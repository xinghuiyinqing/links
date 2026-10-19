/* ==========================================================================
   冬季快车 · 交互层（原生 ES module，零依赖，除 three 由 scene 自己 import）
   --------------------------------------------------------------------------
   职责：
     1. 版本号：读 .d/v.txt（本地预览必定 404，兜底常量必须扛住，不许抛）
     2. 锚点跟随：自建 rAF 读 WinterTrain.anchors()，lerp 0.18 定位四张卡
     3. 开场编排：用 WinterTrain.timeline 的常量排 header / 站牌条 / 卡片入场
     4. 兜底：ready reject、3s 没场景、anchors 一直为空 —— 都必须落到可用的终态
     5. 交互：复制（Clipboard + 900ms 竞速 + execCommand）、toast、QQ 唤起检测
   本文件不碰 assets/scene/**，也不假设它一定存在。
   ========================================================================== */

window.__wtUI = true;   /* index.html 里的兜底定时器靠这个标志判断 UI 是否已接管 */

(function () {
  'use strict';

  var root = document.documentElement;
  var body = document.body;

  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) {
    return Array.prototype.slice.call((ctx || document).querySelectorAll(sel));
  };

  /* 卡片宽度的上下限写在 CSS（--card-min / --card-max）里，不同断点可以改，
     JS 只负责读出来 —— 矮横屏要放宽下限，竖屏要单列排，都靠这两个变量。 */
  var bounds = { min: 220, max: 300 };
  var LERP = 0.18;             /* 契约 §3 的平滑系数 */

  var TL_FALLBACK = {
    washIn: 0, depart: 250, arriveEnd: 3300,
    igniteStart: 3450, igniteStep: 160, settled: 4200
  };

  var DETACH_MQ = window.matchMedia
    ? window.matchMedia('(max-width: 720px), (max-aspect-ratio: 1/1)')
    : { matches: false, addEventListener: function () {} };
  var REDUCE_MQ = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: function () {} };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }
  function scene() { return window.WinterTrain || null; }

  /* 时间轴：scene 的为准，缺失的字段用契约里写死的默认值补齐 */
  function readTimeline() {
    var w = scene();
    var tl = (w && w.timeline && typeof w.timeline === 'object') ? w.timeline : null;
    var out = {};
    for (var k in TL_FALLBACK) {
      out[k] = (tl && typeof tl[k] === 'number' && isFinite(tl[k])) ? tl[k] : TL_FALLBACK[k];
    }
    return out;
  }
  var TL = readTimeline();

  /* ======================================================================
     1. 版本号
     ====================================================================== */
  var FALLBACK_VER = 'v1.9';
  var FALLBACK_SIZE = '12.1 MB';

  function formatSize(bytes) {
    if (!bytes || bytes < 0 || !isFinite(bytes)) return FALLBACK_SIZE;
    var mb = bytes / 1048576;
    return (mb >= 100 ? mb.toFixed(0) : (mb >= 10 ? mb.toFixed(1) : mb.toFixed(2))) + ' MB';
  }

  function paintVersion(ver, sizeText) {
    var v = 'v' + String(ver).replace(/^v/i, '');
    var valueEl = $('#win-0 [data-wc-value]');
    var noteEl = $('#win-0 [data-wc-note]');
    var headVer = $('#head-ver');
    var card = $('#win-0');

    if (valueEl) valueEl.textContent = v;
    if (noteEl) noteEl.textContent = sizeText;
    if (headVer) headVer.textContent = v;
    if (card) {
      card.setAttribute('aria-label',
        '星绘引擎：下载王牌竞速内核 ' + v + '，文件名 王牌竞速内核.sh，体积 ' + sizeText);
    }
  }

  /* 本地预览时 .d/v.txt 一定 404 —— 这是预期行为。
     r.ok 为假就原样返回空串，再由正则不匹配走兜底；catch 把网络异常整个吞掉。 */
  if (window.fetch) {
    window.fetch('.d/v.txt', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        var m = /(\S+)\s+(\d+)/.exec(text || '');
        if (!m) return;
        paintVersion(m[1], formatSize(parseInt(m[2], 10)));
      })
      .catch(function () { /* 静默：保留 HTML 里写死的兜底值 */ });
  }

  /* ======================================================================
     2. Toast（单例，2s / 3.2s 自动消失）
     ====================================================================== */
  var toastEl = $('#toast');
  var toastTimer = 0;
  var toastHover = false;

  function toastHide() {
    if (toastEl) toastEl.classList.remove('is-on');
  }
  function toastArm(ms) {
    window.clearTimeout(toastTimer);
    if (toastHover) return;
    toastTimer = window.setTimeout(toastHide, ms);
  }

  function showToast(message, opt) {
    if (!toastEl) return;
    opt = opt || {};
    var warn = !!opt.warn;

    toastEl.textContent = '';

    var msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message;
    toastEl.appendChild(msg);

    var act = null;
    if (opt.action && opt.action.text) {
      act = document.createElement('button');
      act.type = 'button';
      act.className = 'toast-act';
      act.textContent = opt.action.label || '复制';
      act.addEventListener('click', function () {
        copyThenToast(opt.action.text, opt.action.copyLabel || '群号');
      });
      toastEl.appendChild(act);
    }

    toastEl.classList.toggle('has-act', !!act);
    toastEl.classList.toggle('is-warn', warn);
    toastEl.classList.add('is-on');
    toastArm(warn ? 3200 : 2000);
  }

  if (toastEl) {
    toastEl.addEventListener('pointerenter', function () {
      toastHover = true;
      window.clearTimeout(toastTimer);
    });
    toastEl.addEventListener('pointerleave', function () {
      toastHover = false;
      toastTimer = window.setTimeout(toastHide, 2000);
    });
  }

  /* ======================================================================
     3. 复制：Clipboard API + 900ms 竞速 + execCommand 兜底
        （沿用 _legacy/assets/app.js 的做法：某些浏览器里 writeText 会一直挂着）
     ====================================================================== */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '0';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return new Promise(function (resolve) {
        var settled = false;
        var done = function (v) { if (!settled) { settled = true; resolve(v); } };
        window.setTimeout(function () { done(legacyCopy(text)); }, 900);
        navigator.clipboard.writeText(text).then(
          function () { done(true); },
          function () { done(legacyCopy(text)); }
        );
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function copyThenToast(text, label) {
    copyText(text).then(function (ok) {
      if (!ok) {
        showToast('复制被浏览器拦截，请手动记下 ' + label + ' ' + text, { warn: true });
        return;
      }
      showToast(label + '已复制：' + text);
    });
  }

  $$('[data-copy]').forEach(function (el) {
    el.addEventListener('click', function () {
      var text = el.getAttribute('data-copy') || '';
      if (!text) return;
      copyThenToast(text, el.getAttribute('data-copy-label') || '内容');
    });
  });

  /* ======================================================================
     4. 卡片：点击反馈 + QQ 唤起检测
     ====================================================================== */
  var CLICK_TOAST = {
    0: '已开始下载 王牌竞速内核.sh',
    1: '已在新窗口打开夸克网盘',
    3: '已在新窗口打开购卡页 · 自动发货'
  };

  var cards = $$('#windows > .window-card');

  cards.forEach(function (card) {
    var slot = card.getAttribute('data-slot');

    card.addEventListener('click', function () {
      if (!Object.prototype.hasOwnProperty.call(CLICK_TOAST, slot)) return;
      showToast(CLICK_TOAST[slot]);
    });
  });

  /* 一键加群：mqqapi:// 是 QQ 官方的群卡片 scheme。
     点了之后页面还可见 = 没跳成（大概率没装 QQ）→ 1.8s 后提示，并给可点的复制。 */
  var qqCard = $('#win-2');
  if (qqCard) {
    qqCard.addEventListener('click', function () {
      var start = Date.now();
      window.setTimeout(function () {
        if (document.hidden || document.visibilityState === 'hidden') return;
        if (Date.now() - start < 1500) return;
        showToast('没能唤起 QQ，请确认已安装', {
          warn: true,
          action: { label: '复制群号', text: '1104108350', copyLabel: '群号' }
        });
      }, 1800);
    });
  }

  /* ======================================================================
     5. 模式：锚点跟随 / 分离网格
     ====================================================================== */
  var pos = cards.map(function () {
    return { x: 0, y: 0, px: NaN, py: NaN, w: 0, h: 0, lit: -1, vis: true, init: false };
  });

  function readBounds() {
    var cs = window.getComputedStyle(root);
    var mn = parseFloat(cs.getPropertyValue('--card-min'));
    var mx = parseFloat(cs.getPropertyValue('--card-max'));
    bounds.min = (mn > 0 && isFinite(mn)) ? mn : 220;
    bounds.max = (mx > 0 && isFinite(mx)) ? mx : 300;
    if (bounds.max < bounds.min) bounds.max = bounds.min;
  }

  function isDetached() {
    return DETACH_MQ.matches || body.classList.contains('is-nogl');
  }

  function syncMode() {
    readBounds();
    var detached = isDetached();
    body.classList.toggle('is-anchored', !detached);

    if (detached) {
      body.setAttribute('data-detached', 'true');
      cards.forEach(function (card, i) {
        card.style.transform = '';
        card.style.width = '';
        card.classList.remove('is-out');
        pos[i].init = false;
        pos[i].px = NaN;
        pos[i].py = NaN;
      });
    } else if (body.hasAttribute('data-detached')) {
      body.removeAttribute('data-detached');
    }
  }

  /* ======================================================================
     6. 锚点跟随（自建 rAF，不依赖 scene 的回调）
     ====================================================================== */
  var gotAnchors = false;
  var rafId = 0;

  function paintAnchors() {
    if (!body.classList.contains('is-anchored')) return 0;

    var w = scene();
    if (!w || typeof w.anchors !== 'function') return 0;

    var list = safe(function () { return w.anchors(); });
    if (!list || !list.length) return 0;
    gotAnchors = true;

    for (var i = 0; i < cards.length; i++) {
      var a = list[i];
      if (!a) continue;
      if (!(a.w > 24) || !(a.h > 24)) continue;    /* 场景还没投影出尺寸，先跳过 */

      var card = cards[i];
      var st = pos[i];

      /* 宽度：clamp(--card-min, anchor.w, --card-max)。窗洞尺寸已经是给卡片算过的，
         这里直接取 anchor.w，不再乘系数；高度由 CSS 的 aspect-ratio 决定，不缩放文字。 */
      var wantW = Math.round(clamp(a.w, bounds.min, bounds.max) / 2) * 2;
      if (wantW !== st.w) {
        card.style.width = wantW + 'px';
        st.w = wantW;
        st.h = card.offsetHeight || Math.round(wantW / 0.9);  /* 只在宽度变化时读一次布局 */
      }

      var tx = a.x - st.w * 0.5;
      var ty = a.y - st.h * 0.5;

      if (!st.init) {
        st.x = tx; st.y = ty; st.init = true;
      } else {
        st.x += (tx - st.x) * LERP;
        st.y += (ty - st.y) * LERP;
      }

      if (!(Math.abs(st.x - st.px) < 0.04 && Math.abs(st.y - st.py) < 0.04)) {
        st.px = st.x; st.py = st.y;
        card.style.transform =
          'translate3d(' + st.x.toFixed(2) + 'px,' + st.y.toFixed(2) + 'px,0)';
      }

      /* lit → --lit，驱动亮度 / 辉光 / 序号颜色 */
      var lit = clamp01(typeof a.lit === 'number' ? a.lit : 1);
      if (!(Math.abs(lit - st.lit) < 0.008)) {
        st.lit = lit;
        card.style.setProperty('--lit', lit.toFixed(3));
      }

      var vis = a.visible !== false;
      if (vis !== st.vis) {
        st.vis = vis;
        card.classList.toggle('is-out', !vis);
      }
    }
    return 1;
  }

  function frame() {
    rafId = window.requestAnimationFrame(frame);
    paintAnchors();
  }

  function startLoop() {
    if (!rafId) rafId = window.requestAnimationFrame(frame);
  }
  function stopLoop() {
    if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopLoop(); else startLoop();
  });

  /* ======================================================================
     7. 开场编排
     ====================================================================== */
  var settled = false;

  function setDelays(d1, d2, d3, dBoard) {
    root.style.setProperty('--d-head-1', d1 + 'ms');
    root.style.setProperty('--d-head-2', d2 + 'ms');
    root.style.setProperty('--d-head-3', d3 + 'ms');
    root.style.setProperty('--d-board', dBoard + 'ms');
  }

  function settle() {
    if (settled) return;
    settled = true;
    body.classList.remove('is-boot');
    body.classList.add('is-settled');
  }

  function goNoGL() {
    if (body.classList.contains('is-nogl')) return;
    body.classList.add('is-nogl');
    syncMode();
    settle();
  }

  /* header 三行 + 站牌条：节奏全部从 timeline 推，不硬编码 */
  function scheduleIntro() {
    var d1 = TL.washIn + 120;
    var d2 = TL.washIn + 380;
    var d3 = TL.depart + 220;          /* 250 → 470 */
    var dBoard = d3 + 400;             /* 站牌条晚 400ms */
    setDelays(d1, d2, d3, dBoard);
  }

  /* 一切就绪：header 出发（下一帧加 is-live，保证初始态先被绘制） */
  function goLive() {
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        body.classList.add('is-live');
      });
    });
  }

  /* 兜底定时器：settled 时间点还没停稳就自己落终态 */
  window.setTimeout(function () {
    settle();
  }, Math.max(600, TL.settled));

  /* ======================================================================
     8. 和 scene 接线
     ====================================================================== */
  function bindScene() {
    var w = scene();

    if (!w) return false;

    /* 状态订阅（先挂上，晚一点 settled 也不会漏） */
    if (typeof w.onState === 'function') {
      safe(function () {
        w.onState(function (state) { if (state === 'settled') settle(); });
      });
    }

    if (w.ready && typeof w.ready.then === 'function') {
      w.ready.then(function () {
        sceneReady = true;
        if (REDUCE_MQ.matches) {
          safe(function () { w.skip(); });
          settle();
        } else {
          safe(function () { w.play(); });
        }
        if (safe(function () { return w.state; }) === 'settled') settle();
      }, function () {
        goNoGL();                       /* ready reject → 契约 §2.1 */
      });
      return true;
    }

    /* 没有 ready：只要状态不是 boot 就当作活着 */
    var st = safe(function () { return w.state; });
    if (st && st !== 'boot') {
      safe(function () { w.play(); });
      return true;
    }
    return false;
  }

  var sceneReady = false;

  /* scene 在状态变化时还会派发事件，这里再兜一层 */
  window.addEventListener('wintertrain:state', function (e) {
    if (e && e.detail && e.detail.state === 'settled') settle();
  });

  var bound = bindScene();

  /* app.js 一定在 scene 的 module 之后执行；到这一步还没有 WinterTrain，
     说明 scene 模块根本没挂上（404 / 抛错 / 用了会阻塞的顶层 await）。
     直接降级，别让用户盯着空白等 3 秒。 */
  if (!bound && !scene()) goNoGL();

  /* 3s 看门狗：场景没接管（模块没加载 / 卡住）就降级，绝不停在白屏等 3D */
  window.setTimeout(function () {
    if (sceneReady) return;
    var w = scene();
    var st = w && safe(function () { return w.state; });
    if (w && st && st !== 'boot' && typeof w.anchors === 'function') {
      sceneReady = true;
      return;
    }
    goNoGL();
  }, 3000);

  /* 停稳之后锚点还一直是空数组 = scene 的锚点坏了，退回网格，卡片不能没有位置 */
  window.setTimeout(function () {
    if (gotAnchors || body.classList.contains('is-nogl')) return;
    if (DETACH_MQ.matches) return;      /* 分离模式本来就不用锚点 */
    goNoGL();
  }, Math.max(1000, TL.settled) + 1400);

  /* ======================================================================
     9. 减少动效
     ====================================================================== */
  function applyReduced() {
    var on = !!REDUCE_MQ.matches;
    body.classList.toggle('is-reduced', on);

    var w = scene();
    if (w && typeof w.setReducedMotion === 'function') {
      safe(function () { w.setReducedMotion(on); });
    }

    if (on) {
      /* 直接终态：延迟全部归零，卡片立刻在位 */
      setDelays(0, 0, 0, 0);
      settle();
      if (w && typeof w.skip === 'function') safe(function () { w.skip(); });
    }
  }

  /* ======================================================================
     10. 启动
     ====================================================================== */
  syncMode();
  scheduleIntro();
  applyReduced();
  goLive();
  startLoop();

  if (REDUCE_MQ.addEventListener) {
    REDUCE_MQ.addEventListener('change', applyReduced);
  } else if (REDUCE_MQ.addListener) {
    REDUCE_MQ.addListener(applyReduced);
  }

  if (DETACH_MQ.addEventListener) {
    DETACH_MQ.addEventListener('change', syncMode);
  } else if (DETACH_MQ.addListener) {
    DETACH_MQ.addListener(syncMode);
  }

  window.addEventListener('resize', syncMode, { passive: true });

  /* 尺寸变了：重新读断点上限，并重新量卡片高度（锚点模式下 h 是量出来的） */
  window.addEventListener('resize', function () {
    readBounds();
    cards.forEach(function (card, i) { pos[i].w = 0; });
  }, { passive: true });

  /* 页面藏起来之前把 rAF 停掉，回来再开（省电，也避免后台空转） */
  if (document.hidden) stopLoop();

})();
