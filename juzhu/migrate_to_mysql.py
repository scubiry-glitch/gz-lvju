#!/usr/bin/env python3
"""SQLite → MySQL 数据迁移脚本（一次性工具）。

用法:
    python3 juzhu/migrate_to_mysql.py [sqlite.db 路径]

默认源: /tmp/test_juzhu.db（从测试机拉取的库）
目标: MySQL（JUZHU_DB_* 环境变量，与线上服务共用同一实例）

流程:
    1. 只读打开 SQLite，统计各表行数
    2. MySQL 侧 SET FOREIGN_KEY_CHECKS=0 → 逐表 DELETE 清空 → 按外键依赖顺序全量导入
    3. 时间字段归一化（"YYYY-MM-DDTHH:MM:SSZ" → "YYYY-MM-DD HH:MM:SS"），
       保证 DATE()/DATE_FORMAT() 查询可解析
    4. 行数校验，不一致退出码 1
"""
import re
import sqlite3
import sys
from pathlib import Path

import dbconn
from tp_client import load_dotenv  # noqa: E402

# 导入顺序（外键依赖：先父后子）；清空顺序任意（FK_CHECKS=0）
TABLES = [
    "cities", "districts", "projects", "units", "photos",
    "channels", "settings",
    "jz_categories", "jz_skus", "jz_orders",
    "jz_vendors", "jz_products", "jz_workers", "jz_subcategories", "jz_activities",
    "jz_sku_workers", "jz_sku_slots",
    "gr_orders",
]

# 时间语义列：值为 ISO 格式（带 T/Z）时归一化为 "YYYY-MM-DD HH:MM:SS"
TS_COLUMNS = {
    "jz_orders": {"created_at", "updated_at", "pay_at"},
    "gr_orders": {"created_at", "updated_at", "paid_at", "completed_at"},
    "projects": {"rating_submitted_at", "rating_reviewed_at"},
    "jz_activities": {"fetched_at"},
    "jz_vendors": {"created_at", "updated_at"},
}

_ISO_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$")
_BATCH = 200  # 每批 INSERT 行数（避免超过 max_allowed_packet）


def normalize_ts(table, column, value):
    """ISO 时间（T/Z 格式）→ 'YYYY-MM-DD HH:MM:SS'；其余原样。"""
    if column not in TS_COLUMNS.get(table, ()) or not isinstance(value, str):
        return value
    m = _ISO_TS_RE.match(value)
    return "%s %s" % (m.group(1), m.group(2)) if m else value


def sqlite_rows(src_path):
    """只读打开 SQLite，返回 {table: (cols, rows)}，rows 已做时间归一化。"""
    conn = sqlite3.connect("file:%s?mode=ro" % src_path, uri=True)
    conn.row_factory = sqlite3.Row
    out = {}
    for table in TABLES:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table).fetchall()]
        raw = conn.execute("SELECT * FROM %s" % table).fetchall()
        rows = []
        for row in raw:
            rows.append([normalize_ts(table, c, row[c]) for c in cols])
        out[table] = (cols, rows)
    conn.close()
    return out


def migrate(mysql, data):
    """清空目标表后按依赖顺序导入。返回 {table: 迁移行数}。"""
    mysql.execute("SET FOREIGN_KEY_CHECKS=0")
    try:
        for table in TABLES:
            mysql.execute("DELETE FROM %s" % table)
        for table in TABLES:
            cols, rows = data[table]
            if not rows:
                continue
            col_sql = ", ".join("`%s`" % c for c in cols)
            ph = "(" + ", ".join(["%s"] * len(cols)) + ")"
            for i in range(0, len(rows), _BATCH):
                batch = rows[i:i + _BATCH]
                sql = "INSERT INTO %s (%s) VALUES %s" % (
                    table, col_sql, ", ".join([ph] * len(batch)))
                flat = [v for row in batch for v in row]
                mysql.execute(sql, tuple(flat))
        mysql.commit()
    except Exception:
        mysql.rollback()
        raise
    finally:
        mysql.execute("SET FOREIGN_KEY_CHECKS=1")
        mysql.commit()
    return {t: len(data[t][1]) for t in TABLES}


def main():
    load_dotenv()  # 加载 juzhu/.env 的 JUZHU_DB_* 连接配置
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/test_juzhu.db")
    if not src.is_file():
        print("源库不存在: %s" % src)
        sys.exit(2)

    data = sqlite_rows(src)
    print("源库: %s" % src)
    src_counts = {t: len(data[t][1]) for t in TABLES}
    for t in TABLES:
        if src_counts[t]:
            print("  %-16s %d 行" % (t, src_counts[t]))

    mysql = dbconn.connect()
    cfg = dbconn.load_db_config()
    print("目标: mysql://%s@%s:%s/%s" % (cfg["user"], cfg["host"], cfg["port"], cfg["database"]))

    counts = migrate(mysql, data)

    # 行数校验
    ok = True
    for t in TABLES:
        dst = mysql.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
        if dst != src_counts[t]:
            print("  ! %-16s 源 %d ≠ 目标 %d" % (t, src_counts[t], dst))
            ok = False
    mysql.close()
    print("迁移完成%s" % ("，行数校验一致" if ok else "：行数不一致，见上"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
