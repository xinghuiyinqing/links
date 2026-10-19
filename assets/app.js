/* ==========================================================================
   星绘引擎 · 夜战 PIT WALL —— 交互脚本（原生 JS，零依赖）
   1) 整台机柜跟着指针 / 陀螺仪做真 3D 视差
   2) 发车牌：红灯依次亮起再转绿（0.85s，纯装饰，不挡点击）
   3) 版本号从 .d/v.txt 读，填进标题和下载板
   4) 复制 QQ 群号（Clipboard API + 900ms 竞速 + execCommand 兜底）
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var body = document.body;

  /* ============================ 1. 3D 视差 ============================ */
  var deck = $('#deck');
  var MAX_Y = 6.5;          // 左右最大偏转
  var MAX_X = 4.5;          // 上下最大偏转（视觉上更收敛）
  var curX = 0, curY = 0, tgtX = 0, tgtY = 0, raf = 0;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function paint() {
    raf = 0;
    curX += (tgtX - curX) * 0.16;
    curY += (tgtY - curY) * 0.16;
    deck.style.setProperty('--rx', (-curY * MAX_X).toFixed(3) + 'deg');
    deck.style.setProperty('--ry', (curX * MAX_Y).toFixed(3) + 'deg');
    if (Math.abs(tgtX - curX) > 0.0005 || Math.abs(tgtY - curY) > 0.0005) {
      raf = window.requestAnimationFrame(paint);
    }
  }
  function aim(x, y) {          // x, y ∈ [-1, 1]
    tgtX = clamp(x, -1, 1);
    tgtY = clamp(y, -1, 1);
    if (!raf) raf = window.requestAnimationFrame(paint);
  }

  if (deck && !reduce) {
    window.addEventListener('pointermove', function (e) {
      aim((e.clientX / window.innerWidth) * 2 - 1,
          (e.clientY / window.innerHeight) * 2 - 1);
    }, { passive: true });

    // 指针离开窗口 -> 机柜回正
    document.addEventListener('pointerleave', function () { aim(0, 0); });
    window.addEventListener('blur', function () { aim(0, 0); });

    // 手机陀螺仪：安卓直接可用；iOS 需用户授权，拿不到就静默忽略
    window.addEventListener('deviceorientation', function (e) {
      if (e.gamma === null || e.gamma === undefined) return;
      aim(e.gamma / 28, (e.beta - 45) / 42);
    }, { passive: true });
  }

  /* ============================ 2. 发车牌 ============================ */
  var lights = $('#lights');
  if (lights) {
    window.setTimeout(function () { lights.classList.add('is-green'); }, 520);
  }

  /* ============================ 3. 版本号 ============================ */
  var verText = $('#verText');
  var dlNote = $('#dlNote');
  var dlValue = $('#dlValue');
  fetch('.d/v.txt', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.text() : ''; })
    .then(function (t) {
      var m = /(\S+)\s+(\d+)/.exec(t || '');
      if (!m) return;
      var v = m[1];
      var mb = (parseInt(m[2], 10) / 1048576).toFixed(1);
      if (verText) verText.textContent = 'v' + v;
      if (dlValue) dlValue.textContent = 'v' + v;
      if (dlNote) dlNote.textContent = mb + ' MB · 直装';
    })
    .catch(function () { /* 拉不到就保留 HTML 里写死的 */ });

  /* ============================ 4. Toast ============================ */
  var toastEl = $('#toast');
  var toastTimer = 0;

  function showToast(msg, variant) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.toggle('is-warn', variant === 'warn');
    toastEl.classList.add('is-on');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastEl.classList.remove('is-on');
    }, variant === 'warn' ? 3200 : 2000);
  }

  /* ============================ 5. 复制 ============================ */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  /* Clipboard API 在无权限 / 非安全上下文 / 隐私模式下可能一直挂起，
     加 900ms 竞速，超时立刻切 execCommand，绝不让按钮卡死 */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return new Promise(function (resolve) {
        var settled = false;
        var done = function (v) { if (!settled) { settled = true; resolve(v); } };
        window.setTimeout(function () { done(legacyCopy(text)); }, 900);
        navigator.clipboard.writeText(text).then(function () { done(true); },
                                                 function () { done(legacyCopy(text)); });
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      var label = btn.getAttribute('data-copy-label') || '内容';
      if (!text) return;

      copyText(text).then(function (ok) {
        if (!ok) {
          // 复制被拦（非安全上下文 / 隐私模式 / 无权限）-> 直接打开加群页，别只丢一句报错
          if (/^\d{5,}$/.test(text)) {
            showToast('复制被拦截，正在打开加群页…', 'warn');
            window.open('https://qm.qq.com/q/' + text, '_blank', 'noopener');
          } else {
            showToast('复制被浏览器拦截：' + text, 'warn');
          }
          return;
        }
        showToast(label + '已复制：' + text);
        var note = $('.plate-note', btn);
        if (note && !note.dataset.origin) {
          note.dataset.origin = note.textContent;
          note.textContent = '已复制 ✓';
          window.setTimeout(function () {
            if (note.dataset.origin) note.textContent = note.dataset.origin;
          }, 1600);
        }
      });
    });
  });

  /* ==================== 6. 指针落在板上 -> 赛道加速 ==================== */
  var plates = $('#plates');
  if (plates) {
    plates.addEventListener('pointerenter', function () { body.classList.add('is-engaged'); });
    plates.addEventListener('pointerleave', function () { body.classList.remove('is-engaged'); });
    var lt = 0;
    plates.addEventListener('pointerover', function () {
      body.classList.add('is-engaged');
      window.clearTimeout(lt);
      lt = window.setTimeout(function () { body.classList.remove('is-engaged'); }, 900);
    });
  }

  /* ==================== 7. 触屏点击的轻微下沉 ==================== */
  $$('.plate').forEach(function (p) {
    p.addEventListener('touchstart', function () { p.style.transform = 'translateZ(18px) scale(.985)'; }, { passive: true });
    p.addEventListener('touchend', function () { p.style.transform = ''; }, { passive: true });
    p.addEventListener('touchcancel', function () { p.style.transform = ''; }, { passive: true });
  });

})();
