'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),mysql=require('mysql2/promise');
const demo=require('../settlement/sytest-provider.cjs');
const {createExecution,authorizationHash}=require('../settlement/execution.cjs');
const id=()=>crypto.randomUUID(),json=JSON.stringify;
const config={JUZHU_ENV:'test',SETTLEMENT_DEMO_ENABLED:'1',SETTLEMENT_ENABLED:'0',SETTLEMENT_WORKER_ENABLED:'0',execution_enabled:false,poll_seconds:1};
test('sytest port requires explicit test-site switch and all original source markers',()=>{
 const ctx={execution_scope:'INTERNAL_FUNDED',payment_mode:'pay_center',snapshot:{demo:{seed_key:demo.SEED_KEY},settlement_profile:{contract_mapping_version:demo.VERSION}}};
 const source={provider:demo.PROVIDER,environment:demo.ENVIRONMENT,payment_id:null,evidence:{demo_seed_key:demo.SEED_KEY}};
 assert.equal(demo.assertRoute(config,ctx,source),true);
 for(const bad of [{...config,JUZHU_ENV:'prod'},{...config,SETTLEMENT_DEMO_ENABLED:'0'}])assert.throws(()=>demo.assertRoute(bad,ctx,source),{code:'SYTEST_MOCK_SCOPE_DENIED'});
 for(const bad of [{...source,payment_id:'123'},{...source,environment:'production'},{...source,evidence:{}}])assert.throws(()=>demo.assertRoute(config,ctx,bad),{code:'SYTEST_MOCK_SCOPE_DENIED'});
 assert.throws(()=>demo.assertAccount({provider:demo.PROVIDER,environment:demo.ENVIRONMENT,capabilities:{}}),{code:'SYTEST_MOCK_SCOPE_DENIED'});
});

