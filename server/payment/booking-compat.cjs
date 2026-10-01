'use strict';

const { assert, digest, sqlDate, toAmount, generateAppOrderId } = require('./primitives.cjs');

// Preserve the original lodging service contract while all money operations
// continue through the same durable jobs, guard and outbox as new clients.
function createBookingCompatibility({ core, bookingAdapter, config = process.env }) {
  const rows = (sql, args = []) => core.transaction(async c => (await c.execute(sql, args))[0]);
  const consume = orderNo => core.consumeEvents('booking', bookingAdapter.handleEvent, 25, { orderId: orderNo });
  const paymentById = async id => {
    const [p] = await rows("SELECT * FROM payment_orders WHERE id=? AND biz_type='booking'", [id]);
    assert(p, '住宿支付记录不存在', 404); return p;
  };
  async function prepare(input) {
    if (input.account) {
      await bookingAdapter.status({ ...input, refresh: false });
    } else {
      // Only internal callers may omit the account. HTTP routes authenticate
      // and always supply it before entering this compatibility facade.
      for (let attempt = 0; ; attempt++) {
        try { await core.transaction(c => bookingAdapter.prepare(c, input.orderNo)); break; }
        catch (error) {
          if (!['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code) || attempt >= 4) throw error;
        }
      }
    }
    const [g] = await rows("SELECT * FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=?", [input.orderNo]);
    return g;
  }
  const status = (orderNo, accountId) => core.getStatus({ bizType: 'booking', orderId: orderNo, accountId, refresh: false });
  async function runTarget(kind, targetId, enqueue = false) {
    if (enqueue) await core.transaction(c => core.enqueueJob(c, kind, targetId));
    return core.runJobs(1, { kind, targetId });
  }
  async function waitTarget(kind, targetId) {
    // Another worker may hold the lease. Wait briefly for its persisted result,
    // never make an extra direct gateway call or steal an unexpired lease.
    const configuredWait = Number(config.PAY_COMPAT_WAIT_MS ?? 3000);
    const deadline = Date.now() + (Number.isFinite(configuredWait) ? Math.min(10000, Math.max(0, configuredWait)) : 3000);
    for (;;) {
      const [job] = await rows('SELECT status FROM payment_jobs WHERE job_key=?', [`${kind}:${targetId}`]);
      if (job?.status !== 'running' || Date.now() >= deadline) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  function paymentResult(out) {
    const orderStatus = ['paid', 'partially_refunded', 'refunded'].includes(out.order_pay_status) ? '30'
      : out.order_pay_status === 'closed' || out.pay_status === 'closed' ? '40' : '10';
    return { ...out, appOrderId: out.app_order_id, orderStatus, status: orderStatus,
      amount: toAmount(out.amount_minor), cashierUrl: out.cashier_url };
  }
  async function createOrReusePayment(input) {
    assert(input.account?.id, '仅贝壳登录用户可发起在线支付', 401);
    const g = await prepare(input);
    let key = input.requestKey;
    if (!key) {
      const [last] = await rows("SELECT COALESCE(MAX(id),0) id FROM payment_orders WHERE biz_type='booking' AND biz_order_no=? AND pay_status='closed'", [input.orderNo]);
      // Old clients have no request key. Concurrent/repeated clicks on the same
      // confirmed generation converge; an uncertain payment never advances it.
      key = 'legacy:' + digest([String(input.account.id), input.orderNo, String(input.cashierType), String(last.id)]);
    }
    let out = await bookingAdapter.intent({ ...input, requestKey: key });
    const replay = out.idempotent_replay;
    if (out.payment_id && !input.requestKey) {
      await runTarget('pay_create', out.payment_id);
      await waitTarget('pay_create', out.payment_id);
      await consume(input.orderNo);
      out = await status(input.orderNo, g.account_id);
      // Original React result pages poll only while the business projection is
      // paying. Guard-first locking prevents overwriting an accepted/refunded order.
      await core.transaction(async c => {
        const [guards] = await c.execute("SELECT * FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=? FOR UPDATE", [input.orderNo]);
        if (guards[0]?.lifecycle === 'open' && guards[0].active_payment_id && !guards[0].paid_payment_id)
          await c.execute("UPDATE booking_orders SET pay_status='paying',updated_at=? WHERE order_no=? AND status='pending' AND pay_status='unpaid'", [sqlDate(), input.orderNo]);
      });
    }
    return { ...out, idempotent_replay: replay, reused: replay, orderNo: input.orderNo,
      paymentId: out.payment_id, appOrderId: out.app_order_id,
      payStatus: out.pay_status, cashierUrl: out.cashier_url };
  }
  async function queryPayment(input) {
    const g = await prepare(input);
    let p;
    if (input.appOrderId) {
      [p] = await rows("SELECT * FROM payment_orders WHERE biz_type='booking' AND biz_order_no=? AND app_order_id=?", [input.orderNo, input.appOrderId]);
      assert(p, '支付记录不属于此预订订单', 404);
    } else {
      [p] = await rows("SELECT * FROM payment_orders WHERE biz_type='booking' AND biz_order_no=? ORDER BY id DESC LIMIT 1", [input.orderNo]);
    }
    if (p && p.pay_status !== 'paid') {
      await runTarget('pay_query', p.id, true); await waitTarget('pay_query', p.id);
    }
    await consume(input.orderNo);
    const out = await status(input.orderNo, g.account_id);
    const current = p ? await paymentById(p.id) : null;
    const data = paymentResult(out);
    if (current) {
      // An explicit historical appOrderId queries that attempt. Keep its IDs,
      // status and provider reference together; aggregate business state remains
      // available in the separate status object and order_pay_status field.
      data.payment_id = current.id; data.app_order_id = data.appOrderId = current.app_order_id;
      data.pay_status = current.pay_status; data.cashier_type = current.cashier_type;
      data.orderStatus = data.status = current.pay_status === 'paid' ? '30'
        : current.pay_status === 'closed' ? '40' : current.gateway_order_status || '10';
      if (String(current.id) !== String(out.payment_id)) {
        data.cashier_url = data.cashierUrl = null; data.next_action = 'none';
      }
    }
    return { errno: 0, data: { ...data, payMethod: current?.pay_method || null,
      pay_method: current?.pay_method || null, payNo: current?.pay_no || null, pay_no: current?.pay_no || null }, status: out };
  }
  async function refundById(id) {
    const [r] = await rows("SELECT * FROM payment_refunds WHERE id=? AND biz_type='booking'", [id]);
    assert(r, '住宿退款记录不存在', 404); return r;
  }
  function refundResult(r) {
    const code = r.refund_status === 'refunded' ? '30' : '10';
    return { errno: 0, data: { appOrderId: r.app_order_id, orderStatus: code, status: code,
      refundAmount: r.refund_amount, refund_status: r.refund_status } };
  }
  async function createOrReuseRefund(paymentOrderId, reason = 'booking_cancel', source = 'user') {
    const p = await paymentById(paymentOrderId);
    await prepare({ orderNo: p.biz_order_no });
    const requestKey = reason === 'booking_cancel' ? `booking_cancel:${p.biz_order_no}` : `${reason}:${p.id}`;
    const out = await core.requestRefund({ bizType: 'booking', orderId: p.biz_order_no, paymentId: p.id,
      amountMinor: Number((await paymentById(p.id)).amount_minor), requestKey, reason, source });
    const refund = await refundById(out.id);
    await core.transaction(async c => {
      const [guards] = await c.execute("SELECT * FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=? FOR UPDATE", [p.biz_order_no]);
      if (String(guards[0]?.paid_payment_id) === String(p.id) && refund.refund_status !== 'refunded')
        await c.execute("UPDATE booking_orders SET latest_refund_id=?,refund_status='refunding',pay_status='refunding',updated_at=? WHERE order_no=? AND pay_status<>'refunded'", [refund.id, sqlDate(), p.biz_order_no]);
    });
    return { refund, payment: await paymentById(p.id) };
  }
  async function requestRefund(refund, payment) {
    const r = await refundById(refund.id);
    assert(payment && String(r.payment_order_id) === String(payment.id), '退款原支付不匹配', 409);
    await prepare({ orderNo: r.biz_order_no });
    // Registration of an old refund schedules query only. Never enqueue a
    // creation over that record: the original request may already have succeeded.
    await runTarget('refund_create', r.id); await waitTarget('refund_create', r.id);
    return refundResult(await refundById(r.id));
  }
  async function queryRefund(refund) {
    const r = await refundById(refund.id);
    await prepare({ orderNo: r.biz_order_no });
    if (r.refund_status !== 'refunded') {
      await runTarget('refund_query', r.id, true); await waitTarget('refund_query', r.id);
    }
    await consume(r.biz_order_no);
    return refundResult(await refundById(r.id));
  }
  async function closePaymentByOrder(orderNo, reason = 'booking_expired') {
    const payments = await rows("SELECT * FROM payment_orders WHERE biz_type='booking' AND biz_order_no=? ORDER BY id DESC", [orderNo]);
    if (!payments.length) return { skipped: true, payment: undefined };
    const g = await prepare({ orderNo });
    if (g.paid_payment_id) return { skipped: true, payment: await paymentById(g.paid_payment_id) };
    await core.requestClose({ bizType: 'booking', orderId: orderNo, reason, reopen: false });
    const unresolved = payments.filter(p => !['paid', 'closed'].includes(p.pay_status));
    for (const p of unresolved) { await runTarget('pay_close', p.id); await waitTarget('pay_close', p.id); }
    await consume(orderNo);
    const out = await status(orderNo, g.account_id);
    const current = await paymentById(out.payment_id || payments[0].id);
    const closed = out.order_pay_status === 'closed';
    return { skipped: !closed || !unresolved.length, pending: !closed && !['paid', 'refunded'].includes(out.order_pay_status),
      payment: current, result: { errno: 0, data: paymentResult(out) } };
  }
  async function handleNotify(body) {
    if (body && typeof body.appOrderId === 'string') {
      const [p] = await rows(`SELECT p.* FROM payment_orders p LEFT JOIN payment_refunds r ON r.payment_order_id=p.id
        WHERE p.biz_type='booking' AND (p.app_order_id=? OR r.app_order_id=?) LIMIT 1`, [body.appOrderId, body.appOrderId]);
      if (p) await prepare({ orderNo: p.biz_order_no });
    }
    return core.handleNotify(body);
  }
  async function advancePaymentState(payment, _result, _source) {
    const p = await paymentById(payment.id);
    // Legacy callers can still ask to advance, but supplied callbacks never
    // constitute payment evidence. Query the bound original payment instead.
    await queryPayment({ orderNo: p.biz_order_no, appOrderId: p.app_order_id });
    const current = await paymentById(p.id);
    return { state: current.pay_status, changed: current.pay_status !== p.pay_status };
  }
  async function advanceRefundState(refund, _result, _source) {
    const r = await refundById(refund.id);
    await queryRefund(r);
    const current = await refundById(r.id);
    return { state: current.refund_status, changed: current.refund_status !== r.refund_status };
  }
  async function runPaymentCompensation(limit = 50) {
    await bookingAdapter.recoverLegacy(limit);
    const result = await core.runJobs(limit);
    await core.consumeEvents('booking', bookingAdapter.handleEvent, limit);
    const [counts] = await rows("SELECT SUM(kind LIKE 'pay_%' AND status='pending') payments,SUM(kind LIKE 'refund_%' AND status='pending') refunds FROM payment_jobs");
    return { ...result, payments: Number(counts.payments || 0), refunds: Number(counts.refunds || 0) };
  }
  return { createOrReusePayment, queryPayment, createOrReuseRefund, requestRefund, queryRefund,
    closePaymentByOrder, handleNotify, advancePaymentState, advanceRefundState, runPaymentCompensation, generateAppOrderId };
}

module.exports = { createBookingCompatibility };
