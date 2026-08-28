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


def check_gr_vendor_detail_api():
    import time as _t
    from gr_orders import create_order

    conn = jdb.connect()
    ref = "GRTESTV" + str(int(_t.time() * 1000))
    # vendor_id=None：未关联商家 → ok:false
    create_order(conn, ref, "99", city="沈阳", user_id=TEST_USER)
    conn.commit()
    try:
        r = http_get(f"/api/juzhu/gr/orders/{ref}/vendor-detail")
        assert r.get("__status") == 400, f"缺 user_id 应 400，实际 {r}"
        r = http_get(f"/api/juzhu/gr/orders/{ref}/vendor-detail?user_id={TEST_USER}")
        assert r.get("ok") is False, f"未关联商家应 ok:false，实际 {r}"
        r = http_get(f"/api/juzhu/gr/orders/{ref}/vendor-detail?user_id=other_user")
        assert r.get("__status") == 404, f"跨用户应 404，实际 {r}"
    finally:
        conn.execute("DELETE FROM gr_orders WHERE order_ref = ?", (ref,))
        conn.commit()

    # vendor_id=41（已配置 order_detail_url）：商家接口白名单限制，
    # 测试机 IP 不一定在白名单，仅断言响应为合法 JSON 且不崩溃
    ref2 = "GRTESTV" + str(int(_t.time() * 1000)) + "b"
    create_order(conn, ref2, "99", city="沈阳", user_id=TEST_USER, vendor_id=41)
    conn.commit()
    try:
        r = http_get(f"/api/juzhu/gr/orders/{ref2}/vendor-detail?user_id={TEST_USER}")
        assert isinstance(r, dict) and "ok" in r, f"响应结构异常: {r}"
        if r.get("ok"):
            assert isinstance(r.get("detail"), dict), r
    finally:
        conn.execute("DELETE FROM gr_orders WHERE order_ref = ?", (ref2,))
        conn.commit()
    conn.close()
    print("[PASS] check_gr_vendor_detail_api")


def check_vendor_detail_sync():
    import time
    from gr_orders import create_order, get_order_by_ref, sync_order_from_vendor_detail

    conn = jdb.connect()
    stamp = str(int(time.time() * 1000))

    # 场景1：pending + paid 详情 → 状态推进、vendor_oid 补空、fee/paid_at 写入
    ref = f"GRTESTS{stamp}a"
    create_order(conn, ref, "99", city="沈阳", vendor_id=41, user_id=TEST_USER)
    ok = sync_order_from_vendor_detail(conn, ref, vendor_oid="LL_10001", status="paid", fee=12800)
    row = get_order_by_ref(conn, ref)
    assert ok and row["status"] == "paid" and row["vendor_oid"] == "LL_10001", row
    assert row["fee"] == 12800 and row.get("paid_at"), row

    # 场景2：assigned 详情 → worker_name/phone/eta 写入、状态推进
    ok = sync_order_from_vendor_detail(conn, ref, vendor_oid="LL_10001", status="assigned",
                                       worker_name="李师傅", worker_phone="13900005678",
                                       eta="2026-08-12 09:00:00")
    row = get_order_by_ref(conn, ref)
    assert ok and row["status"] == "assigned", row
    assert row["worker_name"] == "李师傅" and row["worker_phone"] == "13900005678", row
    assert row["eta"] == "2026-08-12 09:00:00", row

    # 场景3：状态不回退：本地 completed + 商家 assigned → 保持 completed
    sync_order_from_vendor_detail(conn, ref, vendor_oid="LL_10001", status="completed")
    sync_order_from_vendor_detail(conn, ref, vendor_oid="LL_10001", status="assigned",
                                  worker_name="王师傅")
    row = get_order_by_ref(conn, ref)
    assert row["status"] == "completed" and row.get("completed_at"), row

    # 场景4：cancelled 终态：本地 paid + 商家 cancelled → 接受并写 cancel_reason；不接受回退
    ref2 = f"GRTESTS{stamp}b"
    create_order(conn, ref2, "99", city="沈阳", vendor_id=41, user_id=TEST_USER)
    sync_order_from_vendor_detail(conn, ref2, vendor_oid="LL_10002", status="paid", fee=9900)
    sync_order_from_vendor_detail(conn, ref2, vendor_oid="LL_10002", status="cancelled",
                                  cancel_reason="顾客取消订单")
    row = get_order_by_ref(conn, ref2)
    assert row["status"] == "cancelled" and row["cancel_reason"] == "顾客取消订单", row
    sync_order_from_vendor_detail(conn, ref2, vendor_oid="LL_10002", status="paid")
    row = get_order_by_ref(conn, ref2)
    assert row["status"] == "cancelled", row

    # 场景5：订单不存在 → 返回 False 不抛异常
    assert sync_order_from_vendor_detail(conn, "GRTEST_NOT_EXIST", vendor_oid=None, status="paid") is False

    conn.execute("DELETE FROM gr_orders WHERE order_ref IN (?, ?)", (ref, ref2))
    conn.commit()
    conn.close()
    print("[PASS] check_vendor_detail_sync")


def main():
    check_user_id_column()
    check_create_order_with_user()
    check_list_user_orders_filters_pending()
    check_gr_orders_api()
    check_serving_at_and_eta()
    check_gr_vendor_detail_api()
    check_vendor_detail_sync()
    print("ALL PASS")


if __name__ == "__main__":
    main()
