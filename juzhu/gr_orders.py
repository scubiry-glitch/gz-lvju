"""GR 侧预约订单模块
- order_ref 生成与防碰撞
- gr_orders 表的读写操作
"""
import random
from datetime import datetime


def generate_order_ref(conn):
    """生成唯一 order_ref：GR + YYYYMMDDHHmmss + 4位随机数。
    查重后若冲突则重新生成，最多重试 10 次。
    """
    max_retries = 10
    for _ in range(max_retries):
        now = datetime.now()
        stamp = now.strftime("%Y%m%d%H%M%S")
        rand = str(random.randint(0, 9999)).zfill(4)
        ref = f"GR{stamp}{rand}"

        row = conn.execute(
            "SELECT 1 FROM gr_orders WHERE order_ref = ?", (ref,)
        ).fetchone()
        if not row:
            return ref

    raise RuntimeError("无法生成唯一 order_ref：重试次数已达上限")


def create_order(conn, order_ref, sku, city="沈阳", vendor_id=None, user_id=None):
    """创建一条 gr_orders 记录。
    vendor_oid / fee / worker_name / worker_phone / eta / cancel_reason 留空。
    返回 order_ref。
    """
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        """INSERT INTO gr_orders
           (order_ref, vendor_id, user_id, sku, city, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)""",
        (order_ref, vendor_id, user_id, sku, city, now),
    )
    conn.commit()
    return order_ref


def get_order_by_ref(conn, order_ref):
    """按 order_ref 查询订单。"""
    row = conn.execute(
        "SELECT * FROM gr_orders WHERE order_ref = ?", (order_ref,)
    ).fetchone()
    if row is None:
        return None
    return dict(row)


def get_order_by_ref_and_vendor(conn, order_ref, vendor_oid):
    """按 order_ref + vendor_oid 联合查询订单。"""
    row = conn.execute(
        "SELECT * FROM gr_orders WHERE order_ref = ? AND vendor_oid = ?",
        (order_ref, vendor_oid),
    ).fetchone()
    if row is None:
        return None
    return dict(row)


def update_order_callback(conn, order_ref, vendor_oid, status,
                           fee=None, worker_name=None, worker_phone=None,
                           eta=None, cancel_reason=None, vendor_id=None):
    """回调更新 gr_orders 订单信息。

    - paid 时写入 vendor_id / vendor_oid / status / fee / paid_at
    - 其他状态更新 vendor_id / status 及对应字段
    - vendor_id 传入 None 时保留原值（COALESCE 兜底）
    """
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if status == "paid":
        conn.execute(
            """UPDATE gr_orders
               SET vendor_id = COALESCE(?, vendor_id), vendor_oid = ?, status = ?, fee = ?,
                   paid_at = ?, updated_at = ?
               WHERE order_ref = ?""",
            (vendor_id, vendor_oid, status, fee, now, now, order_ref),
        )
    elif status == "assigned":
        conn.execute(
            """UPDATE gr_orders
               SET vendor_id = COALESCE(?, vendor_id), vendor_oid = ?, status = ?,
                   worker_name = ?, worker_phone = ?, eta = ?,
                   updated_at = ?
               WHERE order_ref = ? AND vendor_oid = ?""",
            (vendor_id, vendor_oid, status, worker_name, worker_phone, eta,
             now, order_ref, vendor_oid),
        )
    elif status == "completed":
        conn.execute(
            """UPDATE gr_orders
               SET vendor_id = COALESCE(?, vendor_id), vendor_oid = ?, status = ?,
                   completed_at = ?, updated_at = ?
               WHERE order_ref = ? AND vendor_oid = ?""",
            (vendor_id, vendor_oid, status, now, now, order_ref, vendor_oid),
        )
    elif status == "serving":
        conn.execute(
            """UPDATE gr_orders
               SET vendor_id = COALESCE(?, vendor_id), vendor_oid = ?, status = ?,
                   serving_at = ?, updated_at = ?
               WHERE order_ref = ? AND vendor_oid = ?""",
            (vendor_id, vendor_oid, status, now, now, order_ref, vendor_oid),
        )
    elif status == "cancelled":
        conn.execute(
            """UPDATE gr_orders
               SET vendor_id = COALESCE(?, vendor_id), vendor_oid = ?, status = ?,
                   cancel_reason = ?, updated_at = ?
               WHERE order_ref = ? AND vendor_oid = ?""",
            (vendor_id, vendor_oid, status, cancel_reason, now, order_ref, vendor_oid),
        )
    else:
        # 其他状态：仅更新 status
        conn.execute(
            """UPDATE gr_orders
               SET vendor_id = COALESCE(?, vendor_id), vendor_oid = ?, status = ?, updated_at = ?
               WHERE order_ref = ? AND vendor_oid = ?""",
            (vendor_id, vendor_oid, status, now, order_ref, vendor_oid),
        )

    conn.commit()
    return True


# 我的订单（C 端）可见状态：pending 属未支付阶段，不对用户展示
USER_VISIBLE_STATUSES = ("paid", "assigned", "serving", "completed", "cancelled")


def list_user_orders(conn, user_id, limit=50):
    """按用户列出订单（过滤 pending），附带 4 状态计数与服务名/类目（join 产品与 SPU）。"""
    rows = conn.execute(
        """SELECT o.*, p.title AS product_name, s.category_id AS category_id
           FROM gr_orders o
           LEFT JOIN jz_products p ON CAST(p.id AS CHAR) = o.sku
           LEFT JOIN jz_skus s ON s.id = p.channel_sku_id
           WHERE o.user_id = ? AND o.status != 'pending'
           ORDER BY o.created_at DESC, o.id DESC
           LIMIT ?""",
        (user_id, limit),
    ).fetchall()
    items = [dict(r) for r in rows]
    counts = {"paid": 0, "assigned": 0, "serving": 0, "completed": 0}
    for it in items:
        if it.get("status") in counts:
            counts[it["status"]] += 1
    return {"counts": counts, "list": items}


def get_user_order(conn, order_ref, user_id):
    """按 order_ref + user_id 查单（防串单），join 产品名/类目。"""
    row = conn.execute(
        """SELECT o.*, p.title AS product_name, s.category_id AS category_id
           FROM gr_orders o
           LEFT JOIN jz_products p ON CAST(p.id AS CHAR) = o.sku
           LEFT JOIN jz_skus s ON s.id = p.channel_sku_id
           WHERE o.order_ref = ? AND o.user_id = ?""",
        (order_ref, user_id),
    ).fetchone()
    return dict(row) if row else None
