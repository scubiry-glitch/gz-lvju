# 新居住 Node 部署说明

线上运行时是 **纯 Node + MySQL**：SCF 入口 `scf_bootstrap` → `node app.js`，`/api/juzhu/*` 直连 MySQL，**不再依赖 Python**。

> **前后端分离部署**：静态前端（nginx 直服务，无需 Node）与后端 API（`node app.js` + MySQL）分开部署，二者只经 `/api/` 反代耦合，可分机放置、独立发布。分机/分进程部署见 **§4**。

## 1. 启动

```bash
# 依赖
npm install

# 环境变量（进程内读取，禁止经 HTTP 暴露）
# 可用仓库根 .env，或平台注入 MYSQL_* / JUZHU_*
export MYSQL_HOST=...
export MYSQL_PORT=3306
export MYSQL_DB=juzhu
export MYSQL_USER=...
export MYSQL_PASSWORD=...
# 兼容 Python 侧同名：JUZHU_DB_HOST / JUZHU_DB_PORT / JUZHU_DB_NAME / JUZHU_DB_USER / JUZHU_DB_PASSWORD

export JUZHU_API_KEY='<生产密钥>'          # 禁止再用历史默认 dev-juzhu-key
export JUZHU_ADMIN_PASSWORD='<生产密码>'
export JUZHU_ENV=production                # 生产必填，缺密钥/缺 MySQL 会拒绝启动

node app.js                                # 默认 PORT=9000；平台注入 PORT 优先
```

商家 HMAC 密钥存 `jz_vendors` 表（`hmac_key`/`url_link`/`order_detail_url` 列），Node/Python 双端统一从表读取（进程内懒加载缓存，改表后需重启服务生效）。旧文件 `juzhu/hmac_secret.key` 已废弃，若仍存在仅在首次加载时向表导入（表中为空才导入，不覆盖已有值）。

启动时 `ensureSchema()` 会建表；**对应表为空**时再灌家政种子（`jz_seed.cjs`）和保租房 JSON 种子（`housing_seed.cjs`）。已有数据不会被覆盖。

## 2. SQLite → MySQL 一次性迁移（Node）

空库种子 ≠ 把旧 SQLite 存量搬过来。若要把历史 `juzhu.db` 全量导入当前 MySQL，用 Node 一次性工具（对齐原 `juzhu/migrate_to_mysql.py`）：

```bash
# 默认源 /tmp/test_juzhu.db；目标走 MYSQL_* / JUZHU_DB_*（与 app.js 同一套）
node migrate_to_mysql.cjs /path/to/juzhu.db
```

要求：

- 已 `npm install`（用 `mysql2`）
- 本机有 **Node 22+**（`node:sqlite`）或系统 `sqlite3` CLI（`sqlite3 -json`）
- 目标库账号可写；脚本会先 `ensureSchema` 建表，再 `DELETE` + 按外键顺序导入
- **会清空目标表后全量覆盖**，不要对已有生产增量数据重复跑

退出码：`0` 行数一致，`1` 行数不一致，`2` 源库不存在。

可选：若已有 `juzhu/_mysql_dump.json`，启动时 `juzhu_import.cjs` 会在表空时导入，不必再跑本脚本。

## 3. Python `juzhu/server.py` 还用吗？

**不用（含本地）。** `scf_bootstrap` 只 `exec node app.js`。按 CLAUDE.md 规则 12/14（2026-09-04 拍板：只用 Node，不用 Python），Python 存量（`juzhu/server.py`、`juzhu/test_vendor_api.py`、`dbconn.py` 等）**仅作历史参考保留，不运行、不维护、不扩展**：

- 本地联调 → 直接跑 `node app.js`（同一路径，见 §4.2）
- 商家 HMAC 回归 → 用 Node 脚本直调开放接口，不用 `juzhu/test_vendor_api.py`
- 新接口与种子以 Node 为准，任何新代码不得引入 Python

## 4. 前后端分离部署（静态站 + Node API 分开）

架构上只有两块，互相之间**唯一的耦合点是 `/api/` 反代**：

