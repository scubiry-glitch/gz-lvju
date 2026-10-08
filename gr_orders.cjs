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
  const list = (rows || []).filter((r) => r && (r.status !== 'pending' || r.payment_mode === 'pay_center'));
  const counts = { pending: 0, paid: 0, assigned: 0, serving: 0, completed: 0 };
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
    `INSERT INTO gr_orders(order_ref,vendor_id,user_id,sku,city,status,created_at,biz_type,payment_mode,order_snapshot,request_key,request_hash)
     VALUES(?,?,?,?,?,'pending',?,'jiazheng','wechat_mini',?,?,?)`,
    [orderRef, o.vendor_id == null ? null : o.vendor_id, o.user_id || null, String(sku), o.city || '', ts,
      JSON.stringify(o.snapshot || {}), o.request_key || null, o.request_hash || null]
  );
  return orderRef;
}

async function listUserOrders(conn, userId, limit, pageValue, status='') {
  const userIds = Array.isArray(userId) ? userId.map(String) : [String(userId)];
  if (!userIds.length || userIds.length > 2 || userIds.some(id => !id)) throw new Error('订单身份无效');
  const lim = Math.min(Math.max(parseInt(limit || '50', 10) || 50, 1), 200);
  const page = Math.min(Math.max(parseInt(pageValue || '1', 10) || 1, 1), 100000);
  const allowedStatus = ['', 'pending', 'paid', 'assigned', 'serving', 'completed', 'cancelled'];
  if (!allowedStatus.includes(status)) throw new Error('订单状态无效');
  const ownerWhere = `BINARY o.user_id IN (${userIds.map(() => '?').join(',')}) AND (o.status != 'pending' OR o.payment_mode='pay_center')`;
  const [totals] = await conn.execute(`SELECT o.status,COUNT(*) n FROM gr_orders o WHERE ${ownerWhere} GROUP BY o.status`, userIds);
  const counts = { pending: 0, paid: 0, assigned: 0, serving: 0, completed: 0 };
  let allTotal = 0;
  for (const item of totals) { const n=Number(item.n);allTotal+=n;if(Object.hasOwn(counts,item.status))counts[item.status]=n; }
  const total = status ? Number(totals.find(item=>item.status===status)?.n||0) : allTotal;
  const [rows] = await conn.execute(
    `SELECT o.*, p.title AS product_name, s.category_id AS category_id
     FROM gr_orders o
     LEFT JOIN jz_products p ON p.id = CAST(o.sku AS UNSIGNED)
     LEFT JOIN jz_skus s ON s.id = p.channel_sku_id
     WHERE ${ownerWhere}${status?' AND o.status=?':''}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ${lim} OFFSET ${(page-1)*lim}`,
    status?[...userIds,status]:userIds
  );
  const result=summarizeUserOrders(await enrichCustomerOrders(conn, rows));
  return {...result,counts,total,page,size:lim,has_more:page*lim<total};
}

async function getUserOrder(conn, orderRef, userId) {
  const userIds = Array.isArray(userId) ? userId.map(String) : [String(userId)];
  if (!userIds.length || userIds.length > 2 || userIds.some(id => !id)) throw new Error('订单身份无效');
  const [rows] = await conn.execute(
    `SELECT o.*, p.title AS product_name, s.category_id AS category_id
     FROM gr_orders o
     LEFT JOIN jz_products p ON p.id = CAST(o.sku AS UNSIGNED)
     LEFT JOIN jz_skus s ON s.id = p.channel_sku_id
     WHERE BINARY o.order_ref = BINARY ? AND BINARY o.user_id IN (${userIds.map(() => '?').join(',')})
     LIMIT 1`,
    [orderRef, ...userIds]
  );
  return (await enrichCustomerOrders(conn, rows))[0] || null;
}

async function enrichCustomerOrders(conn, rows) {
  const enriched = await require('./commerce/main-system.cjs').enrichOrders(conn, rows);
  const internal = enriched.filter(o => o.biz_type === 'jiazheng' && o.payment_mode === 'pay_center');
  const map = new Map();
  if (internal.length) {
    const [orders] = await conn.execute('SELECT * FROM jz_orders WHERE id IN (' + internal.map(() => '?').join(',') + ')', internal.map(o => o.order_ref));
    for (const order of orders) map.set(order.id, order);
  }
  return enriched.map(original => {
    const out = { ...original }, order = map.get(out.order_ref);
    if (order && out.user_id === 'commerce-account-' + order.account_id) {
      let snapshot = {}; try { snapshot = JSON.parse(order.payment_config_snapshot || '{}'); } catch (_) {}
      out.product_name = snapshot.productTitle || out.product_name;
      out.category_id = order.category_id; out.pay_status = order.pay_status;
      out.refund_status = order.refund_status; out.is_internal_service = true;
      out.status = order.status === 'cancelled' ? 'cancelled' : ['done', 'rated'].includes(order.status) ? 'completed'
        : order.status === 'serving' ? 'serving' : ['dispatched', 'accepted'].includes(order.status) ? 'assigned'
        : order.pay_status === 'paid' ? 'paid' : 'pending';
      out.paid_at = order.pay_at; out.fee = order.fee; out.expect_time = order.expect_time;
      out.can_cancel = order.status === 'pending' && !order.refund_status && order.pay_status !== 'closing';
      out.cancel_policy = snapshot.cancelPolicy;
    }
    delete out.order_snapshot; delete out.request_key; delete out.request_hash;
    return out;
  });
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

// 商家跳过 paid 回调直接推 assigned/serving/... 时，pending 单的 vendor_oid 还是 NULL，
// 联合查询落空。此处按 order_ref + vendor_id 归属回填 vendor_oid（仅命中 NULL 行，不覆盖已有值），
// 使后续状态推进按正常链路命中。
async function backfillVendorOid(conn, orderRef, vendorOid, vendorId) {
  const [ret] = await conn.execute(
    'UPDATE gr_orders SET vendor_oid=?, updated_at=? WHERE order_ref=? AND vendor_id=? AND vendor_oid IS NULL',
    [vendorOid, nowCst(), orderRef, vendorId]
  );
  return ret.affectedRows > 0;
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
  const order = await getOrderByRef(conn, o.order_ref);
  if (!require('./server/payment/vendor-payment.cjs').isExternalOrder(order) || String(order.vendor_id) !== String(vendorId)) {
    const error = new Error('回调不能修改其他商家或中台订单'); error.status = 403; throw error;
  }
  if (o.status === 'paid') {
    await conn.execute(
      `UPDATE gr_orders
         SET vendor_id=COALESCE(?, vendor_id), vendor_oid=?, status=?, fee=?,
             paid_at=?, updated_at=?
       WHERE order_ref=?`,
      [vendorId, o.vendor_oid, o.status, o.fee, now, now, o.order_ref]
    );
  } else if (o.status === 'assigned') {
    // 重新派单（含 serving 回退 assigned）：清空 serving_at，避免状态已回退但时间轴仍残留旧的服务开始时间
    await conn.execute(
      `UPDATE gr_orders
         SET vendor_id=COALESCE(?, vendor_id), vendor_oid=?, status=?,
             worker_name=?, worker_phone=?, eta=?, serving_at=NULL, updated_at=?
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
  backfillVendorOid,
  validateCallbackBody,
  updateOrderCallback,
};
