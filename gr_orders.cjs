// gr_orders.cjs — GR 预约订单（C 端我的订单 + wechat-link 落单）
'use strict';

function pad2(n) { return String(n).padStart(2, '0'); }

function cstParts(d) {
  const cst = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return {
    y: cst.getUTCFullYear(),
    m: pad2(cst.getUTCMonth() + 1),
    day: pad2(cst.getUTCDate()),
    hh: pad2(cst.getUTCHours()),
    mm: pad2(cst.getUTCMinutes()),
    ss: pad2(cst.getUTCSeconds()),
  };
}

function makeOrderRef(now, rand) {
  const d = now || new Date();
  const p = cstParts(d);
  const stamp = String(p.y) + p.m + p.day + p.hh + p.mm + p.ss;
  const r = rand == null ? Math.floor(Math.random() * 10000) : rand;
  return 'GR' + stamp + String(r).padStart(4, '0');
}

async function generateOrderRef(conn) {
  for (let i = 0; i < 10; i++) {
    const ref = makeOrderRef();
    const [rows] = await conn.execute('SELECT 1 FROM gr_orders WHERE order_ref=? LIMIT 1', [ref]);
    if (!rows.length) return ref;
  }
  throw new Error('无法生成唯一 order_ref：重试次数已达上限');
}

function validateWechatLinkBody(body) {
  const productId = body && body.product_id;
  if (!productId) return { ok: false, error: '缺少 product_id 参数', status: 400 };
  const userId = String((body && body.user_id) || '').trim() || null;
  return { ok: true, productId, userId };
}

function validateUserIdQuery(raw) {
  const userId = String(raw || '').trim();
  if (!userId) return { ok: false, error: '缺少 user_id 参数', status: 400 };
  return { ok: true, userId };
}

function summarizeUserOrders(rows) {
  const list = (rows || []).filter((r) => r && r.status !== 'pending');
  const counts = { paid: 0, assigned: 0, serving: 0, completed: 0 };
  for (const it of list) {
    if (Object.prototype.hasOwnProperty.call(counts, it.status)) counts[it.status] += 1;
  }
  return { counts, list };
}

function normEtaPeking(eta) {
  if (!eta) return eta;
  const s = String(eta).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) return s;
  try {
    const iso = s.endsWith('Z') ? s.slice(0, -1) + '+00:00' : s;
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return s;
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) && !s.includes('T')) return s;
    const cst = new Date(dt.getTime() + 8 * 60 * 60 * 1000);
    const y = cst.getUTCFullYear();
    const m = pad2(cst.getUTCMonth() + 1);
    const d = pad2(cst.getUTCDate());
    const hh = pad2(cst.getUTCHours());
    const mm = pad2(cst.getUTCMinutes());
    const ss = pad2(cst.getUTCSeconds());
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
  } catch (_) {
    return s;
  }
}

async function createOrder(conn, orderRef, sku, opts) {
  const o = opts || {};
  const now = new Date();
  const p = cstParts(now);
  const ts = `${p.y}-${p.m}-${p.day} ${p.hh}:${p.mm}:${p.ss}`;
  await conn.execute(
    `INSERT INTO gr_orders(order_ref, vendor_id, user_id, sku, city, status, created_at)
     VALUES(?,?,?,?,?,'pending',?)`,
    [orderRef, o.vendor_id == null ? null : o.vendor_id, o.user_id || null, String(sku), o.city || '沈阳', ts]
  );
  return orderRef;
}

async function listUserOrders(conn, userId, limit) {
  const lim = Math.min(Math.max(parseInt(limit || '50', 10) || 50, 1), 200);
  const [rows] = await conn.execute(
    `SELECT o.*, p.title AS product_name, s.category_id AS category_id
     FROM gr_orders o
     LEFT JOIN jz_products p ON p.id = CAST(o.sku AS UNSIGNED)
     LEFT JOIN jz_skus s ON s.id = p.channel_sku_id
     WHERE BINARY o.user_id = BINARY ? AND o.status != 'pending'
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ${lim}`,
    [userId]
  );
  return summarizeUserOrders(rows);
}

async function getUserOrder(conn, orderRef, userId) {
  const [rows] = await conn.execute(
    `SELECT o.*, p.title AS product_name, s.category_id AS category_id
     FROM gr_orders o
     LEFT JOIN jz_products p ON p.id = CAST(o.sku AS UNSIGNED)
     LEFT JOIN jz_skus s ON s.id = p.channel_sku_id
     WHERE BINARY o.order_ref = BINARY ? AND BINARY o.user_id = BINARY ?
     LIMIT 1`,
    [orderRef, userId]
  );
  return rows[0] || null;
}

function nowCst() {
  const p = cstParts(new Date());
  return `${p.y}-${p.m}-${p.day} ${p.hh}:${p.mm}:${p.ss}`;
}

