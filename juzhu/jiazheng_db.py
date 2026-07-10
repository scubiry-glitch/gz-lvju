"""居住服务·家政频道 · jz_* 表的 CRUD
所有 vendor/product/worker JSON 输出都解析 badges/tags/certs/platform_certs 字段
"""
import json
import sqlite3

CERT_LABELS = {
    "id_card": "身份核验",
    "health": "健康证核验",
    "skill": "技能考核认证",
    "insurance": "责任险承保",
    "backcheck": "平台背调",
}
CERT_PREFIX = {
    "id_card": "JZ-ID",
    "health": "JZ-HC",
    "skill": "JZ-SK",
    "insurance": "JZ-IN",
    "backcheck": "JZ-BC",
}
VENDOR_BADGE_CERTS = {
    "whitelist": ("JZ-V-WL", "白名单商家认证"),
    "backcheck": ("JZ-V-BC", "平台背调认证"),
    "insurance": ("JZ-V-IN", "百万保障认证"),
    "commitment": ("JZ-V-CM", "服务承诺认证"),
    "top10": ("JZ-V-T10", "销量榜认证"),
}


def _ensure_worker_certs(w):
    if not w:
        return w
    if w.get("platform_certs"):
        return w
    out = []
    wid = w.get("id") or 0
    level = w.get("level") or "L3"
    if w.get("whitelist_id") or w.get("is_whitelisted"):
        wl = w.get("whitelist_id") or f"S{wid}"
        out.append({
            "code": f"JZ-S-{wl}",
            "name": f"{level} 服务者持证",
            "issuer": "P 服务认证中台",
            "valid_until": "2027-06-30",
            "status": "valid",
        })
    for c in w.get("certs") or []:
        if c == "whitelist":
            continue
        prefix = CERT_PREFIX.get(c, f"JZ-{c.upper()}")
        out.append({
            "code": f"{prefix}-{wid}",
            "name": CERT_LABELS.get(c, c),
            "issuer": "P 服务认证中台",
            "valid_until": "2027-06-30" if c == "insurance" else "2026-12-31",
            "status": "valid",
        })
    w["platform_certs"] = out
    return w


def _ensure_vendor_certs(v):
    if not v:
        return v
    if v.get("platform_certs"):
        return v
    out = []
    vid = v.get("id") or 0
    vno = v.get("vendor_no") or f"V{vid:04d}"
    v["vendor_no"] = vno
    out.append({
        "code": f"JZ-B-{vno}",
        "name": "家政商家主体认证",
        "issuer": "P 服务认证中台",
        "valid_until": "2027-12-31",
        "status": "valid",
    })
    for b in v.get("badges") or []:
        spec = VENDOR_BADGE_CERTS.get(b)
        if not spec:
            continue
        prefix, name = spec
        out.append({
            "code": f"{prefix}-{vid}",
            "name": name,
            "issuer": "P 服务认证中台",
            "valid_until": "2027-06-30",
            "status": "valid",
        })
    v["platform_certs"] = out
    return v


def _row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    for key in ("badges", "tags", "service_tags", "certs", "platform_certs"):
        if key in d and isinstance(d[key], str):
            try:
                d[key] = json.loads(d[key])
            except (json.JSONDecodeError, TypeError):
                d[key] = []
    # 把 rank_type + rank_label 组合成嵌套对象
    if "rank_type" in d or "rank_label" in d:
        if d.get("rank_type") and d.get("rank_label"):
            d["rank"] = {"type": d["rank_type"], "label": d["rank_label"]}
        else:
            d["rank"] = None
    return d


def _rows_to_list(rows):
    return [_row_to_dict(r) for r in rows]


# ====== Categories ======
def list_categories(conn, parent_type=None, status="on"):
    if parent_type:
        rows = conn.execute(
            "SELECT * FROM jz_categories WHERE parent_type=? AND status=? ORDER BY sort_order",
            (parent_type, status),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM jz_categories WHERE status=? ORDER BY parent_type, sort_order",
            (status,),
        ).fetchall()
    return _rows_to_list(rows)


# ====== Vendors ======
def list_vendors(conn, type_=None, status="active"):
    if type_:
        rows = conn.execute(
            "SELECT * FROM jz_vendors WHERE type=? AND status=? ORDER BY sort_order, id",
            (type_, status),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM jz_vendors WHERE status=? ORDER BY type, sort_order, id",
            (status,),
        ).fetchall()
    vendors = _rows_to_list(rows)
    # 为每个商家附加前 2 个 SKU + 中台证书
    for v in vendors:
        _ensure_vendor_certs(v)
        v["products"] = list_products_by_vendor(conn, v["id"])[:2]
    return vendors


