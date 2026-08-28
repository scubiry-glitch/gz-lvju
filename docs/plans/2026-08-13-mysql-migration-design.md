# juzhu 后端 SQLite → MySQL 迁移设计方案

日期：2026-08-13
状态：待确认（Brainstorming 阶段产出）

## 1. 背景与目标

- juzhu 后端（`juzhu/server.py` 单文件 HTTP 服务）当前全量使用 SQLite（`juzhu/juzhu.db`），
  共 18 张表：房源频道（cities/districts/projects/units/photos/channels/settings）+
  生活服务专区与商家（jz_categories/jz_skus/jz_orders/jz_vendors/jz_products/jz_workers/
  jz_subcategories/jz_activities/jz_sku_workers/jz_sku_slots/gr_orders）。
- 目标：**全后端统一切换到 MySQL**（用户已确认方案 A），本地与测试环境共用同一个库。
- 连接信息（用户提供，已验证可连通，MySQL 5.7.44）：
  - host=62.234.26.57，port=3306，user=dba，password=dBa@sSkx)，database=juzhu
- 迁移数据源：测试服务器（49.232.103.71:/projects/beike/juzhu/juzhu.db）上的现有 SQLite 数据。

## 2. 关键约束（已实测）

1. `juzhu` 库在 MySQL 中**尚不存在**；`dba` 账号无 `CREATE DATABASE` 权限（1044 Access denied）。
   → 需运维先建库（utf8mb4）并授权；代码改造先行，建库后执行迁移。
2. MySQL 版本为 **5.7.44**：不支持 `CREATE INDEX IF NOT EXISTS`、`CHECK` 仅解析不生效；
   `ON DUPLICATE KEY UPDATE` 需用 `VALUES(col)` 写法（8.0.19 的 `AS new` 别名语法不可用）。
3. 本机已装 `pymysql 1.4.6`；测试服务器需补装（部署脚本加入幂等安装步骤）。
4. 工作区有未提交的进行中改动（多商家 vendor_id 等），本次改动在其基础上叠加，不得回退。
5. 部署方式：`publish_test.sh` rsync 整个目录（含 `juzhu/.env`）到测试机 → 配置随 .env 同步生效。

## 3. 架构决策

### 决策 1：新增 DB 连接抽象层 `juzhu/dbconn.py`（核心方案）

现有代码 200+ 处调用点使用 sqlite3 风格 API：`conn.execute(sql, params)`（`?` 占位符）、
`conn.executescript()`、`cursor.fetchone()/fetchall()/lastrowid/rowcount`、`sqlite3.Row`
（支持 `row["name"]`、`row[0]`、`dict(row)`）、`PRAGMA table_info`、`sqlite_master` 查询。

为最小化对上层 3 个模块（server.py / db.py / jiazheng_db.py）的侵入，`dbconn.py` 提供
**sqlite3 兼容连接包装器**（内部走 pymysql）：

- `connect()`：读取环境变量 `JUZHU_DB_HOST/PORT/USER/PASSWORD/NAME`（由 `tp_client.load_dotenv`
  加载 .env.local/.env，server.py 启动时已调用）；charset=utf8mb4，autocommit=False
  （与 sqlite3 隐式事务语义一致，现有 commit/close 行为不变）。
- `execute(sql, params)`：将 `?` 占位符翻译为 `%s` 后执行（需在实现时排查 SQL 字符串字面量中
  是否存在字面 `?`，本项目审计后确认全部为占位符）。
- `executescript(sql)`：按 `;` 切分逐条执行（本项目 SQL 文件无存储过程/触发器，朴素切分安全）。
- 行对象 `Row`：模仿 sqlite3.Row（int 下标 + 字符串下标 + keys() + dict(row) 兼容），
  由 pymysql 元组行 + cursor.description 构造。
- 方言拦截：
  - `PRAGMA foreign_keys = ON` → no-op（MySQL 外键恒开）；
  - `PRAGMA table_info(X)` → 查询 `information_schema.COLUMNS` 返回 (cid, name, type,
    notnull, dflt_value, pk) 兼容形状；
  - `SELECT name FROM sqlite_master WHERE type='table'` → 查询 `information_schema.TABLES`
    返回兼容形状（name/type 两列）。
- `conn.row_factory = ...` 赋值接受并忽略（统一返回 Row）。
- 连接按请求生命周期创建（现有 handler 内 `connect()` 模式不变），不存在长期空闲连接，
  无需 ping/reconnect 逻辑。

**被否决的替代方案**：
- 全量手工改写 3 个模块的 SQL（把 `?`→`%s`、重写全部行访问代码）：改动面 500+ 行、回归风险大。
- SQLAlchemy/ORM 引入：与单文件脚本式代码风格不符，且同样要改全部调用点。

### 决策 2：MySQL 建表 DDL 独立为 `juzhu/mysql_schema.sql`

原 `schema.sql` / `jiazheng_schema.sql` 为 SQLite 方言，保留不动（sqlite 库文件继续存在，
仅不再被读取）。新建 MySQL DDL，要点：

