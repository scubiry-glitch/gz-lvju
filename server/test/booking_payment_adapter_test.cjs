'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { createPaymentCore } = require('../payment/core.cjs');
const { createBookingPaymentAdapter } = require('../payment/booking-adapter.cjs');
const { migrate } = require('../payment/migrate.cjs');
const { sqlDate } = require('../payment/primitives.cjs');
const { createCashier } = require('../../screens/_cashier.js');
const { createBookingRouter } = require('../routes/booking.cjs');

test('shared cashier preserves request keys and only uses native App bridges', () => {
  const storage = new Map();
  const env = { crypto, navigator: { userAgent: 'ordinary browser' }, location: { href: '' }, setTimeout,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    JsBridgeV3: { callAndBack() {}, getSchemeLink() { return ''; } } };
  const first = createCashier(env), second = createCashier(env);
  assert.equal(first.cashierType(), '2');
  assert.equal(first.requestKey('booking:one'), second.requestKey('booking:one'));
  assert.notEqual(first.requestKey('booking:one', true), first.requestKey('booking:two'));
  assert.equal(first.open({ pay_status: 'creating', cashier_url: null }), false);
  assert.equal(first.open({ pay_status: 'paid', order_pay_status: 'closed', cashier_url: null }, { onResult: () => assert.fail('Late payment is not an accepted business payment') }), false);
  assert.throws(() => first.open({ pay_status: 'paying', cashier_type: '2', cashier_url: 'javascript:alert(1)' }));
  first.open({ pay_status: 'paying', cashier_type: '2', cashier_url: 'https://example.test/pay' });
  assert.equal(env.location.href, 'https://example.test/pay');
  let called, cancelled = 0, queried = 0;
  env.__BZF_IS_BEIKE_APP = true;
  env.JsBridgeV3.getSchemeLink = () => 'lianjia://bkjfwallet?url=';
  env.JsBridgeV3.callAndBack = arg => { called = arg; };
  assert.equal(first.cashierType(), '1');
  const payment = { pay_status: 'paying', cashier_type: '1', cashier_url: 'WalletSDK://test' };
  first.open(payment, { onCancel: () => cancelled++, onResult: () => queried++ });
  const callback1 = called.functionName;
  env[callback1]('{"code":-1}');
  assert.equal(cancelled, 1); assert.equal(queried, 0); assert.equal(env[callback1], undefined);
  first.open(payment, { onResult: () => queried++ });
  assert.notEqual(called.functionName, callback1);
  env[called.functionName]('{"code":0}');
  assert.equal(queried, 1);
});

