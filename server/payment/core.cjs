'use strict';

const crypto = require('node:crypto');
const P = require('./primitives.cjs');
const { assert, parse, digest, sqlDate, expired, minor, toAmount, toMinor, normalizeBizOrderNo, restoreBizOrderNo, generateAppOrderId, requestKey } = P;
const ACTIVE = ['creating', 'paying', 'create_unknown', 'closing', 'close_unknown', 'pay_failed'];

function createPaymentCore({ createConnection, config = process.env, payCenter, logger = console, now = () => Date.now(), jobHandlers = {} } = {}) {
  assert(typeof createConnection === 'function', '支付数据库连接未配置', 503, 'payment_configuration');
  const clock = () => sqlDate(new Date(now()));
  const due = seconds => sqlDate(new Date(now() + seconds * 1000));
  async function rows(c, sql, args = []) { return (await c.execute(sql, args))[0]; }
  async function close(c) {
    // mysql2 PromiseConnection exposes release() even for standalone connections,
    // where the underlying release method does not exist.
    if (typeof c.release === 'function' && (!c.connection || typeof c.connection.release === 'function')) c.release();
    else await c.end();
  }
  async function tx(fn, existing) {
    if (existing) { if(typeof existing.query==='function')await existing.query("SET time_zone='+00:00'");return fn(existing); }
    const c = await createConnection();
    try { if(typeof c.query==='function')await c.query("SET time_zone='+00:00'");await c.beginTransaction(); const result = await fn(c); await c.commit(); return result; }
    catch (e) { await c.rollback().catch(() => {}); throw e; }
    finally { await close(c); }
  }
  function identity(input) { return [input.bizType, normalizeBizOrderNo(input.bizType, input.orderId)]; }
  async function guard(c, input) {
    const [g] = await rows(c, 'SELECT * FROM payment_order_guards WHERE biz_type=? AND biz_order_no=? FOR UPDATE', identity(input));
    assert(g, '支付订单尚未登记', 404, 'payment_order_missing');
    g.snapshot = parse(g.snapshot); return g;
  }
  function owned(g, accountId) { assert(accountId != null && String(g.account_id) === String(accountId), '无权操作该订单', 403, 'payment_not_owned'); }
  async function enqueue(c, kind, targetId, payload = {}, delay = 0) {
    const key = `${kind}:${targetId}`;
    await c.execute(`INSERT INTO payment_jobs(job_key,kind,target_id,status,attempts,next_run_at,payload,created_at,updated_at)
      VALUES(?,?,?,'pending',0,?,?,?,?) ON DUPLICATE KEY UPDATE
      next_run_at=IF(status='running',next_run_at,LEAST(next_run_at,VALUES(next_run_at))),
      payload=IF(status='running',JSON_SET(COALESCE(payload,JSON_OBJECT()),'$.rerun',true),payload),
      status=IF(status='running','running','pending'),updated_at=VALUES(updated_at)`,
    [key, kind, targetId, due(delay), JSON.stringify(payload), clock(), clock()]);
  }
  async function emit(c, g, eventType, key, payload) {
    await c.execute(`INSERT INTO payment_events(event_key,biz_type,biz_order_no,event_type,payload,status,attempts,next_run_at,created_at)
      VALUES(?,?,?,?,?,'pending',0,?,?) ON DUPLICATE KEY UPDATE event_key=event_key`,
    [key, g.biz_type, g.biz_order_no, eventType, JSON.stringify({ ...payload, guardVersion: Number(g.version) }), clock(), clock()]);
  }
  async function payment(c, id, lock = true) {
    if (!id) return null;
    return (await rows(c, `SELECT * FROM payment_orders WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [id]))[0] || null;
  }
  async function registerOrder(c, descriptor) {
    const d = descriptor, type = d.bizType, no = normalizeBizOrderNo(type, d.orderId);
    const snapshot = {
      account_id: String(d.accountId || ''), amount_minor: minor(d.amountMinor), payer_ucid: String(d.payerUcid || ''),
      payer_user_type: String(d.payerUserType || config.PAY_USER_TYPE || '2'), merchant_no: String(d.merchantNo || ''),
      share_biz_code: String(d.shareBizCode || config.PAY_SHARE_BIZ_CODE || ''), app_code: String(d.appCode || config.PAY_APP_CODE || ''),
      project_code: String(d.projectCode || config.PAY_PROJECT_CODE || ''), callback_url: String(d.callbackUrl || config.PAY_NOTIFY_URL || ''),
      expires_at: sqlDate(d.expiresAt), title: String(d.title || '订单支付').slice(0, 255),
      config_version: Number(d.configVersion || 1), snapshot: d.snapshot || {},
    };
    for (const key of ['account_id', 'payer_ucid', 'merchant_no', 'share_biz_code', 'app_code', 'project_code', 'callback_url'])
      assert(snapshot[key], `支付配置缺失：${key}`, 503, 'payment_configuration');
    assert(snapshot.account_id.length <= 64 && snapshot.payer_ucid.length <= 64, '支付身份格式无效', 422);
    let registered = false;
    try {
      await c.execute(`INSERT INTO payment_order_guards
      (biz_type,biz_order_no,account_id,amount_minor,payer_ucid,payer_user_type,merchant_no,share_biz_code,app_code,project_code,callback_url,title,expires_at,config_version,snapshot,lifecycle,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',0,?,?)`,
    [type, no, snapshot.account_id, snapshot.amount_minor, snapshot.payer_ucid, snapshot.payer_user_type, snapshot.merchant_no,
      snapshot.share_biz_code, snapshot.app_code, snapshot.project_code, snapshot.callback_url, snapshot.title, snapshot.expires_at,
      snapshot.config_version, JSON.stringify(snapshot.snapshot), clock(), clock()]);
      registered = true;
    } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
    const g = await guard(c, { bizType: type, orderId: no });
    for (const key of ['account_id', 'amount_minor', 'payer_ucid', 'merchant_no', 'share_biz_code', 'app_code', 'project_code'])
      assert(String(g[key]) === String(snapshot[key]), '订单支付快照冲突，禁止更换金额或收款方', 409, 'payment_snapshot_conflict');
    assert(digest(g.snapshot.settlement_profile || null) === digest(snapshot.snapshot.settlement_profile || null),
      '订单受控收款合同快照冲突，不能给历史支付静默换合同',409,'payment_snapshot_conflict');
    // Only the registering transaction can import legacy attempts. No request may create a blank guard over an old payment.
    if (registered) {
      const previous = await rows(c, 'SELECT * FROM payment_orders WHERE biz_type=? AND biz_order_no=? ORDER BY id FOR UPDATE', [type, no]);
      const active = previous.filter(p => ACTIVE.includes(p.pay_status));
      const paid = previous.filter(p => p.pay_status === 'paid');
      const chosen = d.legacyPaidPaymentId ? paid.find(p => String(p.id) === String(d.legacyPaidPaymentId))
        : (!d.requireAuthoritativePaid && paid.length === 1 ? paid[0] : null);
      const unaccepted = paid.filter(p => String(p.id) !== String(chosen?.id));
      assert(active.length <= 1 && (!unaccepted.length || (d.requireAuthoritativePaid && (chosen || d.legacyLifecycle === 'closed'))),
        '历史支付记录需要核对，禁止创建新支付', 409, 'payment_migration_conflict');
      if (d.legacyPaidPaymentId) assert(chosen, '历史成功支付引用不一致', 409, 'payment_migration_conflict');
      for (const p of unaccepted) {
        const [refund] = await rows(c, "SELECT COALESCE(SUM(refund_amount),0) amount FROM payment_refunds WHERE payment_order_id=? AND refund_status<>'voided'", [p.id]);
        assert(Number(refund.amount) === Number(p.amount), '历史未接受到账缺少足额原路退款记录，需要核对', 409, 'payment_migration_conflict');
      }
      for (const p of previous) {
        // Closed attempts and already refunded duplicate/late receipts retain
        // their own historical routing identity. Only the current/accepted
        // attempt must agree with the business order's payment snapshot.
        const current = ACTIVE.includes(p.pay_status) || String(p.id) === String(chosen?.id);
        assert(toMinor(p.amount) === snapshot.amount_minor && (!current ||
          (String(p.payer_ucid) === snapshot.payer_ucid && String(p.merchant_no) === snapshot.merchant_no)),
        '历史支付快照需核对', 409, 'payment_migration_conflict');
        await c.execute('UPDATE payment_orders SET amount_minor=COALESCE(amount_minor,?),app_code=COALESCE(app_code,?),project_code=COALESCE(project_code,?),expires_at=COALESCE(expires_at,?),title=COALESCE(title,?) WHERE id=?',
          [snapshot.amount_minor, snapshot.app_code, snapshot.project_code, snapshot.expires_at, snapshot.title, p.id]);
      }
      g.active_payment_id = active[0]?.id || null; g.paid_payment_id = chosen?.id || null;
      // Import expired/cancelled orders through closing so the durable closed event
      // can finish stock release even when no cashier was ever created.
      g.lifecycle = chosen ? 'paid' : d.legacyLifecycle === 'closed' ? 'closing' : 'open';
      await c.execute('UPDATE payment_order_guards SET active_payment_id=?,paid_payment_id=?,lifecycle=? WHERE biz_type=? AND biz_order_no=?', [g.active_payment_id, g.paid_payment_id, g.lifecycle, type, no]);
      if (chosen && d.legacyFulfilled) {
        g.snapshot.legacyFulfilled = true;
        await c.execute('UPDATE payment_order_guards SET snapshot=? WHERE biz_type=? AND biz_order_no=?', [JSON.stringify(g.snapshot), type, no]);
      }
      for (const p of active) await enqueue(c, 'pay_query', p.id);
      // Legacy refunds may already have reached the provider. Preserve their RF
      // numbers and only query; an unavailable result never authorizes resending.
      const refunds = await rows(c, "SELECT * FROM payment_refunds WHERE biz_type=? AND biz_order_no=? AND refund_status NOT IN ('refunded','voided')", [type, no]);
      for (const r of refunds) await enqueue(c, 'refund_query', r.id);
      if (g.lifecycle === 'closing') await finishClosed(c, g);
    }
    return g;
  }
  async function status(c, g, p, replay = false) {
    const isPaid = Boolean(g.paid_payment_id);
    const canPay = config.PAY_NEW_INTENTS_ENABLED !== '0' && !isPaid && g.lifecycle === 'open' && !expired(g.expires_at, now()) && p && String(g.active_payment_id) === String(p.id) && p.pay_status === 'paying' && (!p.cashier_expires_at || !expired(p.cashier_expires_at, now()));
    let fulfilled = false;
    if (isPaid) {
      const e = await rows(c, "SELECT status FROM payment_events WHERE event_key=?", [`accepted:${g.paid_payment_id}`]);
      fulfilled = e[0]?.status === 'processed' || (!e.length && g.snapshot.legacyFulfilled === true);
    }
    const refundRows = isPaid ? await rows(c, "SELECT COALESCE(SUM(IF(refund_status='refunded',amount_minor,0)),0) refunded,COUNT(*) total FROM payment_refunds WHERE payment_order_id=?", [g.paid_payment_id]) : [];
    const refunded = Number(refundRows[0]?.refunded || 0);
    return { biz_type: g.biz_type, order_id: restoreBizOrderNo(g.biz_type, g.biz_order_no),
      payment_id: p?.id || null, app_order_id: p?.app_order_id || null,
      order_pay_status: isPaid ? (refunded >= Number(g.amount_minor) ? 'refunded' : refunded ? 'partially_refunded' : 'paid') : g.lifecycle === 'open' ? 'unpaid' : g.lifecycle,
      pay_status: p?.pay_status || (g.lifecycle === 'open' ? 'unpaid' : g.lifecycle),
      fulfillment_status: isPaid ? (fulfilled ? 'fulfilled' : 'pending') : 'not_started',
      cashier_type: p?.cashier_type || null, cashier_url: canPay ? p.cashier_url : null,
      amount_minor: Number(g.amount_minor), refunded_minor: refunded,
      idempotent_replay: replay, next_action: isPaid ? (fulfilled ? 'done' : 'poll') : canPay && p.cashier_url ? 'open_cashier' : g.lifecycle === 'closed' ? 'closed' : p?.pay_status === 'closed' && g.lifecycle === 'open' ? 'new_attempt' : 'poll' };
  }
  async function createIntent(input, existing) {
    assert(config.PAY_NEW_INTENTS_ENABLED !== '0', '支付入口暂时关闭，请稍后查询订单状态', 503, 'payment_paused');
    const id = identity(input), key = requestKey(input.requestKey), account = input.account;
    assert(account?.id && account.idp_type === 'beike' && account.idp_subject, '仅贝壳登录用户可发起在线支付', 401, 'beike_identity_required');
    const cashier = String(input.cashierType);
    assert(['1', '2'].includes(cashier), 'cashier_type 仅支持 1 或 2', 422);
    const hash = digest({ bizType: id[0], orderId: id[1], cashierType: cashier });
    return tx(async c => {
      await c.execute(`INSERT INTO payment_requests(actor_id,operation,request_key,digest,biz_type,biz_order_no,created_at)
        VALUES(?,'create_payment',?,?,?,?,?) ON DUPLICATE KEY UPDATE request_key=request_key`, [String(account.id), key, hash, ...id, clock()]);
      const [request] = await rows(c, "SELECT * FROM payment_requests WHERE actor_id=? AND operation='create_payment' AND request_key=? FOR UPDATE", [String(account.id), key]);
      assert(request.digest === hash, '同一幂等请求不能用于不同内容', 409, 'idempotency_conflict');
      const g = await guard(c, input); owned(g, account.id);
      assert(String(g.payer_ucid) === String(account.idp_subject), '支付身份与订单不一致', 403);
      let p = await payment(c, request.payment_order_id), replay = Boolean(p || request.response_json);
      if (!p && g.paid_payment_id) p = await payment(c, g.paid_payment_id);
      if (!p && g.active_payment_id) p = await payment(c, g.active_payment_id);
      if (!g.paid_payment_id && g.lifecycle === 'open' && expired(g.expires_at, now())) await closeGuard(c, g, 'expired', false);
      if (p && !g.paid_payment_id && g.lifecycle === 'open' && (p.cashier_type !== cashier || (p.cashier_expires_at && expired(p.cashier_expires_at, now())))) {
        if (ACTIVE.includes(p.pay_status)) await markClosing(c, g, p, 'cashier_refresh');
      }
      if (!p && !request.response_json && !g.paid_payment_id && g.lifecycle === 'open') {
        const unresolved = await rows(c, "SELECT id FROM payment_orders WHERE biz_type=? AND biz_order_no=? AND pay_status NOT IN ('closed','paid') LIMIT 1", id);
        assert(!unresolved.length, '原支付状态尚未确定，请稍后查询', 409, 'payment_unresolved');
        let inserted;
        for (let retry = 0; retry < 5; retry++) {
          const appId = generateAppOrderId('XD', new Date(now()));
          try {
            [inserted] = await c.execute(`INSERT INTO payment_orders(biz_type,biz_order_no,app_order_id,amount,amount_minor,payer_ucid,payer_user_type,merchant_no,share_biz_code,app_code,project_code,cashier_type,pay_status,callback_url,expires_at,title,client_ip,query_retry_count,next_query_at,version,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'creating',?,?,?,?,0,?,0,?,?)`,
            [...id, appId, toAmount(g.amount_minor), g.amount_minor, g.payer_ucid, g.payer_user_type, g.merchant_no, g.share_biz_code,
              g.app_code, g.project_code, cashier, g.callback_url, sqlDate(g.expires_at), g.title, String(input.clientIp || '127.0.0.1').slice(0, 64), clock(), clock(), clock()]);
            break;
          } catch (e) { if (e.code !== 'ER_DUP_ENTRY' || retry === 4) throw e; }
        }
        p = await payment(c, inserted.insertId); g.active_payment_id = p.id;
        await c.execute('UPDATE payment_order_guards SET active_payment_id=?,version=version+1,updated_at=? WHERE biz_type=? AND biz_order_no=?', [p.id, clock(), ...id]);
        await enqueue(c, 'pay_create', p.id, { sent: false });
      } else replay = true;
      // Bind even reused attempts. A retry of this request can never create a replacement attempt.
      const out = await status(c, g, p, replay);
      await c.execute("UPDATE payment_requests SET payment_order_id=COALESCE(payment_order_id,?),response_json=? WHERE actor_id=? AND operation='create_payment' AND request_key=?", [p?.id || null, JSON.stringify({ order_pay_status: out.order_pay_status }), String(account.id), key]);
      return out;
    }, existing);
  }
  async function getStatus(input, existing) {
    return tx(async c => {
      const g = await guard(c, input); owned(g, input.accountId);
      let p = await payment(c, g.paid_payment_id || g.active_payment_id);
      if (!p) p = (await rows(c, 'SELECT * FROM payment_orders WHERE biz_type=? AND biz_order_no=? ORDER BY id DESC LIMIT 1', identity(input)))[0];
      if (!g.paid_payment_id && g.lifecycle === 'open' && expired(g.expires_at, now())) await closeGuard(c, g, 'expired', false);
      if (input.refresh && p && ACTIVE.includes(p.pay_status)) await enqueue(c, 'pay_query', p.id);
      return status(c, g, p);
    }, existing);
  }
  async function markClosing(c, g, p, reason) {
    if (['paid', 'closed'].includes(p.pay_status)) return;
    await c.execute("UPDATE payment_orders SET pay_status='closing',close_reason=?,updated_at=?,version=version+1 WHERE id=? AND pay_status NOT IN ('paid','closed')", [reason, clock(), p.id]);
    p.pay_status = 'closing'; p.close_reason = reason;
    await enqueue(c, 'pay_close', p.id);
  }
  async function finishClosed(c, g) {
    if (g.lifecycle !== 'closing' || g.paid_payment_id) return;
    const [count] = await rows(c, "SELECT COUNT(*) n FROM payment_orders WHERE biz_type=? AND biz_order_no=? AND pay_status NOT IN ('closed','paid')", [g.biz_type, g.biz_order_no]);
    if (Number(count.n)) return;
    g.lifecycle = 'closed'; g.active_payment_id = null;
    await c.execute("UPDATE payment_order_guards SET lifecycle='closed',active_payment_id=NULL,version=version+1,updated_at=? WHERE biz_type=? AND biz_order_no=? AND paid_payment_id IS NULL", [clock(), g.biz_type, g.biz_order_no]);
    await emit(c, g, 'order.closed', `closed:${g.biz_type}:${g.biz_order_no}`, { reason: g.snapshot.closeReason || 'closed' });
  }
  async function closeGuard(c, g, reason, reopen) {
    if (g.paid_payment_id) return; // Cancellation of a paid order is an explicit refund, never a reopening.
    if (!reopen && g.lifecycle !== 'closed') {
      g.lifecycle = 'closing'; g.snapshot.closeReason = reason;
      await c.execute("UPDATE payment_order_guards SET lifecycle='closing',snapshot=?,version=version+1,updated_at=? WHERE biz_type=? AND biz_order_no=?", [JSON.stringify(g.snapshot), clock(), g.biz_type, g.biz_order_no]);
    }
    const ps = await rows(c, "SELECT * FROM payment_orders WHERE biz_type=? AND biz_order_no=? AND pay_status NOT IN ('paid','closed') ORDER BY id FOR UPDATE", [g.biz_type, g.biz_order_no]);
    for (const p of ps) await markClosing(c, g, p, reason);
    await finishClosed(c, g);
  }
  async function requestClose(input, existing) {
    return tx(async c => {
      const g = await guard(c, input); if (input.accountId != null) owned(g, input.accountId);
      await closeGuard(c, g, String(input.reason || 'cancelled').slice(0, 32), input.reopen === true);
      return status(c, g, await payment(c, g.paid_payment_id || g.active_payment_id));
    }, existing);
  }
  async function refundInTransaction(c, g, p, input) {
    assert(p && p.pay_status === 'paid', '原支付尚未成功', 409, 'payment_not_paid');
    const amount = minor(input.amountMinor), key = String(input.requestKey || '');
    assert(key.length >= 8 && key.length <= 128, '退款幂等标识无效', 422);
    const old = (await rows(c, 'SELECT * FROM payment_refunds WHERE idempotency_key=? FOR UPDATE', [key]))[0];
    if (old) {
      assert(String(old.payment_order_id) === String(p.id) && Number(old.amount_minor) === amount, '退款幂等请求冲突', 409, 'refund_idempotency_conflict');
      if (old.refund_status !== 'refunded') {
        const [job] = await rows(c, 'SELECT payload FROM payment_jobs WHERE job_key=?', [`refund_create:${old.id}`]);
        await enqueue(c, job && !parse(job.payload).sent ? 'refund_create' : 'refund_query', old.id);
      }
      return old;
    }
    const [sum] = await rows(c, "SELECT COALESCE(SUM(amount_minor),0) reserved FROM payment_refunds WHERE payment_order_id=? AND refund_status<>'voided'", [p.id]);
    assert(Number(sum.reserved) + amount <= Number(p.amount_minor), '退款累计金额超过实付金额', 409, 'refund_limit');
    await guardSharedRefund(c,g,p,input,amount,key);
    let insert;
    for (let i = 0; i < 5; i++) {
      try {
        [insert] = await c.execute(`INSERT INTO payment_refunds(payment_order_id,biz_type,biz_order_no,app_order_id,idempotency_key,refund_reason_type,trigger_source,refund_amount,amount_minor,payer_ucid,merchant_no,refund_status,retry_count,next_retry_at,version,reference_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'refunding',0,?,0,?,?,?)`,
        [p.id, g.biz_type, g.biz_order_no, generateAppOrderId('RF', new Date(now())), key, String(input.reason || 'refund').slice(0, 32), String(input.source || 'system').slice(0, 32), toAmount(amount), amount, p.payer_ucid, p.merchant_no, clock(), JSON.stringify(input.reference || {}), clock(), clock()]);
        break;
      } catch (e) { if (e.code !== 'ER_DUP_ENTRY' || i === 4) throw e; }
    }
    await enqueue(c, 'refund_create', insert.insertId, { sent: false });
    return (await rows(c, 'SELECT * FROM payment_refunds WHERE id=?', [insert.insertId]))[0];
  }
  async function guardSharedRefund(c,g,p,input,amount,key) {
    // Legacy payment-only installations have no shared ledger. Once a receipt is
    // admitted to shared settlement, every refund route uses the SAME source.
    const [installed]=await rows(c,"SELECT 1 present FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='commerce_funding_sources'");
    if(!installed){assert(!input.reference?.execution_order_id && !g.snapshot.settlement_profile,'共享退款模块尚未安装',409,'settlement_refund_invalid');return;}
    const sources=await rows(c,'SELECT * FROM commerce_funding_sources WHERE payment_id=? ORDER BY id FOR UPDATE',[String(p.id)]);
    if(!sources.length){assert(!input.reference?.execution_order_id,'执行退款没有原资金来源',409,'settlement_refund_invalid');assert(!g.snapshot.settlement_profile || String(g.paid_payment_id)!==String(p.id),'受控支付正在登记资金来源，请稍后退款',409,'settlement_source_pending');return;}
    assert(sources.length===1,'同一支付重复登记资金来源，退款暂停核验',409,'settlement_source_conflict');
    const source=sources[0];assert(['AVAILABLE','CONFIRMED'].includes(String(source.status).toUpperCase()),'原资金来源已冻结',409,'settlement_source_frozen');
    const hasExecution=(await rows(c,"SELECT 1 present FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='commerce_execution_refund_plans'"))[0];
    if(hasExecution) {
      const [registered]=await rows(c,'SELECT order_id FROM commerce_execution_refund_plans WHERE request_key=?',[key]);
      assert(!registered || String(input.reference?.execution_order_id)===registered.order_id,'共享退款请求号只能由对应批准的执行计划使用',409,'settlement_refund_invalid');
    }
    let approvedAllowance=0n;
    if(input.reference?.execution_order_id) {
      assert(hasExecution,'共享逆向执行模块尚未安装',409,'settlement_refund_invalid');
      const [approved]=await rows(c,`SELECT o.*,r.request_key,r.amount_minor refund_amount,r.source_reserved,r.refund_input
       FROM commerce_execution_orders o JOIN commerce_execution_refund_plans r ON r.order_id=o.id WHERE o.id=? FOR UPDATE`,[input.reference.execution_order_id]);
      assert(approved && approved.operation==='REFUND' && approved.status==='SUBMITTING' && approved.approved_by && approved.approved_by!==approved.created_by && Number(approved.source_reserved)===1 && approved.source_id===source.id && approved.context_id===input.reference.context_id && approved.request_key===key && BigInt(approved.refund_amount)===BigInt(amount),'执行退款必须精确对应已双人批准、已预占的原支付退款计划',409,'settlement_refund_invalid');
      const frozen=parse(approved.refund_input);
      assert(String(frozen.paymentId)===String(p.id) && frozen.requestKey===key && Number(frozen.amountMinor)===amount && BigInt(source.reserved_minor)>=BigInt(amount),'执行退款预占或请求快照不匹配',409,'settlement_refund_invalid');
      approvedAllowance=BigInt(amount);
    }
    const refunds=await rows(c,"SELECT * FROM payment_refunds WHERE payment_order_id=? AND refund_status<>'voided' ORDER BY id",[p.id]);
    const [hasUnits]=await rows(c,"SELECT 1 present FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='commerce_settlement_units'");
    if(hasUnits){const units=await rows(c,"SELECT calculation FROM commerce_settlement_units WHERE source_id=? AND status='CONFIRMED' ORDER BY id FOR UPDATE",[source.id]);const committed=units.reduce((sum,u)=>{const value=parse(u.calculation);return sum+BigInt(value.merchant_minor)+BigInt(value.commission_minor);},0n), priorRefunds=refunds.reduce((sum,r)=>sum+BigInt(r.amount_minor),0n);assert(BigInt(source.received_minor)-committed-priorRefunds>=BigInt(amount),'已确认履约义务尚未撤销，不可占用该款给消费者退款',409,'settlement_refund_obligation_active');}
    let successful=0n,inFlightSuccess=0n,unreservedPending=0n;
    for(const refund of refunds) {
      const [execution]=hasExecution?await rows(c,'SELECT r.source_reserved,o.status FROM commerce_execution_refund_plans r JOIN commerce_execution_orders o ON o.id=r.order_id WHERE r.request_key=? AND o.source_id=?',[refund.idempotency_key,source.id]):[];
      const reserved=execution && Number(execution.source_reserved)===1 && !['SUCCEEDED','FAILED_FINAL','CANCELLED'].includes(execution.status);
      if(refund.refund_status==='refunded'){successful+=BigInt(refund.amount_minor);if(reserved)inFlightSuccess+=BigInt(refund.amount_minor);}
      else if(!reserved)unreservedPending+=BigInt(refund.amount_minor);
    }
    const notReflected=successful-BigInt(source.returned_minor)-inFlightSuccess;
    const available=BigInt(source.received_minor)-BigInt(source.consumed_minor)-BigInt(source.reserved_minor)-BigInt(source.returned_minor)-(notReflected>0n?notReflected:0n)-unreservedPending+approvedAllowance;
    assert(available>=BigInt(amount),'原支付可退资金已用于分账或被预占，请先回退或批准自有资金垫付',409,'settlement_refund_funds_unavailable');
  }
  async function requestRefund(input, existing) {
    return tx(async c => {
      const g = await guard(c, input); if (input.accountId != null) owned(g, input.accountId);
      const p = await payment(c, input.paymentId || g.paid_payment_id);
      assert(p && p.biz_type === g.biz_type && p.biz_order_no === g.biz_order_no, '退款支付归属不匹配', 409);
      const r = await refundInTransaction(c, g, p, input);
      return { id: r.id, refund_id: r.id, payment_id: p.id, refund_status: r.refund_status, amount_minor: Number(r.amount_minor), app_order_id: r.app_order_id };
    }, existing);
  }
  async function consumeEvents(bizType, handler, limit = 25, filter = {}) {
    assert(['booking', 'jiazheng', 'commerce'].includes(bizType) && typeof handler === 'function', '支付事件消费者无效', 422);
    const orderNo = filter.orderId == null ? null : normalizeBizOrderNo(bizType, filter.orderId);
    let processed = 0;
    for (let i = 0; i < Math.min(limit, 100); i++) {
      let selected;
      try {
        const found = await tx(async c => {
          const [e] = await rows(c, `SELECT e.* FROM payment_events e WHERE e.biz_type=? AND e.status<>'processed' AND e.next_run_at<=?
            ${orderNo == null ? '' : 'AND e.biz_order_no=?'}
            AND NOT EXISTS(SELECT 1 FROM payment_events p WHERE p.biz_type=e.biz_type AND p.biz_order_no=e.biz_order_no AND p.id<e.id AND p.status<>'processed') ORDER BY e.id LIMIT 1`, [bizType, clock(), ...(orderNo == null ? [] : [orderNo])]);
          if (!e) return false;
          selected = e;
          const g = await guard(c, { bizType, orderId: e.biz_order_no });
          const [current] = await rows(c, "SELECT * FROM payment_events WHERE id=? FOR UPDATE", [e.id]);
          if (current.status === 'processed' || sqlDate(current.next_run_at) > clock()) return true;
          current.payload = parse(current.payload);
          await handler(c, current, g);
          await c.execute("UPDATE payment_events SET status='processed',processed_at=?,last_error=NULL WHERE id=?", [clock(), e.id]);
          processed++; return true;
        });
        if (!found) break;
      } catch (error) {
        if (!selected) throw error;
        await tx(async c => { await c.execute("UPDATE payment_events SET status='failed',attempts=attempts+1,next_run_at=?,last_error=? WHERE id=? AND status<>'processed'", [due(Math.min(300, 2 ** Math.min(Number(selected.attempts) + 1, 8))), String(error.code || error.message).slice(0, 500), selected.id]); });
        logger.warn('payment event deferred:', selected.id, error.code || error.message);
      }
    }
    return { processed };
  }
  const internals = { config, payCenter, logger, now, clock, due, tx, rows, close, createConnection, guard, payment, enqueue, emit, finishClosed, closeGuard, refundInTransaction, jobHandlers };
  const worker = require('./worker.cjs').createWorker(internals);
  return { registerOrder, createIntent, getStatus, requestClose, requestRefund, consumeEvents, ...worker, transaction: tx, enqueueJob: enqueue };
}

module.exports = { createPaymentCore, ...P };
