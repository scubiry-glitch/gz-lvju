# React C 端（贝壳旅居 H5）

与根目录 `lvju-app-*.html` **并行**，不替换、不删除原 HTML。

| | |
|---|---|
| 开发 | `npm run h5:dev`（Vite :5173，`/api` 代理到 `127.0.0.1:9000`） |
| 构建 | `npm run h5:build` → `h5/dist` |
| 线上入口 | 主站 `app.js` 挂载 `/h5/*`（SPA 回落 `index.html`） |

未构建时访问 `/h5` 会返回 503 提示先 build。
