'use strict';

// The commerce process only persists payment work. Only the main payment worker
// calls the gateway; received money and issued entitlements remain separate facts.
const { assert } = require('./configuration.cjs');
const { isDemo } = require('./guiyang-demo.cjs');
const demoOrder = value => isDemo(value) || value?.is_demo === true;
const main = require('./main-system.cjs');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const uuid = value => {
  const text = String(value || '').toLowerCase();
  if (/^[a-f0-9]{32}$/.test(text)) return `${text.slice(0,8)}-${text.slice(8,12)}-${text.slice(12,16)}-${text.slice(16,20)}-${text.slice(20)}`;
  assert(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(text), '订单编号无效');
  return text;
};
const compact = value => uuid(value).replace(/-/g, '');

function settings(config) {
  return {
    enabled: config.COMMERCE_PAY_ENABLED === '1' && config.PAY_NEW_INTENTS_ENABLED !== '0',
    collectionMode: config.COMMERCE_COLLECTION_MODE,
    merchantNo: config.COMMERCE_PAY_MERCHANT_NO,
    appCode: config.COMMERCE_PAY_APP_CODE,
    projectCode: config.COMMERCE_PAY_PROJECT_CODE,
    shareBizCode: config.COMMERCE_PAY_SHARE_BIZ_CODE,
    callbackUrl: config.COMMERCE_PAY_NOTIFY_URL,
    configVersion: Number(config.COMMERCE_PAY_CONFIG_VERSION || 1),
  };
}
function configured(value) {
  return value.enabled && value.collectionMode === 'platform' &&
    ['merchantNo','appCode','projectCode','shareBizCode','callbackUrl'].every(key => typeof value[key] === 'string' && value[key].length > 0) &&
    /^https:\/\//.test(value.callbackUrl) && Number.isSafeInteger(value.configVersion) && value.configVersion > 0;
}
function pooledConnection(pool) {
  return async () => {
    const conn = await pool.getConnection();
    return {
      execute: conn.execute.bind(conn), query: conn.query.bind(conn),
      beginTransaction: conn.beginTransaction.bind(conn), commit: conn.commit.bind(conn), rollback: conn.rollback.bind(conn),
      end: async () => conn.release(),
    };
  };
}