- 类型映射：
  - `INTEGER PRIMARY KEY` → `INT AUTO_INCREMENT PRIMARY KEY`（自增表）；
  - 文本主键改定长：`channels.id`/`jz_categories.id` → `VARCHAR(32)`，`jz_orders.id` → `VARCHAR(64)`，
    `settings.key` → `VARCHAR(64)`；
  - 被索引/唯一约束的 TEXT 列改 VARCHAR（MySQL 5.7 索引 TEXT 需前缀长度）：
    status/type/level/parent_type → `VARCHAR(32)`，slug/name/label → `VARCHAR(128)`，
    slot_date → `VARCHAR(10)`，start_time/end_time → `VARCHAR(5)`，order_ref → `VARCHAR(64)`，
    file_path 等未索引列保持 TEXT；
  - `CHECK(...)` 约束删除（5.7 不生效，徒增误导）；
  - `DEFAULT (datetime('now','localtime'))` → `DATETIME DEFAULT CURRENT_TIMESTAMP`。
- 索引幂等：**索引一律内联进 CREATE TABLE（KEY(...) 子句）**，仅用 `CREATE TABLE IF NOT EXISTS`
  （MySQL 5.7 不支持 CREATE INDEX IF NOT EXISTS），保证 ensure_schema 每次启动重放安全。
- 外键约束保留（与 SQLite 语义一致，删除业务代码依赖的外键清理顺序不变）。

### 决策 3：`db.py` 改造

- `connect()` 改调 `dbconn.connect()`；`ensure_schema()` 改读 `mysql_schema.sql`；
  `PRAGMA table_info`/`sqlite_master` 调用点保持不变（由 dbconn 拦截翻译）；
  `ALTER TABLE ... ADD COLUMN` 迁移守卫逻辑保留（列存在性检查语义不变）。
- `ON CONFLICT(id) DO UPDATE SET ...` 种子 upsert（jz_categories/jz_skus）→
  `ON DUPLICATE KEY UPDATE col=VALUES(col)`。
- `ensure_settings` / `ensure_channels` 的 executescript 建表改为从 mysql_schema.sql 统一建表，
  种子 INSERT 改 `INSERT IGNORE`。
- `export_json` 等查询语句均为可移植 SQL，无需改动（COALESCE/ORDER BY/IN 均兼容）。

### 决策 4：`jiazheng_db.py` 改造

- `upsert_activity`：`ON CONFLICT(activity_id) DO UPDATE` → `ON DUPLICATE KEY UPDATE`。
- `set_product_workers`：`INSERT OR IGNORE` → `INSERT IGNORE`。
- `IFNULL(worker_id,0)=IFNULL(?,0)` MySQL 原生支持，不动。
- `cursor.lastrowid` 由 dbconn 映射为 `conn.insert_id()`。

### 决策 5：`jiazheng_api.py`（商家 API）改造

- `_connect_db()` 改调 `db.connect()`（与主服务同一 MySQL 库）；
  删除自带的 `schema.sql` executescript 自愈逻辑（由 connect→ensure_schema 统一处理）。
- 其余 SQL 均为可移植语句（含 LIKE/IN），不改。

### 决策 6：`server.py` 方言点改造（共 4 处）

- 订单概览 `_jz_order_overview`：
  - `date(created_at)=?` → `DATE(created_at)=?`（MySQL 同名函数，仅大小写）；
  - `date('now','localtime','-' || ? || ' days')` → `DATE(DATE_SUB(NOW(), INTERVAL ? DAY))`
    （注意 MySQL 中 `||` 是逻辑或，必须消除）；
  - `strftime('%Y-%m','now','localtime','-' || ? || ' months')` →
    `DATE_FORMAT(DATE_SUB(NOW(), INTERVAL ? MONTH), '%Y-%m')`；
  - `strftime('%Y-%m', created_at)` → `DATE_FORMAT(created_at, '%Y-%m')`。
- settings 写入：`ON CONFLICT(key) DO UPDATE SET value=excluded.value` →
  `ON DUPLICATE KEY UPDATE value=VALUES(value)`。
- 其余 SQL 均为可移植语句。

### 决策 7：`.env` 与 `.env.example` 增加数据库配置块

```ini
# ── MySQL 数据库（本地与测试环境共用同一实例） ──
JUZHU_DB_HOST=62.234.26.57
JUZHU_DB_PORT=3306
JUZHU_DB_USER=dba
JUZHU_DB_PASSWORD=dBa@sSkx)
JUZHU_DB_NAME=juzhu
```

- `.env` 写入真实值（部署脚本 rsync 会同步到测试机，两端配置一致）；
- `.env.example` 写入同结构占位符 + 注释（不含真实口令，与现有风格一致）。

### 决策 8：数据迁移脚本 `juzhu/migrate_to_mysql.py`

- 输入：SQLite 库文件路径（默认 `juzhu/juzhu.db`，执行时从测试服务器拉取
  `49.232.103.71:/projects/beike/juzhu/juzhu.db` 作为迁移源；拉取失败则回退本地库并警告）。
