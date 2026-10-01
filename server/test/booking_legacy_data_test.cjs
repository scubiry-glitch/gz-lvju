'use strict';

// Pin the pre-cashier contract so committing this change does not replace the legacy fixture.
const LEGACY_REF = process.env.PAYMENT_LEGACY_REF || 'f68bdb53f47f6e1e973b26d12e368f07c259f67a';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const mysql = require('mysql2/promise');
const { migrate, VERSION, CHECKSUM } = require('../payment/migrate.cjs');
const { createPaymentCore } = require('../payment/core.cjs');
const { createBookingPaymentAdapter } = require('../payment/booking-adapter.cjs');

const socketPath = process.env.PAYMENT_TEST_SOCKET;
test('booking legacy data survives additive migration and recovery', { skip: !socketPath, timeout: 120000 }, async t => {
  assert.match(socketPath, /^\/tmp\/[\w-]*cashier[\w-]*\/[^/]+\.sock$/);
  const database = 'cashier_booking_legacy_' + process.pid + '_' + crypto.randomBytes(3).toString('hex');
  const options = { socketPath, user: 'root', timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true };
  const admin = await mysql.createConnection(options);
  await admin.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4');
  t.after(async () => { await admin.query('DROP DATABASE `' + database + '`'); await admin.end(); });
  const createConnection = () => mysql.createConnection({ ...options, database });
  const db = async (sql, params = []) => { const conn = await createConnection(); try { return (await conn.execute(sql, params))[0]; } finally { await conn.end(); } };
  const originalSchema = execFileSync('git', ['show', LEGACY_REF + ':server/schema.cjs'], { encoding: 'utf8', cwd: __dirname + '/../..' });
  for (const table of ['booking_orders','stay_calendar','payment_orders','payment_refunds','payment_gateway_logs','payment_notify_log']) {
    const match = originalSchema.match(new RegExp('`(CREATE TABLE IF NOT EXISTS ' + table + '[\\s\\S]*?)`'));
    assert.ok(match, 'Original schema exists: ' + table); await db(match[1]);
  }
  await db('ALTER TABLE stay_calendar ADD COLUMN qty_base INT NULL');
  await db('ALTER TABLE booking_orders ADD COLUMN paid_payment_order_id BIGINT NULL,ADD COLUMN latest_refund_id BIGINT NULL,ADD COLUMN refund_status VARCHAR(24),ADD COLUMN refunded_at DATETIME');
  await db('CREATE TABLE accounts(id VARCHAR(64) PRIMARY KEY,idp_type VARCHAR(16),idp_subject VARCHAR(64))');
  await db("INSERT INTO accounts VALUES('owner','beike','current-ucid')");
  await db('CREATE TABLE jz_vendors(id INT PRIMARY KEY,pay_merchant_no VARCHAR(64))');
  await db("INSERT INTO jz_vendors VALUES(1,'current-merchant')");
  await db('CREATE TABLE units(id INT PRIMARY KEY,project_id INT,sort_order INT,ext TEXT)');
  let sequence = 0;
  async function booking({ status = 'pending', payStatus = 'unpaid', owner = 'owner', expires = '2040-01-01 00:00:00', channel = 'minsu' } = {}) {
    const id = ++sequence, orderNo = 'BKG-LEGACY-' + id;
    await db(`INSERT INTO booking_orders(order_no,project_id,unit_id,channel,owner_vendor_id,user_id,contact_name,contact_phone,checkin,checkout,nights,rooms,price_total,status,pay_status,payment_expires_at,created_at,updated_at)
      VALUES(?,?,?, ?,1,?,'测试住客','13800000000','2099-10-02','2099-10-04',2,2,246,?,?,?,'2026-09-30 14:00:00','2026-09-30 14:00:00')`, [orderNo,id,id,channel,owner,status,payStatus,expires]);
    await db('INSERT INTO units(id,project_id,sort_order,ext) VALUES(?,?,1,?)', [id,id,JSON.stringify({cancel_policy:{enabled:true,days_before:1,cutoff_time:'18:00'}})]);
    for (const date of ['2099-10-02','2099-10-03']) await db("INSERT INTO stay_calendar(project_id,unit_id,stay_date,status,price_night,qty,qty_base,booked_qty,source,updated_at) VALUES(?,?,?,'open',150,5,5,2,'vendor','2026-09-30 14:00:00')", [id,id,date]);
    return { id, orderNo };
  }
  async function payment(order, state = 'paying', overrides = {}) {
    const appId = 'XD_' + crypto.randomBytes(10).toString('hex');
    const inserted = await db(`INSERT INTO payment_orders(biz_order_no,app_order_id,amount,payer_ucid,payer_user_type,merchant_no,share_biz_code,cashier_type,pay_status,callback_url,cashier_url,cashier_expires_at,paid_at,created_at,updated_at)
      VALUES(?,?,'246.00',?,?,?,'original-share','2',?,'https://fixture.invalid/original-notify','https://fixture.invalid/original-cashier','2040-01-01 00:00:00',?,'2026-09-30 14:00:00','2026-09-30 14:00:00')`,
    [order.orderNo,appId,overrides.payer || 'original-ucid','9',overrides.merchant || 'original-merchant',state,state === 'paid' ? '2026-09-30 15:00:00' : null]);
    return { id: inserted.insertId, appId };
  }
  async function log(payment, content) {
    await db("INSERT INTO payment_gateway_logs(payment_order_id,app_order_id,operation_type,request_no,request_json,started_at) VALUES(?,?,'pay_create',?,?,'2026-09-30 14:00:00')", [payment.id,payment.appId,crypto.randomUUID(),typeof content === 'string' ? content : JSON.stringify(content)]);
  }
  const paying = await booking(), originalPay = await payment(paying);
  await log(originalPay, '{invalid json');
  await log(originalPay, { appOrderId: 'different-payment', appCode: 'wrong-app', projectCode: 'wrong-project' });
  await log(originalPay, { appOrderId: originalPay.appId, appCode: 'original-app', projectCode: 'original-project' });
  const confirmed = await booking({ status: 'confirmed', payStatus: 'paid', expires: null, channel: 'rental' }), confirmedPay = await payment(confirmed, 'paid');
  await db('UPDATE booking_orders SET paid_payment_order_id=? WHERE order_no=?', [confirmedPay.id,confirmed.orderNo]);
  const conn = await createConnection(); await migrate(conn); await migrate(conn); await conn.end();
  const config = { PAY_APP_CODE:'current-app', PAY_PROJECT_CODE:'current-project', PAY_SHARE_BIZ_CODE:'current-share', PAY_NOTIFY_URL:'https://fixture.invalid/current-notify', PAY_USER_TYPE:'2' };
  const core = createPaymentCore({ createConnection, config, payCenter: {}, logger: { warn() {} } });
  const adapter = createBookingPaymentAdapter({ core, createConnection, config });
  const account = { id:'owner', idp_type:'beike', idp_subject:'current-ucid' };
  const inventory = async order => (await db('SELECT stay_date,status,price_night,qty,qty_base,booked_qty,source FROM stay_calendar WHERE project_id=? ORDER BY stay_date', [order.id])).map(row => ({...row}));

  await t.test('migration keeps v1 checksum, VARCHAR32 and original rows; restores only matching create evidence', async () => {
    assert.equal((await db('SELECT checksum FROM payment_migrations WHERE version=?', [VERSION]))[0].checksum, CHECKSUM);
    const widths = await db("SELECT CHARACTER_MAXIMUM_LENGTH n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('payment_orders','payment_refunds') AND COLUMN_NAME='biz_order_no'");
    assert.deepEqual(widths.map(row => Number(row.n)), [32,32]);
    const row = (await db('SELECT * FROM payment_orders WHERE id=?', [originalPay.id]))[0];
    assert.equal(row.app_code,'original-app'); assert.equal(row.project_code,'original-project');
    assert.equal(row.payer_ucid,'original-ucid'); assert.equal(row.payer_user_type,'9'); assert.equal(row.merchant_no,'original-merchant');
    assert.equal(row.created_at,'2026-09-30 14:00:00'); assert.equal(row.amount_minor,'24600');
    assert.equal((await db('SELECT app_code FROM payment_orders WHERE id=?',[confirmedPay.id]))[0].app_code,null);
  });
  await t.test('live old cashier keeps original payer, merchant, app and pay number after account/config changes', async () => {
    const status = await adapter.status({ orderNo:paying.orderNo,account,refresh:false });
    assert.equal(status.app_order_id,originalPay.appId); assert.equal(status.cashier_url,'https://fixture.invalid/original-cashier');
    const guard = (await db('SELECT * FROM payment_order_guards WHERE biz_order_no=?',[paying.orderNo]))[0];
    assert.equal(guard.payer_ucid,'original-ucid'); assert.equal(guard.payer_user_type,'9'); assert.equal(guard.app_code,'original-app');
    assert.equal(guard.project_code,'original-project'); assert.equal(guard.share_biz_code,'original-share'); assert.equal(guard.callback_url,'https://fixture.invalid/original-notify');
    assert.deepEqual((await db('SELECT kind FROM payment_jobs WHERE target_id=?',[originalPay.id])).map(row=>row.kind),['pay_query']);
    await assert.rejects(adapter.intent({orderNo:paying.orderNo,account,cashierType:'2',requestKey:'changed-identity-request'}),{status:403});
  });
  await t.test('accepted confirmed rental with missing deadline remains paid and preserves inventory', async () => {
    const before = await inventory(confirmed);
    const status = await adapter.status({orderNo:confirmed.orderNo,account,refresh:false});
    assert.equal(status.order_pay_status,'paid'); assert.equal(status.fulfillment_status,'fulfilled');
    await adapter.confirm({orderNo:confirmed.orderNo,source:'vendor',vendorId:1});
    await adapter.expire(); await core.consumeEvents('booking',adapter.handleEvent);
    const row=(await db('SELECT status,pay_status,payment_expires_at FROM booking_orders WHERE order_no=?',[confirmed.orderNo]))[0];
    assert.equal(row.status,'confirmed'); assert.equal(row.pay_status,'paid'); assert.equal(row.payment_expires_at,null);
    assert.deepEqual(await inventory(confirmed),before); assert.equal((await db('SELECT id FROM payment_refunds WHERE biz_order_no=?',[confirmed.orderNo])).length,0);
  });
  await t.test('closed historical attempt may differ; latest unresolved attempt supplies the original snapshot', async () => {
    const order=await booking(), old=await payment(order,'closed',{payer:'old-ucid',merchant:'old-merchant'}), current=await payment(order,'paying');
    const status=await adapter.status({orderNo:order.orderNo,account,refresh:false});
    assert.equal(status.app_order_id,current.appId);
    const rows=await db('SELECT id,payer_ucid,merchant_no FROM payment_orders WHERE biz_order_no=? ORDER BY id',[order.orderNo]);
    assert.equal(rows[0].payer_ucid,'old-ucid'); assert.equal(rows[0].merchant_no,'old-merchant'); assert.notEqual(String(old.id),String(current.id));
  });
  await t.test('old free/offline booking cancels once while merchant calendar overrides survive', async () => {
    const order=await booking({payStatus:null,owner:null,status:'confirmed',channel:'rental'});
    await adapter.cancel({orderNo:order.orderNo,source:'vendor',vendorId:1});
    await adapter.cancel({orderNo:order.orderNo,source:'vendor',vendorId:1});
    const rows=await inventory(order); assert.equal(rows.length,2);
    assert.ok(rows.every(row=>row.booked_qty===0&&row.price_night===150&&row.qty===5&&row.qty_base===5&&row.source==='vendor'));
    const row=(await db('SELECT status,pay_status FROM booking_orders WHERE order_no=?',[order.orderNo]))[0];
    assert.equal(row.status,'cancelled'); assert.equal(row.pay_status,null);
    assert.equal((await db('SELECT biz_order_no FROM payment_order_guards WHERE biz_order_no=?',[order.orderNo])).length,0);
  });
  await t.test('anonymous expired unpaid order with no payment can release legacy stock without an invented payer', async () => {
    const order=await booking({owner:null,expires:'2020-01-01 00:00:00'});
    const result=await adapter.expire(); assert.equal(result.errors.length,0); assert.equal(result.requested,1);
    await adapter.expire();
    assert.ok((await inventory(order)).every(row=>row.booked_qty===0));
    assert.equal((await db('SELECT pay_status FROM booking_orders WHERE order_no=?',[order.orderNo]))[0].pay_status,'expired');
    assert.equal((await db('SELECT biz_order_no FROM payment_order_guards WHERE biz_order_no=?',[order.orderNo])).length,0);
  });
  await t.test('cancelled refunded legacy order neither reopens nor releases another booking stock', async () => {
    const order=await booking({status:'cancelled',payStatus:'refunded',expires:null}), pay=await payment(order,'paid');
    await db('UPDATE booking_orders SET paid_payment_order_id=?,refund_status=\'refunded\' WHERE order_no=?',[pay.id,order.orderNo]);
    const refundId='RF_'+crypto.randomBytes(10).toString('hex');
    await db(`INSERT INTO payment_refunds(payment_order_id,biz_order_no,app_order_id,idempotency_key,refund_reason_type,trigger_source,refund_amount,amount_minor,payer_ucid,merchant_no,refund_status,created_at,updated_at) VALUES(?,?,?,?,'booking_cancel','user','246.00',24600,'original-ucid','original-merchant','refunded','2026-09-30 15:00:00','2026-09-30 15:00:00')`,[pay.id,order.orderNo,refundId,'booking_cancel:'+order.orderNo]);
    const before=await inventory(order);
    const status=await adapter.status({orderNo:order.orderNo,account,refresh:false}); assert.equal(status.order_pay_status,'refunded');
    const replay=await adapter.cancel({orderNo:order.orderNo,source:'vendor',vendorId:1}); assert.equal(replay.idempotent_replay,true);
    await core.consumeEvents('booking',adapter.handleEvent); assert.deepEqual(await inventory(order),before);
    assert.equal((await db('SELECT id FROM payment_jobs WHERE target_id=? AND kind LIKE \'refund_%\'',[pay.id])).length,0);
  });
  await t.test('paid customer cancellation retains original refund payee and the existing cancellation policy', async () => {
    const order=await booking({payStatus:'paid'}), pay=await payment(order,'paid');
    await db('UPDATE booking_orders SET paid_payment_order_id=? WHERE order_no=?',[pay.id,order.orderNo]);
    await db('UPDATE units SET ext=? WHERE id=?',[JSON.stringify({cancel_policy:{enabled:false}}),order.id]);
    await assert.rejects(adapter.cancel({orderNo:order.orderNo,account,source:'user'}),{code:'cancel_not_allowed'});
    assert.ok((await inventory(order)).every(row=>row.booked_qty===2));
    await db('UPDATE units SET ext=? WHERE id=?',[JSON.stringify({cancel_policy:{enabled:true,days_before:1,cutoff_time:'18:00'}}),order.id]);
    await adapter.cancel({orderNo:order.orderNo,account,source:'user'});
    await adapter.cancel({orderNo:order.orderNo,account,source:'user'});
    const rows=await db('SELECT * FROM payment_refunds WHERE payment_order_id=?',[pay.id]);
    assert.equal(rows.length,1); assert.equal(rows[0].payer_ucid,'original-ucid'); assert.equal(rows[0].merchant_no,'original-merchant');
    assert.equal(rows[0].refund_amount,'246.00'); assert.ok((await inventory(order)).every(row=>row.booked_qty===0));
  });
  await t.test('first guard registration racing legacy expiry never releases inventory twice', async () => {
    const order=await booking({expires:'2020-01-01 00:00:00'});
    const results=await Promise.all([adapter.expire(),adapter.status({orderNo:order.orderNo,account,refresh:false})]);
    assert.equal(results[0].errors.length,0);
    await adapter.expire(); await core.consumeEvents('booking',adapter.handleEvent);
    await adapter.expire(); await core.consumeEvents('booking',adapter.handleEvent);
    assert.ok((await inventory(order)).every(row=>row.booked_qty===0));
    assert.equal((await db('SELECT status FROM booking_orders WHERE order_no=?',[order.orderNo]))[0].status,'cancelled');
  });
  await t.test('unproven old paid flags and confirmed unpaid orders never start another charge', async () => {
    const order=await booking({payStatus:'paid'});
    await assert.rejects(adapter.status({orderNo:order.orderNo,account,refresh:false}),{code:'payment_migration_conflict'});
    assert.equal((await db('SELECT biz_order_no FROM payment_order_guards WHERE biz_order_no=?',[order.orderNo])).length,0);
    const confirmedUnpaid=await booking({status:'confirmed'});
    await assert.rejects(adapter.intent({orderNo:confirmedUnpaid.orderNo,account,cashierType:'2',requestKey:'confirmed-never-charge'}),{code:'booking_not_payable'});
  });
});
