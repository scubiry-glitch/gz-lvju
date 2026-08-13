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
BASE = "http://49.232.103.71:8765"
VENDOR_ID = 41
# 密钥不硬编码：从 hmac_secret.key（gitignore 屏蔽）按 vendor_id 读取
_KEY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hmac_secret.key")

auth = None  # HmacAuth 实例，模块加载后初始化


def _load_secret(vendor_id: int) -> str:
    """从 hmac_secret.key（格式: vendor_id|hmac_key|url_link）读取指定商家密钥。"""
    with open(_KEY_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("|")
            if len(parts) >= 2 and parts[0] == str(vendor_id):
                return parts[1]
    raise RuntimeError(f"hmac_secret.key 中未找到 vendor_id={vendor_id} 的密钥")


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


def main() -> int:
    # 步骤计数：2 个查询 + 5 个列表/详情 + 5 个写操作 + 5 个回调状态 = 17
    steps = [
        ("/api/juzhu/jiazheng/vendor/categories/list", {"vendor_id": VENDOR_ID}, "类目列表"),
        ("/api/juzhu/jiazheng/vendor/skus/list", {"vendor_id": VENDOR_ID}, "SPU 列表"),
        ("/api/juzhu/jiazheng/vendor/products/list", {"vendor_id": VENDOR_ID}, "产品列表（无筛选）"),
        ("/api/juzhu/jiazheng/vendor/products/list",
         {"vendor_id": VENDOR_ID, "status": "on"}, "产品列表（status=on 筛选）"),
        ("/api/juzhu/jiazheng/vendor/products/create", None, "创建产品（占位，稍后填充）"),
        ("/api/juzhu/jiazheng/vendor/products/detail", None, "产品详情（占位，稍后填充）"),
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

    # ── 1. 类目列表 ──
    path, body, label = steps[step]
    step += 1
    resp = post(path, body, step, total, label)
    category = (resp.get("list") or [{}])[0].get("name") or "日常保洁"
    results["category"] = category

    # ── 2. SPU 列表 ──
    path, body, label = steps[step]
    step += 1
    resp = post(path, body, step, total, label)
    skus = resp.get("list") or []
    channel_sku_id = skus[0]["id"] if skus else None
    results["channel_sku_id"] = channel_sku_id

    # ── 3/4. 产品列表（无筛选 / status 筛选） ──
    for _ in range(2):
        path, body, label = steps[step]
        step += 1
        post(path, body, step, total, label)

    # ── 5. 创建产品 ──
    path, _, label = steps[step]
    step += 1
    create_body = {
        "vendor_id": VENDOR_ID,
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
    pid = resp.get("id") or 0
    if not pid:
        print("创建产品未返回 id，后续产品操作将使用 id=0 演示（预期 404）。")
    results["pid"] = pid

    # ── 6. 产品详情 ──
    path, _, label = steps[step]
    step += 1
    post(path, {"vendor_id": VENDOR_ID, "id": pid}, step, total, label)

    # ── 7. 编辑产品 ──
    path, _, label = steps[step]
    step += 1
    post(
        path,
        {
            "vendor_id": VENDOR_ID,
            "id": pid,
            "title": "接口测试·日常保洁2小时（特惠）",
            "price": 7900,
            "status": "on",
        },
        step,
        total,
        label,
    )

    # ── 8/9. 状态变更 sold_out → on ──
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
    return 0


if __name__ == "__main__":
    auth = HmacAuth(_load_secret(VENDOR_ID))
    sys.exit(main())
else:
    auth = HmacAuth(_load_secret(VENDOR_ID))
