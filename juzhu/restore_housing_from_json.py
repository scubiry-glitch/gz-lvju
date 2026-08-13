"""从 data.json 快照重建保租房/卖旧买新的基础表（cities/districts/projects/units/photos）。

背景：juzhu.db 为 gitignore 运行库，connect() 只用 ensure_schema 迁移「已存在」的表，
从不 CREATE 房源基表——首次/重置后的 DB 只有 jz_* 家政表，导致 juzhu-admin 后台的
房源编辑整链路 500。此脚本按 schema.sql 建表并回填 data.json 快照，幂等可重复执行。

用法：python3 juzhu/restore_housing_from_json.py
"""
import json
import sqlite3
from pathlib import Path

HERE = Path(__file__).resolve().parent
DB_PATH = HERE / "juzhu.db"
JSON_PATH = HERE / "data.json"
SCHEMA_PATH = HERE / "schema.sql"

JSON_COLS = {"tags", "amenities", "keeper", "rent_detail", "rating"}


def enc(v):
    """列表/字典回落为 JSON 文本存 TEXT 列；标量原样。"""
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False)
    return v


def cols_of(conn, table):
    return [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table).fetchall()]


def insert_rows(conn, table, rows):
    if not rows:
        return 0
    cols = cols_of(conn, table)
    n = 0
    for row in rows:
        keys = [k for k in cols if k in row]
        vals = [enc(row[k]) if k in JSON_COLS else row[k] for k in keys]
        conn.execute(
            "INSERT OR REPLACE INTO %s (%s) VALUES (%s)"
            % (table, ",".join(keys), ",".join("?" * len(keys))),
            vals,
        )
        n += 1
    return n


def main():
    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

    city = data.get("city")
    cities = [city] if city else []
    stats = {}
    for table, rows in (
        ("cities", cities),
        ("districts", data.get("districts", [])),
        ("projects", data.get("projects", [])),
        ("units", data.get("units", [])),
        ("photos", data.get("photos", [])),
    ):
        stats[table] = insert_rows(conn, table, rows)
    conn.commit()
    conn.close()
    print("restored:", stats)


if __name__ == "__main__":
    main()
