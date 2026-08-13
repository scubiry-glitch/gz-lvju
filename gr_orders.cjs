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
     LEFT JOIN jz_products p ON CAST(p.id AS CHAR) = o.sku
     LEFT JOIN jz_skus s ON s.id = p.channel_sku_id
     WHERE o.user_id = ? AND o.status != 'pending'
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ?`,
    [userId, lim]
  );
  return summarizeUserOrders(rows);
}

async function getUserOrder(conn, orderRef, userId) {
  const [rows] = await conn.execute(
    `SELECT o.*, p.title AS product_name, s.category_id AS category_id
     FROM gr_orders o
     LEFT JOIN jz_products p ON CAST(p.id AS CHAR) = o.sku
     LEFT JOIN jz_skus s ON s.id = p.channel_sku_id
     WHERE o.order_ref = ? AND o.user_id = ?
     LIMIT 1`,
    [orderRef, userId]
  );
  return rows[0] || null;
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
};
