'use strict';
const {rows,parse,assert}=require('./primitives.cjs');
const {createAuthorizer,systemPrincipal}=require('./access.cjs');
const sytest=require('./sytest-provider.cjs');
async function migrate(pool){
 await require('../../commerce/migrate.cjs').migrate(pool);
 const c=await pool.getConnection();try{
  const [[lock]]=await c.query("SELECT GET_LOCK(CONCAT(DATABASE(),':shared_settlement'),30) acquired");assert(lock.acquired,'结算迁移锁不可用',503);
  await require('../payment/migrate.cjs').migrate(c);
  await require('./schema.cjs').migrate(c);
  await require('./execution-schema.cjs').migrate(c);
  await require('./statement-schema.cjs').migrate(c);
  await require('./own-funds.cjs').migrate(c);
  await require('./reversal.cjs').migrate(c);
  await require('./booking-schema.cjs').migrate(c);
 }finally{await c.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(),':shared_settlement'))").catch(()=>{});c.release();}
}
function createSettlement({pool,auth,paymentCore,payCenter,config=process.env,now=Date.now,authorize:override}) {
 require('./primitives.cjs').configurePool(pool);
 const authorize=override||createAuthorizer({pool});
 const workflow=require('./workflow.cjs').createWorkflow({pool,authorize,config,now});
 const configuration=require('./configuration.cjs').createConfiguration({pool,workflow,authorize});
 let providerContracts=config.provider_contracts||{};if(config.SETTLEMENT_PROVIDER_CONTRACTS)try{providerContracts=JSON.parse(config.SETTLEMENT_PROVIDER_CONTRACTS);}catch{providerContracts={};}
 const executionConfig={...config,provider_contracts:providerContracts,execution_enabled:config.execution_enabled===true||(config.SETTLEMENT_ENABLED==='1'&&config.SETTLEMENT_WORKER_ENABLED==='1')};
 const execution=require('./execution.cjs').createExecution({pool,authorize,config:executionConfig,now,paymentCore,payCenter});
 const statements=require('./statements.cjs').createStatements({pool,authorize,now,config:{...config,resolvePrincipal:async aid=>{const p=await auth.getAccountWithRoles(aid);return p?{type:'account',...p}:null;}}});
 const business=require('./business.cjs').createBusiness({pool,authorize,configuration,workflow,config});
 const booking=require('./booking.cjs').createBookingSettlement({pool,workflow,authorize,config,now});
 const ownFunds=require('./own-funds.cjs').createOwnFunds({pool,workflow,authorize,config});
 const reversals=require('./reversal.cjs').createReversals({pool,authorize});
 async function me(p){const permissions=[...new Set((p.roles||[]).flatMap(r=>r.permissions||[]))],all=(p.roles||[]).some(r=>(r.scope?.level==='all')&&(r.permissions||[]).some(x=>x==='*'||x==='settlement.policy.write'));
  const candidates=await rows(pool,"SELECT party_id FROM commerce_settlement_party_bindings WHERE status='approved' UNION SELECT party_id FROM commerce_payment_accounts WHERE status='approved' UNION SELECT party_id FROM commerce_settlement_business_contexts UNION SELECT party_id FROM commerce_payee_statement_policies"),parties=[];
  candidates.push({party_id:'account:'+p.account.id});
  const partyLabels=new Map();
  for(const profile of await rows(pool,"SELECT party_id,snapshot FROM commerce_settlement_profiles WHERE status='approved' ORDER BY version DESC,created_at DESC")){
   const name=parse(profile.snapshot).party_name;
   if(typeof name==='string'&&name.trim()&&!partyLabels.has(profile.party_id))partyLabels.set(profile.party_id,name.trim().slice(0,120));
  }
  for(const account of await rows(pool,"SELECT party_id,capabilities FROM commerce_payment_accounts WHERE status='approved' ORDER BY created_at DESC")){
   const name=parse(account.capabilities).party_name;
   if(typeof name==='string'&&name.trim()&&!partyLabels.has(account.party_id))partyLabels.set(account.party_id,name.trim().slice(0,120));
  }
  const permissionsForDirectory=['settlement.statement.read','settlement.fund.read','settlement.fund.write','settlement.policy.write','settlement.policy.review','settlement.external.read','settlement.external.submit','settlement.external.import'];
  for(const row of candidates){let visible=false;for(const biz of ['commerce','jiazheng','booking'])for(const payment_mode of (biz==='booking'?['pay_center','offline']:biz==='jiazheng'?['pay_center','wechat_mini']:['pay_center']))for(const permission of permissionsForDirectory){if(visible)break;try{await authorize(p,permission,{party_id:row.party_id,biz_type:biz,payment_mode});visible=true;}catch(e){if(e.status!==403)throw e;}}if(visible&&!parties.some(x=>x.id===row.party_id))parties.push({id:row.party_id,name:partyLabels.get(row.party_id)||row.party_id});}
  return {account:{id:p.account.id,display_name:p.account.display_name},permissions,parties,can_manage_parties:all,scope:auth?.scopeOf?auth.scopeOf(p):null};
 }
 async function acceptanceStatus(p,input){const [o]=await rows(pool,'SELECT * FROM jz_orders WHERE id=? AND account_id=?',[input.id,String(p.account.id)]);assert(o,'服务订单不存在',404);const snapshot=parse(o.payment_config_snapshot),profile=snapshot.settlement_profile;
  const records=await rows(pool,'SELECT * FROM commerce_settlement_fulfillment WHERE order_no=? AND account_id=?',[o.id,String(p.account.id)]);const confirmed=records.some(x=>x.event_kind==='CUSTOMER_ACCEPTANCE');const eligible=!confirmed&&!o.refund_status&&o.payment_mode==='pay_center'&&o.pay_status==='paid'&&['done','rated'].includes(o.status)&&profile?.recognition_policy?.mode==='CUSTOMER_ACCEPTANCE';
  return {id:o.id,eligible,confirmed,reason:confirmed?'已确认服务完成':eligible?'服务已完成，请确认验收':!profile?'当前订单沿用原结算规则':'服务尚未达到确认条件'};
 }
 async function fundingSources(p,input){const list=await rows(pool,'SELECT s.*,c.party_id,c.biz_type,c.payment_mode FROM commerce_funding_sources s JOIN commerce_settlement_business_contexts c ON c.id=s.context_id ORDER BY s.created_at DESC LIMIT 500'),out=[];for(const r of list){try{await authorize(p,'settlement.fund.read',r);if(!input.source_type||r.source_type===input.source_type)out.push(r);}catch(e){if(e.status!==403)throw e;}}return {rows:out};}
 // 商家目录（只读，供业务主体绑定填编号）。全局目录不是主体维度数据，不按 scope.party_ids
 // 收窄：持有 settlement.policy.write（即可发起绑定准入）即可查；出参不含联系方式与密钥。
 async function vendorDirectory(p,input){
  const permitted=(p.roles||[]).some(r=>(r.permissions||[]).some(x=>x==='*'||x==='settlement.policy.write'));
  assert(permitted,'无结算配置权限',403,'settlement_forbidden');
  const exists=await rows(pool,"SELECT 1 FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='jz_vendors'");if(!exists.length)return {rows:[]};
  const query=String(input.query||'').trim().slice(0,64);assert(query.length>=1,'请输入商家编号或名称关键词',422);
  const numeric=/^\d{1,12}$/.test(query),like='%'+query.replace(/([%_])/g,'\\$1')+'%';
  const found=await rows(pool,'SELECT id,name,type,status,review_status FROM jz_vendors WHERE '+(numeric?'(id=? OR name LIKE ?)':'name LIKE ?')+' ORDER BY id LIMIT 20',numeric?[Number(query),like]:[like]);
  return {rows:found.map(v=>({id:String(v.id),name:v.name||'',type:v.type||'',status:v.status||'',review_status:v.review_status||''}))};
 }
 async function executionOrders(p,input){const args=[],clauses=[];if(input.item_id){clauses.push('l.item_id=?');args.push(input.item_id);}const list=await rows(pool,`SELECT DISTINCT o.* FROM commerce_execution_orders o JOIN commerce_execution_lines l ON l.order_id=o.id${clauses.length?' WHERE '+clauses.join(' AND '):''} ORDER BY o.created_at DESC LIMIT 200`,args),out=[];for(const o of list){try{const ctx=await workflow.context(pool,o.context_id);await authorize(p,'settlement.fund.read',ctx);out.push(o);}catch(e){if(e.status!==403)throw e;}}return {rows:out};}
 let busy=false,lastReportScan=0;
 async function maintenance(){if(busy)return;busy=true;const results={errors:[]};const attempt=async(label,fn)=>{try{return await fn();}catch(e){results.errors.push({operation:label,code:e.code||'settlement_error'});return null;}};try{
  await attempt('exports',()=>statements.runExports(systemPrincipal,{limit:10}));
  if(config.SETTLEMENT_ENABLED==='1')await attempt('booking.checkout',()=>booking.runDue(systemPrincipal,{limit:50}));
  if(now()-lastReportScan>=60000){
   let bookingCursor='0';for(let page=0;page<100;page++){const r=await attempt('booking.reports',()=>require('./booking-reports.cjs').sync(pool,{after_id:bookingCursor,now}));if(!r?.has_more)break;bookingCursor=r.next_after_id;}
   const bookingParties=await rows(pool,"SELECT DISTINCT party_id,payment_mode,currency FROM commerce_settlement_business_contexts WHERE biz_type='booking'");for(const party of bookingParties)await attempt('booking.statement.policy',()=>statements.setStatementPolicy(systemPrincipal,{party_id:party.party_id,biz_types:['booking'],payment_modes:[party.payment_mode],currency:party.currency}));
   const bindings=await rows(pool,"SELECT party_id,source_entity_id vendor_id FROM commerce_settlement_party_bindings WHERE source_domain='jiazheng' AND source_entity_type='vendor' AND status='approved'");
   for(const binding of bindings){let after_id='0';for(let page=0;page<100;page++){const result=await attempt('external.sync',()=>statements.syncExternalOrders(systemPrincipal,{party_id:binding.party_id,vendor_id:binding.vendor_id,after_id,limit:500}));if(!result?.has_more)break;after_id=result.next_after_id;}}
   const payees=await rows(pool,'SELECT DISTINCT i.beneficiary_party_id party_id,c.biz_type,c.currency FROM commerce_settlement_items i JOIN commerce_settlement_business_contexts c ON c.id=i.context_id WHERE i.beneficiary_party_id IS NOT NULL UNION SELECT r.creditor_party_id,c.biz_type,r.currency FROM commerce_compensation_recoveries r JOIN commerce_settlement_business_contexts c ON c.id=r.context_id UNION SELECT r.debtor_party_id,c.biz_type,r.currency FROM commerce_compensation_recoveries r JOIN commerce_settlement_business_contexts c ON c.id=r.context_id');
   for(const payee of payees)await attempt('statement.policy',()=>statements.setStatementPolicy(systemPrincipal,{party_id:payee.party_id,biz_types:[payee.biz_type],payment_modes:['pay_center'],currency:payee.currency}));
   const externalParties=await rows(pool,"SELECT DISTINCT o.creditor_party_id party_id,o.currency FROM commerce_external_obligations o JOIN commerce_external_obligation_events e ON e.obligation_id=o.id WHERE e.status='POSTED' UNION SELECT DISTINCT o.debtor_party_id party_id,o.currency FROM commerce_external_obligations o JOIN commerce_external_obligation_events e ON e.obligation_id=o.id WHERE e.status='POSTED'");
   for(const payee of externalParties)await attempt('external.statement.policy',()=>statements.setStatementPolicy(systemPrincipal,{party_id:payee.party_id,biz_types:['jiazheng'],payment_modes:['wechat_mini'],currency:payee.currency}));
   lastReportScan=now();
  }
  await attempt('statements',()=>statements.runScheduled(systemPrincipal,{}));
  await attempt('execution.jobs',()=>execution.runJobs({limit:30}));
  const realEnabled=config.SETTLEMENT_ENABLED==='1'&&config.SETTLEMENT_WORKER_ENABLED==='1';
  const recoveryScope=sytest.enabled(config)&&!realEnabled?{context_ids:(await rows(pool,"SELECT id FROM commerce_settlement_business_contexts WHERE JSON_UNQUOTE(JSON_EXTRACT(snapshot,'$.demo.seed_key'))='settlement-walkthrough-v1'")).map(c=>c.id)}:{};
  await attempt('compensation.recoveries',()=>ownFunds.syncRecoveries(recoveryScope));
  if(!realEnabled&&!sytest.enabled(config))return results;
  const mockOnly=!realEnabled;
  const mockClause=(mockOnly?" AND s.provider='SYTEST_MOCK' AND s.environment='SANDBOX' AND s.payment_id IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(s.evidence,'$.demo_seed_key'))='settlement-walkthrough-v1' AND JSON_UNQUOTE(JSON_EXTRACT(c.snapshot,'$.demo.seed_key'))='settlement-walkthrough-v1' AND a.provider='SYTEST_MOCK' AND a.environment='SANDBOX' AND JSON_UNQUOTE(JSON_EXTRACT(a.capabilities,'$.demo_seed_key'))='settlement-walkthrough-v1'":"")+" AND (s.provider<>'SYTEST_MOCK' OR JSON_EXTRACT(c.snapshot,'$.demo.auto_settle')=TRUE)";
  const items=await rows(pool,"SELECT i.id,i.revision,c.biz_type FROM commerce_settlement_items i JOIN commerce_payment_accounts a ON a.id=i.account_id AND a.status='approved' JOIN commerce_settlement_business_contexts c ON c.id=i.context_id JOIN commerce_funding_sources s ON s.id=i.source_id WHERE i.context_id IS NOT NULL AND i.status='DRAFT' AND (c.biz_type<>'booking' OR i.not_before_at IS NULL OR i.not_before_at<=UTC_TIMESTAMP()) AND i.planned_minor>0 AND i.planned_minor<=i.payable_minor-i.discharged_minor-i.cancelled_minor-i.offset_minor-i.reserved_minor AND (i.line_kind<>'promoter' OR i.component_key LIKE 'supplement:%' OR EXISTS (SELECT 1 FROM commerce_commission_funding_lots l JOIN commerce_funding_sources s ON s.id=l.source_id WHERE l.context_id=i.context_id AND l.unit_id=i.unit_id AND l.status='AVAILABLE' AND s.status='AVAILABLE' AND s.received_minor-s.reserved_minor-s.consumed_minor-s.returned_minor>=i.planned_minor))"+mockClause+" ORDER BY i.id LIMIT 50");
  for(const i of items)await attempt('auto.authorize:'+i.id,()=>workflow.authorizeItem(systemPrincipal,{id:i.id,expected_revision:Number(i.revision),request_key:'auto-evaluate:'+i.id+':'+i.revision+(i.biz_type==='booking'?':'+Math.floor(now()/60000):'')}));
  const ready=await rows(pool,"SELECT i.id,i.revision,i.source_id,i.authorization_id,JSON_EXTRACT(c.snapshot,'$.settlement_profile.implicit_merchant_release') implicit_release FROM commerce_settlement_items i JOIN commerce_settlement_business_contexts c ON c.id=i.context_id JOIN commerce_funding_sources s ON s.id=i.source_id JOIN commerce_payment_accounts a ON a.id=i.account_id WHERE i.status='AUTHORIZED' AND (i.not_before_at IS NULL OR i.not_before_at<=UTC_TIMESTAMP())"+mockClause+" ORDER BY i.source_id,i.id LIMIT 500");
  const groups=new Map();for(const i of ready){if(!groups.has(i.source_id))groups.set(i.source_id,[]);groups.get(i.source_id).push(i);}
  for(const group of groups.values()){
   const chunks=[];if(group[0].implicit_release===true||group[0].implicit_release==='true')chunks.push(group);else for(let n=0;n<group.length;n+=100)chunks.push(group.slice(n,n+100));
   for(const chunk of chunks)await attempt('auto.plan',()=>execution.createPlan(systemPrincipal,{item_ids:chunk.map(i=>String(i.id)),request_key:'auto-execute:'+require('./primitives.cjs').hash(chunk.map(i=>({id:String(i.id),revision:i.revision,authorization_id:i.authorization_id})))}));
  }
  return results;
 }finally{busy=false;}}
 return {pool,authorize,workflow,configuration,execution,statements,business,booking,ownFunds,reversals,me,acceptanceStatus,fundingSources,vendorDirectory,executionOrders,maintenance};
}
module.exports={migrate,createSettlement};
