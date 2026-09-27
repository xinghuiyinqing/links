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
        async for raw in self.ws:
            d = json.loads(raw)
            mid = d.get('id')
            if mid in self.pending and not self.pending[mid].done():
                self.pending[mid].set_result(d)


async def open_page():
    targets = json.load(urllib.request.urlopen(CDP + '/json/list'))
    page = next(t for t in targets if t['type'] == 'page')
    ws = await websockets.connect(page['webSocketDebuggerUrl'], max_size=80 * 1024 * 1024)
    c = CDPClient(ws)
    asyncio.create_task(c.pump())
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
    outdir = argv[argv.index('--out') + 1]
    specs = argv[argv.index('--spec') + 1].split(',')
    os.makedirs(outdir, exist_ok=True)
    c = await open_page()
    results = []
    for spec in specs:
        dims, theme, name = spec.split(':')
        w, h = (int(x) for x in dims.split('x'))
        mobile = w < 700
        await goto(c, url, w, h, mobile, theme)
        size = await screenshot(c, os.path.join(outdir, name))
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
    await try_eval('cards', "Array.from(document.querySelectorAll('.card h3')).map(h=>h.textContent.trim())")
    await try_eval('links', "Array.from(document.querySelectorAll('a[target=_blank]')).map(a=>a.href)")
    await try_eval('cardcount', "document.querySelectorAll('.card').length")
    await try_eval('qq_value', "document.getElementById('qqValue').textContent.trim()")
    await try_eval('card_radius', "getComputedStyle(document.querySelector('.card')).borderRadius")
    await try_eval('font_status', "document.fonts ? document.fonts.status : 'n/a'")
    await try_eval('h_overflow_px', "document.documentElement.scrollWidth - document.documentElement.clientWidth")
    await try_eval('title_font', "getComputedStyle(document.querySelector('.hero-title')).fontFamily")
    await try_eval('bg_color', "getComputedStyle(document.body).backgroundColor")

    # 复制按钮：点击 -> 轮询 toast 文本与按钮回显
    await try_eval('copy_btn_found', "!!document.querySelector('[data-copy=\"1104108350\"]')")
    await try_eval('copy_click_fired', "document.querySelector('[data-copy=\"1104108350\"]').click(), 'clicked'")
    await sleep(c, 1.6)
    await try_eval('copy_toast_text', "document.getElementById('toast').textContent")
    await try_eval('copy_toast_visible', "document.getElementById('toast').classList.contains('is-on')")
    await try_eval('copy_btn_echo', "document.querySelector('[data-copy=\"1104108350\"]').textContent.trim()")
    await sleep(c, 1.9)
    await try_eval('copy_btn_restored', "document.querySelector('[data-copy=\"1104108350\"]').textContent.trim()")
    await try_eval('clipboard_readback', "navigator.clipboard && navigator.clipboard.readText ? 'api-present' : 'no-api'")

    # 主题切换
    await try_eval('theme_before', "document.documentElement.getAttribute('data-theme')")
    await try_eval('theme_click', "document.getElementById('themeToggle').click(), 'clicked'")
    await sleep(c, 0.5)
    await try_eval('theme_after', "document.documentElement.getAttribute('data-theme') + ' | ls=' + localStorage.getItem('links-site-theme')")
    await try_eval('theme_click_back', "document.getElementById('themeToggle').click(), 'clicked'")
    await sleep(c, 0.5)
    await try_eval('theme_restored', "document.documentElement.getAttribute('data-theme')")

    # 锚点滚动 + 滚动入场
    await try_eval('scroll_before', "Math.round(window.scrollY)")
    await try_eval('anchor_click', "document.querySelector('a[href=\"#buy\"]').click(), 'clicked'")
    await sleep(c, 1.4)
    await try_eval('scroll_after', "Math.round(window.scrollY)")
    await try_eval('buy_in_view', "(function(){var r=document.getElementById('buy').getBoundingClientRect();return Math.round(r.top)+'px top, h='+Math.round(r.height);})()")
    await try_eval('reveal_applied', "document.querySelectorAll('[data-reveal].is-in').length + '/' + document.querySelectorAll('[data-reveal]').length")
    await try_eval('console_errors', "JSON.stringify(window.__probeErrs||[])")
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
