"""生活服务 API 模块
独立的后端接口，与家政(jiazheng)接口解耦。

路由:
  - /api/juzhu/callback                    → HMAC 签名（vendor_id 必填）
  - /api/juzhu/jiazheng/vendor/*           → HMAC 签名（vendor_id 必填）
  - /api/juzhu/jiazheng/wechat-link        → 由 server.py API Key 路由调用

认证: HMAC-SHA256（sign_util.HmacAuth），vendor_id → hmac_secret.key 查密钥
"""

import json
import os
import re
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import db  # noqa: E402
from sign_util import HmacAuth  # noqa: E402

_MODULE_DIR = Path(__file__).resolve().parent
_KEY_PATH = _MODULE_DIR / "hmac_secret.key"

_CST = timezone(timedelta(hours=8))  # 北京时间 UTC+8


def _norm_eta_peking(eta):
    """eta 统一转为北京时间无时区字符串 'YYYY-MM-DD HH:MM:SS'。

    输入示例：
    - '2026-08-07T14:00:00+08:00' → '2026-08-07 14:00:00'
    - '2026-08-07T14:00:00Z'      → '2026-08-07 22:00:00'（UTC 转北京时间）
    - '2026-08-07 14:00:00'       → 原样返回（已是北京时间无时区）
    - 无法解析的值 → 原样返回，避免误伤业务数据
    """
    if not eta:
        return eta
    s = str(eta).strip()
    if re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$", s):
        return s
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            return s
        return dt.astimezone(_CST).strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return s


# ── 密钥加载 ──────────────────────────────────────────────────

def _load_vendor_config():
    """从 hmac_secret.key 加载 vendor 配置。
    格式: vendor_id|hmac_key|url_link（url_link 可选）
    返回: {"1": {"key": "abc...", "url_link": "https://..."}, ...}
    """
    vendors = {}
    if not _KEY_PATH.exists():
        return vendors
    for line in _KEY_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("|")
        if len(parts) >= 2:
            vid = parts[0].strip()
            vendors[vid] = {
                "key": parts[1].strip(),
                "url_link": parts[2].strip() if len(parts) >= 3 else "",
            }
    return vendors


# ── 数据库 ────────────────────────────────────────────────────

def _connect_db():
    """统一走 db.connect()（MySQL 连接，schema 自愈由 db 模块负责）。"""
    return db.connect()


# ── 工具 ──────────────────────────────────────────────────────

def _respond_json(handler, data, code=200):
    handler._json(data, code)
    return True


# ── HMAC 鉴权（vendor_id 维度） ───────────────────────────────

def _verify_vendor_auth(body):
    """校验 vendor HMAC 签名。
    步骤: 提取 vendor_id → 查密钥 → HmacAuth.verify_signature(body)

    返回: (vendor_id_int | None, error_msg | None)
    """
    vendor_id_str = str(body.get("vendor_id", "")).strip()
    if not vendor_id_str:
        return None, "缺少 vendor_id 参数"

    vendors = _load_vendor_config()
    if not vendors:
        return None, "服务端未配置任何 vendor 密钥"

    vendor = vendors.get(vendor_id_str)
    if not vendor:
        return None, f"vendor_id={vendor_id_str} 的密钥未配置"

    auth = HmacAuth(vendor["key"])
    passed, msg = auth.verify_signature(body)
    if not passed:
        return None, f"签名校验失败: {msg}"

    try:
        return int(vendor_id_str), None
    except ValueError:
        return None, f"vendor_id 格式无效: {vendor_id_str}"


# ═══════════════════════════════════════════════════════════════
#  路由入口 —— 供 server.py 调用
# ═══════════════════════════════════════════════════════════════

def handle_request(handler, method, path, qs, body):
    """处理 life / callback / vendor 路由（server.py 桥接调用）。"""
    if method == "POST" and path == "/api/juzhu/callback":
        return _handle_callback(handler, body)

    if method == "POST" and path.startswith("/api/juzhu/jiazheng/vendor/"):
        return _handle_vendor(handler, path, body)

    return False