const socketPath = process.env.PAYMENT_TEST_SOCKET;
test('booking adapter preserves payment and inventory invariants', { skip: !socketPath, timeout: 120000 }, async t => {
  assert.match(socketPath, /^\/tmp\//, 'Only an explicit isolated temporary MySQL socket is permitted');
  const database = 'cashier_booking_test_' + process.pid + '_' + crypto.randomBytes(4).toString('hex');
  const opts = { socketPath, user: 'root', timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true };
  const admin = await mysql.createConnection(opts);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
  t.after(async () => { await admin.query(`DROP DATABASE \`${database}\``); await admin.end(); });
  const createConnection = () => mysql.createConnection({ ...opts, database });
  const db = async (sql, args = []) => { const c = await createConnection(); try { return (await c.execute(sql, args))[0]; } finally { await c.end(); } };
  await db('CREATE TABLE accounts (id VARCHAR(64) PRIMARY KEY,idp_type VARCHAR(16),idp_subject VARCHAR(64))');
  await db('CREATE TABLE jz_vendors (id INT PRIMARY KEY,pay_merchant_no VARCHAR(64))');
  await db(`CREATE TABLE booking_orders (id INT AUTO_INCREMENT PRIMARY KEY,order_no VARCHAR(32) UNIQUE,user_id VARCHAR(64),owner_vendor_id INT,
    project_id INT,unit_id INT,checkin VARCHAR(16),checkout VARCHAR(16),rooms INT,nights INT,price_total DECIMAL(12,2),
    contact_phone VARCHAR(32),status VARCHAR(24),pay_status VARCHAR(24),payment_expires_at VARCHAR(32),paid_payment_order_id BIGINT NULL,
    pay_method VARCHAR(50) NULL,pay_at DATETIME NULL,updated_at DATETIME,refund_status VARCHAR(30),latest_refund_id BIGINT,refunded_at DATETIME)`);
  await db('CREATE TABLE units (id INT PRIMARY KEY,project_id INT,ext JSON,sort_order INT DEFAULT 0)');
  await db(`CREATE TABLE stay_calendar (id INT AUTO_INCREMENT PRIMARY KEY,project_id INT,unit_id INT,stay_date VARCHAR(16),booked_qty INT DEFAULT 0,
    status VARCHAR(20),source VARCHAR(20),price_night DECIMAL(12,2),qty INT,qty_base INT,updated_at DATETIME,
    UNIQUE KEY uk_calendar(project_id,unit_id,stay_date))`);
  const c = await createConnection(); try { await migrate(c); await migrate(c); } finally { await c.end(); }
  await db("INSERT INTO accounts VALUES('account-1','beike','ucid-one')");
  await db("INSERT INTO jz_vendors(id,pay_merchant_no) VALUES(1,'merchant-one')");
  await db('INSERT INTO units(id,project_id,ext) VALUES(1,1,?)', [JSON.stringify({ cancel_policy: { enabled: true, days_before: 0, cutoff_time: '18:00' } })]);
  let now = Date.now();
  const paymentMap = new Map(), refundMap = new Map();
  const gateway = {
    async createC2BOrder(p) { paymentMap.set(p.appOrderId, { ...p, merchantNo: p.recAndShareInfo.merchantNo, orderStatus: '10' }); return { errno: 0, data: { cashierUrl: 'https://example.test/cashier/' + p.appOrderId } }; },
    async queryOrder(p) { const row = paymentMap.get(p.appOrderId); if (!row) throw new Error('unknown'); return { errno: 0, data: row }; },
    async closeOrder(p) { const row = paymentMap.get(p.businessOrderNo); if (row && row.orderStatus !== '30') row.orderStatus = '40'; return { errno: 0, data: { accepted: true } }; },
    async refundOrder(p) { refundMap.set(p.appOrderId, { ...p, merchantNo: p.shareOrderInfos[0].merchantNo, orderStatus: '30' }); return { errno: 0, data: { accepted: true } }; },
    async queryRefundOrder(p) { const row = refundMap.get(p.businessOrderNo); if (!row) throw new Error('unknown'); return { errno: 0, data: row }; },
  };
  const config = { PAY_APP_CODE: 'app-test', PAY_PROJECT_CODE: 'project-test', PAY_SHARE_BIZ_CODE: 'share-test',
    PAY_NOTIFY_URL: 'https://example.test/notify', PAY_POLL_SECONDS: '1' };
  const core = createPaymentCore({ createConnection, config, payCenter: gateway, now: () => now,
    logger: { warn() {} }, jobHandlers: { booking_webhook: async () => {} } });
  const adapter = createBookingPaymentAdapter({ core, createConnection, config });
  const account = { id: 'account-1', idp_type: 'beike', idp_subject: 'ucid-one' };
  let seq = 0;
  async function booking(payStatus = 'unpaid') {
    const orderNo = 'BKG-MINSU-' + (++seq);
    await db(`INSERT INTO booking_orders(order_no,user_id,owner_vendor_id,project_id,unit_id,checkin,checkout,rooms,nights,price_total,
      contact_phone,status,pay_status,payment_expires_at,updated_at) VALUES(?,'account-1',1,1,1,'2099-10-02','2099-10-03',1,1,'123.45','13000000000','pending',?,?,?)`,
    [orderNo, payStatus, sqlDate(new Date(now + 1800000)), sqlDate()]);
    await db("INSERT INTO stay_calendar(project_id,unit_id,stay_date,booked_qty,status,source,price_night) VALUES(1,1,'2099-10-02',1,'open','booking',123.45) ON DUPLICATE KEY UPDATE booked_qty=booked_qty+1");
    return orderNo;
  }
  const intent = (orderNo, key) => adapter.intent({ orderNo, account, cashierType: '2', requestKey: key });
  const work = async () => { now += 2000; await core.runJobs(50); };
  const consume = () => core.consumeEvents('booking', adapter.handleEvent, 50);
  const legacyPayment = (orderNo, state = 'paid') => db(`INSERT INTO payment_orders(biz_order_no,app_order_id,amount,payer_ucid,payer_user_type,merchant_no,
    share_biz_code,cashier_type,pay_status,callback_url,app_code,project_code,created_at,updated_at)
    VALUES(?,?,'123.45','ucid-one','2','legacy-merchant','legacy-share','2',?,'https://example.test/legacy-notify','legacy-app','legacy-project',?,?)`,
  [orderNo, 'XD_20261002000000_' + String(seq).padStart(6, '0'), state, sqlDate(), sqlDate()]);

  await t.test('concurrent first preparation and payment requests converge without changing snapshots', async () => {
    const orderNo = await booking();
    // First registration is intentionally serialized by the adapter/core, not a
    // SELECT FOR UPDATE gap lock on a missing guard.
    const out = await Promise.all(Array.from({ length: 6 }, (_, n) => intent(orderNo, 'booking-request-' + n)));
    assert.equal(new Set(out.map(x => x.payment_id)).size, 1);
    await db("UPDATE jz_vendors SET pay_merchant_no='changed-merchant' WHERE id=1");
    await intent(orderNo, 'booking-request-again');
    assert.equal((await db('SELECT merchant_no FROM payment_order_guards WHERE biz_order_no=?', [orderNo]))[0].merchant_no, 'merchant-one');
    await db("UPDATE jz_vendors SET pay_merchant_no='merchant-one' WHERE id=1");
    await assert.rejects(adapter.status({ orderNo, account: { ...account, id: 'another' } }), { status: 403 });
    await assert.rejects(adapter.confirm({ orderNo, source: 'vendor', vendorId: 1 }), { code: 'payment_not_confirmed' });
  });

  await t.test('unpaid cancellation holds inventory until closure and releases it once', async () => {
    const orderNo = await booking();
    await intent(orderNo, 'booking-close-request'); await work();
    const before = Number((await db('SELECT SUM(booked_qty) total FROM stay_calendar'))[0].total);
    const cancelled = await adapter.cancel({ orderNo, account, source: 'user' });
    assert.equal(cancelled.pay_status, 'closing');
    assert.equal(Number((await db('SELECT SUM(booked_qty) total FROM stay_calendar'))[0].total), before);
    await work(); await work(); await consume();
    assert.equal((await db('SELECT status FROM booking_orders WHERE order_no=?', [orderNo]))[0].status, 'cancelled');
    const after = Number((await db('SELECT SUM(booked_qty) total FROM stay_calendar'))[0].total);
    assert.equal(after, before - 1);
    await adapter.cancel({ orderNo, account, source: 'user' }); await consume();
    assert.equal(Number((await db('SELECT SUM(booked_qty) total FROM stay_calendar'))[0].total), after);
  });

  await t.test('accepted payment, merchant confirmation and cancellation use a real refund lifecycle', async () => {
    const orderNo = await booking(); const out = await intent(orderNo, 'booking-paid-request'); await work();
    paymentMap.get(out.app_order_id).orderStatus = '30'; await work();
    // The business projection may lag the accepted payment past the original
    // expiry time. Expiry must observe the guard, not refund or release stock.
    await db("UPDATE booking_orders SET payment_expires_at='2020-01-01 00:00:00' WHERE order_no=?", [orderNo]);
    assert.equal((await adapter.expire()).requested, 0);
    await consume();
    let row = (await db('SELECT * FROM booking_orders WHERE order_no=?', [orderNo]))[0];
    assert.equal(row.pay_status, 'paid');
    await adapter.confirm({ orderNo, source: 'vendor', vendorId: 1 });
    await adapter.status({ orderNo, account }); await work(); await consume();
    assert.equal((await db('SELECT * FROM payment_refunds WHERE biz_order_no=?', [orderNo])).length, 0);
    const cancelled = await adapter.cancel({ orderNo, source: 'vendor', vendorId: 1 });
    assert.equal(cancelled.pay_status, 'refunding');
    await adapter.cancel({ orderNo, source: 'vendor', vendorId: 1 });
    assert.equal((await db('SELECT * FROM payment_refunds WHERE biz_order_no=?', [orderNo])).length, 1);
    await work(); await work(); await consume();
    row = (await db('SELECT * FROM booking_orders WHERE order_no=?', [orderNo]))[0];
    assert.equal(row.pay_status, 'refunded');
    assert.ok(row.paid_payment_order_id);
  });

  await t.test('legacy expired order without a payment still emits one inventory-release event', async () => {
    const orderNo = await booking();
    await db("UPDATE booking_orders SET payment_expires_at='2020-01-01 00:00:00' WHERE order_no=?", [orderNo]);
    const before = Number((await db('SELECT SUM(booked_qty) total FROM stay_calendar'))[0].total);
    const result = await adapter.expire();
    assert.equal(result.errors.length, 0);
    await consume();
    const row = (await db('SELECT status,pay_status FROM booking_orders WHERE order_no=?', [orderNo]))[0];
    assert.equal(row.status, 'cancelled'); assert.equal(row.pay_status, 'expired');
    assert.equal(Number((await db('SELECT SUM(booked_qty) total FROM stay_calendar'))[0].total), before - 1);
    await adapter.expire(); await consume();
    assert.equal(Number((await db('SELECT SUM(booked_qty) total FROM stay_calendar'))[0].total), before - 1);
  });

  await t.test('legacy paid and pending refund import retain original merchant and only query the refund', async () => {
    const orderNo = await booking('refunding');
    const appOrderId = 'XD_20261002000000_123456', refundAppId = 'RF_20261002000000_123456';
    const inserted = await db(`INSERT INTO payment_orders(biz_order_no,app_order_id,amount,payer_ucid,payer_user_type,merchant_no,
      share_biz_code,cashier_type,pay_status,callback_url,app_code,project_code,created_at,updated_at)
      VALUES(?,?,'123.45','ucid-one','2','legacy-merchant','legacy-share','2','paid','https://example.test/legacy-notify','legacy-app','legacy-project',?,?)`,
    [orderNo, appOrderId, sqlDate(), sqlDate()]);
    await db("UPDATE booking_orders SET status='cancelled',paid_payment_order_id=? WHERE order_no=?", [inserted.insertId, orderNo]);
    const refund = await db(`INSERT INTO payment_refunds(payment_order_id,biz_order_no,app_order_id,idempotency_key,refund_reason_type,
      trigger_source,refund_amount,amount_minor,payer_ucid,merchant_no,refund_status,created_at,updated_at)
      VALUES(?,?,?,?,'booking_cancel','user','123.45',12345,'ucid-one','legacy-merchant','refunding',?,?)`,
    [inserted.insertId, orderNo, refundAppId, 'booking_cancel:' + orderNo, sqlDate(), sqlDate()]);
    refundMap.set(refundAppId, { appOrderId: refundAppId, appCode: 'legacy-app', projectCode: 'legacy-project',
      merchantNo: 'legacy-merchant', refundAmount: '123.45', orderStatus: '30' });
    await db("UPDATE jz_vendors SET pay_merchant_no='new-merchant' WHERE id=1");
    const recovered = await adapter.recoverLegacy();
    assert.equal(recovered.recovered, 1); assert.deepEqual(recovered.errors, []);
    const guard = (await db("SELECT * FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=?", [orderNo]))[0];
    assert.equal(guard.merchant_no, 'legacy-merchant'); assert.equal(guard.share_biz_code, 'legacy-share');
    assert.equal(guard.app_code, 'legacy-app'); assert.equal(guard.lifecycle, 'paid');
    assert.equal((await adapter.status({ orderNo, account })).fulfillment_status, 'fulfilled');
    const jobs = await db("SELECT kind FROM payment_jobs WHERE target_id=? AND kind IN ('refund_create','refund_query')", [refund.insertId]);
    assert.deepEqual(jobs.map(row => row.kind), ['refund_query']);
    await work(); await consume();
    assert.equal((await db('SELECT pay_status FROM booking_orders WHERE order_no=?', [orderNo]))[0].pay_status, 'refunded');
    assert.equal((await db('SELECT app_order_id FROM payment_refunds WHERE id=?', [refund.insertId]))[0].app_order_id, refundAppId);
    await db("UPDATE jz_vendors SET pay_merchant_no='merchant-one' WHERE id=1");
  });

  await t.test('legacy late payments with refunds never become accepted business payments', async () => {
    for (const state of ['refunding', 'refunded']) {
      const orderNo = await booking('expired');
      await db("UPDATE booking_orders SET status='cancelled',payment_expires_at='2020-01-01 00:00:00' WHERE order_no=?", [orderNo]);
      const payment = await legacyPayment(orderNo);
      const refundAppId = 'RF_20261002000000_' + String(seq).padStart(6, '0');
      const refund = await db(`INSERT INTO payment_refunds(payment_order_id,biz_order_no,app_order_id,idempotency_key,refund_reason_type,
        trigger_source,refund_amount,amount_minor,payer_ucid,merchant_no,refund_status,created_at,updated_at)
        VALUES(?,?,?,?,'late_pay','system','123.45',12345,'ucid-one','legacy-merchant',?,?,?)`,
      [payment.insertId, orderNo, refundAppId, 'late_pay:' + payment.insertId, state, sqlDate(), sqlDate()]);
      refundMap.set(refundAppId, { appOrderId: refundAppId, appCode: 'legacy-app', projectCode: 'legacy-project',
        merchantNo: 'legacy-merchant', refundAmount: '123.45', orderStatus: '30' });
      const result = await adapter.recoverLegacy();
      assert.equal(result.recovered, 1); assert.deepEqual(result.errors, []);
      const guard = (await db("SELECT * FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=?", [orderNo]))[0];
      assert.equal(guard.paid_payment_id, null); assert.notEqual(guard.lifecycle, 'paid');
      const status = await adapter.status({ orderNo, account });
      assert.equal(status.fulfillment_status, 'not_started'); assert.notEqual(status.order_pay_status, 'paid');
      const jobs = await db("SELECT kind FROM payment_jobs WHERE target_id=? AND kind IN ('refund_create','refund_query')", [refund.insertId]);
      assert.deepEqual(jobs.map(row => row.kind), state === 'refunding' ? ['refund_query'] : []);
      await work(); await consume();
      assert.equal((await db("SELECT * FROM payment_events WHERE biz_order_no=? AND event_type='payment.accepted'", [orderNo])).length, 0);
      assert.equal((await db('SELECT paid_payment_order_id FROM booking_orders WHERE order_no=?', [orderNo]))[0].paid_payment_order_id, null);
      assert.equal((await db('SELECT app_order_id FROM payment_refunds WHERE id=?', [refund.insertId]))[0].app_order_id, refundAppId);
    }
  });

  await t.test('expiry and recovery scans rotate past unresolved rows', async () => {
    const invalid = await booking(), valid = await booking();
    await db("UPDATE booking_orders SET payment_expires_at='2020-01-01 00:00:00' WHERE order_no IN (?,?)", [invalid, valid]);
    await legacyPayment(invalid, 'paying');
    await db("UPDATE payment_orders SET amount='999.00' WHERE biz_order_no=?", [invalid]);
    assert.equal((await adapter.expire(1)).errors.length, 1);
    assert.equal((await adapter.expire(1)).requested, 1);
    await consume();
    assert.equal((await db('SELECT status FROM booking_orders WHERE order_no=?', [valid]))[0].status, 'cancelled');
    // Keep the failed expiry fixture out of the independent recovery scan.
    await db("UPDATE payment_orders SET pay_status='closed' WHERE biz_order_no=?", [invalid]);
    const badLegacy = await booking('paying'); await legacyPayment(badLegacy, 'paying');
    await db("UPDATE payment_orders SET amount='999.00' WHERE biz_order_no=?", [badLegacy]);
    const goodLegacy = await booking('paying'); await legacyPayment(goodLegacy, 'paying');
    assert.equal((await adapter.recoverLegacy(1)).errors.length, 1);
    assert.equal((await adapter.recoverLegacy(1)).recovered, 1);
    assert.equal((await db("SELECT * FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=?", [goodLegacy])).length, 1);
  });

  await t.test('concurrent booking creation replays one order and reserves inventory once', async () => {
    await db(`CREATE TABLE projects(id INT PRIMARY KEY,name VARCHAR(100),channel VARCHAR(20),status VARCHAR(20),rating_status VARCHAR(20),
      price_from DECIMAL(12,2),owner_vendor_id INT,city_id INT,ext JSON,tags TEXT)`);
    await db("INSERT INTO projects VALUES(2,'Test stay','minsu','online','passed',123.45,1,1,'{}','')");
    await db('ALTER TABLE units ADD rent_monthly DECIMAL(12,2),ADD total_qty INT DEFAULT 1');
    await db("INSERT INTO units(id,project_id,ext,total_qty) VALUES(2,2,'{}',1)");
    await db('ALTER TABLE jz_vendors ADD commission_housing DECIMAL(12,2)');
    await db('ALTER TABLE stay_calendar ADD booking_id INT');
    await db(`ALTER TABLE booking_orders ADD channel VARCHAR(20),ADD city_id INT,ADD contact_name VARCHAR(100),
      ADD commission_rate DECIMAL(12,2),ADD commission_fee DECIMAL(12,2),ADD created_at DATETIME,
      ADD idempotency_key VARCHAR(64),ADD UNIQUE KEY uk_booking_request(idempotency_key)`);
    const body = { project_id: 2, unit_id: 2, contact_name: 'Test', contact_phone: '13000000000',
      checkin: '2099-10-04', checkout: '2099-10-05', rooms: 1, transaction_mode: 'payment' };
    const stay = require('../../stay_config.cjs');
    const router = createBookingRouter({
      readBody: async req => req.body, requestSession: async () => ({ role: 'user', account }),
      jsonReply: (res, data, status = 200) => ({ status, data }),
      mysql2: { createConnection }, getDbConfig: () => ({}), crypto,
      stayCfg: { ...stay, remainingOf: row => 1 - Number(row && row.booked_qty || 0) },
      transactionCapabilitiesOf: () => ({ online_booking: false, online_payment: true }),
      minStayNightsOf: () => 1, stayDateList: stay.stayDateList, stayNightPrices: async () => ({ total: 123.45 }),
      settingValue: async () => 0, vendorRate: { effectiveRateOf: () => 0, defaultSettingKey: () => 'test', commissionAmountOf: () => 0 },
      getBookingPaymentAdapter: () => adapter, notifyVendorBooking: () => {},
      orderCancelInfoOf: () => ({ can_cancel: true }),
    });
    const request = { method: 'POST', headers: { 'idempotency-key': 'parallel-create-booking' }, body };
    const results = await Promise.all(Array.from({ length: 6 }, () => router('/api/juzhu/booking', '', request, {})));
    assert.ok(results.every(result => result.status === 200), JSON.stringify(results));
    assert.equal(new Set(results.map(result => result.data.order_no)).size, 1);
    assert.equal(results.filter(result => result.data.idempotent_replay).length, 5);
    const [reserved] = await db('SELECT booked_qty FROM stay_calendar WHERE project_id=2 AND unit_id=2');
    assert.equal(reserved.booked_qty, 1);
    const mismatch = await router('/api/juzhu/booking', '', { ...request, body: { ...body, contact_name: 'Changed' } }, {});
    assert.equal(mismatch.status, 409);
  });
});
