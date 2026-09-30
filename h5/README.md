# React C 端（贝壳旅居 H5）

与根目录 `lvju-app-*.html` **并行**，不替换、不删除原 HTML。

| | |
|---|---|
| 开发 | `npm run h5:dev`（Vite :5173，`/api` 代理到 `127.0.0.1:9000`） |
| 构建 | `npm run h5:build` → `h5/dist` |
| 本地启服务 | `npm start`（`prestart` 会先装依赖并 build H5，再 `node app.js`） |
| 发布构建 | `moma_build.sh` 末尾也会 build H5 |
| 线上入口 | 主站 `app.js` 挂载 `/h5/*`（SPA 回落 `index.html`） |

未构建时访问 `/h5` 会返回 503 提示先 build。直跑 `node app.js` 不会自动 build，请用 `npm start` 或先手动 `npm run h5:build`。
