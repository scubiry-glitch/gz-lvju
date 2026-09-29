'use strict';

const crypto = require('crypto');

function sqlNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function toAmount(value) {
  const cents = Math.round(Number(value) * 100);
  if (!Number.isFinite(cents) || cents <= 0) throw new Error('支付金额不合法');
  return (cents / 100).toFixed(2);
}

function generateAppOrderId(prefix, now = new Date()) {
  const timestamp = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\D/g, '')
    .slice(0, 14);
  return `${prefix}_${timestamp}_${String(crypto.randomInt(0, 1000000)).padStart(6, '0')}`;
}

function notificationKey(body) {
  const fields = [
    body.appCode, body.projectCode, body.appOrderId,
    body.orderId, body.orderStatus, body.tradeTime,
  ];
  return crypto.createHash('sha256').update(fields.map((v) => String(v || '')).join('|')).digest('hex');
}

function parseStatus(data) {
  return String(
    (data && (data.orderStatus || data.status || data.refundStatus || data.payStatus)) || '',
  );
}

function createPaymentService(options) {
  const {
    createConnection,
    payCenter,
    config = process.env,
    notifyVendorBooking,
    logger = console,
  } = options || {};
  if (typeof createConnection !== 'function') throw new Error('payment_service 需要 createConnection');
  if (!payCenter) throw new Error('payment_service 需要 payCenter');

  const cfg = {
    appCode: config.PAY_APP_CODE,
    projectCode: config.PAY_PROJECT_CODE,
    shareBizCode: config.PAY_SHARE_BIZ_CODE,
    notifyUrl: config.PAY_NOTIFY_URL,
    userType: config.PAY_USER_TYPE || '2',
  };

  function assertConfig() {
    const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`支付配置缺失：${missing.join(', ')}`);
  }

  async function insertGatewayLog(conn, values) {
    const now = sqlNow();
    await conn.execute(
      `INSERT INTO payment_gateway_logs(
        payment_order_id,payment_refund_id,app_order_id,operation_type,request_no,
        http_status,business_code,trace_id,success_flag,request_json,response_json,
        error_message,started_at,finished_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        values.paymentOrderId || null, values.paymentRefundId || null, values.appOrderId,
        values.operation, values.requestNo, values.httpStatus || null, values.businessCode || null,
        values.traceId || null, values.success ? 1 : 0, values.requestJson || null,
        values.responseJson || null, values.errorMessage || null, values.startedAt || now, now,
      ],
    );
  }

  async function logGateway(values) {
    const conn = await createConnection();
    try {
      await insertGatewayLog(conn, values);
    } finally {
      await conn.end();
    }
  }

  function buildPaymentPayload(payment, booking, clientIp) {
    const amount = toAmount(payment.amount);
    const expireSeconds = Math.max(
      60,
      Math.floor((new Date(String(booking.payment_expires_at).replace(' ', 'T') + 'Z').getTime() - Date.now()) / 1000),
    );
    return {
      amount,
      appCode: cfg.appCode,
      projectCode: cfg.projectCode,
      shareBizCode: payment.share_biz_code,
      appOrderId: payment.app_order_id,
      appOrderName: `旅居预订 ${booking.order_no}`,
      payChannel: {
        cashierType: payment.cashier_type,
        shareBizCode: payment.share_biz_code,
        tradeInfo: { tradeName: `旅居预订 ${booking.order_no}`, tradeDesc: `旅居民宿预订` },
      },
      callBackInfo: { callbackUrl: payment.callback_url },
      recAndShareInfo: {
        merchantNo: payment.merchant_no,
        shareOrderMode: '0',
        shareOrderInfos: [{
          merchantNo: payment.merchant_no,
          amount,
          shareBizCode: payment.share_biz_code,
        }],
      },
      payOrderInfo: { note: booking.order_no, expireTime: expireSeconds },
      contractInfo: { contractNo: booking.order_no, contractAmount: amount },
      appClientInfo: {
        appType: payment.cashier_type === '1' ? 1 : 2,
        appClientIp: clientIp || '127.0.0.1',
      },
      userInfo: { ucid: payment.payer_ucid, userType: payment.payer_user_type },
    };
  }

  async function createOrReusePayment(input) {
    assertConfig();
    const { orderNo, contactPhone, account, cashierType, clientIp } = input;
    if (!['1', '2'].includes(String(cashierType))) throw new Error('cashier_type 仅支持 1 或 2');
    if (!account || !account.id || account.idp_type !== 'beike' || !account.idp_subject) {
      throw new Error('仅贝壳登录用户可发起在线支付');
    }

    let prepared;
    const conn = await createConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        `SELECT * FROM booking_orders WHERE order_no=? AND contact_phone=? LIMIT 1 FOR UPDATE`,
        [orderNo, contactPhone],
      );
      const booking = rows[0];
      if (!booking) throw new Error('订单不存在或手机号不匹配');
      if (String(booking.user_id || '') !== String(account.id)) throw new Error('无权支付该订单');
      if (booking.status !== 'pending') throw new Error('订单已取消或已完结，无法支付');
      if (booking.payment_expires_at && new Date(String(booking.payment_expires_at).replace(' ', 'T') + 'Z').getTime() <= Date.now()) {
        throw new Error('待支付订单已过期');
      }
      if (booking.paid_payment_order_id) {
        await conn.commit();
        return { reused: true, orderNo, payStatus: 'paid' };
      }

      const [latestRows] = await conn.execute(
        `SELECT * FROM payment_orders WHERE biz_order_no=? ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [booking.order_no],
      );
      const latest = latestRows[0];
      if (latest && ['creating', 'create_unknown', 'paying'].includes(latest.pay_status)) {
        await conn.commit();
        return {
          reused: true, orderNo, paymentId: latest.id, appOrderId: latest.app_order_id,
          payStatus: latest.pay_status, cashierUrl: latest.cashier_url,
        };
      }
      if (latest && ['closing', 'close_unknown'].includes(latest.pay_status)) {
        throw new Error('上一次支付单关闭处理中，请稍后重试');
      }

      const [vendors] = await conn.execute(
        `SELECT pay_merchant_no FROM jz_vendors WHERE id=? LIMIT 1`,
        [booking.owner_vendor_id],
      );
      const merchantNo = vendors[0] && vendors[0].pay_merchant_no;
      if (!merchantNo) throw new Error('商家未配置收款商户号');

      const appOrderId = generateAppOrderId('XD');
      const now = sqlNow();
      const [insert] = await conn.execute(
        `INSERT INTO payment_orders(
          biz_order_no,app_order_id,amount,payer_ucid,payer_user_type,merchant_no,
          share_biz_code,cashier_type,pay_status,callback_url,query_retry_count,
          next_query_at,version,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          booking.order_no, appOrderId, toAmount(booking.price_total), account.idp_subject,
          cfg.userType, merchantNo, cfg.shareBizCode, String(cashierType), 'creating',
          cfg.notifyUrl, 0, now, 0, now, now,
        ],
      );
      await conn.execute(
        `UPDATE booking_orders SET pay_status='paying', updated_at=? WHERE id=?`,
        [now, booking.id],
      );
      await conn.commit();
      prepared = {
        booking,
        payment: {
          id: insert.insertId, app_order_id: appOrderId, amount: toAmount(booking.price_total),
          payer_ucid: account.idp_subject, payer_user_type: cfg.userType, merchant_no: merchantNo,
          share_biz_code: cfg.shareBizCode, cashier_type: String(cashierType), callback_url: cfg.notifyUrl,
        },
      };
    } catch (error) {
      try { await conn.rollback(); } catch (_) {}
      throw error;
    } finally {
      await conn.end();
    }

    const request = buildPaymentPayload(prepared.payment, prepared.booking, clientIp);
    const requestNo = crypto.randomUUID();
    try {
      const result = await payCenter.createC2BOrder(request);
      await logGateway({
        paymentOrderId: prepared.payment.id, appOrderId: prepared.payment.app_order_id,
        operation: 'pay_create', requestNo, success: true,
        businessCode: result.errno, traceId: result.traceId,
        requestJson: JSON.stringify(request), responseJson: JSON.stringify(result),
      });
      const data = result.data || {};
      const cashierUrl = data.cashierUrl || data.cashier_url || data.url || data.redirectUrl || null;
      const cashierExpiresAt = data.expireTime || data.cashierExpiresAt || null;
      const updateConn = await createConnection();
      try {
        await updateConn.execute(
          `UPDATE payment_orders SET pay_status='paying', cashier_url=?, cashier_expires_at=?,
            next_query_at=?, updated_at=?, version=version+1 WHERE id=? AND pay_status='creating'`,
          [cashierUrl, cashierExpiresAt, sqlNow(), sqlNow(), prepared.payment.id],
        );
      } finally {
        await updateConn.end();
      }
      return {
        reused: false, orderNo: prepared.booking.order_no, paymentId: prepared.payment.id,
        appOrderId: prepared.payment.app_order_id, payStatus: 'paying', cashierUrl,
      };
    } catch (error) {
      await logGateway({
        paymentOrderId: prepared.payment.id, appOrderId: prepared.payment.app_order_id,
        operation: 'pay_create', requestNo, success: false,
        businessCode: error.errno, traceId: error.traceId, requestJson: JSON.stringify(request),
        responseJson: error.payResult ? JSON.stringify(error.payResult) : null,
        errorMessage: String(error.message || error).slice(0, 500),
      });
      const updateConn = await createConnection();
      try {
        await updateConn.execute(
          `UPDATE payment_orders SET pay_status='create_unknown', query_retry_count=query_retry_count+1,
            next_query_at=?, updated_at=?, version=version+1 WHERE id=? AND pay_status='creating'`,
          [sqlNow(), sqlNow(), prepared.payment.id],
        );
      } finally {
        await updateConn.end();
      }
      throw error;
    }
  }

  async function loadPaymentByOrder(orderNo, appOrderId) {
    const conn = await createConnection();
    try {
      const [rows] = await conn.execute(
        appOrderId
          ? `SELECT * FROM payment_orders WHERE biz_order_no=? AND app_order_id=? LIMIT 1`
          : `SELECT * FROM payment_orders WHERE biz_order_no=? ORDER BY id DESC LIMIT 1`,
        appOrderId ? [orderNo, appOrderId] : [orderNo],
      );
      return rows[0] || null;
    } finally {
      await conn.end();
    }
  }

  async function advancePaymentState(payment, result, source) {
    const data = result.data || result;
    const status = parseStatus(data);
    if (!status) return { state: payment.pay_status, changed: false };
    const conn = await createConnection();
    let notify = null;
    const automaticRefunds = [];
    try {
      await conn.beginTransaction();
      const [payments] = await conn.execute(`SELECT * FROM payment_orders WHERE id=? FOR UPDATE`, [payment.id]);
      const current = payments[0];
      if (!current) throw new Error('支付记录不存在');
      const [bookings] = await conn.execute(`SELECT * FROM booking_orders WHERE order_no=? FOR UPDATE`, [current.biz_order_no]);
      const booking = bookings[0];
      if (!booking) throw new Error('业务订单不存在');
      const now = sqlNow();
      if (status === '30') {
        await conn.execute(
          `UPDATE payment_orders SET pay_status='paid', gateway_order_status=?, pay_method=?,
            pay_no=?, paid_at=?, next_query_at=NULL, updated_at=?, version=version+1 WHERE id=?`,
          [status, data.payMethod || data.pay_method || null, data.payNo || data.pay_no || null, now, now, current.id],
        );
        if (!booking.paid_payment_order_id && booking.status === 'pending') {
          await conn.execute(
            `UPDATE booking_orders SET paid_payment_order_id=?, pay_status='paid', pay_method=?,
              pay_at=?, updated_at=? WHERE id=?`,
            [current.id, data.payMethod || data.pay_method || null, now, now, booking.id],
          );
          await conn.execute(
            `UPDATE payment_orders SET pay_status='closing', close_reason='another_payment_succeeded',
              updated_at=? WHERE biz_order_no=? AND id<>? AND pay_status IN ('creating','create_unknown','paying')`,
            [now, current.biz_order_no, current.id],
          );
          notify = booking;
        } else if (booking.status !== 'pending') {
          automaticRefunds.push({
            refund: await createOrReuseRefundInTransaction(conn, current, 'late_pay', 'system'),
            payment: current,
          });
        } else if (Number(booking.paid_payment_order_id) !== Number(current.id)) {
          automaticRefunds.push({
            refund: await createOrReuseRefundInTransaction(conn, current, 'duplicate_pay', 'system'),
            payment: current,
          });
        }
      } else if (status === '40' && current.pay_status !== 'paid') {
        await conn.execute(
          `UPDATE payment_orders SET pay_status='pay_failed', gateway_order_status=?, next_query_at=NULL,
            updated_at=?, version=version+1 WHERE id=?`,
          [status, now, current.id],
        );
        if (!booking.paid_payment_order_id) {
          await conn.execute(`UPDATE booking_orders SET pay_status='unpaid', updated_at=? WHERE id=?`, [now, booking.id]);
        }
      }
      await conn.commit();
    } catch (error) {
      try { await conn.rollback(); } catch (_) {}
      throw error;
    } finally {
      await conn.end();
    }
    if (notify && typeof notifyVendorBooking === 'function') {
      notifyVendorBooking(notify.owner_vendor_id, 'booking.paid', notify);
    }
    for (const item of automaticRefunds) {
      try {
        await requestRefund(item.refund, item.payment);
      } catch (error) {
        logger.warn('automatic payment refund request failed:', error.message);
      }
    }
    return { state: status === '30' ? 'paid' : status === '40' ? 'pay_failed' : payment.pay_status, source };
  }

  async function queryPayment(input) {
    assertConfig();
    const payment = await loadPaymentByOrder(input.orderNo, input.appOrderId);
    if (!payment) throw new Error('支付记录不存在');
    const request = { appCode: cfg.appCode, projectCode: cfg.projectCode, appOrderId: payment.app_order_id };
    const requestNo = crypto.randomUUID();
    try {
      const result = await payCenter.queryOrder(request);
      await logGateway({
        paymentOrderId: payment.id, appOrderId: payment.app_order_id, operation: 'pay_query',
        requestNo, success: true, businessCode: result.errno, traceId: result.traceId,
        requestJson: JSON.stringify(request), responseJson: JSON.stringify(result),
      });
      await advancePaymentState(payment, result, 'query');
      return result;
    } catch (error) {
      await logGateway({
        paymentOrderId: payment.id, appOrderId: payment.app_order_id, operation: 'pay_query',
        requestNo, success: false, businessCode: error.errno, traceId: error.traceId,
        requestJson: JSON.stringify(request), responseJson: error.payResult ? JSON.stringify(error.payResult) : null,
        errorMessage: String(error.message || error).slice(0, 500),
      });
      throw error;
    }
  }

  async function createOrReuseRefundInTransaction(conn, payment, reason, source) {
    const idempotencyKey = reason === 'booking_cancel'
      ? `booking_cancel:${payment.biz_order_no}`
      : `${reason}:${payment.id}`;
    const [existing] = await conn.execute(
      `SELECT * FROM payment_refunds WHERE idempotency_key=? LIMIT 1 FOR UPDATE`,
      [idempotencyKey],
    );
    if (existing[0]) return existing[0];
    const now = sqlNow();
    const appOrderId = generateAppOrderId('RF');
    const [insert] = await conn.execute(
      `INSERT INTO payment_refunds(
        payment_order_id,biz_order_no,app_order_id,idempotency_key,refund_reason_type,
        trigger_source,refund_amount,payer_ucid,merchant_no,refund_status,retry_count,
        next_retry_at,version,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        payment.id, payment.biz_order_no, appOrderId, idempotencyKey, reason, source,
        toAmount(payment.amount), payment.payer_ucid, payment.merchant_no, 'refunding',
        0, now, 0, now, now,
      ],
    );
    return { id: insert.insertId, payment_order_id: payment.id, biz_order_no: payment.biz_order_no, app_order_id: appOrderId,
      refund_amount: toAmount(payment.amount), payer_ucid: payment.payer_ucid, merchant_no: payment.merchant_no, refund_status: 'refunding' };
  }

  async function createOrReuseRefund(paymentOrderId, reason = 'booking_cancel', source = 'user') {
    const conn = await createConnection();
    let refund;
    let payment;
    try {
      await conn.beginTransaction();
      const [payments] = await conn.execute(`SELECT * FROM payment_orders WHERE id=? FOR UPDATE`, [paymentOrderId]);
      payment = payments[0];
      if (!payment || payment.pay_status !== 'paid') throw new Error('原支付记录未成功，不能退款');
      refund = await createOrReuseRefundInTransaction(conn, payment, reason, source);
      await conn.execute(
        `UPDATE booking_orders SET latest_refund_id=?, refund_status='refunding', pay_status='refunding',
          updated_at=? WHERE order_no=?`,
        [refund.id, sqlNow(), payment.biz_order_no],
      );
      await conn.commit();
    } catch (error) {
      try { await conn.rollback(); } catch (_) {}
      throw error;
    } finally {
      await conn.end();
    }
    return { refund, payment };
  }

  async function requestRefund(refund, payment) {
    const request = {
      appCode: cfg.appCode, projectCode: cfg.projectCode, appOrderId: refund.app_order_id,
      businessOrderNo: payment.app_order_id, refundAmount: toAmount(refund.refund_amount),
      callbackUrl: cfg.notifyUrl, ucid: refund.payer_ucid, userType: payment.payer_user_type,
      shareOrderInfos: [{ merchantNo: refund.merchant_no, shareBizCode: payment.share_biz_code, amount: toAmount(refund.refund_amount) }],
    };
    const requestNo = crypto.randomUUID();
    try {
      const result = await payCenter.refundOrder(request);
      await logGateway({
        paymentRefundId: refund.id, appOrderId: refund.app_order_id, operation: 'refund_create',
        requestNo, success: true, businessCode: result.errno, traceId: result.traceId,
        requestJson: JSON.stringify(request), responseJson: JSON.stringify(result),
      });
      return result;
    } catch (error) {
      await logGateway({
        paymentRefundId: refund.id, appOrderId: refund.app_order_id, operation: 'refund_create',
        requestNo, success: false, businessCode: error.errno, traceId: error.traceId,
        requestJson: JSON.stringify(request), responseJson: error.payResult ? JSON.stringify(error.payResult) : null,
        errorMessage: String(error.message || error).slice(0, 500),
      });
      throw error;
    }
  }

  async function queryRefund(refund) {
    assertConfig();
    const request = {
      appCode: cfg.appCode,
      projectCode: cfg.projectCode,
      businessOrderNo: refund.app_order_id,
    };
    const requestNo = crypto.randomUUID();
    try {
      const result = await payCenter.queryRefundOrder(request);
      await logGateway({
        paymentRefundId: refund.id, appOrderId: refund.app_order_id, operation: 'refund_query',
        requestNo, success: true, businessCode: result.errno, traceId: result.traceId,
        requestJson: JSON.stringify(request), responseJson: JSON.stringify(result),
      });
      await advanceRefundState(refund, result, 'query');
      return result;
    } catch (error) {
      await logGateway({
        paymentRefundId: refund.id, appOrderId: refund.app_order_id, operation: 'refund_query',
        requestNo, success: false, businessCode: error.errno, traceId: error.traceId,
        requestJson: JSON.stringify(request), responseJson: error.payResult ? JSON.stringify(error.payResult) : null,
        errorMessage: String(error.message || error).slice(0, 500),
      });
      throw error;
    }
  }

  /* 补偿查单最多 10 次，整个窗口总时长不超过 30 分钟；首次在 1 分钟后触发。
     10 次延迟在「首项 60s」与「末项 x」之间等差，使总和 = 30 分钟：
     10 * (60 + x) / 2 = 1800 → x = 300s；即 60s 起每次 +26.7s，第 10 次 300s。
     retryCount >= 10 返回 null，写入 next_query_at=NULL，该记录退出补偿队列。 */
  const MAX_QUERY_RETRIES = 10;
  const FIRST_QUERY_DELAY_SECONDS = 60;
  const TOTAL_QUERY_WINDOW_SECONDS = 30 * 60;
  const LAST_QUERY_DELAY_SECONDS =
    (TOTAL_QUERY_WINDOW_SECONDS * 2) / MAX_QUERY_RETRIES - FIRST_QUERY_DELAY_SECONDS;

  function nextRetryAt(retryCount) {
    const n = Math.max(Number(retryCount) || 0, 0);
    if (n >= MAX_QUERY_RETRIES) return null;
    const step = Math.round(
      FIRST_QUERY_DELAY_SECONDS
      + n * (LAST_QUERY_DELAY_SECONDS - FIRST_QUERY_DELAY_SECONDS) / (MAX_QUERY_RETRIES - 1),
    );
    return new Date(Date.now() + step * 1000).toISOString().slice(0, 19).replace('T', ' ');
  }

  async function runPaymentCompensation(limit = 50) {
    const conn = await createConnection();
    let payments = [];
    let refunds = [];
    try {
      [payments] = await conn.execute(
        `SELECT * FROM payment_orders
         WHERE pay_status IN ('create_unknown','paying','close_unknown')
           AND next_query_at IS NOT NULL AND next_query_at<=UTC_TIMESTAMP()
         ORDER BY id LIMIT ?`,
        [Math.min(Math.max(Number(limit) || 50, 1), 100)],
      );
      [refunds] = await conn.execute(
        `SELECT * FROM payment_refunds
         WHERE refund_status IN ('refunding','refund_failed','manual_review')
           AND next_retry_at IS NOT NULL AND next_retry_at<=UTC_TIMESTAMP()
         ORDER BY id LIMIT ?`,
        [Math.min(Math.max(Number(limit) || 50, 1), 100)],
      );
    } finally {
      await conn.end();
    }
    for (const payment of payments) {
      try {
        await queryPayment({ orderNo: payment.biz_order_no, appOrderId: payment.app_order_id });
      } catch (error) {
        const retryConn = await createConnection();
        try {
          const retries = Number(payment.query_retry_count || 0) + 1;
          await retryConn.execute(
            `UPDATE payment_orders SET query_retry_count=?, next_query_at=?, updated_at=? WHERE id=?`,
            [retries, nextRetryAt(retries), sqlNow(), payment.id],
          );
        } finally { await retryConn.end(); }
      }
    }
    for (const refund of refunds) {
      try {
        await queryRefund(refund);
      } catch (error) {
        const retryConn = await createConnection();
        try {
          const retries = Number(refund.retry_count || 0) + 1;
          await retryConn.execute(
            `UPDATE payment_refunds SET retry_count=?, next_retry_at=?, updated_at=? WHERE id=?`,
            [retries, nextRetryAt(retries), sqlNow(), refund.id],
          );
        } finally { await retryConn.end(); }
      }
    }
    return { payments: payments.length, refunds: refunds.length };
  }

  async function advanceRefundState(refund, result, source) {
    const data = result.data || result;
    const status = parseStatus(data);
    if (!status) return { state: refund.refund_status, changed: false };
    const conn = await createConnection();
    try {
      await conn.beginTransaction();
      const [refundRows] = await conn.execute(`SELECT * FROM payment_refunds WHERE id=? FOR UPDATE`, [refund.id]);
      const current = refundRows[0];
      if (!current) throw new Error('退款记录不存在');
      const [payments] = await conn.execute(`SELECT * FROM payment_orders WHERE id=? FOR UPDATE`, [current.payment_order_id]);
      const payment = payments[0];
      const [bookings] = await conn.execute(`SELECT * FROM booking_orders WHERE order_no=? FOR UPDATE`, [current.biz_order_no]);
      const booking = bookings[0];
      const now = sqlNow();
      if (status === '30') {
        await conn.execute(
          `UPDATE payment_refunds SET refund_status='refunded', refunded_at=?, next_retry_at=NULL,
            updated_at=?, version=version+1 WHERE id=?`,
          [now, now, current.id],
        );
        if (booking && Number(booking.paid_payment_order_id) === Number(payment && payment.id)
          && current.refund_reason_type === 'booking_cancel') {
          await conn.execute(
            `UPDATE booking_orders SET pay_status='refunded', refund_status='refunded', refunded_at=?,
              latest_refund_id=?, updated_at=? WHERE id=?`,
            [now, current.id, now, booking.id],
          );
        }
      } else if (['40', '104'].includes(status)) {
        await conn.execute(
          `UPDATE payment_refunds SET refund_status='refund_failed', next_retry_at=?, updated_at=?,
            version=version+1 WHERE id=?`,
          [now, now, current.id],
        );
      }
      await conn.commit();
    } catch (error) {
      try { await conn.rollback(); } catch (_) {}
      throw error;
    } finally {
      await conn.end();
    }
    return { state: status === '30' ? 'refunded' : status === '40' || status === '104' ? 'refund_failed' : refund.refund_status, source };
  }

  async function closePaymentByOrder(orderNo, reason = 'booking_expired') {
    assertConfig();
    const conn = await createConnection();
    let payment;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        `SELECT * FROM payment_orders WHERE biz_order_no=? ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [orderNo],
      );
      payment = rows[0];
      if (!payment || ['closed', 'paid'].includes(payment.pay_status)) {
        await conn.commit();
        return { skipped: true, payment };
      }
      await conn.execute(
        `UPDATE payment_orders SET pay_status='closing', close_reason=?, updated_at=?, version=version+1 WHERE id=?`,
        [reason, sqlNow(), payment.id],
      );
      await conn.commit();
    } catch (error) {
      try { await conn.rollback(); } catch (_) {}
      throw error;
    } finally {
      await conn.end();
    }
    const request = {
      appCode: cfg.appCode, projectCode: cfg.projectCode, businessOrderNo: payment.app_order_id,
      ucid: payment.payer_ucid, userType: payment.payer_user_type,
    };
    const requestNo = crypto.randomUUID();
    try {
      const result = await payCenter.closeOrder(request);
      await logGateway({
        paymentOrderId: payment.id, appOrderId: payment.app_order_id, operation: 'pay_close',
        requestNo, success: true, businessCode: result.errno, traceId: result.traceId,
        requestJson: JSON.stringify(request), responseJson: JSON.stringify(result),
      });
      const done = await createConnection();
      try {
        await done.execute(
          `UPDATE payment_orders SET pay_status='closed', closed_at=?, next_query_at=NULL,
            updated_at=?, version=version+1 WHERE id=? AND pay_status='closing'`,
          [sqlNow(), sqlNow(), payment.id],
        );
      } finally { await done.end(); }
      return { skipped: false, result };
    } catch (error) {
      await logGateway({
        paymentOrderId: payment.id, appOrderId: payment.app_order_id, operation: 'pay_close',
        requestNo, success: false, businessCode: error.errno, traceId: error.traceId,
        requestJson: JSON.stringify(request), responseJson: error.payResult ? JSON.stringify(error.payResult) : null,
        errorMessage: String(error.message || error).slice(0, 500),
      });
      const unknown = await createConnection();
      try {
        await unknown.execute(
          `UPDATE payment_orders SET pay_status='close_unknown', query_retry_count=query_retry_count+1,
            next_query_at=?, updated_at=?, version=version+1 WHERE id=?`,
          [sqlNow(), sqlNow(), payment.id],
        );
      } finally { await unknown.end(); }
      throw error;
    }
  }

  async function handleNotify(body) {
    const key = notificationKey(body || {});
    const conn = await createConnection();
    try {
      await conn.beginTransaction();
      const [existing] = await conn.execute(`SELECT id FROM payment_notify_log WHERE notify_key=? LIMIT 1 FOR UPDATE`, [key]);
      if (existing[0]) {
        await conn.commit();
        return 'REPEATED';
      }
      const appOrderId = body && body.appOrderId;
      await conn.execute(
        `INSERT INTO payment_notify_log(notify_key,notify_type,app_order_id,order_status,payload_json,handle_result,received_at)
         VALUES(?,?,?,?,?,'processing',?)`,
        [key, body && body.refundFlag ? 'refund' : 'pay', appOrderId || null, body && body.orderStatus || null, JSON.stringify(body || {}), sqlNow()],
      );
      const [refunds] = await conn.execute(`SELECT * FROM payment_refunds WHERE app_order_id=? LIMIT 1`, [appOrderId]);
      if (refunds[0]) {
        await conn.commit();
        await advanceRefundState(refunds[0], { data: body }, 'notify');
        const done = await createConnection();
        try { await done.execute(`UPDATE payment_notify_log SET handle_result='success', handled_at=? WHERE notify_key=?`, [sqlNow(), key]); } finally { await done.end(); }
        return 'SUCCESS';
      }
      const [payments] = await conn.execute(`SELECT * FROM payment_orders WHERE app_order_id=? LIMIT 1`, [appOrderId]);
      if (payments[0]) {
        await conn.commit();
        await advancePaymentState(payments[0], { data: body }, 'notify');
        const done = await createConnection();
        try { await done.execute(`UPDATE payment_notify_log SET handle_result='success', handled_at=? WHERE notify_key=?`, [sqlNow(), key]); } finally { await done.end(); }
        return 'SUCCESS';
      }
      await conn.execute(`UPDATE payment_notify_log SET handle_result='notfound', handled_at=? WHERE notify_key=?`, [sqlNow(), key]);
      await conn.commit();
      return 'NOTFOUND';
    } catch (error) {
      try { await conn.rollback(); } catch (_) {}
      logger.warn('payment notify failed:', error.message);
      throw error;
    } finally {
      await conn.end();
    }
  }

  return {
    createOrReusePayment,
    queryPayment,
    createOrReuseRefund,
    requestRefund,
    queryRefund,
    closePaymentByOrder,
    runPaymentCompensation,
    handleNotify,
    advancePaymentState,
    advanceRefundState,
    generateAppOrderId,
  };
}

module.exports = { createPaymentService, generateAppOrderId, notificationKey };