function createPaymentAdapter({ service, core, config = process.env, sharedDatabaseVerified = false, logger = console }) {
  const policy = settings(config);
  let readyPromise;
  async function ready() {
    if (!readyPromise) readyPromise = (async () => {
      if (!core) return false;
      if (sharedDatabaseVerified) return true; // Explicit dependency injection in isolated tests.
      const expected = config.MYSQL_DB || config.JUZHU_DB_NAME;
      if (!expected || (config.COMMERCE_DB_NAME && config.COMMERCE_DB_NAME !== expected)) return false;
      const [[database]] = await service.pool.execute('SELECT DATABASE() AS name');
      if (database.name !== expected) return false;
      const [tables] = await service.pool.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('payment_order_guards','payment_requests','payment_jobs','payment_events')");
      if (tables.length !== 4) return false;
      const [[migration]] = await service.pool.execute('SELECT COUNT(*) n FROM payment_migrations WHERE version=?', [require('../server/payment/migrate.cjs').VERSION]);
      return Number(migration.n) === 1;
    })().catch(error => { readyPromise = null; logger.warn('Commerce payment readiness failed:', error.code || error.name); return false; });
    const result = await readyPromise;
    if (!result) readyPromise = null;
    return result;
  }
  async function capability() { return !!(configured(policy) && await ready()); }
  function actor(p) {
    assert(p?.account?.id && p.account.idp_type === 'beike' && p.account.idp_subject, '请使用贝壳账号登录后支付', 403, 'payment_identity_required');
  }
  async function owned(p, orderId, c = service.pool, lock = false) {
    const [order] = await service.get(c, `SELECT * FROM commerce_orders WHERE id=? AND account_id=?${lock?' FOR UPDATE':''}`, [uuid(orderId), p.account.id]);
    assert(order, '订单不存在或无权查看', 404);
    assert(order.payment_mode === 'pay_center' && !demoOrder(parse(order.snapshot)), '该订单不支持真实支付', 409);
    return order;
  }
  async function guardLock(c, orderId) {
    const [guard] = await service.get(c, 'SELECT * FROM payment_order_guards WHERE biz_type=? AND biz_order_no=? FOR UPDATE', ['commerce', compact(orderId)]);
    assert(guard, '支付订单尚未登记', 409);
    return guard;
  }
  async function purchase(p, input, key) {
    assert(await capability(), '购买暂未开放，请关注开售通知', 409, 'payment_unavailable');
    actor(p);
    return service.reserveOrder(p, input, key, { live: true, register: async (c, order) => {
      const snapshot = { ...order.snapshot, payment: { collection_mode: policy.collectionMode, config_version: policy.configVersion } };
      const settlementProfiles = await require('../server/settlement/business.cjs').captureCommerceProfiles(c, order, config);
      if(settlementProfiles)assert(Object.values(settlementProfiles)[0].collection.source_merchant_no===policy.merchantNo,'收银台收款配置与结算协议不一致',409);
      if (settlementProfiles) snapshot.settlement_profiles = settlementProfiles;
      await core.registerOrder(c, {
        bizType: 'commerce', orderId: order.id, accountId: p.account.id, amountMinor: order.amount_minor,
        merchantNo: policy.merchantNo, payerUcid: p.account.idp_subject, payerUserType: '2',
        appCode: policy.appCode, projectCode: policy.projectCode, shareBizCode: policy.shareBizCode,
        callbackUrl: policy.callbackUrl, expiresAt: order.expires_at, title: snapshot.name || '新居住生活权益',
        configVersion: policy.configVersion, snapshot: { collection_mode: policy.collectionMode, product_kind: order.product_kind, product_version: input.version, ...(settlementProfiles ? { settlement_profile: Object.values(settlementProfiles)[0] } : {}) },
      });
      await c.execute("UPDATE commerce_orders SET payment_mode='pay_center',stock_status='reserved',snapshot=? WHERE id=?", [JSON.stringify(snapshot), order.id]);
      order.snapshot = snapshot; order.payment_mode = 'pay_center';
    }});
  }
  async function pay(p, orderId, input, key, clientIp) {
    assert(await capability(), '当前暂不支持发起付款，请稍后重试', 409, 'payment_unavailable');
    actor(p); await owned(p, orderId);
    return core.createIntent({ bizType: 'commerce', orderId: uuid(orderId), account: p.account, requestKey: key, cashierType: String(input.cashier_type || '2'), clientIp });
  }
  async function status(p, orderId, refresh = false) {
    assert(await ready(), '支付服务暂时不可用', 503);
    const order = await owned(p, orderId);
    const payment = await core.getStatus({ bizType: 'commerce', orderId: order.id, accountId: p.account.id, refresh });
    return { ...payment, order_id: order.id, amount_minor: Number(order.amount_minor), expires_at: order.expires_at,
      fulfillment_status: order.fulfillment_status, commerce_status: order.status,
      order_url: '/juzhu-commerce.html?view=orders&order=' + encodeURIComponent(order.id) };
  }
  async function close(p, orderId, reason = 'customer_cancel') {
    assert(await ready(), '支付服务暂时不可用', 503);
    await owned(p, orderId);
    return core.requestClose({ bizType: 'commerce', orderId: uuid(orderId), accountId: p.account.id, reason, reopen: false });
  }
  async function expireOrder(orderId) {
    if (!await ready()) return false; // Keep stock until payment closure is known.
    await core.requestClose({ bizType: 'commerce', orderId: uuid(orderId), reason: 'commerce_expired', reopen: false });
    return true;
  }
  async function postOnce(c, sourceType, sourceId, lines) {
    const [old] = await service.get(c, 'SELECT id FROM commerce_ledger_entries WHERE source_type=? AND source_id=? LIMIT 1', [sourceType, String(sourceId)]);
    if (old) return false;
    await require('./settlement.cjs').post(c, { sourceType, sourceId: String(sourceId), lines, memo: sourceType + ' ' + sourceId });
    return true;
  }
  async function refundEvent(c, order, event, payload) {
    const refundId = payload.refundId || payload.refund_id;
    const paymentId = Number(payload.paymentId || payload.payment_id);
    const amount = Number(payload.amountMinor ?? payload.amount_minor);
    assert(Number.isSafeInteger(amount) && amount > 0 && refundId, '退款事件金额无效', 409);
    const sharedRefund = await require('../server/settlement/business.cjs').onRefundSucceeded(c,{biz_type:'commerce',order,payload});
    const [refund] = await service.get(c, 'SELECT * FROM commerce_refund_orders WHERE payment_refund_id=? FOR UPDATE', [refundId]);
    if (refund) {
      assert(refund.order_id === order.id && refund.payment_mode === 'pay_center' && Number(refund.amount_minor) === amount, '退款事件与权益退款不一致', 409);
      if (refund.status === 'paid') return;
      const coupon = await service.coupon(c, refund.coupon_id);
      assert(coupon.status === 'frozen', '退款卡券状态冲突', 409);
      await c.execute("UPDATE commerce_refund_orders SET status='paid',settled_at=UTC_TIMESTAMP(),fail_reason=NULL WHERE id=?", [refund.id]);
      await c.execute("UPDATE commerce_coupons SET status='refunded',token_hash=NULL,token_expires_at=NULL WHERE id=?", [coupon.id]);
      await c.execute("UPDATE commerce_cases SET status='closed',resolution=CONCAT_WS(' / ',NULLIF(resolution,''),'原路退款已由支付机构确认') WHERE id=?", [refund.case_id]);
      await main.resolveWork(c, refund.case_id, '原路退款已由支付机构确认');
      if(!sharedRefund)await postOnce(c, 'refund', refund.refund_no, [{side:'debit',account:'unredeemed_liability',amount},{side:'credit',account:'provider_refund_out',amount}]);
    } else {
      // Late/duplicate payments need a refund even though no coupon was issued.
      assert(sharedRefund||['late_pay','duplicate_pay','fulfillment_failed'].includes(payload.reason), '退款缺少可核对的权益退款指令', 409);
      if (!sharedRefund&&!await postOnce(c, 'payment_refund', refundId, [{side:'debit',account:'payment_pending_liability',amount},{side:'credit',account:'provider_refund_out',amount}])) return;
    }
    if (refund || (!order.paid_payment_order_id && order.status !== 'refunded') || Number(order.paid_payment_order_id) === paymentId) {
      const total = Number(order.refunded_minor || 0) + amount;
      assert(total <= Number(order.amount_minor), '退款金额超过业务实收', 409);
      const full = total === Number(order.amount_minor);
      await c.execute('UPDATE commerce_orders SET refunded_minor=?,payment_status=?,status=?,fulfillment_status=? WHERE id=?', [total,full?'refunded':'partially_refunded',full?'refunded':order.status,full?'refunded':order.fulfillment_status,order.id]);
      if (full) await c.execute('UPDATE commerce_memberships SET expires_at=LEAST(expires_at,UTC_TIMESTAMP()) WHERE order_id=?', [order.id]);
      await main.linkOrder(c, {...order, status:full?'refunded':order.status, payment_status:full?'refunded':'partially_refunded'});
    }
  }
  async function handleEvent(c, event, guard) {
    const orderId = uuid(event.biz_order_no || event.order_id || guard.biz_order_no);
    const [order] = await service.get(c, 'SELECT * FROM commerce_orders WHERE id=? FOR UPDATE', [orderId]);
    assert(order && order.payment_mode === 'pay_center' && !demoOrder(parse(order.snapshot)), '权益支付事件关联无效', 409);
    const payload = parse(event.payload || event.payload_json || {}), paymentId = Number(payload.paymentId || payload.payment_id), amount = Number(payload.amountMinor ?? payload.amount_minor);
    if (event.event_type === 'payment.received') {
      assert(Number.isSafeInteger(paymentId) && paymentId > 0 && amount === Number(order.amount_minor), '到账事件与订单金额不一致', 409);
      if (!await postOnce(c, 'payment_received', paymentId, [{side:'debit',account:'provider_receivable',amount},{side:'credit',account:'payment_pending_liability',amount}])) return;
      if (payload.accepted === true && Number(guard.paid_payment_id) === paymentId) {
        await c.execute("UPDATE commerce_orders SET payment_status='paid',paid_payment_order_id=?,paid_at=COALESCE(paid_at,UTC_TIMESTAMP()),status=IF(status='reserved','paid_pending_fulfillment',status),fulfillment_status=IF(fulfillment_status='unfulfilled','pending',fulfillment_status) WHERE id=?", [paymentId,order.id]);
        await main.linkOrder(c,{...order,status:order.status==='reserved'?'paid_pending_fulfillment':order.status,payment_status:'paid'});
      } else if (!order.paid_payment_order_id) {
        await c.execute("UPDATE commerce_orders SET payment_status='refund_pending' WHERE id=?", [order.id]);
        await main.linkOrder(c,{...order,payment_status:'refund_pending'});
      }
      return;
    }
    if (event.event_type === 'payment.accepted') {
      assert(Number(guard.paid_payment_id) === paymentId && amount === Number(order.amount_minor), '有效支付事件不匹配', 409);
      if (order.status === 'refunded' && Number(order.paid_payment_order_id) === paymentId) return;
      await require('../server/settlement/business.cjs').onPaymentAccepted(c,{biz_type:'commerce',order,guard});
      await service.fulfillPaidOrder(order.id, 'payment:' + paymentId, amount, { connection:c, verified:true, fundingRecorded:true });
      await c.execute("UPDATE commerce_orders SET payment_status='paid',paid_payment_order_id=?,paid_at=COALESCE(paid_at,UTC_TIMESTAMP()),fulfillment_status='fulfilled',stock_status='granted' WHERE id=?", [paymentId,order.id]);
      await main.linkOrder(c, {...order,status:'fulfilled',payment_status:'paid'});
      return;
    }
    if (event.event_type === 'order.closed') {
      if (guard.paid_payment_id || order.stock_status !== 'reserved') return;
      const items = await service.get(c, 'SELECT sku_id,quantity FROM commerce_order_items WHERE order_id=? ORDER BY sku_id', [order.id]);
      for (const item of items) {
        const [changed] = await c.execute('UPDATE commerce_inventory SET reserved=reserved-? WHERE sku_id=? AND reserved>=?', [item.quantity,item.sku_id,item.quantity]);
        assert(changed.affectedRows, '库存释放状态冲突', 409);
      }
      const state = order.status === 'refunded' ? 'refunded' : /expir/.test(payload.reason || guard.close_reason || '') ? 'expired' : 'cancelled';
      const paymentStatus = ['refund_pending','refunded'].includes(order.payment_status) ? order.payment_status : 'closed';
      await c.execute("UPDATE commerce_orders SET status=?,payment_status=?,stock_status='released' WHERE id=?", [state,paymentStatus,order.id]);
      await main.linkOrder(c, {...order,status:state,payment_status:paymentStatus});
      return;
    }
    if (event.event_type === 'refund.succeeded') return refundEvent(c, order, event, payload);
    throw new Error('Unsupported commerce payment event');
  }
  async function executeRefund(refundId, { action = 'execute', principal } = {}) {
    assert(await ready(), '真实退款通道尚未就绪', 503);
    assert(['execute','query','retry'].includes(action), '退款操作无效', 404);
    const [peek] = await service.get(service.pool, 'SELECT order_id FROM commerce_refund_orders WHERE id=?', [refundId]);
    assert(peek, '退款指令不存在', 404);
    return service.tx(async c => {
      const guard = await guardLock(c, peek.order_id);
      const [order] = await service.get(c, 'SELECT * FROM commerce_orders WHERE id=? FOR UPDATE', [peek.order_id]);
      const [refund] = await service.get(c, 'SELECT * FROM commerce_refund_orders WHERE id=? FOR UPDATE', [refundId]);
      assert(order.payment_mode === 'pay_center' && refund.payment_mode === 'pay_center' && !demoOrder(parse(order.snapshot)), '该退款不属于真实支付', 409);
      const summary = state => ({id:refund.id,payment_refund_id:refund.payment_refund_id,status:state,request_no:refund.request_no,retry_count:Number(refund.retry_count||0)});
      if(action==='execute'&&refund.status==='paid')return summary('paid');
      if(action==='query')assert(['submitted','unknown'].includes(refund.status)&&refund.payment_refund_id, '只有已提交或结果未知且已登记原路退款的指令可以查单', 409, 'instrument_state');
      else if(action==='retry'){
        assert(refund.status==='failed', '只有明确失败的指令可以重试', 409, 'instrument_state');
        assert(Number(refund.retry_count||0)<3, '重试已达上限，请人工核实机构结果或关账', 409, 'retry_exhausted');
        assert(refund.payment_refund_id, '退款尚未登记，不允许作为失败指令重试', 409, 'instrument_state');
      } else assert(['pending','submitted','unknown'].includes(refund.status), '退款指令状态不支持执行', 409, 'refund_state');
      if(refund.payment_refund_id){
        const [original]=await service.get(c,'SELECT id,payment_order_id,biz_type,biz_order_no,idempotency_key,amount_minor FROM payment_refunds WHERE id=? FOR UPDATE',[refund.payment_refund_id]);
        assert(original&&original.biz_type==='commerce'&&original.biz_order_no===compact(order.id)&&Number(original.payment_order_id)===Number(guard.paid_payment_id)&&original.idempotency_key==='commerce-refund-'+refund.id&&Number(original.amount_minor)===Number(refund.amount_minor),'原路退款关联不一致，需先核实机构结果',409,'refund_identity_conflict');
      }
      const coupon = await service.coupon(c, refund.coupon_id);
      assert(coupon.status === 'frozen' && Number(coupon.allocation_minor) === Number(refund.amount_minor), '退款卡券或金额无效', 409);
      if(action==='retry'){
        await c.execute('UPDATE commerce_refund_orders SET retry_count=retry_count+1 WHERE id=?',[refund.id]);
        refund.retry_count=Number(refund.retry_count||0)+1;
      }
      const result = await core.requestRefund({bizType:'commerce',orderId:order.id,paymentId:guard.paid_payment_id,amountMinor:Number(refund.amount_minor),requestKey:'commerce-refund-'+refund.id,reason:refund.kind,source:'commerce',reference:{commerce_refund_id:refund.id,case_id:refund.case_id,coupon_id:refund.coupon_id}}, c);
      const id = result.refund_id || result.id;
      assert(id, '退款请求未建立', 503);
      assert(!refund.payment_refund_id||Number(refund.payment_refund_id)===Number(id),'退款请求不得更换原支付机构单号',409,'refund_identity_conflict');
      const state = result.refund_status === 'refund_failed' ? 'failed' : /unknown|manual_review/.test(result.refund_status || '') ? 'unknown' : 'submitted';
      await c.execute('UPDATE commerce_refund_orders SET payment_refund_id=?,status=?,submitted_at=COALESCE(submitted_at,UTC_TIMESTAMP()),fail_reason=NULL WHERE id=?', [id,state,refund.id]);
      refund.payment_refund_id=id;
      if(principal)await service.audit(c,principal,action==='execute'?'refund.execute':'settlement.'+action,refund.request_no,{type:'refund',payment_refund_id:id,status:state,retry:refund.retry_count||0},{city_id:refund.city_id,merchant_id:refund.merchant_id});
      return summary(state);
    });
  }
  async function queueExpiryRefunds(limit = 20) {
    if (!await ready()) return 0;
    const cases = await service.get(service.pool, `SELECT s.id,s.account_id,r.id refund_id FROM commerce_cases s
      JOIN commerce_coupons c ON c.id=s.coupon_id JOIN commerce_orders o ON o.id=c.order_id
      LEFT JOIN commerce_refund_orders r ON r.case_id=s.id
      WHERE s.kind='refund' AND s.status='awaiting_provider' AND o.payment_mode='pay_center'
        AND (r.id IS NULL OR r.status='pending') ORDER BY s.created_at LIMIT ${Math.max(1,Math.min(100,Number(limit)||20))}`);
    for (const entry of cases) {
      try {
        const refund = entry.refund_id ? {id:entry.refund_id} : await require('./settlement.cjs').createRefundOrder(service,{account:{id:entry.account_id}},{case_id:entry.id},'auto-refund-'+entry.id);
        await executeRefund(refund.id);
      } catch (error) { logger.warn('Commerce original-payment refund remains pending:',error.code||error.name); }
    }
    return cases.length;
  }
  async function consume(limit = 40) {
    if (!await ready()) return 0;
    return core.consumeEvents('commerce', handleEvent, limit);
  }
  return {ready,capability,purchase,pay,status,close,expireOrder,handleEvent,consume,executeRefund,queueExpiryRefunds,guardLock,policy};
}
module.exports = {createPaymentAdapter,settings,configured,pooledConnection,uuid,compact};
