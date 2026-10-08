'use strict';
// Real persisted settlement walkthrough. Only explicitly marked SYTEST_MOCK data;
// no public product/order, payment job, credentials, or browser mock is created.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const P=require('../../server/settlement/primitives.cjs');
const {ensureDemoAccounts,parties:PARTIES}=require('./demo-accounts.cjs');
const SEED_KEY='settlement-walkthrough-v1';
const PROVIDER='SYTEST_MOCK',ENVIRONMENT='SANDBOX';
const NAMES={'demo-cleaning':'明净到家保洁（演示）','demo-moving':'安心搬家服务（演示）','demo-rights':'邻里生活权益商户（演示）','demo-external':'悦享家外部小程序（演示）','demo-promoter':'社区推荐官渠道（演示）','demo-platform':'新居住平台结算主体（演示）','demo-customer':'客户赔付收款主体（演示）'};
const uuid=label=>{const h=crypto.createHash('sha256').update(SEED_KEY+':'+label).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
const request=label=>SEED_KEY+':'+label;
const q=async(pool,sql,args=[])=>(await pool.execute(sql,args))[0];
const parse=P.parse;
async function tableExists(pool,name){return !!(await q(pool,'SELECT 1 ok FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?',[name]))[0];}
async function status(pool){
 const [db]=await q(pool,'SELECT DATABASE() db');
 if(!await tableExists(pool,'commerce_settlement_business_contexts'))return {seed_key:SEED_KEY,database:db.db,status:'NOT_INSTALLED',contexts:0,items:0,statements:0};
 const contexts=await q(pool,"SELECT id,biz_type,biz_order_no,payment_mode FROM commerce_settlement_business_contexts WHERE JSON_UNQUOTE(JSON_EXTRACT(snapshot,'$.demo.seed_key'))=? ORDER BY id",[SEED_KEY]);
 const ids=contexts.map(c=>c.id),items=ids.length?await q(pool,'SELECT id,status FROM commerce_settlement_items WHERE context_id IN ('+ids.map(()=>'?').join(',')+')',ids):[];
 let run;if(await tableExists(pool,'commerce_settlement_walkthrough_runs'))[run]=await q(pool,'SELECT status,manifest FROM commerce_settlement_walkthrough_runs WHERE seed_key=?',[SEED_KEY]);
 return {seed_key:SEED_KEY,database:db.db,status:run?.status||'NOT_SEEDED',contexts:contexts.length,items:items.length,item_statuses:items.reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{}),statements:parse(run?.manifest||'{}').statements?.length||0,manifest:run?parse(run.manifest):null};
}
async function seed(pool,{password,now=Date.now,migrate=true}={}){
 if(migrate)await require('../../server/settlement/index.cjs').migrate(pool);
 P.configurePool(pool);
 await pool.query(`CREATE TABLE IF NOT EXISTS commerce_settlement_walkthrough_runs(seed_key VARCHAR(100) PRIMARY KEY,status VARCHAR(24) NOT NULL,manifest JSON NOT NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
 const lock=await pool.getConnection();
 try{
  const [[held]]=await lock.query("SELECT GET_LOCK(CONCAT(DATABASE(),':',?),10) held",[SEED_KEY]);assert.equal(Number(held.held),1,'Walkthrough seed is already running');
  const [old]=await q(pool,'SELECT * FROM commerce_settlement_walkthrough_runs WHERE seed_key=?',[SEED_KEY]);
  if(old?.status==='READY')return {...parse(old.manifest),reused:true};
  const actors=await ensureDemoAccounts(pool,{password}),operator=actors.operator.principal,reviewer=actors.reviewer.principal,reviewer2=actors.reviewer2.principal;
  const auth={getAccountWithRoles:async aid=>Object.values(actors).find(a=>String(a.id)===String(aid))?.principal};
  const config={JUZHU_ENV:'test',SETTLEMENT_DEMO_ENABLED:'1',SETTLEMENT_ENABLED:'0',SETTLEMENT_WORKER_ENABLED:'0',execution_enabled:false,poll_seconds:3600};
  const service=require('../../server/settlement/index.cjs').createSettlement({pool,auth,config,now,payCenter:new Proxy({},{get:()=>()=>{throw new Error('Walkthrough must never call a real payment provider');}})});
  const manifest={seed_key:SEED_KEY,run_id:SEED_KEY,provider:PROVIDER,environment:ENVIRONMENT,generated_at:new Date(now()).toISOString(),actors:Object.fromEntries(Object.entries(actors).map(([k,v])=>[k,{login:v.login_name,account_id:String(v.id),party_ids:v.principal.roles[0].scope.party_ids}])),party_ids:PARTIES,allowed_party_ids:PARTIES,context_ids:[],allowed_context_ids:[],allowed_item_ids:[],accounts:{},profiles:{},policies:{},scenarios:{},statements:[],notes:['所有凭证均为明确演示记录；仅本地模拟机构。','所有金额由真实结算服务、不可变事件和版本账单计算。']};
  await pool.execute("INSERT INTO commerce_settlement_walkthrough_runs(seed_key,status,manifest) VALUES(?,'RUNNING',?) ON DUPLICATE KEY UPDATE status='RUNNING'",[SEED_KEY,JSON.stringify(manifest)]);
  const checkpoint=async()=>pool.execute('UPDATE commerce_settlement_walkthrough_runs SET manifest=? WHERE seed_key=?',[JSON.stringify(manifest),SEED_KEY]);
  async function provision(kind,label,input,approved=true){const created=await service.configuration.create(operator,{...JSON.parse(JSON.stringify(input)),kind,request_key:request('config:'+label)});if(approved)await service.configuration.approve(reviewer,{kind,id:created.id,request_key:request('approve:'+label)});return created.id;}
  for(const party of PARTIES){manifest.accounts[party]=await provision('accounts',party,{party_id:party,provider:PROVIDER,environment:ENVIRONMENT,merchant_no:'MOCK-'+party.toUpperCase(),contract_no:'DEMO-FUNDS-2026',currency:'CNY',capabilities:{party_name:NAMES[party],account_label:NAMES[party]+'专用演示账户',demo_seed_key:SEED_KEY,evidence_ref:'演示凭证：机构能力验收-'+party,receive:true,operations:['SPLIT','RELEASE','RETURN','PAYOUT'],own_funds_verified:party==='demo-platform',own_funds_evidence_ref:party==='demo-platform'?'演示凭证：平台独立自有资金核验':undefined}});}
  manifest.accounts.cleaning_alternate=await provision('accounts','cleaning-alternate',{party_id:'demo-cleaning',provider:PROVIDER,environment:ENVIRONMENT,merchant_no:'MOCK-CLEANING-SECOND',contract_no:'DEMO-FUNDS-2026',currency:'CNY',capabilities:{party_name:NAMES['demo-cleaning'],account_label:'明净到家备用收款账户（演示）',demo_seed_key:SEED_KEY,evidence_ref:'演示凭证：备用账户独立核验',receive:true,operations:['PAYOUT','RETURN']}});
  await provision('accounts','moving-draft',{party_id:'demo-moving',provider:PROVIDER,environment:ENVIRONMENT,merchant_no:'MOCK-MOVING-PENDING',contract_no:'DEMO-FUNDS-2026',currency:'CNY',capabilities:{party_name:NAMES['demo-moving'],demo_seed_key:SEED_KEY,evidence_ref:'演示凭证：待复核账户',receive:true,operations:['PAYOUT']}},false);
  await provision('bindings','promoter-binding',{party_id:'demo-promoter',source_domain:'identity',source_entity_type:'account',source_entity_id:String(actors.promoter.id)});
  await provision('bindings','customer-binding',{party_id:'demo-customer',source_domain:'identity',source_entity_type:'account',source_entity_id:String(actors.operator.id)});
  // Only this fixed platform admission uses an in-process governance principal;
  // no login account/role receives global authority.
  const governance=p=>({...p,roles:p.roles.map(r=>({...r,scope:{level:'all'}}))});
  const platformBinding=await service.configuration.create(governance(operator),{kind:'bindings',party_id:'demo-platform',source_domain:'platform',source_entity_type:'entity',source_entity_id:SEED_KEY,request_key:request('config:platform-binding')});
  await service.configuration.approve(governance(reviewer),{kind:'bindings',id:platformBinding.id,request_key:request('approve:platform-binding')});
  const vendor=1910000901;
  await provision('bindings','external-vendor',{party_id:'demo-external',source_domain:'jiazheng',source_entity_type:'vendor',source_entity_id:String(vendor)});
  const profileSnapshots={};
  for(const [party,biz]of [['demo-cleaning','jiazheng'],['demo-moving','jiazheng'],['demo-rights','commerce']]){
   const snapshot={party_name:NAMES[party],demo:{seed_key:SEED_KEY},contract_ref:'演示合同-'+party+'-202609',calculation:{mode:'PROPORTIONAL',commission_bps:party==='demo-rights'?2000:1000,channel_bps:2000,rounding:'FLOOR_BPS_V1'},recognition_policy:{mode:biz==='commerce'?'COUPON_REDEMPTION':'CUSTOMER_ACCEPTANCE'},funding_mode:'CONTROLLED_COLLECTION',source_account_id:manifest.accounts['demo-platform'],merchant_account_id:manifest.accounts[party],platform_account_id:manifest.accounts['demo-platform'],contract_no:'DEMO-FUNDS-2026',collection:{mapping_version:'sytest-mock-v1',provider:PROVIDER,environment:ENVIRONMENT,contract_no:'DEMO-FUNDS-2026',source_merchant_no:'MOCK-DEMO-PLATFORM'},contract_mapping_version:'sytest-mock-v1',funding_evidence_ref:'演示凭证：受控资金核验-'+party,settlement_delay_hours:0,expires_at:'2026-12-31T15:59:59Z'};
   const key=await provision('profiles','profile-'+party,{party_id:party,biz_type:biz,payment_mode:'pay_center',snapshot});
   const [saved]=await q(pool,'SELECT * FROM commerce_settlement_profiles WHERE id=?',[key]);profileSnapshots[party]={...parse(saved.snapshot),profile_id:key,party_id:party,version:Number(saved.version)};manifest.profiles[party]=key;
  }
  manifest.profiles['demo-external']=await provision('profiles','external-profile',{party_id:'demo-external',biz_type:'jiazheng',payment_mode:'wechat_mini',snapshot:{party_name:NAMES['demo-external'],demo:{seed_key:SEED_KEY},contract_ref:'演示合同-外部服务佣金-202609',calculation:{mode:'PROPORTIONAL',commission_bps:1000,channel_bps:0,rounding:'HALF_UP_BPS_V1'},recognition_policy:{mode:'CUSTOMER_ACCEPTANCE'},refund_policy:{mode:'PROPORTIONAL_TO_PAID'}}});
  async function policy(label,party,biz,mode,conditions={},nodes=[],approved=true){const p=await service.workflow.savePolicy(operator,{party_id:party,biz_type:biz,payment_mode:'pay_center',priority:conditions.line_kind?200:100,mode,conditions,nodes,request_key:request('policy:'+label)});if(approved)await service.workflow.publishPolicy(reviewer,{id:p.id,request_key:request('publish:'+label)});manifest.policies[label]=p.id;return p.id;}
  const nodes=[{name:'业务履约复核',mode:'ANY',approver_ids:[String(actors.reviewer.id)]},{name:'财务双人会签',mode:'ALL',approver_ids:[String(actors.reviewer.id),String(actors.reviewer2.id)]}];
  await policy('clean-auto','demo-cleaning','jiazheng','AUTO');await policy('moving-review','demo-moving','jiazheng','REVIEW',{},nodes);await policy('rights-auto','demo-rights','commerce','AUTO');
  await policy('clean-compensation','demo-cleaning','jiazheng','REVIEW',{line_kind:'compensation'},[{name:'客户赔付资金复核',mode:'ANY',approver_ids:[String(actors.reviewer.id)]}]);
  await policy('moving-draft','demo-moving','jiazheng','HOLD',{min_minor:'1000000'},[],false);
  await checkpoint();
  const scenarios=[
   ['clean-paid','demo-cleaning','jiazheng','39800','SUCCESS','pay'],
   ['clean-installment','demo-cleaning','jiazheng','68000','SUCCESS','installment'],
   ['clean-unknown','demo-cleaning','jiazheng','129900','UNKNOWN_THEN_SUCCESS','unknown'],
   ['clean-scheduled','demo-cleaning','jiazheng','29900','SUCCESS','scheduled'],
   ['clean-dispute','demo-cleaning','jiazheng','19900','SUCCESS','hold'],
   ['clean-adjustment','demo-cleaning','jiazheng','60000','SUCCESS','adjustable'],
   ['moving-review','demo-moving','jiazheng','88000','SUCCESS','review'],
   ['moving-failed','demo-moving','jiazheng','126000','FAILED_FINAL','fail'],
   ['rights-paid','demo-rights','commerce','159840','SUCCESS','pay'],
   ['rights-authorized','demo-rights','commerce','99900','SUCCESS','authorize'],
   ['rights-partial','demo-rights','commerce','50000','PARTIAL','partial'],
   ['rights-pending','demo-rights','commerce','25000','SUCCESS','draft']
  ];
  const cases={};
  for(const [key,party,biz,amount,scenario,action]of scenarios){
   const contextId=uuid('ctx:'+key),sourceId=uuid('source:'+key),orderNo='DEMO-'+key.toUpperCase(),profile=profileSnapshots[party],stamp='2026-09-'+String(5+scenarios.findIndex(r=>r[0]===key)).padStart(2,'0')+' 04:00:00';
   await P.transaction(pool,async c=>{
    const [exists]=await q(c,'SELECT * FROM commerce_settlement_business_contexts WHERE id=? FOR UPDATE',[contextId]);
    if(exists){assert.equal(parse(exists.snapshot).demo?.seed_key,SEED_KEY,'Context ID collision');return;}
    const snapshot={demo:{seed_key:SEED_KEY,scenario,label:orderNo},settlement_profile:profile,account_id:String(actors.operator.id),party_name:NAMES[party],scenario_name:{pay:'已到账及平台佣金',installment:'按约分两次结算',unknown:'结果未知，保留原请求号查询',scheduled:'约定付款时间尚未到',hold:'服务争议暂缓结算',adjustable:'走查专用：调整付款安排',review:'两级审批与财务会签',fail:'机构明确失败，可重新审批',authorize:'已授权待执行',partial:'机构返回部分成功',draft:'待按规则申请结算'}[action]};
    await c.execute("INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot,created_at,updated_at) VALUES(?,?,'settlement_walkthrough',?,'pay_center','INTERNAL_FUNDED',?,'CNY',?,?,?)",[contextId,biz,orderNo,party,JSON.stringify(snapshot),stamp,stamp]);
    await c.execute("INSERT INTO commerce_funding_sources(id,context_id,payment_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence,created_at,updated_at) VALUES(?,?,NULL,'PAYMENT',?,?,'CNY',?,'DEMO-FUNDS-2026',?,'AVAILABLE',?,?,?)",[sourceId,contextId,PROVIDER,ENVIRONMENT,manifest.accounts['demo-platform'],amount,JSON.stringify({demo_seed_key:SEED_KEY,provider_ref:'MOCK-RECEIPT-'+key,evidence_ref:'演示凭证：顾客原收款-'+key}),stamp,stamp]);
    await P.postLedger(c,{event_key:request('receipt:'+key),context_id:contextId,source_type:'walkthrough_receipt',source_id:sourceId,posted_at:stamp,memo:'演示机构确认原收款；无真实资金',lines:[{side:'debit',account:'settlement_cash:'+sourceId,amount_minor:amount},{side:'credit',account:biz==='commerce'?'unredeemed_liability':'service_pending_liability',amount_minor:amount}]});
   });
   await P.transaction(pool,async c=>{const [ctx]=await q(c,'SELECT * FROM commerce_settlement_business_contexts WHERE id=?',[contextId]);ctx.snapshot=parse(ctx.snapshot);const [source]=await q(c,'SELECT * FROM commerce_funding_sources WHERE id=?',[sourceId]);const result=await require('../../server/settlement/business.cjs').recognize(c,{ctx,unit_key:orderNo,recognition_id:request('fulfilled:'+key),amount_minor:amount,source,profile,evidence:{demo_seed_key:SEED_KEY,evidence_ref:'演示凭证：'+(biz==='commerce'?'权益核销':'客户验收')+'-'+key},promoter_account_id:actors.promoter.id});
    // Explicit historical fixture dates apply only to this owned walkthrough.
    await c.execute('UPDATE commerce_settlement_items SET created_at=? WHERE unit_id=?',[stamp,result.id]);
    await c.execute('UPDATE commerce_settlement_units SET confirmed_at=?,created_at=? WHERE id=?',[stamp,stamp,result.id]);
    await c.execute('UPDATE commerce_ledger_events SET posted_at=? WHERE event_key=?',[stamp,'recognition:'+contextId+':'+request('fulfilled:'+key)]);
   });
   const items=await q(pool,'SELECT * FROM commerce_settlement_items WHERE context_id=? ORDER BY id',[contextId]);cases[key]={key,party,biz,amount,action,context_id:contextId,source_id:sourceId,unit_id:items[0].unit_id,items};manifest.context_ids.push(contextId);
  }
  manifest.allowed_context_ids=[...manifest.context_ids];
  async function itemRefresh(id){return (await q(pool,'SELECT * FROM commerce_settlement_items WHERE id=?',[id]))[0];}
  async function authorize(item,label,completeReview=false){const i=await itemRefresh(item.id);if(['SUCCEEDED','PAID','EXECUTING','AUTHORIZED'].includes(i.status))return null;const [pending]=await q(pool,"SELECT id FROM commerce_settlement_approval_instances WHERE item_id=? AND item_revision=? AND status='PENDING' AND purpose='FUND_EXECUTION' ORDER BY created_at DESC LIMIT 1",[i.id,i.revision]);const out=pending?{approval_id:pending.id}:await service.workflow.authorizeItem(operator,{id:String(i.id),expected_revision:Number(i.revision),request_key:request('authorize:'+label)});if(out.approval_id&&completeReview){let current;for(let step=0;step<5;step++){[current]=await q(pool,'SELECT * FROM commerce_settlement_approval_instances WHERE id=?',[out.approval_id]);if(current.status!=='PENDING')break;const node=parse(current.nodes)[Number(current.current_node)];for(const aid of node.approver_ids.length?node.approver_ids:[String(actors.reviewer.id)]){const who=String(actors.reviewer2.id)===String(aid)?reviewer2:reviewer;await service.workflow.approve(who,{id:out.approval_id,revision:Number(current.item_revision),action:'approve',note:'演示复核：核对履约、合同和资金来源',request_key:request('review:'+label+':'+current.current_node+':'+aid)});}}}return out;}
  async function execute(items,label){const result=await service.execution.createPlan(operator,{item_ids:items.map(i=>String(i.id)),request_key:request('plan:'+label)});const work=await service.execution.runJobs({limit:20,order_ids:result.orders.map(o=>o.id)});for(const r of work)assert(!r.error,'Mock execution failed: '+r.error);return result;}
  for(const c of Object.values(cases)){
   const merchant=c.items.find(i=>i.line_kind==='merchant'),platform=c.items.find(i=>i.line_kind==='platform_transfer');
   if(['draft','adjustable'].includes(c.action))continue;
   if(c.action==='hold'){await service.workflow.adjust(operator,{id:String(merchant.id),expected_revision:1,kind:'PAYMENT_ARRANGEMENT',planned_minor:String(merchant.planned_minor),hold_reason:'演示：客户对清洁范围存在争议，待售后核验',reason:'演示：售后处理中暂缓付款',evidence:{ref:'演示凭证：售后工单-09'},request_key:request('hold:'+c.key)});continue;}
   if(c.action==='scheduled'){const changed=await service.workflow.adjust(operator,{id:String(merchant.id),expected_revision:1,kind:'PAYMENT_ARRANGEMENT',planned_minor:String(merchant.planned_minor),not_before_at:'2026-10-20T02:00:00Z',reason:'演示：合同约定十月二十日付款',evidence:{ref:'演示凭证：付款安排'},request_key:request('schedule:'+c.key)});await service.workflow.approve(reviewer,{id:changed.approval_id,revision:changed.revision,action:'approve',note:'演示复核：按合同约定日期付款',request_key:request('schedule-review:'+c.key)});continue;}
   if(c.action==='installment'){const changed=await service.workflow.adjust(operator,{id:String(merchant.id),expected_revision:1,kind:'PAYMENT_ARRANGEMENT',planned_minor:'20000',reason:'演示：首期付款二百元，余款下期结付',evidence:{ref:'演示凭证：分次付款约定'},request_key:request('installment:'+c.key)});await service.workflow.approve(reviewer,{id:changed.approval_id,revision:changed.revision,action:'approve',note:'演示复核：总应付不变，仅变更本次付款',request_key:request('installment-review:'+c.key)});}
   await authorize(merchant,c.key+':merchant',c.action!=='review');
   if(c.action==='review')continue;
   await authorize(platform,c.key+':platform',true);
   if(c.action==='authorize')continue;
   if(['pay','unknown','fail','partial','installment'].includes(c.action)){
    const plan=await execute(c.action==='installment'?[await itemRefresh(merchant.id)]:[await itemRefresh(merchant.id),await itemRefresh(platform.id)],c.key);
    if(c.action==='unknown'){const [o]=await q(pool,'SELECT * FROM commerce_execution_orders WHERE plan_id=? ORDER BY id LIMIT 1',[plan.id]);manifest.scenarios.unknown={item_id:String(merchant.id),context_id:c.context_id,execution_order_id:o.id,request_no:o.request_no};if(o.status==='UNKNOWN')await pool.execute('UPDATE commerce_execution_jobs SET next_run_at=? WHERE order_id=?',[P.sqlDate(now()+365*86400000),o.id]);}
    if(c.action==='pay'){const promoter=c.items.find(i=>i.line_kind==='promoter');if(promoter){await authorize(promoter,c.key+':promoter',true);await execute([await itemRefresh(promoter.id)],c.key+':promoter');}}
   }
  }
  const adjustable=cases['clean-adjustment'].items.find(i=>i.line_kind==='merchant');manifest.scenarios.adjustment={item_id:String(adjustable.id),context_id:adjustable.context_id,beneficiary_party_id:adjustable.beneficiary_party_id,alternate_account_id:manifest.accounts.cleaning_alternate,expected_revision:Number(adjustable.revision)};
  await checkpoint();
  // Real own-funds and compensation APIs; all sources/accounts remain mock-only.
  const compensationCase=cases['clean-paid'];
  const own=await service.ownFunds.createSource(operator,{context_id:compensationCase.context_id,account_id:manifest.accounts['demo-platform'],source_type:'supplement',amount_minor:'50000',provider_reference:'MOCK-OWN-FUNDS-'+SEED_KEY,evidence_ref:'演示凭证：平台独立自有资金入账五百元',request_key:request('own-source')});
  await service.ownFunds.approveSource(reviewer,{id:own.id,note:'演示复核：独立资金，与顾客原支付及佣金分开',request_key:request('own-source-approve')});
  const [ownRow]=await q(pool,'SELECT * FROM commerce_own_fund_receipts WHERE id=?',[own.id]);
  const comp=await service.ownFunds.createCompensation(operator,{context_id:compensationCase.context_id,original_unit_id:compensationCase.unit_id,source_id:ownRow.source_id,account_id:manifest.accounts['demo-customer'],amount_minor:'10000',case_ref:'DEMO-CASE-CLEAN-PAID',evidence_ref:'演示凭证：客户赔付协议',reason:'演示：清洁器具磕碰，独立赔付一百元',request_key:request('compensation')});
  await service.ownFunds.approveCompensation(reviewer,{id:comp.id,note:'演示复核：赔付金额与客户收款身份均一致',request_key:request('compensation-approve')});
  const [compRow]=await q(pool,'SELECT * FROM commerce_real_compensations WHERE id=?',[comp.id]);const compItem=await itemRefresh(compRow.item_id);await authorize(compItem,'compensation',true);const compPlan=await execute([await itemRefresh(compItem.id)],'compensation');
  const [paidLine]=await q(pool,"SELECT l.* FROM commerce_execution_lines l JOIN commerce_execution_orders o ON o.id=l.order_id WHERE o.plan_id=? AND l.status='SUCCEEDED' LIMIT 1",[compPlan.id]);
  if(paidLine){const returned=await service.execution.recordReturned(operator,{line_id:paidLine.id,amount_minor:'2000',evidence_key:request('bank-return'),evidence:{provider_receipt:'MOCK-BANK-RETURN-2000',demo_seed_key:SEED_KEY,note:'演示凭证：银行退汇二十元，待核验重付'}});await service.execution.approveReturned(reviewer,{returned_id:returned.id,approve:true});}
  await service.ownFunds.syncRecoveries({context_ids:manifest.allowed_context_ids});
  await service.ownFunds.createCompensation(operator,{context_id:compensationCase.context_id,original_unit_id:compensationCase.unit_id,source_id:ownRow.source_id,account_id:manifest.accounts['demo-customer'],amount_minor:'3000',case_ref:'DEMO-CASE-PENDING',evidence_ref:'演示凭证：待独立复核赔付',reason:'演示：待复核的额外售后赔付',request_key:request('compensation-pending')});
  // Pre-fulfilment cancellation: original mock receipt -> independently approved
  // original-source refund. No payment_orders/payment_jobs are involved.
  const refundContext=uuid('ctx:unfulfilled-refund'),refundSource=uuid('source:unfulfilled-refund');
  await P.transaction(pool,async c=>{const [exists]=await q(c,'SELECT id FROM commerce_settlement_business_contexts WHERE id=?',[refundContext]);if(exists)return;
   await c.execute("INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot,created_at) VALUES(?,'jiazheng','settlement_walkthrough','DEMO-UNFULFILLED-REFUND','pay_center','INTERNAL_FUNDED','demo-cleaning','CNY',?,'2026-09-29 04:00:00')",[refundContext,JSON.stringify({demo:{seed_key:SEED_KEY,scenario:'SUCCESS'},settlement_profile:profileSnapshots['demo-cleaning'],account_id:String(actors.operator.id),scenario_name:'演示：预约服务取消，未确认履约，原路退款'})]);
   await c.execute("INSERT INTO commerce_funding_sources(id,context_id,payment_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,NULL,'PAYMENT',?,?,'CNY',?,'DEMO-FUNDS-2026',5000,'AVAILABLE',?)",[refundSource,refundContext,PROVIDER,ENVIRONMENT,manifest.accounts['demo-platform'],JSON.stringify({demo_seed_key:SEED_KEY,provider_ref:'MOCK-UNFULFILLED-5000',evidence_ref:'演示凭证：未履约订单原收款'})]);
   await P.postLedger(c,{event_key:request('receipt:unfulfilled-refund'),context_id:refundContext,source_type:'walkthrough_receipt',source_id:refundSource,posted_at:'2026-09-29 04:00:00',lines:[{side:'debit',account:'settlement_cash:'+refundSource,amount_minor:'5000'},{side:'credit',account:'service_pending_liability',amount_minor:'5000'}]});
  });
  manifest.context_ids.push(refundContext);manifest.allowed_context_ids=[...manifest.context_ids];
  const refund=await service.execution.createRefund(operator,{source_id:refundSource,context_id:refundContext,amount_minor:'3000',reason:'演示：服务取消，先退三十元',request_key:request('refund-complete')});
  await service.execution.approveReverse(reviewer,{order_id:refund.orders[0].id,approve:true});const refundWork=await service.execution.runJobs({limit:20,order_ids:refund.orders.map(o=>o.id)});for(const r of refundWork)assert(!r.error,'Mock refund failed: '+r.error);
  const refundPending=await service.execution.createRefund(operator,{source_id:refundSource,context_id:refundContext,amount_minor:'2000',reason:'演示：余款二十元待另一位财务批准退款',request_key:request('refund-pending')});
  manifest.scenarios.refund={context_id:refundContext,source_id:refundSource,completed_order_id:refund.orders[0].id,pending_order_id:refundPending.orders[0].id};
  await checkpoint();
  const {withExternalOperation}=require('../../server/settlement/access.cjs');
  const extWrite=fn=>withExternalOperation(operator,'finance_import',fn),extAccrual=fn=>withExternalOperation(operator,'accrual_adjustment',fn);
  // A namespaced external order is a report reference only; it is not sellable.
  const extOrders=[['DEMO-EXT-PAID','completed','20000','2026-09-10 12:00:00','2026-09-11 12:00:00'],['DEMO-EXT-PENDING','pending',null,null,null],['DEMO-EXT-UNKNOWN','completed',null,null,'2026-09-18 12:00:00'],['DEMO-EXT-WALKTHROUGH','pending',null,null,null]];
  for(const [ref,state,fee,paid,completed]of extOrders){const [prior]=await q(pool,'SELECT * FROM gr_orders WHERE order_ref=?',[ref]);if(prior)assert.equal(Number(prior.vendor_id),vendor,'External reference belongs to another vendor');else await pool.execute("INSERT INTO gr_orders(order_ref,vendor_id,user_id,sku,biz_type,payment_mode,status,fee,vendor_oid,paid_at,completed_at,created_at) VALUES(?,?,?,'SETTLEMENT-WALKTHROUGH-NOT-FOR-SALE','jiazheng','wechat_mini',?,?,?,?,?,'2026-09-09 12:00:00')",[ref,vendor,String(actors.operator.id),state,fee,'MOCK-'+ref,paid,completed]);}
  const synced=await extWrite(()=>service.statements.syncExternalOrders(operator,{party_id:'demo-external',vendor_id:vendor,request_key:request('external-sync')}));
  for(const row of synced.rows){await pool.execute("UPDATE commerce_settlement_business_contexts SET snapshot=JSON_SET(snapshot,'$.demo',CAST(? AS JSON)),created_at='2026-09-09 04:00:00' WHERE id=? AND party_id='demo-external'",[JSON.stringify({seed_key:SEED_KEY,scenario:'EXTERNAL_RECORD_ONLY'}),row.context_id]);manifest.context_ids.push(row.context_id);}
  const externalCtx=synced.rows.find(r=>r.order_ref==='DEMO-EXT-PAID').context_id;
  const statementInputs=(party,mode,biz,start='2026-09-01',end='2026-10-01')=>({party_id:party,currency:'CNY',biz_types:biz,payment_modes:mode,period_start:start,period_end:end});
  async function statement(label,input){const s=await service.statements.generateStatement(operator,{...input,request_key:request('statement:'+label)});if(!manifest.statements.some(x=>x.id===s.id))manifest.statements.push({id:s.id,party_id:s.party_id,version:s.version,actor:s.party_id==='demo-promoter'?'promoter':s.party_id==='demo-platform'?'platform':s.party_id==='demo-customer'?'operator':'merchant',statement_no:s.statement_no});return s;}
  const extInput=statementInputs('demo-external',['wechat_mini'],['jiazheng']);await statement('external-v1',extInput);
  async function evidence(label,input,verify=true){const e=await extWrite(()=>service.statements.ingestEvidence(operator,{party_id:'demo-external',context_id:externalCtx,channel:'wechat_mini',environment:'external',merchant_account:String(vendor),currency:'CNY',occurred_at:'2026-09-10T04:00:00Z',source_type:'PROVIDER_STATEMENT',evidence_ref:'演示凭证：'+label,...input,request_key:request('evidence:'+label)}));if(verify)await service.statements.reviewEvidence(reviewer,{evidence_id:e.evidence_id,decision:'verify',note:'演示复核：逐项核对原始机构模拟凭证',request_key:request('evidence-review:'+label)});return e;}
  const [legacy]=await q(pool,"SELECT id FROM commerce_external_trade_events WHERE context_id=? AND event_kind='PAYMENT' LIMIT 1",[externalCtx]);
  const payment=await evidence('外部顾客付款',{event_kind:'PAYMENT',transaction_id:'MOCK-EXT-PAY-20000',amount_minor:'20000',alias_event_id:legacy?.id});
  const fulfillment=await evidence('外部客户验收',{event_kind:'FULFILLMENT',transaction_id:null,amount_minor:null,occurred_at:'2026-09-11T04:00:00Z'});
  const common={party_id:'demo-external',context_id:externalCtx,profile_id:manifest.profiles['demo-external'],currency:'CNY',creditor_party_id:'demo-platform',debtor_party_id:'demo-external',evidence_ref:'演示凭证：双方已批准的佣金合同',reason:'演示：顾客实付二百元，服务佣金按百分之十确认',component:'PLATFORM_COMMISSION'};
  async function accrual(label,input){const a=await extAccrual(()=>service.statements.recordExternalAccrual(operator,{...common,...input,request_key:request('accrual:'+label)}));await service.statements.reviewExternalAccrual(reviewer,{event_id:a.id,decision:'approve',note:'演示复核：合同、资金事实与履约基数一致',request_key:request('accrual-review:'+label)});return a;}
  const a=await accrual('initial',{amount_minor:'2000',evidence_event_id:payment.event_id,fulfillment_event_id:fulfillment.event_id});
  const receipt=await evidence('平台实际收到外部佣金',{event_kind:'COMMISSION_RECEIPT',transaction_id:'MOCK-EXT-COMMISSION-1200',amount_minor:'1200',occurred_at:'2026-09-20T04:00:00Z'});
  await accrual('settled',{obligation_id:a.obligation_id,event_kind:'SETTLEMENT',amount_minor:'1200',evidence_event_id:receipt.event_id});
  const refunded=await evidence('外部顾客部分退款',{event_kind:'REFUND',transaction_id:'MOCK-EXT-REFUND-5000',original_event_id:payment.event_id,amount_minor:'5000',occurred_at:'2026-09-22T04:00:00Z'});
  await accrual('refund',{obligation_id:a.obligation_id,event_kind:'REDUCTION',amount_minor:'500',evidence_event_id:refunded.event_id});
  const walkthroughContext=synced.rows.find(r=>r.order_ref==='DEMO-EXT-WALKTHROUGH').context_id,walkthroughTransaction='walkthrough-'+crypto.createHash('sha256').update(SEED_KEY).digest('hex').slice(0,24);
  const pending=await evidence('商户补证专用未知金额候选',{context_id:walkthroughContext,event_kind:'PAYMENT',environment:'sandbox',transaction_id:walkthroughTransaction,amount_minor:null,source_type:'MERCHANT_REPORT',occurred_at:'2026-09-25T04:00:00Z'},false);
  await service.statements.reviewEvidence(reviewer,{evidence_id:pending.evidence_id,decision:'reject',note:'演示复核：候选金额未知，退回商户补证；不形成已核验收款',request_key:request('unknown-candidate-reject')});
  manifest.walkthrough_transaction_id=walkthroughTransaction;
  manifest.scenarios.external={party_id:'demo-external',context_id:walkthroughContext,order_ref:'DEMO-EXT-WALKTHROUGH',event_id:pending.event_id,candidate_event_id:pending.event_id,evidence_id:pending.evidence_id,amount_minor:'26800',environment:'sandbox',channel:'wechat_mini',merchant_account:String(vendor),occurred_at:'2026-09-25T04:00:00Z'};
  const extV2=await statement('external-v2',extInput);
  for(const [party,biz]of [['demo-cleaning',['jiazheng']],['demo-moving',['jiazheng']],['demo-rights',['commerce']],['demo-promoter',['commerce','jiazheng']],['demo-platform',['commerce','jiazheng']]])await statement(party+'-september',statementInputs(party,['pay_center'],biz));
  for(const [party,biz,modes]of [['demo-cleaning',['jiazheng'],['pay_center']],['demo-customer',['jiazheng'],['pay_center']],['demo-platform',['commerce','jiazheng'],['pay_center','wechat_mini']],['demo-external',['jiazheng'],['wechat_mini']],['demo-promoter',['commerce','jiazheng'],['pay_center']]])await statement(party+'-october',statementInputs(party,modes,biz,'2026-10-01','2026-11-01'));
  const externalCurrent=manifest.statements.filter(s=>s.party_id==='demo-external').at(-1);await service.statements.raiseDispute(actors.merchant.principal,{statement_id:externalCurrent.id,reason:'演示：请核对本期剩余三元佣金的结算周期',evidence_ref:'演示凭证：商户往来核对记录',request_key:request('external-dispute')});
  const confirmed=manifest.statements.find(s=>s.party_id==='demo-promoter');await service.statements.confirmStatement(actors.promoter.principal,{statement_id:confirmed.id,note:'演示：推广渠道已确认本版账单，资金状态以独立回执为准',request_key:request('promoter-confirm')});
  manifest.allowed_context_ids=[...new Set(manifest.context_ids)];manifest.allowed_item_ids=(await q(pool,'SELECT id FROM commerce_settlement_items WHERE context_id IN ('+manifest.allowed_context_ids.map(()=>'?').join(',')+')',manifest.allowed_context_ids)).map(r=>String(r.id));
  assert(manifest.allowed_item_ids.length>=20,'Insufficient walkthrough settlement items');assert(manifest.statements.length>=8,'Insufficient real generated statements');
  await pool.execute("UPDATE commerce_settlement_walkthrough_runs SET status='READY',manifest=? WHERE seed_key=?",[JSON.stringify(manifest),SEED_KEY]);return manifest;
 }finally{await lock.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(),':',?))",[SEED_KEY]).catch(()=>{});lock.release();}
}
async function isolatedSchema(pool){
 const fs=require('node:fs'),source=fs.readFileSync(require.resolve('../../auth_center.cjs'),'utf8');
 for(const name of ['accounts','roles','account_roles']){const match=source.match(new RegExp('`(CREATE TABLE IF NOT EXISTS '+name+' \\([\\s\\S]*?)`'));assert(match,'Missing authoritative auth fixture DDL');await pool.query(match[1]);}
 await pool.query('ALTER TABLE accounts MODIFY password_hash VARCHAR(255) NULL');
 await pool.query(`CREATE TABLE IF NOT EXISTS gr_orders(id INT AUTO_INCREMENT PRIMARY KEY,order_ref VARCHAR(64) UNIQUE,vendor_id INT,user_id VARCHAR(64),sku VARCHAR(128),biz_type VARCHAR(24),payment_mode VARCHAR(24),status VARCHAR(24),fee BIGINT NULL,vendor_oid VARCHAR(64),paid_at VARCHAR(32),completed_at VARCHAR(32),created_at VARCHAR(32))`);
}
async function main(argv=process.argv.slice(2)){
 const command=argv[0]||'status';assert(['status','seed'].includes(command),'Usage: demo-seed.cjs [status|seed] [--target sytest] [--isolated --database settlement_seed_...]');
 const value=name=>{const at=argv.indexOf(name);return at<0?undefined:argv[at+1];},isolated=argv.includes('--isolated');
 const mysql=require('mysql2/promise');let options,admin;
 if(isolated){const socket=process.env.SETTLEMENT_TEST_SOCKET;assert(/^\/tmp\/sy-settlement-[\w-]+\/[^/]+\.sock$/.test(socket||''),'An explicit isolated settlement MySQL socket is required');const database=value('--database')||('settlement_seed_'+process.pid);assert(/^settlement_seed_[A-Za-z0-9_]+$/.test(database));options={socketPath:socket,user:'root',database,timezone:'Z'};if(command==='seed'){admin=await mysql.createConnection({...options,database:undefined});await admin.query('CREATE DATABASE IF NOT EXISTS `'+database+'` CHARACTER SET utf8mb4');}}
 else{options=require('../../commerce/db.cjs').config();if(command==='seed'){assert.equal(value('--target'),'sytest','Host mutations require explicit --target sytest');assert.equal(options.database,'juzhu','This sytest deployment uses the confirmed juzhu database');assert.equal(process.env.JUZHU_ENV,'test','Host walkthrough requires JUZHU_ENV=test');assert.equal(process.env.COMMERCE_PUBLIC_ORIGIN,'https://sytest.meizu.life','Host mutations require the explicitly confirmed sytest site origin');}}
 const pool=mysql.createPool({...options,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,connectionLimit:12});
 try{if(isolated&&command==='seed')await isolatedSchema(pool);const result=command==='seed'?await seed(pool,{password:process.env.SETTLEMENT_DEMO_PASSWORD}):await status(pool);console.log(JSON.stringify(result,null,2));return result;}finally{await pool.end();if(admin)await admin.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
module.exports={SEED_KEY,PROVIDER,ENVIRONMENT,NAMES,seed,status,isolatedSchema,main};
