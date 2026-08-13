#!/usr/bin/env python3
"""dbconn（MySQL 兼容层）单元测试。

纯函数部分无需数据库，可离线运行：
    python3 juzhu/test_dbconn.py

连接级集成测试（建表/读写）需真实 MySQL：
    JUZHU_DB_LIVE_TEST=1 python3 juzhu/test_dbconn.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import dbconn  # noqa: E402
from dbconn import (  # noqa: E402
    Row,
    load_db_config,
    pragma_to_sql,
    quote_reserved_words,
    split_script,
    sqlite_master_to_sql,
    translate_placeholders,
)


def t_translate():
    assert translate_placeholders("SELECT * FROM t WHERE a=?")[0] == "SELECT * FROM t WHERE a=%s"
    assert (
        translate_placeholders("SELECT * FROM t WHERE a=? AND b IN (?, ?)")[0]
        == "SELECT * FROM t WHERE a=%s AND b IN (%s, %s)"
    )
    # 引号内 ? 不翻译
    sql, _ = translate_placeholders("SELECT * FROM t WHERE a='what?' AND b=?")
    assert sql == "SELECT * FROM t WHERE a='what?' AND b=%s"
    sql, _ = translate_placeholders('SELECT * FROM t WHERE a="x?y" AND b=?')
    assert sql == 'SELECT * FROM t WHERE a="x?y" AND b=%s'
    # SQLite 双引号内转义引号（''）不受影响
    sql, _ = translate_placeholders("SELECT * FROM t WHERE a='it''s?' AND b=?")
    assert sql == "SELECT * FROM t WHERE a='it''s?' AND b=%s"


def t_quote():
    # 保留字列名 key / desc → 反引号
    assert quote_reserved_words("SELECT key, value FROM settings") == "SELECT `key`, value FROM settings"
    assert quote_reserved_words("SELECT 1 FROM settings WHERE key=?") == "SELECT 1 FROM settings WHERE `key`=?"
    assert (
        quote_reserved_words("INSERT INTO settings(key, value) VALUES (?, ?)")
        == "INSERT INTO settings(`key`, value) VALUES (?, ?)"
    )
    assert (
        quote_reserved_words("UPDATE jz_orders SET fee=?, desc=?, updated_at=? WHERE id=?")
        == "UPDATE jz_orders SET fee=?, `desc`=?, updated_at=? WHERE id=?"
    )
    assert (
        quote_reserved_words("INSERT INTO jz_orders(id, desc, fee) VALUES (?, ?, ?)")
        == "INSERT INTO jz_orders(id, `desc`, fee) VALUES (?, ?, ?)"
    )
    # 大写 DESC（排序）/ PRIMARY KEY / ON DUPLICATE KEY 不受影响
    assert quote_reserved_words("ORDER BY rating DESC") == "ORDER BY rating DESC"
    assert quote_reserved_words("PRIMARY KEY (id)") == "PRIMARY KEY (id)"
    # 字符串字面量内的 key/desc 不替换
    assert quote_reserved_words("WHERE a='desc'") == "WHERE a='desc'"
    # 单词边界：复合标识符不受影响
    assert quote_reserved_words("UPDATE t SET desc_label=1") == "UPDATE t SET desc_label=1"


def t_row():
    row = Row([("id",), ("name",)], (1, "保洁"))
    assert row[0] == 1 and row["id"] == 1
    assert row[1] == "保洁" and row["name"] == "保洁"
    assert dict(row) == {"id": 1, "name": "保洁"}
    assert list(row) == [1, "保洁"]
    assert len(row) == 2
    assert "name" in row and "missing" not in row
    assert row.keys() == ["id", "name"]


def t_split():
    stmts = split_script("CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);")
    assert len(stmts) == 2, stmts
    assert split_script("-- 注释\nCREATE TABLE a (id INT);") == ["-- 注释\nCREATE TABLE a (id INT)"]
    assert split_script("") == []
    assert split_script("  ;\n") == []


def t_pragma():
    # foreign_keys → no-op
    assert pragma_to_sql("PRAGMA foreign_keys = ON") == ("__noop__", None)
    # table_info → information_schema 映射
    sql, params = pragma_to_sql("PRAGMA table_info(projects)")
    assert "information_schema" in sql and params == ("projects",)
    # 非 PRAGMA 返回 None
    assert pragma_to_sql("SELECT 1") is None


def t_sqlite_master():
    sql, params = sqlite_master_to_sql("SELECT name FROM sqlite_master WHERE type='table'")
    assert "information_schema" in sql and params == ()
    assert sqlite_master_to_sql("SELECT * FROM jz_vendors") is None


def t_config():
    cfg = load_db_config({"JUZHU_DB_HOST": "h", "JUZHU_DB_PORT": "3307", "JUZHU_DB_USER": "u",
                          "JUZHU_DB_PASSWORD": "p", "JUZHU_DB_NAME": "d"})
    assert cfg == {"host": "h", "port": 3307, "user": "u", "password": "p", "database": "d"}
    cfg2 = load_db_config({})
    assert cfg2["port"] == 3306 and cfg2["database"] == "juzhu"


def main():
    t_translate()
    t_quote()
    t_row()
    t_split()
    t_pragma()
    t_sqlite_master()
    t_config()
    print("test_dbconn: ALL PASS")


if __name__ == "__main__":
    main()
