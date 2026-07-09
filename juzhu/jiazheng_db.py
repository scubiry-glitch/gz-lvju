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
