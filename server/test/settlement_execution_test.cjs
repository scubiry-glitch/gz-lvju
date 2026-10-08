'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mysql=require('mysql2/promise');
const {createExecution,authorizationHash}=require('../settlement/execution.cjs');
const {createProvider}=require('../settlement/provider.cjs');
const uuid=()=>crypto.randomUUID();
const json=JSON.stringify;
const socketPath=process.env.SETTLEMENT_TEST_SOCKET;
test('authorization hash freezes all fields except the embedded hash',()=>{
 assert.equal(authorizationHash({a:1,b:{z:'2',c:3}}),authorizationHash({b:{c:3,z:'2'},a:1,hash:'ignored'}));
 assert.notEqual(authorizationHash({amount_minor:'1'}),authorizationHash({amount_minor:'2'}));
 assert.throws(()=>createProvider().build('v1','SPLIT',{}),{code:'PROVIDER_CAPABILITY_DISABLED'});
});

test('actual payment core shares source/refund guards and freezes verified collection contracts',{skip:!socketPath,timeout:120000},async t=>{
 assert.match(socketPath,/^\/tmp\/sy-(?:settlement-[\w-]+|cashier-mysql)\/[^/]+\.sock$/);
 const database='settlement_payment_'+process.pid+'_'+crypto.randomBytes(4).toString('hex'),connection={socketPath,user:'root',timezone:'Z',supportBigNumbers:true,bigNumberStrings:true};
 const admin=await mysql.createConnection(connection);await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
 const pool=mysql.createPool({...connection,database,connectionLimit:8}),db=async(sql,args=[])=>(await pool.execute(sql,args))[0];
 t.after(async()=>{await pool.end();await admin.query(`DROP DATABASE \`${database}\``);await admin.end();});
 const c=await pool.getConnection();try{
  await require('../payment/migrate.cjs').migrate(c);
  for(const sql of require('../../commerce/migrate.cjs').statements)await c.query(sql);
  await require('../settlement/schema.cjs').migrate(c);await require('../settlement/execution-schema.cjs').migrate(c);
 }finally{c.release();}
 let timer=Date.UTC(2026,9,2),createCount=0,wrongControl=true;const payments=new Map(),refunds=new Map();
 const transport={
  async createC2BOrder(body){createCount++;payments.set(body.appOrderId,body);return {errno:0,data:{appOrderId:body.appOrderId,orderStatus:'10',cashierUrl:'https://example.test/cashier'}};},
  async queryOrder(input){const b=payments.get(input.appOrderId);if(!b)throw new Error('not sent');return {errno:0,data:{appOrderId:b.appOrderId,orderStatus:'30',amount:b.amount,merchantNo:b.recAndShareInfo.merchantNo,payNo:'verified-test-receipt',contractEvidence:b.contractInfo.contractNo,sourceEvidence:b.recAndShareInfo.merchantNo,controlEvidence:wrongControl?'UNCONTROLLED':'CONTROLLED'}};},
  async refundOrder(body){refunds.set(body.appOrderId,body);return {errno:0,data:{accepted:true}};},
  async queryRefundOrder(input){const b=refunds.get(input.businessOrderNo);if(!b)throw new Error('unknown refund');return {errno:0,data:{refundAppOrderId:b.appOrderId,businessOrderNo:b.businessOrderNo,refundAmount:b.refundAmount,merchantNo:b.shareOrderInfos[0].merchantNo,orderStatus:'30'}};},
 };
 const config={PAY_APP_CODE:'test-app',PAY_PROJECT_CODE:'test-project',PAY_SHARE_BIZ_CODE:'test-business',PAY_NOTIFY_URL:'https://example.test/notify',PAY_POLL_SECONDS:'1',settlement_payment_contracts:{'collection-test-v1':{enabled:true,verified:true,evidence_ref:'TEST-ONLY',provider:'TEST',environment:'ISOLATED_TEST',funding_modes:['CONTROLLED_COLLECTION'],request_template:{recAndShareInfo:{merchantNo:{$ref:'collection.source_merchant_no'},shareOrderMode:'CONTROLLED_TEST_ONLY',shareOrderInfos:[{merchantNo:{$ref:'collection.source_merchant_no'},amount:{$ref:'amount_yuan'},shareBizCode:{$ref:'base.shareBizCode'}}]},contractInfo:{contractNo:{$ref:'collection.contract_no'},contractAmount:{$ref:'amount_yuan'}}},result:{contract_no:'contractEvidence',source_merchant_no:'sourceEvidence',control_status:'controlEvidence',controlled_values:['CONTROLLED']}}}};
 const {createPaymentCore}=require('../payment/core.cjs');
 const core=createPaymentCore({createConnection:()=>pool.getConnection(),config,payCenter:transport,now:()=>timer,logger:{warn(){}}});
 const account={id:'42',idp_type:'beike',idp_subject:'test-ucid'},sourceAccount=uuid(),profile={version:1,funding_mode:'CONTROLLED_COLLECTION',contract_mapping_version:'unused-refund-only',platform_account_id:sourceAccount,implicit_merchant_release:false,collection:{mapping_version:'collection-test-v1',contract_no:'fixture-controlled-contract',source_merchant_no:'fixture-source',provider:'TEST',environment:'ISOLATED_TEST'}};
 const identity={bizType:'jiazheng',orderId:'CONTROLLED-001'};
 await core.transaction(c=>core.registerOrder(c,{...identity,accountId:account.id,amountMinor:10000,merchantNo:'fixture-source',payerUcid:account.idp_subject,expiresAt:new Date(timer+3600000),title:'Controlled fixture',snapshot:{settlement_profile:profile}}));
 const intent=await core.createIntent({...identity,account,cashierType:'2',requestKey:'controlled-request'});
 async function payWork(){timer+=10000;return core.runJobs(20);}
 await payWork();assert.equal(createCount,1);const sent=payments.get(intent.app_order_id);assert.equal(sent.recAndShareInfo.shareOrderMode,'CONTROLLED_TEST_ONLY');assert.equal(sent.contractInfo.contractNo,'fixture-controlled-contract');
 await payWork();assert.notEqual((await db('SELECT pay_status FROM payment_orders WHERE id=?',[intent.payment_id]))[0].pay_status,'paid','generic success cannot establish controlled funding');
 wrongControl=false;await core.getStatus({...identity,accountId:account.id,refresh:true});await payWork();assert.equal((await core.getStatus({...identity,accountId:account.id})).order_pay_status,'paid');
 await assert.rejects(core.requestRefund({...identity,amountMinor:1000,requestKey:'before-source-refund'}),{code:'settlement_source_pending'});
 const context=uuid(),source=uuid();
 await db("INSERT INTO commerce_payment_accounts(id,party_id,provider,environment,merchant_no,contract_no,currency,status,capabilities,created_by) VALUES(?,'merchant','TEST','ISOLATED_TEST','fixture-source','fixture-controlled-contract','CNY','approved',?,'fixture')",[sourceAccount,json({receive:true,evidence_ref:'TEST-ONLY',operations:[]})]);
 await db("INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot) VALUES(?,'jiazheng','fixture','CONTROLLED-001','pay_center','INTERNAL_FUNDED','merchant','CNY',?)",[context,json({settlement_profile:profile})]);
 await db("INSERT INTO commerce_funding_sources(id,context_id,payment_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,reserved_minor,status,evidence) VALUES(?,?,?,'ORIGINAL_PAYMENT','TEST','ISOLATED_TEST','CNY',?,'fixture-controlled-contract',10000,7000,'AVAILABLE',?)",[source,context,String(intent.payment_id),sourceAccount,json({provider_receipt:'fixture-receipt'})]);
 await assert.rejects(core.requestRefund({...identity,amountMinor:4000,requestKey:'over-reservation-refund'}),{code:'settlement_refund_funds_unavailable'});
 await core.requestRefund({...identity,amountMinor:2000,requestKey:'common-refund-one'});
 await assert.rejects(core.requestRefund({...identity,amountMinor:1500,requestKey:'common-refund-two'}),{code:'settlement_refund_funds_unavailable'});
 await payWork();await payWork();assert.equal((await db("SELECT refund_status FROM payment_refunds WHERE idempotency_key='common-refund-one'"))[0].refund_status,'refunded');
 await db('UPDATE commerce_funding_sources SET reserved_minor=0 WHERE id=?',[source]);
 await assert.rejects(core.requestRefund({...identity,amountMinor:1000,requestKey:'spoof-shared-refund',reference:{execution_order_id:uuid(),context_id:context}}),{code:'settlement_refund_invalid'});
 const writer={account:{id:'writer'}},reviewer={account:{id:'reviewer'}},engine=createExecution({pool,paymentCore:core,authorize:async()=>true,now:()=>timer});
 const plan=await engine.createRefund(writer,{context_id:context,source_id:source,amount_minor:'1000',return_line_ids:[],reason:'actual payment port',request_key:'execution-refund-plan'});
 await engine.approveReverse(reviewer,{order_id:plan.orders[0].id,approve:true});timer+=10000;await engine.runJobs({limit:10});
 assert.equal((await db('SELECT reserved_minor FROM commerce_funding_sources WHERE id=?',[source]))[0].reserved_minor,'1000');
 await payWork();await payWork();timer+=10000;await engine.runJobs({limit:10});
 const [actual]=await db('SELECT * FROM commerce_funding_sources WHERE id=?',[source]);assert.equal(actual.returned_minor,'3000');assert.equal(actual.external_refunded_minor,'2000');assert.equal(actual.reserved_minor,'0');assert.equal((await engine.getPlan(writer,{plan_id:plan.id})).status,'SUCCEEDED');
 assert.equal((await db("SELECT * FROM commerce_ledger_events WHERE event_key LIKE 'execution:refund%'")).length,0,'payment event consumer alone owns the consumer refund cash ledger');
 // Profile mappings cannot fall back to legacy shareOrderMode=0. Failure leaves
 // sent=false, so cancellation does not query a request that was never sent.
 const disabled={...profile,collection:{...profile.collection,mapping_version:'unverified'}};
 const closedIdentity={bizType:'jiazheng',orderId:'CONTROLLED-002'};
 await core.transaction(c=>core.registerOrder(c,{...closedIdentity,accountId:account.id,amountMinor:10000,merchantNo:'fixture-source',payerUcid:account.idp_subject,expiresAt:new Date(timer+3600000),title:'Closed capability',snapshot:{settlement_profile:disabled}}));
 const blocked=await core.createIntent({...closedIdentity,account,cashierType:'2',requestKey:'disabled-collection'});await payWork();assert.equal(createCount,1);
 const [job]=await db("SELECT payload FROM payment_jobs WHERE job_key=?",['pay_create:'+blocked.payment_id]);assert.equal((typeof job.payload==='string'?JSON.parse(job.payload):job.payload).sent,false);
 await assert.rejects(core.transaction(c=>core.registerOrder(c,{...identity,accountId:account.id,amountMinor:10000,merchantNo:'fixture-source',payerUcid:account.idp_subject,expiresAt:new Date(timer+3600000),title:'Changed profile',snapshot:{settlement_profile:disabled}})),{code:'payment_snapshot_conflict'});
});

