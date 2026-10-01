'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { Service } = require('../../commerce/service.cjs');
const { createPaymentCore } = require('../../server/payment/core.cjs');
const { createPaymentAdapter, compact, uuid } = require('../../commerce/payment-adapter.cjs');
const settlement = require('../../commerce/settlement.cjs');

test('commerce identifiers are lossless and never truncate malformed orders', () => {
  const id = 'A1234567-1234-4ABC-8DEF-123456789ABC';
  assert.equal(uuid(compact(id)), id.toLowerCase());
  assert.throws(() => compact('a'.repeat(33)));
  assert.throws(() => compact('prefix-' + id));
});

// Explicit opt-in only. This test never loads commerce/db.cjs or host credentials.
test('real commerce purchase, entitlement outbox, original partial refunds and closing races', {skip:!process.env.PAYMENT_TEST_SOCKET}, async t => {
  const socketPath = process.env.PAYMENT_TEST_SOCKET;
  const database = 'cashier_commerce_test_' + crypto.randomBytes(5).toString('hex');
  const admin = await mysql.createConnection({socketPath,user:'root'});
  let pool;
  try {
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
    const db = {socketPath,user:'root',database,timezone:'Z',dateStrings:true};
    pool = mysql.createPool({...db,connectionLimit:8});
    for (const sql of [
      'CREATE TABLE accounts(id BIGINT PRIMARY KEY,display_name VARCHAR(100),principal_type VARCHAR(20),status VARCHAR(20))',
      'CREATE TABLE cities(id BIGINT PRIMARY KEY,name VARCHAR(100),slug VARCHAR(100))',
      'CREATE TABLE gr_orders(order_ref VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),sku VARCHAR(100),city VARCHAR(100),status VARCHAR(32),fee BIGINT,created_at VARCHAR(40),updated_at VARCHAR(40),completed_at VARCHAR(40))',
      'CREATE TABLE jz_categories(id VARCHAR(50) PRIMARY KEY)',
      'CREATE TABLE jz_orders(id VARCHAR(64) PRIMARY KEY,sku_id BIGINT NULL,category_id VARCHAR(50),type VARCHAR(50),house VARCHAR(255),phone VARCHAR(50),expect_time VARCHAR(100),`desc` TEXT,fee BIGINT,pay_status VARCHAR(30),status VARCHAR(30),source VARCHAR(100),created_at VARCHAR(40),updated_at VARCHAR(40),log_json TEXT)',
      "INSERT INTO accounts VALUES(1,'isolated user','user','active'),(2,'other user','user','active')",
      "INSERT INTO cities VALUES(1,'isolated city','isolated')",
      "INSERT INTO jz_categories VALUES('community')",
    ]) await pool.query(sql);
    await require('../../commerce/migrate.cjs').migrate(pool);
    const conn = await pool.getConnection();
    try { await require('../../server/payment/migrate.cjs').migrate(conn); } finally { conn.release(); }
    const config = {
      COMMERCE_PAY_ENABLED:'1', COMMERCE_COLLECTION_MODE:'platform', COMMERCE_PAY_MERCHANT_NO:'isolated-platform',
      COMMERCE_PAY_APP_CODE:'isolated-app', COMMERCE_PAY_PROJECT_CODE:'isolated-project', COMMERCE_PAY_SHARE_BIZ_CODE:'isolated-share',
      COMMERCE_PAY_NOTIFY_URL:'https://invalid.example.test/notify', MYSQL_DB:database,
    };
    const logger = {warn(){}}, core = createPaymentCore({createConnection:()=>mysql.createConnection(db),config,logger});
    const auth = {scopeOf:()=>({level:'all'}),permissionsOf:()=>new Set(['*'])};
    const service = new Service(pool,auth);
    const payments = createPaymentAdapter({service,core,config,logger}); service.payments = payments;
    const owner = {account:{id:1,idp_type:'beike',idp_subject:'isolated-ucid'},roles:[{permissions:['*']}]};
    const other = {account:{id:2,idp_type:'beike',idp_subject:'other-ucid'},roles:[]};
    const first = async (sql,args=[]) => (await pool.execute(sql,args))[0][0];
    async function published(kind,payload) {
      const [r] = await pool.execute(`INSERT INTO commerce_${kind}(name,city_id,merchant_id,store_id,version,published_version,status,payload,created_by) VALUES(?,?,?,?,1,1,'published',?,1)`,[payload.name,1,payload.merchant_id||null,payload.store_id||null,JSON.stringify(payload)]);
      await pool.execute('INSERT INTO commerce_versions(kind,entity_id,version,snapshot,reviewed_by) VALUES(?,?,1,?,2)',[kind,r.insertId,JSON.stringify(payload)]);
      return {id:r.insertId,version:1,payload};
    }
    const merchant = await published('merchants',{name:'approved merchant',city_id:1,vendor_id:1});
    const store = await published('stores',{name:'approved store',merchant_id:merchant.id,city_id:1});
    const rule = await published('rules',{name:'approved rule',merchant_id:merchant.id,beike_bps:2000,channel_bps:5000,floor_bps:1000});
    const sku = await published('skus',{name:'paid SKU',merchant_id:merchant.id,store_id:store.id,city_id:1,retail_minor:10000,supply_minor:7000,valid_days:30,rule_id:rule.id,rule_version:1,rule:rule.payload});
    await pool.execute('INSERT INTO commerce_inventory(sku_id,total) VALUES(?,100)',[sku.id]);
    const item = {sku_id:sku.id,sku_version:1,quantity:2,allocation_minor:10000,sku:sku.payload,rule_id:rule.id,rule_version:1,rule:rule.payload};
    const pkg = await published('packages',{name:'paid package',city_id:1,price_minor:20000,items:[item]});
    const plan = await published('plans',{name:'paid membership',city_id:1,price_minor:20000,valid_days:365,package:pkg.payload});
    const buy = (kind,product,key) => payments.purchase(owner,{kind,product_id:product.id,version:1},key);
    const intent = (id,key) => payments.pay(owner,id,{cashier_type:'2'},key,'127.0.0.1');
    async function paid(paymentId) {
      const payment = await first('SELECT * FROM payment_orders WHERE id=?',[paymentId]);
      await core.reconcilePayment(paymentId,{data:{orderStatus:'30',appOrderId:payment.app_order_id,merchantNo:payment.merchant_no,amount:payment.amount}});
    }
    async function refundPaid(refundId) {
      const refund = await first('SELECT * FROM payment_refunds WHERE id=?',[refundId]);
      await core.reconcileRefund(refundId,{data:{orderStatus:'30',appOrderId:refund.app_order_id,merchantNo:refund.merchant_no,refundAmount:refund.refund_amount}});
    }
    let single, bundle;
    await t.test('configuration, identity, version and demo admission precede real purchase',async()=>{
      const disabled = createPaymentAdapter({service,core,config:{...config,COMMERCE_COLLECTION_MODE:''}});
      await assert.rejects(()=>disabled.purchase(owner,{kind:'skus',product_id:sku.id,version:1},'disabled-01'),/暂未开放/);
      assert.equal(await createPaymentAdapter({service,core,config:{...config,PAY_NEW_INTENTS_ENABLED:'0'}}).capability(),false);
      await assert.rejects(()=>payments.purchase({account:{id:1}}, {kind:'skus',product_id:sku.id,version:1},'identity-01'),/贝壳/);
      await assert.rejects(()=>payments.purchase(owner,{kind:'skus',product_id:sku.id,version:2},'version-01'),/已更新/);
      const demo=await published('skus',{...sku.payload,is_demo:true,initialization:{mode:'demo'}});
      await assert.rejects(()=>buy('skus',demo,'no-demo-money'),/演示/);
      const demoFlag=await published('skus',{...sku.payload,is_demo:true});
      await assert.rejects(()=>buy('skus',demoFlag,'no-demo-flag-money'),/演示/);
      assert.equal(Number((await first('SELECT COUNT(*) n FROM payment_order_guards')).n),0);
      const differentDb=createPaymentAdapter({service,core,config:{...config,COMMERCE_DB_NAME:'other_database'}});
      assert.equal(await differentDb.capability(),false);
    });
    await t.test('concurrent request replay registers one order, stock hold and payment attempt',async()=>{
      const results=await Promise.all(Array.from({length:4},()=>buy('skus',sku,'purchase-single-01')));
      single=results[0];assert(results.every(r=>r.id===single.id));
      const payments0=await Promise.all(Array.from({length:4},(_,i)=>intent(single.id,'payment-single-'+i)));
      assert(payments0.every(p=>p.payment_id===payments0[0].payment_id));
      assert.equal(Number((await first('SELECT reserved FROM commerce_inventory WHERE sku_id=?',[sku.id])).reserved),1);
      assert.equal((await first('SELECT status,payment_mode FROM gr_orders WHERE order_ref=?',[single.id])).payment_mode,'pay_center');
      await assert.rejects(()=>payments.status(other,single.id),/无权/);
      await paid(payments0[0].payment_id);await paid(payments0[0].payment_id);
    });
    await t.test('money is recorded despite grant failure; retry issues exactly once',async()=>{
      let invariant=(await settlement.verifyInvariants(pool)).checks.find(c=>c.name.startsWith('I2b '));
      assert.equal(invariant.passed,false);assert.equal(invariant.detail[0].state,'pending_receipt_posting');assert.equal(invariant.detail[0].pending_receipt_minor,10000);
      const grant=service.fulfillPaidOrder;service.fulfillPaidOrder=async()=>{throw Error('injected grant failure');};
      await payments.consume();service.fulfillPaidOrder=grant;
      const order=await first('SELECT * FROM commerce_orders WHERE id=?',[single.id]);assert.equal(order.status,'paid_pending_fulfillment');
      assert.equal((await first('SELECT pay_status FROM gr_orders WHERE order_ref=?',[single.id])).pay_status,'paid');
      invariant=(await settlement.verifyInvariants(pool)).checks.find(c=>c.name.startsWith('I2b '));
      assert.equal(invariant.passed,true);assert.equal(invariant.detail[0].payment_pending_liability,10000);assert.equal(invariant.detail[0].unredeemed_liability,0);
      assert.equal(Number((await first("SELECT COUNT(*) n FROM commerce_ledger_entries WHERE source_type='payment_received'")).n),2);
      assert.equal(Number((await first('SELECT COUNT(*) n FROM commerce_coupons WHERE order_id=?',[single.id])).n),0);
      await pool.query("UPDATE payment_events SET next_run_at=UTC_TIMESTAMP() WHERE status='failed'");
      await Promise.all([payments.consume(),payments.consume()]);
      assert.equal(Number((await first('SELECT COUNT(*) n FROM commerce_coupons WHERE order_id=?',[single.id])).n),1);
      assert.equal((await payments.status(owner,single.id)).fulfillment_status,'fulfilled');
      assert.equal((await first('SELECT status FROM gr_orders WHERE order_ref=?',[single.id])).status,'completed');
      invariant=(await settlement.verifyInvariants(pool)).checks.find(c=>c.name.startsWith('I2b '));
      assert.equal(invariant.passed,true);assert.equal(invariant.detail[0].payment_pending_liability,0);assert.equal(invariant.detail[0].unredeemed_liability,10000);
    });
    await t.test('package partial refunds reserve the original paid amount and exclude sandbox receipts',async()=>{
      bundle=await buy('packages',pkg,'purchase-package-01');const pay=await intent(bundle.id,'pay-package-01');await paid(pay.payment_id);await payments.consume();
      const [coupons]=await pool.execute('SELECT id FROM commerce_coupons WHERE order_id=?',[bundle.id]);
      const refunds=[];
      for(let i=0;i<coupons.length;i++){
        const entry=await service.openCase(owner,{coupon_id:coupons[i].id,kind:'refund',reason:'未使用权益退款验收'},'case-package-'+i);
        await service.resolveCase(owner,'commerce.admin.write',entry.id,{action:'accept',resolution:'同意原路退回未使用权益'});
        const r=await settlement.createRefundOrder(service,owner,{case_id:entry.id},'refund-package-'+i);refunds.push(r);
      }
      const queued=await Promise.all(refunds.map(r=>payments.executeRefund(r.id)));
      await assert.rejects(()=>core.requestRefund({bizType:'commerce',orderId:bundle.id,amountMinor:1,requestKey:'over-refund-package',reason:'test'}),/超过实付/);
      const row=await first('SELECT request_no FROM commerce_refund_orders WHERE id=?',[refunds[0].id]);
      await assert.rejects(()=>settlement.ingestReceipt(service,owner,{request_no:row.request_no,outcome:'paid'}),/沙箱/);
      await refundPaid(queued[0].payment_refund_id);
      const beforeRefundPosting=(await settlement.verifyInvariants(pool)).checks.find(c=>c.name.startsWith('I2b '));
      assert.equal(beforeRefundPosting.passed,false);assert.equal(beforeRefundPosting.detail.find(r=>r.order===bundle.id).state,'pending_refund_posting');
      await payments.consume();
      assert.equal((await first('SELECT payment_status FROM commerce_orders WHERE id=?',[bundle.id])).payment_status,'partially_refunded');
      await refundPaid(queued[1].payment_refund_id);await payments.consume();await payments.consume();
      const order=await first('SELECT * FROM commerce_orders WHERE id=?',[bundle.id]);assert.equal(order.payment_status,'refunded');assert.equal(Number(order.refunded_minor),20000);
    });
    await t.test('expired unresolved payment holds stock; late success refunds without issuing coupons',async()=>{
      const order=await buy('skus',sku,'late-order-01');const payment=await intent(order.id,'late-payment-01');
      await pool.execute("UPDATE payment_orders SET pay_status='create_unknown' WHERE id=?",[payment.payment_id]);
      await pool.execute('UPDATE commerce_orders SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 SECOND WHERE id=?',[order.id]);
      await pool.execute('UPDATE payment_order_guards SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 SECOND WHERE biz_type=? AND biz_order_no=?',['commerce',compact(order.id)]);
      const reserved=Number((await first('SELECT reserved FROM commerce_inventory WHERE sku_id=?',[sku.id])).reserved);
      await service.expire();assert.equal(Number((await first('SELECT reserved FROM commerce_inventory WHERE sku_id=?',[sku.id])).reserved),reserved);
      await paid(payment.payment_id);await payments.consume();
      assert.equal(Number((await first('SELECT COUNT(*) n FROM commerce_coupons WHERE order_id=?',[order.id])).n),0);
      const r=await first('SELECT id FROM payment_refunds WHERE payment_order_id=?',[payment.payment_id]);assert(r);
      await refundPaid(r.id);await payments.consume();
      assert.equal((await first('SELECT status FROM commerce_orders WHERE id=?',[order.id])).status,'refunded');
      assert.equal(Number((await first('SELECT reserved FROM commerce_inventory WHERE sku_id=?',[sku.id])).reserved),reserved-1);
    });
    await t.test('refund before final close keeps stock reserved until closure; multiple late payments refund separately',async()=>{
      const order=await buy('skus',sku,'refund-before-close'),firstPay=await intent(order.id,'refund-before-close-a');
      await core.reconcilePayment(firstPay.payment_id,{data:{orderStatus:'40'}});
      const secondPay=await intent(order.id,'refund-before-close-b');assert.notEqual(firstPay.payment_id,secondPay.payment_id);
      await payments.close(owner,order.id);await paid(firstPay.payment_id);await payments.consume();
      const firstRefund=await first('SELECT id FROM payment_refunds WHERE payment_order_id=?',[firstPay.payment_id]);
      await refundPaid(firstRefund.id);await payments.consume();
      let row=await first('SELECT status,stock_status,refunded_minor FROM commerce_orders WHERE id=?',[order.id]);
      assert.equal(row.status,'refunded');assert.equal(row.stock_status,'reserved');
      await core.reconcilePayment(secondPay.payment_id,{data:{orderStatus:'40'}});await payments.consume();
      row=await first('SELECT status,stock_status FROM commerce_orders WHERE id=?',[order.id]);
      assert.equal(row.stock_status,'released');assert.equal(row.status,'refunded');
      await paid(secondPay.payment_id);await payments.consume();
      const secondRefund=await first('SELECT id FROM payment_refunds WHERE payment_order_id=?',[secondPay.payment_id]);
      await refundPaid(secondRefund.id);await payments.consume();
      assert.equal(Number((await first('SELECT refunded_minor FROM commerce_orders WHERE id=?',[order.id])).refunded_minor),10000);
      assert.equal(Number((await first("SELECT COUNT(*) n FROM commerce_ledger_entries WHERE source_type='payment_refund' AND source_id IN (?,?)",[String(firstRefund.id),String(secondRefund.id)])).n),4);
      assert.equal(Number((await first('SELECT COUNT(*) n FROM commerce_coupons WHERE order_id=?',[order.id])).n),0);
      const funding=(await settlement.verifyInvariants(pool)).checks.find(c=>c.name.startsWith('I2b '));
      const result=funding.detail.find(r=>r.order===order.id);assert.equal(funding.passed,true);assert.equal(result.provider_refund_out,20000);assert.equal(result.payment_pending_liability,0);
    });
    await t.test('memberships retain independent coupons and extend an existing period',async()=>{
      let expires;
      for(let i=0;i<2;i++){
        const order=await buy('plans',plan,'member-order-'+i);const payment=await intent(order.id,'member-payment-'+i);await paid(payment.payment_id);await payments.consume();
        const member=await first('SELECT expires_at FROM commerce_memberships WHERE order_id=?',[order.id]);assert(member);
        if(expires)assert(new Date(member.expires_at)>new Date(expires));expires=member.expires_at;
        assert.equal(Number((await first('SELECT COUNT(*) n FROM commerce_coupons WHERE order_id=?',[order.id])).n),2);
      }
    });
    await t.test('unused coupon expiry queues one original partial refund, never a sandbox success',async()=>{
      await pool.execute('UPDATE commerce_coupons SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 SECOND WHERE order_id=?',[single.id]);
      await service.expireCoupons();await service.expireCoupons();
      await payments.queueExpiryRefunds();await payments.queueExpiryRefunds();
      const [refunds]=await pool.execute('SELECT * FROM commerce_refund_orders WHERE order_id=?',[single.id]);
      assert.equal(refunds.length,1);assert.equal(refunds[0].payment_mode,'pay_center');assert.equal(refunds[0].status,'submitted');assert(refunds[0].payment_refund_id);
      assert.equal(Number((await first('SELECT COUNT(*) n FROM commerce_provider_requests WHERE request_no=?',[refunds[0].request_no])).n),0);
      await refundPaid(refunds[0].payment_refund_id);await payments.consume();
      assert.equal((await first('SELECT status FROM commerce_coupons WHERE order_id=?',[single.id])).status,'refunded');
      const invariants=await settlement.verifyInvariants(pool);assert.equal(invariants.passed,true,JSON.stringify(invariants.checks.filter(c=>!c.passed)));
    });
    await t.test('HTTP purchase exposes only server prices, owned payment routes and real capability',async()=>{
      const users={owner:{...owner,account:{...owner.account,status:'active',principal_type:'user'}},other:{...other,account:{...other.account,status:'active',principal_type:'user'}}};
      const httpAuth={...auth,bearerToken:req=>String(req.headers.authorization||'').replace(/^Bearer /,''),verifySessionToken:async token=>users[token],principalOf:async req=>req.headers.cookie==='lianjia_token=isolated-verified-cookie'?{type:'account',via:'lianjia_token',...users.owner}:null,hasPermission:()=>false};
      const server=require('../../commerce/app.cjs').createServer({pool,auth:httpAuth,paymentCore:core,paymentConfig:config,staticFiles:true});
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const origin='http://127.0.0.1:'+server.address().port;
      const request=async(route,method='GET',body,token='owner')=>{const response=await fetch(origin+'/api/commerce/v1'+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'http-'+crypto.randomUUID()},body:body?JSON.stringify(body):undefined});return {status:response.status,...await response.json()};};
      try {
        const meta=await request('/meta');assert.equal(meta.data.payment_enabled,true);
        const cookieMe=await fetch(origin+'/api/commerce/v1/me',{headers:{Cookie:'lianjia_token=isolated-verified-cookie'}});
        assert.equal(cookieMe.status,200);assert.equal((await cookieMe.json()).data.account.payment_identity_ready,true);
        const arbitraryHeader=await fetch(origin+'/api/commerce/v1/me',{headers:{'X-Lianjia-Token':'unverified-client-input'}});assert.equal(arbitraryHeader.status,401);
        const catalog=await request('/catalog');assert.equal(catalog.data.find(p=>p.kind==='skus'&&p.id===sku.id).purchase_enabled,true);
        const created=await request('/orders','POST',{kind:'skus',product_id:sku.id,version:1,amount_minor:1});assert.equal(created.status,201);assert.equal(created.data.amount_minor,10000);
        const id=created.data.id;
        assert.equal((await request('/orders/'+id+'/payment','GET',null,'other')).status,404);
        assert.equal((await request('/orders/'+id+'/pay','POST',{cashier_type:'2'},'')).status,401);
        assert.equal((await request('/orders/'+id+'/pay','POST',{cashier_type:'2'})).status,202);
        assert.equal((await request('/orders/'+id+'/test-pay','POST',{})).status,404);
        assert.equal((await fetch(origin+'/screens/_cashier.js')).status,200);
        if(process.env.PAYMENT_TEST_BROWSER==='1'){
          const {chromium}=require(process.env.COMMERCE_PLAYWRIGHT_MODULE||'/tmp/e2e/node_modules/playwright-core');
          const browser=await chromium.launch({executablePath:process.env.COMMERCE_CHROME||'/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
          const closed=new Set();
          const fakePayCenter={
            createC2BOrder:async input=>({data:{appOrderId:input.appOrderId,cashierUrl:'https://invalid.example.test/cashier',orderStatus:'20'}}),
            queryOrder:async input=>{const p=await first('SELECT * FROM payment_orders WHERE app_order_id=?',[input.appOrderId]);return {data:{appOrderId:p.app_order_id,merchantNo:p.merchant_no,amount:p.amount,orderStatus:p.pay_status==='paid'?'30':p.pay_status==='closed'||closed.has(p.app_order_id)?'40':'20',cashierUrl:'https://invalid.example.test/cashier'}};},
            closeOrder:async input=>{closed.add(input.businessOrderNo);return {data:{}};},
            refundOrder:async()=>({data:{}}),
            queryRefundOrder:async input=>{const r=await first('SELECT * FROM payment_refunds WHERE app_order_id=?',[input.businessOrderNo]);return {data:{appOrderId:r.app_order_id,merchantNo:r.merchant_no,refundAmount:r.refund_amount,orderStatus:r.refund_status==='refunded'?'30':'20'}};},
          };
          const worker=createPaymentCore({createConnection:()=>mysql.createConnection(db),config,payCenter:fakePayCenter,logger});
          let working=null;const tick=setInterval(()=>{if(!working)working=worker.runJobs(100).finally(()=>{working=null;});},100);
          try {
            const context=await browser.newContext({viewport:{width:390,height:844}});
            // Simulate only a Beike ticket initially: the real login helper must
            // exchange it through the main site's endpoint before commerce pays.
            await context.addInitScript(()=>{window.$ljBridge={getAccessToken:()=> 'isolated-beike-ticket',ready:fn=>fn({}, {isApp:false})};});
            const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
            await context.route('https://invalid.example.test/**',r=>r.fulfill({contentType:'text/html',body:'<h1>Isolated cashier</h1>'}));
            let exchanges=0;
            await context.route('**/api/juzhu/auth/beike',route=>{assert.equal(route.request().postDataJSON().lianjia_token,'isolated-beike-ticket');exchanges++;return route.fulfill({json:{ok:true,token:'owner',uid:'isolated-ucid',display_name:'isolated user'}});});
            await context.route('**/api/juzhu/auth/beike-config',route=>route.fulfill({json:{login_base:'https://invalid.example.test',service_base:'https://invalid.example.test/checklogin',type:2}}));
            await page.goto(origin+'/juzhu-voucher.html?kind=skus&id='+sku.id);
            await page.getByRole('button',{name:'立即购买',exact:true}).click();
            await page.getByRole('button',{name:'确认并去付款',exact:true}).click();
            await page.waitForURL('https://invalid.example.test/cashier');
            assert(exchanges>0);
            assert.deepEqual(errors,[]);
          } finally {clearInterval(tick);if(working)await working;await browser.close();}
        }
      } finally { await new Promise(resolve=>server.close(resolve)); }
    });
  } finally {
    if(pool)await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }
});
