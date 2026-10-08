'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const {createServer} = require('../../commerce/app.cjs');
const {createPaymentCore} = require('../../server/payment/core.cjs');
const settlement = require('../../commerce/settlement.cjs');

// HEAD's running MySQL M1-A routes are the compatibility baseline. The old M0
// memory server and unimplemented PRD aliases are deliberately not fixtures.
// Explicit isolated socket only; never import host db.cjs or contact a gateway.
test('M1-A membership and coupon HTTP contracts with unified payment additions', {skip:!process.env.PAYMENT_TEST_SOCKET}, async t => {
  const database = 'cashier_legacy_api_' + crypto.randomBytes(5).toString('hex');
  // Match commerce/db.cjs: DATETIME values are UTC Date objects, not local-time
  // strings (which would make a fresh 120-second code appear already expired).
  const db = {socketPath:process.env.PAYMENT_TEST_SOCKET,user:'root',database,timezone:'Z'};
  const admin = await mysql.createConnection({socketPath:db.socketPath,user:'root'});
  let pool, server;
  try {
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
    pool = mysql.createPool({...db,connectionLimit:8});
    for(const sql of [
      'CREATE TABLE accounts(id BIGINT PRIMARY KEY,display_name VARCHAR(100),principal_type VARCHAR(20),status VARCHAR(20),vendor_id BIGINT NULL)',
      'CREATE TABLE cities(id BIGINT PRIMARY KEY,name VARCHAR(100),slug VARCHAR(100))',
      'CREATE TABLE gr_orders(order_ref VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),sku VARCHAR(100),city VARCHAR(100),status VARCHAR(32),fee BIGINT,created_at VARCHAR(40),updated_at VARCHAR(40),completed_at VARCHAR(40))',
      'CREATE TABLE jz_categories(id VARCHAR(50) PRIMARY KEY)',
      'CREATE TABLE jz_orders(id VARCHAR(64) PRIMARY KEY,sku_id BIGINT NULL,category_id VARCHAR(50),type VARCHAR(50),house VARCHAR(255),phone VARCHAR(50),expect_time VARCHAR(100),`desc` TEXT,fee BIGINT,pay_status VARCHAR(30),status VARCHAR(30),source VARCHAR(100),created_at VARCHAR(40),updated_at VARCHAR(40),log_json TEXT)',
      "INSERT INTO accounts VALUES(1,'fixture member','user','active',NULL),(2,'other member','user','active',NULL),(3,'fixture clerk','user','active',1),(4,'fixture admin','user','active',NULL)",
      "INSERT INTO cities VALUES(1,'fixture city','fixture')",
      "INSERT INTO jz_categories VALUES('community')",
    ]) await pool.query(sql);
    await require('../../commerce/migrate.cjs').migrate(pool);
    const connection = await pool.getConnection();
    try { await require('../../server/payment/migrate.cjs').migrate(connection); } finally {connection.release();}
    const config = {MYSQL_DB:database,COMMERCE_PAY_ENABLED:'0',COMMERCE_COLLECTION_MODE:'platform',COMMERCE_PAY_MERCHANT_NO:'fixture-platform',COMMERCE_PAY_APP_CODE:'fixture-app',COMMERCE_PAY_PROJECT_CODE:'fixture-project',COMMERCE_PAY_SHARE_BIZ_CODE:'fixture-share',COMMERCE_PAY_NOTIFY_URL:'https://invalid.example.test/notify'};
    const principals = Object.fromEntries([1,2,3,4].map(id=>[String(id),{
      account:{id,display_name:'fixture account '+id,status:'active',principal_type:'user',idp_type:'beike',idp_subject:'fixture-'+id},
      roles:id===4?[{permissions:['*']}]:id===3?[{permissions:['commerce.merchant.redeem','commerce.merchant.read']}]:[],
    }]));
    const auth = {
      bearerToken:req=>(req.headers.authorization||'').replace(/^Bearer /,''),
      verifySessionToken:async token=>principals[token]||null,
      permissionsOf:p=>new Set(p.roles.flatMap(r=>r.permissions)),
      hasPermission:(p,perm)=>p.roles.some(r=>r.permissions.includes('*')||r.permissions.includes(perm)),
      scopeOf:p=>p.account.id===3?{level:'vendor',vendorId:1}:{level:'all'},
    };
    const core = createPaymentCore({createConnection:()=>mysql.createConnection(db),config,logger:{warn(){}}});
    server = createServer({pool,auth,demoEnabled:true,paymentCore:core,paymentConfig:config});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base = 'http://127.0.0.1:'+server.address().port+'/api/commerce/v1';
    const service = server.service, owner = principals['1'], operator = principals['4'];
    const first = async (sql,args=[]) => (await pool.execute(sql,args))[0][0];
    const count = async table => Number((await first('SELECT COUNT(*) n FROM '+table)).n);
    const keys = (value,list) => list.forEach(key=>assert(Object.hasOwn(value,key),'missing response field '+key));
    async function http(path,{method='GET',user='1',body,key,status=200}={}) {
      const response = await fetch(base+path,{method,headers:{...(user?{Authorization:'Bearer '+user}:{}),...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
      const result = await response.json();
      assert.equal(response.status,status,method+' '+path+': '+JSON.stringify(result));
      if(status<400){assert.deepEqual(Object.keys(result),['data']);return result.data;}
      assert.equal(typeof result.error,'string');assert(!Object.hasOwn(result,'data'));return result;
    }
    async function published(kind,payload) {
      const [r] = await pool.execute(`INSERT INTO commerce_${kind}(name,city_id,merchant_id,store_id,vendor_id,version,published_version,status,payload,created_by) VALUES(?,?,?,?,?,1,1,'published',?,4)`,[payload.name,1,payload.merchant_id||null,payload.store_id||null,payload.vendor_id||null,JSON.stringify(payload)]);
      await pool.execute('INSERT INTO commerce_versions(kind,entity_id,version,snapshot,reviewed_by) VALUES(?,?,1,?,4)',[kind,r.insertId,JSON.stringify(payload)]);
      return {id:r.insertId,version:1,payload};
    }
    const demo = {initialization:{mode:'demo'}};
    const merchant = await published('merchants',{...demo,name:'fixture merchant',city_id:1,vendor_id:1});
    const store = await published('stores',{...demo,name:'fixture store',merchant_id:merchant.id,city_id:1,capacity:20,lead_hours:0});
    await published('staff',{name:'fixture clerk',merchant_id:merchant.id,store_id:store.id,account_id:3});
    const sku = await published('skus',{...demo,name:'fixture offline coupon',description:'fixture description',conditions:'fixture conditions',merchant_id:merchant.id,store_id:store.id,city_id:1,retail_minor:10000,supply_minor:7000,valid_days:30});
    const online = await published('skus',{...sku.payload,name:'fixture online coupon',redeem_channel:'online'});
    await pool.execute('INSERT INTO commerce_inventory(sku_id,total) VALUES(?,100),(?,100)',[sku.id,online.id]);
    const pkg = await published('packages',{...demo,name:'fixture package',city_id:1,price_minor:20000,items:[{sku_id:sku.id,quantity:2,sku:sku.payload,allocation_minor:10000}]});
    const plan = await published('plans',{...demo,name:'fixture membership',city_id:1,price_minor:20000,valid_days:365,package:pkg.payload});
    const demoBuy = (kind,product,key) => http('/demo-orders',{method:'POST',body:{kind,product_id:product.id,version:1,demo_ack:true},key,status:201});
    let packageOrder, memberOrder, offlineCoupon, onlineCoupon;
    await t.test('catalog, account, admin plans/packages and disabled purchase preserve v1 envelopes',async()=>{
      const meta = await http('/meta',{user:null});assert.equal(meta.payment_enabled,false);
      const me = await http('/me');keys(me,['account','permissions','scope']);keys(me.account,['id','display_name']);
      const catalog = await http('/catalog',{user:null});assert(Array.isArray(catalog));
      for(const kind of ['skus','packages','plans']){
        const entry=catalog.find(p=>p.kind===kind);keys(entry,['id','kind','version','name','price_minor','items','is_demo','demo_purchase_enabled']);assert.equal(entry.purchase_enabled,false);assert.equal(entry.demo_purchase_enabled,true);
      }
      for(const kind of ['plans','packages','memberships','coupons'])keys(await http('/admin/'+kind,{user:'4'}),['rows','total','page','size']);
      await http('/my',{user:null,status:401});
      await http('/orders',{method:'POST',body:{kind:'plans',product_id:plan.id,version:1},key:'closed-live-orders',status:409});
      await http('/demo-orders',{method:'POST',body:{kind:'plans',product_id:plan.id,version:1},key:'missing-demo-ack',status:422});
      await http('/demo-orders',{method:'POST',body:{kind:'plans',product_id:plan.id,version:2,demo_ack:true},key:'old-demo-version',status:409});
      await http('/test-sessions',{method:'POST',body:{},status:404});
      await http('/state',{status:404});
    });
    await t.test('demo package and membership purchases stay synchronous, zero-money and idempotent',async()=>{
      packageOrder=await demoBuy('packages',pkg,'legacy-package-01');memberOrder=await demoBuy('plans',plan,'legacy-membership-01');
      for(const order of [packageOrder,memberOrder]){keys(order,['id','status','is_demo','paid_minor','coupon_count']);assert.equal(order.status,'fulfilled');assert.equal(order.coupon_count,2);assert.equal(order.paid_minor,0);assert.equal(order.is_demo,true);}
      assert.deepEqual(await demoBuy('plans',plan,'legacy-membership-01'),memberOrder);
      const onlineOrder=await demoBuy('skus',online,'legacy-online-01');
      const mine=await http('/my');for(const kind of ['orders','coupons','memberships','appointments','cases','redemptions','refunds','compensations'])assert(Array.isArray(mine[kind]));
      for(const order of mine.orders){keys(order,['id','status','name','main_order_ref','is_demo']);assert.equal(order.status,'fulfilled');for(const field of ['payment_mode','payment_status','fulfillment_status','stock_status','paid_payment_order_id'])assert(!Object.hasOwn(order,field));}
      const membership=mine.memberships.find(m=>m.order_id===memberOrder.id);keys(membership,['order_id','name','expires_at','valid_days','items']);assert.equal(membership.items[0].quantity,2);
      offlineCoupon=mine.coupons.find(c=>c.order_id===packageOrder.id);onlineCoupon=mine.coupons.find(c=>c.order_id===onlineOrder.id);
      for(const coupon of mine.coupons){keys(coupon,['id','order_id','status','expires_at','name','conditions']);assert(!Object.hasOwn(coupon,'snapshot'));assert(!Object.hasOwn(coupon,'token_hash'));}
      const track=await http('/my/orders/'+memberOrder.id);keys(track,['id','status','product_kind','product_name','amount_minor','is_demo','created_at','coupons']);assert.equal(track.status,'fulfilled');assert(!Object.hasOwn(track,'payment_status'));assert.equal(track.coupons.length,2);
      await http('/my/orders/'+memberOrder.id,{user:'2',status:404});
      await http('/orders/'+memberOrder.id+'/test-pay',{method:'POST',body:{},status:404});
      await http('/orders/'+memberOrder.id+'/payment',{status:409});
      assert.equal(await count('payment_orders'),0);assert.equal(await count('payment_order_guards'),0);assert.equal(await count('commerce_ledger_entries'),0);
    });
    await t.test('appointment creation, rescheduling, cancellation and ownership retain method/status/fields',async()=>{
      const day=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
      const input={coupon_id:offlineCoupon.id,service_date:day(3)};
      const created=await http('/appointments',{method:'POST',body:input,key:'old-appointment-a',status:201});keys(created,['id','service_date','store_id']);
      assert.deepEqual(await http('/appointments',{method:'POST',body:input,key:'old-appointment-a',status:201}),created);
      await http('/appointments',{method:'POST',body:input,key:'old-appointment-b',status:409});
      const changed=await http('/appointments',{method:'POST',body:{...input,service_date:day(4)},key:'old-appointment-c',status:201});assert.notEqual(changed.id,created.id);
      assert.equal((await first('SELECT status FROM commerce_appointments WHERE id=?',[created.id])).status,'rescheduled');
      assert.deepEqual(await http('/appointments',{method:'POST',body:{coupon_id:offlineCoupon.id,action:'cancel'},key:'old-appointment-d',status:201}),{cancelled:true});
      await http('/appointments',{method:'POST',user:'2',body:input,key:'other-appointment',status:403});
      await http('/appointments',{method:'POST',body:{coupon_id:onlineCoupon.id,service_date:day(3)},key:'online-appointment',status:409});
    });
    await t.test('dynamic coupon code and preview/redeem preserve old fields without funding demos',async()=>{
      const token=await http('/coupons/'+onlineCoupon.id+'/token',{method:'POST',body:{}});assert.deepEqual(Object.keys(token).sort(),['coupon_id','expires_in','token']);assert.equal(token.expires_in,120);
      await http('/coupons/'+onlineCoupon.id+'/token',{method:'POST',user:'2',body:{},status:403});
      const input={coupon_id:onlineCoupon.id,token:token.token};
      const preview=await http('/merchant/redeem/preview',{method:'POST',user:'3',body:input});keys(preview,['coupon_id','name','description','conditions','store','service_date','customer','expires_at','allocation_minor','supplier_minor','is_demo','redeem_channel','preview']);assert.equal(preview.preview,true);assert.equal(await count('commerce_redemptions'),0);
      const redeemed=await http('/merchant/redeem',{method:'POST',user:'3',body:input,key:'legacy-redeem-01'});keys(redeemed,['id','status','store_id','online']);assert.equal(redeemed.status,'redeemed');assert.equal(redeemed.online,true);
      assert.deepEqual(await http('/merchant/redeem',{method:'POST',user:'3',body:input,key:'legacy-redeem-01'}),redeemed);
      await http('/merchant/redeem',{method:'POST',user:'3',body:input,key:'legacy-redeem-02',status:409});
      const offline=await first('SELECT id FROM commerce_coupons WHERE order_id=? LIMIT 1',[memberOrder.id]);
      const future=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
      const appointment=await http('/appointments',{method:'POST',body:{coupon_id:offline.id,service_date:future},key:'offline-service-day',status:201});
      // Advance only the isolated booking calendar to its service day.
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      await pool.execute('UPDATE commerce_capacity SET service_date=? WHERE store_id=? AND service_date=?',[today,store.id,future]);
      await pool.execute('UPDATE commerce_appointments SET service_date=? WHERE id=?',[today,appointment.id]);
      const offlineCode=await http('/coupons/'+offline.id+'/token',{method:'POST',body:{}});
      const offlineInput={coupon_id:offline.id,token:offlineCode.token};
      const offlinePreview=await http('/merchant/redeem/preview',{method:'POST',user:'3',body:offlineInput});assert.equal(offlinePreview.service_date,today);
      const offlineRedeemed=await http('/merchant/redeem',{method:'POST',user:'3',body:offlineInput,key:'offline-redeem'});assert.equal(offlineRedeemed.online,false);assert.equal(offlineRedeemed.status,'redeemed');
      assert.equal((await first('SELECT status FROM commerce_appointments WHERE id=?',[appointment.id])).status,'completed');
      assert.equal(await count('commerce_ledger_entries'),0);
    });
    await t.test('exchange and after-sales retain zero-money membership/coupon contracts',async()=>{
      const issued=await http('/admin/exchange-codes',{method:'POST',user:'4',body:{kind:'plans',product_id:plan.id,version:1,expires_days:7},key:'legacy-exchange-issue',status:201});keys(issued,['id','code','codes','count','expires_at','name','kind']);
      const input={code:issued.code,demo_ack:true};
      const exchanged=await http('/exchange',{method:'POST',body:input,key:'legacy-exchange-redeem',status:201});keys(exchanged,['id','status','coupon_count','paid_minor','kind','name']);assert.equal(exchanged.status,'fulfilled');
      assert.deepEqual(await http('/exchange',{method:'POST',body:input,key:'legacy-exchange-redeem',status:201}),exchanged);
      await http('/exchange',{method:'POST',user:'2',body:input,key:'used-exchange-code',status:409});
      const codes=await http('/admin/exchange-codes',{user:'4'});keys(codes,['rows','total','page','size','summary']);assert.equal(codes.rows[0].state,'redeemed');assert(!Object.hasOwn(codes.rows[0],'code_hash'));
      const entry=await http('/cases',{method:'POST',body:{coupon_id:offlineCoupon.id,kind:'refund',reason:'演示未使用卡券售后'},key:'demo-refund-case',status:201});keys(entry,['id','status','work_order_id']);assert.equal(entry.status,'open');
      const handled=await http('/admin/cases/'+entry.id+'/handle',{method:'POST',user:'4',body:{action:'accept',resolution:'演示权益无实际资金退款'}});assert.deepEqual(handled,{id:entry.id,status:'closed'});
      await http('/admin/settlement/refunds',{method:'POST',user:'4',body:{case_id:entry.id},key:'no-demo-refund',status:409});
      assert.equal(await count('payment_refunds'),0);assert.equal(await count('commerce_ledger_entries'),0);
    });
    let paidOrder, paymentId, liveSku;
    await t.test('historical fulfilled orders keep legacy state; new real orders add fields and trust server price',async()=>{
      const liveMerchant=await published('merchants',{name:'live fixture merchant',city_id:1,vendor_id:2});
      const liveStore=await published('stores',{name:'live fixture store',merchant_id:liveMerchant.id,city_id:1});
      const rule=await published('rules',{name:'live fixture rule',merchant_id:liveMerchant.id,beike_bps:2000,channel_bps:5000,floor_bps:1000});
      liveSku=await published('skus',{name:'live fixture coupon',merchant_id:liveMerchant.id,store_id:liveStore.id,city_id:1,retail_minor:10000,supply_minor:7000,valid_days:30,rule_id:rule.id,rule_version:1,rule:rule.payload});
      await pool.execute('INSERT INTO commerce_inventory(sku_id,total) VALUES(?,100)',[liveSku.id]);
      // Simulates already fulfilled M1-A rows before the payment migration.
      const historical=await service.reserveOrder(owner,{kind:'skus',product_id:liveSku.id,version:1},'legacy-historical-order');
      await service.fulfillPaidOrder(historical.id,'fixture-historical-receipt',10000);
      const old=(await http('/my')).orders.find(o=>o.id===historical.id);assert.equal(old.status,'fulfilled');assert(!Object.hasOwn(old,'payment_status'));assert(!Object.hasOwn((await http('/my/orders/'+old.id)),'fulfillment_status'));
      const enabled={...config,COMMERCE_PAY_ENABLED:'1'};
      service.payments=require('../../commerce/payment-adapter.cjs').createPaymentAdapter({service,core,config:enabled});
      await http('/demo-orders',{method:'POST',body:{kind:'skus',product_id:liveSku.id,version:1,demo_ack:true},key:'no-live-demo',status:409});
      await http('/orders',{method:'POST',body:{kind:'plans',product_id:plan.id,version:1},key:'no-demo-live',status:409});
      paidOrder=await http('/orders',{method:'POST',body:{kind:'skus',product_id:liveSku.id,version:1,amount_minor:1},key:'live-server-price',status:201});assert.equal(paidOrder.amount_minor,10000);assert.equal(paidOrder.status,'reserved');
      const current=(await http('/my')).orders.find(o=>o.id===paidOrder.id);keys(current,['id','status','amount_minor','payment_mode','payment_status','fulfillment_status']);assert.equal(current.payment_mode,'pay_center');assert.equal(current.status,'reserved');assert.equal(current.payment_status,'unpaid');
      await http('/orders/'+paidOrder.id+'/pay',{method:'POST',user:'2',body:{cashier_type:'2'},key:'other-pay-intent',status:404});
      const intent=await http('/orders/'+paidOrder.id+'/pay',{method:'POST',body:{cashier_type:'2'},key:'live-pay-intent',status:202});paymentId=intent.payment_id;
      const payment=await first('SELECT * FROM payment_orders WHERE id=?',[paymentId]);
      await core.reconcilePayment(paymentId,{data:{orderStatus:'30',appOrderId:payment.app_order_id,merchantNo:payment.merchant_no,amount:payment.amount}});
      await service.payments.consume();
      const track=await http('/my/orders/'+paidOrder.id);assert.equal(track.status,'fulfilled');assert.equal(track.payment_status,'paid');assert.equal(track.fulfillment_status,'fulfilled');
    });
    await t.test('real refund execute/query/retry keep legacy envelopes, original IDs and retry ceiling',async()=>{
      const coupon=await first('SELECT id FROM commerce_coupons WHERE order_id=?',[paidOrder.id]);
      const entry=await http('/cases',{method:'POST',body:{coupon_id:coupon.id,kind:'refund',reason:'未使用卡券退款契约验证'},key:'live-refund-case',status:201});
      await http('/admin/cases/'+entry.id+'/handle',{method:'POST',user:'4',body:{action:'accept',resolution:'核实后同意原路退款'}});
      const refund=await http('/admin/settlement/refunds',{method:'POST',user:'4',body:{case_id:entry.id},key:'live-refund-create',status:201});
      const url='/admin/settlement/refunds/'+refund.id;
      await http(url+'/query',{method:'POST',user:'4',body:{},status:409});assert.equal(await count('payment_refunds'),0);
      await pool.execute("UPDATE commerce_refund_orders SET status='unknown' WHERE id=?",[refund.id]);
      await http(url+'/query',{method:'POST',user:'4',body:{},status:409});assert.equal(await count('payment_refunds'),0);
      await pool.execute("UPDATE commerce_refund_orders SET status='pending' WHERE id=?",[refund.id]);
      const execute=await http(url+'/execute',{method:'POST',user:'4',body:{}});keys(execute,['id','request_no','submit','instrument']);assert.equal(execute.instrument.status,'submitted');
      const query=await http(url+'/query',{method:'POST',user:'4',body:{}});keys(query,['request_no','remote_status','instrument','query_count']);assert.equal(query.request_no,execute.request_no);assert.equal(query.instrument.payment_refund_id,execute.instrument.payment_refund_id);
      await http(url+'/retry',{method:'POST',user:'4',body:{},status:409});
      const original=await first('SELECT * FROM payment_refunds WHERE id=?',[execute.instrument.payment_refund_id]);
      await pool.execute("UPDATE payment_refunds SET refund_status='refund_failed' WHERE id=?",[original.id]);
      await pool.execute("UPDATE commerce_refund_orders SET status='failed' WHERE id=?",[refund.id]);
      for(let n=1;n<=2;n++){
        const retried=await http(url+'/retry',{method:'POST',user:'4',body:{}});keys(retried,['request_no','retry_count','instrument']);assert.equal(retried.retry_count,n);assert.equal(retried.request_no,execute.request_no);assert.equal(retried.instrument.payment_refund_id,original.id);
      }
      const concurrent=await Promise.allSettled(Array.from({length:4},()=>settlement.retryInstrument(service,operator,'refund',refund.id)));
      const accepted=concurrent.filter(r=>r.status==='fulfilled');assert.equal(accepted.length,1);assert.equal(accepted[0].value.retry_count,3);assert.equal(accepted[0].value.instrument.payment_refund_id,original.id);
      assert(concurrent.filter(r=>r.status==='rejected').every(r=>r.reason.code==='retry_exhausted'));
      const exhausted=await http(url+'/retry',{method:'POST',user:'4',body:{},status:409});assert.equal(exhausted.code,'retry_exhausted');assert.equal(await count('payment_refunds'),1);
      assert.equal((await first('SELECT app_order_id FROM payment_refunds WHERE id=?',[original.id])).app_order_id,original.app_order_id);
      await core.reconcileRefund(original.id,{data:{orderStatus:'30',appOrderId:original.app_order_id,merchantNo:original.merchant_no,refundAmount:original.refund_amount}});await service.payments.consume();
      const mine=await http('/my');const view=mine.refunds.find(r=>r.order_id===paidOrder.id);keys(view,['refund_no','coupon_id','coupon_name','order_id','amount_minor','kind','status','fail_reason','created_at','settled_at']);assert.equal(view.status,'refunded');
      const replay=await http(url+'/execute',{method:'POST',user:'4',body:{}});assert.equal(replay.instrument.status,'paid');assert.equal(replay.payment_refund_id,original.id);
      assert.equal(Number((await first('SELECT retry_count FROM commerce_refund_orders WHERE id=?',[refund.id])).retry_count),3);
      assert.equal(await count('commerce_provider_requests'),0);
      // Creating a pending command and cancelling it must never later send funds.
      const second=await service.payments.purchase(owner,{kind:'skus',product_id:liveSku.id,version:1},'cancel-refund-order');
      const secondIntent=await service.payments.pay(owner,second.id,{cashier_type:'2'},'cancel-refund-payment','127.0.0.1');
      const secondPayment=await first('SELECT * FROM payment_orders WHERE id=?',[secondIntent.payment_id]);
      await core.reconcilePayment(secondPayment.id,{data:{orderStatus:'30',appOrderId:secondPayment.app_order_id,merchantNo:secondPayment.merchant_no,amount:secondPayment.amount}});await service.payments.consume();
      const secondCoupon=await first('SELECT id FROM commerce_coupons WHERE order_id=?',[second.id]);
      const cancelCase=await service.openCase(owner,{coupon_id:secondCoupon.id,kind:'refund',reason:'待执行退款作废测试'},'cancel-refund-case');await service.resolveCase(operator,'commerce.admin.write',cancelCase.id,{action:'accept',resolution:'待执行退款状态校验通过'});
      const cancelled=await settlement.createRefundOrder(service,operator,{case_id:cancelCase.id},'cancel-refund-command');
      assert.deepEqual(await settlement.refundAction(service,operator,cancelled.id,'cancel',{reason:'取消申请'}),{id:cancelled.id,status:'cancelled'});
      await assert.rejects(()=>settlement.refundAction(service,operator,cancelled.id,'execute',{}),error=>error.code==='refund_state');
      assert.equal(await count('payment_refunds'),1);
    });
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    if(pool)await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }
});