async function getOrderByRef(conn, orderRef) {
  const [rows] = await conn.execute('SELECT * FROM gr_orders WHERE order_ref=? LIMIT 1', [orderRef]);
  return rows[0] || null;
}

async function getOrderByRefAndVendor(conn, orderRef, vendorOid) {
  const [rows] = await conn.execute(
    'SELECT * FROM gr_orders WHERE order_ref=? AND vendor_oid=? LIMIT 1',
    [orderRef, vendorOid]
  );
  return rows[0] || null;
}

function validateCallbackBody(body) {
  const orderRef = String((body && body.order_ref) || '').trim();
  const vendorOid = String((body && (body.vendor_oid || body.lailai_oid)) || '').trim();
  const status = String((body && body.status) || '').trim();
  if (!orderRef) return { ok: false, status: 400, code: 400, message: '缺少 order_ref 参数' };
  if (!vendorOid) return { ok: false, status: 400, code: 400, message: '缺少 vendor_oid 参数' };
  if (!status) return { ok: false, status: 400, code: 400, message: '缺少 status 参数' };
  const fee = body.fee;
  if (status === 'paid' && (fee == null || fee === '')) {
    return { ok: false, status: 400, code: 400, message: 'paid 状态时必须提供 fee' };
  }
  const worker = (body && body.worker) || {};
  if (status === 'assigned') {
    if (!worker.name || !worker.phone || !worker.eta) {
      return { ok: false, status: 400, code: 400, message: 'assigned 状态时必须提供 worker (name/phone/eta)' };
    }
  }
  const cancelReason = body && body.cancel_reason;
  if (status === 'cancelled' && !cancelReason) {
    return { ok: false, status: 400, code: 400, message: 'cancelled 状态时必须提供 cancel_reason' };
  }
  return {
    ok: true,
    orderRef,
    vendorOid,
    status,
    fee,
    worker,
    cancelReason: status === 'cancelled' ? cancelReason : null,
  };
}

async function updateOrderCallback(conn, opts) {
  const o = opts || {};
  const now = nowCst();
  const vendorId = o.vendor_id == null ? null : o.vendor_id;
  if (o.status === 'paid') {
    await conn.execute(
      `UPDATE gr_orders
         SET vendor_id=COALESCE(?, vendor_id), vendor_oid=?, status=?, fee=?,
             paid_at=?, updated_at=?
       WHERE order_ref=?`,
      [vendorId, o.vendor_oid, o.status, o.fee, now, now, o.order_ref]
    );
  } else if (o.status === 'assigned') {
    await conn.execute(
      `UPDATE gr_orders
         SET vendor_id=COALESCE(?, vendor_id), vendor_oid=?, status=?,
             worker_name=?, worker_phone=?, eta=?, updated_at=?
       WHERE order_ref=? AND vendor_oid=?`,
      [vendorId, o.vendor_oid, o.status, o.worker_name, o.worker_phone, o.eta, now, o.order_ref, o.vendor_oid]
    );
  } else if (o.status === 'completed') {
    await conn.execute(
      `UPDATE gr_orders
         SET vendor_id=COALESCE(?, vendor_id), vendor_oid=?, status=?,
             completed_at=?, updated_at=?
       WHERE order_ref=? AND vendor_oid=?`,
      [vendorId, o.vendor_oid, o.status, now, now, o.order_ref, o.vendor_oid]
    );
  } else if (o.status === 'serving') {
    await conn.execute(
      `UPDATE gr_orders
         SET vendor_id=COALESCE(?, vendor_id), vendor_oid=?, status=?,
             serving_at=?, updated_at=?
       WHERE order_ref=? AND vendor_oid=?`,
      [vendorId, o.vendor_oid, o.status, now, now, o.order_ref, o.vendor_oid]
    );
  } else if (o.status === 'cancelled') {
    await conn.execute(
      `UPDATE gr_orders
         SET vendor_id=COALESCE(?, vendor_id), vendor_oid=?, status=?,
             cancel_reason=?, updated_at=?
       WHERE order_ref=? AND vendor_oid=?`,
      [vendorId, o.vendor_oid, o.status, o.cancel_reason, now, o.order_ref, o.vendor_oid]
    );
  } else {
    await conn.execute(
      `UPDATE gr_orders
         SET vendor_id=COALESCE(?, vendor_id), vendor_oid=?, status=?, updated_at=?
       WHERE order_ref=? AND vendor_oid=?`,
      [vendorId, o.vendor_oid, o.status, now, o.order_ref, o.vendor_oid]
    );
  }
  return true;
}

module.exports = {
  makeOrderRef,
  generateOrderRef,
  validateWechatLinkBody,
  validateUserIdQuery,
  summarizeUserOrders,
  normEtaPeking,
  createOrder,
  listUserOrders,
  getUserOrder,
  getOrderByRef,
  getOrderByRefAndVendor,
  validateCallbackBody,
  updateOrderCallback,
};