test('isolated MySQL settlement execution and reverse fault recovery',{skip:!socketPath,timeout:180000},async t=>{
 assert.match(socketPath,/^\/tmp\/sy-(?:settlement-[\w-]+|cashier-mysql)\/[^/]+\.sock$/);
 const database='settlement_exec_'+process.pid+'_'+crypto.randomBytes(4).toString('hex');
 const connection={socketPath,user:'root',timezone:'Z',supportBigNumbers:true,bigNumberStrings:true};
 const admin=await mysql.createConnection(connection);await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
 const pool=mysql.createPool({...connection,database,connectionLimit:12});
 t.after(async()=>{await pool.end();await admin.query(`DROP DATABASE \`${database}\``);await admin.end();});
 const db=async(sql,args=[]) => (await pool.execute(sql,args))[0];
 const c=await pool.getConnection();
 try {
  for(const sql of require('../../commerce/migrate.cjs').statements)await c.query(sql);
  await require('../settlement/schema.cjs').migrate(c);
  await require('../settlement/execution-schema.cjs').migrate(c);
  await require('../settlement/execution-schema.cjs').migrate(c);
  await require('../settlement/reversal.cjs').migrate(c);
  // Test-only payment port tables. Provider and payment mocks exist only here.
  await c.query('CREATE TABLE payment_orders(id BIGINT PRIMARY KEY,biz_type VARCHAR(24),biz_order_no VARCHAR(100),pay_status VARCHAR(24),amount_minor BIGINT)');
  await c.query('CREATE TABLE payment_order_guards(biz_type VARCHAR(24),biz_order_no VARCHAR(100),PRIMARY KEY(biz_type,biz_order_no))');
  await c.query('CREATE TABLE payment_refunds(id BIGINT AUTO_INCREMENT PRIMARY KEY,payment_order_id BIGINT,idempotency_key VARCHAR(128) UNIQUE,refund_status VARCHAR(24),amount_minor BIGINT)');
 }finally{c.release();}
 const writer={account:{id:'writer'}},reviewer={account:{id:'reviewer'}};
 const authorize=async(p,permission,ctx)=>{if(p.party && p.party!==ctx.party_id)throw Object.assign(new Error('denied'),{status:403});return true;};
 const ref=path=>({$ref:path});
 const body={requestNo:ref('request_no'),contract:ref('contract_no'),source:ref('source_merchant_no'),currency:ref('currency'),effects:{$each:'effects',template:{id:ref('line.id'),amount:ref('line.amount_minor'),payee:ref('line.payee_merchant_no'),currency:ref('currency'),kind:ref('line.effect_kind')}}};
 const operation=method=>({amount_unit:'minor',submit:{method,template:body},query:{method:'querySplitResult',template:{requestNo:ref('request_no')}},result:{request_no:'requestNo',contract_no:'contract',source_merchant_no:'source',currency:'currency',provider_order_no:'providerNo',lines:'effects',line:{id:'id',amount:'amount',payee_merchant_no:'payee',currency:'currency',status:'status',provider_line_id:'receipt',no_debit:'noDebit',reservation_released:'released'},statuses:{ok:'SUCCEEDED',failed:'FAILED_FINAL',pending:'PROCESSING'}}});
 const config={execution_enabled:true,poll_seconds:1,lease_seconds:2,provider_contracts:{'test-v1':{enabled:true,verified:true,evidence_ref:'TEST-ONLY-CONTRACT',provider:'TEST',environment:'ISOLATED_TEST',operations:{SPLIT:operation('splitApply'),PAYOUT:operation('payout'),RETURN:operation('splitReturn'),RELEASE:operation('release')}}}};
 let timer=Date.UTC(2026,9,2), remote,engine,failAfterRemote,holdKinds,failKinds,spoof,networkHook,submits,queries;
 const paymentCore={async requestRefund(input){await db("INSERT INTO payment_refunds(payment_order_id,idempotency_key,refund_status,amount_minor) VALUES(?,?,'refunded',?) ON DUPLICATE KEY UPDATE id=id",[input.paymentId,input.requestKey,input.amountMinor]);const [r]=await db('SELECT * FROM payment_refunds WHERE idempotency_key=?',[input.requestKey]);return {id:r.id,refund_id:r.id};}};
 async function reset(){
  const tables=await db('SHOW TABLES'), cleanup=await pool.getConnection();try{await cleanup.beginTransaction();for(const row of tables){const name=Object.values(row)[0];if(!name.endsWith('migrations'))await cleanup.query('DELETE FROM `'+name+'`');}await cleanup.commit();}finally{cleanup.release();}
  timer=Date.UTC(2026,9,2);remote=new Map();failAfterRemote=false;holdKinds=new Set();failKinds=new Set();spoof=false;networkHook=null;submits=0;queries=0;
  const response=body=>({...body,providerNo:'remote-'+body.requestNo,effects:body.effects.map(effect=>({...effect,status:failKinds.has(effect.kind)?'failed':holdKinds.has(effect.kind)?'pending':'ok',receipt:'receipt-'+effect.id,noDebit:true,released:true,amount:spoof?'999':effect.amount}))});
  async function submit(body){submits++;if(networkHook)await networkHook();if(!remote.has(body.requestNo))remote.set(body.requestNo,body);if(failAfterRemote){failAfterRemote=false;throw Object.assign(new Error('response lost after debit'),{code:'ETIMEDOUT'});}return response(remote.get(body.requestNo));}
  const payCenter={splitApply:submit,payout:submit,splitReturn:submit,release:submit,async querySplitResult(input){queries++;if(!remote.has(input.requestNo))throw Object.assign(new Error('not found is UNKNOWN'),{code:'NOT_FOUND'});return response(remote.get(input.requestNo));}};
  engine=createExecution({pool,config,payCenter,paymentCore,authorize,now:()=>timer});return payCenter;
 }
 async function seed({controlled=false,implicit=false,external=false,payment=false}={}) {
  const context=uuid(),source=uuid(),unit=uuid(),a={source:uuid(),merchant:uuid(),platform:uuid(),promoter:uuid()};
  const profile={version:1,funding_mode:controlled?'MERCHANT_CONTROLLED_RECEIPT':'CONTROLLED_COLLECTION',contract_mapping_version:'test-v1',implicit_merchant_release:implicit,platform_account_id:a.platform};
  if(controlled)a.merchant=a.source;
  const parties={source:controlled?'merchant':'platform',merchant:'merchant',platform:'platform',promoter:'promoter'};
  for(const [role,id] of Object.entries(a))await db("INSERT IGNORE INTO commerce_payment_accounts(id,party_id,provider,environment,merchant_no,contract_no,currency,status,version,capabilities,created_by) VALUES(?,?,'TEST','ISOLATED_TEST',?,'contract-v1','CNY','approved',1,?,'fixture')",[id,parties[role],'merchant-'+id,json({operations:['SPLIT','RETURN','PAYOUT','RELEASE'],receive:true,evidence_ref:'TEST-ONLY-ACCOUNT'})]);
  await db('INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot) VALUES(?,\'jiazheng\',\'fixture\',?,?,?,\'merchant\',\'CNY\',?)',[context,'order-'+context,external?'wechat_mini':'pay_center',external?'EXTERNAL_RECORD_ONLY':'INTERNAL_FUNDED',json({settlement_profile:profile})]);
  await db("INSERT INTO commerce_funding_sources(id,context_id,payment_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,?,'ORIGINAL_PAYMENT','TEST','ISOLATED_TEST','CNY',?,'contract-v1',10000,'AVAILABLE',?)",[source,context,payment?'1':null,a.source,json({receipt:'confirmed-fixture'})]);
  if(payment){await db("INSERT INTO payment_orders(id,biz_type,biz_order_no,pay_status,amount_minor) VALUES(1,'jiazheng',?,'paid',10000)",['order-'+context]);await db("INSERT INTO payment_order_guards(biz_type,biz_order_no) VALUES('jiazheng',?)",['order-'+context]);}
  const items={};
  for(const [kind,amount] of [['merchant',8000],['platform_transfer',2000],['promoter',600]]){
   const role=kind==='platform_transfer'?'platform':kind;
   const inserted=await db('INSERT INTO commerce_settlement_items(context_id,unit_id,component_key,line_kind,beneficiary_party_id,account_id,source_id,rule_ref,basis_minor,payable_minor,planned_minor,original_payable_minor,status) VALUES(?,?,?,?,?,?,?,\'rule-v1\',10000,?,?,?,\'AUTHORIZED\')',[context,unit,kind,kind,parties[role],a[role],source,amount,amount,amount]);items[kind]=String(inserted.insertId);await authorizeItem(items[kind],profile);
  }
  return {context,source,unit,accounts:a,profile,items};
 }
 async function authorizeItem(itemId,profile){
  const [item]=await db('SELECT * FROM commerce_settlement_items WHERE id=?',[itemId]),id=uuid();
  const snapshot={item_id:String(item.id),item_revision:Number(item.revision),amount_minor:String(item.planned_minor),source_id:item.source_id,account_id:item.account_id,account_version:1,not_before_at:item.not_before_at?new Date(item.not_before_at).toISOString().slice(0,19).replace('T',' '):null,context_id:item.context_id,policy_id:null,policy_version:0,rule_hash:item.rule_ref,profile_version:1,funding_mode:profile.funding_mode,implicit_merchant_release:profile.implicit_merchant_release};
  await db("INSERT INTO commerce_settlement_authorizations(id,item_id,item_revision,mode,purpose,hash,snapshot,status) VALUES(?,?,?,'AUTO','FUND_EXECUTION',?,?,'ACTIVE')",[id,item.id,item.revision,authorizationHash(snapshot),json(snapshot)]);await db('UPDATE commerce_settlement_items SET authorization_id=? WHERE id=?',[id,item.id]);
 }
 const plan=(ids,key=uuid(),p=writer)=>engine.createPlan(p,{item_ids:ids,request_key:key});
 async function work(){timer+=3000;return engine.runJobs({limit:20});}
 async function source(id){return (await db('SELECT * FROM commerce_funding_sources WHERE id=?',[id]))[0];}
 async function item(id){return (await db('SELECT * FROM commerce_settlement_items WHERE id=?',[id]))[0];}
 async function success(fixture){const p=await plan([fixture.items.merchant,fixture.items.platform_transfer]);await work();return engine.getPlan(writer,{plan_id:p.id});}
 async function reversalFixture() {
  const s=await seed({payment:true}),order=uuid(),coupon=uuid(),redemption=uuid();s.order=order;s.coupon=coupon;s.redemption=redemption;
  await db("UPDATE commerce_settlement_business_contexts SET biz_type='commerce',biz_order_no=?,source_order_system='commerce_orders' WHERE id=?",[order,s.context]);
  await db("UPDATE payment_orders SET biz_type='commerce',biz_order_no=? WHERE id=1",[order.replaceAll('-','')]);await db('DELETE FROM payment_order_guards');await db("INSERT INTO payment_order_guards(biz_type,biz_order_no) VALUES('commerce',?)",[order.replaceAll('-','')]);
  // The payment port fixture adds the shared guard columns used by the legacy
  // review facade; schema semantics are verified by the actual-port test above.
  const [guardColumn]=await db("SELECT 1 ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_order_guards' AND COLUMN_NAME='paid_payment_id'");if(!guardColumn)await pool.query('ALTER TABLE payment_order_guards ADD COLUMN paid_payment_id BIGINT');
  await db('UPDATE payment_order_guards SET paid_payment_id=1');
  await db("INSERT INTO commerce_orders(id,account_id,city_id,product_kind,product_id,product_version,amount_minor,status,expires_at,snapshot,source_account_id) VALUES(?,1,1,'coupon',1,1,10000,'paid','2099-01-01','{}',99)",[order]);
  await db("INSERT INTO commerce_coupons(id,order_id,item_id,unit_no,account_id,merchant_id,store_id,city_id,status,expires_at,allocation_minor,snapshot) VALUES(?,?,1,1,1,1,1,1,'redeemed','2099-01-01',10000,'{}')",[coupon,order]);
  await db("INSERT INTO commerce_redemptions(id,coupon_id,account_id,merchant_id,store_id,city_id,operator_id,allocation_minor,supplier_minor,beike_minor,channel_minor,retained_minor) VALUES(?,?,1,1,1,1,1,10000,8000,2000,600,1400)",[redemption,coupon]);
  await db('UPDATE commerce_settlement_items SET redemption_id=?,coupon_id=?,order_id=?,merchant_id=1,promoter_account_id=99,city_id=1 WHERE unit_id=?',[redemption,coupon,order,s.unit]);
  const calculation={merchant_minor:'8000',commission_minor:'2000',promoter_minor:'600',retained_minor:'1400',unallocated_minor:'0'};
  await db("INSERT INTO commerce_settlement_units(id,context_id,unit_key,recognition_id,status,basis_minor,source_id,rule_snapshot,calculation,evidence,confirmed_at) VALUES(?,?,?,?,'CONFIRMED',10000,?,'{}',?,'{}','2026-10-02 00:00:00')",[s.unit,s.context,coupon,redemption,s.source,json(calculation)]);
  const conn=await pool.getConnection();try{await conn.beginTransaction();await require('../settlement/primitives.cjs').postLedger(conn,{event_key:'recognition:'+s.context+':'+redemption,context_id:s.context,source_id:s.unit,lines:[{account:'unredeemed_liability',side:'debit',amount_minor:'10000'},{account:'payable:merchant',side:'credit',amount_minor:'8000'},{account:'payable:promoter',side:'credit',amount_minor:'600'},{account:'platform_retained',side:'credit',amount_minor:'1400'}]});await conn.commit();}finally{conn.release();}
  const created=await db("INSERT INTO commerce_redemption_reversals(reversal_no,redemption_id,reason,requested_by) VALUES(?,?,'共享误核销撤销测试',1)",['RV-'+uuid(),redemption]);s.reversal=(await db('SELECT * FROM commerce_redemption_reversals WHERE id=?',[created.insertId]))[0];return s;
 }
 async function reverse(s) {const c=await pool.getConnection();try{await c.beginTransaction();const out=await require('../settlement/reversal.cjs').applySharedReversal(c,{service:{audit:async()=>{}},principal:{account:{id:2}},reversal:s.reversal,note:'独立复核同意撤销'});await c.commit();return out;}catch(e){await c.rollback();throw e;}finally{c.release();}}
 await t.test('default disabled capability and external scope never reserve or call transport',async()=>{
  const transport=await reset(),s=await seed();const closed=createExecution({pool,payCenter:transport,authorize,now:()=>timer});
  await assert.rejects(closed.createPlan(writer,{item_ids:[s.items.merchant],request_key:'disabled'}),{code:'PROVIDER_CAPABILITY_DISABLED'});assert.equal(Number((await source(s.source)).reserved_minor),0);assert.equal(submits,0);
  await reset();const e=await seed({external:true});await assert.rejects(plan([e.items.merchant]),{code:'SETTLEMENT_SCOPE_DENIED'});assert.equal(submits,0);
 });
 await t.test('identical concurrent requests converge; separate plans cannot double reserve',async()=>{
  await reset();const s=await seed();const results=await Promise.all(Array.from({length:8},()=>plan([s.items.merchant,s.items.platform_transfer],'same-key')));assert.equal(new Set(results.map(p=>p.id)).size,1);
  await assert.rejects(plan([s.items.merchant],'new-key'));assert.equal(Number((await source(s.source)).reserved_minor),10000);
  // A second connection updates the source DURING the network call. Holding a DB
  // transaction lock around HTTP would deadlock this deliberate probe.
  networkHook=async()=>{const c=await pool.getConnection();try{await c.query('SET innodb_lock_wait_timeout=1');await c.execute('UPDATE commerce_funding_sources SET reserved_minor=reserved_minor WHERE id=?',[s.source]);}finally{c.release();}};
  await Promise.all([work(),work(),work()]);assert.equal(submits,1);assert.equal(Number((await source(s.source)).consumed_minor),10000);assert.equal((await engine.verifyInvariants(writer)).ok,true);
 });
 await t.test('lost response and expired worker lease query the original request without resending',async()=>{
  await reset();const s=await seed();const p=await plan([s.items.merchant,s.items.platform_transfer]);failAfterRemote=true;await work();assert.equal(submits,1);assert.equal(Number((await source(s.source)).reserved_minor),10000);
  await assert.rejects(engine.cancel(writer,{plan_id:p.id}));await work();assert.equal(submits,1);assert.equal(queries,1);assert.equal((await engine.getPlan(writer,{plan_id:p.id})).status,'SUCCEEDED');
  const events=await db('SELECT * FROM commerce_execution_events');await engine.retry(writer,{order_id:p.orders[0].id});await work();assert.equal((await db('SELECT * FROM commerce_execution_events')).length,events.length);
 });
 await t.test('mismatched receipt preserves UNKNOWN and all reservations until a matching query',async()=>{
  await reset();const s=await seed();const p=await plan([s.items.merchant]);spoof=true;await work();assert.equal(Number((await source(s.source)).reserved_minor),8000);assert.equal((await item(s.items.merchant)).discharged_minor,'0');
  spoof=false;await work();assert.equal((await engine.getPlan(writer,{plan_id:p.id})).status,'SUCCEEDED');assert.equal(submits,1);
 });
 await t.test('pausing new execution blocks unsent requests while old UNKNOWN still queries',async()=>{
  await reset();const s=await seed();const p=await plan([s.items.merchant]);failAfterRemote=true;await work();config.execution_enabled=false;
  try{await work();assert.equal(submits,1);assert.equal(queries,1);assert.equal((await engine.getPlan(writer,{plan_id:p.id})).status,'SUCCEEDED');}finally{config.execution_enabled=true;}
  await reset();const next=await seed();const ready=await plan([next.items.merchant]);config.execution_enabled=false;
  try{await work();assert.equal(submits,0);const order=(await engine.getPlan(writer,{plan_id:ready.id})).orders[0];assert.equal(order.status,'READY');assert.equal(order.submitted_at,null);}finally{config.execution_enabled=true;}
 });
 await t.test('disabling a selected policy blocks a reserved but unsent plan',async()=>{
  await reset();const s=await seed(),policyId=uuid();await db("INSERT INTO commerce_settlement_policies(id,party_id,biz_type,payment_mode,version,mode,status,conditions,nodes,created_by) VALUES(?,'merchant','jiazheng','pay_center',1,'AUTO','approved','{}','[]','fixture')",[policyId]);
  const [authorization]=await db('SELECT a.* FROM commerce_settlement_authorizations a JOIN commerce_settlement_items i ON i.authorization_id=a.id WHERE i.id=?',[s.items.merchant]);const snapshot=typeof authorization.snapshot==='string'?JSON.parse(authorization.snapshot):authorization.snapshot;snapshot.policy_id=policyId;snapshot.policy_version=1;await db('UPDATE commerce_settlement_authorizations SET snapshot=?,hash=? WHERE id=?',[json(snapshot),authorizationHash(snapshot),authorization.id]);
  const p=await plan([s.items.merchant]);await db("UPDATE commerce_settlement_policies SET status='disabled' WHERE id=?",[policyId]);await work();assert.equal(submits,0);assert.equal((await engine.getPlan(writer,{plan_id:p.id})).orders[0].submitted_at,null);await engine.cancel(writer,{plan_id:p.id});assert.equal(Number((await source(s.source)).reserved_minor),0);
 });
 await t.test('local receipt transaction failure after remote debit recovers by original-number query',async()=>{
  const transport=await reset(),s=await seed();let fail=true;
  engine=createExecution({pool,config,payCenter:transport,paymentCore,authorize,now:()=>timer,postLedger:async(c,event)=>{await require('../settlement/primitives.cjs').postLedger(c,event);if(fail){fail=false;throw new Error('injected local commit failure');}}});
  const p=await plan([s.items.merchant]);await work();assert.equal(submits,1);assert.equal(Number((await source(s.source)).reserved_minor),8000);assert.equal((await db('SELECT * FROM commerce_ledger_events')).length,0);
  await work();assert.equal(submits,1);assert.equal(queries,1);assert.equal((await engine.getPlan(writer,{plan_id:p.id})).status,'SUCCEEDED');assert.equal((await db('SELECT * FROM commerce_ledger_events')).length,1);
 });
 await t.test('paying less preserves the residual payable but a completed authorization cannot be reused',async()=>{
  await reset();const s=await seed();await db('UPDATE commerce_settlement_items SET planned_minor=3000 WHERE id=?',[s.items.merchant]);await authorizeItem(s.items.merchant,s.profile);await plan([s.items.merchant]);await work();
  assert.equal((await item(s.items.merchant)).discharged_minor,'3000');assert.equal((await item(s.items.merchant)).payable_minor,'8000');await assert.rejects(plan([s.items.merchant]));
  await authorizeItem(s.items.merchant,s.profile);await plan([s.items.merchant]);await work();assert.equal((await item(s.items.merchant)).discharged_minor,'6000');assert.equal((await engine.verifyInvariants(writer)).ok,true);
 });
 await t.test('partial settlement creates no B lot until B receipt; payout consumes only that lot',async()=>{
  await reset();const s=await seed();holdKinds.add('PLATFORM_TRANSFER');const p=await plan([s.items.merchant,s.items.platform_transfer]);await work();assert.equal(Number((await source(s.source)).consumed_minor),8000);assert.equal((await db('SELECT * FROM commerce_commission_funding_lots')).length,0);await assert.rejects(plan([s.items.promoter]));
  holdKinds.clear();await work();const [lot]=await db('SELECT * FROM commerce_commission_funding_lots');assert.equal(Number(lot.received_minor),2000);await db('UPDATE commerce_settlement_items SET source_id=?,revision=revision+1 WHERE id=?',[lot.source_id,s.items.promoter]);await authorizeItem(s.items.promoter,s.profile);
  await plan([s.items.promoter]);await work();assert.equal(Number((await source(s.source)).consumed_minor),10000);assert.equal(Number((await source(lot.source_id)).consumed_minor),600);assert.equal((await engine.verifyInvariants(writer)).ok,true);
  const entries=await db('SELECT * FROM commerce_ledger_entries WHERE account=? AND side=\'credit\'',['settlement_cash:'+s.source]);assert.equal(entries.reduce((n,r)=>n+Number(r.amount_minor),0),10000);assert.equal((await engine.getPlan(writer,{plan_id:p.id})).status,'SUCCEEDED');
 });
 await t.test('definitive no-debit releases only failed lines; no whole-order retry',async()=>{
  await reset();const s=await seed();failKinds.add('PLATFORM_TRANSFER');const p=await plan([s.items.merchant,s.items.platform_transfer]);await work();assert.equal((await engine.getPlan(writer,{plan_id:p.id})).status,'PARTIAL');assert.equal(Number((await source(s.source)).reserved_minor),0);assert.equal(Number((await source(s.source)).consumed_minor),8000);
  await engine.retry(writer,{order_id:p.orders[0].id});await work();assert.equal(submits,1);assert.equal((await item(s.items.merchant)).discharged_minor,'8000');
 });
 await t.test('implicit merchant release requires full S approval and due date; sends no second release',async()=>{
  await reset();const s=await seed({controlled:true,implicit:true});await assert.rejects(plan([s.items.platform_transfer]));
  await db("UPDATE commerce_settlement_items SET not_before_at='2099-01-01 00:00:00' WHERE id=?",[s.items.merchant]);await authorizeItem(s.items.merchant,s.profile);await assert.rejects(plan([s.items.merchant,s.items.platform_transfer]));
  await db('UPDATE commerce_settlement_items SET not_before_at=NULL WHERE id=?',[s.items.merchant]);await authorizeItem(s.items.merchant,s.profile);const p=await success(s);assert.equal(p.orders.length,1);assert.equal(submits,1);const [allocation]=await db('SELECT * FROM commerce_execution_allocations WHERE item_id=?',[s.items.merchant]);assert.equal(Number(allocation.merchant_released_minor),8000);assert.equal(Number(allocation.transferred_minor),0);
 });
 await t.test('zero merchant leg is omitted; zero B uses only the separately verified release operation',async()=>{
  await reset();let s=await seed({controlled:true,implicit:true});await db('UPDATE commerce_settlement_items SET payable_minor=0,planned_minor=0,original_payable_minor=0 WHERE id=?',[s.items.merchant]);await db('UPDATE commerce_settlement_items SET payable_minor=10000,planned_minor=10000,original_payable_minor=10000 WHERE id=?',[s.items.platform_transfer]);await authorizeItem(s.items.platform_transfer,s.profile);let p=await plan([s.items.platform_transfer]);await work();assert.equal((await engine.getPlan(writer,{plan_id:p.id})).status,'SUCCEEDED');assert.equal(submits,1);
  await reset();s=await seed({controlled:true,implicit:true});await db('UPDATE commerce_settlement_items SET payable_minor=0,planned_minor=0,original_payable_minor=0 WHERE id=?',[s.items.platform_transfer]);await db('UPDATE commerce_settlement_items SET payable_minor=10000,planned_minor=10000,original_payable_minor=10000 WHERE id=?',[s.items.merchant]);await authorizeItem(s.items.merchant,s.profile);p=await plan([s.items.merchant]);assert.equal(p.orders[0].operation,'RELEASE');await work();assert.equal((await engine.getPlan(writer,{plan_id:p.id})).status,'SUCCEEDED');assert.equal(submits,1);
 });
 await t.test('reverse needs second reviewer; cumulative return cannot reopen historical payable',async()=>{
  await reset();const s=await seed();const p=await success(s),line=p.orders[0].lines.find(l=>l.effect_kind==='TRANSFER');
  const r=await engine.createReturn(writer,{line_id:line.id,amount_minor:'3000',reason:'partial reversal',request_key:uuid()});assert.equal(submits,1);await assert.rejects(engine.approveReverse(writer,{order_id:r.orders[0].id,approve:true}));
  await engine.approveReverse(reviewer,{order_id:r.orders[0].id,approve:true});await work();assert.equal(Number((await source(s.source)).consumed_minor),7000);assert.equal((await item(s.items.merchant)).discharged_minor,'8000');await assert.rejects(plan([s.items.merchant]));
  const tooMuch=await engine.createReturn(writer,{line_id:line.id,amount_minor:'6000',reason:'over-return',request_key:uuid()});await assert.rejects(engine.approveReverse(reviewer,{order_id:tooMuch.orders[0].id,approve:true}));assert.equal((await engine.verifyInvariants(writer)).ok,true);
 });
 await t.test('B cannot be returned after its cash is reserved for Q; successful return restores original source only',async()=>{
  await reset();const s=await seed(),p=await success(s),b=p.orders[0].lines.find(l=>l.effect_kind==='PLATFORM_TRANSFER'),[lot]=await db('SELECT * FROM commerce_commission_funding_lots');
  await db('UPDATE commerce_settlement_items SET source_id=?,revision=revision+1 WHERE id=?',[lot.source_id,s.items.promoter]);await authorizeItem(s.items.promoter,s.profile);const q=await plan([s.items.promoter]);
  const r=await engine.createReturn(writer,{line_id:b.id,amount_minor:'2000',reason:'B return',request_key:uuid()});await assert.rejects(engine.approveReverse(reviewer,{order_id:r.orders[0].id,approve:true}));await engine.cancel(writer,{plan_id:q.id});await engine.approveReverse(reviewer,{order_id:r.orders[0].id,approve:true});await work();assert.equal(Number((await source(s.source)).consumed_minor),8000);assert.equal(Number((await source(lot.source_id)).returned_minor),2000);
 });
 await t.test('consumer refund waits for exact return dependency and durable payment receipt',async()=>{
  await reset();const s=await seed({payment:true}),p=await success(s),line=p.orders[0].lines.find(l=>l.effect_kind==='TRANSFER');const r=await engine.createReturn(writer,{line_id:line.id,amount_minor:'1000',reason:'customer refund',request_key:uuid()});
  const refund=await engine.createRefund(writer,{context_id:s.context,source_id:s.source,amount_minor:'1000',return_line_ids:[r.orders[0].lines[0].id],reason:'customer refund',request_key:uuid()});await engine.approveReverse(reviewer,{order_id:refund.orders[0].id,approve:true});await work();assert.equal((await db('SELECT * FROM payment_refunds')).length,0);
  await engine.approveReverse(reviewer,{order_id:r.orders[0].id,approve:true});await work();await work();assert.equal((await db('SELECT * FROM payment_refunds')).length,1);assert.equal(Number((await source(s.source)).returned_minor),1000);assert.equal(Number((await source(s.source)).reserved_minor),0);assert.equal((await engine.verifyInvariants(writer)).ok,true);
 });
 await t.test('external common refund receipt reduces source once and blocks spending refunded cash',async()=>{
  await reset();const s=await seed({payment:true});await db("INSERT INTO payment_refunds(payment_order_id,idempotency_key,refund_status,amount_minor) VALUES(1,'other-refund','refunded',3000)");await assert.rejects(plan([s.items.merchant]));assert.equal(Number((await source(s.source)).returned_minor),0,'failed admission transaction rolls back mirror safely');
  await plan([s.items.platform_transfer]);assert.equal(Number((await source(s.source)).returned_minor),3000);await work();assert.equal(Number((await source(s.source)).returned_minor),3000);
 });
 await t.test('bank RETURNED retains successful history and records separate repayment liability once',async()=>{
  await reset();const s=await seed(),p=await success(s),line=p.orders[0].lines.find(l=>l.effect_kind==='TRANSFER');const input={line_id:line.id,amount_minor:'1000',evidence_key:'unique-bank-return',evidence:{provider_receipt:'bank-receipt'}};
  const draft=await engine.recordReturned(writer,input);await assert.rejects(engine.approveReturned(writer,{returned_id:draft.id,approve:true}));await engine.approveReturned(reviewer,{returned_id:draft.id,approve:true});await engine.approveReturned(reviewer,{returned_id:draft.id,approve:true});assert.equal((await engine.recordReturned(writer,input)).id,draft.id);
  assert.equal((await item(s.items.merchant)).discharged_minor,'8000');assert.equal(Number((await source(s.source)).consumed_minor),9000);assert.equal((await db("SELECT * FROM commerce_execution_events WHERE kind='RETURNED'")).length,1);assert.equal((await db('SELECT status FROM commerce_execution_lines WHERE id=?',[line.id]))[0].status,'SUCCEEDED');
 });
 await t.test('services authorize actual stored context and do not trust a supplied party',async()=>{
  await reset();const s=await seed(),p=await plan([s.items.merchant]),outsider={account:{id:'outsider'},party:'somebody-else'};
  await assert.rejects(engine.getPlan(outsider,{plan_id:p.id,party_id:'somebody-else'}),{status:403});assert.deepEqual((await engine.listPlans(outsider,{party_id:'somebody-else'})).rows,[]);await assert.rejects(engine.cancel(outsider,{plan_id:p.id,party_id:'somebody-else'}),{status:403});await assert.rejects(engine.verifyInvariants(outsider,{party_id:'somebody-else'}),{status:403});
 });
 await t.test('confirmed unpaid obligations block refunds until shared reversal cancels reviews and payables',async()=>{
  await reset();const s=await reversalFixture();await assert.rejects(engine.createRefund(writer,{context_id:s.context,source_id:s.source,amount_minor:'1000',request_key:'economic-refund-before',return_line_ids:[]}),{code:'SETTLEMENT_REFUND_OBLIGATION_ACTIVE'});
  await db("INSERT INTO commerce_settlement_approval_instances(id,item_id,item_revision,purpose,status,nodes,current_node,created_by,snapshot) VALUES(?,?,1,'FUND_EXECUTION','PENDING','[]',0,'review-maker','{}')",[uuid(),s.items.merchant]);
  await reverse(s);assert.equal((await db('SELECT status FROM commerce_settlement_units WHERE id=?',[s.unit]))[0].status,'REVERSED');assert.equal((await db('SELECT status FROM commerce_coupons WHERE id=?',[s.coupon]))[0].status,'available');assert.equal((await item(s.items.merchant)).cancelled_minor,'8000');assert.equal((await db('SELECT status FROM commerce_settlement_approval_instances'))[0].status,'SUPERSEDED');assert.equal((await db('SELECT * FROM commerce_shared_recovery_cases')).length,0);
  await assert.rejects(reverse(s));assert.equal((await db("SELECT * FROM commerce_ledger_events WHERE event_key LIKE 'shared-reversal:%'")).length,1);
  const refund=await engine.createRefund(writer,{context_id:s.context,source_id:s.source,amount_minor:'1000',request_key:'economic-refund-after',return_line_ids:[]});assert.equal(refund.status,'DRAFT');
 });
 await t.test('re-redeeming a reversed coupon creates one new unit and preserves old settlement history',async()=>{
  await reset();const s=await reversalFixture();await reverse(s);const recognition=uuid(),[stored]=await db('SELECT * FROM commerce_settlement_business_contexts WHERE id=?',[s.context]),ctx={...stored,snapshot:typeof stored.snapshot==='string'?JSON.parse(stored.snapshot):stored.snapshot};
  const profile={...s.profile,party_id:'merchant',merchant_account_id:s.accounts.merchant,calculation:{mode:'PROPORTIONAL',commission_bps:2000,channel_bps:3000,rounding:'FLOOR_BPS_V1'}};
  async function recognize(){const c=await pool.getConnection();try{await c.beginTransaction();const result=await require('../settlement/business.cjs').recognize(c,{ctx,unit_key:s.coupon,recognition_id:recognition,amount_minor:'10000',source:await source(s.source),profile,evidence:{redemption_id:recognition},merchant_id:1,promoter_account_id:99,coupon_id:s.coupon,redemption_id:recognition,order_id:s.order,city_id:1});await c.commit();return result;}catch(e){await c.rollback();throw e;}finally{c.release();}}
  const first=await recognize(),again=await recognize();assert.equal(first.id,again.id);assert.notEqual(first.id,s.unit);const units=await db('SELECT * FROM commerce_settlement_units WHERE context_id=?',[s.context]);assert.equal(units.length,2);assert.equal(units.filter(u=>u.status==='CONFIRMED').length,1);assert.equal((await item(s.items.merchant)).cancelled_minor,'8000');assert.equal((await db("SELECT * FROM commerce_ledger_events WHERE event_key=?",['recognition:'+s.context+':'+recognition])).length,1);
 });
 await t.test('shared reversal rejects UNKNOWN money, then cancels unpaid remainder and opens only paid recovery',async()=>{
  await reset();const s=await reversalFixture();await db('UPDATE commerce_settlement_items SET planned_minor=3000 WHERE id=?',[s.items.merchant]);await authorizeItem(s.items.merchant,s.profile);const p=await plan([s.items.merchant]);failAfterRemote=true;await work();await assert.rejects(reverse(s),{code:'shared_reversal_in_flight'});await work();await reverse(s);
  const [recovery]=await db("SELECT * FROM commerce_shared_recovery_cases WHERE recovery_kind='BENEFICIARY'");assert.equal(recovery.principal_minor,'3000');assert.equal(recovery.recovered_minor,'0');assert.equal((await item(s.items.merchant)).discharged_minor,'3000');assert.equal((await item(s.items.merchant)).cancelled_minor,'5000');assert.equal((await engine.getPlan(writer,{plan_id:p.id})).status,'SUCCEEDED');
 });
 await t.test('shared paid reversal reverses economics once; B internal return and beneficiary cash recover independently',async()=>{
  await reset();const s=await reversalFixture(),p=await success(s),merchant=p.orders[0].lines.find(l=>l.effect_kind==='TRANSFER');
  const priorReturn=await engine.createReturn(writer,{line_id:merchant.id,amount_minor:'1000',reason:'cash recovered before business reversal',request_key:uuid()});await engine.approveReverse(reviewer,{order_id:priorReturn.orders[0].id,approve:true});await work();await reverse(s);
  const cases=await db('SELECT * FROM commerce_shared_recovery_cases');assert.equal(cases.length,2);const recovery=cases.find(r=>r.recovery_kind==='BENEFICIARY');assert.equal(recovery.principal_minor,'8000');assert.equal(recovery.recovered_minor,'1000');assert.equal(cases.find(r=>r.recovery_kind==='INTERNAL_RETURN').principal_minor,'2000');
  const cashBefore=(await source(s.source)).consumed_minor;
  const pending=await engine.recordReturned(writer,{line_id:merchant.id,amount_minor:'500',evidence_key:'late-bank-return',evidence:{provider_receipt:'late-bank'}});const cleared=await engine.approveReturned(reviewer,{returned_id:pending.id,approve:true});assert.equal(cleared.repayment_item_id,null);assert.equal(cleared.recovery_id,recovery.id);assert.equal((await db('SELECT recovered_minor FROM commerce_shared_recovery_cases WHERE id=?',[recovery.id]))[0].recovered_minor,'1500');assert.equal(Number((await source(s.source)).consumed_minor),Number(cashBefore)-500);assert.equal((await db("SELECT * FROM commerce_settlement_items WHERE component_key LIKE 'returned:%'")).length,0);
  const payable=await db("SELECT side,amount_minor FROM commerce_ledger_entries WHERE account='payable:merchant'");assert.equal(payable.reduce((n,l)=>n+(l.side==='credit'?1:-1)*Number(l.amount_minor),0),0);assert.equal((await engine.verifyInvariants(writer)).ok,true);
 });
});
