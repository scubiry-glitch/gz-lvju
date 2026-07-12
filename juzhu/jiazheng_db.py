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


VENDOR_BADGE_LABELS = {
    "whitelist": "白名单商家",
    "backcheck": "平台背调",
    "insurance": "已投保",
    "top10": "销量榜单",
    "commitment": "不满意重做",
}

WORKER_CERT_LABELS = {
    "id_card": "实名认证",
    "health": "健康证",
    "skill": "技能证",
    "insurance": "保险保障",
}

CATEGORY_REVIEW_FALLBACKS = {
    "cleaning": [
        {"name": "张*华", "score": 5, "tags": ["准时", "干净", "细致"], "text": "阿姨很专业，卫生间和厨房的死角都处理得很干净。", "created_at": "近 30 天"},
        {"name": "李*", "score": 5, "tags": ["专业", "周到"], "text": "沟通顺畅，工具带得很全，整体体验很稳。", "created_at": "近 60 天"},
        {"name": "王*", "score": 4, "tags": ["态度好"], "text": "服务过程细致，结束后还主动提醒后续保洁建议。", "created_at": "近 90 天"},
    ],
    "repair": [
        {"name": "周*", "score": 5, "tags": ["上门快", "专业"], "text": "师傅到得很快，问题定位清楚，维修过程也规范。", "created_at": "近 30 天"},
        {"name": "孙*", "score": 5, "tags": ["讲解清楚"], "text": "处理完后把原因和后续注意事项都交代明白了。", "created_at": "近 60 天"},
        {"name": "赵*", "score": 4, "tags": ["态度好"], "text": "响应速度不错，价格透明，适合家里突发维修。", "created_at": "近 90 天"},
    ],
    "moving": [
        {"name": "陈*", "score": 5, "tags": ["守时", "稳妥"], "text": "搬运师傅动作熟练，大件包裹保护做得很好。", "created_at": "近 30 天"},
        {"name": "钱*", "score": 5, "tags": ["效率高"], "text": "装车和还原都很快，流程也很省心。", "created_at": "近 60 天"},
        {"name": "吴*", "score": 4, "tags": ["态度好"], "text": "整体体验稳定，适合家庭同城搬家预约。", "created_at": "近 90 天"},
    ],
    "nanny": [
        {"name": "刘*", "score": 5, "tags": ["耐心", "专业"], "text": "阿姨沟通温和，照护和家务安排都比较有条理。", "created_at": "近 30 天"},
        {"name": "许*", "score": 5, "tags": ["准时", "放心"], "text": "平台认证和背调信息完整，看起来更安心。", "created_at": "近 60 天"},
        {"name": "何*", "score": 4, "tags": ["细致"], "text": "整体服务比较稳，适合长期预约。", "created_at": "近 90 天"},
    ],
}


def _mask_phone(phone):
    digits = "".join(ch for ch in str(phone or "") if ch.isdigit())
    if len(digits) >= 4:
        return digits[:1] + "**" + digits[-1]
    return "匿名用户"



