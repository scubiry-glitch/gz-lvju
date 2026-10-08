'use strict';

// Pin the pre-cashier contract so committing this change does not replace the legacy fixture.
const LEGACY_REF = process.env.PAYMENT_LEGACY_REF || 'f68bdb53f47f6e1e973b26d12e368f07c259f67a';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const mysql=require('mysql2/promise');
const {migrate}=require('../payment/migrate.cjs');
const {createPaymentCore}=require('../payment/core.cjs');
const {createJiazhengAdapter}=require('../payment/jiazheng-adapter.cjs');
const {createJiazhengRouter}=require('../routes/jiazheng.cjs');
const grOrders=require('../../gr_orders.cjs');
const socketPath=process.env.PAYMENT_TEST_SOCKET;

test('mixed-collation legacy migration preserves commerce exclusion and booking snapshots', {skip:!socketPath,timeout:60000},async t=>{
  assert.match(socketPath,/^\/tmp\/[\w-]*(?:cashier|settlement)[\w-]*\/[^/]+\.sock$/);
  const database='cashier_mixed_'+process.pid+'_'+crypto.randomBytes(3).toString('hex'),options={socketPath,user:'root',timezone:'Z'};
  const admin=await mysql.createConnection(options);await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');
  const c=await mysql.createConnection({...options,database});t.after(async()=>{await c.end();await admin.query('DROP DATABASE `'+database+'`');await admin.end();});
  await c.query('CREATE TABLE jz_vendors(id INT PRIMARY KEY,url_link TEXT) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
  await c.query('CREATE TABLE jz_products(id INT PRIMARY KEY,vendor_id INT) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
  await c.query('CREATE TABLE gr_orders(id INT PRIMARY KEY,user_id VARCHAR(64),order_ref VARCHAR(64),sku VARCHAR(64),vendor_id INT) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
  await c.query('CREATE TABLE commerce_orders(id VARCHAR(64) PRIMARY KEY) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
  await c.query("INSERT INTO jz_vendors VALUES(1,'https://example.test/mini'),(2,NULL)");await c.query('INSERT INTO jz_products VALUES(101,1)');
  await c.query("INSERT INTO commerce_orders VALUES('abcdef00-1234-4567-8901-abcdef123456')");
  await c.query("INSERT INTO gr_orders VALUES(1,'fixture','ABCDEF00-1234-4567-8901-ABCDEF123456','101',1),(2,'fixture','EXTERNAL-MIXED-001','101',1),(3,'fixture','WRONG-VENDOR','101',2),(4,'fixture','NOT-PRODUCT','not-numeric',1)");
  // Exercise the immutable legacy snapshot migration against real old evidence
  // under a different log collation as well, without changing its checksum.
  for(const ddl of require('../payment/migrate.cjs').TABLES)await c.query(ddl.replace('DEFAULT CHARSET=utf8mb4','DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci'));
  await c.query('ALTER TABLE payment_gateway_logs CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  await c.query("INSERT INTO payment_orders(id,biz_order_no,app_order_id,amount,payer_ucid,payer_user_type,merchant_no,share_biz_code,cashier_type,pay_status,callback_url,created_at,updated_at) VALUES(1,'BOOK-MIXED-001','MIXED-APP-001',12.34,'fixture-user','1','fixture-merchant','fixture-share','2','unpaid','https://example.test/callback',UTC_TIMESTAMP(),UTC_TIMESTAMP())");
  await c.execute("INSERT INTO payment_gateway_logs(payment_order_id,app_order_id,operation_type,request_no,request_json,started_at) VALUES(1,'MIXED-APP-001','pay_create','MIXED-LOG-001',?,UTC_TIMESTAMP())",[JSON.stringify({appOrderId:'MIXED-APP-001',appCode:'original-app',projectCode:'original-project'})]);
  await migrate(c);await migrate(c);
  const [orders]=await c.query('SELECT id,biz_type,payment_mode FROM gr_orders ORDER BY id');
  assert.deepEqual(orders.map(r=>[r.id,r.biz_type,r.payment_mode]),[[1,null,null],[2,'jiazheng','wechat_mini'],[3,null,null],[4,null,null]]);
  const [[payment]]=await c.query('SELECT app_code,project_code FROM payment_orders WHERE id=1');assert.deepEqual(payment,{app_code:'original-app',project_code:'original-project'});
  const [collations]=await c.query("SELECT TABLE_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND (TABLE_NAME='commerce_orders' AND COLUMN_NAME='id' OR TABLE_NAME='gr_orders' AND COLUMN_NAME='order_ref') ORDER BY TABLE_NAME");
  assert.deepEqual(collations.map(r=>r.COLLATION_NAME),['utf8mb4_general_ci','utf8mb4_0900_ai_ci'],'migration must not convert existing business tables');
});

test('life service legacy request contracts preserve real payments and ownership', {skip:!socketPath,timeout:120000},async t=>{
  assert.match(socketPath,/^\/tmp\/[\w-]*(?:cashier|settlement)[\w-]*\/[^/]+\.sock$/);
  const database='cashier_life_legacy_'+process.pid+'_'+crypto.randomBytes(3).toString('hex');
  const options={socketPath,user:'root',timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true};
  const admin=await mysql.createConnection(options);await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');
  t.after(async()=>{await admin.query('DROP DATABASE `'+database+'`');await admin.end();});
  const createConnection=()=>mysql.createConnection({...options,database});
  const db=async(sql,params=[])=>{const c=await createConnection();try{return(await c.execute(sql,params))[0];}finally{await c.end();}};
  const schema=execFileSync('git',['show',LEGACY_REF + ':server/schema.cjs'],{cwd:__dirname+'/../..',encoding:'utf8'});
  for(const table of ['cities','jz_categories','jz_skus','jz_vendors','jz_products','jz_orders','jz_sku_slots','gr_orders']){
    const start=schema.indexOf('CREATE TABLE IF NOT EXISTS '+table+' (');
    const end=schema.indexOf(') CHARSET=utf8mb4',start);assert.ok(start>=0&&end>=0,table);
    await db(schema.slice(start,end+') CHARSET=utf8mb4'.length).replace(/\\`/g,'`'));
  }
  await db('ALTER TABLE jz_vendors ADD pay_merchant_no VARCHAR(64),ADD hmac_key TEXT,ADD url_link TEXT');
  const c=await createConnection();try{await migrate(c);}finally{await c.end();}
  await db("INSERT INTO cities(id,name,slug) VALUES(1,'测试城市','fixture-city')");
  await db("INSERT INTO jz_categories(id,name) VALUES('cleaning','保洁')");
  await db("INSERT INTO jz_skus(id,category_id,name,slug) VALUES(1,'cleaning','标准保洁','clean'),(2,'cleaning','小程序保洁','external'),(3,'cleaning','咨询','consultation')");
  await db("INSERT INTO jz_vendors(id,type,name,status,city_ids,payment_mode,pay_merchant_no,hmac_key,url_link) VALUES(1,'cleaning','中台商家','active','1','pay_center','fixture-merchant',NULL,NULL),(2,'cleaning','小程序商家','active','1','wechat_mini',NULL,'fixture-signing-key','https://fixture.invalid/link')");
  await db("INSERT INTO jz_products(id,vendor_id,title,price,channel_sku_id,city_id,status) VALUES(101,1,'真实保洁商品',128.09,1,1,'on'),(1,2,'与SKU数字碰撞的另一商家商品',99,2,1,'on'),(201,2,'小程序预约',99,2,1,'on'),(301,1,'免费咨询',0,3,1,'on')");
  await db("INSERT INTO jz_sku_slots(id,product_id,slot_date,start_time,capacity,booked,status) VALUES(1,101,'2099-10-02','12:00',50,0,'open')");
  const provider=new Map(),creates=[],queries=[],externalCalls=[];
  const config={PAY_APP_CODE:'fixture-app',PAY_PROJECT_CODE:'fixture-project',PAY_SHARE_BIZ_CODE:'fixture-share',PAY_NOTIFY_URL:'https://fixture.invalid/notify',PAY_COMPAT_WAIT_MS:'3000'};
  const core=createPaymentCore({createConnection,config,logger:{warn(){}},payCenter:{
    async createC2BOrder(p){creates.push(p);await new Promise(resolve=>setTimeout(resolve,20));provider.set(p.appOrderId,{appOrderId:p.appOrderId,appCode:p.appCode,projectCode:p.projectCode,merchantNo:p.recAndShareInfo.merchantNo,amount:p.amount,orderStatus:'10'});return{errno:0,data:{cashierUrl:'https://fixture.invalid/cashier/'+p.appOrderId}};},
    async queryOrder(p){queries.push(p);assert.ok(provider.has(p.appOrderId));return{errno:0,data:{...provider.get(p.appOrderId)}};},
    async closeOrder(p){const row=provider.get(p.businessOrderNo);if(row&&row.orderStatus!=='30')row.orderStatus='40';return{errno:0,data:{accepted:true}};},
  }});
  const adapter=createJiazhengAdapter({createConnection,paymentCore:core,config});
  const account={id:'fixture-owner',status:'active',principal_type:'user',idp_type:'beike',idp_subject:'fixture-ucid'};
  const router=createJiazhengRouter({queryRows:db,readBody:async req=>req.body||{},requestSession:async req=>req.session,
    mysql2:{createConnection},getDbConfig:()=>({}),getPaymentCore:()=>core,getJiazhengAdapter:()=>adapter,grOrders,
    requireApiKey:async(_req,res)=>{res.status=401;res.body={error:'unauthorized'};return false;},restrictOrdersRead:async()=>{throw Error('customer must not enter management read');},
    hmacAuth:{generateSignature:(_key,body)=>body},outboundJson:async(_method,url,body)=>{externalCalls.push({url,...body});return{json:{code:200,data:'https://fixture.invalid/mini/'+body.order_ref}};},
    jsonReply:(res,body,status=200)=>Object.assign(res,{body,status})});
  const request=async(path,body={},extra={})=>{const res={};const result=await router(path,extra.qs||'',{method:'POST',headers:{},socket:{remoteAddress:'127.0.0.1'},body,session:{role:'user',account},...extra},res);if(result===false)res.unmatched=true;return res;};
  const fields={product_id:101,house:'测试地址',phone:'13800000000',expectTime:'2099-10-02 12:00',desc:'上门前联系',slot_id:1};
  let legacyOrder;

  await t.test('old product create without a key ignores client fee and returns 201 {ok,order}',async()=>{
    const first=await request('/api/juzhu/jiazheng/orders',{...fields,fee:1,account_id:'forged-account'});
    assert.equal(first.status,201,JSON.stringify(first.body));assert.equal(first.body.ok,true);legacyOrder=first.body.order;
    assert.equal(legacyOrder.fee,12809);assert.equal(legacyOrder.amount_minor,12809);assert.equal(legacyOrder.account_id,account.id);
    assert.equal(legacyOrder.pay_status,'unpaid');assert.equal(legacyOrder.payment_config_snapshot,undefined);assert.equal(legacyOrder.request_key,undefined);
    const repeat=await request('/api/juzhu/jiazheng/orders',{...fields,fee:-999});assert.equal(repeat.status,201);assert.equal(repeat.body.order.id,legacyOrder.id);
    assert.equal(Number((await db('SELECT booked FROM jz_sku_slots WHERE id=1'))[0].booked),1);
  });
  await t.test('concurrent identical legacy creates reuse one order; different appointments do not share keys',async()=>{
    const body={...fields,house:'并发预约地址'};
    const results=await Promise.all(Array.from({length:6},()=>request('/api/juzhu/jiazheng/orders',body)));
    assert.ok(results.every(r=>r.status===201),JSON.stringify(results));assert.equal(new Set(results.map(r=>r.body.order.id)).size,1);
    const different=await request('/api/juzhu/jiazheng/orders',{...body,expectTime:'2099-10-03 15:00',slot_id:null});
    assert.equal(different.status,201);assert.notEqual(different.body.order.id,results[0].body.order.id);
    const foreign=await request('/api/juzhu/jiazheng/orders',body,{session:{role:'user',account:{...account,id:'second-owner',idp_subject:'second-ucid'}}});
    assert.equal(foreign.status,201);assert.notEqual(foreign.body.order.id,results[0].body.order.id);
  });
  await t.test('old sku_id remains the exact product-id alias despite different or colliding catalog SKU numbers',async()=>{
    const {product_id,...skuBody}=fields;
    const result=await request('/api/juzhu/jiazheng/orders',{...skuBody,sku_id:101,house:'SKU兼容地址'});
    assert.equal(result.status,201);assert.equal(result.body.order.product_id,101);assert.equal(result.body.order.vendor_id,1);
    await db("INSERT INTO jz_products(id,vendor_id,title,price,channel_sku_id,city_id,status) VALUES(102,2,'同SKU另一商家',88,1,1,'on')");
    const sameProduct=await request('/api/juzhu/jiazheng/orders',{...skuBody,sku_id:101,house:'同渠道多商家仍准确选品'});
    assert.equal(sameProduct.status,201);assert.equal(sameProduct.body.order.product_id,101);
    const colliding=await request('/api/juzhu/jiazheng/orders',{...skuBody,sku_id:1,slot_id:null,house:'不得把商品1解释成渠道1'});
    assert.equal(colliding.status,409);assert.match(colliding.body.error,/未开通本站支付/);
    const priority=await request('/api/juzhu/jiazheng/orders',{...skuBody,product_id:101,sku_id:1,house:'product_id优先'});
    assert.equal(priority.status,201);assert.equal(priority.body.order.product_id,101);
    await db("UPDATE jz_products SET status='off' WHERE id=102");
    const mini=await request('/api/juzhu/jiazheng/orders',{...fields,product_id:201,slot_id:null});assert.equal(mini.status,409);
    const free=await request('/api/juzhu/jiazheng/orders',{...fields,product_id:301,slot_id:null});assert.equal(free.status,409);
  });
  await t.test('real old /jz/orders alias accepts address and scheduled_at with verified product/vendor',async()=>{
    const body={product_id:101,vendor_id:1,address:'旧入口地址',phone:fields.phone,scheduled_at:fields.expectTime,fee:118.09};
    const result=await request('/api/juzhu/jz/orders',body);assert.equal(result.status,201,JSON.stringify(result.body));
    assert.equal(result.body.order.house,body.address);assert.equal(result.body.order.expect_time,body.scheduled_at);assert.equal(result.body.order.fee,128.09);assert.equal(result.body.order.amount_minor,12809);
    assert.equal(result.body.order.address,body.address);assert.equal(result.body.order.scheduled_at,body.scheduled_at);assert.equal(result.body.order.product_title,'真实保洁商品');
    const wrong=await request('/api/juzhu/jz/orders',{...body,vendor_id:2});assert.equal(wrong.status,409);
    const anonymous=await request('/api/juzhu/jz/orders',body,{session:null});assert.equal(anonymous.status,401);
    const direct=await request('/api/juzhu/jiazheng/orders',fields,{session:null});assert.equal(direct.status,401);
  });
  await t.test('owned GET preserves flat fields plus order envelope; phone cannot claim somebody else order',async()=>{
    const owned=await request('/api/juzhu/jiazheng/orders/'+legacyOrder.id,{}, {method:'GET'});
    assert.equal(owned.status,200);assert.equal(owned.body.id,legacyOrder.id);assert.equal(owned.body.order.id,legacyOrder.id);
    assert.equal(owned.body.payment_config_snapshot,undefined);assert.equal(owned.body.order.request_hash,undefined);
    const other=await request('/api/juzhu/jiazheng/orders/'+legacyOrder.id,{}, {method:'GET',qs:'phone='+fields.phone,session:{role:'user',account:{...account,id:'other'}}});assert.equal(other.status,404);
    const anonymous=await request('/api/juzhu/jiazheng/orders/'+legacyOrder.id,{}, {method:'GET',session:null});assert.equal(anonymous.status,401);
    const list=await request('/api/juzhu/jiazheng/orders',{}, {method:'GET',qs:'phone='+fields.phone});assert.equal(list.status,200);assert.ok(list.body.items.every(o=>o.account_id===account.id));
  });
  let paymentId;
  await t.test('old pay_method-only request returns HTTP 200 {ok,order,cashier_url} without faking paid',async()=>{
    const before=creates.length,route='/api/juzhu/jiazheng/orders/'+legacyOrder.id+'/pay';
    const results=await Promise.all(Array.from({length:4},()=>request(route,{pay_method:'任意前端支付成功文案'})));
    assert.ok(results.every(r=>r.status===200),JSON.stringify(results));assert.equal(creates.length-before,1);
    assert.ok(results.every(r=>r.body.ok&&r.body.order.pay_status==='unpaid'&&r.body.pay_status==='paying'&&r.body.cashier_url));
    assert.equal(new Set(results.map(r=>r.body.app_order_id)).size,1);paymentId=results[0].body.app_order_id;
    assert.equal((await db('SELECT pay_method FROM jz_orders WHERE id=?',[legacyOrder.id]))[0].pay_method,null);
    const other=await request(route,{pay_method:'paid'},{session:{role:'user',account:{...account,id:'other'}}});assert.equal(other.status,404);
    const anon=await request(route,{},{session:null});assert.equal(anon.status,401);
  });
  await t.test('old repeated pay only returns paid after an authoritative query and projection',async()=>{
    provider.get(paymentId).orderStatus='30';
    const result=await request('/api/juzhu/jiazheng/orders/'+legacyOrder.id+'/pay',{pay_method:'微信'});
    assert.equal(result.status,200);assert.equal(result.body.order.pay_status,'paid');assert.equal(result.body.order_pay_status,'paid');
    assert.equal(result.body.order.pay_method,'pay_center');assert.equal(creates.filter(p=>p.appOrderId===paymentId).length,1);
    const status=await request('/api/juzhu/jiazheng/orders/'+legacyOrder.id+'/payment',{}, {method:'GET'});assert.equal(status.status,200);assert.equal(status.body.order_pay_status,'paid');
    const oldCount=Number((await db('SELECT booked FROM jz_sku_slots WHERE id=1'))[0].booked);
    await request('/api/juzhu/jiazheng/orders/'+legacyOrder.id+'/pay',{pay_method:'微信'});assert.equal(Number((await db('SELECT booked FROM jz_sku_slots WHERE id=1'))[0].booked),oldCount);
  });
  await t.test('paid cancellation overrides ledger paid in GET payment and old no-key pay until refund completes',async()=>{
    const route='/api/juzhu/jiazheng/orders/'+legacyOrder.id;
    const cancelled=await request(route+'/cancel',{});
    assert.equal(cancelled.status,200,JSON.stringify(cancelled.body));assert.ok(cancelled.body.refund_id);
    assert.equal(cancelled.body.order.status,'cancelled');assert.equal(cancelled.body.order.refund_status,'refunding');
    const {createCashier}=require('../../screens/_cashier.js');const cashier=createCashier({});let success=0;
    const check=async expected=>{
      const before=creates.length;
      const responses=[await request(route+'/payment',{}, {method:'GET'}),await request(route+'/pay',{pay_method:'贝壳支付'})];
      for(const response of responses){
        assert.equal(response.status,200,JSON.stringify(response.body));const payment=response.body;
        assert.equal(payment.order.id,legacyOrder.id);assert.equal(payment.order.account_id,account.id);
        assert.equal(payment.order.payment_config_snapshot,undefined);assert.equal(payment.order.request_hash,undefined);
        assert.equal(payment.order.status,'cancelled');assert.equal(payment.order.refund_status,expected);
        assert.equal(payment.pay_status,'paid');assert.equal(payment.order_pay_status,expected);
        assert.equal(payment.cashier_url,null);assert.equal(payment.next_action,expected==='refunding'?'poll':'none');
        assert.equal(cashier.orderStatus(payment,payment.order),expected);
        assert.equal(cashier.open(payment,{onResult:()=>success++}),false);
      }
      assert.equal(creates.length,before);assert.equal(success,0);
    };
    await check('refunding');
    const unauthorized=await request(route+'/payment',{}, {method:'GET',session:{role:'user',account:{...account,id:'other'}}});assert.equal(unauthorized.status,404);
    await core.reconcileRefund(cancelled.body.refund_id,{errno:0,data:{orderStatus:'30',appOrderId:cancelled.body.app_order_id,merchantNo:'fixture-merchant',refundAmount:'128.09'}});
    await core.consumeEvents('jiazheng',adapter.handleEvent,25,{orderId:legacyOrder.id});
    await check('refunded');
  });
  await t.test('explicit modern keys still reject price or body changes and retain asynchronous response shape',async()=>{
    const wrong=await request('/api/juzhu/jiazheng/orders',{...fields,price_minor:1},{headers:{'idempotency-key':'modern-price-check'}});assert.equal(wrong.status,409);
    const body={...fields,house:'显式幂等测试'};const first=await request('/api/juzhu/jiazheng/orders',body,{headers:{'idempotency-key':'modern-create-one'}});assert.equal(first.status,201);
    const replay=await request('/api/juzhu/jiazheng/orders',body,{headers:{'idempotency-key':'modern-create-one'}});assert.equal(replay.status,200);
    const conflict=await request('/api/juzhu/jiazheng/orders',{...body,house:'另一个地址'},{headers:{'idempotency-key':'modern-create-one'}});assert.equal(conflict.status,409);
    const pay=await request('/api/juzhu/jiazheng/orders/'+first.body.order.id+'/pay',{cashier_type:'2'},{headers:{'idempotency-key':'modern-payment-one'}});
    assert.equal(pay.status,202);assert.equal(pay.body.pay_status,'creating');assert.equal(pay.body.order.pay_status,'unpaid');
  });
  await t.test('legacy unowned or free orders cannot acquire ownership or become paid through the old endpoint',async()=>{
    await db("INSERT INTO jz_orders(id,category_id,type,house,phone,expect_time,fee,pay_status,status,source,created_at,updated_at) VALUES('WO-legacy-unowned','cleaning','保洁','旧地址','13800000000','2099-10-02',100,'unpaid','pending','c_web','2020-01-01','2020-01-01'),('WO-legacy-free','repair','报修','旧地址','13800000000','2099-10-02',0,'not_required','pending','旅居客 App','2020-01-01','2020-01-01')");
    for(const id of ['WO-legacy-unowned','WO-legacy-free']){
      const pay=await request('/api/juzhu/jiazheng/orders/'+id+'/pay',{phone:fields.phone,pay_method:'paid'});assert.equal(pay.status,404);
      const get=await request('/api/juzhu/jiazheng/orders/'+id,{}, {method:'GET'});assert.equal(get.status,404);
    }
    assert.equal((await request('/api/juzhu/jiazheng/pay',{order_id:legacyOrder.id})).unmatched,true);
    assert.equal((await request('/api/juzhu/jiazheng/book',{product_id:201})).unmatched,true);
  });
  await t.test('old identified anonymous mini-program request needs no key and retains its original channel',async()=>{
    const body={product_id:201,user_id:'legacy-client-user'};
    const first=await request('/api/juzhu/jiazheng/wechat-link',body,{session:null});assert.equal(first.status,200,JSON.stringify(first.body));assert.ok(first.body.url_link);
    const second=await request('/api/juzhu/jiazheng/wechat-link',{...body,product_id:'201'},{session:null});assert.equal(second.status,200);assert.equal(second.body.order_ref,first.body.order_ref);
    await db("UPDATE jz_vendors SET payment_mode='pay_center',url_link=NULL WHERE id=2");
    const retry=await request('/api/juzhu/jiazheng/wechat-link',body,{session:null});assert.equal(retry.status,200);assert.equal(retry.body.order_ref,first.body.order_ref);
    assert.equal(externalCalls.at(-1).url,'https://fixture.invalid/link');
    const newUser=await request('/api/juzhu/jiazheng/wechat-link',{...body,user_id:'another-client'},{session:null});assert.equal(newUser.status,409);
    await db("UPDATE gr_orders SET status='paid' WHERE order_ref=?",[first.body.order_ref]);
    const nextPurchase=await request('/api/juzhu/jiazheng/wechat-link',body,{session:null});assert.equal(nextPurchase.status,409);
    await db("UPDATE jz_vendors SET payment_mode='wechat_mini',url_link='https://fixture.invalid/link' WHERE id=2");
  });
  await t.test('HEAD product-only anonymous links stay independent and never create centre payments',async()=>{
    const before=Number((await db('SELECT COUNT(*) n FROM payment_orders'))[0].n);
    const first=await request('/api/juzhu/jiazheng/wechat-link',{product_id:201},{session:null});
    const second=await request('/api/juzhu/jiazheng/wechat-link',{product_id:201},{session:null});
    assert.equal(first.status,200);assert.equal(second.status,200);assert.notEqual(first.body.order_ref,second.body.order_ref);
    const rows=await db('SELECT user_id,payment_mode FROM gr_orders WHERE order_ref IN (?,?)',[first.body.order_ref,second.body.order_ref]);assert.ok(rows.every(r=>r.user_id===null&&r.payment_mode==='wechat_mini'));
    assert.equal(Number((await db('SELECT COUNT(*) n FROM payment_orders'))[0].n),before);
    const forged=await request('/api/juzhu/jiazheng/wechat-link',{product_id:201,user_id:'commerce-account-'+account.id},{session:null});assert.equal(forged.status,401);
    const authenticated=await request('/api/juzhu/jiazheng/wechat-link',{product_id:201,user_id:'untrusted-user'});assert.equal(authenticated.status,200);
    assert.equal((await db('SELECT user_id FROM gr_orders WHERE order_ref=?',[authenticated.body.order_ref]))[0].user_id,'commerce-account-'+account.id);
  });
  await t.test('identified mini-program retry generations advance through same-second terminal orders',async()=>{
    const body={product_id:201,user_id:'same-second-mini-client'},refs=[];
    for(let i=0;i<3;i++){
      const created=await request('/api/juzhu/jiazheng/wechat-link',body,{session:null});assert.equal(created.status,200);
      assert.ok(!refs.includes(created.body.order_ref));refs.push(created.body.order_ref);
      const repeat=await request('/api/juzhu/jiazheng/wechat-link',body,{session:null});assert.equal(repeat.body.order_ref,created.body.order_ref);
      await db("UPDATE gr_orders SET status='paid',created_at='2026-10-02 01:00:00',updated_at='2026-10-02 01:00:00' WHERE order_ref=?",[created.body.order_ref]);
    }
  });
  await t.test('a completed cancellation permits one new legacy booking generation and retries still converge',async()=>{
    const body={...fields,house:'取消后重新预约'};
    const first=await request('/api/juzhu/jiazheng/orders',body);assert.equal(first.status,201);
    const cancelled=await request('/api/juzhu/jiazheng/orders/'+first.body.order.id+'/cancel',{});assert.ok([200,202].includes(cancelled.status));
    await core.consumeEvents('jiazheng',adapter.handleEvent,25,{orderId:first.body.order.id});
    assert.equal((await db('SELECT status FROM jz_orders WHERE id=?',[first.body.order.id]))[0].status,'cancelled');
    const status=await request('/api/juzhu/jiazheng/orders/'+first.body.order.id+'/payment',{}, {method:'GET'});
    assert.equal(status.status,200);assert.equal(status.body.order.status,'cancelled');assert.equal(status.body.order_pay_status,'closed');
    assert.equal(status.body.cashier_url,null);assert.equal(status.body.next_action,'closed');
    const second=await request('/api/juzhu/jiazheng/orders',body),retry=await request('/api/juzhu/jiazheng/orders',body);
    assert.equal(second.status,201);assert.notEqual(second.body.order.id,first.body.order.id);assert.equal(retry.body.order.id,second.body.order.id);
  });
  await t.test('same-second reverse random IDs cannot strand a third legacy booking on a cancelled second order',async t=>{
    const body={...fields,house:'同秒连续取消重新预约'},ids=[],originalRandomBytes=crypto.randomBytes,sequence=[255,0,17];
    t.mock.method(crypto,'randomBytes',(size,...args)=>size===14?Buffer.alloc(size,sequence.shift()):originalRandomBytes(size,...args));
    for(let i=0;i<2;i++){
      const created=await request('/api/juzhu/jiazheng/orders',body);assert.equal(created.status,201,JSON.stringify(created.body));ids.push(created.body.order.id);
      await db("UPDATE jz_orders SET created_at='2026-10-02 01:00:00' WHERE id=?",[created.body.order.id]);
      const cancelled=await request('/api/juzhu/jiazheng/orders/'+created.body.order.id+'/cancel',{});assert.ok([200,202].includes(cancelled.status));
      await core.consumeEvents('jiazheng',adapter.handleEvent,25,{orderId:created.body.order.id});
      assert.equal((await db('SELECT status FROM jz_orders WHERE id=?',[created.body.order.id]))[0].status,'cancelled');
    }
    assert.ok(ids[0]>ids[1]);
    const third=await request('/api/juzhu/jiazheng/orders',body),repeat=await request('/api/juzhu/jiazheng/orders',body);
    assert.equal(third.status,201);assert.equal(third.body.order.status,'pending');assert.ok(!ids.includes(third.body.order.id));
    assert.equal(repeat.body.order.id,third.body.order.id);
    // A terminal order gaining a rating is not another completed purchase.
    await db("UPDATE jz_orders SET status='done' WHERE id=?",[ids[0]]);
    assert.equal((await request('/api/juzhu/jiazheng/orders',body)).body.order.id,third.body.order.id);
    await db("UPDATE jz_orders SET status='rated' WHERE id=?",[ids[0]]);
    assert.equal((await request('/api/juzhu/jiazheng/orders',body)).body.order.id,third.body.order.id);
  });
});
