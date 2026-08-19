#!/usr/bin/env python3
"""商家服务系统 API 全覆盖测试（测试环境，商家：来来 vendor_id=41）。

依据 api_doc.md，覆盖除「链接」（第 5 章，由商家提供）外的所有接口：
- POST /api/juzhu/callback                    订单状态回调（paid/assigned/serving/completed/cancelled）
- POST /api/juzhu/jiazheng/vendor/categories/list   类目列表
- POST /api/juzhu/jiazheng/vendor/skus/list         平台标准品 SPU 列表
- POST /api/juzhu/jiazheng/vendor/products/list     产品列表
- POST /api/juzhu/jiazheng/vendor/products/detail   产品详情
- POST /api/juzhu/jiazheng/vendor/products/create   创建产品
- POST /api/juzhu/jiazheng/vendor/products/update   编辑产品
- POST /api/juzhu/jiazheng/vendor/products/status   状态变更
- POST /api/juzhu/jiazheng/vendor/products/delete   删除产品（软删）

每个请求均打印：业务输入体、最终签名请求体（含 timestamp/sign）、响应输出。
"""
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request

# ── 测试环境（商家：来来 vendor_id=41） ──
BASE = os.environ.get("JUZHU_TEST_BASE", "http://49.232.103.71:8765")
VENDOR_ID = 41
# 密钥不硬编码：从 jz_vendors 表按 vendor_id 读取（hmac_secret.key 已废弃）

auth = None  # HmacAuth 实例，模块加载后初始化


def _load_secret(vendor_id: int) -> str:
    """从 jz_vendors 表读取指定商家 HMAC 密钥（迁移后密钥存表不存文件）。"""
    from tp_client import load_dotenv

    load_dotenv()
    import db as jdb

    conn = jdb.connect()
    try:
        row = conn.execute("SELECT hmac_key FROM jz_vendors WHERE id=?", (vendor_id,)).fetchone()
    finally:
        conn.close()
    if not row or not (row[0] or "").strip():
        raise RuntimeError(f"jz_vendors 表中未找到 vendor_id={vendor_id} 的 hmac_key")
    return row[0].strip()


class HmacAuth:
    """HMAC-SHA256 签名（照 api_doc.md 第 6 章参考实现）。"""

    def __init__(self, secret_key: str):
        self.secret_key = secret_key.encode("utf-8")

    def _flatten_and_filter(self, data: dict, prefix: str = "") -> dict:
        """递归展平嵌套字典，过滤 None 和空字符串"""
        flat_dict = {}
        for k, v in data.items():
            if v is None or v == "":
                continue
            key_name = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                flat_dict.update(self._flatten_and_filter(v, key_name))
            else:
                flat_dict[key_name] = str(v)
        return flat_dict

    def _build_string_to_sign(self, flat_params: dict) -> str:
        """按 Key 字典序排序，拼接为 a=1&b=2"""
        sorted_keys = sorted(flat_params.keys())
        return "&".join([f"{k}={flat_params[k]}" for k in sorted_keys])

    def generate_signature(self, request_body: dict) -> dict:
        """生成带签名的请求体"""
        payload = request_body.copy()
        payload.pop("sign", None)
        timestamp = int(time.time() * 1000)
        flat_params = self._flatten_and_filter(payload)
        flat_params["timestamp"] = str(timestamp)
        string_to_sign = self._build_string_to_sign(flat_params)
        sign = hmac.new(
            self.secret_key, string_to_sign.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        payload["timestamp"] = timestamp
        payload["sign"] = sign
        return payload


def post(path: str, body: dict, step_no: int, total: int, label: str) -> dict:
    """发送一个 HMAC 签名请求，打印输入与输出，返回解析后的响应 JSON。"""
    print("=" * 78)
    print(f"[{step_no}/{total}] {label}")
    print(f"POST {BASE}{path}")
    payload = auth.generate_signature(body)
    print(f"输入(业务体): {json.dumps(body, ensure_ascii=False)}")
    print(f"输入(签名体): {json.dumps(payload, ensure_ascii=False)}")

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            print(f"输出: {json.dumps(result, ensure_ascii=False)}")
            return result
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        print(f"输出: HTTP {e.code} {raw}")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"_http_error": e.code, "_raw": raw}
    except urllib.error.URLError as e:
        print(f"输出: 网络错误 {e}")
        return {"_network_error": str(e)}


def post_as(vendor_id: int, path: str, body: dict, step_no: int, total: int, label: str) -> dict:
    """以指定商家密钥签名发送请求（用于多商家用例）。"""
    global auth
    saved = auth
    auth = HmacAuth(_load_secret(vendor_id))
    try:
        return post(path, body, step_no, total, label)
    finally:
        auth = saved


CHECKS = []  # (名称, 是否通过) 断言汇总


def check(name: str, cond: bool, extra: str = ""):
    CHECKS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name} {extra}")


