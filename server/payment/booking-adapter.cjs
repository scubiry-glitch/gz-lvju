'use strict';

const stay = require('../../stay_config.cjs');
const { assert, toMinor, sqlDate, expired, normalizeBizOrderNo } = require('./primitives.cjs');

function createBookingPaymentAdapter({ core, createConnection, config = process.env, notifyVendorBooking,
  releaseStayQty = stay.releaseStayQty, orderCancelInfoOf = stay.orderCancelInfoOf }) {
  assert(core && typeof createConnection === 'function', '住宿支付适配器缺少依赖', 500);
  let expiryCursor = 0, recoveryCursor = 0;

  // Rotate past unresolved rows; one old configuration conflict must not starve
  // all later expirations or legacy recovery. Restarting from zero is harmless.
  async function scan(sql, cursor, limit) {
    const conn = await createConnection();
    const size = Math.trunc(Math.max(1, Math.min(Number(limit) || 100, 100)));
    try {
      let [rows] = await conn.execute(`${sql} ORDER BY b.id LIMIT ${size}`, [cursor]);
      if (!rows.length && cursor) [rows] = await conn.execute(`${sql} ORDER BY b.id LIMIT ${size}`, [0]);
      return rows;
    } finally { await conn.end(); }
  }

  async function transaction(fn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const conn = await createConnection();
      try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
      } catch (error) {
        await conn.rollback();
        if (!['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code) || attempt === 4) throw error;
      } finally { await conn.end(); }
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }

  async function load(conn, orderNo, lock = false) {
    normalizeBizOrderNo('booking', orderNo);
    const [rows] = await conn.execute('SELECT * FROM booking_orders WHERE order_no=?' + (lock ? ' FOR UPDATE' : ''), [orderNo]);
    assert(rows[0], '预订订单不存在', 404, 'order_not_found');
    return rows[0];
  }

  function assertOwner(order, input) {
    if (input.source === 'vendor') {
      assert(input.vendorId && String(order.owner_vendor_id) === String(input.vendorId), '无权操作此商家订单', 403);
    } else if (input.source !== 'system') {
      assert(input.account && String(input.account.id) === String(order.user_id), '无权操作此订单', 403);
      if (input.contactPhone) assert(String(input.contactPhone) === String(order.contact_phone), '订单手机号不匹配', 404);
    }
  }

  async function prepare(conn, booking, account) {
    const orderNo = typeof booking === 'string' ? booking : booking.order_no;
    normalizeBizOrderNo('booking', orderNo);
    const [existing] = await conn.execute("SELECT * FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=?", [orderNo]);
    if (existing[0]) {
      const [guards] = await conn.execute("SELECT * FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=? FOR UPDATE", [orderNo]);
      return guards[0];
    }
    // First registration also locks the business row. This serializes legacy
    // no-attempt expiry with registration without fabricating a payer snapshot.
    const order = await load(conn, orderNo, true);
    const [raced] = await conn.execute("SELECT * FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=? FOR UPDATE", [orderNo]);
    if (raced[0]) return raced[0];
    assert(order.pay_status != null, '此预订单采用线下收款，不进入在线收银台', 409, 'payment_not_required');
    const [previous] = await conn.execute("SELECT * FROM payment_orders WHERE biz_type='booking' AND biz_order_no=? ORDER BY id", [orderNo]);
    assert(!['paid','refunding','refunded','partially_refunded'].includes(order.pay_status) || order.paid_payment_order_id,
      '历史付款缺少有效支付引用，需要核对原订单', 409, 'payment_migration_conflict');
    const active = previous.filter(payment => ['creating','paying','create_unknown','closing','close_unknown','pay_failed'].includes(payment.pay_status));
    const legacy = previous.find(payment => String(payment.id) === String(order.paid_payment_order_id))
      || active[active.length - 1] || previous[previous.length - 1];
    // Existing attempts belong to their original payer even if an account's
    // identity binding changes later. Query/close/refund must retain that snapshot.
    // Creating a fresh attempt still checks the current identity in the core.
    let payerUcid = legacy && legacy.payer_ucid;
    if (!legacy) {
      const [payers] = account ? [[account]] : await conn.execute('SELECT id,idp_type,idp_subject FROM accounts WHERE id=?', [order.user_id]);
      const payer = payers[0];
      assert(payer && String(payer.id) === String(order.user_id) && payer.idp_type === 'beike' && payer.idp_subject,
        '在线支付需要订单所属贝壳账号', 403, 'beike_identity_required');
      payerUcid = payer.idp_subject;
    }
    const [vendors] = legacy ? [[]] : await conn.execute('SELECT pay_merchant_no FROM jz_vendors WHERE id=?', [order.owner_vendor_id]);
    const merchantNo = legacy && legacy.merchant_no || vendors[0] && vendors[0].pay_merchant_no;
    assert(merchantNo, '商家尚未配置收款商户号', 409, 'merchant_not_ready');
    const expiresAt = order.payment_expires_at || legacy && (legacy.expires_at ||
      (order.paid_payment_order_id && (legacy.paid_at || legacy.created_at)));
    assert(expiresAt, '预订缺少付款期限，需要核对原订单', 409, 'migration_conflict');
    return core.registerOrder(conn, {
      bizType: 'booking', orderId: order.order_no, accountId: String(order.user_id),
      amountMinor: toMinor(order.price_total), merchantNo,
      payerUcid, payerUserType: legacy && legacy.payer_user_type || config.PAY_USER_TYPE || '2',
      appCode: legacy && legacy.app_code || undefined, projectCode: legacy && legacy.project_code || undefined,
      shareBizCode: legacy && legacy.share_biz_code || undefined, callbackUrl: legacy && legacy.callback_url || undefined,
      expiresAt: sqlDate(expiresAt), title: '住宿预订 ' + order.order_no,
      configVersion: 1, snapshot: { projectId: order.project_id, unitId: order.unit_id, vendorId: order.owner_vendor_id,
        checkin: order.checkin, checkout: order.checkout, rooms: order.rooms },
      legacyPaidPaymentId: order.paid_payment_order_id || null,
      requireAuthoritativePaid: true,
      legacyFulfilled: Boolean(order.paid_payment_order_id),
      legacyLifecycle: order.status === 'cancelled' || expired(expiresAt) ? 'closed' : 'open',
    });
  }

  async function prepareOwned(input, forIntent = false) {
    return transaction(async (conn) => {
      const order = await load(conn, input.orderNo);
      assertOwner(order, input);
      if (forIntent) assert(order.status === 'pending' || order.paid_payment_order_id,
        '订单已取消或已完结，无法创建支付', 409, 'booking_not_payable');
      return prepare(conn, order, input.account);
    });
  }

  async function intent(input) {
    await prepareOwned(input, true);
    return core.createIntent({ bizType: 'booking', orderId: input.orderNo, account: input.account,
      requestKey: input.requestKey, cashierType: input.cashierType, clientIp: input.clientIp });
  }

  async function status(input) {
    await prepareOwned(input);
    return core.getStatus({ bizType: 'booking', orderId: input.orderNo, accountId: input.account && input.account.id,
      refresh: input.refresh !== false });
  }

  async function unitFor(conn, order) {
    const [rows] = await conn.execute(order.unit_id
      ? 'SELECT ext FROM units WHERE id=? AND project_id=?'
      : 'SELECT ext FROM units WHERE project_id=? ORDER BY sort_order,id LIMIT 1',
    order.unit_id ? [order.unit_id, order.project_id] : [order.project_id]);
    return rows[0] || null;
  }

  async function release(conn, order) {
    await releaseStayQty(async (sql, values) => (await conn.execute(sql, values))[0], {
      project_id: order.project_id, unit_id: order.unit_id, rooms: order.rooms,
      checkin: order.checkin, checkout: order.checkout, now: sqlDate(),
    });
  }

  async function cancel(input) {
    return transaction(async (conn) => {
      const initial = await load(conn, input.orderNo);
      assertOwner(initial, input);
      if (initial.status === 'cancelled') return { ok: true, order_no: initial.order_no, status: initial.status,
        pay_status: initial.pay_status, idempotent_replay: true };
      const guard = initial.pay_status == null ? null : await prepare(conn, initial, input.account);
      const order = await load(conn, input.orderNo, true);
      assertOwner(order, input);
      if (order.status === 'cancelled') return { ok: true, order_no: order.order_no, status: order.status,
        pay_status: order.pay_status, idempotent_replay: true };
      if (!['vendor', 'system'].includes(input.source)) {
        assert(order.status === 'pending', '仅待确认订单可由用户取消');
        const info = orderCancelInfoOf(await unitFor(conn, order), order);
        assert(info.can_cancel, info.cancel_deadline ? '已超过免费取消截止时间' : '该订单未开通免费取消', 409, 'cancel_not_allowed');
      }
      if (!guard) {
        await conn.execute("UPDATE booking_orders SET status='cancelled',updated_at=? WHERE id=?", [sqlDate(), order.id]);
        await release(conn, order);
        return { ok: true, order_no: order.order_no, status: 'cancelled', pay_status: null };
      }
      if (guard.paid_payment_id) {
        const requestKey = 'booking_cancel:' + order.order_no;
        await core.requestRefund({ bizType: 'booking', orderId: order.order_no, paymentId: guard.paid_payment_id,
          amountMinor: Number(guard.amount_minor), requestKey, reason: 'booking_cancel', source: input.source || 'user',
          reference: { orderNo: order.order_no } }, conn);
        await conn.execute("UPDATE booking_orders SET status='cancelled',pay_status='refunding',refund_status='refunding',updated_at=? WHERE id=?", [sqlDate(), order.id]);
        await release(conn, order);
        return { ok: true, order_no: order.order_no, status: 'cancelled', pay_status: 'refunding', pending: true };
      }
      await core.requestClose({ bizType: 'booking', orderId: order.order_no, reason: input.reason || 'booking_cancel', reopen: false }, conn);
      await conn.execute("UPDATE booking_orders SET pay_status='closing',updated_at=? WHERE id=? AND status<>'cancelled'", [sqlDate(), order.id]);
      return { ok: true, order_no: order.order_no, status: order.status, pay_status: 'closing', pending: true };
    });
  }

  async function confirm(input) {
    return transaction(async (conn) => {
      const initial = await load(conn, input.orderNo);
      assertOwner(initial, input);
      const guard = initial.pay_status == null ? null : await prepare(conn, initial);
      const order = await load(conn, input.orderNo, true);
      assertOwner(order, input);
      assert(order.status !== 'cancelled', '订单已取消，不可确认');
      if (guard) assert(guard.lifecycle === 'paid' && guard.paid_payment_id && order.pay_status === 'paid',
        '支付尚未确认完成，不可确认预订', 409, 'payment_not_confirmed');
      await conn.execute("UPDATE booking_orders SET status='confirmed',updated_at=? WHERE id=?", [sqlDate(), order.id]);
      return { ok: true, order_no: order.order_no, status: 'confirmed' };
    });
  }

  async function expire(limit = 100) {
    const rows = await scan(`SELECT b.id,b.order_no FROM booking_orders b WHERE b.id>? AND b.status='pending'
      AND b.pay_status IS NOT NULL AND b.paid_payment_order_id IS NULL
      AND b.payment_expires_at IS NOT NULL AND b.payment_expires_at<=UTC_TIMESTAMP()`, expiryCursor, limit);
    expiryCursor = rows.length ? rows[rows.length - 1].id : 0;
    let requested = 0;
    const errors = [];
    for (const row of rows) {
      try {
        requested += await transaction(async c => {
          const initial = await load(c, row.order_no);
          const [registered] = await c.execute("SELECT biz_order_no FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=?", [row.order_no]);
          if (!registered.length && initial.pay_status === 'unpaid') {
            const untouched = await load(c, row.order_no, true);
            const [guards] = await c.execute("SELECT biz_order_no FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=?", [row.order_no]);
            const [attempts] = await c.execute("SELECT id FROM payment_orders WHERE biz_type='booking' AND biz_order_no=? LIMIT 1", [row.order_no]);
            if (!guards.length && !attempts.length && untouched.status === 'pending' && untouched.pay_status === 'unpaid'
              && untouched.payment_expires_at && expired(untouched.payment_expires_at)) {
              await c.execute("UPDATE booking_orders SET status='cancelled',pay_status='expired',updated_at=? WHERE id=?", [sqlDate(), untouched.id]);
              await release(c, untouched);
              return 1;
            }
          }
          const guard = await prepare(c, initial);
          const order = await load(c, row.order_no, true);
          if (guard.paid_payment_id || order.status !== 'pending') return 0;
          await core.requestClose({ bizType: 'booking', orderId: order.order_no, reason: 'booking_expired', reopen: false }, c);
          await c.execute("UPDATE booking_orders SET pay_status='closing',updated_at=? WHERE id=?", [sqlDate(), order.id]);
          return 1;
        });
      } catch (error) { errors.push({ orderNo: row.order_no, code: error.code || 'booking_expiry_error' }); }
    }
    return { scanned: rows.length, requested, errors };
  }

  async function recoverLegacy(limit = 100) {
    const rows = await scan(`SELECT b.id,b.order_no FROM booking_orders b
        WHERE b.id>? AND EXISTS(SELECT 1 FROM payment_orders p WHERE p.biz_type='booking' AND p.biz_order_no=b.order_no
          AND p.pay_status IN ('creating','paying','create_unknown','closing','close_unknown','pay_failed','paid'))
        AND NOT EXISTS(SELECT 1 FROM payment_order_guards g WHERE g.biz_type='booking' AND g.biz_order_no=b.order_no)`, recoveryCursor, limit);
    recoveryCursor = rows.length ? rows[rows.length - 1].id : 0;
    let recovered = 0;
    const errors = [];
    for (const row of rows) {
      try { await transaction(c => prepare(c, row.order_no)); recovered++; }
      catch (error) { errors.push({ orderNo: row.order_no, code: error.code || 'booking_recovery_error' }); }
    }
    return { scanned: rows.length, recovered, errors };
  }

  async function handleEvent(conn, event, guard) {
    const order = await load(conn, event.biz_order_no, true);
    const payload = event.payload || {};
    if (event.event_type === 'payment.accepted') {
      assert(Number(guard.paid_payment_id) === Number(payload.paymentId), '有效支付关联不一致', 409, 'payment_mismatch');
      // Cancellation can win after acceptance but before this event is consumed.
      if (order.status === 'cancelled') return;
      const [payments] = await conn.execute('SELECT pay_method,paid_at FROM payment_orders WHERE id=?', [payload.paymentId]);
      await conn.execute("UPDATE booking_orders SET paid_payment_order_id=?,pay_status='paid',pay_method=?,pay_at=?,updated_at=? WHERE id=?",
        [payload.paymentId, payments[0] && payments[0].pay_method || null, payments[0] && payments[0].paid_at || sqlDate(), sqlDate(), order.id]);
      if (order.owner_vendor_id) await core.enqueueJob(conn, 'booking_webhook', payload.paymentId, {
        vendorId: order.owner_vendor_id, event: 'booking.paid', order: {
          id: order.id, order_no: order.order_no, project_id: order.project_id, unit_id: order.unit_id,
          checkin: order.checkin, checkout: order.checkout, nights: order.nights, rooms: order.rooms,
          price_total: order.price_total, status: order.status, pay_status: 'paid', payment_id: payload.paymentId,
        },
      });
    }
    if (event.event_type === 'order.closed') {
      if (guard.paid_payment_id || order.status === 'cancelled') return;
      const payStatus = /expir/.test(String(payload.reason || '')) ? 'expired' : 'closed';
      await conn.execute("UPDATE booking_orders SET status='cancelled',pay_status=?,updated_at=? WHERE id=?", [payStatus, sqlDate(), order.id]);
      await release(conn, order);
    }
    if (event.event_type === 'refund.succeeded' && Number(guard.paid_payment_id) === Number(payload.paymentId)) {
      const [[sum]] = await conn.execute("SELECT COALESCE(SUM(amount_minor),0) AS total FROM payment_refunds WHERE payment_order_id=? AND refund_status='refunded'", [payload.paymentId]);
      const refunded = Number(sum.total) >= Number(guard.amount_minor);
      await conn.execute('UPDATE booking_orders SET refund_status=?,pay_status=?,latest_refund_id=?,refunded_at=?,updated_at=? WHERE id=?',
        [refunded ? 'refunded' : 'partially_refunded', refunded ? 'refunded' : 'partially_refunded', payload.refundId,
          refunded ? sqlDate() : null, sqlDate(), order.id]);
    }
  }

  return { prepare, intent, status, cancel, confirm, expire, recoverLegacy, handleEvent };
}

module.exports = { createBookingPaymentAdapter };