def get_vendor(conn, vendor_id):
    row = conn.execute("SELECT * FROM jz_vendors WHERE id=?", (vendor_id,)).fetchone()
    if not row:
        return None
    v = _row_to_dict(row)
    _ensure_vendor_certs(v)
    # 关联产品
    v["products"] = list_products_by_vendor(conn, vendor_id)
    # 关联服务者
    v["workers"] = [_ensure_worker_certs(w) for w in list_workers_by_vendor(conn, vendor_id)]
    return v


# ====== Products ======
def list_products_by_vendor(conn, vendor_id, status="on"):
    rows = conn.execute(
        "SELECT * FROM jz_products WHERE vendor_id=? AND status=? ORDER BY sort_order, id",
        (vendor_id, status),
    ).fetchall()
    return _rows_to_list(rows)


def get_product(conn, product_id):
    row = conn.execute("SELECT * FROM jz_products WHERE id=?", (product_id,)).fetchone()
    return _row_to_dict(row)


# ====== Workers ======
def list_workers_by_vendor(conn, vendor_id):
    rows = conn.execute(
        "SELECT * FROM jz_workers WHERE vendor_id=? AND status='active' ORDER BY level DESC, rating DESC",
        (vendor_id,),
    ).fetchall()
    return [_ensure_worker_certs(w) for w in _rows_to_list(rows)]


def list_workers_online(conn):
    rows = conn.execute(
        "SELECT * FROM jz_workers WHERE online=1 AND status='active' ORDER BY level DESC, credit_score DESC"
    ).fetchall()
    return [_ensure_worker_certs(w) for w in _rows_to_list(rows)]


def get_worker(conn, worker_id):
    row = conn.execute("SELECT * FROM jz_workers WHERE id=?", (worker_id,)).fetchone()
    return _ensure_worker_certs(_row_to_dict(row))


# ====== Activities (贝壳缓存) ======
def upsert_activity(conn, activity):
    """activity: {activity_id, name, unit, cover_remote, cover_path, banner_paths, detail, price, tag_id}"""
    aid = activity["activity_id"]
    conn.execute(
        """INSERT INTO jz_activities(activity_id, name, unit, cover_path, cover_remote, banner_paths, detail, price, tag_id, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(activity_id) DO UPDATE SET
             name=excluded.name,
             unit=excluded.unit,
             cover_path=COALESCE(excluded.cover_path, cover_path),
             cover_remote=COALESCE(excluded.cover_remote, cover_remote),
             banner_paths=COALESCE(excluded.banner_paths, banner_paths),
             detail=excluded.detail,
             price=excluded.price,
             tag_id=excluded.tag_id,
             fetched_at=excluded.fetched_at""",
        (
            aid,
            activity.get("name"),
            activity.get("unit"),
            activity.get("cover_path"),
            activity.get("cover_remote"),
            json.dumps(activity.get("banner_paths") or [], ensure_ascii=False),
            activity.get("detail"),
            activity.get("price"),
            activity.get("tag_id"),
            activity.get("fetched_at"),
        ),
    )


