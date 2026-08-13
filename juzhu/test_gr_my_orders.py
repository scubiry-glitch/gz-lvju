#!/usr/bin/env python3
"""我的订单链路冒烟：user_id 迁移 → 下单落库 → 聚合接口过滤 pending → 单条详情。"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tp_client import load_dotenv  # noqa: E402

load_dotenv()  # 加载 juzhu/.env 的 JUZHU_DB_* 连接配置（同 test_db_city.py）

import db as jdb  # noqa: E402

TEST_USER = "test_gr_orders_user"
HOST = "http://127.0.0.1:8765"


def http_get(path):
    req = urllib.request.Request(HOST + path)
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"__status": e.code, "body": e.read().decode()}


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


def check_gr_orders_api():
    import time
    from datetime import datetime
    from gr_orders import list_user_orders

    conn = jdb.connect()
    stamp = str(int(time.time() * 1000))
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for i, status in enumerate(["pending", "paid", "completed"]):
        conn.execute(
            "INSERT INTO gr_orders (order_ref, user_id, sku, city, status, created_at)"
            " VALUES (?, ?, '99', '沈阳', ?, ?)",
            (f"GRTESTA{stamp}{i}", TEST_USER, status, now),
        )
    conn.commit()
    try:
        # 缺 user_id → 400
        r = http_get("/api/juzhu/gr/orders")
        assert r.get("__status") == 400, f"缺 user_id 应 400，实际 {r}"
        # 正常聚合：无 pending、counts 正确
        r = http_get("/api/juzhu/gr/orders?user_id=" + TEST_USER)
        assert r.get("ok"), r
        assert len(r["list"]) == 2, f"list 应 2 条（无 pending），实际 {r['list']}"
        assert r["counts"]["paid"] == 1 and r["counts"]["completed"] == 1, r["counts"]
        # 单条详情（防串单：其他 user 查不到 → 404）
        ref = list_user_orders(conn, TEST_USER)["list"][0]["order_ref"]
        d = http_get(f"/api/juzhu/gr/orders/{ref}?user_id={TEST_USER}")
        assert d.get("ok") and d.get("order", {}).get("order_ref") == ref, d
        d2 = http_get(f"/api/juzhu/gr/orders/{ref}?user_id=other_user")
        assert d2.get("__status") == 404, f"跨用户应 404，实际 {d2}"
        print("[PASS] check_gr_orders_api")
    finally:
        conn.execute("DELETE FROM gr_orders WHERE user_id = ? AND order_ref LIKE 'GRTESTA%'", (TEST_USER,))
        conn.commit()


def check_serving_at_and_eta():
    import time as _t
    from gr_orders import create_order, get_order_by_ref, update_order_callback
    from jiazheng_api import _norm_eta_peking

    # eta 统一北京时间无时区
    assert _norm_eta_peking("2026-08-07T14:00:00+08:00") == "2026-08-07 14:00:00", \
        _norm_eta_peking("2026-08-07T14:00:00+08:00")
    assert _norm_eta_peking("2026-08-07T14:00:00Z") == "2026-08-07 22:00:00", \
        _norm_eta_peking("2026-08-07T14:00:00Z")
    assert _norm_eta_peking("2026-08-07 14:00:00") == "2026-08-07 14:00:00"
    assert _norm_eta_peking("") == "" and _norm_eta_peking(None) is None

    # serving 回调写入 serving_at；paid 阶段 serving_at 为空
    conn = jdb.connect()
    ref = "GRTESTS" + str(int(_t.time() * 1000))
    create_order(conn, ref, "99", city="沈阳", user_id=TEST_USER)
    update_order_callback(conn, ref, "oid-s", "paid", fee=12800, vendor_id=1)
    row = get_order_by_ref(conn, ref)
    assert not row.get("serving_at"), f"paid 阶段不应有 serving_at: {row}"
    update_order_callback(conn, ref, "oid-s", "serving", vendor_id=1)
    row = get_order_by_ref(conn, ref)
    assert row.get("serving_at"), f"serving_at 未写入: {row}"
    conn.execute("DELETE FROM gr_orders WHERE order_ref = ?", (ref,))
    conn.commit()
    print("[PASS] check_serving_at_and_eta")


def main():
    check_user_id_column()
    check_create_order_with_user()
    check_list_user_orders_filters_pending()
    check_gr_orders_api()
    check_serving_at_and_eta()
    print("ALL PASS")


if __name__ == "__main__":
    main()
