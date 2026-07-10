"""居住服务·家政频道 · jz_* 表的 CRUD
所有 vendor/product/worker JSON 输出都解析 badges/tags/certs 字段
"""
import json
import sqlite3


def _row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    for key in ("badges", "tags", "service_tags", "certs"):
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
            "SELECT * FROM jz_subcategories WHERE parent_type=? AND status=? ORDER BY sort_order",
            (parent_type, status),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM jz_subcategories WHERE status=? ORDER BY parent_type, sort_order",
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
    # 为每个商家附加前 2 个 SKU
    for v in vendors:
        v["products"] = list_products_by_vendor(conn, v["id"])[:2]
    return vendors


def get_vendor(conn, vendor_id):
    row = conn.execute("SELECT * FROM jz_vendors WHERE id=?", (vendor_id,)).fetchone()
    if not row:
        return None
    v = _row_to_dict(row)
    # 关联产品
    v["products"] = list_products_by_vendor(conn, vendor_id)
    # 关联服务者
    v["workers"] = list_workers_by_vendor(conn, vendor_id)
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
    return _rows_to_list(rows)


def list_workers_online(conn):
    rows = conn.execute(
        "SELECT * FROM jz_workers WHERE online=1 AND status='active' ORDER BY level DESC, credit_score DESC"
    ).fetchall()
    return _rows_to_list(rows)


def get_worker(conn, worker_id):
    row = conn.execute("SELECT * FROM jz_workers WHERE id=?", (worker_id,)).fetchone()
    return _row_to_dict(row)


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


# ====== Orders（读统一 C 端 jz_orders · SKU 工单表） ======
def _order_row_to_legacy(row):
    if not row:
        return None
    d = dict(row)
    worker = None
    if d.get("worker_json"):
        try:
            worker = json.loads(d["worker_json"])
        except (json.JSONDecodeError, TypeError):
            pass
    rating = None
    if d.get("rating_json"):
        try:
            rating = json.loads(d["rating_json"])
        except (json.JSONDecodeError, TypeError):
            pass
    return {
        "id": d["id"],
        "type": d.get("category_id") or d.get("type"),
        "vendor_id": None,
        "product_id": d.get("sku_id"),
        "vendor_name": d.get("source"),
        "vendor_logo": None,
        "product_title": d.get("sku_name") or d.get("type"),
        "product_sub": d.get("desc"),
        "product_price": d.get("fee"),
        "address": d.get("house"),
        "phone": d.get("phone"),
        "scheduled_at": d.get("expect_time"),
        "fee": d.get("fee"),
        "status": d.get("status"),
        "pay_status": d.get("pay_status"),
        "worker_id": worker.get("id") if worker else None,
        "worker": worker,
        "rating": rating,
        "source": d.get("source"),
        "created_at": d.get("created_at"),
        "updated_at": d.get("updated_at"),
    }


def get_order(conn, order_id):
    row = conn.execute(
        """SELECT o.*, s.name AS sku_name FROM jz_orders o
           LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE o.id=?""",
        (order_id,),
    ).fetchone()
    return _order_row_to_legacy(row)


def list_orders(conn, status=None, limit=50):
    sql = """SELECT o.*, s.name AS sku_name FROM jz_orders o
             LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE 1=1"""
    params = []
    if status:
        sql += " AND o.status=?"
        params.append(status)
    sql += " ORDER BY o.created_at DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    return [_order_row_to_legacy(r) for r in rows]


def update_order_status(conn, order_id, status, worker_id=None):
    worker_json = None
    if worker_id is not None:
        w = get_worker(conn, worker_id)
        if w:
            worker_json = json.dumps(
                {
                    "id": worker_id,
                    "name": w.get("name"),
                    "level": w.get("level"),
                    "avatar": w.get("avatar"),
                },
                ensure_ascii=False,
            )
    if worker_json is not None:
        conn.execute(
            "UPDATE jz_orders SET status=?, worker_json=?, updated_at=? WHERE id=?",
            (status, worker_json, _now(), order_id),
        )
    else:
        conn.execute(
            "UPDATE jz_orders SET status=?, updated_at=? WHERE id=?",
            (status, _now(), order_id),
        )


def rate_order(conn, order_id, score, tags, text, credit_delta=0.0):
    rating = {"score": score, "tags": tags, "text": text, "created_at": _now()}
    conn.execute(
        "UPDATE jz_orders SET status='rated', rating_json=?, updated_at=? WHERE id=?",
        (json.dumps(rating, ensure_ascii=False), _now(), order_id),
    )


def _now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ====== Categories CRUD (P 端·类目管理) ======
def list_categories_all(conn):
    """所有子类目（不区分 status）— 管理端用"""
    rows = conn.execute(
        "SELECT * FROM jz_subcategories ORDER BY parent_type, sort_order, id"
    ).fetchall()
    return _rows_to_list(rows)


def create_category(conn, data):
    """新增子类目"""
    cur = conn.execute(
        "INSERT INTO jz_subcategories (parent_type, name, icon, sort_order, status) VALUES (?,?,?,?,?)",
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
    cur = conn.execute(f"UPDATE jz_subcategories SET {', '.join(fields)} WHERE id=?", params)
    return cur.rowcount > 0


def delete_category(conn, cat_id):
    """删除子类目（有产品引用则不允许）"""
    used = conn.execute(
        "SELECT COUNT(*) c FROM jz_products WHERE category=(SELECT name FROM jz_subcategories WHERE id=?)",
        (cat_id,),
    ).fetchone()[0]
    if used > 0:
        return {"ok": False, "error": f"该子类目有 {used} 个产品引用，无法删除"}
    conn.execute("DELETE FROM jz_subcategories WHERE id=?", (cat_id,))
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
    return _rows_to_list(rows)


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
