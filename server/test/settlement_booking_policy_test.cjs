'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),mysql=require('mysql2/promise');
const P=require('../settlement/primitives.cjs'),BP=require('../settlement/booking-policy.cjs'),socket=process.env.SETTLEMENT_TEST_SOCKET;
test('booking delay uses valid integer N and Shanghai calendar dates including leap days',()=>{
 const context={biz_type:'booking',snapshot:{booking:{checkout:'2028-02-29'}}};
 for(const n of [null,undefined,'1',-1,0.5,3651])assert.throws(()=>BP.delayDays({booking_checkout_delay_days:n}),{code:'booking_delay_invalid'});
 const policy={id:'rule',version:1,conditions:{booking_checkout_delay_days:1}},timing=BP.dueAt(context,policy);
 assert.equal(timing.not_before_at,'2028-02-29 16:00:00');
 assert.throws(()=>BP.assertDue(context,policy,'2028-02-29 15:59:59'),{code:'booking_settlement_not_due'});
 assert.deepEqual(BP.assertDue(context,policy,'2028-02-29 16:00:00'),timing);
 policy.conditions.booking_checkout_delay_days=0;assert.equal(BP.dueAt(context,policy).not_before_at,'2028-02-28 16:00:00');
 context.snapshot.booking.checkout='2027-02-29';assert.throws(()=>BP.dueAt(context,policy));
});
test('账单日（T+N 账期）把可结算日推到离店 N 天后的最近账单日',()=>{
 const context={biz_type:'booking',snapshot:{booking:{checkout:'2026-10-01'}}};
 // 未配置账单日：timing 不携带 billing_day，存量授权快照 hash 不变。
 const plain=BP.dueAt(context,{id:'p',version:1,conditions:{booking_checkout_delay_days:3}});
 assert.equal(Object.prototype.hasOwnProperty.call(plain,'billing_day'),false);
 assert.equal(plain.not_before_at,'2026-10-03 16:00:00');
 // 资格日（10-04）之后最近账单日 10-25：北京零点，UTC 渲染为前一日 16:00。
 const bill=BP.dueAt(context,{id:'p',version:1,conditions:{booking_checkout_delay_days:3,billing_day:25}});
 assert.equal(bill.not_before_at,'2026-10-24 16:00:00');
 assert.equal(bill.qualified_at,'2026-10-03 16:00:00');
 assert.equal(bill.billing_day,25);
 assert.equal(bill.source,'BOOKING_BILLING_DAY');
 // 资格日恰为账单日：当日即可随账单结算。
 assert.equal(BP.dueAt(context,{id:'p',version:1,conditions:{booking_checkout_delay_days:3,billing_day:4}}).not_before_at,'2026-10-03 16:00:00');
 // 资格日已过本月账单日：顺延到下月账单日。
 const late=BP.dueAt({biz_type:'booking',snapshot:{booking:{checkout:'2026-10-20'}}},{id:'p',version:1,conditions:{booking_checkout_delay_days:0,billing_day:5}});
 assert.equal(late.not_before_at,'2026-11-04 16:00:00');
 for(const day of [0,29,1.5,'15'])assert.throws(()=>BP.billingDay({billing_day:day}),{code:'booking_billing_day_invalid'});
 assert.equal(BP.billingDay({}),null);
 assert.equal(BP.billingDay({billing_day:28}),28);
 // 品类：新旅局两品类（民宿/长租），未知 channel 原样保留。
 assert.deepEqual([BP.categoryOf('rental'),BP.categoryLabel('rental'),BP.categoryOf('minsu'),BP.categoryLabel('minsu'),BP.categoryOf('newhouse'),BP.categoryOf(null)],['rental','长租','minsu','民宿','newhouse',null]);
});
test('booking policies, manual timing and statement coverage use actual shared services',{skip:!socket,timeout:180000},async t=>{
 assert.match(socket,/^\/tmp\/sy-(?:settlement-[\w-]+|cashier-mysql)\/[^/]+\.sock$/);
 const database='booking_policy_'+process.pid+'_'+crypto.randomBytes(4).toString('hex'),connection={socketPath:socket,user:'root',timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true};
 const admin=await mysql.createConnection(connection);await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');const pool=mysql.createPool({...connection,database,connectionLimit:8});
 t.after(async()=>{await pool.end();await admin.query('DROP DATABASE `'+database+'`');await admin.end();});
 const q=async(sql,args=[])=>(await pool.execute(sql,args))[0];
 await pool.query('CREATE TABLE booking_orders(id INT PRIMARY KEY,order_no VARCHAR(32),project_id INT,owner_vendor_id INT,user_id VARCHAR(64),checkin VARCHAR(10),checkout VARCHAR(10),rooms INT,price_total INT,commission_rate DECIMAL(5,2),commission_fee DECIMAL(10,2),status VARCHAR(16),pay_status VARCHAR(20),refund_status VARCHAR(24),paid_payment_order_id BIGINT,created_at VARCHAR(32))');
 await require('../settlement/index.cjs').migrate(pool);await require('../settlement/index.cjs').migrate(pool);
 assert.equal((await q("SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='booking_orders' AND COLUMN_NAME='price_total'"))[0].DATA_TYPE,'decimal');
 let timer=Date.parse('2026-10-01T16:00:00Z'),seq=0;const now=()=>timer,key=()=>({request_key:'book-policy-'+(++seq)});
 const authorize=require('../settlement/access.cjs').createAuthorizer({pool}),w=require('../settlement/workflow.cjs').createWorkflow({pool,authorize,now});
 const principal=id=>({account:{id,status:'active',principal_type:'user'},roles:[{permissions:['*'],scope:{level:'all'}}]}),maker=principal('maker'),reviewer=principal('reviewer');
 const account=P.id(),ctx=P.id(),source=P.id();
 await q("INSERT INTO commerce_payment_accounts(id,party_id,provider,environment,merchant_no,contract_no,currency,status,capabilities,created_by) VALUES(?,'booking-merchant','TEST','ISOLATED_TEST','test','test','CNY','approved','{}','maker')",[account]);
 await q("INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot) VALUES(?,'booking','booking_orders','BKG-TEST','pay_center','INTERNAL_FUNDED','booking-merchant','CNY',?)",[ctx,JSON.stringify({booking:{checkout:'2026-10-01'},settlement_profile:{version:1,funding_mode:'CONTROLLED_COLLECTION'}})]);
 await q("INSERT INTO commerce_funding_sources(id,context_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,'PAYMENT','TEST','ISOLATED_TEST','CNY',?,'test',10000,'AVAILABLE','{}')",[source,ctx,account]);
 const item=String((await q("INSERT INTO commerce_settlement_items(context_id,line_kind,beneficiary_party_id,account_id,source_id,rule_ref,basis_minor,payable_minor,planned_minor,original_payable_minor,status) VALUES(?,'merchant','booking-merchant',?,?,'booking-rule',10000,9000,9000,9000,'DRAFT')",[ctx,account,source])).insertId);
 async function rule(n,mode='AUTO',priority=1,extra={}){const p=await w.savePolicy(maker,{party_id:'booking-merchant',biz_type:'booking',payment_mode:'pay_center',mode,priority,conditions:{booking_checkout_delay_days:n,...extra},nodes:[{name:'预订财务复核',mode:'ANY',approver_ids:['reviewer']}],...key()});await w.publishPolicy(reviewer,{id:p.id,...key()});return p;}
 await t.test('N is required; before due neither AUTO nor REVIEW opens approval',async()=>{
  await assert.rejects(w.savePolicy(maker,{party_id:'booking-merchant',biz_type:'booking',payment_mode:'pay_center',mode:'AUTO',...key()}),{code:'booking_delay_invalid'});
  await rule(2);let i=await w.detail(maker,{id:item});let out=await w.authorizeItem(maker,{id:item,expected_revision:i.revision,...key()});assert.equal(out.status,'DRAFT');assert.equal(out.not_before_at,'2026-10-02 16:00:00');assert.equal((await q('SELECT * FROM commerce_settlement_approval_instances')).length,0);
  i=await w.detail(maker,{id:item});await assert.rejects(w.previewAdjustment(maker,{id:item,expected_revision:i.revision,reason:'申请提前支付',not_before_at:'2026-10-02 15:59:59'}),{code:'booking_payment_too_early'});
  timer=Date.parse('2026-10-02T16:00:00Z');out=await w.authorizeItem(maker,{id:item,expected_revision:i.revision,...key()});assert.equal(out.status,'AUTHORIZED');const [auth]=await q('SELECT snapshot FROM commerce_settlement_authorizations WHERE id=?',[out.authorization_id]);assert.equal(P.parse(auth.snapshot).booking_timing.booking_checkout_delay_days,2);
 });
 await t.test('new N revokes unused authorization and waits for later independent review',async()=>{
  await rule(4,'REVIEW',2);assert.equal((await w.listPolicies(maker,{biz_type:'booking'})).rows.length,2);assert.equal((await w.listPolicies(maker,{biz_type:'commerce'})).rows.length,0);assert.equal((await q("SELECT * FROM commerce_settlement_authorizations WHERE status='ACTIVE'")).length,0);
  let i=await w.detail(maker,{id:item}),out=await w.authorizeItem(maker,{id:item,expected_revision:i.revision,...key()});assert.equal(out.status,'DRAFT');assert.equal((await q('SELECT * FROM commerce_settlement_approval_instances')).length,0);
  timer=Date.parse('2026-10-04T16:00:00Z');i=await w.detail(maker,{id:item});out=await w.authorizeItem(maker,{id:item,expected_revision:i.revision,...key()});assert.equal(out.status,'IN_REVIEW');await assert.rejects(w.approve(maker,{id:out.approval_id,revision:out.revision,action:'approve',note:'同意',...key()}),{status:403});assert.equal((await w.approve(reviewer,{id:out.approval_id,revision:out.revision,action:'approve',note:'到期复核通过',...key()})).status,'AUTHORIZED');
 });
 await t.test('账单日规则把授权推迟到账单日，出账策略随规则派生并按账单日窗口出账',async()=>{
  await assert.rejects(w.savePolicy(maker,{party_id:'booking-merchant',biz_type:'booking',payment_mode:'pay_center',mode:'AUTO',conditions:{booking_checkout_delay_days:0,billing_day:29},...key()}),{code:'booking_billing_day_invalid'});
  await rule(2,'AUTO',5,{billing_day:20});
  const billSource=P.id();
  await q("INSERT INTO commerce_funding_sources(id,context_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,'PAYMENT','TEST','ISOLATED_TEST','CNY',?,'test',9000,'AVAILABLE','{}')",[billSource,ctx,account]);
  const billItem=String((await q("INSERT INTO commerce_settlement_items(context_id,line_kind,beneficiary_party_id,account_id,source_id,rule_ref,basis_minor,payable_minor,planned_minor,original_payable_minor,status) VALUES(?,'merchant','booking-merchant',?,?,'booking-billday',9000,9000,9000,9000,'DRAFT')",[ctx,account,billSource])).insertId);
  // timer=北京 10-05：离店 10-01 + 2 天 = 资格日 10-03，尚未到账单日 10-20，授权被推迟。
  let i=await w.detail(maker,{id:billItem});const out=await w.authorizeItem(maker,{id:billItem,expected_revision:i.revision,...key()});
  assert.equal(out.status,'DRAFT');assert.equal(out.not_before_at,'2026-10-19 16:00:00');
  const statements=require('../settlement/statements.cjs').createStatements({pool,authorize,now});
  // 出账策略缺省从结算规则派生账单日（单一数据源）；登记即补出上一完整账期，与自然月口径一致。
  const reg=await statements.setStatementPolicy(maker,{party_id:'booking-merchant',biz_types:['booking'],payment_modes:['pay_center'],...key()});
  assert.equal(reg.billing_day,20);assert.equal(reg.next_run_at,'2026-09-20 00:00:00.000');
  await assert.rejects(statements.setStatementPolicy(maker,{party_id:'booking-merchant',biz_types:['booking'],payment_modes:['pay_center'],billing_day:29,...key()}),{message:'账单日须为每月 1–28 日的整数，留空则按自然月出账'});
  const backfill=await statements.runScheduled(maker);assert.equal(backfill.rows.length,1,JSON.stringify(backfill));
  const [backfillStatement]=await q('SELECT * FROM commerce_payee_statements ORDER BY created_at DESC LIMIT 1');
  assert.equal(backfillStatement.period_start,'2026-08-19 16:00:00');assert.equal(backfillStatement.period_end,'2026-09-19 16:00:00');
  assert.equal((await statements.runScheduled(maker)).rows.length,0,'补出后未到下一账单日不再出账');
  timer=Date.parse('2026-10-20T00:00:00Z');
  i=await w.detail(maker,{id:billItem});const granted=await w.authorizeItem(maker,{id:billItem,expected_revision:i.revision,...key()});
  assert.equal(granted.status,'AUTHORIZED');
  const [auth]=await q('SELECT snapshot FROM commerce_settlement_authorizations WHERE id=?',[granted.authorization_id]);
  assert.equal(P.parse(auth.snapshot).booking_timing.billing_day,20);
  assert.equal(P.parse(auth.snapshot).booking_timing.source,'BOOKING_BILLING_DAY');
  const fired=await statements.runScheduled(maker);assert.equal(fired.rows.length,1,JSON.stringify(fired));
  const [statement]=await q('SELECT * FROM commerce_payee_statements ORDER BY created_at DESC LIMIT 1');
  assert.equal(statement.period_start,'2026-09-19 16:00:00');assert.equal(statement.period_end,'2026-10-19 16:00:00');
  const [policyRow]=await q('SELECT next_run_at FROM commerce_payee_statement_policies');
  assert.equal(policyRow.next_run_at,'2026-11-20 00:00:00');
 });
 await t.test('SETTLEMENT_MAKER_CHECKER=0 时起草人可自行发布与批准（默认模式仍 403）',async()=>{
  await assert.rejects(w.publishPolicy(maker,{id:(await w.savePolicy(maker,{party_id:'booking-merchant',biz_type:'booking',payment_mode:'pay_center',mode:'AUTO',priority:9,conditions:{booking_checkout_delay_days:0},nodes:[{name:'预订财务复核',mode:'ANY',approver_ids:['reviewer']}],...key()})).id,...key()}),{status:403},'默认模式下起草人不能发布自己的草稿');
  process.env.SETTLEMENT_MAKER_CHECKER='0';
  try{
   const draft=await w.savePolicy(maker,{party_id:'booking-merchant',biz_type:'booking',payment_mode:'pay_center',mode:'AUTO',priority:8,conditions:{booking_checkout_delay_days:0},nodes:[{name:'预订财务复核',mode:'ANY',approver_ids:['reviewer']}],...key()});
   assert.equal((await w.publishPolicy(maker,{id:draft.id,...key()})).status,'approved','同人发布自己的草稿');
   const review=await rule(0,'REVIEW',9);
   const src=P.id();
   await q("INSERT INTO commerce_funding_sources(id,context_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,'PAYMENT','TEST','ISOLATED_TEST','CNY',?,'test',5000,'AVAILABLE','{}')",[src,ctx,account]);
   const selfItem=String((await q("INSERT INTO commerce_settlement_items(context_id,line_kind,beneficiary_party_id,account_id,source_id,rule_ref,basis_minor,payable_minor,planned_minor,original_payable_minor,status) VALUES(?,'merchant','booking-merchant',?,?,'booking-self-review',5000,5000,5000,5000,'DRAFT')",[ctx,account,src])).insertId);
   let i=await w.detail(maker,{id:selfItem});const opened=await w.authorizeItem(maker,{id:selfItem,expected_revision:i.revision,...key()});
   assert.equal(opened.status,'IN_REVIEW');
   assert.equal((await w.approve(maker,{id:opened.approval_id,revision:opened.revision,action:'approve',note:'同人自审',...key()})).status,'AUTHORIZED','同人批准自己的审批');
   const configuration=require('../settlement/configuration.cjs').createConfiguration({pool,workflow:w,authorize});
   const draftAccount=await configuration.create(maker,{kind:'accounts',party_id:'booking-merchant',provider:'TEST',environment:'ISOLATED_TEST',merchant_no:'self-review',contract_no:'test',currency:'CNY',capabilities:{evidence_ref:'self',receive:true},...key()});
   assert.equal((await configuration.approve(maker,{kind:'accounts',id:draftAccount.id,...key()})).status,'approved','同人批准自己的配置');
  }finally{delete process.env.SETTLEMENT_MAKER_CHECKER;}
 });
 await t.test('offline and unpaid bookings appear as immutable order facts without financial accrual',async()=>{
  await q("INSERT INTO commerce_settlement_party_bindings(id,source_domain,source_entity_type,source_entity_id,party_id,status,created_by) VALUES(?,'booking','vendor','18','booking-merchant','approved','maker')",[P.id()]);
  for(const [id,paid]of [[1,null],[2,'unpaid']])await q("INSERT INTO booking_orders(id,order_no,project_id,owner_vendor_id,user_id,checkin,checkout,rooms,price_total,commission_rate,commission_fee,status,pay_status,created_at) VALUES(?,?,1,18,'42','2026-10-08','2026-10-10',2,1298,10,129.8,'pending',?,'2026-10-01 00:00:00')",[id,'BKG-REPORT-'+id,paid]);
  const reports=require('../settlement/booking-reports.cjs');await reports.sync(pool,{now});await reports.sync(pool,{now});assert.equal((await q('SELECT * FROM commerce_booking_statement_facts')).length,2);
  const statements=require('../settlement/statements.cjs').createStatements({pool,authorize,now}),input={party_id:'booking-merchant',biz_types:['booking'],payment_modes:['offline'],period_start:'2026-10-01',period_end:'2026-11-01'};
  const first=await statements.generateStatement(maker,{...input,...key()});assert.equal(first.summary.order_count,1);assert.equal(first.summary.accrued_minor,'0');assert.equal(first.snapshot.lines[0].quoted_minor,'129800');assert.equal(first.snapshot.lines[0].commission_minor,'12980');const csv=await require('../settlement/exports.cjs').buildExport(first,'csv');assert.match(csv.buffer.toString(),/2026-10-10/);assert.match(csv.buffer.toString(),/129800/);assert.match(csv.buffer.toString(),/锁定佣金/);
  await q("UPDATE booking_orders SET status='cancelled' WHERE id=1");await reports.sync(pool,{now});const cancelled=await statements.generateStatement(maker,{...input,...key()});assert.equal(cancelled.snapshot.lines[0].order_status,'cancelled');assert.equal(first.snapshot.lines[0].order_status,'pending');
  await q("UPDATE booking_orders SET status='pending' WHERE id=1");await reports.sync(pool,{now});const reverted=await statements.generateStatement(maker,{...input,...key()});assert.equal(reverted.snapshot.lines[0].order_status,'pending');assert.equal((await q('SELECT * FROM commerce_booking_statement_facts')).length,4);
  const unauthorized={...maker,roles:[{permissions:['settlement.statement.read'],scope:{level:'all',party_ids:['someone-else']}}]};await assert.rejects(statements.getStatement(unauthorized,{statement_id:first.id}),{status:403});
 });
});
