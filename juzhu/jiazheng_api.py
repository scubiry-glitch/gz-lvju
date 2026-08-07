"""生活服务 API 模块
独立的后端接口，与家政(jiazheng)接口解耦。

路由:
  - /api/juzhu/callback                    → HMAC 签名（vendor_id 必填）
  - /api/juzhu/jiazheng/vendor/*           → HMAC 签名（vendor_id 必填）
  - /api/juzhu/jiazheng/wechat-link        → 由 server.py API Key 路由调用

认证: HMAC-SHA256（sign_util.HmacAuth），vendor_id → hmac_secret.key 查密钥
"""

import configparser
import json
import sqlite3
import urllib.request
from pathlib import Path

from sign_util import HmacAuth  # noqa: E402

_MODULE_DIR = Path(__file__).resolve().parent
_CONFIG_PATH = _MODULE_DIR / "config.ini"
_KEY_PATH = _MODULE_DIR / "hmac_secret.key"
_DB_PATH = _MODULE_DIR / "juzhu.db"


# ── 密钥加载 ──────────────────────────────────────────────────

def _load_vendor_keys():
    """从 hmac_secret.key 加载 vendor_id → HMAC 密钥映射。
    格式: vendor_id|key（每行一个；忽略空行、# 注释行）。
    返回: {"1": "abc...", "2": "def..."}
    """
    keys = {}
    if not _KEY_PATH.exists():
        return keys
    for line in _KEY_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("|", 1)
        if len(parts) == 2:
            keys[parts[0].strip()] = parts[1].strip()
    return keys


# ── 数据库 ────────────────────────────────────────────────────

def _connect_db():
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    schema_path = _MODULE_DIR / "schema.sql"
    if schema_path.exists():
        conn.executescript(schema_path.read_text(encoding="utf-8"))
    return conn


# ── 工具 ──────────────────────────────────────────────────────

def _load_config():
    cfg = configparser.ConfigParser()
    cfg.read(_CONFIG_PATH, encoding="utf-8")
    return cfg


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

    keys = _load_vendor_keys()
    if not keys:
        return None, "服务端未配置任何 vendor 密钥"

    key = keys.get(vendor_id_str)
    if not key:
        return None, f"vendor_id={vendor_id_str} 的密钥未配置"

    auth = HmacAuth(key)
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
    _, err = _verify_vendor_auth(body)
    if err:
        _respond_json(handler, {"code": 401, "message": err}, 401)
        return True

    order_ref = (body.get("order_ref") or "").strip()
    lailai_oid = (body.get("lailai_oid") or "").strip()
    status = (body.get("status") or "").strip()

    if not order_ref:
        _respond_json(handler, {"code": 400, "message": "缺少 order_ref 参数"}, 400)
        return True
    if not lailai_oid:
        _respond_json(handler, {"code": 400, "message": "缺少 lailai_oid 参数"}, 400)
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
        from gr_orders import get_order_by_ref, get_order_by_ref_and_lailai, update_order_callback

        if status == "paid":
            order = get_order_by_ref(conn, order_ref)
        else:
            order = get_order_by_ref_and_lailai(conn, order_ref, lailai_oid)

        if not order:
            _respond_json(handler, {"code": 404, "message": "订单不存在"}, 404)
            return True

        update_order_callback(
            conn,
            order_ref=order_ref,
            lailai_oid=lailai_oid,
            status=status,
            fee=fee,
            worker_name=worker.get("name") if worker else None,
            worker_phone=worker.get("phone") if worker else None,
            eta=worker.get("eta") if worker else None,
            cancel_reason=cancel_reason if status == "cancelled" else None,
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
    """类目列表（不分页）。返回 status='on' 的子类目。"""
    conn = _connect_db()
    try:
        rows = conn.execute(
            "SELECT id, parent_type, name, icon, sort_order "
            "FROM jz_subcategories WHERE status='on' ORDER BY parent_type, sort_order"
        ).fetchall()
        _respond_json(handler, {"code": 0, "message": "success", "list": [dict(r) for r in rows]})
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
    筛选: category（精确）/ status（精确）/ name（title 模糊）。
    """
    conn = _connect_db()
    try:
        sql = """SELECT p.*, v.name AS vendor_name, v.type AS vendor_type
                 FROM jz_products p LEFT JOIN jz_vendors v ON v.id=p.vendor_id
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
            "SELECT * FROM jz_products WHERE id=? AND vendor_id=?",
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
    """创建产品。vendor_id 由鉴权提供，不可在 body 中覆写。"""
    from jiazheng_db import create_product

    conn = _connect_db()
    try:
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

    from jiazheng_db import update_product

    conn = _connect_db()
    try:
        row = conn.execute(
            "SELECT id FROM jz_products WHERE id=? AND vendor_id=?",
            (int(pid), vendor_id),
        ).fetchone()
        if not row:
            _respond_json(handler, {"code": 404, "message": "产品不存在或不属于该商家"}, 404)
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
    """生成微信小程序 URL Link 并创建 GR 订单。

    请求体: { "product_id": 123 }
    成功响应: { "ok": true, "url_link": "...", "order_ref": "GR..." }
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
        path = product.get("path") or ""
        query = product.get("query") or ""
        sku_slug = product.get("sku_slug") or ""
        vendor_id = product.get("vendor_id")

        from gr_orders import generate_order_ref, create_order

        order_ref = generate_order_ref(conn)

        cfg = _load_config()
        api_url = cfg.get("wechat", "url_link_api", fallback="")
        api_token = cfg.get("wechat", "token", fallback="")
        if not api_url:
            _respond_json(handler, {"ok": False, "error": "config.ini 未配置 url_link_api"}, 500)
            return True

        url_link = _call_third_party_url_link(api_url, api_token, order_ref)

        create_order(conn, order_ref, str(product_id))

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


def _call_third_party_url_link(api_url, api_token, order_ref):
    """调用第三方小程序链接生成接口。

    请求 POST {api_url}
    返回生成的 scheme/url_link 字符串。
    """
    payload = json.dumps({
        "channel": 6,
        "param": f"code={order_ref}&type=1",
        "path": None,
        "cacheFlag": True,
    }).encode("utf-8")

    req = urllib.request.Request(api_url, data=payload, headers={
        "Content-Type": "application/json",
        "Token": api_token,
    })

    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    # 返回格式: {"code":1,"msg":"成功","data":"weixin://...","success":true}
    return data.get("data") or ""
