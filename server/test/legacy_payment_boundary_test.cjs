'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiDirectRouter } = require('../routes/api_direct.cjs');
const { isExternalOrder } = require('../payment/vendor-payment.cjs');
const vendorApi = require('../../vendor_api.cjs');
const hmac = require('../../hmac_auth.cjs');
const settlement = require('../../commerce/settlement.cjs');

test('legacy /jz/orders POST reaches the shared handler only after authorization and schema readiness', async () => {
  const steps = [];
  let allowed = true;
  const router = createApiDirectRouter({
    assertAdminAuthorized: async () => { steps.push('admin'); return true; },
    assertApiAuthorized: async () => { steps.push('account'); return allowed; },
    ensureSchema: async () => { steps.push('schema'); },
    handleJiazhengRoutes: async (path, _qs, req, res) => {
      steps.push(path); assert.equal(req.body.address, 'fixture address'); res.status = 201;
    },
    jsonReply: () => assert.fail('The known legacy route must not fall through'),
  });
  const req = { method: 'POST', body: { product_id: 1, address: 'fixture address' } }, res = {};
  await router('/api/juzhu/jz/orders', '', req, res);
  assert.equal(res.status, 201);
  assert.deepEqual(steps, ['admin', 'account', 'schema', '/api/juzhu/jz/orders']);
  allowed = false; steps.length = 0;
  await router('/api/juzhu/jz/orders', '', req, {});
  assert.deepEqual(steps, ['admin', 'account']);
});

const legacyExternal = { order_ref: 'GR202610021000000001', vendor_id: 41, sku: '99', payment_mode: null, biz_type: null, status: 'pending' };
test('old customer /jz/orders/:id preserves yuan and address fields without exposing payment routing', async () => {
  let accountId = 'owner';
  const original = { id: 'WO-fixture', account_id: 'owner', payment_mode: 'pay_center', fee: 12900,
    house: 'fixture address', expect_time: '2099-10-03 10:00', payment_config_snapshot: '{"productTitle":"旧商品","merchantNo":"fixture"}',
    request_key: 'private-key', request_hash: 'private-hash' };
  const router = createApiDirectRouter({
    ADMIN_PREFIX: '/api/juzhu/admin', assertAdminAuthorized: async () => true, assertApiAuthorized: async () => true,
    handleBookingRoutes: async () => false,
    ensureSchema: async () => {}, requestSession: async () => ({ role: 'user', account: { id: accountId } }),
    requireApiKey: () => assert.fail('An authenticated customer must not need an operator key'),
    queryRows: async (sql, args) => { assert.match(sql, /o\.account_id=\?/); return args[1] === original.account_id ? [original] : []; },
    jsonReply: (res, body, status = 200) => Object.assign(res, { body, status }),
  });
  const owned = {}; await router('/api/juzhu/jz/orders/WO-fixture', '', { method: 'GET' }, owned);
  assert.equal(owned.status, 200, JSON.stringify(owned.body)); assert.equal(owned.body.fee, 129); assert.equal(owned.body.amount_minor, 12900);
  assert.equal(owned.body.address, original.house); assert.equal(owned.body.scheduled_at, original.expect_time);
  assert.equal(owned.body.product_title, '旧商品');
  assert.equal(owned.body.payment_config_snapshot, undefined); assert.equal(owned.body.request_key, undefined); assert.equal(owned.body.request_hash, undefined);
  accountId = 'another';
  const other = {}; await router('/api/juzhu/jz/orders/WO-fixture', '', { method: 'GET' }, other);
  assert.equal(other.status, 404);
  assert.equal(original.fee, 12900, 'The stored and management amount remains minor units');
});

test('unmarked historic mini-program orders remain external without consulting a changed/deleted product', () => {
  assert.equal(isExternalOrder(legacyExternal), true);
  assert.equal(isExternalOrder({ ...legacyExternal, payment_mode: 'wechat_mini' }), true);
  for (const patch of [{ payment_mode: 'pay_center' }, { biz_type: 'commerce' }, { sku: 'commerce:plans' },
    { order_ref: 'WO-internal' }, { vendor_id: null }, { sku: '' }, { payment_mode: 'unknown' }]) {
    assert.equal(isExternalOrder({ ...legacyExternal, ...patch }), false, JSON.stringify(patch));
  }
});

