'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorker } = require('../payment/worker.cjs');

// Protocol-only fixtures: no host configuration, database, gateway or network.
function fixture({ bizType = 'booking', kind = 'pay_query', query = { status: '30' }, create = { status: '30' }, refundQuery = { status: '30' } } = {}) {
  const p = { id: 1, biz_type: bizType, biz_order_no: 'fixture-order', app_order_id: 'XD_fixture', app_code: 'fixture-app',
    project_code: 'fixture-project', merchant_no: 'fixture-merchant', payer_ucid: 'fixture-payer', payer_user_type: '2',
    amount_minor: 10000, share_biz_code: 'fixture-share', cashier_type: '2', callback_url: 'https://invalid.example.test/notify',
    title: 'fixture', expires_at: '2099-01-01 00:00:00', pay_status: 'paying' };
  const r = { id: 2, payment_order_id: 1, biz_type: bizType, biz_order_no: p.biz_order_no, app_order_id: 'RF_fixture',
    amount_minor: 2500, refund_status: 'refunding', reference_json: {}, refund_reason_type: 'fixture', idempotency_key: 'fixture-refund' };
  const g = { biz_type: bizType, biz_order_no: p.biz_order_no, lifecycle: 'open', expires_at: p.expires_at, paid_payment_id: null };
  const job = { id: 3, kind, target_id: kind.startsWith('refund') ? r.id : p.id, status: 'pending', attempts: 0, payload: {} };
  const writes = [], events = [], queued = [], calls = [];
  const conn = { execute: async (sql, args = []) => {
    writes.push({ sql, args });
    if (sql.includes("UPDATE payment_jobs SET status='running'")) { job.status = 'running'; job.lease_token = args[0]; }
    if (sql.includes("UPDATE payment_refunds SET refund_status='refunded'")) r.refund_status = 'refunded';
    return [{ affectedRows: 1, insertId: 1 }];
  } };
  const rows = async (_conn, sql) => {
    if (sql.includes('FROM payment_jobs')) return [job];
    if (sql.includes('FROM payment_refunds')) return sql.includes('app_order_id=?') ? [] : [r];
    if (sql.includes('FROM payment_orders') && sql.includes('app_order_id=?')) return [p];
    return [];
  };
  const payCenter = {
    async queryOrder(input) { calls.push({ kind: 'query', input }); return { errno: 0, data: query }; },
    async createC2BOrder(input) { calls.push({ kind: 'create', input }); return { errno: 0, data: create }; },
    async queryRefundOrder(input) { calls.push({ kind: 'refund_query', input }); return { errno: 0, data: refundQuery }; },
  };
  const worker = createWorker({ config: {}, payCenter, logger: { warn() {} }, now: () => Date.parse('2026-01-01T00:00:00Z'),
    clock: () => '2026-01-01 00:00:00', due: () => '2026-01-01 00:00:10', tx: fn => fn(conn), rows,
    guard: async () => g, payment: async () => p, enqueue: async (_c, ...value) => queued.push(value),
    emit: async (_c, _g, type, key, payload) => events.push({ type, key, payload }), finishClosed: async () => {},
    closeGuard: async () => {}, refundInTransaction: async () => {}, jobHandlers: {} });
  return { worker, p, r, writes, events, queued, calls };
}
const evidence = { status: '30', appOrderId: 'XD_fixture', merchantNo: 'fixture-merchant', amount: '100.00' };

test('public reconciliation stays strict, including attempted legacy-option injection', async () => {
  for (const options of [undefined, true, { allowLegacySparse: true }, Symbol('authenticated payment query')]) {
    const f = fixture();
    await assert.rejects(f.worker.reconcilePayment(1, { data: { status: '30' } }, options), { code: 'gateway_evidence_incomplete' });
    await assert.rejects(f.worker.reconcileRefund(2, { data: { status: '30' } }, options), { code: 'gateway_evidence_incomplete' });
    assert.equal(f.events.length, 0);
  }
});

test('only authenticated booking query jobs accept legacy sparse success', async () => {
  for (const bizType of ['booking', 'commerce', 'jiazheng']) {
    const f = fixture({ bizType, query: { status: '30', pay_method: 'wx', pay_no: 'exact-legacy-receipt' } });
    const result = await f.worker.runJobs(1);
    assert.equal(f.calls[0].input.appOrderId, f.p.app_order_id);
    assert.equal(result.processed, bizType === 'booking' ? 1 : 0);
    assert.equal(f.events.some(e => e.type === 'payment.accepted'), bizType === 'booking');
    if (bizType === 'booking') {
      const write = f.writes.find(w => w.sql.includes('gateway_order_status=?,pay_method='));
      assert.equal(write.args[1], 'wx'); assert.equal(write.args[2], 'exact-legacy-receipt');
    }
  }
});

test('trusted sparse booking responses still reject every echoed mismatch', async () => {
  const changes = [{ appOrderId: 'other' }, { businessOrderNo: 'other' }, { merchantNo: 'other' },
    { recAndShareInfo: { merchantNo: 'other' } }, { amount: '100.01' }, { payAmount: '99.00' },
    { ucid: 'other' }, { userInfo: { ucid: 'other' } }, { appCode: 'other' }, { projectCode: 'other' }, { currency: 'USD' }];
  for (const changed of changes) {
    const f = fixture({ query: { ...evidence, ...changed } });
    assert.equal((await f.worker.runJobs(1)).deferred, 1, JSON.stringify(changed));
    assert.equal(f.events.length, 0); assert.notEqual(f.p.pay_status, 'paid');
  }
});

