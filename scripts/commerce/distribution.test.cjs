'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mysql=require('mysql2/promise');
const {Service}=require('../../commerce/service.cjs');
const distribution=require('../../commerce/distribution.cjs');
const couponUse=require('../../commerce/coupon-application.cjs');

test('funded campaign needs another reviewer and transfers usable coupons without moving original payment',
  {skip:!process.env.PAYMENT_TEST_SOCKET,timeout:120000},async()=>{
  process.env.JUZHU_API_KEY='isolated-test-distribution-secret';
  const socketPath=process.env.PAYMENT_TEST_SOCKET,db='distribution_test_'+crypto.randomBytes(5).toString('hex');
  const admin=await mysql.createConnection({socketPath,user:'root'});
  let pool;
  try{
    await admin.query('CREATE DATABASE '+mysql.escapeId(db)+' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    pool=mysql.createPool({socketPath,user:'root',database:db,connectionLimit:8});
    await require('../../server/settlement/index.cjs').migrate(pool);
    const q=async(sql,args=[])=>(await pool.execute(sql,args))[0];
    const orderId=crypto.randomUUID(),couponIds=[crypto.randomUUID(),crypto.randomUUID()];
    const orderSnapshot={settlement_profiles:{1:{source_account_id:'controlled-source'}}};
    await q("INSERT INTO commerce_orders(id,account_id,city_id,product_kind,product_id,product_version,amount_minor,status,expires_at,snapshot,payment_mode,payment_status,paid_payment_order_id) VALUES(?,101,3,'skus',1,1,10000,'fulfilled','2099-01-01',?,'pay_center','paid',99)",[orderId,JSON.stringify(orderSnapshot)]);
    await q("INSERT INTO commerce_funding_sources(id,context_id,payment_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,99,'PAYMENT','TEST','ISOLATED_TEST','CNY',?,'test-contract',10000,'AVAILABLE','{}')",
      [crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()]);
    const policy={name:'通用抵用券',use_mode:'amount_offset',use_domains:['jiazheng'],use_vendor_ids:[11],use_vendor_contracts:{11:{merchant_id:1,contract_ref:'C-11'}},life_product_ids:[201]};
    for(let i=0;i<couponIds.length;i++)await q("INSERT INTO commerce_coupons(id,order_id,item_id,unit_no,account_id,merchant_id,store_id,city_id,status,expires_at,allocation_minor,snapshot) VALUES(?,?,1,?,101,1,1,3,'available','2099-01-01',5000,?)",
      [couponIds[i],orderId,i+1,JSON.stringify({sku:policy})]);
    const service=new Service(pool,{});
    service.allowed=async()=>{};
    service.audit=async()=>{};
    service.scope=()=>({level:'all'});
    const sponsor={account:{id:101}},reviewer={account:{id:102}},people=[{account:{id:201}},{account:{id:202}}];
    const input={order_id:orderId,coupon_ids:couponIds,expires_days:7,per_user_limit:1};
    const first=await distribution.create(service,sponsor,input,'create-campaign-draft');
    assert((await q('SELECT status FROM commerce_coupons WHERE order_id=?',[orderId])).every(x=>x.status==='reserved'));
    await distribution.action(service,sponsor,first.id,'close');
    assert((await q('SELECT status FROM commerce_coupons WHERE order_id=?',[orderId])).every(x=>x.status==='available'));
    const timed=await distribution.create(service,sponsor,input,'create-campaign-expire');
    await q('UPDATE commerce_distribution_campaigns SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 SECOND WHERE id=?',[timed.id]);
    await distribution.expire(service);
    assert((await q('SELECT status FROM commerce_coupons WHERE order_id=?',[orderId])).every(x=>x.status==='available'));
    const campaign=await distribution.create(service,sponsor,input,'create-campaign-active');
    assert.equal(campaign.status,'draft');
    assert((await q('SELECT status FROM commerce_coupons WHERE order_id=?',[orderId])).every(x=>x.status==='reserved'));
    await distribution.action(service,sponsor,campaign.id,'submit');
    await assert.rejects(distribution.action(service,sponsor,campaign.id,'review',{action:'approve',note:'资金已核验'}),/提交人不能复核/);
    await distribution.action(service,reviewer,campaign.id,'review',{action:'approve',note:'资金已核验'});
    const active=await distribution.action(service,sponsor,campaign.id,'activate');
    assert.equal((await distribution.preview(pool,active.token)).remaining,2);
    const claimed=await Promise.all(people.map((person,i)=>distribution.claim(service,person,active.token,'claim-'+i+'-once')));
    assert.equal(new Set(claimed.map(x=>x.coupon_id)).size,2);
    assert.equal((await distribution.preview(pool,active.token)).remaining,0);
    assert.deepEqual(await distribution.claim(service,people[0],active.token,'claim-0-once'),claimed[0]);
    await assert.rejects(distribution.claim(service,people[0],active.token,'claim-again'),/领取上限/);
    const transferred=claimed[0].coupon_id;
    await q("UPDATE commerce_orders SET payment_status='partially_refunded',refunded_minor=5000 WHERE id=?",[orderId]);
    const conn=await pool.getConnection();
    try{
      const available=await couponUse.listQuotes(conn,{accountId:201,bizType:'jiazheng',cityId:3,vendorId:11,itemId:201,grossMinor:12000});
      assert(available.some(x=>x.coupon_id===transferred),'recipient must see a usable voucher during checkout');
      const quote=await couponUse.quote(conn,{couponId:transferred,accountId:201,bizType:'jiazheng',cityId:3,vendorId:11,itemId:201,grossMinor:12000});
      assert.equal(quote.coupon_minor,5000);
      assert.equal(quote.cash_minor,7000);
      await assert.rejects(couponUse.quote(conn,{couponId:transferred,accountId:101,bizType:'jiazheng',cityId:3,vendorId:11,itemId:201,grossMinor:12000}),/不属于当前账号/);
    }finally{conn.release();}
    await assert.rejects(service.openCase(people[0],{coupon_id:transferred,kind:'refund',reason:'不要使用此券了'},'refund-claim'),/赠送券不能由领取人/);
    const [dbOrder]=await q('SELECT account_id,paid_payment_order_id FROM commerce_orders WHERE id=?',[orderId]);
    assert.equal(Number(dbOrder.account_id),101);
    assert.equal(Number(dbOrder.paid_payment_order_id),99);
    const ownership=await q('SELECT id,account_id FROM commerce_coupons WHERE order_id=? ORDER BY id',[orderId]);
    assert.deepEqual(ownership.map(x=>Number(x.account_id)).sort(),[201,202]);
    const clicks=require('../../commerce/promotion-clicks.cjs');
    const visit={ip:'127.0.0.1',userAgent:'isolated-test'},link={aid:777,kind:'skus',id:42};
    assert.equal(await clicks.record(pool,'signed-link',link,visit),true);
    assert.equal(await clicks.record(pool,'signed-link',link,visit),false);
    assert.equal(await clicks.record(pool,'signed-link',link,{...visit,ip:'127.0.0.2'}),true);
    const [daily]=await q('SELECT clicks FROM commerce_referral_daily WHERE promoter_account_id=777 AND product_id=42');
    assert.equal(Number(daily.clicks),2);
    const [raw]=await q("SELECT COUNT(*) n FROM commerce_events WHERE event_type='referral.click'");
    assert.equal(Number(raw.n),0,'new clicks must use bounded daily aggregation');
  }finally{if(pool)await pool.end();await admin.query('DROP DATABASE IF EXISTS '+mysql.escapeId(db));await admin.end();}
});