def _handle_vendor(handler, path, body):
    """vendor 统一入口：HMAC 鉴权 → 路由分发。"""
    vendor_id, err = _verify_vendor_auth(body)
    if err:
        _respond_json(handler, {"code": 401, "message": err}, 401)
        return True

    routes = {
        "/api/juzhu/jiazheng/vendor/cities/list":      _vendor_cities_list,
        "/api/juzhu/jiazheng/vendor/categories/list":    _vendor_categories_list,
        "/api/juzhu/jiazheng/vendor/skus/list":          _vendor_skus_list,
        "/api/juzhu/jiazheng/vendor/products/list":      _vendor_products_list,
        "/api/juzhu/jiazheng/vendor/products/detail":    _vendor_products_detail,
        "/api/juzhu/jiazheng/vendor/products/create":    _vendor_products_create,
        "/api/juzhu/jiazheng/vendor/products/update":    _vendor_products_update,
        "/api/juzhu/jiazheng/vendor/products/status":    _vendor_products_status,
        "/api/juzhu/jiazheng/vendor/products/delete":    _vendor_products_delete,
    }

    handler_fn = routes.get(path)
    if not handler_fn:
        _respond_json(handler, {"code": 404, "message": "未知 vendor 路由"}, 404)
        return True

    return handler_fn(handler, body, vendor_id)


# ═══════════════════════════════════════════════════════════════
#  POST /api/juzhu/callback
# ═══════════════════════════════════════════════════════════════

def _handle_callback(handler, body):
    """第三方小程序回调 —— 更新 GR 订单状态（HMAC 鉴权，vendor_id 必填）。"""
    vendor_id, err = _verify_vendor_auth(body)
    if err:
        _respond_json(handler, {"code": 401, "message": err}, 401)
        return True

    order_ref = (body.get("order_ref") or "").strip()
    vendor_oid = (body.get("vendor_oid") or body.get("lailai_oid") or "").strip()
    status = (body.get("status") or "").strip()

    if not order_ref:
        _respond_json(handler, {"code": 400, "message": "缺少 order_ref 参数"}, 400)
        return True
    if not vendor_oid:
        _respond_json(handler, {"code": 400, "message": "缺少 vendor_oid 参数"}, 400)
        return True
    if not status:
        _respond_json(handler, {"code": 400, "message": "缺少 status 参数"}, 400)
        return True

    # 条件必填
    fee = body.get("fee")
    if status == "paid" and not fee:
        _respond_json(handler, {"code": 400, "message": "paid 状态时必须提供 fee"}, 400)
        return True

    worker = body.get("worker") or {}
    if status == "assigned":
        if not worker.get("name") or not worker.get("phone") or not worker.get("eta"):
            _respond_json(handler, {"code": 400, "message": "assigned 状态时必须提供 worker (name/phone/eta)"}, 400)
            return True

    cancel_reason = body.get("cancel_reason")
    if status == "cancelled" and not cancel_reason:
        _respond_json(handler, {"code": 400, "message": "cancelled 状态时必须提供 cancel_reason"}, 400)
        return True

    conn = _connect_db()
    try:
        from gr_orders import get_order_by_ref, get_order_by_ref_and_vendor, update_order_callback

        if status == "paid":
            order = get_order_by_ref(conn, order_ref)
        else:
            order = get_order_by_ref_and_vendor(conn, order_ref, vendor_oid)

        if not order:
            _respond_json(handler, {"code": 404, "message": "订单不存在"}, 404)
            return True

        update_order_callback(
            conn,
            order_ref=order_ref,
            vendor_oid=vendor_oid,
            status=status,
            fee=fee,
            worker_name=worker.get("name") if worker else None,
            worker_phone=worker.get("phone") if worker else None,
            eta=_norm_eta_peking(worker.get("eta")) if worker else None,
            cancel_reason=cancel_reason if status == "cancelled" else None,
            vendor_id=vendor_id,
        )
        _respond_json(handler, {"code": 0, "message": "success"})
    except Exception as e:
        _respond_json(handler, {"code": 500, "message": str(e)}, 500)
    finally:
        conn.close()
    return True


