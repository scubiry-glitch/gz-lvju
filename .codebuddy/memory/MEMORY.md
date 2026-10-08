# 长期记忆（跨会话）

> 只放**稳定事实**：项目约定、环境坑、勿回退红线。日常过程记录见 `YYYY-MM-DD.md`。

## 项目性质
- `sy2-no-assets-20260812` = 保租房/新居住/旅居/家政多业务线；静态 HTML 原型（~200 页）+ **Node 单入口后端 `app.js`**（入口 + 共享辅助；管理/C 端/家政/预订路由在 `server/routes/{admin,api_direct,jiazheng,booking}.cjs`，经 createXxxRouter(deps) 注入）+ MySQL。`python` 层（`juzhu/server.py`）仅历史参考，不运行。
- 后端发行包 `package_backend.sh` **明确排除 `assets/`**（图片由前端仓库/CDN 承担）→ 任何「回落本地文件系统」的逻辑在生产都不可靠。
- 权限/审计单一出口：`perm_registry.cjs` 的 `ROUTES`（**新增路由必须同步登记**，否则 401/不可达；改动后必须做数组空洞检查 + `permRegistry.match()` 抽查）。

## 本机开发环境（实测）
- 启动服务：`cd <repo> && PORT=8766 node --env-file=.env.dev app.js`（`.env.dev` 的库 `lv_gz@rd.mysql.anjun.tech:3331` 在内网可达；管理员账号 `admin`，口令见 `.env.dev` 的 `JUZHU_ADMIN_PASSWORD`）。
- 内联 `PORT=8766` 优先于 `.env.dev` 里的 `PORT=9000`（Node `--env-file` 不覆盖已存在的环境变量）。
- **冷启动 `ensureSchema()`（DDL + 大量种子）可能耗时数分钟**：期间所有位于它之后的路由（含登录）都会挂起，而 `GET /api/juzhu/img?p=` 在它之前仍秒回 → 用它区分「服务已起」与「schema 未就绪」。规避：**同一时刻只跑一个实例**（并发实例的 DDL 元数据锁会让彼此卡住）；改代码后先 kill 旧实例再起新的。
- `lv_gz` 是**共享 MySQL 实例**，同 user 还有别的应用在用别的库；该账号**无 PROCESS 权限**，看不了锁等待。
- ⚠ 停止服务只用 `lsof -ti tcp:8766 -sTCP:LISTEN | xargs kill`；**不带 `-sTCP:LISTEN` 会把正在跑 e2e 的客户端一起杀掉**（导致中断并留下测试数据）。
- 本机 shell 是 **zsh**：`for f in $VAR` 不做分词（用数组或 `$(cat list)`）；`set -a; source .env.dev; set +a` 可用于注入环境变量。

## 房源图片对象存储（贝壳 ODS/S3，规则 21）
详见 `docs/s3-image-storage.md`（含实测口径、排障表、勿回退约束、验证分层）与 `docs/s3-intake-api-plan.md`（改造范围/风险/回滚/验收）。
- **单一出口**：上传/读取只走 `img_storage.cjs`（`s3_client.cjs` 为协议层），页面与接口不得直连 ODS、不得自拼签名。
- **写侧收口**：所有 `file_path` / `cover_image` 写入经 `img_storage.ingestRef()`；脏值（`-` / `todo` / 含 `..` 的路径 / `javascript:` 等）一律 400 拒绝；落库失败要 `compensateUpload()` 补偿删对象。
- **灰度/回滚主开关**：`IMG_URL_MODE=local|dual|s3`（缺省 dual）+ `IMG_INGEST=keep|mirror`、`IMG_NORMALIZE`、`S3_FAIL_ON_UNCONFIGURED`、`S3_MIGRATE_PREFIX`、`S3_SOURCE_URL_ALLOWLIST`、`S3_DELETE_ON_PHOTO_DELETE`（均可在 `GET /api/juzhu/admin/storage/status` 回显核对）。
- **回滚口径固定为「保留 S3 引用 + 只回滚写侧」** ⇒ 前端 `imgUrl()` 兼容（`juzhu-admin.html` / `juzhu-admin-unit.html` / `screens/p-rating-detail.html`）是回滚前置，**不得回退**；库内一旦有 S3 绝对 URL，旧写法 `url('/'+p)` 会拼成 `/https://…` 必坏图。
- **四条勿回退红线**：① 存量迁移 key 必须 `legacyKeyOf()`（确定性），不能走 `keyFor()` 的 uuid；② multipart/二进制必须 `readRawBody()`（`readBody()` 是 utf8 拼串会毁字节），分隔符匹配 `\r\n--<boundary>`；③ `insertPhotoRow()` 必须事务 + 归属行锁；④ `deleteObjectByRef()` 拒绝对外部 URL 反解 key（防误删同名对象）。
- **生产 fail-closed**：后端包不含 `assets/`，未配 S3 时回落本地 = 静默丢图 → 生产设 `S3_FAIL_ON_UNCONFIGURED=1`。
- 回归入口：`npm run test:img-ingest`（L1 纯函数）/ `test:admin-upload`（L2 multipart 与契约）/ `s3:smoke`（L3 协议）/ `node scripts/admin_upload_e2e.cjs --base=…`（L4 HTTP，需 DB + 管理员账号，会临时插 `photos` 行并自动清理）。

## 编码约定
- Lombok `@Data` 项目：**不要**手写与字段 getter 同名的静态方法（会让 Lombok 跳过生成实例 getter → 递归）。
- 异常不要统一包成"DB 查询失败"（`app.js` 历史问题会把真实原因盖掉）；按 kind 分类或保留原始 stack。