- 流程：
  1. 连接 MySQL（不自动建库——建库由运维完成，脚本检测库不存在则报错退出）；
  2. 重放 `mysql_schema.sql` 建表（IF NOT EXISTS 幂等）；
  3. 按外键依赖顺序清空目标表（TRUNCATE，仅限本次迁移的 18 张表）并逐表全量导入：
     cities → districts → projects → units → photos → channels → settings →
     jz_categories → jz_skus → jz_vendors → jz_subcategories → jz_activities →
     jz_workers → jz_products → jz_sku_workers → jz_sku_slots → jz_orders → gr_orders；
  4. 显式写入自增 id（MySQL 允许，InnoDB 自动把 AUTO_INCREMENT 推到 max+1）；
  5. 逐表打印 源行数/目标行数 对比校验，不一致即非零退出。
- SQLite → MySQL 值转换：int/float/str 原生透传；bytes 解码 utf-8；NULL 保持 NULL。

### 决策 9：种子/维护脚本适配

`seed_jiazheng.py`、`seed_demo_cities.py`、`seed_from_folder.py`、`restore_housing_from_json.py`
中 `sqlite3.connect(...)` 一律改 `db.connect()`（走 MySQL）：
- `seed_from_folder.py` 的“删除旧 sqlite 库文件”逻辑改为清空 MySQL 对应表；
- 其余种子数据逻辑不变（数据不变，仅连接层变化）。

### 决策 10：部署脚本 `publish_test.sh` 调整

- 移除/停用 `-db` 参数（不再同步 sqlite 库文件；库文件始终排除）；
- 重启服务前增加幂等步骤：检测远端 `python3 -c "import pymysql"`，缺失则 `pip3 install pymysql`；
- rsync 排除列表维持现状（.env 正常同步）。

### 决策 11：不做的事（YAGNI）

- 不做 SQLite/MySQL 双引擎运行时切换（数据会分叉，违背“两端同库”目标；回滚走 git revert）。
- 不改任何前端页面/接口契约（后端兼容层保证响应 JSON 形状不变，前端零改动）。
- 不动 HMAC 密钥文件机制（仍为本地文件，与 DB 无关）。
- 不迁移 `jiazheng.db`（项目根目录，独立的老家政演示库，非服务端数据源）。

## 4. 执行顺序与回滚

1. 代码改造（本阶段）：dbconn.py → db.py → jiazheng_db.py → jiazheng_api.py →
   gr_orders.py → server.py → .env/.env.example → mysql_schema.sql → migrate_to_mysql.py →
   种子脚本 → publish_test.sh；
2. 单元/冒烟测试（可离线部分先行；MySQL 集成测试等建库后跑）；
3. **检查点：等运维建好 `juzhu` 库**（阻塞迁移步骤）；
4. 从测试服务器拉取 juzhu.db → 运行 migrate_to_mysql.py → 行数校验；
5. 本地启动 server.py 指向 MySQL 冒烟（jiazheng 列表/详情/下单/商家 API 全链路）；
6. 执行 publish_test.sh 发布 → 测试服务器重启 → 远程冒烟
   （`test_vendor_api.py` 17 请求全绿 + `test_jiazheng_flow.py` 四品类全流程）；
7. 回滚方案：`git revert` 本系列提交 + 测试机换回旧 sqlite 库文件（原库文件全程保留不删）。

## 5. 测试计划（TDD）

- `test_dbconn.py`（新）：
  - Row 下标/键名/keys()/dict() 兼容性；
  - `?`→`%s` 占位符翻译（含无参数、多参数、LIKE 场景）；
  - PRAGMA table_info / sqlite_master 拦截映射（对 MySQL 执行，建库后跑）；
  - executescript 切分与执行、lastrowid/rowcount（建库后跑）。
- `test_mysql_migration.py`（新，建库后跑）：migrate 脚本对样例 SQLite 库的迁移与行数校验。
- 既有冒烟脚本改造后重跑：`test_jiazheng_flow.py`、`test_vendor_api.py`（指向测试环境）。
- 建库前的可执行验证：pymysql 连接探测脚本、dbconn 纯函数单元测试。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| dba 无建库权限（已实测） | 检查点阻塞迁移步骤；代码先行，不阻塞开发 |
| `?` 占位符全局替换误伤字面量 | 实现时 grep 审计全部 SQL 字符串；dbconn 单测覆盖 |
| MySQL 5.7 方言差异（INDEX IF NOT EXISTS / CHECK / VALUES()） | 内联索引 + 删 CHECK + VALUES() 写法（见决策 2） |
| TEXT 列被索引导致建表失败 | 索引列全部改 VARCHAR（见决策 2） |
| 测试机无 pymysql | publish_test.sh 幂等安装步骤 |
| 迁移后 AUTO_INCREMENT 错位 | 显式插入 id，InnoDB 自动推进（迁移脚本校验行数） |
| 时区差异（NOW() vs localtime） | 服务器均为东八区，MySQL 会话时区=系统时区，口径一致 |
