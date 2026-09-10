"""居住服务·家政频道 · jz_* 表的 CRUD
所有 vendor/product/worker JSON 输出都解析 badges/tags/certs 字段
"""
import json


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


VENDOR_SECRET_FIELDS = ("hmac_key", "url_link", "order_detail_url")


def _strip_vendor_secrets(vendor):
    """对外响应剥离商家密钥与接口地址（内部出站调用另从 jiazheng_api 缓存取）。"""
    if not vendor:
        return vendor
    for f in VENDOR_SECRET_FIELDS:
        vendor.pop(f, None)
    return vendor


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
        _strip_vendor_secrets(v)
        v["products"] = list_products_by_vendor(conn, v["id"])[:2]
    return vendors


def get_vendor(conn, vendor_id):
    row = conn.execute("SELECT * FROM jz_vendors WHERE id=?", (vendor_id,)).fetchone()
    if not row:
        return None
    v = _row_to_dict(row)
    _strip_vendor_secrets(v)
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
    d = _row_to_dict(row)
    if d:
        d["worker_ids"] = list_product_worker_ids(conn, product_id)
        d["workers"] = list_product_workers(conn, product_id)
    return d


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



def _review_rows(conn, product_ids, vendor_name, limit=6):
    if not product_ids:
        return []
    # 旧库可能是 P/B 订单表（product_id/rating），无 C 端 rating_json/sku_id —— 评价可选，缺列则跳过
    order_cols = {r[1] for r in conn.execute("PRAGMA table_info(jz_orders)").fetchall()}
    if "rating_json" not in order_cols or "sku_id" not in order_cols:
        return []
    placeholders = ",".join(["?"] * len(product_ids))
    rows = conn.execute(
        f"""SELECT o.*, s.name AS sku_name FROM jz_orders o
             LEFT JOIN jz_products p ON p.id=o.sku_id
             LEFT JOIN jz_skus s ON s.id=p.channel_sku_id
             WHERE o.rating_json IS NOT NULL AND o.sku_id IN ({placeholders})
             ORDER BY COALESCE(o.updated_at, o.created_at) DESC LIMIT ?""",
        list(product_ids) + [int(limit)],
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



def list_channel_sku_products(conn, sku_id, vendor_id=None, city_id=None):
    """某 SPU 下全部上架商品（商家 SKU），含商家摘要，按评分-销量-创建时间排序。
    同一商家可为同一 SPU 挂多个商品（不同套餐/服务者），C 端详情页全部展示供选择。
    """
    city_filter = ""
    city_params = []
    if city_id is not None:
        # 双维度过滤：商品 city_id 命中 且 商家 city_ids 声明服务该城（city_ids 为空视为全省可约）
        city_filter = (" AND (p.city_id=? OR p.city_id IS NULL) "
                       "AND (v.city_ids IS NULL OR TRIM(v.city_ids)='' "
                       "OR CONCAT(',', v.city_ids, ',') LIKE CONCAT('%,', ?, ',%'))")
        city_params = [int(city_id), str(city_id)]
    rows = conn.execute(
        """SELECT p.*, v.name AS vendor_name, v.logo AS vendor_logo,
                  v.rating AS vendor_rating, v.review_count AS vendor_review_count,
                  v.type AS vendor_type
           FROM jz_products p JOIN jz_vendors v ON v.id=p.vendor_id
           WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'
           """ + ("AND p.vendor_id=? " if vendor_id else "") + city_filter + """
           ORDER BY p.rating DESC, p.sales_count DESC, p.id""",
        ((sku_id, vendor_id) if vendor_id else (sku_id,)) + tuple(city_params),
    ).fetchall()
    return _rows_to_list(rows)


def get_detail_context_by_channel_sku(conn, sku_id, category_id=None, vendor_id=None, city_id=None):
    """C 端 SKU 详情上下文：商品列表 + 默认商品 + 默认商家 + 服务者 + 评价 + 商家介绍。
    同一商家同一 SPU 可有多商品，products 全量返回，product 为排序第一名（默认选中）。
    """
    products = list_channel_sku_products(conn, sku_id, vendor_id, city_id)
    if not products:
        return None
    product = products[0]
    row = conn.execute("SELECT * FROM jz_vendors WHERE id=?", (product["vendor_id"],)).fetchone()
    if not row:
        return None
    vendor = _row_to_dict(row)
    _strip_vendor_secrets(vendor)
    vendor["auth_badges"] = _vendor_auth_badges(vendor)
    # 优先取默认商品绑定的服务者（P2：SKU=SPU+服务者+时间）；无绑定回退到商家全员
    workers = list_product_workers(conn, product["id"])
    if not workers:
        workers = list_workers_by_vendor(conn, vendor["id"])
    for worker in workers:
        worker["auth_badges"] = _worker_auth_badges(worker)
    workers = workers[:4]
    reviews = _review_rows(conn, [p["id"] for p in products[:8]], vendor.get("name"), limit=6)
    if len(reviews) < 3:
        reviews.extend(_fallback_reviews(category_id or vendor.get("type") or "cleaning", vendor.get("name")))
        reviews = reviews[:4]
    return {
        "product": product,
        "products": products,
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
           ON DUPLICATE KEY UPDATE
             name=VALUES(name),
             unit=VALUES(unit),
             cover_path=COALESCE(VALUES(cover_path), cover_path),
             cover_remote=COALESCE(VALUES(cover_remote), cover_remote),
             banner_paths=COALESCE(VALUES(banner_paths), banner_paths),
             detail=VALUES(detail),
             price=VALUES(price),
             tag_id=VALUES(tag_id),
             fetched_at=VALUES(fetched_at)""",
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
def vendor_city_ids(conn, vendor_id):
    """解析商家关联城市 id 列表（city_ids 文本逗号分隔）；无关联返回 []"""
    row = conn.execute(
        "SELECT city_ids FROM jz_vendors WHERE id=?", (int(vendor_id),)
    ).fetchone()
    raw = (row[0] if row else None) or ""
    ids = []
    for part in raw.split(","):
        part = part.strip()
        if part.isdigit():
            ids.append(int(part))
    return ids


def validate_product_city(conn, vendor_id, city_id):
    """商品城市校验：city_id 必填且必须属于商家的 city_ids。
    返回 (ok, err_msg)，不通过时 err_msg 为中文提示。"""
    if city_id is None or (isinstance(city_id, str) and not city_id.strip()):
        return False, "缺少 city_id"
    try:
        cid = int(city_id)
    except (TypeError, ValueError):
        return False, "city_id 非法"
    if cid not in vendor_city_ids(conn, vendor_id):
        return False, "city_id 不属于该商家"
    return True, ""


def list_products(conn, vendor_id=None, type_=None, status=None, city_id=None, limit=200):
    """产品列表（支持 vendor_id / type / status / city_id 过滤）
    类目维度以商品引用 SPU 的 category_id 为准（product_category），
    未引用 SPU 时兜底回退商家 type。附带城市名 city_name。
    """
    sql = """SELECT p.*, v.name AS vendor_name, v.type AS vendor_type,
                    COALESCE(s.category_id, v.type) AS product_category,
                    c.name AS city_name
             FROM jz_products p
             LEFT JOIN jz_vendors v ON v.id=p.vendor_id
             LEFT JOIN jz_skus s ON s.id=p.channel_sku_id
             LEFT JOIN cities c ON c.id=p.city_id
             WHERE 1=1"""
    params = []
    if vendor_id is not None:
        sql += " AND p.vendor_id=?"
        params.append(int(vendor_id))
    if type_:
        sql += " AND COALESCE(s.category_id, v.type)=?"
        params.append(type_)
    if status:
        sql += " AND p.status=?"
        params.append(status)
    if city_id is not None:
        sql += " AND p.city_id=?"
        params.append(int(city_id))
    sql += " ORDER BY p.vendor_id, p.sort_order, p.id LIMIT ?"
    params.append(int(limit))
    rows = conn.execute(sql, params).fetchall()
    items = _rows_to_list(rows)
    # 附加：引用的 SPU 名 + 绑定服务者 id 列表
    for it in items:
        it["worker_ids"] = list_product_worker_ids(conn, it["id"])
        if it.get("channel_sku_id"):
            srow = conn.execute(
                "SELECT name FROM jz_skus WHERE id=?", (it["channel_sku_id"],)
            ).fetchone()
            it["spu_name"] = srow[0] if srow else None
        else:
            it["spu_name"] = None
    return items


def create_product(conn, data):
    """新增商家 SKU（引用 SPU=channel_sku_id，可绑本店服务者 worker_ids）"""
    import json as _json
    cur = conn.execute(
        """INSERT INTO jz_products
           (vendor_id, city_id, title, subtitle, category, duration_hours, area_range, unit,
            price, original_price, discount_label, earliest_time, advance_booking_hours,
            sales_count, rating, service_tags, channel_sku_id, path, query, status, sort_order)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (int(data.get("vendor_id", 0)),
         int(data["city_id"]) if data.get("city_id") else None,
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
         int(data["channel_sku_id"]) if data.get("channel_sku_id") else None,
         data.get("path", ""),
         data.get("query", ""),
         data.get("status", "on"),
         int(data.get("sort_order", 99))),
    )
    pid = cur.lastrowid
    if "worker_ids" in data:
        set_product_workers(conn, pid, data.get("worker_ids") or [])
    return pid


def update_product(conn, pid, data):
    """更新商家 SKU"""
    import json as _json
    fields = []
    params = []
    for k in ("vendor_id", "city_id", "title", "subtitle", "category", "duration_hours", "area_range",
              "unit", "price", "original_price", "discount_label", "earliest_time",
              "advance_booking_hours", "sales_count", "rating", "service_tags",
              "channel_sku_id", "path", "query", "status", "sort_order"):
        if k in data:
            v = data[k]
            if k == "service_tags":
                v = _json.dumps(v, ensure_ascii=False)
            elif k == "channel_sku_id":
                v = int(v) if v else None
            elif k == "city_id":
                v = int(v) if v else None
            fields.append(f"{k}=?")
            params.append(v)
    ok = True
    if fields:
        params.append(pid)
        cur = conn.execute(f"UPDATE jz_products SET {', '.join(fields)} WHERE id=?", params)
        ok = cur.rowcount > 0
    if "worker_ids" in data:
        set_product_workers(conn, pid, data.get("worker_ids") or [])
        ok = True
    return ok


def delete_product(conn, pid):
    conn.execute("DELETE FROM jz_sku_workers WHERE product_id=?", (pid,))
    conn.execute("DELETE FROM jz_products WHERE id=?", (pid,))
    return {"ok": True}


def _level_num(lv):
    """'L4' → 4；无法解析按 0。按数字比较，避免 'L10' < 'L3' 的字符串序错误。"""
    try:
        return int(str(lv).lstrip("Ll") or 0)
    except (ValueError, TypeError):
        return 0


def set_product_workers(conn, product_id, worker_ids):
    """全量重置某 SKU 绑定的服务者；过滤掉等级低于该商家 SKU 对应 SPU
    worker_min_level 的服务者——之前 worker_min_level 从不参与接单资格校验，
    低于门槛的服务者也能被绑上接单。"""
    conn.execute("DELETE FROM jz_sku_workers WHERE product_id=?", (int(product_id),))
    minrow = conn.execute(
        """SELECT sk.worker_min_level FROM jz_products p
           LEFT JOIN jz_skus sk ON sk.id=p.channel_sku_id WHERE p.id=?""",
        (int(product_id),),
    ).fetchone()
    min_lv = _level_num(minrow[0]) if minrow and minrow[0] else 0
    for wid in worker_ids:
        try:
            wid = int(wid)
        except (ValueError, TypeError):
            continue
        if min_lv:
            wl = conn.execute("SELECT level FROM jz_workers WHERE id=?", (wid,)).fetchone()
            if not wl or _level_num(wl[0]) < min_lv:
                continue  # 低于 SPU 门槛，跳过绑定
        conn.execute(
            "INSERT IGNORE INTO jz_sku_workers(product_id, worker_id) VALUES (?,?)",
            (int(product_id), wid),
        )


def list_product_worker_ids(conn, product_id):
    rows = conn.execute(
        "SELECT worker_id FROM jz_sku_workers WHERE product_id=?", (product_id,)
    ).fetchall()
    return [r[0] for r in rows]


def list_product_workers(conn, product_id):
    """SKU 绑定的服务者明细（带认证信息）。"""
    rows = conn.execute(
        """SELECT w.* FROM jz_sku_workers sw
           JOIN jz_workers w ON w.id=sw.worker_id
           WHERE sw.product_id=? ORDER BY w.level DESC, w.rating DESC""",
        (product_id,),
    ).fetchall()
    return _rows_to_list(rows)


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
    for k in ("name", "avatar", "level", "credit_score", "tags", "certs", "is_whitelisted",
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
    # 先清引用子表再删主表：jz_sku_workers / jz_sku_slots 的 worker_id 有外键且无
    # ON DELETE CASCADE，connect() 又开了 PRAGMA foreign_keys=ON——直接删已绑定
    # 服务者会抛 IntegrityError → 500。与 delete_product 的清理方式一致。
    conn.execute("DELETE FROM jz_sku_workers WHERE worker_id=?", (wid,))
    conn.execute("DELETE FROM jz_sku_slots WHERE worker_id=?", (wid,))
    conn.execute("DELETE FROM jz_workers WHERE id=?", (wid,))
    return {"ok": True}


# ====== SPU CRUD (P 端·平台标准品，操作 jz_skus) ======
# 语义：jz_skus = SPU（平台统一标准服务品）；jz_products = 商家 SKU（引用 SPU）。
_SPU_JSON_FIELDS = ("tags", "badges", "gallery", "includes", "service_flow", "service_notice")


def _spu_json(v):
    """接受 list 或逗号/换行分隔字符串，统一存 JSON 数组。"""
    if isinstance(v, str):
        v = [s.strip() for s in v.replace("\n", ",").split(",") if s.strip()]
    return json.dumps(v or [], ensure_ascii=False)


def list_skus_admin(conn):
    """SPU 全量列表（含下架），带类目名，用于 P 端管理台。"""
    rows = conn.execute(
        """SELECT s.*, c.name AS category_name, c.icon AS category_icon,
                  (SELECT COUNT(*) FROM jz_products p WHERE p.channel_sku_id=s.id) AS sku_count
           FROM jz_skus s LEFT JOIN jz_categories c ON c.id=s.category_id
           ORDER BY s.category_id, s.sort_order, s.id"""
    ).fetchall()
    out = []
    for r in rows:
        d = _row_to_dict(r)
        for k in _SPU_JSON_FIELDS:
            raw = d.get(k)
            if isinstance(raw, str):
                try:
                    d[k] = json.loads(raw) if raw else []
                except (ValueError, TypeError):
                    d[k] = []
            elif raw is None:
                d[k] = []
        out.append(d)
    return out


def create_sku(conn, data):
    """新增 SPU（平台标准品）。"""
    cur = conn.execute(
        """INSERT INTO jz_skus
           (category_id, name, slug, spec, price_from, price_unit, duration_min,
            tags, badges, sales_text, rating_score, worker_min_level,
            includes, service_flow, sort_order, enabled)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (data.get("category_id", "cleaning"),
         data.get("name", ""),
         data.get("slug", ""),
         data.get("spec", ""),
         int(data.get("price_from", 0) or 0),
         data.get("price_unit", "起"),
         int(data.get("duration_min", 0) or 0),
         _spu_json(data.get("tags", [])),
         _spu_json(data.get("badges", [])),
         data.get("sales_text", ""),
         float(data.get("rating_score", 0) or 0),
         data.get("worker_min_level", "L3"),
         _spu_json(data.get("includes", [])),
         _spu_json(data.get("service_flow", [])),
         int(data.get("sort_order", 99) or 99),
         1 if str(data.get("enabled", 1)) not in ("0", "false", "False", "") else 0),
    )
    return cur.lastrowid


def update_sku(conn, sku_id, data):
    """更新 SPU。"""
    fields = []
    params = []
    for k in ("category_id", "name", "slug", "spec", "price_from", "price_unit",
              "duration_min", "tags", "badges", "gallery", "sales_text", "rating_score",
              "worker_min_level", "includes", "service_flow", "service_notice",
              "cover_image", "sort_order", "enabled"):
        if k in data:
            v = data[k]
            if k in _SPU_JSON_FIELDS:
                v = _spu_json(v)
            elif k == "enabled":
                v = 1 if str(v) not in ("0", "false", "False", "") else 0
            fields.append(f"{k}=?")
            params.append(v)
    if not fields:
        return False
    params.append(sku_id)
    cur = conn.execute(f"UPDATE jz_skus SET {', '.join(fields)} WHERE id=?", params)
    return cur.rowcount > 0


def delete_sku(conn, sku_id):
    """删除 SPU（被商家 SKU 引用或有历史工单则禁止）。"""
    used = conn.execute(
        "SELECT COUNT(*) FROM jz_products WHERE channel_sku_id=?", (sku_id,)
    ).fetchone()[0]
    if used > 0:
        return {"ok": False, "error": f"该 SPU 已被 {used} 个商家 SKU 引用，无法删除"}
    ordered = conn.execute(
        "SELECT COUNT(*) FROM jz_orders WHERE sku_id=?", (sku_id,)
    ).fetchone()[0]
    if ordered > 0:
        return {"ok": False, "error": f"该 SPU 有 {ordered} 条历史工单，建议下架而非删除"}
    conn.execute("DELETE FROM jz_skus WHERE id=?", (sku_id,))
    return {"ok": True}


# ====== 排班档期 CRUD (jz_sku_slots) — SKU 的"时间"维度 ======
def _slot_row(r):
    d = _row_to_dict(r)
    if d:
        d["remaining"] = max(0, (d.get("capacity") or 0) - (d.get("booked") or 0))
    return d


def resolve_channel_sku_product_id(conn, sku_id, vendor_id=None):
    """给定 C 端 SKU(=SPU) id，取承接它的商家 SKU(product) id（评分优先，与详情页一致）。
    指定 vendor_id 则锁定该商家（多商家同款切换用）。"""
    row = conn.execute(
        """SELECT p.id FROM jz_products p JOIN jz_vendors v ON v.id=p.vendor_id
           WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'
           """ + ("AND p.vendor_id=? " if vendor_id else "") + """
           ORDER BY p.rating DESC, p.sales_count DESC, p.id LIMIT 1""",
        ((sku_id, vendor_id) if vendor_id else (sku_id,)),
    ).fetchone()
    return row[0] if row else None


ROLLING_SLOT_TIMES = [("09:00", "11:00"), ("14:00", "16:00"), ("19:00", "21:00")]


def ensure_rolling_slots(conn, product_id, days=5):
    """滚动排期：确保该商家 SKU 未来 days 天都有可约档期，随日期推进自动补齐。
    仅对已绑定服务者的 SKU 生成；已有该日期档期则跳过（幂等，读接口前调用）。"""
    from datetime import date, timedelta
    wids = [r[0] for r in conn.execute(
        "SELECT worker_id FROM jz_sku_workers WHERE product_id=?", (product_id,)
    ).fetchall()]
    if not wids:
        return 0
    today = date.today()
    made = 0
    for i in range(1, days + 1):
        d = (today + timedelta(days=i)).isoformat()
        if conn.execute(
            "SELECT 1 FROM jz_sku_slots WHERE product_id=? AND slot_date=? LIMIT 1",
            (product_id, d),
        ).fetchone():
            continue
        for wid in wids:
            for (st, et) in ROLLING_SLOT_TIMES:
                conn.execute(
                    """INSERT INTO jz_sku_slots(product_id, worker_id, slot_date, start_time, end_time, capacity, booked, status)
                       VALUES (?, ?, ?, ?, ?, 2, 0, 'open')""",
                    (product_id, wid, d, st, et),
                )
                made += 1
    if made:
        conn.commit()
    return made


def list_channel_sku_vendors(conn, sku_id, city_id=None):
    """某 SPU 下所有上架商家（多商家同款 / 比价用），按评分-销量排序。"""
    city_filter = ""
    city_params = []
    if city_id is not None:
        # 双维度过滤：商品 city_id 命中 且 商家 city_ids 声明服务该城（city_ids 为空视为全省可约）
        city_filter = (" AND (p.city_id=? OR p.city_id IS NULL) "
                       "AND (v.city_ids IS NULL OR TRIM(v.city_ids)='' "
                       "OR CONCAT(',', v.city_ids, ',') LIKE CONCAT('%,', ?, ',%'))")
        city_params = [int(city_id), str(city_id)]
    rows = conn.execute(
        """SELECT p.id AS product_id, p.price, p.original_price, p.discount_label,
                  p.rating AS product_rating, p.sales_count,
                  v.id AS vendor_id, v.name AS vendor_name, v.logo AS vendor_logo,
                  v.rating AS vendor_rating, v.review_count, v.rank_label, v.badges
           FROM jz_products p JOIN jz_vendors v ON v.id=p.vendor_id
           WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'
           """ + city_filter + """
           ORDER BY p.rating DESC, p.sales_count DESC, p.id""",
        (sku_id,) + tuple(city_params),
    ).fetchall()
    out, seen = [], set()
    for r in rows:
        d = dict(r)
        if d["vendor_id"] in seen:   # 一商家一行：同 vendor 多 product 取评分最高的
            continue
        seen.add(d["vendor_id"])
        d["auth_badges"] = _vendor_auth_badges({"badges": d.get("badges")})
        out.append(d)
    return out


def list_slots_by_product(conn, product_id):
    """某商家 SKU 的全部档期（B 端排班台），带服务者名。"""
    rows = conn.execute(
        """SELECT s.*, w.name AS worker_name, w.level AS worker_level, w.avatar AS worker_avatar
           FROM jz_sku_slots s LEFT JOIN jz_workers w ON w.id=s.worker_id
           WHERE s.product_id=? ORDER BY s.slot_date, s.start_time, s.id""",
        (product_id,),
    ).fetchall()
    return [_slot_row(r) for r in rows]


def list_available_slots_for_product(conn, product_id, from_date=None):
    """C 端可约档期：open 且未满且日期≥今天，带服务者名与剩余容量。"""
    if from_date is None:
        from datetime import date
        from_date = date.today().isoformat()
    rows = conn.execute(
        """SELECT s.*, w.name AS worker_name, w.level AS worker_level, w.avatar AS worker_avatar
           FROM jz_sku_slots s LEFT JOIN jz_workers w ON w.id=s.worker_id
           WHERE s.product_id=? AND s.status='open' AND s.booked < s.capacity
                 AND s.slot_date >= ?
           ORDER BY s.slot_date, s.start_time, s.id""",
        (product_id, from_date),
    ).fetchall()
    return [_slot_row(r) for r in rows]


def create_slot(conn, data):
    cur = conn.execute(
        """INSERT INTO jz_sku_slots(product_id, worker_id, slot_date, start_time, end_time, capacity, booked, status)
           VALUES (?,?,?,?,?,?,0,'open')""",
        (int(data["product_id"]),
         int(data["worker_id"]) if data.get("worker_id") else None,
         data.get("slot_date", ""),
         data.get("start_time", ""),
         data.get("end_time", ""),
         int(data.get("capacity", 1) or 1)),
    )
    return cur.lastrowid


def delete_slot(conn, slot_id):
    row = conn.execute("SELECT booked FROM jz_sku_slots WHERE id=?", (slot_id,)).fetchone()
    if row and (row[0] or 0) > 0:
        return {"ok": False, "error": "该档期已有预约，无法删除（可改为关闭）"}
    conn.execute("DELETE FROM jz_sku_slots WHERE id=?", (slot_id,))
    return {"ok": True}


def set_slot_status(conn, slot_id, status):
    """开/关档期：closed 的档期不再对 C 端开放。"""
    status = "closed" if status == "closed" else "open"
    cur = conn.execute("UPDATE jz_sku_slots SET status=? WHERE id=?", (status, slot_id))
    return {"ok": cur.rowcount > 0, "status": status}


def generate_slots(conn, product_id, worker_ids, dates, times, capacity=1):
    """批量生成档期：worker × date × time 笛卡尔积，跳过重复。"""
    n = 0
    workers = worker_ids or [None]
    for wid in workers:
        for d in dates:
            for t in times:
                start = t.get("start") if isinstance(t, dict) else t
                end = t.get("end") if isinstance(t, dict) else None
                dup = conn.execute(
                    """SELECT 1 FROM jz_sku_slots WHERE product_id=? AND slot_date=?
                       AND start_time=? AND IFNULL(worker_id,0)=IFNULL(?,0)""",
                    (product_id, d, start, wid),
                ).fetchone()
                if dup:
                    continue
                conn.execute(
                    """INSERT INTO jz_sku_slots(product_id, worker_id, slot_date, start_time, end_time, capacity, booked, status)
                       VALUES (?,?,?,?,?,?,0,'open')""",
                    (int(product_id), int(wid) if wid else None, d, start, end, int(capacity or 1)),
                )
                n += 1
    return n


def book_slot(conn, slot_id):
    """占用一个档期名额：未满则 booked+1，返回该档服务者信息。"""
    row = conn.execute(
        """SELECT s.*, w.name AS worker_name, w.level AS worker_level, w.avatar AS worker_avatar
           FROM jz_sku_slots s LEFT JOIN jz_workers w ON w.id=s.worker_id WHERE s.id=?""",
        (slot_id,),
    ).fetchone()
    if not row:
        return {"ok": False, "error": "档期不存在"}
    d = _row_to_dict(row)
    # 条件更新占名额：把「判满」和「+1」合成一条原子语句，避免先 SELECT 再 UPDATE 的
    # TOCTOU——并发/重试下两个请求都读到 booked<capacity 各自 +1 会超卖。rowcount==0
    # 即表示已满/已关，未占到名额。
    cur = conn.execute(
        "UPDATE jz_sku_slots SET booked = booked + 1 "
        "WHERE id=? AND status='open' AND booked < capacity",
        (slot_id,),
    )
    if cur.rowcount == 0:
        return {"ok": False, "error": "该档期已约满"}
    return {
        "ok": True,
        "worker_id": d.get("worker_id"),
        "worker": {"id": d.get("worker_id"), "name": d.get("worker_name"),
                   "level": d.get("worker_level"), "avatar": d.get("worker_avatar")} if d.get("worker_id") else None,
        "slot": {"date": d.get("slot_date"), "start": d.get("start_time"), "end": d.get("end_time")},
    }
