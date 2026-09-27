# 星绘引擎 · 三入口页

「星绘引擎」是一个只做三件事的静态导航页：**辅助下载 / 加入群聊 / 卡密购买**。纯 HTML + CSS + 原生 JS，零依赖、零构建，直接丢到 GitHub Pages 就能跑。

![三个入口：辅助下载、加入群聊、卡密购买](assets/preview.png)

## 部署地址

- GitHub Pages：`https://<用户名>.github.io/<仓库名>/`

## 目录结构

```
.
├── index.html              # 单页，三个卡片的入口
├── assets/
│   ├── style.css           # 全部样式（深色玻璃拟态 + 浅色主题 token 切换）
│   ├── app.js              # 主题切换、一键复制、滚动入场
│   └── preview.png         # 预览图（可选）
├── .nojekyll               # 关掉 Jekyll，保证下划线开头的文件也能发布
└── .github/workflows/pages.yml   # Pages 自动发布工作流
```

## 本地预览

```bash
# 任意静态服务器都行
python3 -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080
```

## 修改入口链接

所有链接都写在 `index.html` 里，搜关键词就能改：

| 入口 | 位置 |
| --- | --- |
| 辅助下载 | `pan.quark.cn/s/dd3c3e5637be` |
| 加入群聊 | `1104108350`（群号展示 + 复制按钮 + 一键加群） |
| 卡密购买 | `ds.xiaoman.top/links/9261E5EF` |

## 特性

- 移动端优先，`clamp()` 流式排版，窄屏不溢出
- 深色 / 浅色双主题，跟随系统并可手动切换（记忆在 localStorage）
- 一键复制下载链接、购买链接、QQ 群号，带 toast 反馈
- 尊重 `prefers-reduced-motion`，键盘 focus 可见，语义化标签 + aria
- 无外部 JS 依赖，字体走 Google Fonts 且有系统字体兜底
