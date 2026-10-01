'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),mysql=require('mysql2/promise');
const P=require('../settlement/primitives.cjs'),{createWorkflow}=require('../settlement/workflow.cjs'),{createAuthorizer}=require('../settlement/access.cjs');
const uuid=()=>crypto.randomUUID(),socket=process.env.SETTLEMENT_TEST_SOCKET;
test('approved arithmetic uses exact minor units and explicit fixed cost',()=>{
 assert.deepEqual(P.calculate({amount_minor:'999999999999999999',mode:'PROPORTIONAL',commission_bps:1000,channel_bps:5000,rounding:'FLOOR_BPS_V1',promoter_party_id:'x'}),{amount_minor:'999999999999999999',merchant_minor:'900000000000000000',commission_minor:'99999999999999999',promoter_minor:'49999999999999999',retained_minor:'50000000000000000',unallocated_minor:'0'});
 assert.equal(P.calculate({amount_minor:'10000',mode:'FIXED_COST',fixed_cost_minor:'3000',fixed_commission_minor:'2000',channel_bps:5000,promoter_party_id:'x',rounding:'FLOOR_BPS_V1'}).unallocated_minor,'5000');
 assert.throws(()=>P.calculate({amount_minor:'100',mode:'FIXED_COST',fixed_cost_minor:'101',fixed_commission_minor:'1',rounding:'FLOOR_BPS_V1'}));
 assert.throws(()=>P.minor(9007199254740992));assert.equal(P.sqlDate('2026-10-02 00:00:00'),'2026-10-02 00:00:00');
});
test('unified workflow uses isolated MySQL and actual shared migrations',{skip:!socket,timeout:180000},async t=>{
 assert.match(socket,/^\/tmp\/sy-(?:settlement-[\w-]+|cashier-mysql)\/[^/]+\.sock$/);
 const database='settlement_workflow_'+process.pid+'_'+crypto.randomBytes(4).toString('hex'),connection={socketPath:socket,user:'root',timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true};
 const admin=await mysql.createConnection(connection);await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');const pool=mysql.createPool({...connection,database,connectionLimit:10});
 t.after(async()=>{await pool.end();await admin.query('DROP DATABASE `'+database+'`');await admin.end();});
 await require('../settlement/index.cjs').migrate(pool);await require('../settlement/index.cjs').migrate(pool);
 const q=async(sql,args=[])=>(await pool.execute(sql,args))[0];
 const authorize=createAuthorizer({pool}),w=createWorkflow({pool,authorize}),C=require('../settlement/configuration.cjs').createConfiguration({pool,workflow:w,authorize});
 const principal=(id,permissions=['*'],scope={level:'all'})=>({account:{id,status:'active',principal_type:'user'},roles:[{permissions,scope}]});
 const maker=principal('maker'),reviewer=principal('reviewer'),reviewer2=principal('reviewer2');let seq=0;
 const key=()=>({request_key:'workflow-test-'+(++seq)});
 async function makeFixture({party='merchant-'+uuid(),mode='AUTO',conditions={},nodes=[],biz='commerce',kind='merchant',amount='10000'}={}){
  const sourceAccount=uuid(),platformAccount=uuid(),context=uuid(),source=uuid(),unit=uuid();
  for(const [a,p]of [[sourceAccount,party],[platformAccount,'platform']])await q("INSERT INTO commerce_payment_accounts(id,party_id,provider,environment,merchant_no,contract_no,currency,status,capabilities,created_by,reviewed_by) VALUES(?,?,'TEST','ISOLATED_TEST',?,'contract','CNY','approved',?,'maker','reviewer')",[a,p,a,JSON.stringify({operations:['SPLIT','RELEASE','PAYOUT','RETURN'],receive:true,evidence_ref:'TEST'})]);
  const profile={version:1,profile_id:uuid(),party_id:party,source_account_id:sourceAccount,merchant_account_id:sourceAccount,platform_account_id:platformAccount,contract_no:'contract',funding_mode:'CONTROLLED_COLLECTION',contract_mapping_version:'test',funding_evidence_ref:'TEST',calculation:{mode:'PROPORTIONAL',commission_bps:2000,channel_bps:5000,rounding:'FLOOR_BPS_V1'},recognition_policy:{mode:'CUSTOMER_ACCEPTANCE'}};
  await q("INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot) VALUES(?,?,'fixture',?,'pay_center','INTERNAL_FUNDED',?,'CNY',?)",[context,biz,uuid(),party,JSON.stringify({settlement_profile:profile})]);
  await q("INSERT INTO commerce_funding_sources(id,context_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,'PAYMENT','TEST','ISOLATED_TEST','CNY',?,'contract',100000,'AVAILABLE','{}')",[source,context,sourceAccount]);
  await q("INSERT INTO commerce_settlement_units(id,context_id,unit_key,recognition_id,status,basis_minor,source_id,rule_snapshot,calculation,evidence,confirmed_at) VALUES(?,?,?,?,'CONFIRMED',10000,?,'{}','{}','{}',UTC_TIMESTAMP())",[unit,context,unit,unit,source]);
  const result=await q("INSERT INTO commerce_settlement_items(context_id,unit_id,component_key,line_kind,beneficiary_party_id,account_id,source_id,rule_ref,basis_minor,payable_minor,planned_minor,original_payable_minor,status) VALUES(?,?,?,?,?,?,?,'test-rule',10000,?,?,?,'DRAFT')",[context,unit,kind,kind,party,sourceAccount,source,amount,amount,amount]);
  const policy=await w.savePolicy(maker,{party_id:party,biz_type:biz,payment_mode:'pay_center',mode,conditions,nodes,...key()});await w.publishPolicy(reviewer,{id:policy.id,...key()});
  return {item:String(result.insertId),context,source,unit,sourceAccount,platformAccount,party,profile,policy:policy.id};
 }
 await t.test('scope follows the role granting each permission, including on idempotent replay',async()=>{
  const f=await makeFixture(),req={id:f.item,expected_revision:1,...key()},limited=principal('limited',['settlement.fund.write'],{level:'all',party_ids:[f.party],biz_types:['commerce'],payment_modes:['pay_center']});
  limited.roles.push({permissions:['settlement.fund.read'],scope:{level:'all'}});
  const out=await w.authorizeItem(limited,req);assert.equal(out.status,'AUTHORIZED');assert.deepEqual(await w.authorizeItem(limited,req),out);
  limited.roles[0].scope.party_ids=['wrong-party'];await assert.rejects(w.authorizeItem(limited,req),{status:403});
  const snapshot=P.parse((await q('SELECT snapshot FROM commerce_settlement_authorizations WHERE id=?',[out.authorization_id]))[0].snapshot);assert.equal(snapshot.account_version,1);
 });
 await t.test('maker checker and sequential ALL/ANY approval',async()=>{
  const f=await makeFixture({mode:'REVIEW',nodes:[{name:'财务会签',mode:'ALL',approver_ids:['reviewer','reviewer2']},{name:'终审',mode:'ANY',approver_ids:['reviewer2']}]});
  const a=await w.authorizeItem(maker,{id:f.item,expected_revision:1,...key()});assert.equal(a.status,'IN_REVIEW');
  await assert.rejects(w.approve(maker,{id:a.approval_id,revision:1,action:'approve',note:'同意',...key()}),{status:403});
  assert.equal((await w.approve(reviewer,{id:a.approval_id,revision:1,action:'approve',note:'确认',...key()})).node,0);
  assert.equal((await w.approve(reviewer2,{id:a.approval_id,revision:1,action:'approve',note:'确认',...key()})).node,1);
  assert.equal((await w.approve(reviewer2,{id:a.approval_id,revision:1,action:'approve',note:'批准',...key()})).status,'AUTHORIZED');
 });
 await t.test('adjustment preserves paid history, invalidates stale approval and returns visible balances',async()=>{
  const f=await makeFixture(),old=await w.authorizeItem(maker,{id:f.item,expected_revision:1,...key()});
  await q('UPDATE commerce_settlement_items SET discharged_minor=3000,planned_minor=7000 WHERE id=?',[f.item]);
  const input={id:f.item,expected_revision:1,kind:'ENTITLEMENT_ADJUSTMENT',planned_minor:'6000',delta_minor:'-1000',reason:'合同差额调整'};
  const preview=await w.previewAdjustment(maker,input);assert.equal(preview.after.remaining_minor,'6000');assert.equal(preview.after.payable_minor,'9000');
  const a=await w.adjust(maker,{...input,...key()});assert.equal(a.revision,2);assert.equal((await q('SELECT status FROM commerce_settlement_authorizations WHERE id=?',[old.authorization_id]))[0].status,'REVOKED');
  await assert.rejects(w.approve(reviewer,{id:a.approval_id,revision:1,action:'approve',note:'确认',...key()}),{status:409});
  await w.approve(reviewer,{id:a.approval_id,revision:2,action:'approve',note:'确认',...key()});const item=await w.detail(maker,{id:f.item});assert.equal(item.discharged_minor,'3000');assert.equal(item.remaining_minor,'6000');
  await assert.rejects(w.previewAdjustment(maker,{...input,expected_revision:2,delta_minor:'-7000'}),{status:409});
  await q('UPDATE commerce_settlement_items SET reserved_minor=100 WHERE id=?',[f.item]);await assert.rejects(w.adjust(maker,{...input,expected_revision:2,...key()}),{status:409});
 });
 await t.test('parallel AUTO grants include earlier unspent authorizations in cumulative cap',async()=>{
  const f=await makeFixture({amount:'6000',conditions:{cumulative_minor:'10000'}}),second=await q("INSERT INTO commerce_settlement_items(context_id,unit_id,component_key,line_kind,beneficiary_party_id,account_id,source_id,rule_ref,basis_minor,payable_minor,planned_minor,original_payable_minor,status) VALUES(?,?,'second','merchant',?,?,?,'rule',6000,6000,6000,6000,'DRAFT')",[f.context,f.unit,f.party,f.sourceAccount,f.source]);
  const result=await Promise.all([f.item,String(second.insertId)].map(id=>w.authorizeItem(maker,{id,expected_revision:1,...key()})));assert.deepEqual(result.map(r=>r.status).sort(),['AUTHORIZED','IN_REVIEW']);
 });
 await t.test('positive amendments use approved own funds and cannot promise the same cash twice',async()=>{
  const f=await makeFixture(),source=uuid();await q("INSERT INTO commerce_funding_sources(id,context_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,'supplement','TEST','ISOLATED_TEST','CNY',?,'contract',1000,'AVAILABLE','{}')",[source,f.context,f.platformAccount]);
  const input={id:f.item,expected_revision:1,kind:'ENTITLEMENT_ADJUSTMENT',delta_minor:'1000',planned_minor:'10000',source_id:source,reason:'平台确认补差'};
  await assert.rejects(w.previewAdjustment(principal('merchant-operator',['settlement.fund.adjust'],{level:'all',party_ids:[f.party]}),input),{status:403});
  const change=await w.adjust(maker,{...input,...key()});await w.approve(reviewer,{id:change.approval_id,revision:change.revision,action:'approve',note:'确认自有资金',...key()});
  const [supplement]=await q('SELECT * FROM commerce_settlement_items WHERE source_id=?',[source]);assert.equal(supplement.payable_minor,'1000');assert.equal(supplement.component_key,'supplement:'+change.adjustment_id);
  await assert.rejects(w.previewAdjustment(maker,{...input,expected_revision:2,delta_minor:'1'}),{status:409});
  assert.equal((await w.detail(maker,{id:f.item})).payable_minor,'10000','original payment obligation is not enlarged');
 });
 await t.test('B is a cash movement and cannot be amended as a fictitious platform payable',async()=>{
  const f=await makeFixture({kind:'platform_transfer',amount:'2000'});await assert.rejects(w.previewAdjustment(maker,{id:f.item,expected_revision:1,kind:'ENTITLEMENT_ADJUSTMENT',planned_minor:'1000',delta_minor:'-1000',reason:'尝试改变佣金合同'}),{code:'platform_transfer_requires_business_revision'});
  assert.equal((await w.previewAdjustment(maker,{id:f.item,expected_revision:1,kind:'PAYMENT_ARRANGEMENT',planned_minor:'1000',reason:'佣金分次到账安排'})).after.planned_minor,'1000');
 });
 await t.test('Q waits for B receipt; retry binds an actual commission lot before authorization',async()=>{
  const f=await makeFixture({kind:'promoter',amount:'1000'}),input={id:f.item,expected_revision:1,...key()};await assert.rejects(w.authorizeItem(maker,input),{code:'commission_funding_pending'});
  const child=uuid();await q("INSERT INTO commerce_funding_sources(id,context_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,'PLATFORM_COMMISSION','TEST','ISOLATED_TEST','CNY',?,'contract',2000,'AVAILABLE','{}')",[child,f.context,f.platformAccount]);
  await q("INSERT INTO commerce_commission_funding_lots(id,source_execution_line_id,source_id,context_id,unit_id,received_minor,status,created_at) VALUES(?,?,?,?,?,2000,'AVAILABLE',UTC_TIMESTAMP())",[uuid(),uuid(),child,f.context,f.unit]);
  const out=await w.authorizeItem(maker,input);assert.equal(out.revision,2);const frozen=P.parse((await q('SELECT snapshot FROM commerce_settlement_authorizations WHERE id=?',[out.authorization_id]))[0].snapshot);assert.equal(frozen.source_id,child);
 });
 await t.test('ledger deduplicates immutable events and reports balance errors',async()=>{
  const f=await makeFixture(),event={event_key:uuid(),context_id:f.context,lines:[{side:'debit',account:'a',amount_minor:'10'},{side:'credit',account:'b',amount_minor:'10'}]};
  const first=await P.transaction(pool,c=>P.postLedger(c,event));assert.equal(await P.transaction(pool,c=>P.postLedger(c,event)),first);await assert.rejects(P.transaction(pool,c=>P.postLedger(c,{...event,memo:'changed'})),{status:409});
  assert.equal(Number((await q('SELECT COUNT(*) n FROM commerce_ledger_entries WHERE event_id=?',[first]))[0].n),2);
 });
 await t.test('disabling a policy revokes unspent authorization and supersedes pending review',async()=>{
  const f=await makeFixture(),a=await w.authorizeItem(maker,{id:f.item,expected_revision:1,...key()});
  await w.pausePolicy(maker,{id:f.policy,...key()});assert.equal((await q('SELECT status FROM commerce_settlement_authorizations WHERE id=?',[a.authorization_id]))[0].status,'REVOKED');
  const i=await w.detail(maker,{id:f.item});assert.equal(i.status,'DRAFT');assert.equal(Number(i.revision),2);
  const r=await makeFixture({mode:'REVIEW',nodes:[{name:'复核',mode:'ANY',approver_ids:[]}]}),task=await w.authorizeItem(maker,{id:r.item,expected_revision:1,...key()});await w.pausePolicy(maker,{id:r.policy,...key()});
  await assert.rejects(w.approve(reviewer,{id:task.approval_id,revision:1,action:'approve',note:'确认',...key()}),{status:409});
 });
 await t.test('configuration maker checker and frozen order profile',async()=>{
  const account=await C.create(maker,{kind:'accounts',party_id:'new-party',provider:'TEST',environment:'ISOLATED_TEST',merchant_no:'new-merchant',contract_no:'contract',currency:'CNY',capabilities:{operations:['SPLIT']},...key()});
  await assert.rejects(C.approve(maker,{kind:'accounts',id:account.id,...key()}),{status:403});await C.approve(reviewer,{kind:'accounts',id:account.id,...key()});
  const binding=await C.create(maker,{kind:'bindings',party_id:'new-party',source_domain:'jiazheng',source_entity_type:'vendor',source_entity_id:'7',...key()});await C.approve(reviewer,{kind:'bindings',id:binding.id,...key()});
  const restricted=principal('merchant-admin',['settlement.policy.write','settlement.policy.review'],{level:'all',party_ids:['new-party']});
  await assert.rejects(C.create(restricted,{kind:'bindings',party_id:'new-party',source_domain:'platform',source_entity_type:'entity',source_entity_id:'unauthorized-platform',...key()}),{status:403});
  const platformBinding=await C.create(maker,{kind:'bindings',party_id:'new-party',source_domain:'platform',source_entity_type:'entity',source_entity_id:'test-platform',...key()});await assert.rejects(C.approve(restricted,{kind:'bindings',id:platformBinding.id,...key()}),{status:403});await C.approve(reviewer,{kind:'bindings',id:platformBinding.id,...key()});
  const profile=await C.create(maker,{kind:'profiles',party_id:'new-party',biz_type:'jiazheng',payment_mode:'pay_center',snapshot:{contract_ref:'contract',calculation:{mode:'PROPORTIONAL',commission_bps:1000,rounding:'FLOOR_BPS_V1'},recognition_policy:{mode:'CUSTOMER_ACCEPTANCE'},funding_mode:'CONTROLLED_COLLECTION',source_account_id:account.id,merchant_account_id:account.id,platform_account_id:account.id,funding_evidence_ref:'TEST',contract_mapping_version:'TEST',collection:{mapping_version:'collection-test',contract_no:'contract',source_merchant_no:'new-merchant',provider:'TEST',environment:'ISOLATED_TEST'}},...key()});
  await C.approve(reviewer,{kind:'profiles',id:profile.id,...key()});assert.equal((await C.forOrder(pool,{biz_type:'jiazheng',entity_id:'7',payment_mode:'pay_center'})).profile_id,profile.id);
 });
 await t.test('paid life order is recognized only once on customer acceptance',async()=>{
  await q('CREATE TABLE IF NOT EXISTS jz_orders(id VARCHAR(100) PRIMARY KEY,account_id VARCHAR(64),payment_mode VARCHAR(24),status VARCHAR(24),pay_status VARCHAR(24),payment_config_snapshot JSON,fee BIGINT,vendor_id INT,city_id INT)');
  const f=await makeFixture({biz:'jiazheng'}),orderId='WO-'+crypto.randomBytes(14).toString('hex'),customer=principal('customer',[]),core=require('../payment/core.cjs').createPaymentCore({createConnection:()=>pool.getConnection(),config:{PAY_APP_CODE:'test',PAY_PROJECT_CODE:'test',PAY_SHARE_BIZ_CODE:'test',PAY_NOTIFY_URL:'https://example.test/notify'}});
  await core.transaction(c=>core.registerOrder(c,{bizType:'jiazheng',orderId,accountId:'customer',amountMinor:10000,merchantNo:f.sourceAccount,payerUcid:'test-customer',expiresAt:new Date(Date.now()+3600000),title:'验收测试',snapshot:{settlement_profile:f.profile}}));
  // The existing source is already the accepted payment fixture; the business
  // confirmation consumes it without contacting a provider.
  await q('UPDATE commerce_settlement_business_contexts SET biz_order_no=?,source_order_system=\'jz_orders\' WHERE id=?',[orderId,f.context]);
  const b=require('../settlement/business.cjs');
  await q("INSERT INTO jz_orders VALUES(?,'customer','pay_center','done','paid',?,10000,7,1)",[orderId,JSON.stringify({settlement_profile:f.profile})]);
  const business=b.createBusiness({pool,workflow:w,authorize,config:{}});
  await assert.rejects(business.acceptService(principal('stranger',[]),{id:orderId,...key()}),{status:404});
  await assert.rejects(business.acceptService(customer,{id:orderId,...key()}),{status:409});
  assert.equal(Number((await q('SELECT COUNT(*) n FROM commerce_settlement_fulfillment WHERE order_no=?',[orderId]))[0].n),0,'no accepted payment must never produce recognition');
  const intent=await core.createIntent({bizType:'jiazheng',orderId,account:{id:'customer',idp_type:'beike',idp_subject:'test-customer'},cashierType:'2',requestKey:'life-accepted-fixture'});
  await q("UPDATE payment_orders SET pay_status='paid',pay_no='TEST-PROVIDER-RECEIPT' WHERE id=?",[intent.payment_id]);await q("UPDATE payment_order_guards SET paid_payment_id=? WHERE biz_type='jiazheng' AND biz_order_no=?",[intent.payment_id,orderId]);
  const accepted=await business.acceptService(customer,{id:orderId,...key()}),again=await business.acceptService(customer,{id:orderId,...key()});assert.equal(accepted.confirmation_id,again.confirmation_id);
  assert.equal(Number((await q('SELECT COUNT(*) n FROM commerce_settlement_units WHERE context_id=? AND unit_key=?',[f.context,orderId]))[0].n),1);
  const lines=await q('SELECT line_kind,payable_minor FROM commerce_settlement_items WHERE unit_id=? ORDER BY line_kind',[accepted.settlement_unit_id]);assert.deepEqual(lines.map(x=>[x.line_kind,x.payable_minor]),[['merchant','8000'],['platform_transfer','2000']]);
  const [source]=await q('SELECT * FROM commerce_funding_sources WHERE payment_id=?',[String(intent.payment_id)]);assert.equal(source.received_minor,'10000');
  assert.equal(Number((await q("SELECT COUNT(*) n FROM commerce_ledger_entries WHERE account=? AND side='debit'",['settlement_cash:'+source.id]))[0].n),1);
 });
});
