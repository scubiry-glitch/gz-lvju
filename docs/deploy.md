# 新居住 Node 部署说明

线上运行时是 **纯 Node + MySQL**：SCF 入口 `scf_bootstrap` → `node app.js`，`/api/juzhu/*` 直连 MySQL，**不再依赖 Python**。

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

**线上不用。** `scf_bootstrap` 只 `exec node app.js`。

`juzhu/server.py` 保留为：

- 本地/历史联调（端口 8765）
- Python 单测与商家 HMAC 回归脚本（`juzhu/test_vendor_api.py` 等）
- 已通过 `dbconn.py` 改连 **同一套 MySQL**，不再读写 `juzhu.db`

新接口与种子以 Node 为准。不要在 SCF 部署里再启 Python。
