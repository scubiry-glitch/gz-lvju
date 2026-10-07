'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mysql=require('mysql2/promise');

test('local service uses only the cash difference and full exchange creates no payment guard', {skip:!process.env.PAYMENT_TEST_SOCKET}, async()=>{
  const socketPath=process.env.PAYMENT_TEST_SOCKET;
  const cfg=require('../../commerce/db.cjs').config();
  const database='coupon_order_test_'+crypto.randomBytes(5).toString('hex');
  const admin=await mysql.createConnection({socketPath,user:'root'});
  let pool;
  const business=require('../../server/settlement/business.cjs');
  const originalCapture=business.captureProfile;
  try{
    await admin.query('CREATE DATABASE '+mysql.escapeId(database)+' CHARACTER SET utf8mb4');
    pool=mysql.createPool({socketPath,user:'root',database,timezone:'Z',dateStrings:true,connectionLimit:6});
    for(const table of ['cities','jz_categories','jz_skus','jz_vendors','jz_products','jz_orders','jz_sku_slots','gr_orders','commerce_orders','commerce_coupons','commerce_appointments','payment_order_guards'])
      await pool.query('CREATE TABLE '+mysql.escapeId(table)+' LIKE '+mysql.escapeId(cfg.database)+'.'+mysql.escapeId(table));
    const c=await pool.getConnection();try{await require('../../commerce/coupon-application.cjs').migrate(c);}finally{c.release();}
    await pool.query("INSERT INTO cities(id,name,slug) VALUES(3,'测试城市','test')");
    await pool.query("INSERT INTO jz_categories(id,name) VALUES('cleaning','保洁')");
    await pool.query("INSERT INTO jz_skus(id,category_id,name,slug) VALUES(1,'cleaning','清洁服务','clean')");
    await pool.query("INSERT INTO jz_vendors(id,type,name,status,city_ids,payment_mode,pay_merchant_no) VALUES(1,'cleaning','测试商家','active','3','pay_center','merchant-1')");
    await pool.query("INSERT INTO jz_products(id,vendor_id,title,price,channel_sku_id,city_id,status) VALUES(201,1,'测试保洁',150.09,1,3,'on')");
    const originalOrder=crypto.randomUUID();
    await pool.execute("INSERT INTO commerce_orders(id,account_id,city_id,product_kind,product_id,product_version,amount_minor,status,expires_at,snapshot,payment_status,paid_payment_order_id) VALUES(?,101,3,'skus',1,1,17809,'fulfilled','2099-01-01',?,'paid',55)",[originalOrder,JSON.stringify({settlement_profiles:{1:{source_account_id:'source-account'}}})]);
    const exchange=crypto.randomUUID(),offset=crypto.randomUUID();
    const base={name:'服务权益',use_domains:['booking','jiazheng'],use_vendor_ids:[1],booking_project_ids:[301],life_product_ids:[201]};
    for(const [id,unit,face,mode] of [[exchange,1,12809,'exchange'],[offset,2,5000,'amount_offset']])
      await pool.execute("INSERT INTO commerce_coupons(id,order_id,item_id,unit_no,account_id,merchant_id,store_id,city_id,status,expires_at,allocation_minor,snapshot) VALUES(?,?,1,?,101,1,1,3,'available','2099-01-01',?,?)",[id,originalOrder,unit,face,JSON.stringify({sku:{...base,use_mode:mode,...(mode==='exchange'?{exchange_contract_minor:12809}:{})}})]);
    business.captureProfile=async()=>({party_id:'target-party',source_account_id:'source-account',collection:{source_merchant_no:'merchant-1'},calculation:{mode:'PROPORTIONAL',rounding:'FLOOR_BPS_V1',commission_bps:1000}});
    const paymentAmounts=[];
    const fakeCore={registerOrder:async(_conn,payload)=>{paymentAmounts.push(payload.amountMinor);}};
    const connect=()=>mysql.createConnection({socketPath,user:'root',database,timezone:'Z',dateStrings:true});
    const adapter=require('../../server/payment/jiazheng-adapter.cjs').createJiazhengAdapter({createConnection:connect,paymentCore:fakeCore,config:{SETTLEMENT_ENABLED:'1'}});
    const account={id:101,status:'active',idp_type:'beike',idp_subject:'test-ucid'};
    const input={account,productId:201,house:'测试地址',phone:'13800000000',expectTime:'2099-01-01 12:00',desc:'',priceMinor:15009};
    const direct=await adapter.createOrder({...input,couponId:exchange,requestKey:'coupon-exchange-001'});
    assert.equal(direct.order.pay_status,'coupon_funded');assert.equal(direct.order.fee,12809);assert.equal(direct.order.cash_due_minor,0);assert.deepEqual(paymentAmounts,[]);
    const part=await adapter.createOrder({...input,couponId:offset,requestKey:'coupon-offset-001'});
    assert.equal(part.order.cash_due_minor,10009);assert.deepEqual(paymentAmounts,[10009]);
    const [applications]=await pool.execute('SELECT mode,gross_minor,coupon_minor,cash_minor FROM coupon_applications ORDER BY mode');
    assert.equal(applications.length,2);
    assert(applications.every(a=>Number(a.gross_minor)===Number(a.coupon_minor)+Number(a.cash_minor)));
    const [orders]=await pool.execute('SELECT id,coupon_minor,cash_due_minor FROM jz_orders');assert.equal(orders.length,2);
    const cancelled=await adapter.cancel({account,orderId:direct.order.id});assert.equal(cancelled.order.status,'cancelled');
    const [[restored]]=await pool.execute('SELECT status FROM commerce_coupons WHERE id=?',[exchange]);assert.equal(restored.status,'available');
    const expiring=await adapter.createOrder({...input,couponId:exchange,requestKey:'coupon-exchange-expiry-002'});
    await pool.execute("UPDATE jz_orders SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE) WHERE id=?",[expiring.order.id]);
    assert.equal(await adapter.expire(),1);
    const [[expired]]=await pool.execute('SELECT status,pay_status FROM jz_orders WHERE id=?',[expiring.order.id]);
    assert.deepEqual([expired.status,expired.pay_status],['cancelled','expired']);
    const [[restoredAfterExpiry]]=await pool.execute('SELECT status FROM commerce_coupons WHERE id=?',[exchange]);
    assert.equal(restoredAfterExpiry.status,'available');
  }finally{
    business.captureProfile=originalCapture;
    if(pool)await pool.end();
    await admin.query('DROP DATABASE IF EXISTS '+mysql.escapeId(database));await admin.end();
  }
});