test('database-backed sytest execution has no external financial port and preserves real gates',{skip:!process.env.SETTLEMENT_TEST_SOCKET,timeout:120000},async t=>{
 const socketPath=process.env.SETTLEMENT_TEST_SOCKET;assert.match(socketPath,/^\/tmp\/sy-(?:settlement-[\w-]+|cashier-mysql)\/[^/]+\.sock$/);
 const database='settlement_sytest_'+process.pid+'_'+crypto.randomBytes(4).toString('hex');
 const connection={socketPath,user:'root',timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true};
 const admin=await mysql.createConnection(connection);await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
 const pool=mysql.createPool({...connection,database,connectionLimit:8}),q=async(sql,args=[])=>(await pool.execute(sql,args))[0];
 t.after(async()=>{await pool.end();await admin.query(`DROP DATABASE \`${database}\``);await admin.end();});
 const c=await pool.getConnection();try{for(const sql of require('../../commerce/migrate.cjs').statements)await c.query(sql);await require('../payment/migrate.cjs').migrate(c);await require('../settlement/schema.cjs').migrate(c);await require('../settlement/execution-schema.cjs').migrate(c);await require('../settlement/reversal.cjs').migrate(c);}finally{c.release();}
 let now=Date.UTC(2026,9,8),externalCalls=0;const forbidden=async()=>{externalCalls++;throw new Error('external money port must never be called');};
 const maker={account:{id:'maker'}},checker={account:{id:'checker'}},authorize=async()=>true;
 const options={pool,config,authorize,now:()=>now,payCenter:new Proxy({},{get:()=>forbidden}),paymentCore:{requestRefund:forbidden}};
 const E=createExecution(options),work=async()=>{now+=2000;return E.runJobs({limit:30});};
 async function grant(itemId,profile){
  const [i]=await q('SELECT * FROM commerce_settlement_items WHERE id=?',[itemId]),auth=id();
  const snapshot={item_id:String(i.id),item_revision:Number(i.revision),amount_minor:String(i.planned_minor),source_id:i.source_id,account_id:i.account_id,account_version:1,not_before_at:null,context_id:i.context_id,policy_id:null,policy_version:0,rule_hash:i.rule_ref,profile_version:1,funding_mode:profile.funding_mode,implicit_merchant_release:false};
  await q("INSERT INTO commerce_settlement_authorizations(id,item_id,item_revision,mode,purpose,hash,snapshot,status) VALUES(?,?,?,'AUTO','FUND_EXECUTION',?,?,'ACTIVE')",[auth,i.id,i.revision,authorizationHash(snapshot),json(snapshot)]);
  await q("UPDATE commerce_settlement_items SET authorization_id=?,status='AUTHORIZED' WHERE id=?",[auth,i.id]);
 }
 async function fixture(scenario='SUCCESS',real=false){
  const context=id(),source=id(),unit=id(),accounts={source:id(),merchant:id(),platform:id(),promoter:id()};
  const profile={version:1,funding_mode:'CONTROLLED_COLLECTION',contract_mapping_version:real?'real-not-enabled':demo.VERSION,implicit_merchant_release:false,platform_account_id:accounts.platform};
  for(const [role,key] of Object.entries(accounts))await q("INSERT INTO commerce_payment_accounts(id,party_id,provider,environment,merchant_no,contract_no,currency,status,version,capabilities,created_by) VALUES(?,?,?,?,?,'sytest-contract','CNY','approved',1,?,'fixture')",[key,role,real?'REAL':demo.PROVIDER,real?'production':demo.ENVIRONMENT,'merchant-'+key,json({receive:true,operations:['SPLIT','PAYOUT','RETURN','RELEASE'],evidence_ref:'ISOLATED-ONLY',...(real?{}:{demo_seed_key:demo.SEED_KEY})})]);
  await q("INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot) VALUES(?,'jiazheng','isolated-sytest',?,'pay_center','INTERNAL_FUNDED','merchant','CNY',?)",[context,'order-'+context,json({settlement_profile:profile,...(real?{}:{demo:{seed_key:demo.SEED_KEY,scenario}})})]);
  await q("INSERT INTO commerce_funding_sources(id,context_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,'PAYMENT',?,?,'CNY',?,'sytest-contract',12000,'AVAILABLE',?)",[source,context,real?'REAL':demo.PROVIDER,real?'production':demo.ENVIRONMENT,accounts.source,json(real?{}:{demo_seed_key:demo.SEED_KEY})]);
  const items={};for(const [kind,amount,role] of [['merchant','8000','merchant'],['platform_transfer','2000','platform'],['promoter','600','promoter']]){
   const out=await q("INSERT INTO commerce_settlement_items(context_id,unit_id,component_key,line_kind,beneficiary_party_id,account_id,source_id,rule_ref,basis_minor,payable_minor,planned_minor,original_payable_minor,status) VALUES(?,?,?,?,?,?,?,'fixture-rule',10000,?,?,?,'AUTHORIZED')",[context,unit,kind,kind,role,accounts[role],source,amount,amount,amount]);items[kind]=String(out.insertId);await grant(items[kind],profile);
  }
  return {context,source,unit,accounts,profile,items};
 }
 const plan=(s,kinds=['merchant','platform_transfer'])=>E.createPlan(maker,{item_ids:kinds.map(k=>s.items[k]),request_key:id()});
 await t.test('normal split and Q use immutable receipts and the actual B funding lot',async()=>{
  const s=await fixture(),p=await plan(s);await work();assert.equal((await E.getPlan(maker,{plan_id:p.id})).status,'SUCCEEDED');
  const [lot]=await q('SELECT s.* FROM commerce_commission_funding_lots l JOIN commerce_funding_sources s ON s.id=l.source_id WHERE l.unit_id=?',[s.unit]);assert.equal((typeof lot.evidence==='string'?JSON.parse(lot.evidence):lot.evidence).demo_seed_key,demo.SEED_KEY);
  await q('UPDATE commerce_settlement_items SET source_id=?,revision=revision+1 WHERE id=?',[lot.id,s.items.promoter]);await grant(s.items.promoter,s.profile);const qp=await plan(s,['promoter']);await work();assert.equal((await E.getPlan(maker,{plan_id:qp.id})).status,'SUCCEEDED');
  assert.equal((await q('SELECT consumed_minor FROM commerce_funding_sources WHERE id=?',[s.source]))[0].consumed_minor,'10000');assert.equal((await q('SELECT consumed_minor FROM commerce_funding_sources WHERE id=?',[lot.id]))[0].consumed_minor,'600');
  const original=(await E.getPlan(maker,{plan_id:p.id})).orders[0].lines.find(l=>String(l.item_id)===s.items.merchant);
  const rp=await E.createReturn(maker,{line_id:original.id,amount_minor:'1000',reason:'isolated return',request_key:id()});await E.approveReverse(checker,{order_id:rp.orders[0].id,approve:true});await work();assert.equal((await E.getPlan(maker,{plan_id:rp.id})).status,'SUCCEEDED');
  assert.equal((await q('SELECT consumed_minor FROM commerce_funding_sources WHERE id=?',[s.source]))[0].consumed_minor,'9000');
 });
 await t.test('UNKNOWN and partial results query the same frozen request without repeat discharge',async()=>{
  for(const scenario of ['UNKNOWN_THEN_SUCCESS','PARTIAL_THEN_SUCCESS']){
   const s=await fixture(scenario),p=await plan(s);await work();let current=await E.getPlan(maker,{plan_id:p.id});assert.equal(current.orders[0].status,'UNKNOWN');const originalNo=current.orders[0].request_no;
   await E.query(maker,{order_id:current.orders[0].id});await work();current=await E.getPlan(maker,{plan_id:p.id});assert.equal(current.orders[0].request_no,originalNo);assert.equal(current.status,'SUCCEEDED');assert.equal((await q('SELECT consumed_minor FROM commerce_funding_sources WHERE id=?',[s.source]))[0].consumed_minor,'10000');
  }
 });
 await t.test('final failure releases reserves and closed real plans never reach a transport',async()=>{
  const s=await fixture('FAILED_FINAL'),p=await plan(s);await work();assert.equal((await E.getPlan(maker,{plan_id:p.id})).orders[0].status,'FAILED_FINAL');assert.equal((await q('SELECT reserved_minor FROM commerce_funding_sources WHERE id=?',[s.source]))[0].reserved_minor,'0');
  const real=await fixture('SUCCESS',true),mock=await fixture();await assert.rejects(plan(real),{code:'PROVIDER_CAPABILITY_DISABLED'});await assert.rejects(E.createPlan(maker,{item_ids:[real.items.merchant,mock.items.merchant],request_key:id()}),{code:'SYTEST_MIXED_PLAN_DENIED'});
  const closed=createExecution({...options,config:{...config,JUZHU_ENV:'production'}});await assert.rejects(closed.createPlan(maker,{item_ids:[mock.items.merchant],request_key:id()}),{code:'SYTEST_MOCK_SCOPE_DENIED'});
  await q("UPDATE commerce_payment_accounts SET capabilities=JSON_REMOVE(capabilities,'$.demo_seed_key') WHERE id=?",[mock.accounts.merchant]);await assert.rejects(plan(mock,['merchant']),{code:'SYTEST_MOCK_SCOPE_DENIED'});
 });
 await t.test('mock consumer refund posts one ledger event and never creates a payment refund or job',async()=>{
  const s=await fixture('UNKNOWN_THEN_SUCCESS');const p=await E.createRefund(maker,{source_id:s.source,context_id:s.context,amount_minor:'1000',reason:'mock consumer refund',request_key:id()});await E.approveReverse(checker,{order_id:p.orders[0].id,approve:true});await work();assert.equal((await E.getPlan(maker,{plan_id:p.id})).orders[0].status,'UNKNOWN');await work();assert.equal((await E.getPlan(maker,{plan_id:p.id})).status,'SUCCEEDED');await work();
  const [source]=await q('SELECT * FROM commerce_funding_sources WHERE id=?',[s.source]);assert.equal(source.returned_minor,'1000');assert.equal(source.reserved_minor,'0');
  assert.equal((await q("SELECT * FROM commerce_ledger_events WHERE context_id=? AND event_key LIKE 'execution:mock-refund:%'",[s.context])).length,1);
  for(const table of ['payment_orders','payment_refunds','payment_jobs','payment_events'])assert.equal(Number((await q('SELECT COUNT(*) n FROM '+table))[0].n),0);
 });
 await t.test('scoped worker leaves other queued plans untouched, including nonmock orders',async()=>{
  const first=await fixture(),second=await fixture(),a=await plan(first),b=await plan(second);
  assert.deepEqual(await E.runJobs({limit:10,order_ids:[]}),[]);
  now+=2000;await E.runJobs({limit:10,order_ids:a.orders.map(o=>o.id)});
  assert.equal((await E.getPlan(maker,{plan_id:a.id})).status,'SUCCEEDED');assert.equal((await E.getPlan(maker,{plan_id:b.id})).orders[0].status,'READY');
  await q("UPDATE commerce_execution_orders SET provider='REAL' WHERE id=?",[b.orders[0].id]);
  await work();assert.equal((await E.getPlan(maker,{plan_id:b.id})).orders[0].status,'READY');
  assert.equal(Number((await q('SELECT attempts FROM commerce_execution_jobs WHERE order_id=?',[b.orders[0].id]))[0].attempts),0);
  await q('UPDATE commerce_execution_orders SET provider=? WHERE id=?',[demo.PROVIDER,b.orders[0].id]);await work();assert.equal((await E.getPlan(maker,{plan_id:b.id})).status,'SUCCEEDED');
 });
 assert.equal(externalCalls,0);assert.equal((await E.verifyInvariants(maker)).ok,true);
});
