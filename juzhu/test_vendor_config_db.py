#!/usr/bin/env python3
"""商家密钥配置迁库验证：schema 列 → db.py 迁移 → 缓存读取 → 防泄露。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tp_client import load_dotenv  # noqa: E402

load_dotenv()

HERE = os.path.dirname(os.path.abspath(__file__))


def check_schema_files():
    for name in ("mysql_schema.sql", "jiazheng_schema.sql"):
        text = open(os.path.join(HERE, name), encoding="utf-8").read()
        # 仅校验 jz_vendors 建表段含三列（文本级检查，避免误命中其它表）
        idx = text.find("jz_vendors")
        assert idx >= 0, f"{name} 未找到 jz_vendors 建表段"
        seg = text[idx:idx + 1600]
        assert "hmac_key" in seg, f"{name} jz_vendors 缺 hmac_key 列"
        assert "url_link" in seg, f"{name} jz_vendors 缺 url_link 列"
        assert "order_detail_url" in seg, f"{name} jz_vendors 缺 order_detail_url 列"
    print("[PASS] check_schema_files")


def check_db_migration():
    import db as jdb

    conn = jdb.connect()
    cols = {dict(r)["name"] for r in conn.execute("PRAGMA table_info(jz_vendors)").fetchall()}
    assert {"hmac_key", "url_link", "order_detail_url"} <= cols, f"缺列: {cols}"
    row41 = conn.execute("SELECT hmac_key, url_link, order_detail_url FROM jz_vendors WHERE id=41").fetchone()
    row42 = conn.execute("SELECT hmac_key, url_link, order_detail_url FROM jz_vendors WHERE id=42").fetchone()
    assert row41 and row41[0] and row41[1] and row41[2], f"41 未从文件导入: {row41}"
    assert row42 and row42[0] and row42[1] and row42[2] is None, f"42 未从文件导入: {row42}"
    conn.close()
    print("[PASS] check_db_migration")


def check_vendor_config_cache():
    from jiazheng_api import _load_vendor_config

    vendors = _load_vendor_config()
    assert "41" in vendors and "42" in vendors, f"缓存缺 vendor: {list(vendors)}"
    v41 = vendors["41"]
    assert v41["key"] and v41["url_link"] and v41["order_detail_url"], v41
    v42 = vendors["42"]
    assert v42["key"] and v42["url_link"] and not v42.get("order_detail_url"), v42
    # 缓存命中：第二次调用返回同一对象
    assert _load_vendor_config() is vendors, "缓存未生效"
    print("[PASS] check_vendor_config_cache")


def check_vendor_secrets_stripped():
    import db as jdb
    from jiazheng_db import list_vendors, get_vendor

    conn = jdb.connect()
    try:
        for v in list_vendors(conn):
            for secret in ("hmac_key", "url_link", "order_detail_url"):
                assert secret not in v, f"list_vendors 泄露 {secret}: vendor {v.get('id')}"
        v41 = get_vendor(conn, 41)
        for secret in ("hmac_key", "url_link", "order_detail_url"):
            assert secret not in v41, f"get_vendor 泄露 {secret}"
        # C 端详情上下文里的 vendor 同样不得携带密钥
        from jiazheng_db import get_detail_context_by_channel_sku

        sku_row = conn.execute("SELECT channel_sku_id FROM jz_products WHERE status='on' LIMIT 1").fetchone()
        if sku_row and sku_row[0]:
            ctx = get_detail_context_by_channel_sku(conn, sku_row[0])
            if ctx:
                for secret in ("hmac_key", "url_link", "order_detail_url"):
                    assert secret not in ctx["vendor"], f"详情上下文泄露 {secret}"
    finally:
        conn.close()
    print("[PASS] check_vendor_secrets_stripped")


def main():
    check_schema_files()
    check_db_migration()
    check_vendor_config_cache()
    check_vendor_secrets_stripped()


if __name__ == "__main__":
    main()
