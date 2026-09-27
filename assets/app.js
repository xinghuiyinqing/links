/* ==========================================================================
   星绘引擎 · 交互脚本（原生 JS，无依赖）
   - 明暗主题切换（记忆到 localStorage）
   - 一键复制（Clipboard API + 降级方案）
   - 顶栏吸顶态、滚动入场（IntersectionObserver）
   所有外部数据都通过 data-* 注入，未使用 innerHTML，避免 XSS 面。
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------------------------------------------------------------- 主题 */
  var THEME_KEY = 'links-site-theme';
  var root = document.documentElement;

  function preferredTheme() {
    // URL 显式指定优先（?theme=dark / light），便于分享固定配色与自动化截图
    var forced = null;
    try { forced = new URLSearchParams(location.search).get('theme'); } catch (e) { forced = null; }
    if (forced === 'light' || forced === 'dark') return forced;
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { saved = null; }
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    var meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f3f5f9' : '#05070c');
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 隐私模式忽略 */ }
  }

  applyTheme(preferredTheme());

  var themeBtn = $('#themeToggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      applyTheme(root.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
    });
  }

  /* ---------------------------------------------------------------- Toast */
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

  function toast(message) { showToast(message, 'ok'); }

  /* --------------------------------------------------------------- 复制 */
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

  /* 兜底：Clipboard API 在无权限 / 非安全上下文 / 隐私模式下可能一直挂起，
     所以加 900ms 竞速，超时立刻切 execCommand 方案，绝不让按钮卡死。 */
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

  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      var label = btn.getAttribute('data-copy-label') || '内容';
      if (!text) return;

      copyText(text).then(function (ok) {
        if (ok) {
          showToast(label + '已复制：' + text, 'ok');
          if (!btn.dataset.originalHtml) btn.dataset.originalHtml = btn.innerHTML;
          var restored = false;
          btn.textContent = '✓ 已复制';
          window.setTimeout(function () {
            if (restored) return;
            restored = true;
            btn.innerHTML = btn.dataset.originalHtml;
          }, 1600);
          return;
        }
        // 浏览器拒绝写入剪贴板（无手势/权限被拒/非 HTTPS）：明确告知 + 弹出可手动复制
        showToast('复制被浏览器拦截，内容已在下方选中', 'warn');
        selectText(text);
        window.setTimeout(function () {
          try { window.prompt('请长按选中后复制：', text); } catch (e) { /* 忽略 */ }
        }, 60);
      });
    });
  });

  /* 用 range 选区把文本高亮出来，用户长按即可复制 */
  function selectText(text) {
    try {
      var range = document.createRange();
      range.selectNodeContents(document.body);
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

  /* ------------------------------------------------------------ 今日日期 */
  var stamp = $('#stamp');
  if (stamp) {
    try {
      stamp.textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date());
    } catch (e) {
      stamp.textContent = new Date().toLocaleDateString();
    }
  }

  /* ------------------------------------------------------------ 顶栏吸顶 */
  var topbar = $('.topbar');
  if (topbar) {
    var syncTopbar = function () {
      topbar.classList.toggle('is-stuck', window.scrollY > 8);
    };
    syncTopbar();
    window.addEventListener('scroll', syncTopbar, { passive: true });
  }

  /* ------------------------------------------------------------ 滚动入场 */
  var revealTargets = $$('.notice .steps li, .section-head, .hero-stats');
  revealTargets.forEach(function (el) { el.setAttribute('data-reveal', ''); });

  if ('IntersectionObserver' in window && revealTargets.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        var index = revealTargets.indexOf(el);
        el.style.transitionDelay = Math.min(index, 6) * 60 + 'ms';
        el.classList.add('is-in');
        io.unobserve(el);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.15 });

    revealTargets.forEach(function (el) { io.observe(el); });
  } else {
    revealTargets.forEach(function (el) { el.classList.add('is-in'); });
  }

  /* ------------------------------------------------ 平滑锚点（老浏览器兜底） */
  $$('a[href^="#"]').forEach(function (link) {
    link.addEventListener('click', function (event) {
      var id = link.getAttribute('href').slice(1);
      if (!id) return;
      var target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      try { history.replaceState(null, '', '#' + id); } catch (e) { /* 忽略 */ }
    });
  });
})();