def list_activities(conn, tag_id=None, limit=100):
    if tag_id:
        rows = conn.execute(
            "SELECT * FROM jz_activities WHERE tag_id=? ORDER BY id DESC LIMIT ?",
            (tag_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM jz_activities ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return _rows_to_list(rows)


# ====== Orders ======
def create_order(conn, order):
    """order: {id, type, vendor_id, product_id, vendor_name, vendor_logo, product_title,
                product_sub, product_price, address, phone, scheduled_at, fee, status, source}
    Returns the created order id."""
    conn.execute(
        """INSERT INTO jz_orders(id, type, vendor_id, product_id, vendor_name, vendor_logo,
           product_title, product_sub, product_price, address, phone, scheduled_at,
           fee, status, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            order["id"],
            order["type"],
            order["vendor_id"],
            order["product_id"],
            order.get("vendor_name"),
            order.get("vendor_logo"),
            order.get("product_title"),
            order.get("product_sub"),
            order.get("product_price"),
            order.get("address"),
            order.get("phone"),
            order.get("scheduled_at"),
            order.get("fee"),
            order.get("status", "pending"),
            order.get("source", "jz"),
            order.get("created_at"),
            order.get("updated_at"),
        ),
    )
    return order["id"]


def get_order(conn, order_id):
    row = conn.execute("SELECT * FROM jz_orders WHERE id=?", (order_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    if d.get("worker_id"):
        d["worker"] = get_worker(conn, d["worker_id"])
    if d.get("vendor_id"):
        vrow = conn.execute("SELECT * FROM jz_vendors WHERE id=?", (d["vendor_id"],)).fetchone()
        if vrow:
            v = _ensure_vendor_certs(_row_to_dict(vrow))
            d["vendor_platform_certs"] = v.get("platform_certs", [])
            d["vendor_no"] = v.get("vendor_no")
    if d.get("rating"):
        try:
            d["rating"] = json.loads(d["rating"])
        except (json.JSONDecodeError, TypeError):
            pass
    return d


def list_orders(conn, status=None, limit=50):
    if status:
        rows = conn.execute(
            "SELECT * FROM jz_orders WHERE status=? ORDER BY created_at DESC LIMIT ?",
            (status, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM jz_orders ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def update_order_status(conn, order_id, status, worker_id=None):
    """更新订单状态。worker_id 可选（dispatched 时绑定）"""
    if worker_id is not None:
        conn.execute(
            "UPDATE jz_orders SET status=?, worker_id=?, updated_at=? WHERE id=?",
            (status, worker_id, _now(), order_id),
        )
    else:
        conn.execute(
            "UPDATE jz_orders SET status=?, updated_at=? WHERE id=?",
            (status, _now(), order_id),
        )


def rate_order(conn, order_id, score, tags, text, credit_delta=0.0):
    rating = {"score": score, "tags": tags, "text": text, "created_at": _now()}
    conn.execute(
        "UPDATE jz_orders SET status='rated', rating=?, updated_at=? WHERE id=?",
        (json.dumps(rating, ensure_ascii=False), _now(), order_id),
    )
    # 信用引擎预留：可在此调用 G 端白名单接口更新 worker 信用分
    # （目前 mock：写入到 worker.credit_score）
    # row = conn.execute("SELECT worker_id FROM jz_orders WHERE id=?", (order_id,)).fetchone()
    # if row and row["worker_id"]:
    #     conn.execute("UPDATE jz_workers SET credit_score=MIN(100,MAX(0,credit_score+?)) WHERE id=?", (credit_delta, row["worker_id"]))


def _now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ====== Categories CRUD (P 端·类目管理) ======
def list_categories_all(conn):
    """所有子类目（不区分 status）— 管理端用"""
    rows = conn.execute(
        "SELECT * FROM jz_categories ORDER BY parent_type, sort_order, id"
    ).fetchall()
    return _rows_to_list(rows)


def create_category(conn, data):
    """新增子类目"""
    cur = conn.execute(
        "INSERT INTO jz_categories (parent_type, name, icon, sort_order, status) VALUES (?,?,?,?,?)",
        (data.get("parent_type", "cleaning"),
         data.get("name", ""),
         data.get("icon", "📦"),
         int(data.get("sort_order", 99)),
         data.get("status", "on")),
    )
    return cur.lastrowid


def update_category(conn, cat_id, data):
    """更新子类目"""
    fields = []
    params = []
    for k in ("parent_type", "name", "icon", "sort_order", "status"):
        if k in data:
            fields.append(f"{k}=?")
            params.append(data[k])
    if not fields:
        return False
    params.append(cat_id)
    cur = conn.execute(f"UPDATE jz_categories SET {', '.join(fields)} WHERE id=?", params)
    return cur.rowcount > 0


def delete_category(conn, cat_id):
    """删除子类目（有产品引用则不允许）"""
    used = conn.execute(
        "SELECT COUNT(*) c FROM jz_products WHERE category=(SELECT name FROM jz_categories WHERE id=?)",
        (cat_id,),
    ).fetchone()[0]
    if used > 0:
        return {"ok": False, "error": f"该子类目有 {used} 个产品引用，无法删除"}
    conn.execute("DELETE FROM jz_categories WHERE id=?", (cat_id,))
    return {"ok": True}


# ====== Products CRUD (B 端·产品管理) ======
def list_products(conn, vendor_id=None, type_=None, status=None, limit=200):
    """产品列表（支持 vendor_id / type / status 过滤）"""
    sql = """SELECT p.*, v.name AS vendor_name, v.type AS vendor_type
             FROM jz_products p LEFT JOIN jz_vendors v ON v.id=p.vendor_id
             WHERE 1=1"""
    params = []
    if vendor_id is not None:
        sql += " AND p.vendor_id=?"
        params.append(int(vendor_id))
    if type_:
        sql += " AND v.type=?"
        params.append(type_)
    if status:
        sql += " AND p.status=?"
        params.append(status)
    sql += " ORDER BY p.vendor_id, p.sort_order, p.id LIMIT ?"
    params.append(int(limit))
    rows = conn.execute(sql, params).fetchall()
    return _rows_to_list(rows)


def create_product(conn, data):
    """新增产品"""
    import json as _json
    cur = conn.execute(
        """INSERT INTO jz_products
           (vendor_id, title, subtitle, category, duration_hours, area_range, unit,
            price, original_price, discount_label, earliest_time, advance_booking_hours,
            sales_count, rating, service_tags, status, sort_order)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (int(data.get("vendor_id", 0)),
         data.get("title", ""),
         data.get("subtitle", ""),
         data.get("category", ""),
         float(data.get("duration_hours", 0)),
         data.get("area_range", ""),
         data.get("unit", "次"),
         float(data.get("price", 0)),
         float(data.get("original_price", 0)) if data.get("original_price") else None,
         data.get("discount_label", ""),
         data.get("earliest_time", ""),
         int(data.get("advance_booking_hours", 0)),
         int(data.get("sales_count", 0)),
         float(data.get("rating", 0)),
         _json.dumps(data.get("service_tags", []), ensure_ascii=False),
         data.get("status", "on"),
         int(data.get("sort_order", 99))),
    )
    return cur.lastrowid


def update_product(conn, pid, data):
    """更新产品"""
    import json as _json
    fields = []
    params = []
    for k in ("vendor_id", "title", "subtitle", "category", "duration_hours", "area_range",
              "unit", "price", "original_price", "discount_label", "earliest_time",
              "advance_booking_hours", "sales_count", "rating", "status", "sort_order"):
        if k in data:
            v = data[k]
            if k == "service_tags":
                v = _json.dumps(v, ensure_ascii=False)
            fields.append(f"{k}=?")
            params.append(v)
    if not fields:
        return False
    params.append(pid)
    cur = conn.execute(f"UPDATE jz_products SET {', '.join(fields)} WHERE id=?", params)
    return cur.rowcount > 0


def delete_product(conn, pid):
    conn.execute("DELETE FROM jz_products WHERE id=?", (pid,))
    return {"ok": True}


# ====== Workers CRUD (B 端·服务者管理) ======
def list_workers(conn, vendor_id=None, status=None, limit=200):
    """服务者列表（支持 vendor_id / status 过滤）"""
    sql = """SELECT w.*, v.name AS vendor_name, v.type AS vendor_type
             FROM jz_workers w LEFT JOIN jz_vendors v ON v.id=w.vendor_id
             WHERE 1=1"""
    params = []
    if vendor_id is not None:
        sql += " AND w.vendor_id=?"
        params.append(int(vendor_id))
    if status:
        sql += " AND w.status=?"
        params.append(status)
    sql += " ORDER BY w.vendor_id, w.level DESC, w.rating DESC LIMIT ?"
    params.append(int(limit))
    rows = conn.execute(sql, params).fetchall()
    return [_ensure_worker_certs(w) for w in _rows_to_list(rows)]


def create_worker(conn, data):
    """新增服务者"""
    import json as _json
    cur = conn.execute(
        """INSERT INTO jz_workers
           (name, avatar, level, credit_score, tags, certs, is_whitelisted, rating,
            completed_orders, years_experience, online, distance_km, vendor_id, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (data.get("name", ""),
         data.get("avatar", "👤"),
         data.get("level", "L3"),
         int(data.get("credit_score", 70)),
         _json.dumps(data.get("tags", []), ensure_ascii=False),
         _json.dumps(data.get("certs", []), ensure_ascii=False),
         int(data.get("is_whitelisted", 0)),
         float(data.get("rating", 0)),
         int(data.get("completed_orders", 0)),
         int(data.get("years_experience", 0)),
         int(data.get("online", 0)),
         float(data.get("distance_km", 0)) if data.get("distance_km") else None,
         int(data.get("vendor_id", 0)) if data.get("vendor_id") else None,
         data.get("status", "active")),
    )
    return cur.lastrowid


def update_worker(conn, wid, data):
    """更新服务者"""
    import json as _json
    fields = []
    params = []
    for k in ("name", "avatar", "level", "credit_score", "certs", "is_whitelisted",
              "rating", "completed_orders", "years_experience", "online",
              "distance_km", "vendor_id", "status"):
        if k in data:
            v = data[k]
            if k in ("tags", "certs"):
                v = _json.dumps(v, ensure_ascii=False)
            fields.append(f"{k}=?")
            params.append(v)
    if not fields:
        return False
    params.append(wid)
    cur = conn.execute(f"UPDATE jz_workers SET {', '.join(fields)} WHERE id=?", params)
    return cur.rowcount > 0


def delete_worker(conn, wid):
    conn.execute("DELETE FROM jz_workers WHERE id=?", (wid,))
    return {"ok": True}