# ═══════════════════════════════════════════════════════════════
#  Vendor 子路由: categories / skus / products
# ═══════════════════════════════════════════════════════════════

def _vendor_categories_list(handler, body, vendor_id):
    """类目列表（不分页）。返回 C 端四大类 jz_categories 中 enabled=1 的类目。"""
    conn = _connect_db()
    try:
        rows = conn.execute(
            "SELECT id, id AS parent_type, name, icon, sort_order "
            "FROM jz_categories WHERE enabled=1 ORDER BY sort_order, id"
        ).fetchall()
        _respond_json(handler, {"code": 0, "message": "success", "list": [dict(r) for r in rows]})
    finally:
        conn.close()
    return True


def _vendor_cities_list(handler, body, vendor_id):
    """城市列表：仅返回本商家 city_ids 关联的城市（id + name + slug，按 city_ids 顺序）。"""
    from jiazheng_db import vendor_city_ids

    conn = _connect_db()
    try:
        ids = vendor_city_ids(conn, vendor_id)
        cities = []
        if ids:
            marks = ",".join("?" for _ in ids)
            rows = conn.execute(
                f"SELECT id, name, slug FROM cities WHERE id IN ({marks})",
                tuple(ids),
            ).fetchall()
            order = {cid: i for i, cid in enumerate(ids)}
            cities = sorted([dict(r) for r in rows], key=lambda c: order.get(c["id"], 99))
        _respond_json(handler, {"code": 0, "message": "success", "list": cities})
    finally:
        conn.close()
    return True


def _vendor_skus_list(handler, body, vendor_id):
    """SPU 列表（不分页）。返回 enabled=1 的平台标准品。"""
    conn = _connect_db()
    try:
        rows = conn.execute(
            "SELECT id, category_id, name, slug, spec, price_from, price_unit, "
            "duration_min, tags, badges, worker_min_level "
            "FROM jz_skus WHERE enabled=1 ORDER BY sort_order, id"
        ).fetchall()
        _respond_json(handler, {"code": 0, "message": "success", "list": [dict(r) for r in rows]})
    finally:
        conn.close()
    return True


def _vendor_products_list(handler, body, vendor_id):
    """产品列表（vendor_id 隔离）。
    筛选: category（精确）/ status（精确）/ name（title 模糊）/ city_id（精确）。
    每项附带城市名 city_name。
    """
    conn = _connect_db()
    try:
        sql = """SELECT p.*, v.name AS vendor_name, v.type AS vendor_type, c.name AS city_name
                 FROM jz_products p LEFT JOIN jz_vendors v ON v.id=p.vendor_id
                 LEFT JOIN cities c ON c.id=p.city_id
                 WHERE p.vendor_id=?"""
        params = [vendor_id]

        category = (body.get("category") or "").strip()
        if category:
            sql += " AND p.category=?"
            params.append(category)

        status = (body.get("status") or "").strip()
        if status:
            sql += " AND p.status=?"
            params.append(status)

        city_id = body.get("city_id")
        if city_id not in (None, ""):
            sql += " AND p.city_id=?"
            params.append(int(city_id))

        name = (body.get("name") or "").strip()
        if name:
            sql += " AND p.title LIKE ?"
            params.append("%" + name + "%")

        sql += " ORDER BY p.sort_order, p.id"
        rows = conn.execute(sql, params).fetchall()
        items = [dict(r) for r in rows]

        # 附加字段
        for it in items:
            if it.get("channel_sku_id"):
                srow = conn.execute(
                    "SELECT name FROM jz_skus WHERE id=?", (it["channel_sku_id"],)
                ).fetchone()
                it["spu_name"] = srow["name"] if srow else None
            else:
                it["spu_name"] = None
            wrows = conn.execute(
                "SELECT worker_id FROM jz_sku_workers WHERE product_id=?", (it["id"],)
            ).fetchall()
            it["worker_ids"] = [w["worker_id"] for w in wrows]

        _respond_json(handler, {"code": 0, "message": "success", "list": items})
    finally:
        conn.close()
    return True


