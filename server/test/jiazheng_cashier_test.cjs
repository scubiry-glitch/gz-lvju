'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createJiazhengAdapter, amountMinor, normalizeOrder } = require('../payment/jiazheng-adapter.cjs');
const vendor = require('../payment/vendor-payment.cjs');
const { createJiazhengRouter } = require('../routes/jiazheng.cjs');
const grOrders = require('../../gr_orders.cjs');

test('生活服务金额和商家模式拒绝歧义输入', () => {
  assert.equal(amountMinor('128.09'), 12809);
  assert.throws(() => amountMinor('-1'));
  assert.throws(() => amountMinor('1.234'));
  assert.throws(() => vendor.normalizeMode('automatic'));
  assert.throws(() => vendor.validateVendorPayment({ payment_mode: 'pay_center' }));
  assert.equal(vendor.validateVendorPayment({ payment_mode: 'pay_center', pay_merchant_no: 'fixture_merchant' }), 'pay_center');
  assert.throws(() => vendor.paymentConfig({ token: 'not-a-real-token' }));
});

test('生活订单读取验证匿名、本人、他人，并剥离收款快照', async () => {
  const row = { id: 'WO-owned', account_id: 'owner', fee: 12800, payment_config_snapshot: '{"merchantNo":"fixture","productTitle":"保洁"}', request_key: 'sensitive-request' };
  let administrativeReads = 0;
  const router = createJiazhengRouter({
    requestSession: async req => req.session || null,
    requireApiKey: async (_req, res) => { res.status = 401; return false; },
    restrictOrdersRead: async () => { administrativeReads++; return null; },
    queryRows: async (_sql, values) => values[1] === row.account_id ? [row] : [],
    jsonReply: (res, body, status = 200) => Object.assign(res, { body, status }),
  });
  const anonymous = {}, owner = {}, other = {};
  await router('/api/juzhu/jiazheng/orders/WO-owned', '', { method: 'GET' }, anonymous);
  await router('/api/juzhu/jiazheng/orders/WO-owned', '', { method: 'GET', session: { role: 'user', account: { id: 'owner' } } }, owner);
  await router('/api/juzhu/jiazheng/orders/WO-owned', '', { method: 'GET', session: { role: 'user', account: { id: 'other' } } }, other);
  assert.equal(anonymous.status, 401); assert.equal(owner.status, 200); assert.equal(other.status, 404);
  assert.equal(owner.body.order.product_name, '保洁'); assert.equal(owner.body.order.payment_config_snapshot, undefined);
  assert.equal(owner.body.order.request_key, undefined); assert.equal(administrativeReads, 0);
  const list = {}; await router('/api/juzhu/jiazheng/orders', '', { method: 'GET' }, list); assert.equal(list.status, 401);
});

test('免费报修不能硬删除已付或已注册支付意图的订单', async () => {
  const queries = [];
  const conn = { execute: async (sql) => { queries.push(sql); return [[]]; }, end: async () => {} };
  const router = createJiazhengRouter({ requireCEndWrite: async () => true, authCenter: { P: { ORDER_CREATE: 'order.create' } },
    mysql2: { createConnection: async () => conn }, getDbConfig: () => ({}), jsonReply: (res, body, status = 200) => Object.assign(res, { body, status }) });
  const response = {};
  await router('/api/juzhu/jiazheng/repairs/WO-paid', 'phone=13800000000', { method: 'DELETE' }, response);
  assert.equal(response.status, 404); assert.match(queries[0], /pay_status='not_required'/); assert.match(queries[0], /payment_mode IS NULL/);
  assert.equal(queries.some(sql => sql.startsWith('DELETE')), false);
});

test('内部待付款进入订单中心，小程序草稿仍隐藏', () => {
  const result = grOrders.summarizeUserOrders([
    { status: 'pending', payment_mode: 'pay_center' }, { status: 'pending', payment_mode: 'wechat_mini' }, { status: 'paid' },
  ]);
  assert.equal(result.list.length, 2); assert.equal(result.counts.pending, 1);
});

