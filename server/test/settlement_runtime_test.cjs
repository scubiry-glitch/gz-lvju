'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http'),mysql=require('mysql2/promise');
const {migrate,createSettlement}=require('../settlement/index.cjs');
const {createHandler}=require('../settlement/http.cjs');
const P=require('../settlement/primitives.cjs');
const socket=process.env.SETTLEMENT_TEST_SOCKET;

test('real settlement runtime and HTTP work on Date-returning isolated MySQL',{skip:!socket,timeout:180000},async t=>{
  assert.match(socket,/^\/tmp\/sy-settlement-[\w-]+\/[^/]+\.sock$/);
  const database='settlement_runtime_'+process.pid+'_'+crypto.randomBytes(4).toString('hex');
  // Match production's Date objects. Other suites intentionally use dateStrings.
  const options={socketPath:socket,user:'root',timezone:'Z',supportBigNumbers:true,bigNumberStrings:true};
  const admin=await mysql.createConnection(options);await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');
  const pool=mysql.createPool({...options,database,connectionLimit:10}),q=async(sql,args=[])=>(await pool.execute(sql,args))[0];let server;
  t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await pool.end();await admin.query('DROP DATABASE `'+database+'`');await admin.end();});
  await migrate(pool);
  await q('CREATE TABLE gr_orders(id INT PRIMARY KEY,order_ref VARCHAR(64),vendor_id INT,biz_type VARCHAR(24),payment_mode VARCHAR(24),status VARCHAR(24),fee BIGINT NULL,vendor_oid VARCHAR(64) NULL,sku VARCHAR(64),paid_at VARCHAR(32) NULL,completed_at VARCHAR(32) NULL,created_at VARCHAR(32))');
  await q('CREATE TABLE jz_orders(id VARCHAR(32) PRIMARY KEY,account_id VARCHAR(64),payment_mode VARCHAR(24),pay_status VARCHAR(24),status VARCHAR(24),payment_config_snapshot JSON,fee BIGINT,vendor_id INT,city_id INT,refund_status VARCHAR(32) NULL)');
  const principal=(id,permissions=['*'],scope={level:'all'})=>({account:{id,status:'active',principal_type:'user'},roles:[{permissions,scope}]});
  const principals=new Map([['101',principal('101')],['102',principal('102')],['103',principal('103',['settlement.statement.read','settlement.statement.export'],{level:'all',party_ids:['unrelated']})],['104',principal('104',[])]]);
  const auth={bearerToken:req=>(req.headers.authorization||'').replace(/^Bearer /,''),verifySessionToken:async token=>principals.get(token),getAccountWithRoles:async id=>principals.get(String(id))};
  let clock=Date.now();const service=createSettlement({pool,auth,config:{SETTLEMENT_ENABLED:'0',SETTLEMENT_WORKER_ENABLED:'0'},now:()=>clock});
  server=http.createServer(createHandler({service,auth}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;let seq=0;
  async function request(path,actor='101',body,key){const response=await fetch(origin+'/api/settlement/v1'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+actor,...(body?{'Content-Type':'application/json','Idempotency-Key':key||'runtime-request-'+(++seq)}:{})},body:body?JSON.stringify(body):undefined});const content=await response.text();return {status:response.status,body:(response.headers.get('content-type')||'').includes('application/json')?JSON.parse(content):content};}
  const successful=async(...args)=>{const r=await request(...args);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
  async function provision(kind,body){const row=await successful('/admin/configuration/'+kind,'101',body);await successful('/admin/configuration/'+kind+'/'+row.id+'/approve','102',{});return row.id;}
  let externalStatement,contextId;

  await t.test('runtime normalizes an existing pooled session back to UTC before SQL',async()=>{
    await q("SET time_zone='+08:00'");const [current]=await q('SELECT @@session.time_zone tz');assert.equal(current.tz,'+00:00');
  });

  await t.test('external automatic sync and monthly publication require no institution execution mapping',async()=>{
    await provision('bindings',{party_id:'runtime-merchant',source_domain:'jiazheng',source_entity_type:'vendor',source_entity_id:'7'});
    await q("INSERT INTO gr_orders VALUES(1,'RUNTIME-EXTERNAL',7,'jiazheng','wechat_mini','pending',NULL,NULL,'cleaning',NULL,NULL,'2026-09-01 10:00:00'),(2,'RUNTIME-INTERNAL',7,'jiazheng','pay_center','paid',500,NULL,'cleaning',NULL,NULL,'2026-09-01 10:00:00')");
    const out=await service.maintenance();assert.deepEqual(out.errors,[]);
    const contexts=await q('SELECT * FROM commerce_settlement_business_contexts');assert.equal(contexts.length,1);contextId=contexts[0].id;assert.equal(contexts[0].execution_scope,'EXTERNAL_RECORD_ONLY');
    const policies=await q('SELECT * FROM commerce_payee_statement_policies');assert.equal(policies.length,1);assert.ok(policies[0].next_run_at instanceof Date);
    const statements=await q('SELECT * FROM commerce_payee_statements');assert.equal(statements.length,1,'Date-returning monthly scheduler actually publishes');externalStatement=statements[0].id;
    assert.equal((await q('SELECT * FROM commerce_funding_sources')).length,0);
    const list=await successful('/me/settlement-statements?party_id=runtime-merchant&biz_type=jiazheng&payment_mode=wechat_mini');assert.equal(list.rows.length,1);
    assert.equal((await request('/me/settlement-statements/'+externalStatement,'103')).status,403);
  });
  await t.test('HTTP write replay and actual worker export revalidate current identity',async()=>{
    const body={reason:'完整性证据尚需补齐',evidence_ref:'runtime-proof'},key='runtime-dispute-once';
    const first=await successful('/me/settlement-statements/'+externalStatement+'/disputes','101',body,key),again=await successful('/me/settlement-statements/'+externalStatement+'/disputes','101',body,key);assert.equal(first.id,again.id);
    assert.equal((await request('/me/settlement-statements/'+externalStatement+'/disputes','101',{...body,reason:'changed'},key)).status,409);
    const job=await successful('/me/settlement-statements/'+externalStatement+'/exports','101',{format:'csv'});
    assert.deepEqual((await service.maintenance()).errors,[]);assert.equal((await successful('/me/statement-exports/'+job.id)).status,'READY');
    const file=await request('/me/statement-exports/'+job.id+'/download');assert.equal(file.status,200);assert.match(file.body,/账单号/);
    principals.get('101').roles=[];assert.equal((await request('/me/statement-exports/'+job.id+'/download')).status,403);assert.equal((await request('/me/settlement-statements/'+externalStatement+'/disputes','101',body,key)).status,403);principals.get('101').roles=[{permissions:['*'],scope:{level:'all'}}];
  });
  await t.test('approved external contract, maker checker and both debt-party policies integrate through HTTP',async()=>{
    const profile=await provision('profiles',{party_id:'runtime-merchant',biz_type:'jiazheng',payment_mode:'wechat_mini',snapshot:{contract_ref:'runtime-contract',recognition_policy:{mode:'CUSTOMER_ACCEPTANCE'},calculation:{mode:'PROPORTIONAL',commission_bps:1000,rounding:'HALF_UP_BPS_V1'}}});
    const evidence={party_id:'runtime-merchant',context_id:contextId,channel:'wechat_mini',environment:'external',merchant_account:'7',event_kind:'PAYMENT',transaction_id:'RUNTIME-TX',amount_minor:'1005',currency:'CNY',occurred_at:new Date(clock-1000).toISOString(),source_type:'PROVIDER_STATEMENT',evidence_ref:'runtime-bank-proof'};
    const payment=await successful('/admin/external-evidence','101',evidence);await successful('/admin/external-evidence/'+payment.evidence_id+'/reviews','102',{decision:'verify',note:'独立核验原机构凭证'});
    const fulfillment=await successful('/admin/external-evidence','101',{...evidence,event_kind:'FULFILLMENT',transaction_id:null,amount_minor:null,evidence_ref:'runtime-acceptance'});await successful('/admin/external-evidence/'+fulfillment.evidence_id+'/reviews','102',{decision:'verify',note:'独立核验履约签收'});
    const accrued=await successful('/admin/external-accruals','101',{party_id:'runtime-merchant',context_id:contextId,profile_id:profile,currency:'CNY',amount_minor:'101',creditor_party_id:'runtime-platform',debtor_party_id:'runtime-merchant',evidence_event_id:payment.event_id,fulfillment_event_id:fulfillment.event_id,evidence_ref:'signed-runtime-contract',reason:'HALF_UP基点计算1005分百分之十'});
    assert.equal((await request('/admin/external-accruals/'+accrued.id+'/reviews','101',{decision:'approve',note:'禁止自审'})).status,403);
    await successful('/admin/external-accruals/'+accrued.id+'/reviews','102',{decision:'approve',note:'复核合同和应计'});
    clock+=61000;assert.deepEqual((await service.maintenance()).errors,[]);
    assert.equal((await q("SELECT * FROM commerce_payee_statement_policies WHERE party_id='runtime-platform'")).length,1);
    assert.ok((await successful('/me')).parties.some(p=>p.id==='runtime-platform'),'a pure external creditor is discoverable from its automatic statement policy');
    assert.equal((await q('SELECT * FROM commerce_funding_sources')).length,0);
  });
  await t.test('paid life-service acceptance creates exact obligations once and adjustments flow to a statement',async()=>{
    const sourceAccount=await provision('accounts',{party_id:'runtime-internal',provider:'TEST',environment:'ISOLATED_TEST',merchant_no:'runtime-receiver',contract_no:'runtime-controlled',currency:'CNY'});
    const platformAccount=await provision('accounts',{party_id:'runtime-platform',provider:'TEST',environment:'ISOLATED_TEST',merchant_no:'runtime-platform-receiver',contract_no:'runtime-controlled',currency:'CNY'});
    const profile={version:1,profile_id:crypto.randomUUID(),party_id:'runtime-internal',source_account_id:sourceAccount,merchant_account_id:sourceAccount,platform_account_id:platformAccount,contract_no:'runtime-controlled',funding_mode:'CONTROLLED_COLLECTION',funding_evidence_ref:'ISOLATED_CONTROL_EVIDENCE',contract_mapping_version:'runtime-map',calculation:{mode:'PROPORTIONAL',commission_bps:1000,rounding:'FLOOR_BPS_V1'},recognition_policy:{mode:'CUSTOMER_ACCEPTANCE'}};
    const orderId='WO-runtime-accepted',core=require('../payment/core.cjs').createPaymentCore({createConnection:()=>pool.getConnection(),now:()=>clock,config:{PAY_APP_CODE:'isolated',PAY_PROJECT_CODE:'isolated',PAY_SHARE_BIZ_CODE:'isolated',PAY_NOTIFY_URL:'https://example.test/notify'}}),account={id:'104',idp_type:'beike',idp_subject:'runtime-customer'};
    // A complete accepted payment fixture is produced by the actual core's
    // identity-checked reconciliation, without calling a payment institution.
    await core.transaction(c=>core.registerOrder(c,{bizType:'jiazheng',orderId,accountId:'104',amountMinor:10000,payerUcid:account.idp_subject,merchantNo:'runtime-receiver',expiresAt:new Date(clock+3600000),title:'隔离验收服务'}));
    const payment=await core.createIntent({bizType:'jiazheng',orderId,account,cashierType:'2',requestKey:'runtime-payment-intent'});
    await core.reconcilePayment(payment.payment_id,{errno:0,data:{appOrderId:payment.app_order_id,merchantNo:'runtime-receiver',amount:'100.00',orderStatus:'30',payNo:'isolated-runtime-payment'}});
    await q("INSERT INTO jz_orders VALUES(?,'104','pay_center','paid','done',?,10000,7,1,NULL)",[orderId,JSON.stringify({settlement_profile:profile})]);
    assert.equal((await successful('/me/service-orders/'+orderId+'/acceptance','104')).eligible,true);
    const confirmed=await successful('/me/service-orders/'+orderId+'/acceptance','104',{note:'确认服务验收'});assert.equal(confirmed.status,'confirmed');
    await successful('/me/service-orders/'+orderId+'/acceptance','104',{note:'确认服务验收'});
    const items=await q("SELECT * FROM commerce_settlement_items WHERE beneficiary_party_id='runtime-internal'");assert.equal(items.length,1);assert.equal(items[0].payable_minor,'9000');
    const before=await q("SELECT e.account,SUM(IF(e.side='credit',e.amount_minor,-e.amount_minor)) total FROM commerce_ledger_entries e WHERE e.account IN ('service_pending_liability','payable:runtime-internal') GROUP BY e.account");assert.equal(String(before.find(r=>r.account==='service_pending_liability').total),'0');assert.equal(String(before.find(r=>r.account==='payable:runtime-internal').total),'9000');
    const adjustment=await successful('/admin/items/'+items[0].id+'/adjustments','101',{expected_revision:1,kind:'ENTITLEMENT_ADJUSTMENT',planned_minor:'8500',delta_minor:'-500',reason:'独立核验服务部分差额'});
    await successful('/admin/approval-tasks/'+adjustment.approval_id+'/actions','102',{revision:adjustment.revision,action:'approve',note:'核验合同差额，准予冲减'});
    const start=new Date(clock-86400000).toISOString(),end=new Date(clock+86400000).toISOString();
    const statement=await successful('/admin/settlement-statements/generate','101',{party_id:'runtime-internal',biz_types:['jiazheng'],payment_modes:['pay_center'],currency:'CNY',period_start:start,period_end:end});assert.equal(statement.summary.accrued_minor,'9000');assert.equal(statement.summary.reduced_minor,'500');assert.equal(statement.summary.closing_minor,'8500');
    assert.equal(Number((await q("SELECT COUNT(*) n FROM commerce_settlement_fulfillment WHERE order_no=?",[orderId]))[0].n),1);
    assert.equal(Number((await q('SELECT COUNT(*) n FROM commerce_execution_orders'))[0].n),0,'recognition does not execute funds');
    const partialOrder='WO-runtime-partial';await core.transaction(c=>core.registerOrder(c,{bizType:'jiazheng',orderId:partialOrder,accountId:'104',amountMinor:10000,payerUcid:account.idp_subject,merchantNo:'runtime-receiver',expiresAt:new Date(clock+3600000),title:'部分退款验收阻断'}));
    const partialPayment=await core.createIntent({bizType:'jiazheng',orderId:partialOrder,account,cashierType:'2',requestKey:'runtime-partial-payment'});await core.reconcilePayment(partialPayment.payment_id,{errno:0,data:{appOrderId:partialPayment.app_order_id,merchantNo:'runtime-receiver',amount:'100.00',orderStatus:'30',payNo:'isolated-runtime-partial'}});
    await q("INSERT INTO jz_orders VALUES(?,'104','pay_center','paid','done',?,10000,7,1,'partially_refunded')",[partialOrder,JSON.stringify({settlement_profile:profile})]);
    assert.equal((await successful('/me/service-orders/'+partialOrder+'/acceptance','104')).eligible,false);
    const blocked=await request('/me/service-orders/'+partialOrder+'/acceptance','104',{note:'退款后不能按原全额验收'});assert.equal(blocked.status,409);assert.equal(blocked.body.code,'service_refund_requires_review');
    assert.equal(Number((await q('SELECT COUNT(*) n FROM commerce_settlement_fulfillment WHERE order_no=?',[partialOrder]))[0].n),0);
  });
});
