'use strict';
const crypto = require('node:crypto');
const {createProvider, authorizationHash, digest, minor, fault} = require('./provider.cjs');
const {parse, sqlDate, postLedger: defaultPostLedger} = require('./primitives.cjs');
const sytest=require('./sytest-provider.cjs');
const uuid = () => crypto.randomUUID();
const rows = async (c, sql, args = []) => (await c.execute(sql,args))[0];
const json = value => JSON.stringify(value);
const upper = value => String(value || '').toUpperCase();
const ensure = (ok,message,code='SETTLEMENT_EXECUTION_CONFLICT') => { if(!ok) throw fault(message,code); };
const actor = principal => String(principal?.account?.id ?? principal?.id ?? '');
const terminal = status => ['SUCCEEDED','PARTIAL','FAILED_FINAL','CANCELLED'].includes(status);
const amountOf = value => minor(value ?? 0);

function createExecution(options) {
 const {pool, config={}, payCenter={}, paymentCore, authorize} = options;
 const provider=createProvider({config,payCenter}), mockProvider=sytest.createProvider(config), postLedger=options.postLedger || defaultPostLedger;
 const clock=() => sqlDate(options.now ? options.now() : Date.now());
 const after=(seconds) => sqlDate(new Date(clock().replace(' ','T')+'Z').getTime()+seconds*1000);
 async function permission(principal,name,context={}) {
  ensure(actor(principal),'需要已登录操作人','SETTLEMENT_FORBIDDEN');
  ensure(typeof authorize==='function','未配置资金权限校验','SETTLEMENT_FORBIDDEN');
  ensure(await authorize(principal,name,context)===true,'无资金操作权限','SETTLEMENT_FORBIDDEN');
 }
 async function tx(fn) {
  for(let attempt=0;;attempt++) {
   const c=await pool.getConnection();
   try { if(typeof c.query==='function')await c.query("SET time_zone='+00:00'");await c.beginTransaction(); const result=await fn(c); await c.commit(); return result; }
   catch(e) { await c.rollback().catch(()=>{}); if(attempt<2 && ['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT','ER_DUP_ENTRY'].includes(e.code)) continue; throw e; }
   finally { c.release(); }
  }
 }
 async function read(fn) {const c=await pool.getConnection();try{if(typeof c.query==='function')await c.query("SET time_zone='+00:00'");return await fn(c);}finally{c.release();}}
 async function loadContext(c,id) {
  const context=(await rows(c,'SELECT * FROM commerce_settlement_business_contexts WHERE id=?',[id]))[0];
  ensure(context && upper(context.execution_scope)==='INTERNAL_FUNDED','外部账单或缺少资金准入的订单不可执行','SETTLEMENT_SCOPE_DENIED');
  ensure(context.payment_mode==='pay_center','支付路径不允许内部资金执行');
  context.snapshot=parse(context.snapshot); context.profile=context.snapshot.settlement_profile;
  ensure(context.profile && context.profile.version && context.profile.contract_mapping_version,'结算合同快照不完整');
  ensure(['CONTROLLED_COLLECTION','PLATFORM_CONTROLLED','MERCHANT_CONTROLLED_RECEIPT'].includes(upper(context.profile.funding_mode)),'资金持有模式未支持或未核验');
  return context;
 }
 async function account(c,id,source) {
  const a=(await rows(c,'SELECT * FROM commerce_payment_accounts WHERE id=?',[id]))[0];
  ensure(a && ['ACTIVE','APPROVED'].includes(upper(a.status)),'机构账户未激活');
  ensure(a.provider===source.provider && a.environment===source.environment && a.currency===source.currency,'机构账户币种或环境不一致');
  if(source.provider===sytest.PROVIDER){sytest.assertSource(source);sytest.assertAccount(a);}
  a.capabilities=parse(a.capabilities); return a;
 }
 function capability(a,operation) {
  ensure(a.capabilities.evidence_ref,'账户缺少机构能力核验凭据');
  if(operation==='RECEIVE')ensure(a.capabilities.receive===true,'账户尚未核验收款能力');
  else ensure(Array.isArray(a.capabilities.operations) && a.capabilities.operations.includes(operation),'账户尚未核验此资金操作: '+operation);
 }
 async function lockSources(c,ids,{allowRefund=false,reconcile=false}={}) {
  const unique=[...new Set(ids)].sort();
  ensure(unique.length && unique.every(Boolean),'资金来源缺失；佣金到账后须绑定来源并重新授权');
  const sources=await rows(c,`SELECT * FROM commerce_funding_sources WHERE id IN (${unique.map(()=>'?').join(',')}) ORDER BY id`,unique);
  ensure(sources.length===unique.length,'资金来源不存在');
  // Shared order is business guard -> payment -> refund -> source -> item.
  // internal refunds and settlement admission against the same original receipt.
  const payments=[];
  for(const paymentId of [...new Set(sources.map(s=>s.payment_id).filter(Boolean))]) {
   const p=(await rows(c,'SELECT * FROM payment_orders WHERE id=?',[paymentId]))[0];ensure(p,'原支付不存在');payments.push(p);
  }
  payments.sort((a,b)=>(a.biz_type+':'+a.biz_order_no).localeCompare(b.biz_type+':'+b.biz_order_no)||String(a.id).localeCompare(String(b.id)));
  for(const p of payments) {
   const guard=(await rows(c,'SELECT biz_type FROM payment_order_guards WHERE biz_type=? AND biz_order_no=? FOR UPDATE',[p.biz_type,p.biz_order_no]))[0];ensure(guard,'原支付尚未进入共享支付保护域');
  }
  const externalRefunds=new Map();
  for(const old of payments) {
   const paymentId=old.id,p=(await rows(c,'SELECT * FROM payment_orders WHERE id=? FOR UPDATE',[paymentId]))[0];
   ensure(p && ['PAID','SUCCESS'].includes(upper(p.pay_status || p.status)),'原支付未确认到账');
   const refunds=await rows(c,'SELECT * FROM payment_refunds WHERE payment_order_id=? ORDER BY id FOR UPDATE',[paymentId]);
   const tracked=new Set((await rows(c,'SELECT request_key FROM commerce_execution_refund_plans')).map(r=>r.request_key));
   externalRefunds.set(String(paymentId),refunds.filter(r=>r.refund_status==='refunded'&&!tracked.has(r.idempotency_key)).reduce((sum,r)=>sum+minor(r.amount_minor),0n));
   if(!allowRefund) {
    const pending=(await rows(c,"SELECT COUNT(*) n FROM payment_refunds WHERE payment_order_id=? AND refund_status NOT IN ('voided','refunded')",[paymentId]))[0];
    ensure(!Number(pending.n),'原支付有处理中退款');
   }
  }
  const locked=await rows(c,`SELECT * FROM commerce_funding_sources WHERE id IN (${unique.map(()=>'?').join(',')}) ORDER BY id FOR UPDATE`,unique);
  for(const source of locked) {
   ensure(reconcile || ['AVAILABLE','CONFIRMED'].includes(upper(source.status)),'资金来源未确认或已冻结');
   if(source.payment_id) {
    const duplicate=(await rows(c,'SELECT COUNT(*) n FROM commerce_funding_sources WHERE payment_id=?',[source.payment_id]))[0];ensure(Number(duplicate.n)===1,'同一支付重复登记资金来源');
    const reflected=externalRefunds.get(String(source.payment_id))||0n,delta=reflected-amountOf(source.external_refunded_minor);
    ensure(delta>=0n,'成功退款事实不可减少');
    if(delta>0n) {await c.execute('UPDATE commerce_funding_sources SET returned_minor=returned_minor+?,external_refunded_minor=? WHERE id=?',[delta.toString(),reflected.toString(),source.id]);source.returned_minor=(amountOf(source.returned_minor)+delta).toString();source.external_refunded_minor=reflected.toString();}
   }
  }
  return new Map(locked.map(s=>[s.id,s]));
 }
 function free(source) {return amountOf(source.received_minor)-amountOf(source.reserved_minor)-amountOf(source.consumed_minor)-amountOf(source.returned_minor);}
 async function refundEconomicCapacity(c,source,amount,requestKey=null) {
  const units=await rows(c,"SELECT calculation FROM commerce_settlement_units WHERE source_id=? AND status='CONFIRMED' ORDER BY id FOR UPDATE",[source.id]);
  const committed=units.reduce((n,u)=>{const value=parse(u.calculation);return n+minor(value.merchant_minor)+minor(value.commission_minor);},0n);
  const refunds=source.payment_id?await rows(c,"SELECT idempotency_key,amount_minor FROM payment_refunds WHERE payment_order_id=? AND refund_status<>'voided'",[source.payment_id]):[];
  const refundAmount=source.payment_id?refunds.filter(r=>r.idempotency_key!==requestKey).reduce((n,r)=>n+minor(r.amount_minor),0n):amountOf(source.returned_minor);
  ensure(amountOf(source.received_minor)-committed-refundAmount>=amount,'已确认履约义务尚未撤销，不可退款','SETTLEMENT_REFUND_OBLIGATION_ACTIVE');
 }
 async function validateAuthorization(c,item,context,source,existingLine=false) {
  ensure(!item.hold_reason,'结算明细被暂停');
  const a=(await rows(c,'SELECT * FROM commerce_settlement_authorizations WHERE id=?',[item.authorization_id]))[0];
  ensure(a && ['AUTHORIZED','ACTIVE'].includes(upper(a.status)) && upper(a.purpose)==='FUND_EXECUTION','缺少有效资金执行授权');
  const snapshot=parse(a.snapshot), currentAmount=minor(item.planned_minor,true).toString();
  if(snapshot.policy_id) {const policy=(await rows(c,'SELECT status,version FROM commerce_settlement_policies WHERE id=?',[snapshot.policy_id]))[0];ensure(policy && upper(policy.status)==='APPROVED' && Number(policy.version)===Number(snapshot.policy_version),'执行策略已停用或版本变化，须重新授权');}
  if(context.biz_type==='booking'){const bp=require('./booking-policy.cjs'),policy=await bp.selectPolicy(c,context,item);ensure(policy&&policy.id===snapshot.policy_id,'民宿结算规则已变化，须重新授权');const timing=bp.assertDue(context,policy,clock());ensure(snapshot.booking_timing&&digest(snapshot.booking_timing)===digest(timing),'民宿结算日期或规则已变化，须重新授权');}
  ensure(a.hash===authorizationHash(snapshot),'执行授权快照被修改');
  ensure(String(a.item_id)===String(item.id) && Number(a.item_revision)===Number(item.revision),'执行授权版本已过期');
  ensure(!a.expires_at || sqlDate(a.expires_at)>clock(),'执行授权已到期');
  ensure(!item.not_before_at || sqlDate(item.not_before_at)<=clock(),'尚未到付款时间');
  const expected={item_id:String(item.id),item_revision:Number(item.revision),amount_minor:currentAmount,source_id:source.id,account_id:item.account_id,context_id:item.context_id,not_before_at:sqlDate(item.not_before_at),profile_version:Number(context.profile.version),funding_mode:context.profile.funding_mode,implicit_merchant_release:context.profile.implicit_merchant_release===true};
  for(const [key,value] of Object.entries(expected)) ensure(Object.hasOwn(snapshot,key) && json(snapshot[key])===json(value),'执行授权与当前要素不符: '+key);
  if(snapshot.account_version!=null) {const approvedAccount=await account(c,item.account_id,source);ensure(Number(snapshot.account_version)===Number(approvedAccount.version),'收款账户版本已变化，须重新授权');}
  ensure(snapshot.rule_hash===item.rule_ref,'分账规则版本已变化');
  const remaining=amountOf(item.payable_minor)-amountOf(item.discharged_minor)-amountOf(item.cancelled_minor)-amountOf(item.offset_minor);
  ensure(amountOf(item.reserved_minor)===(existingLine?minor(currentAmount):0n),'明细已有活动执行占用');
  ensure(minor(currentAmount)<=remaining,'执行超过剩余清偿额度');
  const used=(await rows(c,"SELECT COALESCE(SUM(amount_minor),0) amount FROM commerce_execution_lines WHERE authorization_id=? AND status='SUCCEEDED'",[a.id]))[0];
  ensure(amountOf(used.amount)===0n,'本次金额授权已清偿；分次剩余付款须重新授权');
  return {authorization:a,snapshot};
 }
 async function insertPlan(c,principal,input,snapshot) {
  ensure(typeof input.request_key==='string' && input.request_key.length>0 && input.request_key.length<=128,'需要幂等请求号');
  const fingerprint=digest(snapshot), prior=(await rows(c,'SELECT * FROM commerce_execution_plans WHERE created_by=? AND request_key=? FOR UPDATE',[actor(principal),input.request_key]))[0];
  if(prior) {ensure(prior.request_hash===fingerprint,'幂等请求号内容不一致');return {id:prior.id,exists:true};}
  const id=uuid(); await c.execute('INSERT INTO commerce_execution_plans(id,request_key,request_hash,created_by,status,snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',[id,input.request_key,fingerprint,actor(principal),'READY',json(snapshot),clock(),clock()]); return {id,exists:false};
 }
 async function putOrder(c,planId,principal,source,context,operation,effects,status='READY',extras={}) {
  const mock=sytest.assertRoute(config,context,source),port=mock?mockProvider:provider;
  const id=uuid(), requestNo='XS'+id.replaceAll('-',''), sourceAccount=await account(c,extras.payer_account_id||source.account_id,source);
  if(operation!=='REFUND')capability(sourceAccount,operation);
  const input={request_no:requestNo,source_id:source.id,payment_id:source.payment_id,contract_no:source.contract_no,payer_account_id:sourceAccount.id,payer_account_version:Number(sourceAccount.version),source_merchant_no:sourceAccount.merchant_no,currency:source.currency,amount_minor:effects.reduce((sum,l)=>sum+minor(l.amount_minor),0n).toString(),explicit_amount_minor:effects.filter(l=>!l.implicit).reduce((sum,l)=>sum+minor(l.amount_minor),0n).toString(),lines:effects.filter(l=>!l.implicit),effects,...extras};
  if(mock)input.demo={seed_key:sytest.SEED_KEY,scenario:context.snapshot.demo.scenario||'SUCCESS'};
  let built={};
  if(operation!=='REFUND'||mock) {
   const capability=port.contract(context.profile.contract_mapping_version,operation);
   ensure(capability.provider===source.provider && capability.environment===source.environment,'机构契约环境不匹配');
   built=port.build(context.profile.contract_mapping_version,operation,input);
  }
  await c.execute('INSERT INTO commerce_execution_orders(id,plan_id,context_id,source_id,operation,provider,environment,mapping_version,contract_hash,request_no,amount_minor,status,canonical_request,request_payload,query_payload,payload_hash,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,planId,context.id,source.id,operation,source.provider,source.environment,context.profile.contract_mapping_version,built.contract_hash||null,requestNo,input.amount_minor,status,json(input),built.submit?json(built.submit):null,built.query?json(built.query):null,built.submit?digest(built.submit):null,actor(principal),clock(),clock()]);
  for(const effect of effects) {
   await c.execute('INSERT INTO commerce_execution_lines(id,order_id,item_id,source_id,context_id,unit_id,account_id,effect_kind,amount_minor,authorization_id,authorization_hash,item_revision,original_line_id,status,snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[effect.id,id,effect.item_id||null,source.id,context.id,effect.unit_id||null,effect.account_id,effect.effect_kind,effect.amount_minor,effect.authorization_id||null,effect.authorization_hash||null,effect.item_revision||null,effect.original_line_id||null,status,json(effect),clock(),clock()]);
   await c.execute('INSERT INTO commerce_execution_allocations(line_id,item_id,source_id,reserved_minor,status) VALUES(?,?,?,?,?)',[effect.id,effect.item_id||null,source.id,['DRAFT','WAITING_DEPENDENCIES'].includes(status)?'0':effect.amount_minor,status]);
  }
  if(status==='READY') await enqueue(c,id);
  return id;
 }
 async function enqueue(c,orderId) {
  await c.execute("INSERT INTO commerce_execution_jobs(order_id,status,next_run_at,created_at) VALUES(?,'READY',?,?) ON DUPLICATE KEY UPDATE status=IF(status='RUNNING',status,'READY'),next_run_at=VALUES(next_run_at)",[orderId,clock(),clock()]);
 }
 async function getPlan(principal,input) {
  return read(async c=>{
   const plan=(await rows(c,'SELECT * FROM commerce_execution_plans WHERE id=?',[input.plan_id]))[0];ensure(plan,'执行计划不存在');
   plan.orders=await rows(c,'SELECT * FROM commerce_execution_orders WHERE plan_id=? ORDER BY id',[plan.id]);
   for(const order of plan.orders) { await permission(principal,'settlement.fund.read',await loadContext(c,order.context_id)); order.lines=await rows(c,'SELECT * FROM commerce_execution_lines WHERE order_id=? ORDER BY id',[order.id]); }
   return plan;
  });
 }
 async function createPlan(principal,input) {
  ensure(actor(principal),'操作人缺失');
  const ids=[...new Set((input.item_ids||[]).map(String))].sort(); ensure(ids.length>0 && ids.length<=100 && ids.every(v=>/^\d+$/.test(v)),'明细列表无效');
  const id=await tx(async c=>{
   const plan=await insertPlan(c,principal,input,{operation:'FUND_EXECUTION',item_ids:ids});if(plan.exists)return plan.id;
   let items=await rows(c,`SELECT * FROM commerce_settlement_items WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`,ids);ensure(items.length===ids.length,'结算明细不存在');
   const sources=await lockSources(c,items.map(i=>i.source_id));
   const modes=new Set();for(const source of sources.values())modes.add(sytest.assertRoute(config,await loadContext(c,source.context_id),source)?'mock':'real');
   ensure(modes.size===1,'模拟资金与真实资金不得进入同一执行计划','SYTEST_MIXED_PLAN_DENIED');
   items=await rows(c,`SELECT * FROM commerce_settlement_items WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY id FOR UPDATE`,ids);
   const groups=new Map();
   for(const item of items) {
    const source=sources.get(item.source_id);ensure(source && source.context_id===item.context_id,'资金来源或业务归属不匹配');
    const context=await loadContext(c,item.context_id);await permission(principal,'settlement.fund.write',context);ensure(context.currency===source.currency,'订单与来源币种不匹配');
    const receiver=await account(c,item.account_id,source);ensure(receiver.party_id===item.beneficiary_party_id,'收款账户受益方不匹配');capability(receiver,'RECEIVE');
    const validated=await validateAuthorization(c,item,context,source);
    let operation='SPLIT',effect='TRANSFER',implicit=false;
    const ownFunds=['platform_own','supplement'].includes(source.source_type),repayment=/^returned:/.test(item.component_key||'');
    if(ownFunds && repayment)ensure((await rows(c,"SELECT id FROM commerce_execution_returned WHERE repayment_item_id=? AND status='APPROVED'",[item.id])).length===1,'自有资金重付必须关联已核验退票');
    if((/^supplement:/.test(item.component_key||'') || repayment) && ownFunds) {
     ensure(['merchant','promoter','compensation'].includes(item.line_kind),'补差组件受益方类型无效');operation='PAYOUT';effect='PAYOUT';
    } else if(item.line_kind==='promoter') {
     ensure(source.source_type==='PLATFORM_COMMISSION','推广款必须来自已实际入账的平台佣金');
     const lot=(await rows(c,'SELECT * FROM commerce_commission_funding_lots WHERE source_id=? AND context_id=? AND unit_id=?',[source.id,context.id,item.unit_id]))[0];ensure(lot && upper(lot.status)==='AVAILABLE','佣金资金批次未到账');operation='PAYOUT';effect='PAYOUT';
    } else if(item.line_kind==='platform_transfer') {ensure(receiver.id===context.profile.platform_account_id,'平台佣金收款账户与合同不一致');effect='PLATFORM_TRANSFER';}
    else {ensure(item.line_kind==='merchant','未支持的结算组件');if(upper(context.profile.funding_mode)==='MERCHANT_CONTROLLED_RECEIPT') {
     if(receiver.id!==source.account_id)ensure(context.profile.directed_transfer_verified===true && context.profile.implicit_merchant_release!==true,'原款释放不能改收款账户；定向划转须另行核验并关闭隐含释放');
     else {effect='MERCHANT_RELEASE';implicit=context.profile.implicit_merchant_release===true;
      if(implicit){const [commission]=await rows(c,"SELECT COUNT(*) n FROM commerce_settlement_items WHERE source_id=? AND line_kind='platform_transfer' AND payable_minor>discharged_minor+cancelled_minor+offset_minor",[source.id]);if(!Number(commission.n))implicit=false;}
      operation=implicit?'SPLIT':'RELEASE';}
    }}
    const key=[source.id,operation,context.profile.contract_mapping_version].join(':');
    if(!groups.has(key)) groups.set(key,{source,context,operation,effects:[]});
    groups.get(key).effects.push({id:uuid(),item_id:String(item.id),unit_id:item.unit_id,account_id:receiver.id,account_version:Number(receiver.version),account_contract_no:receiver.contract_no,payee_merchant_no:receiver.merchant_no,effect_kind:effect,amount_minor:minor(item.planned_minor,true).toString(),authorization_id:validated.authorization.id,authorization_hash:validated.authorization.hash,item_revision:Number(item.revision),implicit});
   }
   const reserveTotals=new Map();
   for(const g of groups.values()) {
    if(g.operation==='SPLIT' && g.context.profile.implicit_merchant_release===true && upper(g.context.profile.funding_mode)==='MERCHANT_CONTROLLED_RECEIPT') {
     const merchants=await rows(c,"SELECT * FROM commerce_settlement_items WHERE source_id=? AND line_kind='merchant' AND payable_minor>discharged_minor+cancelled_minor+offset_minor FOR UPDATE",[g.source.id]);
     ensure(g.effects.some(e=>e.effect_kind==='PLATFORM_TRANSFER'),'隐含原款释放必须与平台划拨共同授权');
     for(const m of merchants) {const e=g.effects.find(e=>e.item_id===String(m.id));ensure(e && minor(e.amount_minor)===amountOf(m.payable_minor)-amountOf(m.discharged_minor)-amountOf(m.cancelled_minor)-amountOf(m.offset_minor),'机构隐含释放包含未授权或未到期商户款');}
     ensure(amountOf(g.source.reserved_minor)===0n && g.effects.reduce((n,e)=>n+minor(e.amount_minor),0n)===free(g.source),'机构隐含释放尚有未获授权的剩余原款；保留用途或未选B必须采用单独释放契约');
    }
    const total=g.effects.reduce((n,e)=>n+minor(e.amount_minor),0n);reserveTotals.set(g.source.id,(reserveTotals.get(g.source.id)||0n)+total);
    await putOrder(c,plan.id,principal,g.source,g.context,g.operation,g.effects);
    for(const e of g.effects) await c.execute("UPDATE commerce_settlement_items SET reserved_minor=reserved_minor+?,status='EXECUTING' WHERE id=?",[e.amount_minor,e.item_id]);
   }
   for(const [sourceId,amount] of reserveTotals) {ensure(free(sources.get(sourceId))>=amount,'已确认可用资金不足');await c.execute('UPDATE commerce_funding_sources SET reserved_minor=reserved_minor+? WHERE id=?',[amount.toString(),sourceId]);}
   return plan.id;
  }); return getPlan(principal,{plan_id:id});
 }
 async function event(c,order,line,kind,amount,evidence,key) {
  await c.execute('INSERT INTO commerce_execution_events(event_key,order_id,line_id,kind,amount_minor,evidence,created_at) VALUES(?,?,?,?,?,?,?)',[key||`${kind}:${line?.id||order.id}`,order.id,line?.id||null,kind,String(amount),json(evidence||{}),clock()]);
 }
 async function ledger(c,order,line,kind,debit,credit,amount) {
  await postLedger(c,{event_key:`execution:${kind}:${line.id}`,context_id:order.context_id,source_type:'settlement_execution',source_id:line.id,lines:[{account:debit,side:'debit',amount_minor:String(amount)},{account:credit,side:'credit',amount_minor:String(amount)}]});
 }
 async function releaseLine(c,order,line,kind) {
  const amount=minor(line.amount_minor);
  if(line.effect_kind==='RETURN') {
   await c.execute('UPDATE commerce_execution_lines SET return_reserved_minor=return_reserved_minor-? WHERE id=?',[amount.toString(),line.original_line_id]);
   const s=parse(line.snapshot);if(s.recovery_source_id) await c.execute('UPDATE commerce_funding_sources SET reserved_minor=reserved_minor-? WHERE id=?',[amount.toString(),s.recovery_source_id]);
  } else {
   await c.execute('UPDATE commerce_funding_sources SET reserved_minor=reserved_minor-? WHERE id=?',[amount.toString(),line.source_id]);
   if(line.item_id)await c.execute("UPDATE commerce_settlement_items SET reserved_minor=reserved_minor-?,status='AUTHORIZED' WHERE id=?",[amount.toString(),line.item_id]);
  }
  await c.execute('UPDATE commerce_execution_allocations SET reserved_minor=0,reservation_released_minor=reservation_released_minor+?,status=? WHERE line_id=?',[amount.toString(),kind,line.id]);
  await event(c,order,line,kind,amount,{});
 }
 async function successfulLine(c,order,line,result) {
  const amount=minor(line.amount_minor),snapshot=parse(line.snapshot);
  if(line.effect_kind==='RETURN') {
   const original=(await rows(c,'SELECT * FROM commerce_execution_lines WHERE id=? FOR UPDATE',[line.original_line_id]))[0];
   ensure(original && original.status==='SUCCEEDED' && amountOf(original.return_reserved_minor)>=amount,'原分账回退额度不匹配');
   await c.execute('UPDATE commerce_execution_lines SET returned_minor=returned_minor+?,return_reserved_minor=return_reserved_minor-? WHERE id=?',[amount.toString(),amount.toString(),original.id]);
   await c.execute('UPDATE commerce_execution_allocations SET returned_minor=returned_minor+? WHERE line_id=?',[amount.toString(),original.id]);
   await c.execute('UPDATE commerce_funding_sources SET consumed_minor=consumed_minor-? WHERE id=?',[amount.toString(),original.source_id]);
   if(snapshot.recovery_source_id) await c.execute('UPDATE commerce_funding_sources SET reserved_minor=reserved_minor-?,returned_minor=returned_minor+? WHERE id=?',[amount.toString(),amount.toString(),snapshot.recovery_source_id]);
   await ledger(c,order,line,'return',`settlement_cash:${original.source_id}`,snapshot.recovery_source_id?`settlement_cash:${snapshot.recovery_source_id}`:`settlement_recovery:${original.id}`,amount);
   await require('./reversal.cjs').recordRecovery(c,{original_line_id:original.id,amount_minor:amount.toString(),event_key:'RETURN:'+line.id,kind:'SPLIT_RETURN'});
  } else if(line.effect_kind==='REFUND') {
   const source=(await rows(c,'SELECT * FROM commerce_funding_sources WHERE id=?',[line.source_id]))[0],context=await loadContext(c,line.context_id);
   ensure(sytest.assertRoute(config,context,source)&&order.provider===sytest.PROVIDER,'消费者退款必须由独立模拟端口或统一支付入口确认','SYTEST_MOCK_SCOPE_DENIED');
   await c.execute('UPDATE commerce_funding_sources SET reserved_minor=reserved_minor-?,returned_minor=returned_minor+? WHERE id=?',[amount.toString(),amount.toString(),line.source_id]);
   await c.execute('UPDATE commerce_execution_refund_plans SET payment_refund_id=? WHERE order_id=?',[result.provider_line_id,order.id]);
   await ledger(c,order,line,'mock-refund',context.biz_type==='commerce'?'unredeemed_liability':'service_pending_liability',`settlement_cash:${line.source_id}`,amount);
  } else {
   await c.execute('UPDATE commerce_funding_sources SET reserved_minor=reserved_minor-?,consumed_minor=consumed_minor+? WHERE id=?',[amount.toString(),amount.toString(),line.source_id]);
   await c.execute("UPDATE commerce_settlement_items SET reserved_minor=reserved_minor-?,discharged_minor=discharged_minor+?,status=IF(discharged_minor+cancelled_minor+offset_minor>=payable_minor,'PAID','PARTIALLY_PAID') WHERE id=?",[amount.toString(),amount.toString(),line.item_id]);
   if(line.authorization_id)await c.execute("UPDATE commerce_settlement_authorizations SET status='CONSUMED' WHERE id=?",[line.authorization_id]);
   if(line.effect_kind==='PLATFORM_TRANSFER') {
    const source=(await rows(c,'SELECT * FROM commerce_funding_sources WHERE id=?',[line.source_id]))[0], child=uuid();
    const receivedAccount=(await rows(c,'SELECT * FROM commerce_payment_accounts WHERE id=?',[line.account_id]))[0];
    const childStatus=Number(receivedAccount.version)===snapshot.account_version && receivedAccount.merchant_no===snapshot.payee_merchant_no && ['ACTIVE','APPROVED'].includes(upper(receivedAccount.status))?'AVAILABLE':'FROZEN';
    await c.execute("INSERT INTO commerce_funding_sources(id,context_id,payment_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,NULL,'PLATFORM_COMMISSION',?,?,?,?,?,?,?,?)",[child,line.context_id,source.provider,source.environment,source.currency,line.account_id,snapshot.account_contract_no||source.contract_no,amount.toString(),childStatus,json({provider_line_id:result.provider_line_id,execution_line_id:line.id,source_id:source.id,account_version:snapshot.account_version,payee_merchant_no:snapshot.payee_merchant_no,...(source.provider===sytest.PROVIDER?{demo_seed_key:sytest.SEED_KEY}:{})})]);
    await c.execute("INSERT INTO commerce_commission_funding_lots(id,source_execution_line_id,source_id,context_id,unit_id,received_minor,status,created_at) VALUES(?,?,?,?,?,?,'AVAILABLE',?)",[uuid(),line.id,child,line.context_id,line.unit_id,amount.toString(),clock()]);
    await ledger(c,order,line,'success',`settlement_cash:${child}`,`settlement_cash:${line.source_id}`,amount);
   } else { const item=(await rows(c,'SELECT beneficiary_party_id FROM commerce_settlement_items WHERE id=?',[line.item_id]))[0]; await ledger(c,order,line,'success',`payable:${item.beneficiary_party_id}`,`settlement_cash:${line.source_id}`,amount); }
  }
  const allocationColumn=line.effect_kind==='REFUND'?'returned_minor':line.effect_kind==='MERCHANT_RELEASE'?'merchant_released_minor':'transferred_minor';
  await c.execute(`UPDATE commerce_execution_allocations SET reserved_minor=0,${allocationColumn}=${allocationColumn}+?,status='SUCCEEDED' WHERE line_id=?`,[amount.toString(),line.id]);
  await event(c,order,line,line.effect_kind+'_SUCCEEDED',amount,{provider_line_id:result.provider_line_id});
 }
 async function lockOrderResources(c,orderId) {
  const order=(await rows(c,'SELECT * FROM commerce_execution_orders WHERE id=?',[orderId]))[0];ensure(order,'执行子单不存在');
  let lines=await rows(c,'SELECT * FROM commerce_execution_lines WHERE order_id=? ORDER BY id',[orderId]);
  const extra=lines.map(l=>parse(l.snapshot).recovery_source_id).filter(Boolean);
  await lockSources(c,[order.source_id,...extra],{allowRefund:true,reconcile:true});
  const itemIds=lines.map(l=>l.item_id).filter(Boolean);
  if(itemIds.length)await rows(c,`SELECT id FROM commerce_settlement_items WHERE id IN (${itemIds.map(()=>'?').join(',')}) ORDER BY id FOR UPDATE`,itemIds);
  const current=(await rows(c,'SELECT * FROM commerce_execution_orders WHERE id=? FOR UPDATE',[orderId]))[0];
  lines=await rows(c,'SELECT * FROM commerce_execution_lines WHERE order_id=? ORDER BY id FOR UPDATE',[orderId]);return {order:current,lines};
 }
 async function updatePlanStatus(c,planId) {
  const orders=await rows(c,'SELECT status FROM commerce_execution_orders WHERE plan_id=?',[planId]);
  const status=orders.every(o=>o.status==='SUCCEEDED')?'SUCCEEDED':orders.every(o=>terminal(o.status))?'PARTIAL':orders.some(o=>o.status==='UNKNOWN')?'UNKNOWN':orders.every(o=>o.status==='DRAFT')?'DRAFT':'PROCESSING';
  await c.execute('UPDATE commerce_execution_plans SET status=?,updated_at=? WHERE id=?',[status,clock(),planId]);
 }
 async function applyReceipt(orderId,response,action) {
  return tx(async c=>{
   const {order,lines}=await lockOrderResources(c,orderId);
   const fingerprint=digest(response.raw);
   const prior=(await rows(c,'SELECT id FROM commerce_execution_receipts WHERE order_id=? AND digest=?',[orderId,fingerprint]))[0];
   if(!prior)await c.execute('INSERT INTO commerce_execution_receipts(id,order_id,source,digest,raw_payload,normalized,created_at) VALUES(?,?,?,?,?,?,?)',[uuid(),orderId,action,fingerprint,json(response.raw),json(response.normalized),clock()]);
   for(const result of response.normalized.lines) {
    const line=lines.find(l=>l.id===result.id);ensure(line,'机构返回不存在的明细');
    if(['SUCCEEDED','FAILED_FINAL','CANCELLED'].includes(line.status)) {ensure(!(line.status==='FAILED_FINAL' && result.status==='SUCCEEDED'),'机构已确认未扣款的终态发生矛盾','PROVIDER_TERMINAL_CONTRADICTION');continue;}
    if(result.status==='SUCCEEDED')await successfulLine(c,order,line,result);
    else if(result.status==='FAILED_FINAL')await releaseLine(c,order,line,'FAILED_RELEASED');
    await c.execute('UPDATE commerce_execution_lines SET status=?,provider_line_id=COALESCE(?,provider_line_id),updated_at=? WHERE id=?',[result.status,result.provider_line_id||null,clock(),line.id]);line.status=result.status;
   }
   const complete=lines.every(l=>['SUCCEEDED','FAILED_FINAL','CANCELLED'].includes(l.status));
   const status=complete?(lines.every(l=>l.status==='SUCCEEDED')?'SUCCEEDED':lines.every(l=>l.status==='FAILED_FINAL')?'FAILED_FINAL':'PARTIAL'):'UNKNOWN';
   await c.execute('UPDATE commerce_execution_orders SET status=?,provider_order_no=COALESCE(?,provider_order_no),completed_at=?,updated_at=?,last_error=NULL WHERE id=?',[status,response.normalized.provider_order_no,complete?clock():null,clock(),orderId]);
   await updatePlanStatus(c,order.plan_id);return status;
  });
 }
 async function prepare(orderId) {
  return tx(async c=>{
   const {order,lines}=await lockOrderResources(c,orderId);
   if(terminal(order.status))return {order,skip:true};
   ensure(order.status!=='DRAFT','逆向单未审批');
   const context=await loadContext(c,order.context_id),source=(await rows(c,'SELECT * FROM commerce_funding_sources WHERE id=?',[order.source_id]))[0];
   const mock=sytest.assertRoute(config,context,source),port=mock?mockProvider:provider;
   if(mock){
    ensure(order.provider===sytest.PROVIDER&&order.environment===sytest.ENVIRONMENT,'模拟执行记录归属不符','SYTEST_MOCK_SCOPE_DENIED');
    for(const accountId of new Set([parse(order.canonical_request).payer_account_id,...lines.map(l=>l.account_id)])){const a=(await rows(c,'SELECT * FROM commerce_payment_accounts WHERE id=?',[accountId]))[0];ensure(a,'模拟账户不存在');sytest.assertAccount(a);}
   }
   if(order.operation==='REFUND')return {order,refund:true,mock};
   let action='query';
   if(order.status==='READY' && !order.submitted_at) {
    ensure(port.build(order.mapping_version,order.operation,parse(order.canonical_request)).contract_hash===order.contract_hash,'机构契约已变化，禁止发送旧计划','PROVIDER_CONTRACT_CHANGED');
    ensure(['AVAILABLE','CONFIRMED'].includes(upper(source.status)),'资金来源执行前被冻结');
    const canonical=parse(order.canonical_request),payer=await account(c,canonical.payer_account_id,source);
    ensure(Number(payer.version)===canonical.payer_account_version,'机构付款账户版本变化');capability(payer,order.operation);
    for(const line of lines) {
     if(line.item_id) {
      const item=(await rows(c,'SELECT * FROM commerce_settlement_items WHERE id=?',[line.item_id]))[0];
      const valid=await validateAuthorization(c,item,context,source,true);ensure(valid.authorization.hash===line.authorization_hash,'执行占用后的授权发生变化');
     }
     const a=await account(c,line.account_id,source);ensure(Number(a.version)===Number(parse(line.snapshot).account_version),'收款账户版本已变化');
    }
    ensure(digest(parse(order.request_payload))===order.payload_hash,'机构请求快照发生变化');
    await c.execute("UPDATE commerce_execution_orders SET status='SUBMITTING',submitted_at=?,updated_at=? WHERE id=?",[clock(),clock(),orderId]);action='submit';
   }
   return {order,action,mock};
  });
 }
 async function claimJob(orderIds=null) {
  return tx(async c=>{
   const mockOnly=sytest.enabled(config)&&config.execution_enabled!==true;
   const job=(await rows(c,"SELECT * FROM commerce_execution_jobs WHERE status IN ('READY','RETRY','RUNNING') AND next_run_at<=? AND (lease_until IS NULL OR lease_until<?)"+(mockOnly?" AND order_id IN (SELECT o.id FROM commerce_execution_orders o JOIN commerce_settlement_business_contexts x ON x.id=o.context_id JOIN commerce_funding_sources s ON s.id=o.source_id WHERE o.provider='SYTEST_MOCK' AND o.environment='SANDBOX' AND JSON_UNQUOTE(JSON_EXTRACT(x.snapshot,'$.demo.seed_key'))='settlement-walkthrough-v1' AND JSON_UNQUOTE(JSON_EXTRACT(s.evidence,'$.demo_seed_key'))='settlement-walkthrough-v1')":"")+(orderIds?' AND order_id IN ('+orderIds.map(()=>'?').join(',')+')':'')+" ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",[clock(),clock(),...(orderIds||[])]))[0];
   if(!job)return null;const token=uuid();await c.execute("UPDATE commerce_execution_jobs SET status='RUNNING',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?",[token,after(Number(config.lease_seconds)||60),job.id]);return {...job,lease_token:token};
  });
 }
 async function runJobs({limit=10,order_ids}={}) {
  ensure(Number.isInteger(limit) && limit>0 && limit<=100,'worker limit 无效');const results=[];
  let orderIds=null;if(order_ids!==undefined){ensure(Array.isArray(order_ids)&&order_ids.length<=100&&order_ids.every(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id)),'worker order_ids 无效');orderIds=[...new Set(order_ids)];if(!orderIds.length)return results;}
  for(let n=0;n<limit;n++) {
   const job=await claimJob(orderIds);if(!job)break;let status,error;
   try {
    const ready=await prepare(job.order_id);
    if(ready.skip)status=ready.order.status;
    else if(ready.refund)status=await processRefund(ready.order,ready.mock);
    else status=await applyReceipt(job.order_id,await (ready.mock?mockProvider:provider).invoke(ready.order,ready.action),ready.action);
   }catch(e) {
    error=e;status='UNKNOWN';
    await tx(async c=>{
     if(e.provider_raw!==undefined)await c.execute('INSERT IGNORE INTO commerce_execution_receipts(id,order_id,source,digest,raw_payload,normalized,created_at) VALUES(?,?,?,?,?,?,?)',[uuid(),job.order_id,'REJECTED',digest(e.provider_raw),json(e.provider_raw),json({error:e.code||e.message}),clock()]);
     await c.execute("UPDATE commerce_execution_orders SET status=IF(status='READY','READY',IF(status IN ('SUCCEEDED','PARTIAL','FAILED_FINAL','CANCELLED'),status,'UNKNOWN')),last_error=?,updated_at=? WHERE id=?",[String(e.message).slice(0,255),clock(),job.order_id]);
    });
   }
   await tx(async c=>{await c.execute('UPDATE commerce_execution_jobs SET status=?,next_run_at=?,lease_until=NULL,lease_token=NULL,last_error=? WHERE id=? AND lease_token=?',[terminal(status)?'DONE':'RETRY',after(Number(config.poll_seconds)||30),error?String(error.message).slice(0,255):null,job.id,job.lease_token]);});
   results.push({order_id:job.order_id,status,error:error?.code||error?.message||null});
  } return results;
 }
 async function query(principal,input) {
  return tx(async c=>{const o=(await rows(c,'SELECT * FROM commerce_execution_orders WHERE id=? FOR UPDATE',[input.order_id]))[0];ensure(o,'子单不存在');await permission(principal,'settlement.fund.read',await loadContext(c,o.context_id));ensure(o.status!=='DRAFT','逆向未审批');if(!terminal(o.status))await enqueue(c,o.id);return o;});
 }
 async function retry(principal,input) {
  await read(async c=>{const o=(await rows(c,'SELECT context_id FROM commerce_execution_orders WHERE id=?',[input.order_id]))[0];ensure(o,'子单不存在');await permission(principal,'settlement.fund.write',await loadContext(c,o.context_id));});
  // UNKNOWN, timed-out and partially observed requests always query the SAME
  // request number. A definitive no-debit line needs a NEW approval/plan.
  return query(principal,input);
 }
 async function cancel(principal,input) {
  return tx(async c=>{
   const orders=await rows(c,'SELECT * FROM commerce_execution_orders WHERE plan_id=? ORDER BY source_id,id',[input.plan_id]);ensure(orders.length,'计划不存在');
   for(const original of orders) {
    const {order,lines}=await lockOrderResources(c,original.id);await permission(principal,'settlement.fund.write',await loadContext(c,order.context_id));ensure(!order.submitted_at && ['READY','DRAFT'].includes(order.status),'请求可能已送达，必须查原请求号，不能取消或释放预占');
    for(const line of lines) {if(order.status==='READY')await releaseLine(c,order,line,'CANCELLED_RELEASED');await c.execute("UPDATE commerce_execution_lines SET status='CANCELLED' WHERE id=?",[line.id]);}
    await c.execute("UPDATE commerce_execution_orders SET status='CANCELLED',completed_at=?,updated_at=? WHERE id=?",[clock(),clock(),order.id]);await c.execute("UPDATE commerce_execution_jobs SET status='DONE',lease_until=NULL WHERE order_id=?",[order.id]);
   }await c.execute("UPDATE commerce_execution_plans SET status='CANCELLED',updated_at=? WHERE id=?",[clock(),input.plan_id]);return {plan_id:input.plan_id,status:'CANCELLED'};
  });
 }
 async function createReturn(principal,input) {
  ensure(actor(principal),'操作人缺失');const amount=minor(input.amount_minor,true);
  ensure(typeof input.reason==='string' && input.reason.trim(),'回退需要原因');
  const id=await tx(async c=>{
   const plan=await insertPlan(c,principal,input,{operation:'RETURN',line_id:input.line_id,amount_minor:amount.toString(),reason:input.reason});if(plan.exists)return plan.id;
   const original=(await rows(c,'SELECT * FROM commerce_execution_lines WHERE id=?',[input.line_id]))[0];ensure(original && original.status==='SUCCEEDED' && ['TRANSFER','PLATFORM_TRANSFER','PAYOUT'].includes(original.effect_kind),'原明细不可分账回退');
   const sources=await lockSources(c,[original.source_id],{allowRefund:true}), source=sources.get(original.source_id),context=await loadContext(c,original.context_id);await permission(principal,'settlement.fund.write',context);
   const payer=await account(c,original.account_id,source), payee=await account(c,source.account_id,source);
   let recoverySource=null;
   if(original.effect_kind==='PLATFORM_TRANSFER') {const lot=(await rows(c,'SELECT * FROM commerce_commission_funding_lots WHERE source_execution_line_id=?',[original.id]))[0];ensure(lot,'原平台款没有实际到账lot');recoverySource=lot.source_id;}
   const effect={id:uuid(),original_line_id:original.id,account_id:source.account_id,account_version:Number(payee.version),payee_merchant_no:payee.merchant_no,effect_kind:'RETURN',amount_minor:amount.toString(),recovery_source_id:recoverySource,original_provider_line_id:original.provider_line_id};
   await putOrder(c,plan.id,principal,source,context,'RETURN',[effect],'DRAFT',{payer_account_id:payer.id,source_merchant_no:payer.merchant_no,original_request_no:(await rows(c,'SELECT request_no FROM commerce_execution_orders WHERE id=?',[original.order_id]))[0].request_no});
   await c.execute("UPDATE commerce_execution_plans SET status='DRAFT' WHERE id=?",[plan.id]);return plan.id;
  });return getPlan(principal,{plan_id:id});
 }
 async function createRefund(principal,input) {
  ensure(actor(principal),'操作人缺失');
  const amount=minor(input.amount_minor,true),deps=[...new Set(input.return_line_ids||[])].sort();
  const id=await tx(async c=>{
   const plan=await insertPlan(c,principal,input,{operation:'REFUND',source_id:input.source_id,context_id:input.context_id,amount_minor:amount.toString(),dependencies:deps,reason:input.reason||''});if(plan.exists)return plan.id;
   const sources=await lockSources(c,[input.source_id],{allowRefund:true}),source=sources.get(input.source_id),context=await loadContext(c,input.context_id);await permission(principal,'settlement.fund.write',context);
   const mock=sytest.assertRoute(config,context,source);
   if(!mock)ensure(paymentCore && typeof paymentCore.requestRefund==='function','统一退款能力未接入');
   ensure(source.context_id===context.id && (mock?source.source_type==='PAYMENT':source.payment_id&&source.source_type!=='PLATFORM_COMMISSION'),'退款必须绑定原支付来源');
   await refundEconomicCapacity(c,source,amount);
   for(const dep of deps) {const line=(await rows(c,"SELECT * FROM commerce_execution_lines WHERE id=? AND effect_kind='RETURN'",[dep]))[0];ensure(line && line.source_id===source.id && line.context_id===context.id,'回退依赖归属不符');}
   const a=await account(c,source.account_id,source),line={id:uuid(),account_id:a.id,account_version:Number(a.version),payee_merchant_no:a.merchant_no,effect_kind:'REFUND',amount_minor:amount.toString()};
   const orderId=await putOrder(c,plan.id,principal,source,context,'REFUND',[line],'DRAFT');
   const payment=mock?null:(await rows(c,'SELECT * FROM payment_orders WHERE id=?',[source.payment_id]))[0];
   const refundInput={bizType:context.biz_type,orderId:context.biz_order_no,paymentId:mock?null:String(source.payment_id),requestKey:'settlement:'+orderId,amountMinor:Number(amount),reason:input.reason||'settlement refund',source:mock?'sytest-mock':'settlement',reference:{execution_order_id:orderId,context_id:context.id},...(mock?{demo_seed_key:sytest.SEED_KEY}:{})};
   const paymentOrderNo=context.biz_type==='commerce'?String(context.biz_order_no).replaceAll('-','').toLowerCase():String(context.biz_order_no);
   ensure(amount<=BigInt(Number.MAX_SAFE_INTEGER) && (mock||payment&&payment.biz_type===context.biz_type && String(payment.biz_order_no)===paymentOrderNo),'原支付与业务订单不符或金额超统一退款接口范围');
   await c.execute('INSERT INTO commerce_execution_refund_plans(order_id,amount_minor,dependencies,request_key,refund_input) VALUES(?,?,?,?,?)',[orderId,amount.toString(),json(deps),refundInput.requestKey,json(refundInput)]);await c.execute("UPDATE commerce_execution_plans SET status='DRAFT' WHERE id=?",[plan.id]);return plan.id;
  });return getPlan(principal,{plan_id:id});
 }
 async function approveReverse(principal,input) {
  return tx(async c=>{
   const {order,lines}=await lockOrderResources(c,input.order_id);await permission(principal,'settlement.fund.review',await loadContext(c,order.context_id));ensure(order.created_by!==actor(principal),'逆向申请人不能审批自己的资金单');ensure(['RETURN','REFUND'].includes(order.operation),'不是逆向申请');
   if(order.status!=='DRAFT')return order;ensure(input.approve===true,'需要明确批准');
   if(order.operation==='REFUND') {const source=(await rows(c,'SELECT * FROM commerce_funding_sources WHERE id=?',[order.source_id]))[0],refund=(await rows(c,'SELECT request_key FROM commerce_execution_refund_plans WHERE order_id=?',[order.id]))[0];await refundEconomicCapacity(c,source,minor(order.amount_minor),refund.request_key);}
   if(order.operation==='RETURN')for(const line of lines) {
    const original=(await rows(c,'SELECT * FROM commerce_execution_lines WHERE id=? FOR UPDATE',[line.original_line_id]))[0],amount=minor(line.amount_minor),snapshot=parse(line.snapshot);
    ensure(original && original.status==='SUCCEEDED' && amount<=amountOf(original.amount_minor)-amountOf(original.returned_minor)-amountOf(original.return_reserved_minor)-amountOf(original.bank_returned_minor),'回退超过原成功金额');
    if(snapshot.recovery_source_id) {const source=(await rows(c,'SELECT * FROM commerce_funding_sources WHERE id=?',[snapshot.recovery_source_id]))[0];ensure(free(source)>=amount,'平台佣金已用于推广，须先回收或另用自有资金退款');await c.execute('UPDATE commerce_funding_sources SET reserved_minor=reserved_minor+? WHERE id=?',[amount.toString(),source.id]);}
    await c.execute('UPDATE commerce_execution_lines SET return_reserved_minor=return_reserved_minor+? WHERE id=?',[amount.toString(),original.id]);await c.execute("UPDATE commerce_execution_allocations SET reserved_minor=?,status='READY' WHERE line_id=?",[amount.toString(),line.id]);
   }
   const status=order.operation==='REFUND'?'WAITING_DEPENDENCIES':'READY';await c.execute('UPDATE commerce_execution_orders SET approved_by=?,status=?,updated_at=? WHERE id=?',[actor(principal),status,clock(),order.id]);await c.execute('UPDATE commerce_execution_lines SET status=? WHERE order_id=?',[status,order.id]);await enqueue(c,order.id);await updatePlanStatus(c,order.plan_id);return {order_id:order.id,status};
  });
 }
 async function processRefund(order,mock=false) {
  const prepared=await tx(async c=>{
   const locked=await lockOrderResources(c,order.id), current=locked.order;
   const refund=(await rows(c,'SELECT * FROM commerce_execution_refund_plans WHERE order_id=? FOR UPDATE',[order.id]))[0];
   ensure(current.approved_by,'退款未审批');
   for(const dep of parse(refund.dependencies,[])) {const line=(await rows(c,'SELECT status FROM commerce_execution_lines WHERE id=?',[dep]))[0];if(line?.status!=='SUCCEEDED')return {waiting:true};}
   if(!refund.source_reserved) {
    const source=(await rows(c,'SELECT * FROM commerce_funding_sources WHERE id=?',[order.source_id]))[0];ensure(free(source)>=minor(refund.amount_minor),'原支付可退资金不足，等待回退');
    await refundEconomicCapacity(c,source,minor(refund.amount_minor),refund.request_key);
    await c.execute('UPDATE commerce_funding_sources SET reserved_minor=reserved_minor+? WHERE id=?',[String(refund.amount_minor),source.id]);await c.execute('UPDATE commerce_execution_refund_plans SET source_reserved=1 WHERE order_id=?',[order.id]);await c.execute("UPDATE commerce_execution_allocations SET reserved_minor=?,status='READY' WHERE line_id=?",[String(refund.amount_minor),locked.lines[0].id]);
   }
   await c.execute("UPDATE commerce_execution_orders SET status='SUBMITTING',submitted_at=COALESCE(submitted_at,?),updated_at=? WHERE id=?",[clock(),clock(),order.id]);return {refund};
  });if(prepared.waiting)return 'WAITING_DEPENDENCIES';
  if(mock)return applyReceipt(order.id,await mockProvider.invoke(order,order.submitted_at?'query':'submit'),order.submitted_at?'query':'submit');
  // This method only creates a durable unified payment refund/outbox. It never
  // calls an institution while our source/item transaction holds locks.
  const response=await paymentCore.requestRefund(parse(prepared.refund.refund_input));
  return tx(async c=>{
   const {order:current,lines}=await lockOrderResources(c,order.id),line=lines[0];if(current.status==='SUCCEEDED')return 'SUCCEEDED';
   const paymentRefund=(await rows(c,'SELECT * FROM payment_refunds WHERE id=?',[response.refund_id||response.id]))[0],input=parse(prepared.refund.refund_input);
   ensure(paymentRefund && String(paymentRefund.payment_order_id)===String(input.paymentId) && String(paymentRefund.amount_minor)===String(prepared.refund.amount_minor) && paymentRefund.idempotency_key===input.requestKey,'退款记录与原支付不匹配');
   await c.execute('UPDATE commerce_execution_refund_plans SET payment_refund_id=? WHERE order_id=?',[String(paymentRefund.id),order.id]);
   if(paymentRefund.refund_status!=='refunded')return 'UNKNOWN';
   const amount=minor(prepared.refund.amount_minor);await c.execute('UPDATE commerce_funding_sources SET reserved_minor=reserved_minor-?,returned_minor=returned_minor+? WHERE id=?',[amount.toString(),amount.toString(),order.source_id]);
   await c.execute("UPDATE commerce_execution_lines SET status='SUCCEEDED',provider_line_id=?,updated_at=? WHERE id=?",[String(paymentRefund.id),clock(),line.id]);await c.execute("UPDATE commerce_execution_allocations SET reserved_minor=0,returned_minor=?,status='SUCCEEDED' WHERE line_id=?",[amount.toString(),line.id]);
   // paymentCore owns the cash-refund ledger. This event links its receipt to
   // settlement; posting cash here again would duplicate the original refund.
   await event(c,order,line,'REFUND_SUCCEEDED',amount,{payment_refund_id:String(paymentRefund.id)});
   await c.execute("UPDATE commerce_execution_orders SET status='SUCCEEDED',completed_at=?,updated_at=? WHERE id=?",[clock(),clock(),order.id]);await updatePlanStatus(c,order.plan_id);return 'SUCCEEDED';
  });
 }
 async function recordReturned(principal,input) {
  ensure(actor(principal),'操作人缺失');const amount=minor(input.amount_minor,true);
  ensure(input.evidence_key && input.evidence && input.evidence.provider_receipt,'退票必须提供唯一机构凭证');
  return tx(async c=>{
   const prior=(await rows(c,'SELECT * FROM commerce_execution_returned WHERE evidence_key=? FOR UPDATE',[input.evidence_key]))[0];if(prior){const stored=(await rows(c,'SELECT context_id FROM commerce_execution_lines WHERE id=?',[prior.line_id]))[0];await permission(principal,'settlement.fund.write',await loadContext(c,stored.context_id));ensure(prior.line_id===input.line_id && String(prior.amount_minor)===amount.toString() && digest(parse(prior.evidence))===digest(input.evidence),'退票凭证重复但内容不同');return prior;}
   const line=(await rows(c,'SELECT * FROM commerce_execution_lines WHERE id=?',[input.line_id]))[0];ensure(line && line.status==='SUCCEEDED' && ['TRANSFER','PAYOUT'].includes(line.effect_kind),'退票必须关联原成功出款');
   await permission(principal,'settlement.fund.write',await loadContext(c,line.context_id));const id=uuid();await c.execute("INSERT INTO commerce_execution_returned(id,line_id,evidence_key,amount_minor,evidence,created_by,status,created_at) VALUES(?,?,?,?,?,?,'DRAFT',?)",[id,line.id,input.evidence_key,amount.toString(),json(input.evidence),actor(principal),clock()]);return {id,status:'DRAFT'};
  });
 }
 async function approveReturned(principal,input) {
  return tx(async c=>{
   const initial=(await rows(c,'SELECT * FROM commerce_execution_returned WHERE id=?',[input.returned_id]))[0];ensure(initial,'退票记录不存在');
   const original=(await rows(c,'SELECT * FROM commerce_execution_lines WHERE id=?',[initial.line_id]))[0];const {order}=await lockOrderResources(c,original.order_id);await permission(principal,'settlement.fund.review',await loadContext(c,order.context_id));
   const returned=(await rows(c,'SELECT * FROM commerce_execution_returned WHERE id=? FOR UPDATE',[input.returned_id]))[0];if(returned.status==='APPROVED')return returned;
   ensure(returned.created_by!==actor(principal) && input.approve===true,'退票需另一人核验批准');
   const line=(await rows(c,'SELECT * FROM commerce_execution_lines WHERE id=? FOR UPDATE',[returned.line_id]))[0],amount=minor(returned.amount_minor);
   ensure(amount<=amountOf(line.amount_minor)-amountOf(line.returned_minor)-amountOf(line.return_reserved_minor)-amountOf(line.bank_returned_minor),'退票超过未回收原成功金额');
   await c.execute('UPDATE commerce_execution_lines SET bank_returned_minor=bank_returned_minor+? WHERE id=?',[amount.toString(),line.id]);await c.execute('UPDATE commerce_funding_sources SET consumed_minor=consumed_minor-? WHERE id=?',[amount.toString(),line.source_id]);
   const oldItem=(await rows(c,'SELECT * FROM commerce_settlement_items WHERE id=?',[line.item_id]))[0];ensure(oldItem,'退票缺少原应付组件');
   const recovered=await require('./reversal.cjs').recordRecovery(c,{original_line_id:line.id,amount_minor:amount.toString(),event_key:'RETURNED:'+returned.id,kind:'BANK_RETURN'});
   let repaymentId=null;
   if(!recovered) {
    const [unit]=line.unit_id?await rows(c,'SELECT status FROM commerce_settlement_units WHERE id=?',[line.unit_id]):[];ensure(unit?.status!=='REVERSED','撤销单位的退票必须关联原追偿');
    const [inserted]=await c.execute("INSERT INTO commerce_settlement_items(context_id,unit_id,component_key,line_kind,beneficiary_party_id,account_id,source_id,rule_ref,basis_minor,payable_minor,planned_minor,original_payable_minor,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT')",[line.context_id,line.unit_id,'returned:'+returned.id,oldItem.line_kind,oldItem.beneficiary_party_id,line.account_id,line.source_id,oldItem.rule_ref,String(oldItem.basis_minor),amount.toString(),amount.toString(),amount.toString()]);repaymentId=String(inserted.insertId);
   }
   await event(c,order,line,'RETURNED',amount,{returned_id:returned.id,evidence:parse(returned.evidence)},'RETURNED:'+returned.id);
   await postLedger(c,{event_key:'execution:returned:'+returned.id,context_id:line.context_id,source_type:'settlement_returned',source_id:returned.id,lines:[{account:'settlement_cash:'+line.source_id,side:'debit',amount_minor:amount.toString()},{account:recovered?'settlement_recovery:'+line.id:'payable:'+oldItem.beneficiary_party_id,side:'credit',amount_minor:amount.toString()}]});
   // The original paid/discharged history is immutable. A new reviewed component
   // must consume this repayment obligation before another disbursement.
   await c.execute("UPDATE commerce_execution_returned SET status='APPROVED',approved_by=?,repayment_item_id=? WHERE id=?",[actor(principal),repaymentId,returned.id]);return {id:returned.id,status:'APPROVED',repayment_minor:recovered?'0':amount.toString(),repayment_item_id:repaymentId,recovery_id:recovered?.id||null};
  });
 }
 async function listPlans(principal,input={}) {
  return read(async c=>{const plans=await rows(c,'SELECT * FROM commerce_execution_plans ORDER BY created_at DESC LIMIT 100'),out=[];
   for(const plan of plans){try{const orders=await rows(c,'SELECT DISTINCT context_id FROM commerce_execution_orders WHERE plan_id=?',[plan.id]);if(!orders.length)continue;for(const order of orders)await permission(principal,'settlement.fund.read',await loadContext(c,order.context_id));out.push(plan);}catch(e){if(e.status!==403)throw e;}}
   return {rows:out};
  });
 }
 async function verifyInvariants(principal,input={}) {
  await permission(principal,'settlement.fund.read',{});
  return read(async c=>{
   const errors=[];
   const sources=await rows(c,'SELECT * FROM commerce_funding_sources');for(const s of sources)if(BigInt(s.received_minor)-BigInt(s.reserved_minor)-BigInt(s.consumed_minor)-BigInt(s.returned_minor)<0n || ['reserved_minor','consumed_minor','returned_minor'].some(k=>BigInt(s[k])<0n))errors.push({kind:'SOURCE_CONSERVATION',id:s.id});
   const items=await rows(c,'SELECT * FROM commerce_settlement_items WHERE context_id IS NOT NULL');for(const i of items)if(['discharged_minor','reserved_minor','cancelled_minor','offset_minor'].some(k=>BigInt(i[k])<0n)||BigInt(i.discharged_minor)+BigInt(i.reserved_minor)+BigInt(i.cancelled_minor)+BigInt(i.offset_minor)>BigInt(i.payable_minor))errors.push({kind:'ITEM_QUOTA',id:String(i.id)});
   const duplicates=await rows(c,"SELECT item_id,COUNT(*) n FROM commerce_execution_lines WHERE item_id IS NOT NULL AND status NOT IN ('SUCCEEDED','FAILED_FINAL','CANCELLED') GROUP BY item_id HAVING COUNT(*)>1");for(const d of duplicates)errors.push({kind:'ACTIVE_ITEM_DUPLICATE',id:String(d.item_id)});
   return {ok:!errors.length,errors};
  });
 }
 return {createPlan,getPlan,listPlans,query,retry,cancel,createReturn,createRefund,approveReverse,recordReturned,approveReturned,runJobs,verifyInvariants};
}
module.exports={createExecution,authorizationHash};
