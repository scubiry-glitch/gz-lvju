#!/usr/bin/env python3
"""家政四大品类 API 全流程冒烟：下单 → 支付 → 派单 → 推进 → 评价。"""
import json
import sys
import urllib.error
import urllib.request

HOST = "http://127.0.0.1:8765"
KEY = (__import__("os").environ.get("JUZHU_API_KEY") or "").strip()
if not KEY:
    print("请在 .env / 环境变量设置 JUZHU_API_KEY（本地示例见 juzhu/.env.example）", file=sys.stderr)
    sys.exit(2)

# 每品类代表 SKU（与 juzhu/db.py JZ_DEFAULT_SKUS 对齐）
FLOW = [
    ("cleaning", 2, "deep-clean-4h"),
    ("repair", 4, "pipe-unclog-fast"),
    ("moving", 6, "moving-city-standard"),
    ("nanny", 8, "nanny-hourly-3h"),
]


def call(method, path, body=None, auth=False):
    headers = {"Content-Type": "application/json"}
    if auth:
        headers["Authorization"] = f"Bearer {KEY}"
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(HOST + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        try:
            err = json.loads(err)
        except json.JSONDecodeError:
            pass
        raise RuntimeError(f"{method} {path} -> {e.code}: {err}") from e


def run_one(cat, sku_id, slug):
    print(f"\n=== {cat} ({slug}) ===")
    created = call(
        "POST",
        "/api/juzhu/jiazheng/orders",
        {
            "sku_id": sku_id,
            "house": f"演示公寓 · {cat}",
            "phone": "13800138000",
            "expectTime": "2026-07-10 15:00",
            "desc": f"全流程冒烟 · {cat}",
            "source": "冒烟脚本",
        },
        auth=True,
    )
    oid = created["order"]["id"]
    print("create", oid)

    paid = call("POST", f"/api/juzhu/jiazheng/orders/{oid}/pay", {"pay_method": "贝壳支付"}, auth=True)
    assert paid["order"]["pay_status"] == "paid"
    print("pay ok")

    dispatched = call("POST", f"/api/juzhu/jiazheng/orders/{oid}/dispatch", {}, auth=True)
    assert dispatched["order"]["status"] == "dispatched"
    print("dispatch ->", dispatched["order"]["worker"]["name"])

    for step in ("accepted", "serving", "done"):
        advanced = call("POST", f"/api/juzhu/jiazheng/orders/{oid}/advance", {}, auth=True)
        assert advanced["order"]["status"] == step
        print("advance ->", step)

    rated = call("POST", f"/api/juzhu/jiazheng/orders/{oid}/rate", {"score": 5, "tags": ["专业"]}, auth=False)
    assert rated["order"]["status"] == "rated"
    print("rate ok")

    got = call("GET", f"/api/juzhu/jiazheng/orders/{oid}", auth=False)
    assert got["order"]["category_id"] == cat
    print("verify ok", got["order"]["id"])
    return oid


def main():
    ok = 0
    for cat, sku_id, slug in FLOW:
        try:
            run_one(cat, sku_id, slug)
            ok += 1
        except Exception as e:
            print("FAIL:", e, file=sys.stderr)
    print(f"\n{ok}/{len(FLOW)} 品类全流程通过")
    return 0 if ok == len(FLOW) else 1


if __name__ == "__main__":
    sys.exit(main())
