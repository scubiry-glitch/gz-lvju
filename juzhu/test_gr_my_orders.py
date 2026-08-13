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


def check_create_order_with_user():
    import time
    from gr_orders import create_order, get_order_by_ref

    conn = jdb.connect()
    ref = "GRTEST" + str(int(time.time() * 1000))
    create_order(conn, ref, "99", city="沈阳", vendor_id=None, user_id=TEST_USER)
    conn.commit()
    row = get_order_by_ref(conn, ref)
    assert row and row.get("user_id") == TEST_USER, f"user_id 未落库: {row}"
    conn.execute("DELETE FROM gr_orders WHERE order_ref = ?", (ref,))
    conn.commit()
    print("[PASS] check_create_order_with_user")


def check_list_user_orders_filters_pending():
    import time
    from datetime import datetime
    from gr_orders import list_user_orders

    conn = jdb.connect()
    stamp = str(int(time.time() * 1000))
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    refs = []
    for i, status in enumerate(["pending", "paid", "assigned", "serving", "completed"]):
        ref = f"GRTESTL{stamp}{i}"
        conn.execute(
            "INSERT INTO gr_orders (order_ref, user_id, sku, city, status, created_at)"
            " VALUES (?, ?, '99', '沈阳', ?, ?)",
            (ref, TEST_USER, status, now),
        )
        refs.append(ref)
    conn.commit()
    try:
        data = list_user_orders(conn, TEST_USER)
        got = {r["order_ref"] for r in data["list"]}
        assert all(r not in got for r in refs[:1]), "pending 订单被泄露"
        assert len(got) == 4, f"应返回 4 条，实际 {len(got)}"
        assert data["counts"] == {"paid": 1, "assigned": 1, "serving": 1, "completed": 1}, data["counts"]
        print("[PASS] check_list_user_orders_filters_pending")
    finally:
        conn.execute("DELETE FROM gr_orders WHERE user_id = ? AND order_ref LIKE 'GRTESTL%'", (TEST_USER,))
        conn.commit()


def main():
    check_user_id_column()
    check_create_order_with_user()
    check_list_user_orders_filters_pending()
    print("ALL PASS")


if __name__ == "__main__":
    main()