test('the old signed vendor callback keeps code/message, fee units and lailai_oid alias', async () => {
  let order = { ...legacyExternal }, updates = 0, transaction = null, commits = 0;
  const conn = {
    beginTransaction:async()=>{assert.equal(transaction,null);transaction={...order};},
    commit:async()=>{assert.ok(transaction);transaction=null;commits++;},
    rollback:async()=>{if(transaction)order=transaction;transaction=null;},
    execute: async (sql, values) => {
    if (sql.startsWith('SELECT status, review_status')) return [[{ status: 'active', review_status: 'approved' }]];
    if (sql.startsWith('SELECT * FROM gr_orders')) return [[order]];
    if (/UPDATE gr_orders/.test(sql)) {
      updates++; assert.equal(values[3], 12900, 'Existing callback fee is already minor units');
      order = { ...order, vendor_oid: values[1], status: values[2], fee: values[3] };
      return [{ affectedRows: 1 }];
    }
    assert.fail('Unexpected query: ' + sql);
  } };
  const key = 'isolated-legacy-vendor-key';
  const body = hmac.generateSignature(key, { vendor_id: 41, order_ref: order.order_ref, lailai_oid: 'old-provider-order', status: 'paid', fee: 12900 });
  const vendors = { 41: { key } };
  assert.deepEqual(await vendorApi.handleRequest('/api/juzhu/callback', body, conn, vendors), { status: 200, data: { code: 0, message: 'success' } });
  assert.equal(order.vendor_oid, 'old-provider-order'); assert.equal(updates, 1);assert.equal(commits,1);assert.equal(transaction,null);
  order.payment_mode = 'pay_center';
  assert.equal((await vendorApi.handleRequest('/api/juzhu/callback', body, conn, vendors)).status, 403);
  order.payment_mode = null; order.vendor_id = 42;
  assert.equal((await vendorApi.handleRequest('/api/juzhu/callback', body, conn, vendors)).status, 404);
  assert.equal((await vendorApi.handleRequest('/api/juzhu/callback', { ...body, sign: 'invalid' }, conn, vendors)).status, 401);
  assert.equal(updates, 1);
});

function refundService(instrument) {
  const calls = [], principal = { account: { id: 1 } };
  const service = {
    pool: {},
    get: async (_pool, sql) => {
      if (sql.includes('commerce_refund_orders')) return [{ payment_mode: 'pay_center' }];
      if (sql.includes('payment_jobs')) return [{ attempts: 4 }];
      assert.fail(sql);
    },
    payments: { executeRefund: async (id, options) => {
      calls.push({ id, ...options }); return { id, payment_refund_id: 99, request_no: 'old-request-no', retry_count: 2, ...instrument };
    } },
    tx: () => assert.fail('A real refund must never fall through to the sandbox provider'),
  };
  return { service, calls, principal };
}

test('real refund execution preserves v1 request_no/submit/instrument envelope', async () => {
  const { service, calls, principal } = refundService({ status: 'submitted' });
  const out = await settlement.refundAction(service, principal, 7, 'execute', {});
  assert.equal(out.id, 7); assert.equal(out.request_no, 'old-request-no');
  assert.equal(out.submit, 'processing'); assert.equal(out.instrument.status, 'submitted');
  assert.equal(out.payment_refund_id, 99); assert.equal(calls[0].action, 'execute');
  assert.equal(calls[0].principal, principal);
});

test('real refund query preserves v1 remote_status/instrument/query_count and invokes only query action', async () => {
  const { service, calls, principal } = refundService({ status: 'unknown' });
  const out = await settlement.queryInstrument(service, principal, 'refund', 7);
  assert.equal(out.request_no, 'old-request-no'); assert.equal(out.remote_status, 'processing');
  assert.equal(out.instrument.status, 'unknown'); assert.equal(out.query_count, 4);
  assert.equal(calls[0].action, 'query');
});

test('real refund retry preserves v1 retry_count/instrument and successful state never comes from a fake submit', async () => {
  const { service, calls, principal } = refundService({ status: 'submitted' });
  const out = await settlement.retryInstrument(service, principal, 'refund', 7);
  assert.equal(out.request_no, 'old-request-no'); assert.equal(out.retry_count, 2);
  assert.equal(out.instrument.status, 'submitted'); assert.equal(calls[0].action, 'retry');
  const paid = refundService({ status: 'paid' });
  assert.equal((await settlement.refundAction(paid.service, paid.principal, 7, 'execute', {})).submit, 'paid');
});

test('refund compatibility propagates authoritative state failures without claiming success', async () => {
  const { service, principal } = refundService({ status: 'submitted' });
  service.payments.executeRefund = async () => { const e = new Error('not a submitted refund'); e.status = 409; e.code = 'instrument_state'; throw e; };
  await assert.rejects(settlement.queryInstrument(service, principal, 'refund', 7), { status: 409, code: 'instrument_state' });
});
