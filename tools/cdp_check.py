#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CDP 截图 + 交互自检（Termux headless chromium, 127.0.0.1:9222）
用法:
  python3 cdp_check.py shots --url URL --out DIR --spec 1200x900:dark:desktop.png,390x844:dark:mobile.png
  python3 cdp_check.py probe --url URL
"""
import asyncio, base64, json, os, sys, urllib.request
import websockets

CDP = 'http://127.0.0.1:9222'


class CDPClient:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0
        self.pending = {}
        self.task = None
        self.rx = 0
        self.dialogs = []
        self.auto_dismiss = True

    async def call(self, method, params=None, timeout=40):
        self.n += 1
        mid = self.n
        fut = asyncio.get_event_loop().create_future()
        self.pending[mid] = fut
        await self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self.pending.pop(mid, None)

    async def pump(self):
        try:
            async for raw in self.ws:
                self.rx += 1
                d = json.loads(raw)
                mid = d.get('id')
                if mid is not None and mid in self.pending and not self.pending[mid].done():
                    self.pending[mid].set_result(d)
                    continue
                # 原生对话框会锁死页面 JS 线程（Runtime.evaluate 永远不返回），必须自动关掉
                if d.get('method') == 'Page.javascriptDialogOpening':
                    info = d.get('params', {})
                    self.dialogs.append('%s: %s' % (info.get('type'), str(info.get('message'))[:80]))
                    if self.auto_dismiss:
                        self.n += 1
                        await self.ws.send(json.dumps({
                            'id': self.n, 'method': 'Page.handleJavaScriptDialog', 'params': {'accept': False},
                        }))
        except Exception as exc:
            print('[pump stopped: %s: %s]' % (type(exc).__name__, exc), file=sys.stderr)
            for fut in list(self.pending.values()):
                if not fut.done():
                    fut.set_exception(ConnectionError('CDP connection closed'))
            raise


async def open_page():
    targets = json.load(urllib.request.urlopen(CDP + '/json/list'))
    page = next(t for t in targets if t['type'] == 'page')
    ws = await websockets.connect(page['webSocketDebuggerUrl'], max_size=80 * 1024 * 1024)
    c = CDPClient(ws)
    # 必须持强引用，否则 task 会被 GC 回收，之后的响应无人派发（曾导致 awaitPromise 永久挂起）
    c.task = asyncio.create_task(c.pump())
    await c.call('Browser.getVersion', timeout=10)
    return c


async def goto(c, url, width, height, mobile, theme='dark', wait=2.0):
    await c.call('Page.enable')
    await c.call('Runtime.enable')
    await c.call('Emulation.setDeviceMetricsOverride', {
        'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': mobile,
        'screenOrientation': {'angle': 0, 'type': 'portraitPrimary'} if mobile else {'angle': 0, 'type': 'landscapePrimary'},
    })
    await c.call('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme', 'value': theme}]})
    await c.call('Page.navigate', {'url': url})
    await asyncio.sleep(wait)
    # 强制目标主题（localStorage 记忆优先于媒体查询）
    await c.call('Runtime.evaluate', {'expression':
        "localStorage.setItem('links-site-theme','%s');document.documentElement.setAttribute('data-theme','%s');"
        "document.querySelectorAll('[data-reveal]').forEach(e=>e.classList.add('is-in'));" % (theme, theme)})
    await asyncio.sleep(0.6)


async def screenshot(c, out, full=True):
    r = await c.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': full, 'optimizeForSpeed': False})
    data = base64.b64decode(r['result']['data'])
    with open(out, 'wb') as f:
        f.write(data)
    return len(data)


async def evaluate(c, expr, timeout=15):
    r = await c.call('Runtime.evaluate', {'expression': expr, 'awaitPromise': False, 'returnByValue': True}, timeout=timeout)
    res = r.get('result', {})
    if not isinstance(res, dict):
        return 'ODD_RESULT: %r' % (r,)
    if 'exceptionDetails' in res:
        return 'JS_EXCEPTION: %s' % json.dumps(res['exceptionDetails'].get('exception', {}).get('description', res['exceptionDetails']))[:300]
    return res.get('result', {}).get('value')


async def sleep(c, seconds):
    """用页面内计时器等待，避免与本进程事件循环耦合。"""
    await c.call('Runtime.evaluate', {'expression': 'new Promise(r=>setTimeout(r,%d))' % int(seconds * 1000), 'awaitPromise': True}, timeout=seconds + 10)


async def cmd_shots(argv):
    url = argv[argv.index('--url') + 1]
    if '--new-session' in argv:
        await (await open_page()).call('Network.clearBrowserCookies')
    outdir = argv[argv.index('--out') + 1]
    specs = argv[argv.index('--spec') + 1].split(',')
    os.makedirs(outdir, exist_ok=True)
    c = await open_page()
    results = []
    hold_intro = '--hold-intro' in argv
    for spec in specs:
        dims, theme, name = spec.split(':')
        w, h = (int(x) for x in dims.split('x'))
        mobile = w < 700
        # 每次截图前清掉会话标记，保证开场动画可复现
        await goto(c, url, w, h, mobile, theme, wait=1.2 if hold_intro else 2.0)
        if hold_intro:
            try:
                await c.call('Runtime.evaluate', {'expression': "(function(){try{sessionStorage.removeItem('sde-intro-seen')}catch(e){};location.replace('/index.html?intro=1&fresh='+Date.now());return 1})()", 'returnByValue': True})
                await asyncio.sleep(2.2)
            except Exception as exc:
                print('intro replay skipped:', exc, file=sys.stderr)
        if not hold_intro:
            try:
                await c.call('Runtime.evaluate', {'expression': "document.getElementById('introEnter') && document.getElementById('introEnter').click()", 'returnByValue': True})
                await asyncio.sleep(1.4)
                # 逐屏滚动一遍，触发各分区的 IntersectionObserver 入场
                await c.call('Runtime.evaluate', {'expression': "(function(){var s=document.querySelectorAll('section[id]');var y=0;for(var i=1;i<s.length;i++){s[i].scrollIntoView();}window.scrollTo(0,0);return s.length})()", 'returnByValue': True})
                await asyncio.sleep(2.0)
            except Exception as exc:
                print('intro dismiss skipped:', exc, file=sys.stderr)
        size = await screenshot(c, os.path.join(outdir, name), full=not hold_intro)
        results.append({'file': name, 'viewport': dims, 'theme': theme, 'bytes': size})
        print('SHOT %-16s %-10s %-6s %7d bytes' % (name, dims, theme, size))
    await c.call('Emulation.clearDeviceMetricsOverride')
    return results


async def cmd_probe(argv):
    url = argv[argv.index('--url') + 1]
    c = await open_page()
    try:
        await c.call('Browser.grantPermissions', {
            'origin': 'http://127.0.0.1:8099',
            'permissions': ['clipboardReadWrite', 'clipboardSanitizedWrite'],
        })
    except Exception as exc:  # 权限 API 不可用不阻塞其他检查
        print('grantPermissions skipped:', exc, file=sys.stderr)
    await goto(c, url, 1200, 900, False, 'dark')
    checks = {}

    async def try_eval(key, expr, timeout=15):
        try:
            checks[key] = await evaluate(c, expr, timeout=timeout)
        except Exception as exc:
            checks[key] = 'ERROR: %s: %s' % (type(exc).__name__, exc)

    await try_eval('title', 'document.title')
    await try_eval('nav_items', "Array.from(document.querySelectorAll('#sectionNav .label')).map(e=>e.textContent.trim())")
    await try_eval('panels', "Array.from(document.querySelectorAll('.panel-title')).map(e=>e.textContent.trim())")
    await try_eval('links', "Array.from(document.querySelectorAll('a[target=_blank]')).map(a=>a.href)")
    await try_eval('panel_count', "document.querySelectorAll('.panel').length")
    await try_eval('qq_value', "document.getElementById('qqValue').textContent.trim()")
    await try_eval('h_overflow_px', "document.documentElement.scrollWidth - document.documentElement.clientWidth")
    await try_eval('title_font', "getComputedStyle(document.querySelector('.t-main')).fontFamily")
    await try_eval('page_bg', "getComputedStyle(document.body).backgroundColor")
    await try_eval('btn_main_bg', "getComputedStyle(document.querySelector('.btn-main')).backgroundImage.slice(0,60)")
    await try_eval('intro_present', "!!document.getElementById('intro')")
    await try_eval('intro_visible', "(()=>{const i=document.getElementById('intro');return !!i && !i.classList.contains('is-gone') && getComputedStyle(i).opacity!=='0';})()")
    await try_eval('intro_enter_btn', "!!document.getElementById('introEnter')")

    # 开场动画：进度条是否在走
    await sleep(c, 1.0)
    await try_eval('intro_progress_text', "document.getElementById('introPct').textContent")
    await try_eval('intro_bar_width', "document.getElementById('introBar').style.width")

    # 点击进入 -> 开场退出、内容入场
    await try_eval('enter_click', "document.getElementById('introEnter').click(), 'clicked'")
    await sleep(c, 1.6)
    await try_eval('intro_after', "(()=>{const i=document.getElementById('intro');return 'classes='+i.className+' opacity='+getComputedStyle(i).opacity;})()")
    await try_eval('html_classes', "document.documentElement.className")
    await try_eval('hero_opacity', "getComputedStyle(document.querySelector('.hero-inner')).opacity")

    # 复制按钮（群聊分区）
    await try_eval('copy_btn_found', "!!document.querySelector('[data-copy=\"1104108350\"]')")
    await try_eval('copy_click_fired', "document.querySelector('[data-copy=\"1104108350\"]').click(), 'clicked'")
    await sleep(c, 1.6)
    await try_eval('copy_toast_text', "document.getElementById('toast').textContent")
    await try_eval('copy_btn_echo', "document.querySelector('[data-copy=\"1104108350\"] .btn-label').textContent.trim()")
    await sleep(c, 1.9)
    await try_eval('copy_btn_restored', "document.querySelector('[data-copy=\"1104108350\"] .btn-label').textContent.trim()")

    # 滚动 + 分区入场 + 指示高亮
    await try_eval('anchor_click', "document.querySelector('#sectionNav a[data-target=\"buy\"]').click(), 'clicked'")
    await sleep(c, 2.2)
    await try_eval('scroll_y', "Math.round(window.scrollY)")
    await try_eval('buy_in_view', "(function(){var r=document.getElementById('buy').getBoundingClientRect();return Math.round(r.top)+'px top';})()")
    await try_eval('panel_revealed', "document.querySelectorAll('.panel.is-in').length + '/' + document.querySelectorAll('.panel').length")
    await try_eval('nav_active', "(()=>{const a=document.querySelector('#sectionNav a.is-active');return a?a.getAttribute('data-target'):'none';})()")
    await try_eval('topbar_stuck', "document.getElementById('topbar').classList.contains('is-stuck')")
    print(json.dumps(checks, ensure_ascii=False, indent=2))
    return checks


async def main():
    mode = sys.argv[1]
    argv = sys.argv[1:]
    if mode == 'shots':
        await cmd_shots(argv)
    elif mode == 'probe':
        await cmd_probe(argv)
    else:
        print('unknown mode', mode)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