def _vendor_products_detail(handler, body, vendor_id):
    """产品详情（vendor_id 隔离）。"""
    pid = body.get("id")
    if not pid:
        _respond_json(handler, {"code": 400, "message": "缺少 id 参数"}, 400)
        return True

    conn = _connect_db()
    try:
        row = conn.execute(
            """SELECT p.*, c.name AS city_name FROM jz_products p
               LEFT JOIN cities c ON c.id=p.city_id
               WHERE p.id=? AND p.vendor_id=?""",
            (int(pid), vendor_id),
        ).fetchone()
        if not row:
            _respond_json(handler, {"code": 404, "message": "产品不存在或不属于该商家"}, 404)
            return True
        item = dict(row)
        if item.get("channel_sku_id"):
            srow = conn.execute(
                "SELECT name FROM jz_skus WHERE id=?", (item["channel_sku_id"],)
            ).fetchone()
            item["spu_name"] = srow["name"] if srow else None
        else:
            item["spu_name"] = None
        wrows = conn.execute(
            "SELECT worker_id FROM jz_sku_workers WHERE product_id=?", (item["id"],)
        ).fetchall()
        item["worker_ids"] = [w["worker_id"] for w in wrows]
        _respond_json(handler, {"code": 0, "message": "success", "product": item})
    finally:
        conn.close()
    return True


def _vendor_products_create(handler, body, vendor_id):
    """创建产品。vendor_id 由鉴权提供，不可在 body 中覆写；city_id 必填且须属于本商家。"""
    from jiazheng_db import create_product, validate_product_city

    conn = _connect_db()
    try:
        ok, err = validate_product_city(conn, vendor_id, body.get("city_id"))
        if not ok:
            _respond_json(handler, {"code": 400, "message": err}, 400)
            return True
        data = dict(body)
        data["vendor_id"] = vendor_id  # 强制使用鉴权所得的 vendor_id
        pid = create_product(conn, data)
        conn.commit()
        _respond_json(handler, {"code": 0, "message": "success", "id": pid})
    except Exception as e:
        _respond_json(handler, {"code": 500, "message": str(e)}, 500)
    finally:
        conn.close()
    return True


def _vendor_products_update(handler, body, vendor_id):
    """编辑产品（vendor_id 隔离，不允许修改 vendor_id / id）。"""
    pid = body.get("id")
    if not pid:
        _respond_json(handler, {"code": 400, "message": "缺少 id 参数"}, 400)
        return True

    from jiazheng_db import update_product, validate_product_city

    conn = _connect_db()
    try:
        row = conn.execute(
            "SELECT id FROM jz_products WHERE id=? AND vendor_id=?",
            (int(pid), vendor_id),
        ).fetchone()
        if not row:
            _respond_json(handler, {"code": 404, "message": "产品不存在或不属于该商家"}, 404)
            return True

        if body.get("city_id") is not None:
            ok, err = validate_product_city(conn, vendor_id, body.get("city_id"))
            if not ok:
                _respond_json(handler, {"code": 400, "message": err}, 400)
                return True

        data = dict(body)
        data.pop("vendor_id", None)
        data.pop("id", None)
        ok = update_product(conn, int(pid), data)
        conn.commit()
        _respond_json(handler, {"code": 0, "message": "success" if ok else "未变更"})
    except Exception as e:
        _respond_json(handler, {"code": 500, "message": str(e)}, 500)
    finally:
        conn.close()
    return True


