# juzhu 后端 SQLite → MySQL 迁移实施计划

日期：2026-08-13
设计文档：docs/plans/2026-08-13-mysql-migration-design.md
执行模式：手动执行（本会话逐任务实施，TDD 优先）

## 任务清单（按序执行，每任务：测试 → 实现 → 提交）

### T1. 连接抽象层 juzhu/dbconn.py（含单测 test_dbconn.py）
- `connect()`：环境变量 JUZHU_DB_* → pymysql（utf8mb4，autocommit=False）
- `Row` 类：模仿 sqlite3.Row（int/str 下标、keys()、dict(row)）
- `MysqlConn.execute()`：`?`→`%s` 翻译；`PRAGMA table_info` / `sqlite_master` / `PRAGMA foreign_keys` 拦截
- `executescript()` 切分执行；cursor 提供 fetchone/fetchall/lastrowid/rowcount
- 单测先行：占位符翻译、Row 行为（纯函数部分无需 DB）

### T2. MySQL DDL：juzhu/mysql_schema.sql（18 张表）
- 自增主键 INT AUTO_INCREMENT；文本主键 VARCHAR；索引列 TEXT→VARCHAR
- 索引内联进 CREATE TABLE（幂等）；删 CHECK；DATETIME DEFAULT CURRENT_TIMESTAMP

### T3. db.py 切换
- connect() → dbconn.connect()；ensure_schema 读 mysql_schema.sql
- ON CONFLICT → ON DUPLICATE KEY UPDATE（jz_categories/jz_skus 种子）
- ensure_settings/ensure_channels 建表改自 DDL，INSERT IGNORE

### T4. jiazheng_db.py 方言
- upsert_activity → ON DUPLICATE KEY UPDATE；set_product_workers → INSERT IGNORE

### T5. jiazheng_api.py（商家 API）
- _connect_db() → db.connect()；移除自带 schema.sql 自愈

### T6. gr_orders.py
- 移除未用 sqlite3 import（SQL 本身可移植）

### T7. server.py 方言（4 处）
- _jz_order_overview：DATE()/DATE_SUB(INTERVAL)/DATE_FORMAT
- settings upsert → ON DUPLICATE KEY UPDATE

### T8. 配置：.env + .env.example 增加 JUZHU_DB_* 块

### T9. 迁移脚本 juzhu/migrate_to_mysql.py
- 拉取测试机 juzhu.db（sshpass，凭据复用 publish_test.sh）→ 建表 → 按 FK 顺序清空+全量导入 → 行数校验

### T10. 种子/维护脚本 ×4 改 db.connect()

### T11. publish_test.sh：停用 -db；远端幂等安装 pymysql

### T12. 数据迁移执行（前置：运维 GRANT CREATE/DROP/INDEX）
- 探测权限 → 迁移 → 行数校验 → 提交记录

### T13. 冒烟与发布
- 本地起服务（MySQL）跑 test_jiazheng_flow.py
- publish_test.sh 发布 → 测试机重启 → test_vendor_api.py 17 请求全绿

## 验证口径
- 全部 SQL 无 sqlite 专属函数残留（grep strftime/PRAGMA/ON CONFLICT/INSERT OR）
- 迁移后 MySQL 各表行数 == SQLite 源行数
- 前端零改动；API 响应形状不变（test_jiazheng_flow.py / test_vendor_api.py 通过）

## 执行状态（2026-08-13）

- [x] T1-T11 全部完成（提交：cfbae0f…15414ef）
- [x] T12 数据迁移完成：建表 + 全量导入 + 行数校验一致（gr_orders 3241 行等 8 张非空表）
- [x] T13 本地冒烟通过：
  - 核心 API（cities / jz/orders/overview 漏斗 / jz/vendors / jiazheng/skus）
  - 商家 API 17 请求全覆盖（本地指向 MySQL）
  - 回调全链路：造单 → paid 回调 → 落库校验（vendor_id/vendor_oid/fee/paid_at）
- [x] 发布测试机：代码同步 + 远端自动安装 pymysql 1.2.0 + 服务启动监听 8765
- [ ] 远程全链路验证 —— **阻塞：测试机 49.232.103.71 → MySQL 62.234.26.57:3306 TCP 不通（超时）**，
      需运维在 MySQL 安全组放行测试机 IP；放行后执行：
      `JUZHU_TEST_BASE=http://49.232.103.71:8765 python3 juzhu/test_vendor_api.py`

### 实施中发现并修复的适配层缺陷
- dbconn 反引号重复包裹：`mysql_schema.sql` 中 `` `key` `` 被二次包裹 → 负向断言正则修复
- pymysql mogrify 字面量 `%` 当格式化符（`'%Y-%m'`/`'%,'`）→ 引号段内 `%`→`%%` 转义
- MySQL DATE 类型返回 date 对象不可 JSON 序列化 → Row 层 `_to_plain` 转文本
- sqlite3 游标可迭代 vs _MysqlCursor → 补 `__iter__`
- 远端 pymysql 版本差异（1.2.0 vs 本地 1.4.6）无影响
