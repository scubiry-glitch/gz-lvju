# xjz.ke.com 敏感信息泄露 — 修复报告

| 字段 | 内容 |
|---|---|
| 漏洞名称 | 静态资源未鉴权导致源码 / 数据库凭证 / API Key 泄露 |
| 影响域名 | `https://xjz.ke.com` |
| 严重级别 | **高危**（可直连生产库、伪造管理写操作） |
| 发现日期 | 2026-08-12 |
| 修复分支 | `cursor`（待合入生产部署分支并 redeploy） |
| 报告日期 | 2026-08-12 |

---

## 1. 漏洞说明

`xjz.ke.com` 采用 Serverless（SCF）部署：Node `app.js` 以前台进程托管**整仓静态文件**，并反向代理 `/api/juzhu/*` 到 Python；部署脚本将运行时 `.env` 打进制品包。

静态层此前**未拦截**敏感路径，导致攻击者可直接 HTTP GET 读取：

| 泄露面 | 示例路径 | 后果 |
|---|---|---|
| 数据库凭证 | `/.env`（由 `.env.prod` 复制） | MySQL host / user / **明文 password** |
| 工程元信息 | `/package.json`、`/.gitignore`、`/README.md` | 暴露技术栈与仓库结构 |
| 源码 | `/app.js`、`/juzhu/server.py` 等 | 含历史硬编码 DB fallback、鉴权逻辑 |
| API 文档密钥 | `/docs/api-document.html`、`/api_doc.md` | 历史默认 `dev-juzhu-key`、vendor HMAC 等 |

报告复现（摘要）：

1. `GET https://xjz.ke.com/.env` → 200，返回 `MYSQL_*` 明文  
2. `GET https://xjz.ke.com/package.json` → 200  
3. 文档页暴露默认 API Key `dev-juzhu-key`

> 修复验证当日线上 SCF 曾整体异常（`python3: not found`），无法二次现场拉取正文；定性依据为漏洞报告截图 + `lianjia/master` 源码审计。

---

## 2. 根因分析

```
moma_deploy.js  ──copy──►  .env.prod → .env  ──zip──►  制品
                                              │
scf_bootstrap  ──source .env──►  进程环境变量
                                              │
app.js  ──fs.readFile(仓库根任意路径)──►  HTTP 200（无敏感拦截）
```

1. **错误信任静态根**：`app.js` 仅做目录穿越检查，未做敏感文件拒绝列表。  
2. **密钥进 Web 根目录**：运行时 `.env` 与可访问静态文件同目录。  
3. **源码硬编码 fallback**：旧 `app.js` 在环境变量缺失时仍可使用内置 MySQL 账号。  
4. **默认 API Key 可被文档泄露利用**：`dev-juzhu-key` 曾作为有效密钥。  
5. **分支分裂**：Python 侧曾加拦截（`cursor`），生产 Node 入口未同步。

---

## 3. 修复内容（已完成）

### 3.1 静态资源拦截（Node + Python 同口径）

- **文件**：`app.js`（`isPublicStatic`）、`juzhu/server.py`（`is_public_static`）
- **拦截**：
  - 全部 `.env*` / 隐藏文件
  - `*.py` / `*.db` / `*.sql` / `*.ini` / `*.key` / `*.sh` / `*.md` 等
  - `package.json`、根目录 `app.js`、`scf_bootstrap`、`moma_*`
  - `/juzhu/` 仅白名单：`app.js`、`cities.json`、`data.json`、`data-*.json`
  - 生产（`JUZHU_ENV=production|prod`）禁用整棵 `/docs/`
  - 禁止目录列表；`node_modules` / `scripts` 不可外访

### 3.2 去除源码内数据库默认凭证

- `app.js` `getDbConfig()`：**必须**提供 `MYSQL_HOST/DB/USER/PASSWORD`，否则抛错，无内置账号。

### 3.3 API Key / 管理口令策略收紧

- 历史默认 `dev-juzhu-key`：**任何环境均视为无效**（Node + Python）。  
- 生产缺少有效 `JUZHU_API_KEY` / `JUZHU_ADMIN_PASSWORD`：启动失败（`scf_bootstrap` + `app.js`）。  
- 前端/`_jzapi.js`/`juzhu-admin*.html`/家政管理页：**不再内嵌**默认 Key，改为读 `localStorage` 或提示配置。  
- Admin 写接口（含 Node fallback）强制 API Key（`auth/login|check` 除外）。

### 3.4 部署与引导脚本

- `scf_bootstrap`：`.env` 可选；生产缺密钥/缺 MySQL 则 `exit 1`。  
- `moma_deploy.js`：打包说明与排除密钥文档；`.env` 仅供进程，依赖 HTTP 拦截。  
- 根目录 `.env.example`：无真实密钥的配置模板（`.env.*` 已 gitignore）。

### 3.5 回归单测

```bash
python3 juzhu/test_static_guard.py
node test_static_guard.js
```

覆盖：敏感路径 404 策略、生产 `/docs/` 禁用、禁止默认 API Key。

---

## 4. 运维必做项（代码无法替代）

以下密钥**已在公网暴露过**，必须轮换后才能视为闭环：

