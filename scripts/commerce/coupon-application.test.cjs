'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const use = require('../../commerce/coupon-application.cjs');

test('quote arithmetic and publish scope are strict', () => {
  assert.deepEqual(use.calculate({mode:'exchange',grossMinor:16000,faceMinor:12000,contractMinor:12000}),{listed_minor:16000,gross_minor:12000,coupon_minor:12000,cash_minor:0});
  assert.deepEqual(use.calculate({mode:'amount_offset',grossMinor:30000,faceMinor:10000}),{listed_minor:30000,gross_minor:30000,coupon_minor:10000,cash_minor:20000});
  assert.throws(()=>use.calculate({mode:'exchange',grossMinor:30000,faceMinor:10000,contractMinor:12000}),/签约兑付金额/);
  assert.throws(()=>use.calculate({mode:'exchange',grossMinor:16000,faceMinor:12000,contractMinor:12000,unitCount:2}),/只覆盖一项/);
  assert.throws(()=>use.calculate({mode:'amount_offset',grossMinor:9000,faceMinor:10000}),/低于券面值/);
  const policy={domains:['booking','jiazheng'],vendorIds:[11,22],bookingProjectIds:[101],lifeProductIds:[202]};
  use.validateScope(policy,{bizType:'booking',cityId:3,vendorId:11,itemId:101});
  use.validateScope(policy,{bizType:'jiazheng',cityId:3,vendorId:22,itemId:202});
  assert.throws(()=>use.validateScope(policy,{bizType:'booking',cityId:3,vendorId:22,itemId:202}),/项目或服务/);
  assert.throws(()=>use.validateScope(policy,{bizType:'jiazheng',cityId:3,vendorId:33,itemId:202}),/商户/);
});

test('one coupon cannot fund two business orders; cancellation restores it', {skip:!process.env.PAYMENT_TEST_SOCKET}, async () => {
  const admin=await mysql.createConnection({socketPath:process.env.PAYMENT_TEST_SOCKET,user:'root'});
  const db='coupon_use_test_'+crypto.randomBytes(5).toString('hex');
  let pool;
  try {
    await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4`);
    pool=mysql.createPool({socketPath:process.env.PAYMENT_TEST_SOCKET,user:'root',database:db,timezone:'Z',dateStrings:true,connectionLimit:5});
    await pool.query(`CREATE TABLE commerce_orders(id VARCHAR(40) PRIMARY KEY,account_id BIGINT,city_id BIGINT,payment_status VARCHAR(24),paid_payment_order_id BIGINT,refunded_minor BIGINT DEFAULT 0,snapshot JSON)`);
    await pool.query(`CREATE TABLE commerce_coupons(id VARCHAR(40) PRIMARY KEY,order_id VARCHAR(40),account_id BIGINT,merchant_id BIGINT,city_id BIGINT,status VARCHAR(24),expires_at DATETIME,allocation_minor BIGINT,snapshot JSON)`);
    await pool.query(`CREATE TABLE commerce_appointments(id VARCHAR(40) PRIMARY KEY,coupon_id VARCHAR(40),status VARCHAR(24))`);
    const conn=await pool.getConnection();try{await use.migrate(conn);await use.migrate(conn);}finally{conn.release();}
    const order=crypto.randomUUID(),coupon=crypto.randomUUID();
    await pool.execute("INSERT INTO commerce_orders(id,account_id,city_id,payment_status,paid_payment_order_id,snapshot) VALUES(?,7,3,'paid',55,?)",[order,JSON.stringify({settlement_profiles:{11:{source_account_id:'source-1'}}})]);
    const sku={use_mode:'amount_offset',use_domains:['booking','jiazheng'],use_vendor_ids:[11,22],booking_project_ids:[101],life_product_ids:[202]};
    await pool.execute("INSERT INTO commerce_coupons(id,order_id,account_id,merchant_id,city_id,status,expires_at,allocation_minor,snapshot) VALUES(?,?,7,11,3,'available','2099-01-01',10000,?)",[coupon,order,JSON.stringify({sku})]);
    async function reserve(bizType,orderNo,itemId,vendorId,grossMinor){const c=await pool.getConnection();try{await c.beginTransaction();const out=await use.reserve(c,{couponId:coupon,accountId:7,bizType,orderNo,cityId:3,vendorId,itemId,grossMinor});await c.commit();return out;}catch(e){await c.rollback();throw e;}finally{c.release();}}
    const attempts=await Promise.allSettled([reserve('booking','BKG-101',101,11,30000),reserve('jiazheng','WO-202',202,22,30000)]);
    assert.equal(attempts.filter(v=>v.status==='fulfilled').length,1);
    const winner=attempts.find(v=>v.status==='fulfilled').value;
    assert.equal(Number(winner.coupon_minor)+Number(winner.cash_minor),30000);
    const c=await pool.getConnection();try{await c.beginTransaction();await use.transition(c,{bizType:winner.biz_type,orderNo:winner.order_no,from:['reserved'],to:'released'});await c.commit();}finally{c.release();}
    const second=await reserve(winner.biz_type==='booking'?'jiazheng':'booking','ORDER-SECOND',winner.biz_type==='booking'?202:101,winner.biz_type==='booking'?22:11,30000);
    assert.equal(second.cash_minor,20000);
    const [rows]=await pool.execute('SELECT status FROM commerce_coupons WHERE id=?',[coupon]);assert.equal(rows[0].status,'reserved');
    await assert.rejects(()=>reserve('booking','BKG-THIRD',101,11,30000),/被占用/);
    await pool.execute("UPDATE commerce_orders SET refunded_minor=100 WHERE id=?",[order]);
    const c2=await pool.getConnection();try{await c2.beginTransaction();await use.transition(c2,{bizType:second.biz_type,orderNo:second.order_no,from:['reserved'],to:'released'});await c2.commit();}finally{c2.release();}
    await assert.rejects(()=>reserve('booking','BKG-FOURTH',101,11,30000),/发生退款/);
  } finally {
    if(pool)await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);await admin.end();
  }
});