```
┌─ 前端（静态，无状态，不需要 Node）─┐     ┌─ 后端（Node API + MySQL）──────┐
│ nginx root → 静态目录（HTML/JS/JSON）│ ──→ │ node app.js（监听 127.0.0.1:N）│ ──→ MySQL
│ 浏览器直接访问，页面内 fetch('/api/…')│     │ 规则12：唯一运行时，无 Python   │
└──────────────────────────────────┘     └───────────────────────────────┘
```

### 4.1 前端（静态站）部署

```nginx
server {
    listen 443 ssl;
    server_name <your-domain>;
    root /srv/sy-web;                 # 静态产物目录（仓库的页面与 screens/ 等）
    index index.html;
    charset utf-8;
    autoindex off;                    # 规则11：禁止目录列表

    # 规则11：源码/密钥/部署产物必须拦截（完整清单见 §11 与本仓库
    # /etc/nginx/conf.d/sytest.meizu.life.conf 的现行实现）
    location ~ /\.(?!well-known) { deny all; }        # .env* .git
    location = /app.js       { deny all; }            # 根 Node 入口
    location = /runtime.env  { deny all; }
    location = /package.json { deny all; }
    location ~* \.(py|db|sql|ini|cjs|mjs|sh)$ { deny all; }
    # 若把 /juzhu/ 目录也放进来：仅白名单 app.js / cities.json / data.json / data-*.json

    location ^~ /api/ {               # 唯一耦合点：反代到后端
        proxy_pass http://127.0.0.1:8766;   # 后端与本机同机时；分机换成内网 IP
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

- 前端是**纯静态产物**：`rsync`/CI 上传 → reload 即发布，可独立回滚（保留上一版目录软链切换）。
- 页面调 API 用**相对路径** `/api/…`（现有 `_jzapi.js` 即如此），同域反代免 CORS；若前后端确需跨域，由后端加 CORS 白名单，不在前端写死绝对后端地址。

### 4.2 后端（Node API）部署

```bash
npm install                       # mysql2（生产依赖）
export MYSQL_HOST=... MYSQL_PORT=3306 MYSQL_DB=juzhu MYSQL_USER=... MYSQL_PASSWORD=...
export JUZHU_API_KEY='<生产密钥>'    # 禁止 dev-juzhu-key
export JUZHU_ADMIN_PASSWORD='<生产密码>'
export JUZHU_ENV=production
PORT=8766 node app.js             # 只监听 127.0.0.1，由 nginx/网关对外
```

要点：

- **后端可单独换端口/单独重启**，前端零改动（反代地址改一行）。端口冲突时换 `PORT` 即可，8765 在本机已被其它服务占用，现用 **8766**。
- 进程守护建议 systemd（`setsid nohup` 仅适合临时）：

```ini
# /etc/systemd/system/juzhu-api.service
[Service]
WorkingDirectory=/srv/sy-api
EnvironmentFile=/srv/sy-api/runtime.env          # 权限 600，不入 git
ExecStart=/usr/bin/node app.js
Environment=PORT=8766
Restart=always
User=www
```

- 分机部署时：后端机只开 `127.0.0.1`（同机反代）或内网安全组（跨机反代），**绝不经公网直连**；MySQL 账号只授后端机来源 IP。
- 健康检查：`curl -s http://127.0.0.1:8766/api/juzhu/catalog?city=<slug>&lite=1` 返回 200 JSON；冷启动首跑 `ensureSchema` 可能耗时数分钟（弱网远程库更明显），期间 API 挂起属正常，等日志 `ensureSchema done`。

### 4.3 本仓库预览环境（现况参考，2026-09-04）

| 项 | 值 |
|---|---|
| 前端 | nginx `sytest.meizu.life`，root 直服务本仓库 `/proweb/run/sy`（改动即生效） |
| 后端 | `node app.js`，`PORT=8766`，setsid 裸进程（重启机器不自拉） |
| MySQL | 远程测试库（`juzhu/.env.local` 配置，gitignored），启动前 `set -a; . juzhu/.env.local; set +a` |
| 日志 | `/var/log/juzhu-api.log` |
| nginx conf | `/etc/nginx/conf.d/sytest.meizu.life.conf`（改前备份 `.bak.20260904-pre-mysql`） |
