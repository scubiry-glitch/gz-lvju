# xjz.ke.com 管理员 API 未授权 — 修复报告

| 字段 | 内容 |
|---|---|
| 漏洞名称 | `/api/juzhu/admin/*` 未授权 CRUD |
| 影响域名 | `https://xjz.ke.com` |
| 严重级别 | **高危**（可无认证创建/修改/删除行政区、项目、户型与全局设置） |
| 发现日期 | 2026-08-12 |
| 修复日期 | 2026-08-12 |
| 修复范围 | Node `app.js` + Python `juzhu/server.py` + 前端去硬编码密钥 |
| 代码状态 | **已闭环** |
| 生产状态 | **待部署验收** |
| 报告来源 | Canvas `juzhu-admin-unauth-fix-report` 导出 |

---

## 修复结论

三项要求已在仓库落地：

1. **admin 全方法强制 API Key**（含 Node `handleApiDirect` fallback）
2. **密钥只从 `.env` / 环境变量读取**（本地可用示例值 `dev-juzhu-key`；生产禁止该示例值；前端不硬编码）
3. **生产禁用 `/docs/` 与 API 文档页**

线上需部署后用无头 curl 复验 **401**。若 `xjz.ke.com` 仍处于 SCF 异常，以部署后验收为准。

| 指标 | 值 |
|---|---|
| 要求完成 | 3/3 |
| 无密钥期望码 | 401 |
| 开发示例密钥 | 仅 `.env` 配置；生产拒绝 |
| 生产验收 | 待发版 |

---

## 三项要求落地

| ID | 要求 | 实现 | 状态 |
|---|---|---|---|
| R1 | 所有 admin 端点强制认证 | Python `_require_api_key`；Node `assertAdminAuthorized`（`handleApiDirect` 入口） | 已完成 |
| R2 | 密钥改由 `.env` 配置 | `JUZHU_API_KEY` 只读环境变量；本地 `.env` 可用 `dev-juzhu-key`；生产禁止该示例值；前端不硬编码 | 已完成 |
| R3 | 生产禁用 API 文档页 | 拦截 `api-document.html` 等；生产 `isPublicStatic` 拒绝整个 `/docs/` | 已完成 |

---

## 根因（已堵住）

Node 双引擎在 Python 不可用时走 `handleApiDirect` 直连 MySQL，原实现**零鉴权**，导致「无认证头 → 201」。

现于 fallback 入口强制 API Key：

- 无密钥 → **401**
- 生产环境使用开发示例密钥 → **401 / 拒绝启动**
- 开发环境须在 `.env` 显式配置 `JUZHU_API_KEY`（可用 `dev-juzhu-key`）

---

## 主要改动文件

| 文件 | 说明 |
|---|---|
| `app.js` | admin 中间件 + 静态/文档拦截 + 生产启动校验 |
| `juzhu/server.py` | API Key 只读环境变量；生产禁 `/docs/` |
| `juzhu/.env.example` / `.env.example` | 本地示例 `JUZHU_API_KEY=dev-juzhu-key` |
| `juzhu-admin*.html` / `screens/_jzapi.js` / `p-jz-*` | 去硬编码密钥 |
| `scripts/test_juzhu_admin_auth.js` | 单测验收 |

---

## 复现路径对照（修复后期望）

| 步骤 | 请求 | 修复前 | 修复后 |
|---|---|---|---|
| 1 | `GET /docs/api-document.html` | 公开 + 默认密钥 | 404（始终拦文档名；生产整目录） |
| 2 | `POST .../admin/districts` 无头 | 201 | 401 |
| 3 | `POST .../admin/projects` 无头 | 201 | 401 |
| 4 | `POST .../units` 无头 | 201 | 401 |
| 5 | `PUT .../admin/settings` 无头 | 200 | 401 |
| 6 | `DELETE` admin CRUD 无头 | 成功 | 401 |
| 7 | 生产环境 `X-API-Key: dev-juzhu-key` | 可能成功 | 401 |

---

## 本地已跑通

```bash
node scripts/test_juzhu_admin_auth.js
```

同时已对 Python `_expected_api_key` / `is_public_static` 做断言校验。

---

## 部署验收清单

| # | 动作 | 期望 |
|---|---|---|
| 1 | 设置 `JUZHU_ENV=production` 与强随机 `JUZHU_API_KEY` / `JUZHU_ADMIN_PASSWORD` | 进程可启动 |
| 2 | 生产环境变量不得使用 `dev-juzhu-key` | 使用则 FATAL / 401 |
| 3 | 无头 `POST` `admin/districts\|projects\|settings` | 401 |
| 4 | 带正确 `X-API-Key` 写操作 | 业务成功码 |
| 5 | 访问 `/docs/api-document.html` | 404 |
| 6 | 公网 HTML/JS 搜索业务硬编码密钥 | 无（仅常量黑名单/示例名） |

### 建议验收命令（部署后）

```bash
# 无认证头 → 期望 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  'https://xjz.ke.com/api/juzhu/admin/districts' \
  -H 'Content-Type: application/json' \
  -d '{"name":"probe"}'

# 生产使用开发示例密钥 → 期望 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  'https://xjz.ke.com/api/juzhu/admin/districts' \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: dev-juzhu-key' \
  -d '{"name":"probe"}'

# 文档页 → 期望 404
curl -sS -o /dev/null -w '%{http_code}\n' \
  'https://xjz.ke.com/docs/api-document.html'
```

---

## 运维注意

- 后台与家政管理台须事先配置 `localStorage.JUZHU_API_KEY`（与服务端 `.env` 一致）。
- 未配置将收到 **401**，不再静默使用页面内硬编码密钥。
- 本地开发：在 `juzhu/.env.local` 或根 `.env` 配置：

```env
JUZHU_ENV=dev
JUZHU_API_KEY=dev-juzhu-key
```

- 生产必须换成强随机值，且 `JUZHU_ENV=production`。

---

## 报告元信息

- 报告版本：代码修复闭环 · 2026-08-12  
- 不含真实生产密钥  
- 同源 Canvas：`juzhu-admin-unauth-fix-report.canvas.tsx`