| 序号 | 动作 | 负责人 | 状态 |
|---|---|---|---|
| 1 | 轮换生产 MySQL 账号密码（报告中的生产库账号 + 历史硬编码账号） | DBA / 运维 | ⬜ 待执行 |
| 2 | 轮换 vendor HMAC、`JUZHU_API_KEY`、`JUZHU_ADMIN_PASSWORD`、话务 `TP_APP_KEY`（若曾进 `.env.test`） | 业务运维 | ⬜ 待执行 |
| 3 | 从 Git / 制品库移除 `.env.prod`、`.env.test`；改用平台密钥或本地 gitignore 文件 | 研发 | ⬜ 待执行（`cursor` 已不包含；需清理 `lianjia/master`） |
| 4 | 将本修复合入生产分支并 **redeploy** `xjz.ke.com` | 研发 | ⬜ 待执行 |
| 5 | 生产环境变量：`JUZHU_ENV=production` + 新 API Key + 新管理口令 + MySQL | 运维 | ⬜ 待执行 |
| 6 | 上线后验收（见 §5） | 测试 / 研发 | ⬜ 待执行 |

---

## 5. 上线验收清单

对 `https://xjz.ke.com` 逐项确认均为 **404**（或非 200 正文）：

- [ ] `/.env`
- [ ] `/.env.prod`
- [ ] `/package.json`
- [ ] `/.gitignore`
- [ ] `/README.md`
- [ ] `/app.js`
- [ ] `/juzhu/server.py`
- [ ] `/api_doc.md`
- [ ] `/docs/api-document.html`
- [ ] `/scf_bootstrap`

业务可用性：

- [ ] `/` 或首页 HTML 200  
- [ ] `/juzhu/app.js`、`/juzhu/data.json`（或城市 data）200  
- [ ] 管理写接口无有效 Key → 401；有效 Key → 正常  
- [ ] 使用 `dev-juzhu-key` → 401  

---

## 6. 涉及文件清单

| 文件 | 变更要点 |
|---|---|
| `app.js` | 静态拦截、去硬编码 DB、API Key 策略、生产启动门禁 |
| `juzhu/server.py` | 同口径静态拦截；默认 Key 永久失效 |
| `scf_bootstrap` | 可选 `.env`；生产硬门禁 |
| `moma_deploy.js` | 打包排除与告警 |
| `package.json` | 部署清单（HTTP 仍拦截） |
| `.env.example` | 根目录模板 |
| `screens/_jzapi.js` 等前端 | 去除内嵌默认 Key |
| `juzhu-admin.html` / `juzhu-admin-unit.html` | 同上 |
| `juzhu/test_static_guard.py` / `test_static_guard.js` | 回归 |
| `CLAUDE.md` / `README.md` / `juzhu/README.md` | 约定同步 |

---

## 7. 残留风险与建议

1. **Git 历史**仍可能含旧 `.env.prod` / 硬编码密码提交；需轮换密钥，必要时对历史做清理或仓库权限收紧。  
2. **当前线上 SCF** 若仍缺 Python runtime，API 依赖 Node fallback；修复部署时建议确认 runtime 含 Python 3.10，或明确「仅 Node + MySQL」模式。  
3. 前端静态页仍可能被篡改 localStorage 后带 Key 调用 API——属持有密钥后的正常能力；关键是 Key 不再公开、可轮换。  
4. 建议在网关/Kong 层增加二次规则：拒绝 `/\.`、`*.env`、`package.json`、`*.py`（纵深防御）。

---

## 8. 结论

应用层修复已在 `cursor` 完成：静态敏感路径不可读、默认 API Key 失效、源码不再携带 DB 默认凭证，并具备单测与生产启动门禁。

**安全闭环条件** = 本报告 §4 运维项全部完成 + §5 验收通过。未轮换已泄露数据库密码前，不得宣称风险已消除。

---

## 9. 执行进度（2026-08-12 22:50）

| 项 | 内容 | 状态 |
|---|---|---|
| 代码修复 | `cursor`：`2c4a72c` / `d823ce8` | ✅ 本地已提交 |
| 2. 去掉入库 `.env.*` | 分支 `security/remove-env-secrets`：`6afe78b`（基于 `lianjia/master` 删除 `.env.prod`/`.env.test`） | ✅ 本地已提交；⏳ 推远程受阻 |
| 3. 合入 + redeploy | 需 push / moma 发布 + 平台注入 `MYSQL_*` / `JUZHU_*` | ⏳ 未完成（git push 挂起；线上 SCF 仍 443） |
| 4. §5 验收 | 探测 `xjz.ke.com` 全路径 HTTP **443** + body「python3: not found」 | ⚠️ 站点不可用，无法验收静态拦截是否生效 |

**说明：** 未完成密钥轮换（报告 §4 第 1 项）前，即便拦截上线，已泄露的 DB 凭证仍视为有效风险。

手动补推 / 部署命令：

```bash
# 推删除密钥提交
git push -u lianjia security/remove-env-secrets
# 推修复代码
git push -u origin cursor
git push lianjia cursor:cursor-security-fix

# 合并删除提交到 master 后，用 moma 按 prod 发布（须已配置平台 MYSQL_* / JUZHU_ENV / JUZHU_API_KEY）
```