def _vendor_products_status(handler, body, vendor_id):
    """产品状态变更（on / off / sold_out），vendor_id 隔离。"""
    pid = body.get("id")
    status = (body.get("status") or "").strip()
    if not pid:
        _respond_json(handler, {"code": 400, "message": "缺少 id 参数"}, 400)
        return True
    if status not in ("on", "off", "sold_out"):
        _respond_json(handler, {"code": 400, "message": "status 须为 on / off / sold_out"}, 400)
        return True

    conn = _connect_db()
    try:
        cur = conn.execute(
            "UPDATE jz_products SET status=? WHERE id=? AND vendor_id=?",
            (status, int(pid), vendor_id),
        )
        conn.commit()
        if cur.rowcount == 0:
            _respond_json(handler, {"code": 404, "message": "产品不存在或不属于该商家"}, 404)
        else:
            _respond_json(handler, {"code": 0, "message": "success"})
    except Exception as e:
        _respond_json(handler, {"code": 500, "message": str(e)}, 500)
    finally:
        conn.close()
    return True


def _vendor_products_delete(handler, body, vendor_id):
    """软删产品（status → off），vendor_id 隔离。"""
    pid = body.get("id")
    if not pid:
        _respond_json(handler, {"code": 400, "message": "缺少 id 参数"}, 400)
        return True

    conn = _connect_db()
    try:
        cur = conn.execute(
            "UPDATE jz_products SET status='off' WHERE id=? AND vendor_id=? AND status!='off'",
            (int(pid), vendor_id),
        )
        conn.commit()
        if cur.rowcount == 0:
            _respond_json(handler, {"code": 404, "message": "产品不存在、不属于该商家或已是下架状态"}, 404)
        else:
            _respond_json(handler, {"code": 0, "message": "success"})
    except Exception as e:
        _respond_json(handler, {"code": 500, "message": str(e)}, 500)
    finally:
        conn.close()
    return True


# ═══════════════════════════════════════════════════════════════
#  POST /api/juzhu/jiazheng/wechat-link（由 server.py 路由调用）
# ═══════════════════════════════════════════════════════════════

def handle_wechat_link(handler, body):
    """生成小程序 URL Link 并创建 GR 订单。

    请求体: { "product_id": 123 }
    成功响应: { "ok": true, "url_link": "...", "order_ref": "GR..." }

    流程：
    1. 查产品 → 获取 path / query / vendor_id
    2. 查 vendor 的 url_link（来自 hmac_secret.key 第三列）
    3. 生成 order_ref
    4. 调用商家 URL Link 接口
    5. 创建 GR 订单
    """
    product_id = body.get("product_id")
    if not product_id:
        _respond_json(handler, {"ok": False, "error": "缺少 product_id 参数"}, 400)
        return True

    conn = _connect_db()
    try:
        row = conn.execute(
            "SELECT p.*, s.slug AS sku_slug FROM jz_products p "
            "LEFT JOIN jz_skus s ON s.id=p.channel_sku_id "
            "WHERE p.id = ? AND p.status = 'on'",
            (int(product_id),),
        ).fetchone()
        if not row:
            _respond_json(handler, {"ok": False, "error": "产品未找到"}, 404)
            return True

        product = dict(row)
        path = product.get("path") or "pages-sub/goods/goods"
        product_query = product.get("query") or ""
        vendor_id = str(product.get("vendor_id", ""))

        # 获取 vendor 的 url_link
        vendors = _load_vendor_config()
        vendor = vendors.get(vendor_id)
        if not vendor or not vendor.get("url_link"):
            _respond_json(
                handler,
                {"ok": False, "error": f"vendor_id={vendor_id} 未配置 url_link，请检查 hmac_secret.key"},
                500,
            )
            return True
        api_url = vendor["url_link"]

        # 拼接 query: 产品级参数
        query = product_query or ""

        from gr_orders import generate_order_ref, create_order

        order_ref = generate_order_ref(conn)

        url_link = _call_gen_url_link(api_url, path=path, query=query, order_ref=order_ref)

        # 下单用户 id（C 端模拟，后期接真实登录）
        user_id = (body.get("user_id") or "").strip() or None

        create_order(
            conn,
            order_ref,
            str(product_id),
            vendor_id=product.get("vendor_id"),
            user_id=user_id,
        )

        _respond_json(handler, {
            "ok": True,
            "url_link": url_link,
            "order_ref": order_ref,
        })

    except Exception as e:
        _respond_json(handler, {"ok": False, "error": str(e)}, 500)
    finally:
        conn.close()

    return True


