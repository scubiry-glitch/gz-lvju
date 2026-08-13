#!/usr/bin/env python3
"""db 层城市维度回归测试：city_id 过滤 / city_name / 校验辅助。

运行（本地连线上 MySQL）：
    cd juzhu && python3 test_db_city.py
"""
import sys
from tp_client import load_dotenv

load_dotenv()

from dbconn import connect
import jiazheng_db as jzdb

PASS = 0
FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {extra}")


def main():
    conn = connect()
    try:
        # 1. vendor_city_ids：解析商家 city_ids
        ids41 = jzdb.vendor_city_ids(conn, 41)
        check("vendor_city_ids(41) == [1,2,3]", ids41 == [1, 2, 3], f"got {ids41}")
        ids42 = jzdb.vendor_city_ids(conn, 42)
        check("vendor_city_ids(42) == [1,2]", ids42 == [1, 2], f"got {ids42}")

        # 2. validate_product_city：必填 + 归属校验
        ok, msg = jzdb.validate_product_city(conn, 41, None)
        check("缺 city_id → False", ok is False, f"got {ok}")
        check("缺 city_id → 缺少 city_id", "缺少 city_id" in (msg or ""), f"got {msg}")
        ok, msg = jzdb.validate_product_city(conn, 41, 4)
        check("city_id=4 不属于商家41 → False", ok is False, f"got {ok}")
        check("不属于商家 → 提示归属错误", "不属于" in (msg or ""), f"got {msg}")
        ok, msg = jzdb.validate_product_city(conn, 41, 1)
        check("city_id=1 属于商家41 → True", ok is True, f"got {ok} {msg}")
        ok, msg = jzdb.validate_product_city(conn, 42, 2)
        check("city_id=2 属于商家42 → True", ok is True, f"got {ok} {msg}")

        # 3. list_products：city_id 过滤 + city_name
        all_items = jzdb.list_products(conn)
        check("list_products 每项含 city_name", all("city_name" in it for it in all_items), "")
        city1 = jzdb.list_products(conn, city_id=1)
        check("city_id=1 过滤后非空", len(city1) > 0, f"got {len(city1)}")
        check("city_id=1 过滤后全部 city_id==1", all(it.get("city_id") == 1 for it in city1), "")
        city2 = jzdb.list_products(conn, city_id=2)
        check("city_id=2 过滤后全部 city_id==2", all(it.get("city_id") == 2 for it in city2), f"got {len(city2)}")
        shenyang = [it for it in city1 if it.get("city_name") == "沈阳"]
        check("city_name 返回沈阳", len(shenyang) > 0, "")

        # 4. create_product / update_product：city_id 落库与修改
        pid = jzdb.create_product(conn, {
            "vendor_id": 42, "city_id": 2, "title": "测试·城市字段冒烟",
            "channel_sku_id": None, "price": 1, "status": "off",
        })
        conn.commit()
        row = conn.execute("SELECT city_id FROM jz_products WHERE id=?", (pid,)).fetchone()
        check("create_product 落库 city_id=2", row and row[0] == 2, f"got {row}")
        jzdb.update_product(conn, pid, {"city_id": 1})
        conn.commit()
        row = conn.execute("SELECT city_id FROM jz_products WHERE id=?", (pid,)).fetchone()
        check("update_product 改 city_id=1", row and row[0] == 1, f"got {row}")
        # 清理
        conn.execute("DELETE FROM jz_products WHERE id=?", (pid,))
        conn.commit()
        check("测试产品已清理", True, "")
    finally:
        conn.close()

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
