'use strict';

const crypto = require('node:crypto');
const P = require('./primitives.cjs');
const { assert, parse, sqlDate, expired, toAmount, toMinor, minor, sanitize, notificationKey } = P;

function createWorker(I) {
  const { config, payCenter, logger, now, clock, due, tx, rows, guard, payment, enqueue, emit, finishClosed, closeGuard, refundInTransaction } = I;
  const pendingDelay = Number(config.PAY_POLL_SECONDS || 10);
  const leaseSeconds = Math.max(30, Number(config.PAY_JOB_LEASE_SECONDS || 60));
  const closedStatuses = new Set(String(config.PAY_CLOSED_STATUSES || '40').split(','));
  const rawData = result => {
    assert(result && (result.errno == null || Number(result.errno) === 0), '中台业务请求失败', 502, 'gateway_business_error');
    const data = result.data == null ? result : result.data;
    assert(data && typeof data === 'object' && !Array.isArray(data), '中台返回无效', 502, 'gateway_invalid_response');
    return data;
  };
  const remoteStatus = data => String(data.orderStatus ?? data.status ?? data.refundStatus ?? data.payStatus ?? '');
  // This capability never leaves the worker. Public reconciliation and callbacks
  // cannot opt into the historical booking query response contract.
  const trustedQuery = Symbol('authenticated payment query');
  function checkIdentity(data, p, refund, { allowLegacySparse = false, requireSuccessEvidence = true } = {}) {
    const same = (value, expected) => String(value) === String(expected);
    const match = (ok, message) => assert(ok, message, 502, 'gateway_identity_mismatch');
    let orderEvidence = false;
    if (refund) {
      if (data.refundAppOrderId != null) {
        match(same(data.refundAppOrderId, refund.app_order_id), '中台退款流水与原单不匹配');
        orderEvidence = true;
      }
      if (data.appOrderId != null) {
        // Some refund schemas explicitly name the refund and also echo the
        // original payment as appOrderId. Neither may refer to an unrelated order.
        match(same(data.appOrderId, refund.app_order_id) || (data.refundAppOrderId != null && same(data.appOrderId, p.app_order_id)), '中台退款业务单与原单不匹配');
        orderEvidence = orderEvidence || same(data.appOrderId, refund.app_order_id);
      }
      if (data.businessOrderNo != null) {
        match(same(data.businessOrderNo, p.app_order_id) || same(data.businessOrderNo, refund.app_order_id), '中台退款关联支付单不匹配');
        orderEvidence = orderEvidence || same(data.businessOrderNo, refund.app_order_id);
      }
    } else {
      for (const value of [data.appOrderId, data.businessOrderNo]) if (value != null) {
        match(same(value, p.app_order_id), '中台流水与原单不匹配'); orderEvidence = true;
      }
    }
    if (data.appCode != null) assert(String(data.appCode) === p.app_code, '中台应用不匹配', 502, 'gateway_identity_mismatch');
    if (data.projectCode != null) assert(String(data.projectCode) === p.project_code, '中台项目不匹配', 502, 'gateway_identity_mismatch');
    // merchantId is an institution identifier in the existing gateway sample,
    // not the collecting merchantNo. Do not guess that these are aliases.
    const merchants = [data.merchantNo, data.recAndShareInfo?.merchantNo].filter(value => value != null);
    for (const merchant of merchants) match(same(merchant, p.merchant_no), '中台商户不匹配');
    for (const payer of [data.ucid, data.userInfo?.ucid]) if (payer != null) match(same(payer, p.payer_ucid), '中台付款身份不匹配');
    if (data.currency != null) assert(['CNY', '156', 'RMB'].includes(String(data.currency)), '支付币种不匹配', 502, 'gateway_identity_mismatch');
    const amounts = (refund ? [data.refundAmount ?? data.amount] : [data.amount, data.payAmount, data.orderAmount]).filter(value => value != null);
    for (const amount of amounts) {
      assert(toMinor(amount) === Number(refund ? refund.amount_minor : p.amount_minor), '中台实付金额不匹配', 502, 'gateway_amount_mismatch');
    }
    if (requireSuccessEvidence && remoteStatus(data) === '30' && !(allowLegacySparse && p.biz_type === 'booking')) {
      assert(orderEvidence && merchants.length && amounts.length, '成功查单缺少流水、金额或商户，待中台核验', 502, 'gateway_evidence_incomplete');
    }
  }
  function providerReference(data, p) {
    for (const value of [data.payNo, data.pay_no, data.orderId]) {
      if (typeof value === 'string' && value.trim()) return value;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    }
    // JSON numbers above 2^53 have already lost precision. Retain the exact local
    // app order identifier rather than inventing a rounded provider reference.
    return p.app_order_id;
  }
  function createPayload(p) {
    const amount = toAmount(p.amount_minor), seconds = Math.max(1, Math.floor((new Date(sqlDate(p.expires_at).replace(' ', 'T') + 'Z').getTime() - now()) / 1000));
    return {
      amount, appCode: p.app_code, projectCode: p.project_code, shareBizCode: p.share_biz_code,
      appOrderId: p.app_order_id, appOrderName: p.title,
      payChannel: { cashierType: p.cashier_type, shareBizCode: p.share_biz_code, tradeInfo: { tradeName: p.title, tradeDesc: p.title } },
      callBackInfo: { callbackUrl: p.callback_url },
      recAndShareInfo: { merchantNo: p.merchant_no, shareOrderMode: '0', shareOrderInfos: [{ merchantNo: p.merchant_no, amount, shareBizCode: p.share_biz_code }] },
      payOrderInfo: { note: p.biz_order_no, expireTime: seconds }, contractInfo: { contractNo: p.biz_order_no, contractAmount: amount },
      appClientInfo: { appType: p.cashier_type === '1' ? 1 : 2, appClientIp: p.client_ip || '127.0.0.1' },
      userInfo: { ucid: p.payer_ucid, userType: p.payer_user_type },
    };
  }
  const queryPayload = p => ({ appCode: p.app_code, projectCode: p.project_code, appOrderId: p.app_order_id });
  async function gateway(operation, target, request, call) {
    const started = clock(), requestNo = crypto.randomUUID();
    let result, failure;
    try { result = await call(request); rawData(result); return result; }
    catch (e) { failure = e; throw e; }
    finally {
      try {
        await tx(c => c.execute(`INSERT INTO payment_gateway_logs(payment_order_id,payment_refund_id,app_order_id,operation_type,request_no,business_code,trace_id,success_flag,request_json,response_json,error_message,started_at,finished_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [target.paymentId || null, target.refundId || null, target.appOrderId, operation, requestNo,
          result?.errno == null ? failure?.errno == null ? null : String(failure.errno) : String(result.errno), result?.traceId || failure?.traceId || null,
          failure ? 0 : 1, JSON.stringify(sanitize(request)), result ? JSON.stringify(sanitize(result)) : null,
          failure ? String(failure.code || failure.name || 'gateway_error').slice(0, 500) : null, started, clock()]));
      } catch (e) { logger.warn('payment gateway log failed:', e.code || e.name); }
    }
  }
  async function loadTarget(job) {
    return tx(async c => {
      if (job.kind.startsWith('refund_')) {
        const [r] = await rows(c, 'SELECT * FROM payment_refunds WHERE id=?', [job.target_id]);
        assert(r, '退款记录不存在', 404);
        const p = await payment(c, r.payment_order_id, false); assert(p, '原支付记录不存在', 404); return { p, r };
      }
      const p = await payment(c, job.target_id, false); assert(p, '支付记录不存在', 404); return { p };
    });
  }
  async function reconcilePayment(id, result, context) {
    const data = rawData(result);
    return tx(async c => {
      const reference = await payment(c, id, false); assert(reference, '支付记录不存在', 404);
      const g = await guard(c, { bizType: reference.biz_type, orderId: reference.biz_order_no });
      const p = await payment(c, id), code = remoteStatus(data); checkIdentity(data, p, null, { allowLegacySparse: context === trustedQuery });
      if (code === '30') {
        if (p.pay_status === 'paid') return { terminal: true, state: 'paid' };
        const providerRef = providerReference(data, p);
        await c.execute("UPDATE payment_orders SET pay_status='paid',gateway_order_status=?,pay_method=?,pay_no=?,paid_at=?,next_query_at=NULL,updated_at=?,version=version+1 WHERE id=?", [code, data.payMethod || data.pay_method || null, providerRef, clock(), clock(), p.id]);
        p.pay_status = 'paid';
        const accepted = !g.paid_payment_id && g.lifecycle === 'open' && !expired(g.expires_at, now());
        if (accepted) {
          g.paid_payment_id = p.id; g.lifecycle = 'paid';
          await c.execute("UPDATE payment_order_guards SET paid_payment_id=?,lifecycle='paid',version=version+1,updated_at=? WHERE biz_type=? AND biz_order_no=?", [p.id, clock(), p.biz_type, p.biz_order_no]);
        }
        await emit(c, g, 'payment.received', `received:${p.id}`, { paymentId: p.id, amountMinor: Number(p.amount_minor), accepted, providerRef, appOrderId: p.app_order_id });
        if (accepted) {
          await emit(c, g, 'payment.accepted', `accepted:${p.id}`, { paymentId: p.id, amountMinor: Number(p.amount_minor), providerRef, appOrderId: p.app_order_id });
          const other = await rows(c, "SELECT * FROM payment_orders WHERE biz_type=? AND biz_order_no=? AND id<>? AND pay_status NOT IN ('paid','closed') ORDER BY id FOR UPDATE", [p.biz_type, p.biz_order_no, p.id]);
          for (const candidate of other) {
            await c.execute("UPDATE payment_orders SET pay_status='closing',close_reason='another_payment_succeeded',updated_at=? WHERE id=?", [clock(), candidate.id]);
            await enqueue(c, 'pay_close', candidate.id);
          }
        } else if (String(g.paid_payment_id) !== String(p.id)) {
          const reason = g.paid_payment_id ? 'duplicate_pay' : 'late_pay';
          await refundInTransaction(c, g, p, { amountMinor: Number(p.amount_minor), requestKey: `${reason}:${p.id}`, reason, source: 'system' });
          if (!g.paid_payment_id && g.lifecycle === 'open') await closeGuard(c, g, 'expired', false);
        }
        await finishClosed(c, g);
        return { terminal: true, state: 'paid' };
      }
      if (p.pay_status === 'paid') return { terminal: true, state: 'paid' };
      if (closedStatuses.has(code)) {
        await c.execute("UPDATE payment_orders SET pay_status='closed',gateway_order_status=?,closed_at=?,next_query_at=NULL,updated_at=?,version=version+1 WHERE id=? AND pay_status<>'paid'", [code, clock(), clock(), p.id]);
        await c.execute('UPDATE payment_order_guards SET active_payment_id=NULL,updated_at=? WHERE biz_type=? AND biz_order_no=? AND active_payment_id=?', [clock(), p.biz_type, p.biz_order_no, p.id]);
        if (String(g.active_payment_id) === String(p.id)) g.active_payment_id = null;
        await finishClosed(c, g); return { terminal: true, state: 'closed' };
      }
      const closing = g.lifecycle === 'closing' || Boolean(p.close_reason) || (g.paid_payment_id && String(g.paid_payment_id) !== String(p.id));
      const cashierUrl = data.cashierUrl || data.cashier_url || data.url || data.redirectUrl || null;
      const expiry = data.cashierExpiresAt || data.expireTime;
      const cashierExpiry = typeof expiry === 'string' && /^\d{4}-/.test(expiry) ? sqlDate(expiry) : null;
      if (!['closed', 'paid'].includes(p.pay_status)) await c.execute('UPDATE payment_orders SET pay_status=?,gateway_order_status=?,cashier_url=COALESCE(?,cashier_url),cashier_expires_at=COALESCE(?,cashier_expires_at),next_query_at=?,updated_at=? WHERE id=?', [closing ? 'closing' : 'paying', code || null, cashierUrl, cashierExpiry, due(pendingDelay), clock(), p.id]);
      if (closing) await enqueue(c, 'pay_close', p.id, {}, pendingDelay);
      return { terminal: p.pay_status === 'closed', state: closing ? 'closing' : 'paying' };
    });
  }
  async function reconcileRefund(id, result, context) {
    const data = rawData(result);
    return tx(async c => {
      const [ref] = await rows(c, 'SELECT * FROM payment_refunds WHERE id=?', [id]); assert(ref, '退款不存在', 404);
      const g = await guard(c, { bizType: ref.biz_type, orderId: ref.biz_order_no });
      const p = await payment(c, ref.payment_order_id);
      const [r] = await rows(c, 'SELECT * FROM payment_refunds WHERE id=? FOR UPDATE', [id]);
      checkIdentity(data, p, r, { allowLegacySparse: context === trustedQuery });
      if (r.refund_status === 'refunded') return { terminal: true };
      const code = remoteStatus(data);
      if (code === '30') {
        await c.execute("UPDATE payment_refunds SET refund_status='refunded',refunded_at=?,next_retry_at=NULL,version=version+1,updated_at=? WHERE id=?", [clock(), clock(), id]);
        await emit(c, g, 'refund.succeeded', `refunded:${id}`, { paymentId: p.id, refundId: r.id, amountMinor: Number(r.amount_minor), reference: parse(r.reference_json), reason: r.refund_reason_type, requestKey: r.idempotency_key });
        return { terminal: true };
      }
      // Failed/unknown refunds still reserve their amount until an operator has authoritative final evidence.
      await c.execute('UPDATE payment_refunds SET refund_status=?,retry_count=retry_count+1,next_retry_at=?,updated_at=? WHERE id=?', [['40', '104', '60', '101', '102', '103'].includes(code) ? 'manual_review' : 'refunding', due(pendingDelay), clock(), id]);
      return { terminal: false };
    });
  }
  async function queryPayment(p) {
    const result = await gateway('pay_query', { paymentId: p.id, appOrderId: p.app_order_id }, queryPayload(p), body => payCenter.queryOrder(body));
    return reconcilePayment(p.id, result, trustedQuery);
  }
  async function processJob(job) {
    if (typeof I.jobHandlers[job.kind] === 'function') {
      await I.jobHandlers[job.kind]({ ...job, payload: parse(job.payload) });
      return { terminal: true };
    }
    assert(payCenter, '支付执行器未配置中台客户端', 503, 'payment_configuration');
    const { p, r } = await loadTarget(job);
    const target = { paymentId: p.id, refundId: r?.id, appOrderId: r?.app_order_id || p.app_order_id };
    if (job.kind === 'pay_query') return queryPayment(p);
    if (job.kind === 'pay_create') {
      const prepared = await tx(async c => {
        const g = await guard(c, { bizType: p.biz_type, orderId: p.biz_order_no });
        const current = await payment(c, p.id);
        const [j] = await rows(c, 'SELECT * FROM payment_jobs WHERE id=? FOR UPDATE', [job.id]);
        assert(j.lease_token === job.lease_token && j.status === 'running', '任务已由另一执行器接管', 409, 'lease_lost');
        if (['paid', 'closed'].includes(current.pay_status)) return { skip: true };
        const sent = parse(j.payload).sent === true;
        if (sent) return { query: true };
        if (g.lifecycle !== 'open' || g.paid_payment_id || expired(g.expires_at, now()) || current.close_reason) {
          await c.execute("UPDATE payment_orders SET pay_status='closed',closed_at=?,updated_at=? WHERE id=? AND pay_status<>'paid'", [clock(), clock(), p.id]);
          await c.execute('UPDATE payment_order_guards SET active_payment_id=NULL WHERE biz_type=? AND biz_order_no=? AND active_payment_id=?', [p.biz_type, p.biz_order_no, p.id]);
          if (g.lifecycle === 'open' && expired(g.expires_at, now())) await closeGuard(c, g, 'expired', false);
          await finishClosed(c, g); return { skip: true };
        }
        await c.execute('UPDATE payment_jobs SET payload=? WHERE id=? AND lease_token=?', [JSON.stringify({ ...parse(j.payload), sent: true }), j.id, job.lease_token]);
        return { current };
      });
      if (prepared.skip) return { terminal: true };
      if (prepared.query) { await queryPayment(p); return { terminal: true, queryAgain: true }; }
      const result = await gateway('pay_create', target, createPayload(prepared.current), body => payCenter.createC2BOrder(body));
      const data = rawData(result); checkIdentity(data, p, null, { requireSuccessEvidence: false });
      await tx(async c => {
        const g = await guard(c, { bizType: p.biz_type, orderId: p.biz_order_no });
        const current = await payment(c, p.id);
        if (['paid', 'closed'].includes(current.pay_status)) return;
        const closing = g.lifecycle !== 'open' || Boolean(current.close_reason) || expired(g.expires_at, now());
        const rawExpiry = data.cashierExpiresAt || data.expireTime;
        let expiresAt = null;
        if (rawExpiry && typeof rawExpiry === 'string' && /^\d{4}-/.test(rawExpiry)) expiresAt = sqlDate(rawExpiry);
        await c.execute('UPDATE payment_orders SET pay_status=?,cashier_url=?,cashier_expires_at=?,gateway_order_status=?,updated_at=? WHERE id=?', [closing ? 'closing' : 'paying', data.cashierUrl || data.cashier_url || data.url || data.redirectUrl || null, expiresAt, remoteStatus(data) || null, clock(), p.id]);
        await enqueue(c, closing ? 'pay_close' : 'pay_query', p.id, {}, closing ? 0 : pendingDelay);
      });
      // Creation response is not the payment evidence; confirm terminal success with a query.
      if (remoteStatus(data) === '30') await queryPayment(p);
      return { terminal: true };
    }
    if (job.kind === 'pay_close') {
      const local = await tx(async c => {
        const g = await guard(c, { bizType: p.biz_type, orderId: p.biz_order_no });
        const current = await payment(c, p.id);
        if (['paid', 'closed'].includes(current.pay_status)) return true;
        const [create] = await rows(c, "SELECT * FROM payment_jobs WHERE job_key=? FOR UPDATE", [`pay_create:${p.id}`]);
        if (create && !parse(create.payload).sent) {
          await c.execute("UPDATE payment_jobs SET status='done',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?", [clock(), create.id]);
          await c.execute("UPDATE payment_orders SET pay_status='closed',closed_at=?,updated_at=? WHERE id=?", [clock(), clock(), p.id]);
          await c.execute('UPDATE payment_order_guards SET active_payment_id=NULL WHERE biz_type=? AND biz_order_no=? AND active_payment_id=?', [p.biz_type, p.biz_order_no, p.id]);
          await finishClosed(c, g); return true;
        }
        return false;
      });
      if (local) return { terminal: true };
      const before = await queryPayment(p);
      if (before.terminal) return before;
      const body = { appCode: p.app_code, projectCode: p.project_code, businessOrderNo: p.app_order_id, ucid: p.payer_ucid, userType: p.payer_user_type };
      await gateway('pay_close', target, body, input => payCenter.closeOrder(input));
      return queryPayment(p); // An accepted close request is not a closed order.
    }
    if (job.kind === 'refund_create') {
      if (r.refund_status === 'refunded') return { terminal: true };
      const sent = await tx(async c => {
        await guard(c, { bizType: p.biz_type, orderId: p.biz_order_no });
        const [j] = await rows(c, 'SELECT * FROM payment_jobs WHERE id=? FOR UPDATE', [job.id]);
        assert(j.lease_token === job.lease_token && j.status === 'running', '任务租约失效', 409, 'lease_lost');
        const already = parse(j.payload).sent === true;
        if (!already) await c.execute('UPDATE payment_jobs SET payload=? WHERE id=?', [JSON.stringify({ ...parse(j.payload), sent: true }), job.id]);
        return already;
      });
      if (!sent) {
        const body = { appCode: p.app_code, projectCode: p.project_code, appOrderId: r.app_order_id, businessOrderNo: p.app_order_id, refundAmount: toAmount(r.amount_minor),
          callbackUrl: p.callback_url, ucid: p.payer_ucid, userType: p.payer_user_type,
          shareOrderInfos: [{ merchantNo: p.merchant_no, shareBizCode: p.share_biz_code, amount: toAmount(r.amount_minor) }] };
        await gateway('refund_create', target, body, input => payCenter.refundOrder(input));
      }
      await tx(c => enqueue(c, 'refund_query', r.id));
      return { terminal: true };
    }
    if (job.kind === 'refund_query') {
      const body = { appCode: p.app_code, projectCode: p.project_code, businessOrderNo: r.app_order_id };
      const result = await gateway('refund_query', target, body, input => payCenter.queryRefundOrder(input));
      return reconcileRefund(r.id, result, trustedQuery);
    }
    throw new P.PaymentError('未知支付任务', 500);
  }
  async function claim(filter = {}) {
    return tx(async c => {
      const kinds = ['pay_create', 'pay_query', 'pay_close', 'refund_create', 'refund_query', ...Object.keys(I.jobHandlers)];
      // Claim transactions contain no network calls, so a brief row-lock wait
      // also supports deployments without MySQL 8 SKIP LOCKED.
      const target = filter.kind != null || filter.targetId != null;
      if (target) assert(kinds.includes(filter.kind) && /^\d+$/.test(String(filter.targetId)), '支付任务筛选无效', 422);
      const [job] = await rows(c, `SELECT * FROM payment_jobs WHERE kind IN (${kinds.map(() => '?').join(',')}) ${target ? 'AND kind=? AND target_id=?' : ''} AND ((status='pending' AND next_run_at<=?) OR (status='running' AND lease_until<=?)) ORDER BY IF(status='running',lease_until,next_run_at),id LIMIT 1 FOR UPDATE`, [...kinds, ...(target ? [filter.kind, filter.targetId] : []), clock(), clock()]);
      if (!job) return null;
      const token = crypto.randomUUID();
      await c.execute("UPDATE payment_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,payload=JSON_REMOVE(COALESCE(payload,JSON_OBJECT()),'$.rerun'),updated_at=? WHERE id=?", [token, due(leaseSeconds), clock(), job.id]);
      return { ...job, attempts: Number(job.attempts) + 1, lease_token: token };
    });
  }
  async function runJobs(limit = 25, filter = {}) {
    let processed = 0, deferred = 0;
    for (let i = 0; i < Math.min(Number(limit) || 25, 100); i++) {
      const job = await claim(filter); if (!job) break;
      try {
        const outcome = await processJob(job);
        await tx(async c => {
          // A notification queued during this external request needs another query,
          // even if the older response was terminal. Never drop a durable wakeup.
          await c.execute("UPDATE payment_jobs SET status=IF(JSON_EXTRACT(payload,'$.rerun')=true,'pending',?),next_run_at=?,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND lease_token=?", [outcome.terminal ? 'done' : 'pending', due(pendingDelay), clock(), job.id, job.lease_token]);
          if (outcome.queryAgain) await enqueue(c, 'pay_query', job.target_id, {}, pendingDelay);
        });
        processed++;
      } catch (error) {
        const delay = Math.min(300, 2 ** Math.min(job.attempts, 8));
        await tx(async c => {
          // Lease identity fences task ownership, while reconciliation above preserves verified terminal facts.
          await c.execute("UPDATE payment_jobs SET status='pending',next_run_at=?,lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease_token=?", [due(delay), String(error.code || error.name).slice(0, 500), clock(), job.id, job.lease_token]);
        });
        if (['pay_create', 'pay_close'].includes(job.kind)) {
          await tx(async c => {
            const p = await payment(c, job.target_id, false); if (!p) return;
            await guard(c, { bizType: p.biz_type, orderId: p.biz_order_no });
            await c.execute("UPDATE payment_orders SET pay_status=?,query_retry_count=query_retry_count+1,next_query_at=?,updated_at=? WHERE id=? AND pay_status NOT IN ('paid','closed')", [job.kind === 'pay_close' ? 'close_unknown' : 'create_unknown', due(delay), clock(), p.id]);
            await enqueue(c, 'pay_query', p.id, {}, delay);
          });
        }
        deferred++; logger.warn('payment task deferred:', job.id, error.code || error.name);
      }
    }
    return { processed, deferred };
  }
  async function handleNotify(body) {
    assert(body && typeof body === 'object' && !Array.isArray(body) && typeof body.appOrderId === 'string' && body.appOrderId.length <= 28, '支付通知格式无效', 422);
    // Notification body is an untrusted hint. Only an authenticated server-to-server query changes money states.
    return tx(async c => {
      const key = notificationKey(body);
      const [r] = await rows(c, 'SELECT * FROM payment_refunds WHERE app_order_id=?', [body.appOrderId]);
      const p = r ? await payment(c, r.payment_order_id, false) : (await rows(c, 'SELECT * FROM payment_orders WHERE app_order_id=?', [body.appOrderId]))[0];
      assert(p, '通知支付单不存在', 404, 'notify_unknown_order');
      if (body.appCode != null) assert(body.appCode === p.app_code, '通知应用不匹配', 422);
      if (body.projectCode != null) assert(body.projectCode === p.project_code, '通知项目不匹配', 422);
      const g = await guard(c, { bizType: p.biz_type, orderId: p.biz_order_no });
      const [existing] = await rows(c, 'SELECT * FROM payment_notify_log WHERE notify_key=? FOR UPDATE', [key]);
      if (existing?.handle_result === 'success') return 'SUCCESS';
      await c.execute(`INSERT INTO payment_notify_log(notify_key,notify_type,app_order_id,order_status,payload_json,handle_result,received_at)
        VALUES(?,?,?,?,?,'processing',?) ON DUPLICATE KEY UPDATE handle_result='processing'`,
      [key, r ? 'refund' : 'pay', body.appOrderId, String(body.orderStatus || body.status || ''), JSON.stringify(sanitize(body)), clock()]);
      await enqueue(c, r ? 'refund_query' : 'pay_query', r ? r.id : p.id);
      await c.execute("UPDATE payment_notify_log SET handle_result='success',handled_at=?,handle_message='durable authoritative query queued' WHERE notify_key=?", [clock(), key]);
      return 'SUCCESS';
    });
  }
  return { runJobs, handleNotify, reconcilePayment, reconcileRefund };
}

module.exports = { createWorker };