def main() -> int:
    # 步骤计数：cities×2 + 类目/SPU×2 + 产品列表×2 + 产品写操作×11 + 回调×5 = 22
    steps = [
        ("/api/juzhu/jiazheng/vendor/cities/list", {"vendor_id": VENDOR_ID}, "城市列表（商家 41）"),
        ("/api/juzhu/jiazheng/vendor/cities/list", {"vendor_id": 42}, "城市列表（商家 42·多城）"),
        ("/api/juzhu/jiazheng/vendor/categories/list", {"vendor_id": VENDOR_ID}, "类目列表"),
        ("/api/juzhu/jiazheng/vendor/skus/list", {"vendor_id": VENDOR_ID}, "SPU 列表"),
        ("/api/juzhu/jiazheng/vendor/products/list", {"vendor_id": VENDOR_ID}, "产品列表（无筛选）"),
        ("/api/juzhu/jiazheng/vendor/products/list",
         {"vendor_id": VENDOR_ID, "status": "on"}, "产品列表（status=on 筛选）"),
        ("/api/juzhu/jiazheng/vendor/products/create", None, "创建产品·缺 city_id（预期 400）"),
        ("/api/juzhu/jiazheng/vendor/products/create", None, "创建产品·city_id=4 非本商家（预期 400）"),
        ("/api/juzhu/jiazheng/vendor/products/create", None, "创建产品（city_id=1 合法）"),
        ("/api/juzhu/jiazheng/vendor/products/detail", None, "产品详情（占位，稍后填充）"),
        ("/api/juzhu/jiazheng/vendor/products/update", None, "编辑产品·city_id=4 非本商家（预期 400）"),
        ("/api/juzhu/jiazheng/vendor/products/update", None, "编辑产品（占位，稍后填充）"),
        ("/api/juzhu/jiazheng/vendor/products/status", None, "状态变更 sold_out（占位）"),
        ("/api/juzhu/jiazheng/vendor/products/status", None, "状态变更 on（占位）"),
        ("/api/juzhu/jiazheng/vendor/products/delete", None, "删除产品·软删（占位）"),
        ("/api/juzhu/jiazheng/vendor/products/detail", None, "删除后再查详情（软删后 status=off）"),
        ("/api/juzhu/jiazheng/vendor/products/delete", None, "重复删除已下架产品（预期 404）"),
        ("/api/juzhu/callback", None, "回调 paid（占位）"),
        ("/api/juzhu/callback", None, "回调 assigned（占位）"),
        ("/api/juzhu/callback", None, "回调 serving（占位）"),
        ("/api/juzhu/callback", None, "回调 completed（占位）"),
        ("/api/juzhu/callback", None, "回调 cancelled（占位）"),
    ]
    total = len(steps)
    results: dict = {}
    step = 0

    # ── 1/2. 城市列表（商家 41 / 多城商家 42） ──
    path, body, label = steps[step]
    step += 1
    resp = post(path, body, step, total, label)
    c41 = resp.get("list") or []
    check("cities/list(41) 与商家 city_ids 一致(1,2,3)", [c.get("id") for c in c41] == [1, 2, 3], f"got {c41}")

    path, body, label = steps[step]
    step += 1
    resp = post_as(42, path, body, step, total, label)
    c42 = resp.get("list") or []
    check("cities/list(42) 返回沈阳+贵阳且有序", [c.get("id") for c in c42] == [1, 2], f"got {c42}")

    # ── 3. 类目列表 ──
    path, body, label = steps[step]
    step += 1
    resp = post(path, body, step, total, label)
    category = (resp.get("list") or [{}])[0].get("name") or "日常保洁"
    results["category"] = category

    # ── 4. SPU 列表 ──
    path, body, label = steps[step]
    step += 1
    resp = post(path, body, step, total, label)
    skus = resp.get("list") or []
    channel_sku_id = skus[0]["id"] if skus else None
    results["channel_sku_id"] = channel_sku_id

    # ── 5/6. 产品列表（无筛选 / status 筛选） ──
    for _ in range(2):
        path, body, label = steps[step]
        step += 1
        resp = post(path, body, step, total, label)
        if _ == 0:
            items = resp.get("list") or []
            check("products/list 每项含 city_name",
                  items and all("city_name" in it for it in items), f"got {len(items)} 项")

    # ── 7/8. 创建产品负例（缺 city_id / 非本商家城市） ──
    path, _, label = steps[step]
    step += 1
    resp = post(path, {
        "vendor_id": VENDOR_ID, "title": "负例·缺 city_id",
        "category": category, "price": 100, "path": "pages/index", "query": "id=x",
    }, step, total, label)
    check("create 缺 city_id → 400", resp.get("code") == 400, f"got code={resp.get('code')}")

    path, _, label = steps[step]
    step += 1
    resp = post(path, {
        "vendor_id": VENDOR_ID, "title": "负例·非本商家城市", "city_id": 4,
        "category": category, "price": 100, "path": "pages/index", "query": "id=x",
    }, step, total, label)
    check("create city_id=4（非本商家） → 400", resp.get("code") == 400, f"got code={resp.get('code')}")

    # ── 9. 创建产品（合法） ──
    path, _, label = steps[step]
    step += 1
    create_body = {
        "vendor_id": VENDOR_ID,
        "city_id": 1,
        "title": "接口测试·日常保洁2小时",
        "subtitle": "全接口覆盖测试自动创建",
        "category": category,
        "duration_hours": 2,
        "area_range": "60-90㎡",
        "unit": "次",
        "price": 9900,
        "original_price": 12900,
        "discount_label": "7.7折",
        "earliest_time": "次日08:00",
        "advance_booking_hours": 12,
        "service_tags": ["接口测试", "临时产品"],
        "path": "pages/index",
        "query": "id=test0001",
        "status": "on",
        "sort_order": 99,
    }
    if channel_sku_id:
        create_body["channel_sku_id"] = channel_sku_id
    resp = post(path, create_body, step, total, label)
    check("create 合法（city_id=1） → code=0", resp.get("code") == 0, f"got {resp}")
    pid = resp.get("id") or 0
    if not pid:
        print("创建产品未返回 id，后续产品操作将使用 id=0 演示（预期 404）。")
    results["pid"] = pid

    # ── 10. 产品详情 ──
    path, _, label = steps[step]
    step += 1
    resp = post(path, {"vendor_id": VENDOR_ID, "id": pid}, step, total, label)
    prod = resp.get("product") or {}
    check("products/detail 含 city_name=沈阳", prod.get("city_name") == "沈阳", f"got {prod.get('city_name')}")

    # ── 11. 编辑产品负例（city_id=4 非本商家） ──
    path, _, label = steps[step]
    step += 1
    resp = post(path, {"vendor_id": VENDOR_ID, "id": pid, "city_id": 4}, step, total, label)
    check("update city_id=4（非本商家） → 400", resp.get("code") == 400, f"got code={resp.get('code')}")

    # ── 12. 编辑产品（合法） ──
    path, _, label = steps[step]
    step += 1
    resp = post(
        path,
        {
            "vendor_id": VENDOR_ID,
            "id": pid,
            "city_id": 1,
            "title": "接口测试·日常保洁2小时（特惠）",
            "price": 7900,
            "status": "on",
        },
        step,
        total,
        label,
    )
    check("update 合法（city_id=1） → code=0", resp.get("code") == 0, f"got {resp}")

    # ── 13/14. 状态变更 sold_out → on ──
    for status in ("sold_out", "on"):
        path, _, label = steps[step]
        step += 1
        post(path, {"vendor_id": VENDOR_ID, "id": pid, "status": status}, step, total, label)

    # ── 10. 删除产品（软删） ──
    path, _, label = steps[step]
    step += 1
    post(path, {"vendor_id": VENDOR_ID, "id": pid}, step, total, label)

    # ── 11. 删除后再查详情（软删后 status=off） ──
    path, _, label = steps[step]
    step += 1
    post(path, {"vendor_id": VENDOR_ID, "id": pid}, step, total, label)

    # ── 12. 重复删除已下架产品（预期 404） ──
    path, _, label = steps[step]
    step += 1
    post(path, {"vendor_id": VENDOR_ID, "id": pid}, step, total, label)

    # ── 13-17. 订单状态回调（5 种状态） ──
    # 测试环境如无该 order_ref 订单，接口按文档返回 404「订单不存在」。
    order_ref = "GR202608071429360148"
    vendor_oid = "SP_88888"
    callbacks = [
        {"status": "paid", "fee": 12800},
        {
            "status": "assigned",
            "worker": {
                "name": "李师傅",
                "phone": "139****5678",
                "eta": "2026-08-07T14:00:00+08:00",
            },
        },
        {"status": "serving"},
        {"status": "completed"},
        {"status": "cancelled", "cancel_reason": "用户主动取消"},
    ]
    for extra in callbacks:
        path, _, label = steps[step]
        step += 1
        cb_body = {
            "vendor_id": VENDOR_ID,
            "order_ref": order_ref,
            "vendor_oid": vendor_oid,
        }
        cb_body.update(extra)
        post(path, cb_body, step, total, label)

    print("=" * 78)
    print(f"全覆盖测试完成：{total} 个请求（类目 {results['category']}，SPU {results['channel_sku_id']}）")
    passed = sum(1 for _, ok in CHECKS if ok)
    failed = [name for name, ok in CHECKS if not ok]
    print(f"断言汇总：{passed}/{len(CHECKS)} 通过" + (f"；失败：{failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    auth = HmacAuth(_load_secret(VENDOR_ID))
    sys.exit(main())
else:
    auth = HmacAuth(_load_secret(VENDOR_ID))
