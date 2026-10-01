'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { createPaymentCore, normalizeBizOrderNo, restoreBizOrderNo, toMinor, toAmount, sqlDate } = require('../payment/core.cjs');
const { migrate } = require('../payment/migrate.cjs');

test('business identity is reversible and monetary conversions are exact', () => {
  const uuid = '12345678-1234-4ABC-8DEF-123456789ABC';
  const compact = normalizeBizOrderNo('commerce', uuid);
  assert.equal(compact.length, 32);
  assert.equal(restoreBizOrderNo('commerce', compact), uuid.toLowerCase());
  assert.equal(normalizeBizOrderNo('booking', 'BKG-MINSU-00001'), 'BKG-MINSU-00001');
  assert.throws(() => normalizeBizOrderNo('jiazheng', 'x'.repeat(33)));
  assert.throws(() => normalizeBizOrderNo('commerce', 'arbitrary-order'));
  for (const amount of [1, 101, 999999999999]) assert.equal(toMinor(toAmount(amount)), amount);
  assert.throws(() => toMinor('1.001'));
  assert.throws(() => toAmount(1.5));
});

const socketPath = process.env.PAYMENT_TEST_SOCKET;
test('isolated MySQL payment concurrency and recovery', { skip: !socketPath, timeout: 120000 }, async t => {
  // An explicit local socket is mandatory. Never read application/host database configuration.
  assert.match(socketPath, /^\/tmp\//);
  const database = `cashier_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const options = { socketPath, user: 'root', timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true };
  const admin = await mysql.createConnection(options);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
  const createConnection = () => mysql.createConnection({ ...options, database });
  async function db(sql, args = []) { const c = await createConnection(); try { return (await c.execute(sql, args))[0]; } finally { await c.end(); } }
  const c = await createConnection(); try { await migrate(c); await migrate(c); } finally { await c.end(); }
  t.after(async () => { await admin.query(`DROP DATABASE \`${database}\``); await admin.end(); });
  const config = { PAY_APP_CODE: 'test-app', PAY_PROJECT_CODE: 'test-project', PAY_SHARE_BIZ_CODE: 'test-share', PAY_NOTIFY_URL: 'https://example.test/notify', PAY_POLL_SECONDS: '1' };
  const account = { id: '123', idp_type: 'beike', idp_subject: 'test-ucid' };
  let timer = Date.now(), gateway, core;
  function makeGateway() {
    const payments = new Map(), refunds = new Map();
    return { payments, refunds, creates: 0, refundCreates: 0, loseCreateResponse: false, spoofAmount: false, failQuery: false,
      async createC2BOrder(body) {
        this.creates++;
        if (!payments.has(body.appOrderId)) payments.set(body.appOrderId, { ...body, merchantNo: body.recAndShareInfo.merchantNo, orderStatus: '10', payNo: `receipt-${body.appOrderId}` });
        if (this.loseCreateResponse) { this.loseCreateResponse = false; throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }
        return { errno: 0, data: { appOrderId: body.appOrderId, orderStatus: '10', cashierUrl: 'https://example.test/cashier/' + body.appOrderId } };
      },
      async queryOrder(input) {
        if (this.failQuery) throw Object.assign(new Error('offline'), { code: 'ETIMEDOUT' });
        const p = payments.get(input.appOrderId);
        if (!p) throw Object.assign(new Error('not found is not a closed order'), { code: 'NOT_FOUND' });
        return { errno: 0, data: { ...p, amount: this.spoofAmount ? '999.00' : p.amount } };
      },
      async closeOrder(input) { const p = payments.get(input.businessOrderNo); if (p && p.orderStatus !== '30') p.orderStatus = '40'; return { errno: 0, data: { accepted: true } }; },
      async refundOrder(input) {
        this.refundCreates++;
        if (!refunds.has(input.appOrderId)) refunds.set(input.appOrderId, { ...input, merchantNo: input.shareOrderInfos[0].merchantNo, orderStatus: '10' });
        return { errno: 0, data: { orderStatus: '10' } };
      },
      async queryRefundOrder(input) { const r = refunds.get(input.businessOrderNo); if (!r) throw new Error('unknown refund'); return { errno: 0, data: r }; },
    };
  }
  async function reset() {
    for (const table of ['payment_requests', 'payment_events', 'payment_jobs', 'payment_notify_log', 'payment_gateway_logs', 'payment_refunds', 'payment_orders', 'payment_order_guards']) await db(`TRUNCATE TABLE ${table}`);
    timer = Date.now(); gateway = makeGateway(); core = createPaymentCore({ createConnection, config, payCenter: gateway, now: () => timer, logger: { warn() {} } });
  }
  async function register(orderId = 'WO-test-001', bizType = 'jiazheng', extra = {}) {
    await core.transaction(conn => core.registerOrder(conn, { bizType, orderId, accountId: account.id, amountMinor: 10000, merchantNo: 'merchant-test', payerUcid: account.idp_subject,
      expiresAt: sqlDate(new Date(timer + 900000)), title: '测试订单', ...extra }));
    return { bizType, orderId };
  }
  const intent = (id, key = 'request-key-0001', more = {}) => core.createIntent({ ...id, account, cashierType: '2', requestKey: key, ...more });
  async function work(seconds = 2) { timer += seconds * 1000; await core.runJobs(50); }
  async function pay(id) {
    const out = await intent(id); await work();
    gateway.payments.get(out.app_order_id).orderStatus = '30';
    await work(); return out;
  }

  await t.test('migration preserves 32-byte business IDs and nonunique history indexes', async () => {
    const columns = await db("SELECT CHARACTER_MAXIMUM_LENGTH n FROM information_schema.columns WHERE table_schema=? AND table_name IN ('payment_orders','payment_refunds') AND column_name='biz_order_no'", [database]);
    assert.deepEqual(columns.map(x => Number(x.n)), [32, 32]);
    const indexes = await db("SELECT NON_UNIQUE n FROM information_schema.statistics WHERE table_schema=? AND table_name='payment_orders' AND index_name='idx_po_biz_id'", [database]);
    assert.ok(indexes.length > 0 && indexes.every(x => Number(x.n) === 1));
  });
  await t.test('same or different request keys converge under concurrent connections', async () => {
    await reset(); const id = await register();
    const results = await Promise.all(Array.from({ length: 12 }, (_, n) => intent(id, `request-${n % 6}-stable`)));
    assert.equal(new Set(results.map(x => x.app_order_id)).size, 1);
    assert.equal((await db('SELECT * FROM payment_orders')).length, 1);
    await Promise.all([core.runJobs(10), core.runJobs(10), core.runJobs(10)]);
    assert.equal(gateway.creates, 1);
    await assert.rejects(intent(id, 'request-0-stable', { cashierType: '1' }), { code: 'idempotency_conflict' });
  });
  await t.test('identical business numbers in different categories never share payments', async () => {
    await reset();
    const booking = await register('SAME-ORDER', 'booking');
    const life = await register('SAME-ORDER', 'jiazheng');
    const first = await intent(booking, 'booking-same-id');
    const second = await intent(life, 'life-same-id');
    assert.notEqual(first.app_order_id, second.app_order_id);
    await work(); gateway.payments.get(first.app_order_id).orderStatus = '30'; await work();
    assert.equal((await core.getStatus({ ...booking, accountId: account.id })).order_pay_status, 'paid');
    assert.equal((await core.getStatus({ ...life, accountId: account.id })).order_pay_status, 'unpaid');
    await assert.rejects(core.getStatus({ ...life, accountId: 'someone-else' }), { code: 'payment_not_owned' });
  });
  await t.test('reused request stays bound to the old attempt after it closes', async () => {
    await reset(); const id = await register();
    const first = await intent(id, 'request-original');
    const reused = await intent(id, 'request-reuse-02'); assert.equal(reused.payment_id, first.payment_id);
    await core.requestClose({ ...id, reason: 'cashier_refresh', reopen: true }); await work();
    const replay = await intent(id, 'request-reuse-02'); assert.equal(replay.payment_id, first.payment_id); assert.equal(replay.cashier_url, null);
    const next = await intent(id, 'request-next-003'); assert.notEqual(next.payment_id, first.payment_id);
    assert.equal((await db('SELECT * FROM payment_orders')).length, 2);
  });
  await t.test('cancelled guard prevents replay and locally unsent orders need no gateway close', async () => {
    await reset(); const id = await register(); await intent(id);
    await core.requestClose({ ...id, accountId: account.id, reason: 'cancelled' }); await work();
    const out = await intent(id); assert.equal(out.order_pay_status, 'closed'); assert.equal(out.cashier_url, null); assert.equal(gateway.creates, 0);
  });
  await t.test('lost creation response queries original ID and never creates another payment', async () => {
    await reset(); const id = await register(); gateway.loseCreateResponse = true;
    const before = await intent(id); await work();
    const after = await intent(id, 'request-other-key'); assert.equal(before.app_order_id, after.app_order_id);
    await work(10); assert.equal(gateway.creates, 1); assert.equal((await db('SELECT * FROM payment_orders')).length, 1);
    gateway.payments.get(before.app_order_id).cashierUrl = 'https://example.test/recovered';
    await work(); assert.equal((await core.getStatus({ ...id, accountId: account.id })).cashier_url, 'https://example.test/recovered');
  });
  await t.test('notification arriving during a terminal query is not lost', async () => {
    await reset(); const id = await register(); const out = await intent(id); await work();
    const originalQuery = gateway.queryOrder.bind(gateway);
    let raced = false;
    gateway.queryOrder = async input => {
      if (raced) return originalQuery(input);
      raced = true;
      const old = { ...(await originalQuery(input)).data, orderStatus: '40' };
      gateway.payments.get(out.app_order_id).orderStatus = '30';
      await core.handleNotify({ appOrderId: out.app_order_id, orderStatus: '30' });
      return { errno: 0, data: old };
    };
    await work(); await work();
    assert.equal((await core.getStatus({ ...id, accountId: account.id })).order_pay_status, 'paid');
    assert.equal(gateway.creates, 1);
  });
  await t.test('query not found while a creation is in flight cannot release the guard', async () => {
    await reset(); const id = await register(); const out = await intent(id);
    await db("UPDATE payment_jobs SET payload=JSON_OBJECT('sent',true),status='pending' WHERE kind='pay_create'");
    await core.requestClose({ ...id, reason: 'cancelled' }); await work();
    const [g] = await db('SELECT * FROM payment_order_guards'); assert.equal(g.lifecycle, 'closing'); assert.equal(String(g.active_payment_id), String(out.payment_id));
    assert.equal((await db("SELECT * FROM payment_events WHERE event_type='order.closed'")).length, 0);
  });
  await t.test('notification is a hint; forged success cannot mark payment paid', async () => {
    await reset(); const id = await register(); const out = await intent(id); await work();
    await core.handleNotify({ appOrderId: out.app_order_id, orderStatus: '30' }); await work();
    assert.equal((await core.getStatus({ ...id, accountId: account.id })).order_pay_status, 'unpaid');
    gateway.payments.get(out.app_order_id).orderStatus = '30';
    await core.handleNotify({ appOrderId: out.app_order_id, orderStatus: '30', tradeTime: 'later' }); await work();
    assert.equal((await core.getStatus({ ...id, accountId: account.id })).order_pay_status, 'paid');
  });
  await t.test('successful evidence requires matching amount and merchant', async () => {
    await reset(); const id = await register(); const out = await intent(id); await work(); gateway.payments.get(out.app_order_id).orderStatus = '30'; gateway.spoofAmount = true;
    await work(); assert.equal((await core.getStatus({ ...id, accountId: account.id })).order_pay_status, 'unpaid');
    for (const changed of [{ merchantNo: 'wrong-merchant' }, { appOrderId: 'XD_wrong' }, { ucid: 'wrong-payer' }, { currency: 'USD' }]) {
      await assert.rejects(core.reconcilePayment(out.payment_id, { errno: 0, data: { appOrderId: out.app_order_id, orderStatus: '30', merchantNo: 'merchant-test', amount: '100.00', ...changed } }), { code: 'gateway_identity_mismatch' });
    }
    gateway.spoofAmount = false; await work(10); assert.equal((await core.getStatus({ ...id, accountId: account.id })).order_pay_status, 'paid');
  });
  await t.test('duplicate success after fulfillment never triggers an automatic refund', async () => {
    await reset(); const id = await register(); const out = await pay(id); let granted = 0;
    await core.consumeEvents('jiazheng', async (conn, event) => { if (event.event_type === 'payment.accepted') granted++; });
    for (let n = 0; n < 3; n++) { await core.handleNotify({ appOrderId: out.app_order_id, orderStatus: '30', nonce: n }); await work(); }
    await core.consumeEvents('jiazheng', async (conn, event) => { if (event.event_type === 'payment.accepted') granted++; });
    assert.equal(granted, 1); assert.equal((await db('SELECT * FROM payment_refunds')).length, 0);
  });
  await t.test('event failures recover and preserve per-order received-before-accepted order', async () => {
    await reset(); const id = await register(); await pay(id); const delivered = [];
    await core.consumeEvents('jiazheng', async () => { throw new Error('simulated crash'); });
    assert.equal((await db("SELECT * FROM payment_events WHERE status='processed'")).length, 0);
    timer += 10000;
    await Promise.all([1, 2].map(() => core.consumeEvents('jiazheng', async (conn, event) => { delivered.push(event.event_type); })));
    assert.deepEqual(delivered, ['payment.received', 'payment.accepted']);
  });
  await t.test('concurrent partial refunds reserve the original payment amount once', async () => {
    await reset(); const id = await register(); await pay(id);
    const results = await Promise.allSettled([1, 2].map(n => core.requestRefund({ ...id, amountMinor: 6000, requestKey: `coupon-refund-${n}`, reason: 'unused', reference: { couponId: n } })));
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    const original = results.find(x => x.status === 'fulfilled').value;
    const [r] = await db('SELECT * FROM payment_refunds');
    const replay = await core.requestRefund({ ...id, amountMinor: 6000, requestKey: r.idempotency_key, reason: 'unused' });
    assert.equal(String(replay.id), String(original.id));
    await work(); assert.equal(gateway.refundCreates, 1);
    gateway.refunds.get(r.app_order_id).orderStatus = '30'; await work();
    const out = await core.getStatus({ ...id, accountId: account.id }); assert.equal(out.order_pay_status, 'partially_refunded'); assert.equal(out.refunded_minor, 6000);
  });
  await t.test('closed-order late success refunds once without creating fulfillment', async () => {
    await reset(); const id = await register(); const out = await intent(id); await work();
    await core.requestClose({ ...id, reason: 'cancelled' }); await work();
    gateway.payments.get(out.app_order_id).orderStatus = '30';
    await core.handleNotify({ appOrderId: out.app_order_id, orderStatus: '30' }); await work();
    await core.handleNotify({ appOrderId: out.app_order_id, orderStatus: '30', retry: true }); await work();
    assert.equal((await db('SELECT * FROM payment_refunds')).length, 1);
    assert.equal((await db("SELECT * FROM payment_events WHERE event_type='payment.accepted'")).length, 0);
  });
  await t.test('paid or refunded original order can never be charged again', async () => {
    await reset(); const id = await register(); await pay(id);
    const r = await core.requestRefund({ ...id, amountMinor: 10000, requestKey: 'full-refund-test', reason: 'cancelled' }); await work();
    gateway.refunds.get(r.app_order_id).orderStatus = '30'; await work();
    const result = await intent(id, 'new-key-after-refund'); assert.equal(result.order_pay_status, 'refunded'); assert.equal(result.cashier_url, null);
    assert.equal((await db('SELECT * FROM payment_orders')).length, 1);
  });
  await t.test('registration does not overwrite a previously closed guard', async () => {
    await reset(); const id = await register(); await core.requestClose({ ...id, reason: 'cancelled' });
    await register(); assert.equal((await core.getStatus({ ...id, accountId: account.id })).order_pay_status, 'closed');
  });
  await t.test('pausing new payments preserves settlement and hides existing cashier links', async () => {
    await reset(); const id = await register(); const payment = await intent(id); await work();
    config.PAY_NEW_INTENTS_ENABLED = '0';
    try {
      await assert.rejects(intent(id, 'paused-request'), { code: 'payment_paused' });
      assert.equal((await core.getStatus({ ...id, accountId: account.id })).cashier_url, null);
      gateway.payments.get(payment.app_order_id).orderStatus = '30'; await work();
      assert.equal((await core.getStatus({ ...id, accountId: account.id })).order_pay_status, 'paid');
      await core.requestRefund({ ...id, amountMinor: 10000, requestKey: 'paused-refund' });
      await work(); assert.equal(gateway.refundCreates, 1);
    } finally { delete config.PAY_NEW_INTENTS_ENABLED; }
  });
});