def _parse_rating_json(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None



def _vendor_auth_badges(vendor):
    badges = []
    if vendor.get("whitelist_id"):
        badges.append("白名单商家")
    rank = vendor.get("rank") or {}
    if rank.get("label"):
        badges.append(rank["label"])
    for key in vendor.get("badges") or []:
        label = VENDOR_BADGE_LABELS.get(key)
        if label and label not in badges:
            badges.append(label)
    if vendor.get("live"):
        badges.append("在线接单")
    return badges[:5]



def _worker_auth_badges(worker):
    badges = []
    if worker.get("is_whitelisted"):
        badges.append("白名单服务者")
    for key in worker.get("certs") or []:
        label = WORKER_CERT_LABELS.get(key)
        if label and label not in badges:
            badges.append(label)
    return badges[:5]



def _review_reply(vendor_name, score):
    if score >= 5:
        return (vendor_name or "商家") + "：感谢认可，我们会继续按认证标准完成每次上门服务。"
    if score >= 4:
        return (vendor_name or "商家") + "：感谢反馈，我们会继续优化服务细节与响应体验。"
    return ""



def _review_rows(conn, sku_ids, vendor_name, limit=6):
    if not sku_ids:
        return []
    placeholders = ",".join(["?"] * len(sku_ids))
    rows = conn.execute(
        f"""SELECT o.*, s.name AS sku_name FROM jz_orders o
             LEFT JOIN jz_skus s ON s.id=o.sku_id
             WHERE o.rating_json IS NOT NULL AND o.sku_id IN ({placeholders})
             ORDER BY COALESCE(o.updated_at, o.created_at) DESC LIMIT ?""",
        list(sku_ids) + [int(limit)],
    ).fetchall()
    reviews = []
    for row in rows:
        rowd = dict(row)
        rating = _parse_rating_json(rowd.get("rating_json"))
        if not rating:
            continue
        score = float(rating.get("score") or 0)
        reviews.append(
            {
                "name": _mask_phone(rowd.get("phone")),
                "score": score,
                "tags": rating.get("tags") or [],
                "text": rating.get("text") or ((rowd.get("sku_name") or "本次服务") + "整体完成较稳定。"),
                "created_at": (rating.get("created_at") or rowd.get("updated_at") or rowd.get("created_at") or "").replace("T", " ").replace("Z", "")[:16],
                "reply": _review_reply(vendor_name, score),
            }
        )
    return reviews



def _fallback_reviews(category_id, vendor_name):
    reviews = []
    for item in CATEGORY_REVIEW_FALLBACKS.get(category_id, CATEGORY_REVIEW_FALLBACKS["cleaning"]):
        row = dict(item)
        row["reply"] = _review_reply(vendor_name, row.get("score") or 0)
        reviews.append(row)
    return reviews



def _merchant_intro(vendor, product):
    intro = {
        "summary": "",
        "stats": [],
        "service_flow": ["线上预约 + 确认时间", "平台派单 + 服务者确认", "按标准上门服务", "服务完成 + 记录回传", "客户评价 + 信用回流"],
        "guarantees": ["服务前 2 小时可免费取消", "服务前 2 小时内取消扣 30%", "服务开始后不可取消", "认证商家按平台标准提供售后处理"],
    }
    if not vendor:
        return intro
    vendor_name = vendor.get("name") or "认证商家"
    category = product.get("category") or vendor.get("type") or "家政"
    subtitle = product.get("subtitle") or product.get("title") or ""
    intro["summary"] = (
        vendor_name
        + " 提供 "
        + category
        + " 服务，覆盖 "
        + (vendor.get("address") or "本地核心区域")
        + "，营业时段 "
        + (vendor.get("hours") or "08:00-22:00")
        + "。"
        + (subtitle + "。" if subtitle else "")
        + "平台展示的商家、服务者认证状态与评价会同步回流到详情页，便于下单前判断履约稳定性。"
    )
    intro["stats"] = [
        {"label": "服务评分", "value": str(vendor.get("rating") or "4.8")},
        {"label": "累计评价", "value": str(vendor.get("review_count") or 0)},
        {"label": "起订价格", "value": ("¥%s/%s" % (vendor.get("start_price") or 0, vendor.get("unit") or "次"))},
    ]
    return intro



def get_detail_context_by_channel_sku(conn, sku_id, category_id=None):
    row = conn.execute(
        """SELECT
               p.id AS product_id,
               p.vendor_id AS product_vendor_id,
               p.title AS product_title,
               p.subtitle AS product_subtitle,
               p.category AS product_category,
               p.duration_hours AS product_duration_hours,
               p.area_range AS product_area_range,
               p.unit AS product_unit,
               p.price AS product_price,
               p.original_price AS product_original_price,
               p.discount_label AS product_discount_label,
               p.earliest_time AS product_earliest_time,
               p.advance_booking_hours AS product_advance_booking_hours,
               p.sales_count AS product_sales_count,
               p.rating AS product_rating,
               p.service_tags AS product_service_tags,
               p.channel_sku_id AS product_channel_sku_id,
               p.status AS product_status,
               p.sort_order AS product_sort_order,
               v.id AS vendor_id,
               v.type AS vendor_type,
               v.name AS vendor_name,
               v.logo AS vendor_logo,
               v.address AS vendor_address,
               v.district_id AS vendor_district_id,
               v.phone AS vendor_phone,
               v.rating AS vendor_rating,
               v.review_count AS vendor_review_count,
               v.rank_type AS vendor_rank_type,
               v.rank_label AS vendor_rank_label,
               v.badges AS vendor_badges,
               v.live AS vendor_live,
               v.start_price AS vendor_start_price,
               v.unit AS vendor_unit,
               v.fulfillment AS vendor_fulfillment,
               v.hours AS vendor_hours,
               v.vendor_no AS vendor_vendor_no,
               v.whitelist_id AS vendor_whitelist_id,
               v.status AS vendor_status,
               v.sort_order AS vendor_sort_order,
               v.created_at AS vendor_created_at,
               v.updated_at AS vendor_updated_at
           FROM jz_products p
           JOIN jz_vendors v ON v.id=p.vendor_id
           WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'
           ORDER BY p.rating DESC, p.sales_count DESC, p.id LIMIT 1""",
        (sku_id,),
    ).fetchone()
    if not row:
        return None
    raw = dict(row)
    product = _row_to_dict({
        "id": raw.get("product_id"),
        "vendor_id": raw.get("product_vendor_id"),
        "title": raw.get("product_title"),
        "subtitle": raw.get("product_subtitle"),
        "category": raw.get("product_category"),
        "duration_hours": raw.get("product_duration_hours"),
        "area_range": raw.get("product_area_range"),
        "unit": raw.get("product_unit"),
        "price": raw.get("product_price"),
        "original_price": raw.get("product_original_price"),
        "discount_label": raw.get("product_discount_label"),
        "earliest_time": raw.get("product_earliest_time"),
        "advance_booking_hours": raw.get("product_advance_booking_hours"),
        "sales_count": raw.get("product_sales_count"),
        "rating": raw.get("product_rating"),
        "service_tags": raw.get("product_service_tags"),
        "channel_sku_id": raw.get("product_channel_sku_id"),
        "status": raw.get("product_status"),
        "sort_order": raw.get("product_sort_order"),
    })
    vendor = _row_to_dict({
        "id": raw.get("vendor_id"),
        "type": raw.get("vendor_type"),
        "name": raw.get("vendor_name"),
        "logo": raw.get("vendor_logo"),
        "address": raw.get("vendor_address"),
        "district_id": raw.get("vendor_district_id"),
        "phone": raw.get("vendor_phone"),
        "rating": raw.get("vendor_rating"),
        "review_count": raw.get("vendor_review_count"),
        "rank_type": raw.get("vendor_rank_type"),
        "rank_label": raw.get("vendor_rank_label"),
        "badges": raw.get("vendor_badges"),
        "live": raw.get("vendor_live"),
        "start_price": raw.get("vendor_start_price"),
        "unit": raw.get("vendor_unit"),
        "fulfillment": raw.get("vendor_fulfillment"),
        "hours": raw.get("vendor_hours"),
        "vendor_no": raw.get("vendor_vendor_no"),
        "whitelist_id": raw.get("vendor_whitelist_id"),
        "status": raw.get("vendor_status"),
        "sort_order": raw.get("vendor_sort_order"),
        "created_at": raw.get("vendor_created_at"),
        "updated_at": raw.get("vendor_updated_at"),
    })
    vendor["auth_badges"] = _vendor_auth_badges(vendor)
    workers = list_workers_by_vendor(conn, vendor["id"])
    for worker in workers:
        worker["auth_badges"] = _worker_auth_badges(worker)
    workers = workers[:3]
    sku_ids = [sku_id]
    for p in list_products_by_vendor(conn, vendor["id"]):
        channel_sku_id = p.get("channel_sku_id")
        if channel_sku_id and channel_sku_id not in sku_ids:
            sku_ids.append(channel_sku_id)
    reviews = _review_rows(conn, sku_ids[:8], vendor.get("name"), limit=6)
    if len(reviews) < 3:
        reviews.extend(_fallback_reviews(category_id or vendor.get("type") or "cleaning", vendor.get("name")))
        reviews = reviews[:4]
    return {
        "product": product,
        "vendor": vendor,
        "workers": workers,
        "reviews": reviews,
        "merchant_intro": _merchant_intro(vendor, product),
    }


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
