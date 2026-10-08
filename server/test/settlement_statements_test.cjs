'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const mysql=require('mysql2/promise');
const {createStatements}=require('../settlement/statements.cjs');
const {migrate}=require('../settlement/statement-schema.cjs');
const {safe}=require('../settlement/exports.cjs');
const socket=process.env.SETTLEMENT_TEST_SOCKET||process.env.PAYMENT_TEST_SOCKET;

test('statement text neutralizes spreadsheet formulas',()=>{
  assert.equal(safe('=HYPERLINK("x")'),"'=HYPERLINK(\"x\")");
  assert.equal(safe('  +SUM(1,2)'),"'  +SUM(1,2)");
  assert.equal(safe('订单甲'),'订单甲');assert.equal(safe(null),'');
});

test('external evidence and unified statements use isolated MySQL', {skip:!socket,timeout:120000},async t=>{
  assert.match(socket,/^\/tmp\/[^/]*(?:settlement|cashier)[^/]*\/[^/]+\.sock$/,'Only an explicitly supplied temporary isolated MySQL socket is allowed');
  const database='settlement_statements_'+process.pid+'_'+crypto.randomBytes(4).toString('hex');
  const options={socketPath:socket,user:'root',timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true};
  const admin=await mysql.createConnection(options);await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');
  const pool=mysql.createPool({...options,database,connectionLimit:8});
  t.after(async()=>{await pool.end();await admin.query('DROP DATABASE `'+database+'`');await admin.end();});
  const c=await pool.getConnection();try{
    for(const sql of require('../settlement/schema.cjs').ddl)await c.query(sql);
    await migrate(c);await migrate(c);await require('../settlement/reversal.cjs').migrate(c);await require('../settlement/own-funds.cjs').migrate(c);
    await c.query(`CREATE TABLE gr_orders(id INT PRIMARY KEY,order_ref VARCHAR(64),vendor_id INT,user_id VARCHAR(64),sku VARCHAR(64),biz_type VARCHAR(24),payment_mode VARCHAR(24),status VARCHAR(24),fee BIGINT NULL,vendor_oid VARCHAR(64) NULL,paid_at VARCHAR(32) NULL,completed_at VARCHAR(32) NULL,created_at VARCHAR(32))`);
    await c.query(`CREATE TABLE commerce_settlement_items(id BIGINT PRIMARY KEY,context_id VARCHAR(36),beneficiary_party_id VARCHAR(64),original_payable_minor BIGINT,payable_minor BIGINT,offset_minor BIGINT DEFAULT 0,cancelled_minor BIGINT DEFAULT 0,line_kind VARCHAR(32),hold_reason VARCHAR(255),created_at DATETIME)`);
    await c.query(`CREATE TABLE commerce_execution_lines(id VARCHAR(36) PRIMARY KEY,item_id BIGINT,context_id VARCHAR(36),effect_kind VARCHAR(32),original_line_id VARCHAR(36) NULL)`);
    await c.query(`CREATE TABLE commerce_execution_events(event_key VARCHAR(255) PRIMARY KEY,line_id VARCHAR(36),kind VARCHAR(48),amount_minor BIGINT,created_at DATETIME)`);
  }finally{c.release();}
  const q=async(sql,args=[])=>(await pool.execute(sql,args))[0];
  let instant=Date.parse('2026-09-15T10:00:00Z');
  const owner={account:{id:'author'},parties:['merchant-A']},reviewer={account:{id:'reviewer'},parties:['merchant-A']},intruder={account:{id:'outsider'},parties:['merchant-B']};
  const authorize=async(p,permission,scope)=>{if(p.revoked||!p.parties.includes(scope.party_id))throw Object.assign(new Error('scope denied'),{status:403});return true;};
  const service=createStatements({pool,authorize,now:()=>instant});
  const binding=crypto.randomUUID(),profile=crypto.randomUUID();
  await q("INSERT INTO commerce_settlement_party_bindings(id,source_domain,source_entity_type,source_entity_id,party_id,status,created_by,reviewed_by) VALUES(?,'jiazheng','vendor','7','merchant-A','approved','one','two')",[binding]);
  await q("INSERT INTO commerce_settlement_profiles(id,party_id,biz_type,payment_mode,version,status,created_by,reviewed_by,snapshot) VALUES(?,'merchant-A','jiazheng','wechat_mini',1,'approved','one','two',?)",[profile,JSON.stringify({contract_ref:'contract-01',calculation:{mode:'PROPORTIONAL',commission_bps:1000,channel_bps:0,rounding:'FLOOR_BPS_V1'}})]);
  await q(`INSERT INTO gr_orders(id,order_ref,vendor_id,user_id,sku,biz_type,payment_mode,status,fee,vendor_oid,paid_at,completed_at,created_at) VALUES
    (1,'GR-PAID',7,'account-1','101','jiazheng','wechat_mini','completed',20000,'VO-1','2026-09-10 12:00:00','2026-09-11 12:00:00','2026-09-09 12:00:00'),
    (2,'GR-PENDING',7,'account-1','101','jiazheng','wechat_mini','pending',NULL,NULL,NULL,NULL,'2026-09-12 12:00:00'),
    (3,'WO-INTERNAL-PROJECTION',7,'account-1','101','jiazheng','pay_center','completed',9999,'X','2026-09-12 12:00:00',NULL,'2026-09-12 12:00:00'),
    (4,'COMMERCE-PROJECTION',7,'account-1','101','commerce','pay_center','completed',9999,'Y','2026-09-12 12:00:00',NULL,'2026-09-12 12:00:00'),
    (5,'GR-UNKNOWN',7,'account-1','101','jiazheng','wechat_mini','completed',NULL,'VO-5',NULL,'2026-09-12 12:00:00','2026-09-12 12:00:00')`);
  let contextId,payment,fulfillment,initialStatement,accrual,receipt;
  const ingest=(extra={})=>service.ingestEvidence(owner,{party_id:'merchant-A',context_id:contextId,channel:'wechat_mini',environment:'external',merchant_account:'7',event_kind:'PAYMENT',transaction_id:'TX-1',amount_minor:'20000',currency:'CNY',occurred_at:'2026-09-10T04:00:00Z',source_type:'PROVIDER_STATEMENT',evidence_ref:'bank-proof-1',...extra});
  const review=e=>service.reviewEvidence(reviewer,{evidence_id:e.evidence_id,decision:'verify',note:'已独立核对原始凭证及对应订单'});
  const statementInput={party_id:'merchant-A',currency:'CNY',period_start:'2026-09-01',period_end:'2026-10-01',biz_types:['jiazheng'],payment_modes:['wechat_mini']};

  await t.test('external sync includes pending and excludes internal projections, and requires approved binding',async()=>{
    await assert.rejects(service.syncExternalOrders(intruder,{vendor_id:7,party_id:'merchant-A'}),{status:403});
    const synced=await service.syncExternalOrders(owner,{vendor_id:7,party_id:'merchant-A'});assert.equal(synced.rows.length,3);contextId=synced.rows.find(x=>x.order_ref==='GR-PAID').context_id;
    await service.syncExternalOrders(owner,{vendor_id:7,party_id:'merchant-A'});
    assert.equal((await q('SELECT * FROM commerce_settlement_business_contexts')).length,3);
    assert.equal((await q('SELECT * FROM commerce_external_trade_events')).length,6);
    assert.equal((await q('SELECT * FROM commerce_payee_statement_policies')).length,1,'sync automatically registers one monthly policy');
    assert.equal((await q('SELECT * FROM commerce_funding_sources')).length,0);
  });
  await t.test('incomplete external evidence still produces frozen downloadable statements',async()=>{
    instant=Date.parse('2026-10-02T03:00:00Z');initialStatement=await service.generateStatement(owner,statementInput);
    assert.equal(initialStatement.publication_status,'ISSUED');assert.equal(initialStatement.coverage_status,'PARTIAL');assert.equal(initialStatement.summary.verified_payment_minor,'0');assert.equal(initialStatement.summary.order_count,3);assert.equal(initialStatement.summary.unknown_amount_count,3);
    const again=await service.generateStatement(owner,statementInput);assert.equal(again.id,initialStatement.id);
    await assert.rejects(service.getStatement(intruder,{statement_id:initialStatement.id}),{status:403});
  });
  await t.test('candidate becomes one verified transaction using alias and independent review',async()=>{
    instant=Date.parse('2026-09-16T10:00:00Z');const [legacy]=await q("SELECT * FROM commerce_external_trade_events WHERE context_id=? AND event_kind='PAYMENT'",[contextId]);
    payment=await ingest({alias_event_id:legacy.id});assert.equal(payment.event_id,legacy.id);
    await assert.rejects(service.reviewEvidence(owner,{evidence_id:payment.evidence_id,decision:'verify',note:'本人申请不应通过'}),{status:403});
    assert.equal((await review(payment)).status,'VERIFIED');
    assert.equal((await ingest({alias_event_id:legacy.id})).event_id,payment.event_id);
    assert.equal((await q("SELECT * FROM commerce_external_trade_events WHERE context_id=? AND event_kind='PAYMENT'",[contextId])).length,1);
    const [candidate]=await q("SELECT * FROM commerce_external_trade_events WHERE context_id=? AND event_kind='FULFILLMENT'",[contextId]);
    fulfillment=await ingest({event_kind:'FULFILLMENT',transaction_id:null,alias_event_id:candidate.id,amount_minor:null,occurred_at:'2026-09-11T04:00:00Z',evidence_ref:'acceptance-proof'});await review(fulfillment);
  });
  await t.test('same transaction with changed amount is a conflict rather than a second payment',async()=>{
    const conflicting=await ingest({amount_minor:'30000',evidence_ref:'contradictory-report'});assert.equal(conflicting.event_id,payment.event_id);
    assert.equal((await review(conflicting)).status,'CONFLICT');
    const [event]=await q('SELECT * FROM commerce_external_trade_events WHERE id=?',[payment.event_id]);assert.equal(String(event.amount_minor),'20000');
  });
  await t.test('external approved accrual, actual commission receipt and proportional refund remain separate',async()=>{
    const common={party_id:'merchant-A',context_id:contextId,profile_id:profile,currency:'CNY',creditor_party_id:'platform',debtor_party_id:'merchant-A',evidence_ref:'signed-contract-01',reason:'批准合同百分之十服务佣金',component:'PLATFORM_COMMISSION'};
    accrual=await service.recordExternalAccrual(owner,{...common,amount_minor:'2000',evidence_event_id:payment.event_id,fulfillment_event_id:fulfillment.event_id,request_key:'accrual-1'});
    await assert.rejects(service.reviewExternalAccrual(owner,{event_id:accrual.id,decision:'approve',note:'禁止自审'}),{status:403});
    await service.reviewExternalAccrual(reviewer,{event_id:accrual.id,decision:'approve',note:'已核对协议、履约及计费基数'});
    receipt=await ingest({event_kind:'COMMISSION_RECEIPT',transaction_id:'COM-1',amount_minor:'1200',occurred_at:'2026-09-17T04:00:00Z',evidence_ref:'platform-bank-credit-1'});await review(receipt);
    const settled=await service.recordExternalAccrual(owner,{...common,obligation_id:accrual.obligation_id,event_kind:'SETTLEMENT',amount_minor:'1200',evidence_event_id:receipt.event_id,request_key:'receipt-1'});await service.reviewExternalAccrual(reviewer,{event_id:settled.id,decision:'approve',note:'核实平台实际到账1200分'});
    const refund=await ingest({event_kind:'REFUND',transaction_id:'REF-1',original_event_id:payment.event_id,amount_minor:'5000',occurred_at:'2026-09-18T04:00:00Z',evidence_ref:'consumer-refund-1'});await review(refund);
    const reduction=await service.recordExternalAccrual(owner,{...common,obligation_id:accrual.obligation_id,event_kind:'REDUCTION',amount_minor:'500',evidence_event_id:refund.event_id,request_key:'reduction-1'});await service.reviewExternalAccrual(reviewer,{event_id:reduction.id,decision:'approve',note:'合同明确按实退百分之十退佣'});
    const [ob]=await q('SELECT * FROM commerce_external_obligations WHERE id=?',[accrual.obligation_id]);assert.equal(BigInt(ob.accrued_minor)-BigInt(ob.reduced_minor)-BigInt(ob.settled_minor),300n);
    const duplicateReduction=await service.recordExternalAccrual(owner,{...common,obligation_id:accrual.obligation_id,event_kind:'REDUCTION',amount_minor:'500',evidence_event_id:refund.event_id,request_key:'reduction-duplicate'});await assert.rejects(service.reviewExternalAccrual(reviewer,{event_id:duplicateReduction.id,decision:'approve',note:'第二次退佣不得重复确认'}),/累计退佣/);
    assert.equal((await q('SELECT * FROM commerce_funding_sources')).length,0);
  });
  await t.test('new evidence yields new version without rewriting old content or duplicating receipts',async()=>{
    instant=Date.parse('2026-10-02T04:00:00Z');const latest=await service.generateStatement(owner,statementInput);assert.equal(latest.version,2);assert.equal(latest.summary.verified_payment_minor,'20000');assert.equal(latest.summary.verified_refund_minor,'5000');assert.equal(latest.summary.external_commission_outstanding_minor,'300');assert.equal(latest.summary.external_commission_received_minor,'1200');
    const original=await service.getStatement(owner,{statement_id:initialStatement.id});assert.equal(original.summary.verified_payment_minor,'0');assert.equal(original.source_hash,initialStatement.source_hash);
    const concurrent=await Promise.all([service.generateStatement(owner,statementInput),service.generateStatement(owner,statementInput)]);assert.equal(concurrent[0].id,concurrent[1].id);
    initialStatement=latest;
  });
  await t.test('different refund reviews serialize on original payment and reject aggregate overrefund',async()=>{
    const a=await ingest({event_kind:'REFUND',transaction_id:'REF-A',original_event_id:payment.event_id,amount_minor:'10000',occurred_at:'2026-10-01T04:00:00Z',evidence_ref:'refund-A'});
    const b=await ingest({event_kind:'REFUND',transaction_id:'REF-B',original_event_id:payment.event_id,amount_minor:'10000',occurred_at:'2026-10-01T04:00:00Z',evidence_ref:'refund-B'});
    const results=await Promise.all([review(a),review(b)]);assert.deepEqual(results.map(r=>r.status).sort(),['CONFLICT','VERIFIED']);
  });
  await t.test('batch imports retain unmatched and invalid rows and deduplicate canonical trades',async()=>{
    const records=[{context_id:contextId,merchant_account:'7',event_kind:'PAYMENT',transaction_id:'TX-1',amount_minor:'20000',currency:'CNY',occurred_at:'2026-09-10T04:00:00Z'},{merchant_account:'7',event_kind:'PAYMENT',transaction_id:'UNMATCHED-1',amount_minor:'999',currency:'CNY'},{merchant_account:'7',event_kind:'PAYMENT',transaction_id:'INVALID-1',amount_minor:'1.5',currency:'CNY'}];
    const input={party_id:'merchant-A',channel:'wechat_mini',environment:'external',format:'json',filename:'batch.json',file_base64:Buffer.from(JSON.stringify(records)).toString('base64')};
    const batch=await service.importExternalEvidence(owner,input);assert.equal(batch.results[0].event_id,payment.event_id);assert.ok(batch.results[2].error);assert.equal((await service.importExternalEvidence(owner,input)).id,batch.id);
    assert.equal((await q("SELECT * FROM commerce_external_trade_events WHERE transaction_id='TX-1'")).length,1);
    await assert.rejects(service.reviewImport(owner,{import_id:batch.id,decision:'verify',note:'同人不可复核导入'}),{status:403});
    const reviewed=await service.reviewImport(reviewer,{import_id:batch.id,decision:'verify',note:'独立核验各行机构凭证',request_key:'review-import-atomic'});assert.equal(reviewed.status,'PARTIAL');assert.equal(reviewed.results[0].status,'VERIFIED');assert.ok(reviewed.results[1].error);assert.ok(reviewed.results[2].error);
  });
  await t.test('exports share immutable snapshot, include Chinese, and recheck current authorization',async()=>{
    for(const format of ['csv','xlsx','pdf']){
      const job=await service.requestExport(owner,{statement_id:initialStatement.id,format});const work=await service.runExports(owner);assert.equal(work.rows.find(x=>x.id===job.id).status,'READY',JSON.stringify(work));
      const out=await service.downloadExport(owner,{export_id:job.id});assert.ok(Buffer.isBuffer(out.buffer));
      if(format==='csv'){assert.match(out.buffer.toString('utf8'),/20000/);assert.match(out.buffer.toString('utf8'),/账单号/);}
      if(format==='xlsx'){const ExcelJS=require('exceljs'),wb=new ExcelJS.Workbook();await wb.xlsx.load(out.buffer);assert.equal(wb.worksheets.length,2);assert.equal(wb.getWorksheet('明细').rowCount,initialStatement.snapshot.lines.length+1);}
      if(format==='pdf')assert.equal(out.buffer.subarray(0,4).toString(),'%PDF');
      owner.revoked=true;await assert.rejects(service.downloadExport(owner,{export_id:job.id}),{status:403});owner.revoked=false;
    }
    assert.equal((await q("SELECT * FROM commerce_statement_access_audit WHERE result='DENIED'")).length,3);
  });
  await t.test('confirmation and dispute do not mutate frozen amounts and need independent resolution',async()=>{
    await service.confirmStatement(owner,{statement_id:initialStatement.id,note:'确认本版统计范围'});
    const dispute=await service.raiseDispute(owner,{statement_id:initialStatement.id,reason:'质疑佣金到账分配',evidence_ref:'dispute-evidence'});
    await assert.rejects(service.resolveDispute(owner,{dispute_id:dispute.id,resolution:'本人关闭不允许',evidence_ref:'x'}),{status:403});
    await service.resolveDispute(reviewer,{dispute_id:dispute.id,resolution:'已核查原凭证，后续调整另走批准流程',evidence_ref:'review-proof'});
    assert.equal((await service.getStatement(owner,{statement_id:initialStatement.id})).source_hash,initialStatement.source_hash);
  });
  await t.test('write keys replay atomically, reject changed bodies, and recheck revoked permissions',async()=>{
    const input={statement_id:initialStatement.id,reason:'核验幂等提交异议',evidence_ref:'replay-proof',request_key:'dispute-atomic-key'};
    const results=await Promise.all([service.raiseDispute(owner,input),service.raiseDispute(owner,{...input})]);assert.equal(results[0].id,results[1].id);
    assert.equal((await q('SELECT * FROM commerce_statement_disputes WHERE evidence_ref=?',['replay-proof'])).length,1);
    await assert.rejects(service.raiseDispute(owner,{...input,reason:'相同键变更内容必须拒绝'}),{status:409,code:'idempotency_conflict'});
    owner.revoked=true;await assert.rejects(service.raiseDispute(owner,input),{status:403});owner.revoked=false;
    await assert.rejects(service.raiseDispute(owner,{...input,request_key:'rollback-key',line_key:'nonexistent'}),{status:404});
    assert.equal((await q("SELECT * FROM commerce_statement_requests WHERE request_key='rollback-key'")).length,0,'failed mutation rolls back its request record');
  });
  await t.test('monthly scheduler issues without payment or split switches and catches due periods',async()=>{
    await service.setStatementPolicy(owner,{party_id:'merchant-A',currency:'CNY',biz_types:['jiazheng'],payment_modes:['wechat_mini']});
    const result=await service.runScheduled(owner);assert.equal(result.rows.length,1);assert.ok(result.rows[0].statement_id,JSON.stringify(result));
    const catchup=await service.runScheduled(owner);assert.equal(catchup.rows.length,1);assert.ok(catchup.rows[0].statement_id,'policy created in September catches August and September');
    assert.equal((await service.runScheduled(owner)).rows.length,0);
  });
  await t.test('coverage requires independently reviewed completeness and preserves old versions',async()=>{
    const report=await service.submitCoverage(owner,{party_id:'merchant-A',currency:'CNY',period_start:'2026-09-01',period_end:'2026-10-01',fact_types:['PAYMENT','REFUND','FULFILLMENT','CHANNEL_SETTLEMENT','COMMISSION_RECEIPT'],evidence_ref:'full-provider-statement',request_key:'coverage-month-1'});
    await assert.rejects(service.reviewCoverage(owner,{coverage_id:report.id,decision:'approve',note:'不能自审'}),{status:403});
    await service.reviewCoverage(reviewer,{coverage_id:report.id,decision:'approve',note:'逐项验证完整覆盖范围',request_key:'coverage-review-1'});
    const complete=await service.generateStatement(owner,statementInput);assert.equal(complete.coverage_status,'COMPLETE');assert.notEqual(complete.recon_status,'MATCHED');
    assert.equal((await service.getStatement(owner,{statement_id:initialStatement.id})).coverage_status,'PARTIAL');
    assert.equal(complete.summary.external_payable_outstanding_minor,'300');assert.equal(complete.summary.external_receivable_outstanding_minor,'0');
  });
  await t.test('batch allocations match multiple orders without counting full receipt twice',async()=>{
    const batch=await ingest({context_id:null,transaction_id:'BATCH-PAID',amount_minor:'1000',occurred_at:'2026-09-20T00:00:00Z',evidence_ref:'batch-payment'});await review(batch);
    const [other]=await q("SELECT id FROM commerce_settlement_business_contexts WHERE biz_order_no='GR-PENDING'");
    await service.allocateExternalTrade(reviewer,{event_id:batch.event_id,context_id:contextId,purpose:'PAYMENT_BASIS',amount_minor:'600',request_key:'allocate-batch-1'});
    await service.allocateExternalTrade(reviewer,{event_id:batch.event_id,context_id:other.id,purpose:'PAYMENT_BASIS',amount_minor:'400',request_key:'allocate-batch-2'});
    await assert.rejects(service.allocateExternalTrade(reviewer,{event_id:batch.event_id,context_id:other.id,purpose:'PAYMENT_BASIS',amount_minor:'1',request_key:'allocate-overflow'}),/累计分配/);
    const s=await service.generateStatement(owner,statementInput);assert.equal(s.summary.verified_payment_minor,'21000');
    assert.equal(s.snapshot.lines.filter(l=>l.event_id===batch.event_id&&l.record_type==='EXTERNAL_TRADE').length,2);
    assert.equal(s.snapshot.lines.filter(l=>l.event_id===batch.event_id&&l.record_type==='EXTERNAL_ALLOCATION_SOURCE').length,1);
  });
  await t.test('approved fixed-cost contract supports two refunds after commission was fully received',async()=>{
    const [ctx]=await q("SELECT id FROM commerce_settlement_business_contexts WHERE biz_order_no='GR-UNKNOWN'"),fixedProfile=crypto.randomUUID();
    await q("INSERT INTO commerce_settlement_profiles(id,party_id,biz_type,payment_mode,version,status,created_by,reviewed_by,snapshot) VALUES(?,'merchant-A','jiazheng','wechat_mini',2,'approved','one','two',?)",[fixedProfile,JSON.stringify({contract_ref:'fixed-contract',calculation:{mode:'FIXED_COST',fixed_cost_minor:'75',fixed_commission_minor:'30',rounding:'HALF_UP_BPS_V1'},refund_policy:{mode:'PROPORTIONAL_TO_PAID'}})]);
    const paid=await ingest({context_id:ctx.id,transaction_id:'FIXED-PAYMENT',amount_minor:'105',evidence_ref:'fixed-paid'});await review(paid);
    const fulfilled=await ingest({context_id:ctx.id,event_kind:'FULFILLMENT',transaction_id:null,amount_minor:null,evidence_ref:'fixed-acceptance'});await review(fulfilled);
    const common={party_id:'merchant-A',context_id:ctx.id,profile_id:fixedProfile,currency:'CNY',creditor_party_id:'platform',debtor_party_id:'merchant-A',evidence_ref:'fixed-contract-proof',reason:'批准固定成本合同',component:'FIXED_SERVICE_FEE'};
    const obligation=await service.recordExternalAccrual(owner,{...common,amount_minor:'30',evidence_event_id:paid.event_id,fulfillment_event_id:fulfilled.event_id,request_key:'fixed-accrual'});await service.reviewExternalAccrual(reviewer,{event_id:obligation.id,decision:'approve',note:'固定佣金30分'});
    const receipt=await ingest({context_id:ctx.id,event_kind:'COMMISSION_RECEIPT',transaction_id:'FIXED-RECEIPT',amount_minor:'30',evidence_ref:'fixed-receipt'});await review(receipt);
    const settled=await service.recordExternalAccrual(owner,{...common,obligation_id:obligation.obligation_id,event_kind:'SETTLEMENT',amount_minor:'30',evidence_event_id:receipt.event_id,request_key:'fixed-settlement'});await service.reviewExternalAccrual(reviewer,{event_id:settled.id,decision:'approve',note:'佣金全额到账'});
    for(const [index,amount]of [[1,'53'],[2,'52']]){
      const refund=await ingest({context_id:ctx.id,event_kind:'REFUND',transaction_id:'FIXED-REFUND-'+index,original_event_id:paid.event_id,amount_minor:amount,evidence_ref:'fixed-refund-'+index});await review(refund);
      const reduction=await service.recordExternalAccrual(owner,{...common,obligation_id:obligation.obligation_id,event_kind:'REDUCTION',amount_minor:'15',evidence_event_id:refund.event_id,request_key:'fixed-reduction-'+index});await service.reviewExternalAccrual(reviewer,{event_id:reduction.id,decision:'approve',note:'依批准原支付比例退佣15分'});
    }
    const [o]=await q('SELECT * FROM commerce_external_obligations WHERE id=?',[obligation.obligation_id]);assert.equal(String(o.return_due_minor),'30');assert.equal(String(o.settled_minor),'30');assert.equal(String(o.reduced_minor),'0');
    assert.equal((await q('SELECT * FROM commerce_funding_sources')).length,0);
  });
  await t.test('internal original obligations and successful release events conserve period balances',async()=>{
    const context=crypto.randomUUID();await q("INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot,created_at) VALUES(?,'jiazheng','jz_orders','WO-REAL','pay_center','INTERNAL_FUNDED','merchant-A','CNY','{}','2026-09-01 00:00:00')",[context]);
    await q("INSERT INTO commerce_settlement_items(id,context_id,beneficiary_party_id,original_payable_minor,payable_minor,line_kind,created_at) VALUES(1,?,'merchant-A',15984,15984,'merchant','2026-09-10 00:00:00')",[context]);
    const line=crypto.randomUUID();await q("INSERT INTO commerce_execution_lines(id,item_id,context_id,effect_kind) VALUES(?,1,?,'MERCHANT_RELEASE')",[line,context]);
    await q("INSERT INTO commerce_execution_events(event_key,line_id,kind,amount_minor,created_at) VALUES('actual-release',?,'MERCHANT_RELEASE_SUCCEEDED',15000,'2026-09-20 00:00:00'),('reservation-release',?,'FAILED_RELEASED',984,'2026-09-20 00:00:00')",[line,line]);
    const s=await service.generateStatement(owner,{...statementInput,payment_modes:['pay_center']});assert.equal(s.summary.accrued_minor,'15984');assert.equal(s.summary.discharged_minor,'15000');assert.equal(s.summary.closing_minor,'984');
    await q("INSERT INTO commerce_execution_events(event_key,line_id,kind,amount_minor,created_at) VALUES('bank-return',?,'RETURNED',100,'2026-09-21 00:00:00')",[line]);
    const returned=await service.generateStatement(owner,{...statementInput,payment_modes:['pay_center']});assert.equal(returned.summary.bank_returned_minor,'100');assert.equal(returned.summary.closing_minor,'984','returned cash is not an invented change to original paid item');assert.ok(returned.snapshot.lines.some(l=>l.record_type==='INTERNAL_REVERSAL'));
    const next=await service.generateStatement(owner,{...statementInput,payment_modes:['pay_center'],period_start:'2026-10-01',period_end:'2026-11-01'});assert.equal(next.summary.opening_minor,'984');assert.equal(next.summary.closing_minor,'984');
  });
  await t.test('shared reversal cancels unpaid obligations and reconstructs recovery only from immutable facts',async()=>{
    const context=crypto.randomUUID(),line=crypto.randomUUID(),recovery=crypto.randomUUID(),event=crypto.randomUUID(),party='recovery-merchant';owner.parties.push(party);
    await q("INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot,created_at) VALUES(?,'jiazheng','jz_orders','WO-REVERSED','pay_center','INTERNAL_FUNDED',?,'CNY','{}','2026-09-01 00:00:00')",[context,party]);
    await q("INSERT INTO commerce_settlement_items(id,context_id,beneficiary_party_id,original_payable_minor,payable_minor,cancelled_minor,line_kind,created_at) VALUES(2,?,?,1000,1000,400,'merchant','2026-09-10 00:00:00')",[context,party]);
    await q("INSERT INTO commerce_execution_lines(id,item_id,context_id,effect_kind) VALUES(?,2,?,'MERCHANT_RELEASE')",[line,context]);
    await q("INSERT INTO commerce_execution_events(event_key,line_id,kind,amount_minor,created_at) VALUES('recovery-paid',?,'MERCHANT_RELEASE_SUCCEEDED',600,'2026-09-12 00:00:00'),('recovery-early-return',?,'RETURN_SUCCEEDED',100,'2026-09-18 00:00:00')",[line,line]);
    const payload={source_type:'shared_reversal',item_cancellations:[{item_id:'2',amount_minor:'400'}],recovery_cases:[{id:recovery,original_execution_line_id:line,party_id:party,recovery_kind:'BENEFICIARY',principal_minor:'600',initial_recovered_minor:'100'}]};
    await q("INSERT INTO commerce_ledger_events(id,event_key,context_id,payload_hash,payload,posted_at) VALUES(?,'shared-reversal:statement-test',?,?,?,'2026-09-20 00:00:00')",[event,context,crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),JSON.stringify(payload)]);
    await q("INSERT INTO commerce_shared_recovery_cases(id,context_id,unit_id,original_execution_line_id,reversal_id,party_id,recovery_kind,principal_minor,recovered_minor,status,reason,created_at,updated_at) VALUES(?,?,?, ?,999,?,'BENEFICIARY',600,500,'OPEN','已核验核销撤销','2026-09-20 00:00:00','2026-09-25 00:00:00')",[recovery,context,crypto.randomUUID(),line,party]);
    await q("INSERT INTO commerce_shared_recovery_events(event_key,recovery_id,amount_minor,kind,created_at) VALUES('recovery-actual-1',?,200,'SPLIT_RETURN','2026-09-21 00:00:00'),('recovery-actual-future',?,200,'SPLIT_RETURN','2026-09-25 00:00:00')",[recovery,recovery]);
    const input={...statementInput,party_id:party,payment_modes:['pay_center']};
    const beforeReversal=await service.generateStatement(owner,{...input,as_of:'2026-09-19T12:00:00Z'});assert.equal(beforeReversal.summary.closing_minor,'400');assert.equal(beforeReversal.summary.recovery_payable_outstanding_minor,'0');
    const early=await service.generateStatement(owner,{...input,as_of:'2026-09-20T12:00:00Z'});assert.equal(early.summary.accrued_minor,'1000');assert.equal(early.summary.discharged_minor,'600');assert.equal(early.summary.reduced_minor,'400');assert.equal(early.summary.closing_minor,'0');assert.equal(early.summary.recovery_payable_accrued_minor,'500');assert.equal(early.summary.recovery_payable_outstanding_minor,'500','current recovered balance never changes a past statement');assert.equal(early.snapshot.lines.some(l=>l.record_type==='PENDING_LEDGER_RECONCILIATION'),false);
    const recovered=await service.generateStatement(owner,{...input,as_of:'2026-09-22T00:00:00Z'});assert.equal(recovered.summary.recovery_payable_recovered_minor,'200');assert.equal(recovered.summary.recovery_payable_outstanding_minor,'300');assert.equal(recovered.summary.discharged_minor,'600');assert.equal((await service.getStatement(owner,{statement_id:early.id})).summary.recovery_payable_outstanding_minor,'500');
    const next=await service.generateStatement(owner,{...input,period_start:'2026-10-01',period_end:'2026-11-01'});assert.equal(next.summary.recovery_payable_opening_minor,'100');assert.equal(next.summary.recovery_payable_outstanding_minor,'100');assert.equal(next.summary.closing_minor,'0');
  });
  await t.test('compensation payment and both recovery debt directions export without treating bank returns as repayment',async()=>{
    const context=crypto.randomUUID(),line=crypto.randomUUID(),recovery=crypto.randomUUID(),debtor='comp-merchant',creditor='comp-platform',customer='comp-customer';owner.parties.push(debtor,creditor,customer);
    await q("INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot,created_at) VALUES(?,'jiazheng','jz_orders','WO-COMPENSATION','pay_center','INTERNAL_FUNDED',?,'CNY','{}','2026-09-01 00:00:00')",[context,debtor]);
    await q("INSERT INTO commerce_settlement_items(id,context_id,beneficiary_party_id,original_payable_minor,payable_minor,line_kind,created_at) VALUES(3,?,?,500,500,'compensation','2026-09-10 00:00:00')",[context,customer]);
    await q("INSERT INTO commerce_execution_lines(id,item_id,context_id,effect_kind) VALUES(?,3,?,'PAYOUT')",[line,context]);
    await q("INSERT INTO commerce_execution_events(event_key,line_id,kind,amount_minor,created_at) VALUES('comp-paid',?,'PAYOUT_SUCCEEDED',500,'2026-09-20 00:00:00'),('comp-bank-return',?,'RETURNED',200,'2026-09-21 00:00:00')",[line,line]);
    await q("INSERT INTO commerce_compensation_recoveries(id,compensation_id,context_id,debtor_party_id,creditor_party_id,currency,amount_minor,activated_minor,created_at) VALUES(?,?,?,?,?,'CNY',500,300,'2026-09-10 00:00:00')",[recovery,crypto.randomUUID(),context,debtor,creditor]);
    for(const [key,side,amount,stamp]of [['comp-recovery-plus','debit','500','2026-09-20 00:00:00'],['comp-recovery-return','credit','200','2026-09-21 00:00:00']]){
      const payload={source_type:'compensation_recovery',source_id:recovery,lines:[{side,account:'receivable:'+debtor,amount_minor:amount},{side:side==='debit'?'credit':'debit',account:'compensation_recovery',amount_minor:amount}]};
      await q('INSERT INTO commerce_ledger_events(id,event_key,context_id,payload_hash,payload,posted_at) VALUES(?,?,?,?,?,?)',[crypto.randomUUID(),key,context,crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),JSON.stringify(payload),stamp]);
    }
    const input={...statementInput,payment_modes:['pay_center']};
    const before=await service.generateStatement(owner,{...input,party_id:debtor,as_of:'2026-09-19T12:00:00Z'});assert.equal(before.summary.recovery_payable_outstanding_minor,'0');assert.ok(before.snapshot.lines.some(l=>l.record_type==='PENDING_RECOVERY'));
    const owed=await service.generateStatement(owner,{...input,party_id:debtor,as_of:'2026-09-20T12:00:00Z'});assert.equal(owed.summary.recovery_payable_outstanding_minor,'500','past amount comes from original ledger despite current activated=300');
    const receivable=await service.generateStatement(owner,{...input,party_id:creditor});assert.equal(receivable.summary.recovery_receivable_accrued_minor,'500');assert.equal(receivable.summary.recovery_receivable_reduced_minor,'200');assert.equal(receivable.summary.recovery_receivable_recovered_minor,'0');assert.equal(receivable.summary.recovery_receivable_outstanding_minor,'300');assert.equal(receivable.summary.recovery_payable_outstanding_minor,'0');
    const payable=await service.generateStatement(owner,{...input,party_id:debtor});assert.equal(payable.summary.recovery_payable_outstanding_minor,'300');assert.equal(payable.summary.recovery_payable_recovered_minor,'0');
    const paid=await service.generateStatement(owner,{...input,party_id:customer});assert.equal(paid.summary.accrued_minor,'500');assert.equal(paid.summary.discharged_minor,'500');assert.equal(paid.summary.bank_returned_minor,'200');assert.ok(paid.snapshot.lines.some(l=>l.record_type==='INTERNAL_OBLIGATION'&&l.event_kind==='compensation'));
    const {buildExport}=require('../settlement/exports.cjs');
    for(const format of ['csv','xlsx','pdf']){const file=await buildExport({...receivable,created_at:new Date('2026-10-02T04:00:00Z')},format);assert.ok(file.buffer.length>100);if(format==='csv'){const content=file.buffer.toString('utf8');assert.match(content,/RECOVERY_RECEIVABLE/);assert.match(content,/COMPENSATION/);assert.match(content,new RegExp(recovery));}if(format==='xlsx'){const ExcelJS=require('exceljs'),wb=new ExcelJS.Workbook();await wb.xlsx.load(file.buffer);assert.equal(wb.created.toISOString(),'2026-10-02T04:00:00.000Z');}}
  });
  await t.test('contract-filtered statements include only explicitly associated orders and obligations',async()=>{
    for(const [number,contract,amount]of [[4,'internal-contract-A','111'],[5,'internal-contract-B','222']]){
      const context=crypto.randomUUID();await q("INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot,created_at) VALUES(?,'jiazheng','jz_orders',?,'pay_center','INTERNAL_FUNDED','merchant-A','CNY',?,'2026-09-01 00:00:00')",[context,'WO-CONTRACT-'+number,JSON.stringify({settlement_profile:{contract_ref:contract}})]);
      await q("INSERT INTO commerce_settlement_items(id,context_id,beneficiary_party_id,original_payable_minor,payable_minor,line_kind,created_at) VALUES(?,?,'merchant-A',?,?,'merchant','2026-09-10 00:00:00')",[number,context,amount,amount]);
    }
    const internal=await service.generateStatement(owner,{...statementInput,payment_modes:['pay_center'],contract_ref:'internal-contract-A'});assert.equal(internal.summary.accrued_minor,'111');assert.equal(internal.summary.order_count,1);assert.ok(internal.snapshot.lines.every(l=>l.order_ref==='WO-CONTRACT-4'));
    const outside=await service.generateStatement(owner,{...statementInput,contract_ref:'contract-01'});assert.equal(outside.summary.order_count,1);assert.equal(outside.summary.verified_payment_minor,'20600');assert.equal(outside.summary.external_payable_outstanding_minor,'300');assert.ok(outside.snapshot.lines.every(l=>!l.order_ref||l.order_ref==='GR-PAID'));
    const unknown=await service.generateStatement(owner,{...statementInput,contract_ref:'unconfirmed-contract'});assert.equal(unknown.summary.order_count,0);assert.equal(unknown.snapshot.lines.length,0);
  });
  await t.test('signed callbacks retain paid, fulfillment and refund history before binding and consume only external facts',async()=>{
    await q('ALTER TABLE gr_orders ADD updated_at VARCHAR(32) NULL');
    await q('CREATE TABLE jz_vendors(id INT PRIMARY KEY,status VARCHAR(24),review_status VARCHAR(24))');
    await q("INSERT INTO jz_vendors VALUES(8,'active','approved')");
    await q("INSERT INTO gr_orders(id,order_ref,vendor_id,biz_type,payment_mode,status,created_at) VALUES(99,'CALLBACK-EXTERNAL',8,'jiazheng','wechat_mini','pending','2026-09-20 12:00:00'),(100,'CALLBACK-INTERNAL',8,'jiazheng','pay_center','pending','2026-09-20 12:00:00')");
    await q('DROP TABLE commerce_external_callback_inbox'); // exercise independent pre-migration bootstrap
    const vendorApi=require('../../vendor_api.cjs'),hmac=require('../../hmac_auth.cjs'),secret=crypto.randomBytes(32).toString('hex'),vendors={8:{key:secret}},connection=await pool.getConnection();
    const send=async(payload,conn=connection)=>vendorApi.handleRequest('/api/juzhu/callback',hmac.generateSignature(secret,{vendor_id:8,order_ref:'CALLBACK-EXTERNAL',vendor_oid:'V-99',...payload}),conn,vendors);
    try{
      assert.equal((await send({status:'paid',fee:'2000',transaction_id:'CB-PAYMENT',currency:'CNY',occurred_at:'2026-09-20T04:00:00Z'})).status,200);
      assert.equal((await send({status:'paid',fee:'2000',transaction_id:'CB-PAYMENT',currency:'CNY',occurred_at:'2026-09-20T04:00:00Z'})).status,200);
      assert.equal((await send({status:'completed',occurred_at:'2026-09-21T04:00:00Z'})).status,200);
      assert.equal((await send({status:'refunded',refund_id:'CB-REFUND',original_transaction_id:'CB-PAYMENT',refund_amount_minor:'500',currency:'CNY',occurred_at:'2026-09-22T04:00:00Z'})).status,200);
      assert.equal((await q('SELECT * FROM commerce_external_callback_inbox')).length,3);
      const failing=new Proxy(connection,{get(target,key){if(key==='execute')return async(sql,args)=>{if(sql.startsWith('INSERT INTO commerce_external_callback_inbox'))throw new Error('isolated inbox failure');return target.execute(sql,args);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
      await assert.rejects(send({status:'completed',event_id:'atomic-failure'},failing),/isolated inbox failure/);
      assert.equal((await q("SELECT status FROM gr_orders WHERE id=99"))[0].status,'refunded','order update rolls back when inbox insert fails');
      assert.equal((await send({order_ref:'CALLBACK-INTERNAL',status:'paid',fee:'1'})).status,403);
      assert.equal((await vendorApi.handleRequest('/api/juzhu/callback',{vendor_id:8,sign:'invalid',timestamp:Date.now()},connection,vendors)).status,401);
    }finally{connection.release();}
    const pending=await q('SELECT * FROM commerce_external_callback_inbox');assert.ok(pending.every(x=>x.status==='PENDING'));assert.ok(pending.every(x=>!JSON.stringify(x.payload).includes(secret)));
    await q("INSERT INTO commerce_settlement_party_bindings(id,source_domain,source_entity_type,source_entity_id,party_id,status,created_by,reviewed_by) VALUES(?,'jiazheng','vendor','8','merchant-A','approved','one','two')",[crypto.randomUUID()]);
    const synced=await service.syncExternalOrders(owner,{party_id:'merchant-A',vendor_id:8});assert.equal(synced.consumed_callback_ids.length,3);
    const events=await q("SELECT * FROM commerce_external_trade_events WHERE merchant_account='8'");assert.equal(events.filter(e=>e.event_kind==='PAYMENT').length,1);assert.equal(events.filter(e=>e.event_kind==='REFUND').length,1);assert.ok(events.every(e=>e.verification_status==='REPORTED'));
    assert.equal((await q("SELECT * FROM commerce_funding_sources WHERE evidence LIKE '%CALLBACK-EXTERNAL%'")).length,0);
    assert.equal((await service.syncExternalOrders(owner,{party_id:'merchant-A',vendor_id:8})).consumed_callback_ids.length,0);
  });
});
