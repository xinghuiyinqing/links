/* ==========================================================================
   星绘引擎 · 资源门户 交互脚本（原生 JS，无依赖）
   1) 开场动画：载入进度 → 品牌揭示 → 点击进入 → 内容分层入场
   2) 一键复制（Clipboard API + 超时竞速 + execCommand 兜底）
   3) 极简单屏版：无需滚动与分区逻辑
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var root = document.documentElement;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var params = { get: function () { return null; } };
  try { params = new URLSearchParams(location.search); } catch (e) { /* 老浏览器忽略 */ }

  /* ============================== Toast ============================== */
  var toastEl = $('#toast');
  var toastTimer = null;

  function showToast(message, variant) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.toggle('is-warn', variant === 'warn');
    toastEl.classList.add('is-on');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastEl.classList.remove('is-on');
    }, variant === 'warn' ? 3200 : 2000);
  }

  /* ============================ 开场动画 ============================ */
  var intro = $('#intro');
  var bar = $('#introBar');
  var pct = $('#introPct');
  var enterBtn = $('#introEnter');
  var skipBtn = $('#introSkip');
  var barTimer = null;
  var autoTimer = null;
  var introDone = false;
  var heroSection = $('#hero');

  function setProgress(value) {
    var v = Math.max(0, Math.min(100, Math.round(value)));
    if (bar) bar.style.width = v + '%';
    if (pct) pct.textContent = v + '%';
  }

  function revealAll() {
    root.classList.remove('is-intro');
    root.classList.add('is-ready');
    if (heroSection) heroSection.classList.add('is-in');
  }

  function finishIntro() {
    if (introDone) return;
    introDone = true;
    window.clearInterval(barTimer);
    window.clearTimeout(autoTimer);
    setProgress(100);
    revealAll();
    if (intro) {
      intro.classList.add('is-done');
      window.setTimeout(function () { intro.classList.add('is-gone'); }, reduceMotion ? 60 : 1000);
      intro.setAttribute('aria-hidden', 'true');
    }
    try { sessionStorage.setItem('sde-intro-seen', '1'); } catch (e) { /* 隐私模式忽略 */ }
  }

  function runIntro() {
    var force = params.get('intro');
    var seen = false;
    try { seen = sessionStorage.getItem('sde-intro-seen') === '1'; } catch (e) { seen = false; }

    // ?intro=0 关闭开场；同一次会话内再次进入直接放行；系统开启"减少动态效果"时也跳过
    var skipAll = force === '0' || (!force && seen) || reduceMotion;
    if (skipAll || !intro) {
      if (intro) intro.classList.add('is-gone');
      introDone = true;
      revealAll();
      return;
    }

    var progress = 0;
    // 先快后慢的载入节奏，约 1.5s 到 100%
    barTimer = window.setInterval(function () {
      var step = progress < 62 ? 7.5 : progress < 88 ? 3.4 : 1.1;
      progress = Math.min(100, progress + step);
      setProgress(progress);
      if (progress >= 100) window.clearInterval(barTimer);
    }, 85);

    // 载入完成后自动放行（期间可随时点击进入 / 跳过 / 按 Esc）
    autoTimer = window.setTimeout(finishIntro, 4200);
  }

  if (enterBtn) enterBtn.addEventListener('click', finishIntro);
  if (skipBtn) skipBtn.addEventListener('click', finishIntro);
  document.addEventListener('keydown', function (event) {
    if (introDone) return;
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
      event.preventDefault();
      finishIntro();
    }
  });
  runIntro();

  /* ============================== 复制 ============================== */
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
     所以加 900ms 竞速，超时立刻切 execCommand，绝不让按钮卡死。 */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return new Promise(function (resolve) {
        var settled = false;
        var done = function (val) { if (!settled) { settled = true; resolve(val); } };
        window.setTimeout(function () { done(legacyCopy(text)); }, 900);
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacyCopy(text)); });
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function selectText(text) {
    try {
      var range = document.createRange();
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        var idx = node.nodeValue.indexOf(text);
        if (idx >= 0) {
          range.setStart(node, idx);
          range.setEnd(node, idx + text.length);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          return true;
        }
      }
    } catch (e) { /* 选区失败不影响主流程 */ }
    return false;
  }

  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      var label = btn.getAttribute('data-copy-label') || '内容';
      if (!text) return;

      copyText(text).then(function (ok) {
        if (ok) {
          showToast(label + '已复制：' + text, 'ok');
          var labelEl = $('.btn-label', btn) || $('.entry-text b', btn);
          if (labelEl && !labelEl.dataset.original) {
            labelEl.dataset.original = labelEl.innerHTML;
            labelEl.textContent = '✓ 已复制';
            window.setTimeout(function () {
              labelEl.innerHTML = labelEl.dataset.original;
            }, 1600);
          }
          return;
        }
        showToast('复制被浏览器拦截，内容已在页面中选中', 'warn');
        selectText(text);
        window.setTimeout(function () {
          try { window.prompt('请长按选中后复制：', text); } catch (e) { /* 忽略 */ }
        }, 60);
      });
    });
  });

})();