test('notification is only a query hint and cannot itself enable sparse reconciliation', async () => {
  const f = fixture({ query: { status: '10' } });
  assert.equal(await f.worker.handleNotify({ appOrderId: f.p.app_order_id, status: '30' }), 'SUCCESS');
  assert.equal(f.events.length, 0); assert.equal(f.calls.length, 0);
  assert(f.queued.some(q => q[0] === 'pay_query'));
  await f.worker.runJobs(1); assert.notEqual(f.p.pay_status, 'paid'); assert.equal(f.events.length, 0);
});

test('successful sparse creation always proceeds to an authoritative query for every business', async () => {
  for (const bizType of ['booking', 'commerce', 'jiazheng']) {
    const f = fixture({ bizType, kind: 'pay_create', create: { status: '30', merchantId: 'institution-id' }, query: evidence });
    assert.equal((await f.worker.runJobs(1)).processed, 1);
    assert.deepEqual(f.calls.map(c => c.kind), ['create', 'query']);
    assert.equal(f.calls[0].input.callBackInfo.callbackUrl, f.p.callback_url);
    assert(f.events.some(e => e.type === 'payment.accepted'));
  }
  const pending = fixture({ kind: 'pay_create', create: { status: '30' }, query: { status: '10' } });
  await pending.worker.runJobs(1); assert.equal(pending.events.length, 0);
  const mismatch = fixture({ kind: 'pay_create', create: { status: '30', amount: '1.00' } });
  assert.equal((await mismatch.worker.runJobs(1)).deferred, 1); assert.equal(mismatch.calls.length, 1);
});

test('refund identity distinguishes explicit refund ID and original payment ID', async () => {
  const f = fixture({ bizType: 'commerce' });
  await f.worker.reconcileRefund(2, { data: { status: '30', refundAppOrderId: f.r.app_order_id,
    businessOrderNo: f.p.app_order_id, merchantNo: f.p.merchant_no, refundAmount: '25.00' } });
  assert(f.events.some(e => e.type === 'refund.succeeded'));
  for (const change of [{ refundAppOrderId: 'other' }, { businessOrderNo: 'other' }, { appOrderId: 'other' }, { refundAmount: '100.00' }]) {
    const wrong = fixture({ bizType: 'commerce' });
    await assert.rejects(wrong.worker.reconcileRefund(2, { data: { status: '30', refundAppOrderId: wrong.r.app_order_id,
      businessOrderNo: wrong.p.app_order_id, merchantNo: wrong.p.merchant_no, refundAmount: '25.00', ...change } }));
    assert.equal(wrong.events.length, 0);
  }
  const originalOnly = fixture({ bizType: 'commerce' });
  await assert.rejects(originalOnly.worker.reconcileRefund(2, { data: { status: '30', businessOrderNo: originalOnly.p.app_order_id,
    merchantNo: originalOnly.p.merchant_no, refundAmount: '25.00' } }), { code: 'gateway_evidence_incomplete' });
});

test('refund query allows sparse booking only and retains mismatched amount protection', async () => {
  for (const bizType of ['booking', 'commerce', 'jiazheng']) {
    const f = fixture({ bizType, kind: 'refund_query' });
    assert.equal((await f.worker.runJobs(1)).processed, bizType === 'booking' ? 1 : 0);
    assert.equal(f.calls[0].input.businessOrderNo, f.r.app_order_id);
    assert.equal(f.events.some(e => e.type === 'refund.succeeded'), bizType === 'booking');
  }
  const bad = fixture({ kind: 'refund_query', refundQuery: { status: '30', refundAmount: '99.00' } });
  assert.equal((await bad.worker.runJobs(1)).deferred, 1); assert.equal(bad.events.length, 0);
});

test('merchantId never substitutes for a collecting merchantNo', async () => {
  const f = fixture({ bizType: 'commerce' });
  await assert.rejects(f.worker.reconcilePayment(1, { data: { status: '30', appOrderId: f.p.app_order_id,
    amount: '100.00', merchantId: f.p.merchant_no } }), { code: 'gateway_evidence_incomplete' });
  await f.worker.reconcilePayment(1, { data: { ...evidence, merchantId: 'different-institution-id' } });
  assert(f.events.some(e => e.type === 'payment.accepted'));
});

test('provider references preserve string IDs and never store rounded numeric order IDs', async () => {
  for (const [fields, expected] of [[{ orderId: Number.MAX_SAFE_INTEGER + 1 }, 'XD_fixture'],
    [{ orderId: '90071992547409931234' }, '90071992547409931234'], [{ pay_no: 'old-exact-no', orderId: 42 }, 'old-exact-no'],
    [{ payNo: 'new-exact-no', pay_no: 'old-no' }, 'new-exact-no']]) {
    const f = fixture(); await f.worker.reconcilePayment(1, { data: { ...evidence, ...fields } });
    const write = f.writes.find(w => w.sql.includes('gateway_order_status=?,pay_method='));
    assert.equal(write.args[2], expected); assert.equal(f.events[0].payload.providerRef, expected);
  }
});
