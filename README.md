# 星绘引擎 · 王牌竞速辅助科技

**https://xinghuiyinqing.github.io/links/**

单屏导航站：雪原上停着一台喷着白汽的蒸汽机车，**两节客车上的四扇亮着灯的车窗就是四个入口**。
纯静态（HTML + CSS + 原生 ES Module），Three.js 本地化，零构建、零 CDN 依赖，`git push` 即发布。

![星绘引擎 · 冬季快车](assets/preview.png)

## 四个入口

| # | 名称 | 链接 | 说明 |
| --- | --- | --- | --- |
| 01 | 内核版本下载 | `.d/nh_latest.sh` | 版本号与体积实时读 `.d/v.txt` |
| 02 | 插件直装 | `pan.quark.cn/s/dd3c3e5637be` | 夸克网盘，新窗口 |
| 03 | 加入群聊 | `mqqapi://card/show_pslcard?...uin=1104108350` | 一键唤起 QQ 到群卡片 |
| 04 | 24 小时购卡 | `ds.xiaoman.top/links/9261E5EF` | 自动发货 |

改入口只动 `index.html` 里的四个 `<a>`；改版本号只改 `.d/v.txt`（格式 `<版本> <字节数>`）。

## 它就是怎么跑起来的

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 场景 | `assets/scene/` | Three.js 手写场景：雪原高度场 + 四层山脊 + 双轨枕木 + 程序化蒸汽机车 + 两节客车 + 飘雪 + 蒸汽 |
| 外壳 | `index.html` `assets/style.css` `assets/app.js` | 四张车窗卡、开场编排、锚点跟随、版本号、复制与 toast |
| 依赖 | `assets/vendor/` | three 0.186.1（`three.module.js` + `three.core.js`）本地化，靠 importmap 映射 |

场景对外只暴露一个对象：`window.WinterTrain`（`ready / state / play / skip / onState / anchors / timeline / quality / debug`）。
UI 每帧读 `anchors()` 拿四扇车窗的视口坐标，把卡片**像素级**贴上去 —— 这就是"卡片长在车窗里"的实现方式。

## 开场

`250ms` 列车从左侧驶入 → `3300ms` 减速停稳 → `3450ms` 起四扇窗每隔 `160ms` 依次点亮 → `4200ms` 卡片入场。
车轮角速度严格等于线速度除以半径，连杆由曲柄滑块解析解驱动。

## 性能

| 视口 | p50 | p95 | 预算 |
| --- | --- | --- | --- |
| 1440×900 | 7.0 ms | 14.0 ms | ≤17.2 ms |
| 390×844 dpr3 | 7.0 ms | 13.9 ms | ≤20.8 ms |

draw calls 26、三角 7.4 万、光照 4 盏、无 shadowMap、无全屏后处理。
`assets/scene/quality.js` 会在连续两个 1 秒窗口低于 45fps 时自动降档（粒子数 / DPR / 光锥）。

## 无障碍与降级

- 无 WebGL：自动走 `is-nogl`，退成雪天背景 + 网格排布的四张卡，四个入口依然可用
- 系统「减少动态效果」：直接跳到终态
- 关闭 JS：仍是完整可读的四个入口
- 卡片背后零 `backdrop-filter`（画布在动，会掉帧）；暖色只出现在窗灯上

## 本地预览

```bash
cd <repo>
python -m http.server 8901
# http://127.0.0.1:8901/
```

本地没有 `.d/nh_latest.sh` 与 `.d/v.txt` 时，控制台会出现两条 404 —— 这是**预期**的，UI 有 `v1.9 / 12.1 MB` 兜底常量。

## 部署

main 分支根目录 + `.nojekyll`，GitHub Pages（legacy build）。推送后约 30 秒自动重建。