def _call_gen_url_link(api_url, *, path, query, order_ref):
    """调用商家小程序 URL Link 生成接口。

    统一请求格式（POST JSON）：
    - path: 小程序页面路径（不含 / 开头），默认 pages-sub/goods/goods
    - query: 原始查询字符串
    - order_ref: GR 侧订单参考号

    鉴权方式由各商家接口自行定义（IP 白名单 / Token 等）。
    返回生成的 url_link 字符串。
    """
    payload = json.dumps({
        "path": path,
        "query": query,
        "order_ref": order_ref,
    }).encode("utf-8")

    _log(f"    [平台→商家] {_log_ts()} POST {api_url}", force=True)
    _log(f"      >> 参数: {payload.decode('utf-8')}")
    req = urllib.request.Request(api_url, data=payload, headers={
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read()
        text = raw.decode("utf-8", "replace")
        result = json.loads(text)
    except Exception as e:
        _log(f"      ! {type(e).__name__}: {e}")
        if hasattr(e, "read"):  # HTTPError：附带商家返回的错误响应体
            try:
                _log(f"      << 返回(错误): {_clip(e.read().decode('utf-8', 'replace'))}")
            except Exception:
                pass
        raise
    _log(f"      << 返回: {_clip(text)}")

    if result.get("code") != 200:
        raise RuntimeError(result.get("msg") or "URL Link 生成失败")

    return result.get("data") or ""


# ── 外部调用日志（print 到 stdout，随 server.py 主日志落盘） ──

def _log(line, force=False):
    """force=True 的行在简洁模式下也打印（出站请求的接口 URI 行）。"""
    if force or _log_detail():
        print(line, flush=True)


def _log_ts():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _log_detail():
    """详细日志开关：JUZHU_LOG_DETAIL=false/0/off 时出站调用只打印请求 URL 一行。"""
    return os.environ.get("JUZHU_LOG_DETAIL", "true").strip().lower() in ("1", "true", "yes", "on")


def _clip(text, limit=2000):
    """日志打印截断：超长截断并标注总长度；换行转义为单行。"""
    text = text.replace("\n", "\\n")
    if len(text) > limit:
        return text[:limit] + f"…[截断，共 {len(text)} 字符]"
    return text


# ═══════════════════════════════════════════════════════════════
#  我的订单（GR 侧，C 端匿名可读；user_id 必填）
# ═══════════════════════════════════════════════════════════════

def handle_gr_orders(handler, qs):
    """GET /api/juzhu/gr/orders?user_id=xxx —— 聚合返回 counts + list（过滤 pending）。"""
    user_id = (qs.get("user_id") or [""])[0].strip()
    if not user_id:
        _respond_json(handler, {"ok": False, "error": "缺少 user_id 参数"}, 400)
        return True
    try:
        limit = int((qs.get("limit") or ["50"])[0])
    except ValueError:
        limit = 50
    conn = _connect_db()
    try:
        from gr_orders import list_user_orders

        data = list_user_orders(conn, user_id, limit)
        _respond_json(handler, {"ok": True, **data})
    finally:
        conn.close()
    return True


def handle_gr_order_detail(handler, order_ref, qs):
    """GET /api/juzhu/gr/orders/{order_ref}?user_id=xxx —— 单条详情（防串单）。"""
    user_id = (qs.get("user_id") or [""])[0].strip()
    if not user_id:
        _respond_json(handler, {"ok": False, "error": "缺少 user_id 参数"}, 400)
        return True
    conn = _connect_db()
    try:
        from gr_orders import get_user_order

        order = get_user_order(conn, order_ref, user_id)
        if not order:
            _respond_json(handler, {"ok": False, "error": "订单不存在"}, 404)
        else:
            _respond_json(handler, {"ok": True, "order": order})
    finally:
        conn.close()
    return True
