'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),mysql=require('mysql2/promise');
const P=require('../settlement/primitives.cjs'),booking=require('../settlement/booking.cjs');
const socket=process.env.SETTLEMENT_TEST_SOCKET;
test('booking commission admission preserves stored cents and rejects inconsistent snapshots',()=>{
 const order={id:1,order_no:'BKG-PURE',owner_vendor_id:8,checkin:'2026-10-01',checkout:'2026-10-02',price_total:'999.99',commission_rate:'12.34',commission_fee:'123.40'};
 assert.equal(booking.bookingSnapshot(order).commission_minor,'12340');
 assert.equal(booking.bookingSnapshot({...order,price_total:'1.00',commission_rate:'14.50',commission_fee:'0.14'}).commission_minor,'14','preserve the authoritative booking writer rounding, including its legacy floating-point edge');
 for(const change of [{commission_fee:'123.39'},{commission_rate:null},{commission_fee:'-1'},{checkout:'2026-02-30'},{price_total:'1e3'}])assert.throws(()=>booking.bookingSnapshot({...order,...change}));
});

test('booking recognition uses original payment guards, frozen fees and one shared unit',{skip:!socket,timeout:180000},async t=>{
 assert.match(socket,/^\/tmp\/sy-(?:settlement-[\w-]+|cashier-mysql)\/[^/]+\.sock$/);
 const database='booking_settlement_'+process.pid+'_'+crypto.randomBytes(4).toString('hex'),connection={socketPath:socket,user:'root',timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true};
 const admin=await mysql.createConnection(connection);await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
 const pool=mysql.createPool({...connection,database,connectionLimit:10});
 t.after(async()=>{await pool.end();await admin.query('DROP DATABASE `'+database+'`');await admin.end();});
 const q=async(sql,args=[])=>(await pool.execute(sql,args))[0];
 await pool.query(`CREATE TABLE booking_orders(id INT AUTO_INCREMENT PRIMARY KEY,order_no VARCHAR(32) UNIQUE,owner_vendor_id INT,user_id VARCHAR(64),city_id INT,project_id INT,unit_id INT,rooms INT,nights INT,checkin VARCHAR(10),checkout VARCHAR(10),price_total DECIMAL(10,2),commission_rate DECIMAL(5,2),commission_fee DECIMAL(10,2),status VARCHAR(16),pay_status VARCHAR(24),paid_payment_order_id BIGINT,refund_status VARCHAR(24),created_at VARCHAR(32)) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
 await require('../settlement/index.cjs').migrate(pool);
 let time=Date.parse('2026-10-02T00:00:00Z'),seq=0;const now=()=>time;
 const authorize=require('../settlement/access.cjs').createAuthorizer({pool}),system=require('../settlement/access.cjs').systemPrincipal;
 const actor=id=>({account:{id,status:'active',principal_type:'user'},roles:[{permissions:['*'],scope:{level:'all'}}]}),maker=actor('maker'),checker=actor('checker');
 const W=require('../settlement/workflow.cjs').createWorkflow({pool,authorize,now});
 const sourceAccount=P.id(),merchantAccount=P.id(),platformAccount=P.id();
 for(const [key,party,merchant]of [[sourceAccount,'platform','controlled-source'],[merchantAccount,'booking-merchant','stay-merchant'],[platformAccount,'platform','platform-merchant']])await q("INSERT INTO commerce_payment_accounts(id,party_id,provider,environment,merchant_no,contract_no,currency,status,capabilities,created_by) VALUES(?,?,'TEST','ISOLATED_TEST',?,'booking-contract','CNY','approved',?,'maker')",[key,party,merchant,JSON.stringify({receive:true,operations:['SPLIT','PAYOUT','RETURN'],evidence_ref:'ISOLATED-ONLY'})]);
 await q("INSERT INTO commerce_settlement_party_bindings(id,source_domain,source_entity_type,source_entity_id,party_id,status,created_by) VALUES(?,'booking','vendor','8','booking-merchant','approved','maker')",[P.id()]);
 const profile={contract_ref:'booking-contract',version:1,source_account_id:sourceAccount,merchant_account_id:merchantAccount,platform_account_id:platformAccount,contract_no:'booking-contract',funding_mode:'CONTROLLED_COLLECTION',contract_mapping_version:'test-split',funding_evidence_ref:'ISOLATED-ONLY',recognition_policy:{mode:'BOOKING_CHECKOUT_DELAY'},calculation:{mode:'PROPORTIONAL',commission_bps:500,channel_bps:2000,rounding:'FLOOR_BPS_V1'},collection:{mapping_version:'booking-collection',contract_no:'booking-contract',source_merchant_no:'controlled-source',provider:'TEST',environment:'ISOLATED_TEST'}};
 for(const mode of ['pay_center','offline'])await q("INSERT INTO commerce_settlement_profiles(id,party_id,biz_type,payment_mode,version,status,created_by,snapshot) VALUES(?,'booking-merchant','booking',?,1,'approved','maker',?)",[P.id(),mode,JSON.stringify(profile)]);
 const config={SETTLEMENT_ENABLED:'1',PAY_APP_CODE:'test',PAY_PROJECT_CODE:'test',PAY_SHARE_BIZ_CODE:'test',PAY_NOTIFY_URL:'https://example.test/notify',settlement_payment_contracts:{'booking-collection':{enabled:true,verified:true,evidence_ref:'ISOLATED-ONLY',provider:'TEST',environment:'ISOLATED_TEST',funding_modes:['CONTROLLED_COLLECTION'],request_template:{recAndShareInfo:{},contractInfo:{}},result:{contract_no:'contract',source_merchant_no:'merchant',control_status:'controlled',controlled_values:[true]}}}};
 const engine=()=>booking.createBookingSettlement({pool,workflow:W,authorize,config,now});
 const B=engine(),core=require('../payment/core.cjs').createPaymentCore({createConnection:()=>pool.getConnection(),config,now,payCenter:new Proxy({},{get:()=>()=>{throw Error('network forbidden');}})});
 async function fixture(change={}){
  const orderNo='BKG-ISOLATED-'+(++seq),o={order_no:orderNo,owner_vendor_id:8,user_id:'42',city_id:1,project_id:1,unit_id:1,rooms:1,nights:1,checkin:'2026-10-01',checkout:'2026-10-02',price_total:'100.00',commission_rate:'12.34',commission_fee:'12.34',status:'confirmed',pay_status:'paid',...change};
  const inserted=await q('INSERT INTO booking_orders(order_no,owner_vendor_id,user_id,city_id,project_id,unit_id,rooms,nights,checkin,checkout,price_total,commission_rate,commission_fee,status,pay_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[...['order_no','owner_vendor_id','user_id','city_id','project_id','unit_id','rooms','nights','checkin','checkout','price_total','commission_rate','commission_fee','status','pay_status'].map(k=>o[k]),P.sqlDate(now())]);o.id=inserted.insertId;
  let snapshot;await P.transaction(pool,async c=>{snapshot=await booking.captureBookingSnapshot(c,o,{config});await c.execute('UPDATE booking_orders SET payment_config_snapshot=? WHERE id=?',[snapshot?JSON.stringify(snapshot):null,o.id]);});
  if(o.pay_status==null)return {...o,snapshot};
  const payment=await q("INSERT INTO payment_orders(biz_type,biz_order_no,app_order_id,amount,amount_minor,payer_ucid,payer_user_type,merchant_no,share_biz_code,cashier_type,pay_status,callback_url,app_code,project_code,created_at,updated_at) VALUES('booking',?,?,?,?,'fixture-user','2','controlled-source','test','2','paid','https://example.test/notify','test','test',?,?)",[orderNo,'XD_20261002000000_'+String(seq).padStart(6,'0'),o.price_total,booking.bookingSnapshot(o).amount_minor,P.sqlDate(now()),P.sqlDate(now())]);
  await core.transaction(c=>core.registerOrder(c,{bizType:'booking',orderId:orderNo,accountId:'42',amountMinor:booking.bookingSnapshot(o).amount_minor,merchantNo:'controlled-source',payerUcid:'fixture-user',expiresAt:new Date(time+3600000),title:'isolated stay',snapshot}));
  await q("UPDATE payment_order_guards SET lifecycle='paid',paid_payment_id=? WHERE biz_type='booking' AND biz_order_no=?",[payment.insertId,orderNo]);
  await q('UPDATE booking_orders SET paid_payment_order_id=? WHERE id=?',[payment.insertId,o.id]);
  return {...o,snapshot,payment_id:String(payment.insertId)};
 }
 await t.test('captures opt-in once; offline only has report context and disabled/unbound stays legacy',async()=>{
  const offline=await fixture({pay_status:null});assert.equal(offline.snapshot.settlement_profile.calculation.fixed_commission_minor,'1234');
  const contexts=await q('SELECT * FROM commerce_settlement_business_contexts WHERE biz_order_no=?',[offline.order_no]);assert.equal(contexts[0].execution_scope,'EXTERNAL_RECORD_ONLY');
  assert.equal((await q('SELECT * FROM commerce_funding_sources')).length,0);
  const c=await pool.getConnection();try{assert.equal(await booking.captureBookingSnapshot(c,offline,{config:{SETTLEMENT_ENABLED:'0'},payment_mode:'pay_center'}),null);assert.equal(await booking.captureBookingSnapshot(c,{...offline,owner_vendor_id:999},{config,payment_mode:'offline'}),null);await assert.rejects(booking.captureBookingSnapshot(c,offline,{config:{SETTLEMENT_ENABLED:'1'},payment_mode:'pay_center'}),{code:'PAYMENT_COLLECTION_DISABLED'});}finally{c.release();}
  assert.equal((await B.runDue(system)).count,0);
 });
 let original;
 await t.test('concurrent recognition keeps frozen B and one journal/unit with no coupons or transfer',async()=>{
  const initialPolicy=await W.savePolicy(maker,{party_id:'booking-merchant',biz_type:'booking',payment_mode:'pay_center',priority:-1,mode:'AUTO',conditions:{booking_checkout_delay_days:3},request_key:'booking-initial-n3-create'});await W.publishPolicy(checker,{id:initialPolicy.id,request_key:'booking-initial-n3-publish'});
  original=await fixture();
  await q("UPDATE commerce_settlement_profiles SET snapshot=JSON_SET(snapshot,'$.calculation.commission_bps',9900) WHERE payment_mode='pay_center'");
  const results=await Promise.all([engine().runDue(system),engine().runDue(system),engine().runDue(system)]);assert.equal(results.flatMap(r=>r.rows).filter(x=>x.status==='RECOGNIZED').length,1);assert.ok(results.flatMap(r=>r.rows).every(x=>['RECOGNIZED','EXISTING'].includes(x.status)),JSON.stringify(results));
  const [unit]=await q('SELECT * FROM commerce_settlement_units');assert.deepEqual(P.parse(unit.calculation),{amount_minor:'10000',merchant_minor:'8766',commission_minor:'1234',promoter_minor:'0',retained_minor:'1234',unallocated_minor:'0'});
  const items=await q('SELECT * FROM commerce_settlement_items WHERE unit_id=?',[unit.id]);assert.equal(items.length,2);assert.ok(items.every(i=>i.status==='DRAFT'&&i.coupon_id===null&&i.redemption_id===null));assert.ok(items.every(i=>i.not_before_at==='2026-10-04 16:00:00'),'all created components show checkout + N before any authorization');assert.equal((await q('SELECT * FROM commerce_settlement_approval_instances')).length,0);assert.equal((await q('SELECT * FROM commerce_settlement_authorizations')).length,0);assert.equal((await q('SELECT * FROM commerce_execution_orders')).length,0);
  assert.equal((await q("SELECT * FROM commerce_ledger_events WHERE event_key LIKE 'recognition:%'")).length,1);assert.equal((await q('SELECT * FROM commerce_settlement_units')).length,1);assert.equal((await B.runDue(system)).count,0);
  assert.equal(P.parse(unit.evidence).source,'BOOKING_CHECKOUT_DATE');assert.equal((await q('SELECT received_minor FROM commerce_funding_sources'))[0].received_minor,'10000');
  const imbalanced=await q("SELECT group_no FROM commerce_ledger_entries GROUP BY group_no HAVING SUM(IF(side='debit',amount_minor,-amount_minor))<>0");assert.deepEqual(imbalanced,[]);
 });
 await t.test('future checkout, reservation-only, offline and historical orders create no units',async()=>{
  await fixture({checkin:'2026-10-02',checkout:'2026-10-03'});await fixture({status:'pending'});await fixture({pay_status:'unpaid'});await fixture({status:'cancelled'});
  const historical=await fixture();await q('UPDATE booking_orders SET payment_config_snapshot=NULL WHERE id=?',[historical.id]);
  assert.equal((await engine().runDue(system)).count,0);assert.equal((await q('SELECT * FROM commerce_settlement_units')).length,1);
 });
 await t.test('snapshot or accepted-payment mismatch and requested refunds block without side effects',async()=>{
  const changed=await fixture(),wrong=await fixture(),refunded=await fixture();
  await q("UPDATE booking_orders SET checkout='2026-10-01' WHERE id=?",[changed.id]);await q('UPDATE booking_orders SET paid_payment_order_id=paid_payment_order_id+999 WHERE id=?',[wrong.id]);
  await q("INSERT INTO payment_refunds(payment_order_id,biz_order_no,app_order_id,idempotency_key,refund_reason_type,trigger_source,refund_amount,amount_minor,payer_ucid,merchant_no,refund_status,created_at,updated_at) VALUES(?,?,?,'fixture-refund','USER','fixture',1,100,'fixture-user','controlled-source','refunding',?,?)",[refunded.payment_id,refunded.order_no,'RF_20261002000000_000001',P.sqlDate(now()),P.sqlDate(now())]);
  const out=await engine().runDue(system);assert.equal(out.count,3);assert.ok(out.rows.every(r=>r.status==='BLOCKED'));assert.ok(out.rows.some(r=>r.code==='booking_payment_mismatch'));assert.ok(out.rows.some(r=>r.code==='booking_refund_requires_review'));
  assert.equal((await q('SELECT * FROM commerce_funding_sources')).length,1);assert.equal((await q('SELECT * FROM commerce_settlement_units')).length,1);
  const e=engine(),paged=[];for(let n=0;n<3;n++)paged.push(...(await e.runDue(system,{limit:1})).rows);assert.equal(new Set(paged.map(x=>x.id)).size,3,'a blocked first order must not starve later pages');
 });
 await t.test('execution independently rejects a not-yet-due N authorization before reserving money',async()=>{
  const [i]=await q("SELECT * FROM commerce_settlement_items WHERE line_kind='merchant'");
  const policy=await W.savePolicy(maker,{party_id:'booking-merchant',biz_type:'booking',payment_mode:'pay_center',mode:'AUTO',conditions:{booking_checkout_delay_days:2},request_key:'booking-rule-create'});await W.publishPolicy(checker,{id:policy.id,request_key:'booking-rule-publish'});
  time=Date.parse('2026-10-03T16:00:00Z');const fresh=await W.detail(maker,{id:i.id});assert.equal((await W.authorizeItem(maker,{id:i.id,expected_revision:fresh.revision,request_key:'booking-at-due-authorize'})).status,'AUTHORIZED');
  time=Date.parse('2026-10-03T15:59:59Z');const E=require('../settlement/execution.cjs').createExecution({pool,authorize,now,config:{execution_enabled:true},payCenter:{splitApply(){throw Error('network forbidden');}}});
  await assert.rejects(E.createPlan(maker,{item_ids:[String(i.id)],request_key:'booking-before-due-execute'}),{code:'booking_settlement_not_due'});
  assert.equal((await q('SELECT reserved_minor FROM commerce_funding_sources'))[0].reserved_minor,'0');assert.equal((await q('SELECT * FROM commerce_execution_orders')).length,0);
 });
 await t.test('a due booking survives MySQL JSON key reordering and executes once through a local test port',async()=>{
  time=Date.parse('2026-10-03T16:00:00Z');
  const [i]=await q("SELECT * FROM commerce_settlement_items WHERE line_kind='merchant'"),[a]=await q('SELECT snapshot FROM commerce_settlement_authorizations WHERE id=?',[i.authorization_id]),[context]=await q('SELECT * FROM commerce_settlement_business_contexts WHERE id=?',[i.context_id]);
  context.snapshot=P.parse(context.snapshot);const policy=await W.selectPolicy(pool,context,i),timing=require('../settlement/booking-policy.cjs').dueAt(context,policy),stored=P.parse(a.snapshot).booking_timing;
  assert.notEqual(JSON.stringify(stored),JSON.stringify(timing),'fixture must exercise MySQL JSON object key normalization');assert.equal(P.hash(stored),P.hash(timing));
  const ref=value=>({$ref:value}),body={requestNo:ref('request_no'),contract:ref('contract_no'),source:ref('source_merchant_no'),currency:ref('currency'),effects:{$each:'effects',template:{id:ref('line.id'),amount:ref('line.amount_minor'),payee:ref('line.payee_merchant_no'),currency:ref('currency')}}};
  const operation={amount_unit:'minor',submit:{method:'splitApply',template:body},query:{method:'querySplitResult',template:{requestNo:ref('request_no')}},result:{request_no:'requestNo',contract_no:'contract',source_merchant_no:'source',currency:'currency',lines:'effects',line:{id:'id',amount:'amount',payee_merchant_no:'payee',currency:'currency',status:'status',provider_line_id:'receipt'},statuses:{ok:'SUCCEEDED'}}};
  let submits=0;const transport={async splitApply(request){submits++;return {...request,effects:request.effects.map(effect=>({...effect,status:'ok',receipt:'ISOLATED-BOOKING-'+effect.id}))};},async querySplitResult(){throw Error('no query expected for this local synchronous fixture');}};
  const E=require('../settlement/execution.cjs').createExecution({pool,authorize,now,config:{execution_enabled:true,provider_contracts:{'test-split':{enabled:true,verified:true,evidence_ref:'ISOLATED-ONLY',provider:'TEST',environment:'ISOLATED_TEST',operations:{SPLIT:operation}}}},payCenter:transport});
  const input={item_ids:[String(i.id)],request_key:'booking-due-execute'},plan=await E.createPlan(maker,input);assert.equal((await q('SELECT reserved_minor FROM commerce_funding_sources WHERE id=?',[i.source_id]))[0].reserved_minor,'8766');
  await E.runJobs({limit:10});await E.runJobs({limit:10});const complete=await E.getPlan(maker,{plan_id:plan.id});assert.equal(complete.status,'SUCCEEDED');assert.equal(submits,1);assert.equal((await E.createPlan(maker,input)).id,plan.id);
  const [paid]=await q('SELECT discharged_minor,reserved_minor FROM commerce_settlement_items WHERE id=?',[i.id]),[source]=await q('SELECT consumed_minor,reserved_minor FROM commerce_funding_sources WHERE id=?',[i.source_id]);assert.equal(paid.discharged_minor,'8766');assert.equal(paid.reserved_minor,'0');assert.equal(source.consumed_minor,'8766');assert.equal(source.reserved_minor,'0');
  assert.deepEqual(await q("SELECT group_no FROM commerce_ledger_entries GROUP BY group_no HAVING SUM(IF(side='debit',amount_minor,-amount_minor))<>0"),[]);
 });
});
