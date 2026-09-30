# app.js 模块化拆分说明（2026-09）

把原来的单体 `app.js` 按「基础设施 → 领域路由 → 剩余直连」拆成若干 CJS 模块，**不引入 Nest/Next**，对外入口与导出保持不变（`scf_bootstrap` → `app.js`）。

拆完后量级（约数，随后续改动会漂）：

| 文件 | 约行数 | 职责 |
|---|---:|---|
| `app.js` | ~2100 | 启动、静态、鉴权 helper、路由装配、`createServer` |
| `server/db.cjs` | ~80 | MySQL 配置 / 连接池 / `queryRows` |
| `server/http_util.cjs` | ~40 | `jsonReply` / `createReadBody` |
| `server/schema.cjs` | ~970 | `ensureSchema`（DDL + extraCols + 种子） |
| `server/routes/booking.cjs` | ~520 | C 端预订 / 支付确认 |
| `server/routes/jiazheng.cjs` | ~770 | 家政 C 端 `/api/juzhu/jiazheng/*`（不含 vendor HMAC） |
| `server/routes/admin.cjs` | ~2000 | `/api/juzhu/admin/*` + 公开 `GET /settings` |
| `server/routes/api_direct.cjs` | ~2070 | 其余 `/api/juzhu/*`（catalog / vendor 会话 / spots…） |

---

## 约定

1. **工厂函数**：`createXxxRouter(deps)` / `createSchema(deps)`，依赖由 `app.js` 显式注入，不在子模块里 `require('./app.js')`。
2. **路由命中约定**（booking / jiazheng / admin）：
   - 命中并已写响应 → 返回 `undefined`（调用方 `!== false` 即 return）
   - 未命中 → 返回 `false`，交给下一层
3. **`api_direct`** 是总调度：先鉴权闸，再转发 jiazheng / admin / booking，再处理剩余路径。
4. **导出稳定**：`module.exports.ensureSchema` 等仍从 `app.js` 露出，脚本/测试可照旧 `require('./app.js')`。

装配顺序（`app.js` 内）：

```
createBookingRouter → createJiazhengRouter → createAdminRouter
  → createApiDirectRouter（吃上面三个 handle*）
  → http.createServer → handleApiDirect / handleAuthRoutes
```

启动时仍会主动跑一次 `ensureSchema()`（冷启动连远程库可能数十秒～两分钟，属原行为）。

---

## 各模块边界

### `server/db.cjs`
- `getDbConfig` / `getPool` / `queryRows` / `withDbRetry` / `getMysql`
- 凭证只读 `MYSQL_*` / `JUZHU_DB_*`，禁止写死源码

### `server/http_util.cjs`
- `jsonReply(res, body, status)`
- `createReadBody({ reqLogBody })` —— 读 body 仍依赖 app 侧请求日志钩子

### `server/schema.cjs`
- `createSchema({ authCenter, channelBrand, housingSeedAll, … })` → `{ ensureSchema, … }`
- 内含：`ensureGrOrdersShape`、`ensureJzSkusIncludesColumn`、`ensureSchemaRun`
- `CREATE IF NOT EXISTS` + `extraCols` ALTER + 住房/家政/花名册种子 + `authCenter.ensureAuthSchema`

### `server/routes/booking.cjs`
- `/api/juzhu/booking/*`、`/payment/query`、`/payment/notify/:token`
- 同期改动（同次模块化相关）：`GET /booking/my` **只按 `user_id` 认领**（去掉手机号 OR 旁路）；整栋单 unit ext 批量查；打 auth/sql 耗时日志

### `server/routes/jiazheng.cjs`
- `/api/juzhu/jiazheng/*` **C 端**（categories / skus / orders / repairs…）
- **不含** `/api/juzhu/jiazheng/vendor/*`（HMAC 仍在 `api_direct` → `vendor_api`）

### `server/routes/admin.cjs`
- `ADMIN_PREFIX`（`/api/juzhu/admin/*`）+ 公开 `GET /api/juzhu/settings`
- 权限点走 `perm_registry`（由 `api_direct` 入口闸 + admin 内处理配合）

### `server/routes/api_direct.cjs`
- 原 `handleApiDirect` 整块迁出
- 含：公开 catalog/cities/ratings/routes/spots/topics、商家会话 `/vendor/*`、vendor-admin、onboarding、HMAC callback、gr/jz 双轨读、org/report、s/orders 等
- 顺手修复：C 端 `SPOT_TYPE_LABELS` 曾随 admin 拆走后未在公开路径定义，现于本文件补回（与 admin 同口径）

### 仍留在 `app.js`（刻意未拆）
- 静态根 / 敏感路径拦截 / H5 SPA
- 鉴权 helper：`requestSession`、`requirePerm`、`assertApiAuthorized`、C 端写闸…
- 房态/评级/佣金等与 `stay_config` / `vendor_rate` 的薄封装
- Webhook 推送、`handleAuthRoutes`（`/api/auth/*`）、请求日志、`createServer`

---

## 怎么找代码

| 想改… | 去哪 |
|---|---|
| 连接池 / SQL 重试 | `server/db.cjs` |
| 建表 / 补列 / 种子 | `server/schema.cjs` |
| C 端下单、我的预订、支付回调 | `server/routes/booking.cjs` |
| 家政 C 端下单 / 派单 / 报修 | `server/routes/jiazheng.cjs` |
| 后台 admin CRUD | `server/routes/admin.cjs` |
| catalog、商家 B 端会话、spots | `server/routes/api_direct.cjs` |
| 登录会话门闸、静态、启动 | `app.js` |

本地冒烟示例（需 `.env.test`，端口自定）：

```bash
set -a; . ./.env.test; set +a
PORT=8766 JUZHU_ENV=test node app.js
# 另开终端：
curl -sS http://127.0.0.1:8766/api/juzhu/auth/beike-config
curl -sS 'http://127.0.0.1:8766/api/juzhu/catalog?city=沈阳&lite=1'
```

冷启动第一次会卡在 `ensureSchema`；日志出现 `ensureSchema done` 后再打依赖库的接口更稳。`beike-config` 故意不连库，可用来确认进程已起来。

---

## 刻意没做的

- 不上 Nest / Next；继续模块化 CJS
- 不再继续拆 `api_direct` 内部（vendor / catalog 等）——需要时再开
- `app.js` 内 auth 门闸 / `handleAuthRoutes` 暂留（边界清晰但非刚需）

若继续拆，优先候选见对话结论：`api_direct → vendor`，或 `app.js → auth_gate.cjs` / `handleAuthRoutes`。
