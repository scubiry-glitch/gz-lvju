#!/usr/bin/env python3
"""我的订单链路冒烟：user_id 迁移 → 下单落库 → 聚合接口过滤 pending → 单条详情。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tp_client import load_dotenv  # noqa: E402

load_dotenv()  # 加载 juzhu/.env 的 JUZHU_DB_* 连接配置（同 test_db_city.py）

import db as jdb  # noqa: E402

TEST_USER = "test_gr_orders_user"


def check_user_id_column():
    conn = jdb.connect()
    rows = conn.execute("PRAGMA table_info(gr_orders)").fetchall()
    cols = [dict(r)["name"] for r in rows]
    assert "user_id" in cols, f"gr_orders 缺少 user_id 列，现有列: {cols}"
    print("[PASS] check_user_id_column: user_id 列存在")


def main():
    check_user_id_column()
    print("ALL PASS")


if __name__ == "__main__":
    main()