test('前端仅按服务端新尝试指令换请求键，并隔离收银台类型', async () => {
  const keys = new Map(), calls = []; let number = 0, cashierType = '2';
  const context = {
    localStorage: { getItem: () => '' }, CustomEvent: function () {}, dispatchEvent() {},
    BZF_CASHIER: { cashierType: () => cashierType, requestKey(scope, renew) {
      if (renew || !keys.has(scope)) keys.set(scope, 'fixture-key-' + (++number)); return keys.get(scope);
    } },
    fetch: async (_url, options) => { calls.push(options); return { ok: true, json: async () => calls.length === 1 ? { next_action: 'new_attempt' } : { pay_status: 'created' } }; },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../screens/_jzapi.js'), 'utf8'), context);
  await context.BZF_JZ.payIntent('WO-fixture');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
  await context.BZF_JZ.payIntent('WO-fixture');
  assert.equal(calls[1].headers['Idempotency-Key'], calls[2].headers['Idempotency-Key']);
  cashierType = '1'; await context.BZF_JZ.payIntent('WO-fixture');
  assert.notEqual(calls[2].headers['Idempotency-Key'], calls[3].headers['Idempotency-Key']);
});

const socket = process.env.PAYMENT_TEST_SOCKET || process.env.CASHIER_TEST_SOCKET;
test('隔离 MySQL：生活服务建单幂等、价格归属、支付、取消退款、档期守恒', { skip: !socket }, async t => {
  assert.match(socket, /^\/tmp\/[\w-]*(?:cashier|settlement)[\w-]*\/[^/]+\.sock$/, '只接受显式隔离测试 socket');
  const mysql = require('mysql2/promise');
  const database = 'cashier_life_test_' + process.pid;
  const admin = await mysql.createConnection({ socketPath: socket, user: 'root' });
  await admin.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4');
  const connect = () => mysql.createConnection({ socketPath: socket, user: 'root', database, dateStrings: true });
  t.after(async () => { await admin.query('DROP DATABASE `' + database + '`'); await admin.end(); });
  const conn = await connect(); t.after(() => conn.end());
  const source = fs.readFileSync(path.join(__dirname, '../schema.cjs'), 'utf8');
  for (const table of ['cities', 'jz_categories', 'jz_skus', 'jz_vendors', 'jz_products', 'jz_orders', 'jz_sku_slots', 'gr_orders']) {
    const start = source.indexOf('CREATE TABLE IF NOT EXISTS ' + table + ' (');
    const end = source.indexOf(') CHARSET=utf8mb4', start);
    assert.ok(start >= 0 && end >= 0, table);
    await conn.query(source.slice(start, end + ') CHARSET=utf8mb4'.length).replace(/\\`/g, '`'));
  }
  await conn.query('ALTER TABLE jz_vendors ADD pay_merchant_no VARCHAR(64),ADD hmac_key TEXT,ADD url_link TEXT');
  await conn.query('CREATE TABLE commerce_orders (id VARCHAR(36) PRIMARY KEY,account_id VARCHAR(64),snapshot TEXT)');
  await require('../payment/migrate.cjs').migrate(conn);
  await conn.query("INSERT INTO cities(id,name,slug) VALUES(1,'测试城市','test')");
  await conn.query("INSERT INTO jz_categories(id,name) VALUES('cleaning','保洁')");
  await conn.query("INSERT INTO jz_skus(id,category_id,name,slug) VALUES(1,'cleaning','清洁服务','clean')");
  await conn.query("INSERT INTO jz_vendors(id,type,name,status,city_ids,payment_mode,pay_merchant_no) VALUES(1,'cleaning','测试商家','active','1','pay_center','fixture_merchant'),(2,'cleaning','外跳商家','active','1','wechat_mini',NULL)");
  await conn.query("INSERT INTO jz_products(id,vendor_id,title,price,channel_sku_id,city_id,status) VALUES(101,1,'测试保洁',128.09,1,1,'on'),(102,2,'外跳保洁',99,1,1,'on'),(103,1,'咨询',0,1,1,'on')");
  const tomorrow = new Date(Date.now() + 48 * 3600000).toISOString().slice(0, 10);
  await conn.execute("INSERT INTO jz_sku_slots(id,product_id,slot_date,start_time,capacity,booked,status) VALUES(1,101,?,'12:00',1,0,'open')", [tomorrow]);
  const { createPaymentCore } = require('../payment/core.cjs');
  const config = { PAY_APP_CODE: 'fixture_app', PAY_PROJECT_CODE: 'fixture_project', PAY_SHARE_BIZ_CODE: 'fixture_share', PAY_NOTIFY_URL: 'https://fixture.invalid/notify' };
  const core = createPaymentCore({ createConnection: connect, config, payCenter: {}, logger: { warn() {} } });
  const adapter = createJiazhengAdapter({ createConnection: connect, paymentCore: core, config });
  const account = { id: 'customer', status: 'active', idp_type: 'beike', idp_subject: 'fixture_ucid' };
  const input = { account, productId: 101, house: '测试地址', phone: '13800000000', expectTime: tomorrow + ' 12:00',
    slotId: 1, priceMinor: 12809, requestKey: 'fixture-order-one' };
  const concurrent = await Promise.all([adapter.createOrder(input), adapter.createOrder(input), adapter.createOrder(input)]);
  const first = concurrent[0];
  assert.equal(new Set(concurrent.map(result => result.order.id)).size, 1);
  assert.equal(first.order.fee, 12809); assert.ok(first.order.id.length <= 32);
  const replayed = await Promise.all([adapter.createOrder(input), adapter.createOrder(input)]);
  assert.equal(replayed[0].order.id, first.order.id); assert.equal(replayed[1].order.id, first.order.id);
  await assert.rejects(() => adapter.createOrder({ ...input, house: '另一个地址' }), /同一请求键/);
  await assert.rejects(() => adapter.createOrder({ ...input, productId: 102, requestKey: 'external-order' }), /未开通本站/);
  await assert.rejects(() => adapter.createOrder({ ...input, productId: 103, requestKey: 'free-inquiry' }), /咨询/);
  await assert.rejects(() => adapter.createOrder({ ...input, priceMinor: 1, requestKey: 'changed-price' }), /价格已更新/);
  await assert.rejects(() => adapter.createOrder({ ...input, requestKey: 'second-booking' }), /档期/);
  assert.equal((await conn.query('SELECT booked FROM jz_sku_slots WHERE id=1'))[0][0].booked, 1);
  assert.equal((await conn.query('SELECT COUNT(*) n FROM jz_orders'))[0][0].n, 1);
  const own = await grOrders.listUserOrders(conn, ['commerce-account-customer', 'fixture_ucid']);
  assert.equal(own.list.length, 1); assert.equal(own.list[0].product_name, '测试保洁');
  assert.equal(await grOrders.getUserOrder(conn, first.order.id, 'commerce-account-other'), null);
  await assert.rejects(() => core.createIntent({ bizType: 'jiazheng', orderId: first.order.id, account: { ...account, id: 'other' }, requestKey: 'foreign-pay', cashierType: '2' }));
  const intent = await core.createIntent({ bizType: 'jiazheng', orderId: first.order.id, account, requestKey: 'fixture-pay', cashierType: '2' });
  await core.reconcilePayment(intent.payment_id, { errno: 0, data: { orderStatus: '30', appOrderId: intent.app_order_id, merchantNo: 'fixture_merchant', amount: '128.09' } });
  const consumed = await core.consumeEvents('jiazheng', adapter.handleEvent);
  assert.ok(consumed.processed >= 2);
  assert.equal((await conn.query('SELECT pay_status FROM jz_orders'))[0][0].pay_status, 'paid');
  await assert.rejects(() => grOrders.updateOrderCallback(conn, { order_ref: first.order.id, vendor_id: 1, status: 'paid', fee: 1 }), /不能修改/);
  const cancelled = await adapter.cancel({ account, orderId: first.order.id });
  assert.ok(cancelled.refund_id);
  const again = await adapter.cancel({ account, orderId: first.order.id }); assert.equal(again.reused, true);
  await core.reconcileRefund(cancelled.refund_id, { errno: 0, data: { orderStatus: '30', appOrderId: cancelled.app_order_id, merchantNo: 'fixture_merchant', refundAmount: '128.09' } });
  await core.consumeEvents('jiazheng', adapter.handleEvent);
  const [[final]] = await conn.query('SELECT pay_status,refund_status,status FROM jz_orders');
  assert.deepEqual({ ...final }, { pay_status: 'refunded', refund_status: 'refunded', status: 'cancelled' });
  assert.equal((await conn.query('SELECT booked FROM jz_sku_slots WHERE id=1'))[0][0].booked, 0);
  await core.consumeEvents('jiazheng', adapter.handleEvent);
  assert.equal((await conn.query('SELECT booked FROM jz_sku_slots WHERE id=1'))[0][0].booked, 0);
  const pending = await adapter.createOrder({ ...input, requestKey: 'cancel-unpaid-order' });
  await adapter.cancel({ account, orderId: pending.order.id });
  await core.consumeEvents('jiazheng', adapter.handleEvent);
  assert.equal((await conn.execute('SELECT status FROM jz_orders WHERE id=?', [pending.order.id]))[0][0].status, 'cancelled');
  assert.equal((await conn.query('SELECT booked FROM jz_sku_slots WHERE id=1'))[0][0].booked, 0);

  const older = await adapter.createOrder({ ...input, slotId: null, requestKey: 'expiry-already-closing' });
  const newer = await adapter.createOrder({ ...input, slotId: null, requestKey: 'expiry-still-open' });
  await conn.execute("UPDATE jz_orders SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR) WHERE id IN (?,?)", [older.order.id, newer.order.id]);
  await conn.execute("UPDATE payment_order_guards SET lifecycle='closing' WHERE biz_type='jiazheng' AND biz_order_no=?", [older.order.id]);
  assert.equal(await adapter.expire(1), 1, '正在关闭的旧单不占据到期扫描配额');
  await core.consumeEvents('jiazheng', adapter.handleEvent);
  assert.equal((await conn.execute('SELECT status FROM jz_orders WHERE id=?', [newer.order.id]))[0][0].status, 'cancelled');
  assert.equal(await adapter.expire(1), 0);

  await conn.query("UPDATE jz_vendors SET url_link='https://fixture.invalid/link',hmac_key='fixture-signing-key' WHERE id=2");
  const calls = [];
  const route = createJiazhengRouter({ queryRows: async (sql, params) => (await conn.execute(sql, params))[0], readBody: async req => req.body,
    requestSession: async () => ({ account }), grOrders, mysql2: { createConnection: connect }, getDbConfig: () => ({}),
    hmacAuth: { generateSignature: (_key, body) => body }, outboundJson: async (_method, url, body) => { calls.push({ url, ...body }); return { json: { code: 200, data: 'https://fixture.invalid/cashier' } }; },
    jsonReply: (res, body, status = 200) => Object.assign(res, { status, body }) });
  const request = { method: 'POST', headers: { 'idempotency-key': 'external-link-request' }, body: { product_id: 102, user_id: 'untrusted-client-user' } };
  const linked = {}; await route('/api/juzhu/jiazheng/wechat-link', '', request, linked); assert.equal(linked.status, 200);
  await conn.query("UPDATE jz_vendors SET payment_mode='pay_center',url_link=NULL WHERE id=2");
  await conn.query("UPDATE jz_products SET status='off' WHERE id=102");
  const retried = {}; await route('/api/juzhu/jiazheng/wechat-link', '', request, retried);
  assert.equal(retried.status, 200); assert.equal(retried.body.order_ref, linked.body.order_ref);
  assert.equal(calls[1].url, 'https://fixture.invalid/link');
  await conn.query("UPDATE jz_products SET status='on' WHERE id=102");
  const wrongChannel = {}; await route('/api/juzhu/jiazheng/wechat-link', '', { ...request, headers: { 'idempotency-key': 'new-external-request' } }, wrongChannel);
  assert.equal(wrongChannel.status, 409);
  const [[external]] = await conn.execute('SELECT * FROM gr_orders WHERE order_ref=?', [linked.body.order_ref]);
  assert.equal(external.user_id, 'commerce-account-customer');
  assert.equal(external.payment_mode, 'wechat_mini');
  await assert.rejects(() => grOrders.updateOrderCallback(conn, { order_ref: external.order_ref, vendor_id: 1, status: 'paid', fee: 1 }), /不能修改/);
});
