'use strict';

const { digest } = require('./primitives.cjs');
const { fail } = require('./vendor-payment.cjs');
const { normalizeOrder } = require('./jiazheng-adapter.cjs');

// The original API names sku_id as an alias for jz_products.id. A catalog SKU
// with the same number must never redirect this API request to another merchant.
async function createInput({ body, account, requestKey, legacyPath = false }, queryRows) {
  const productId = body.product_id || body.sku_id;
  if (body.vendor_id != null && body.vendor_id !== '' && productId) {
    const rows = await queryRows('SELECT vendor_id FROM jz_products WHERE id=?', [productId]);
    if (!rows[0] || String(rows[0].vendor_id) !== String(body.vendor_id)) throw fail('商品与所选商家不匹配', 409);
  }
  const fields = normalizeOrder({ productId, house: legacyPath ? body.address || body.house : body.house,
    phone: body.phone, expectTime: legacyPath ? body.scheduled_at || body.expectTime : body.expectTime,
    desc: legacyPath ? body.desc || body.product_title : body.desc, slotId: body.slot_id,
    priceMinor: body.price_minor, requestKey: requestKey || 'legacy-normalization' });
  // While an identical service order is open, an old client's retry reuses it.
  // After a terminal order, permit a new generation without using a time bucket
  // which could split an ordinary network retry into two purchases.
  // IDs are random and created_at has second precision. Counting terminal
  // orders advances once per order even when several finish in the same second;
  // a later done -> rated transition leaves the generation unchanged.
  const terminal = requestKey ? [] : await queryRows(`SELECT COUNT(*) AS generation FROM jz_orders WHERE account_id=? AND request_hash=?
    AND status IN ('cancelled','done','rated')`, [String(account.id), fields.requestHash]);
  return { ...fields, account,
    requestKey: requestKey || 'legacy-order:' + digest([String(account.id), fields.requestHash, String(terminal[0]?.generation || 0)]) };
}

async function pay({ core, adapter, queryRows, order, account, body, requestKey, clientIp, config = process.env }) {
  const legacy = !requestKey, cashierType = body.cashier_type || '2';
  if (legacy) {
    const [last] = await queryRows("SELECT COALESCE(MAX(id),0) id FROM payment_orders WHERE biz_type='jiazheng' AND biz_order_no=? AND pay_status='closed'", [order.id]);
    requestKey = 'legacy:' + digest([String(account.id), order.id, String(cashierType), String(last.id)]);
  }
  let result = await core.createIntent({ bizType: 'jiazheng', orderId: order.id, account, requestKey, cashierType, clientIp });
  const replay = result.idempotent_replay;
  if (legacy && result.payment_id) {
    const run = async (kind, enqueue = false) => {
      if (enqueue) await core.transaction(c => core.enqueueJob(c, kind, result.payment_id));
      await core.runJobs(1, { kind, targetId: result.payment_id });
      const waitMs = Number(config.PAY_COMPAT_WAIT_MS ?? 3000);
      const deadline = Date.now() + (Number.isFinite(waitMs) ? Math.min(10000, Math.max(0, waitMs)) : 3000);
      for (;;) {
        const [job] = await queryRows('SELECT status FROM payment_jobs WHERE job_key=?', [`${kind}:${result.payment_id}`]);
        if (job?.status !== 'running' || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    };
    await run('pay_create');
    // Supplied pay_method is only an old UI preference, never payment evidence.
    // A repeated old pay request can project an already-completed real payment.
    await run('pay_query', true);
    await core.consumeEvents('jiazheng', adapter.handleEvent, 25, { orderId: order.id });
    result = await core.getStatus({ bizType: 'jiazheng', orderId: order.id, accountId: String(account.id), refresh: false });
    result.idempotent_replay = replay;
  }
  return result;
}

module.exports = { createInput, pay };
