'use strict';
const {assert,id,rows,parse,minor,hash,sqlDate,transaction,postLedger}=require('./primitives.cjs');
const ddl=[
 `CREATE TABLE IF NOT EXISTS commerce_own_fund_receipts(id VARCHAR(36) PRIMARY KEY,source_id VARCHAR(36) NOT NULL UNIQUE,context_id VARCHAR(36) NOT NULL,account_id VARCHAR(36) NOT NULL,provider VARCHAR(32) NOT NULL,environment VARCHAR(24) NOT NULL,provider_reference VARCHAR(128) NOT NULL,currency CHAR(3) NOT NULL,amount_minor BIGINT NOT NULL,evidence_ref VARCHAR(500) NOT NULL,payload_hash CHAR(64) NOT NULL,status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',created_by VARCHAR(64) NOT NULL,reviewed_by VARCHAR(64) NULL,review_note VARCHAR(1000) NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,reviewed_at DATETIME NULL,UNIQUE KEY uk_own_receipt(provider,environment,provider_reference)) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_real_compensations(id VARCHAR(36) PRIMARY KEY,context_id VARCHAR(36) NOT NULL,original_unit_id VARCHAR(36) NOT NULL,source_id VARCHAR(36) NOT NULL,beneficiary_party_id VARCHAR(64) NOT NULL,account_id VARCHAR(36) NOT NULL,account_version INT NOT NULL,currency CHAR(3) NOT NULL,amount_minor BIGINT NOT NULL,case_ref VARCHAR(128) NOT NULL,evidence_ref VARCHAR(500) NOT NULL,reason VARCHAR(1000) NOT NULL,payload_hash CHAR(64) NOT NULL,status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',item_id BIGINT NULL UNIQUE,created_by VARCHAR(64) NOT NULL,reviewed_by VARCHAR(64) NULL,review_note VARCHAR(1000) NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,approved_at DATETIME NULL,UNIQUE KEY uk_comp_case(context_id,case_ref)) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_compensation_recoveries(id VARCHAR(36) PRIMARY KEY,compensation_id VARCHAR(36) NOT NULL UNIQUE,context_id VARCHAR(36) NOT NULL,debtor_party_id VARCHAR(64) NOT NULL,creditor_party_id VARCHAR(64) NOT NULL,currency CHAR(3) NOT NULL,amount_minor BIGINT NOT NULL,activated_minor BIGINT NOT NULL DEFAULT 0,recovered_minor BIGINT NOT NULL DEFAULT 0,return_due_minor BIGINT NOT NULL DEFAULT 0,sync_version INT NOT NULL DEFAULT 0,status VARCHAR(24) NOT NULL DEFAULT 'PENDING_PAYMENT',created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB`,
];
async function migrate(c){
 for(const sql of ddl)await c.query(sql);
 const column=require('./schema.cjs').column;
 await column(c,'commerce_compensation_recoveries','return_due_minor','BIGINT NOT NULL DEFAULT 0');
 await column(c,'commerce_compensation_recoveries','sync_version','INT NOT NULL DEFAULT 0');
}
function createOwnFunds({pool,workflow,authorize}){
 const actor=p=>String(p.account.id),text=(v,name,max)=>{assert(typeof v==='string'&&v.trim().length>0&&v.length<=max,name+'无效',422);return v.trim();};
 async function context(c,contextId){const ctx=await workflow.context(c,contextId);assert(ctx.payment_mode==='pay_center'&&ctx.execution_scope==='INTERNAL_FUNDED'&&ctx.currency,'仅支持已接入真实站内结算的订单',409);assert(ctx.snapshot?.is_demo!==true&&ctx.snapshot?.initialization?.mode!=='demo','演示订单不可使用真实资金',409);assert(ctx.snapshot.settlement_profile,'订单缺少结算合同',409);return ctx;}
 async function access(p,permission,ctx){assert(await authorize(p,permission,ctx)===true,'无此主体资金权限',403);}
 async function approvedAccount(c,key){const [a]=await rows(c,"SELECT * FROM commerce_payment_accounts WHERE id=? AND status='approved'",[key]);assert(a,'账户尚未获准使用',409);a.capabilities=parse(a.capabilities);return a;}
 async function ownAccount(c,ctx,key){
  const profile=ctx.snapshot.settlement_profile,platform=await approvedAccount(c,profile.platform_account_id),original=await approvedAccount(c,profile.source_account_id),a=await approvedAccount(c,key);
  assert(a.party_id===platform.party_id,'资金来源必须属于本协议的平台法律主体',409);
  assert(a.currency===ctx.currency&&a.provider===original.provider&&a.environment===original.environment,'资金账户币种、机构或环境不一致',409);
  assert(a.capabilities.own_funds_verified===true&&a.capabilities.evidence_ref&&a.capabilities.own_funds_evidence_ref,'缺少独立自有资金核验证据',409);
  assert(a.capabilities.operations?.includes('PAYOUT')&&a.contract_no,'自有资金账户未核验付款能力或资金合同',409);return a;
 }
 async function rejectOriginalReceipt(c,provider,environment,reference){
  const [original]=await rows(c,`SELECT id FROM commerce_funding_sources WHERE provider=? AND environment=? AND source_type NOT IN ('supplement','platform_own') AND
   (payment_id=? OR JSON_UNQUOTE(JSON_EXTRACT(evidence,'$.provider_ref'))=? OR JSON_UNQUOTE(JSON_EXTRACT(evidence,'$.provider_reference'))=? OR JSON_UNQUOTE(JSON_EXTRACT(evidence,'$.provider_receipt'))=? OR JSON_UNQUOTE(JSON_EXTRACT(evidence,'$.provider_line_id'))=?) LIMIT 1`,[provider,environment,reference,reference,reference,reference,reference]);
  assert(!original,'原支付或已分账资金凭证不能登记为独立补差款',409);
 }
 async function command(p,operation,input,fn){for(let attempt=0;;attempt++){try{return await workflow.command(p,operation,input,fn);}catch(e){if(attempt<2&&['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT','ER_DUP_ENTRY'].includes(e.code))continue;throw e;}}}
 async function createSource(p,input){
  const ctx=await context(pool,input.context_id);await access(p,'settlement.fund.write',ctx);
  const amount=minor(input.amount_minor);assert(BigInt(amount)>0n,'入账金额必须大于零',422);
  const fundingAccount=await ownAccount(pool,ctx,input.account_id);await access(p,'settlement.fund.write',{...ctx,party_id:fundingAccount.party_id});
  const reference=text(input.provider_reference,'机构入账流水号',128),evidence=text(input.evidence_ref,'自有资金入账凭证',500),sourceType=input.source_type||'supplement';assert(['supplement','platform_own'].includes(sourceType),'自有资金类型无效',422);
  return command(p,'own-funds.source.create',input,async c=>{
   const current=await context(c,ctx.id);await access(p,'settlement.fund.write',current);const a=await ownAccount(c,current,input.account_id);await access(p,'settlement.fund.write',{...current,party_id:a.party_id});
   await rejectOriginalReceipt(c,a.provider,a.environment,reference);
   const fingerprint=hash({context_id:ctx.id,account_id:a.id,amount_minor:amount,provider_reference:reference,evidence_ref:evidence,source_type:sourceType});
   const [prior]=await rows(c,'SELECT * FROM commerce_own_fund_receipts WHERE provider=? AND environment=? AND provider_reference=? FOR UPDATE',[a.provider,a.environment,reference]);
   if(prior){assert(prior.payload_hash===fingerprint,'该机构流水已登记，内容或归属不能改变',409,'own_receipt_conflict');return {...prior,reused:true};}
   const receiptId=id(),sourceId=id();
   await c.execute("INSERT INTO commerce_funding_sources(id,context_id,payment_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,NULL,?,?,?,?,?,?,?,'DRAFT',?)",[sourceId,ctx.id,sourceType,a.provider,a.environment,a.currency,a.id,a.contract_no,amount,JSON.stringify({own_receipt_id:receiptId,provider_reference:reference,evidence_ref:evidence,own_funds_evidence_ref:a.capabilities.own_funds_evidence_ref})]);
   await c.execute('INSERT INTO commerce_own_fund_receipts(id,source_id,context_id,account_id,provider,environment,provider_reference,currency,amount_minor,evidence_ref,payload_hash,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[receiptId,sourceId,ctx.id,a.id,a.provider,a.environment,reference,a.currency,amount,evidence,fingerprint,actor(p)]);
   await workflow.audit(c,p,'own-funds.source.create',receiptId,{source_id:sourceId,amount_minor:amount,provider_reference:reference});return {id:receiptId,source_id:sourceId,status:'DRAFT',amount_minor:amount};
  });
 }
 async function approveSource(p,input){
  const [row]=await rows(pool,'SELECT * FROM commerce_own_fund_receipts WHERE id=?',[input.id]);assert(row,'入账资料不存在',404);const ctx=await context(pool,row.context_id);await access(p,'settlement.fund.review',ctx);const fundingAccount=await ownAccount(pool,ctx,row.account_id);await access(p,'settlement.fund.review',{...ctx,party_id:fundingAccount.party_id});
  return command(p,'own-funds.source.approve',input,async c=>{
   const [r]=await rows(c,'SELECT * FROM commerce_own_fund_receipts WHERE id=? FOR UPDATE',[input.id]);const current=await context(c,r.context_id);await access(p,'settlement.fund.review',current);assert(r.created_by!==actor(p),'入账申请人不能复核自己的资料',403);
   if(r.status==='APPROVED')return {id:r.id,source_id:r.source_id,status:'APPROVED',reused:true};
   assert(r.status==='DRAFT','入账资料状态已变化',409);const a=await ownAccount(c,current,r.account_id);await access(p,'settlement.fund.review',{...current,party_id:a.party_id});assert(a.provider===r.provider&&a.environment===r.environment&&a.currency===r.currency,'入账账户机构或币种已改变',409);await rejectOriginalReceipt(c,a.provider,a.environment,r.provider_reference);
   const [source]=await rows(c,'SELECT * FROM commerce_funding_sources WHERE id=? FOR UPDATE',[r.source_id]);assert(source&&source.status==='DRAFT'&&source.payment_id==null&&source.context_id===r.context_id&&String(source.received_minor)===String(r.amount_minor),'资金来源与入账资料不一致',409);
   const note=text(input.note,'复核意见',1000);
   await c.execute("UPDATE commerce_funding_sources SET status='AVAILABLE' WHERE id=?",[source.id]);await c.execute("UPDATE commerce_own_fund_receipts SET status='APPROVED',reviewed_by=?,review_note=?,reviewed_at=? WHERE id=?",[actor(p),note,sqlDate(),r.id]);
   await postLedger(c,{event_key:'own-funds:receipt:'+r.id,context_id:r.context_id,source_type:'own_fund_receipt',source_id:r.id,lines:[{side:'debit',account:'settlement_cash:'+source.id,amount_minor:r.amount_minor},{side:'credit',account:'platform_own_funding',amount_minor:r.amount_minor}]});
   await workflow.audit(c,p,'own-funds.source.approve',r.id,{source_id:source.id,note});return {id:r.id,source_id:source.id,status:'APPROVED'};
  });
 }
 async function compensationInputs(c,ctx,input){
  const [unit]=await rows(c,"SELECT * FROM commerce_settlement_units WHERE id=? AND context_id=? AND status='CONFIRMED'",[input.original_unit_id,ctx.id]);assert(unit&&BigInt(unit.basis_minor)>0n,'赔付必须关联真实已确认履约单位',409);
  const [original]=await rows(c,'SELECT * FROM commerce_funding_sources WHERE id=?',[unit.source_id]);assert(original&&original.payment_id&&original.context_id===ctx.id&&!['platform_own','supplement','PLATFORM_COMMISSION'].includes(original.source_type),'缺少真实原支付来源',409);
  const customer=String(ctx.snapshot.account_id||'');assert(customer,'缺少原订单客户归属',409);
  const account=await approvedAccount(c,input.account_id);
  let own=account.party_id==='account:'+customer;
  if(!own){const [binding]=await rows(c,"SELECT id FROM commerce_settlement_party_bindings WHERE source_domain='identity' AND source_entity_type='account' AND source_entity_id=? AND party_id=? AND status='approved'",[customer,account.party_id]);own=!!binding;}
  assert(own,'赔付收款账户不属于原订单客户',403);
  const [source]=await rows(c,"SELECT * FROM commerce_funding_sources WHERE id=? AND status='AVAILABLE'",[input.source_id]);assert(source&&source.context_id===ctx.id&&['supplement','platform_own'].includes(source.source_type)&&source.payment_id==null,'赔付必须使用本订单已确认的独立自有资金',409);
  await ownAccount(c,ctx,source.account_id);
  assert(account.currency===ctx.currency&&source.currency===ctx.currency&&account.provider===source.provider&&account.environment===source.environment,'赔付收款账户币种、机构或环境不符',409);
  assert(account.capabilities.receive===true&&account.capabilities.evidence_ref,'客户账户尚未核验收款能力',409);
  const merchants=await rows(c,"SELECT DISTINCT beneficiary_party_id FROM commerce_settlement_items WHERE unit_id=? AND line_kind='merchant' AND component_key='merchant'",[unit.id]);assert(merchants.length===1&&merchants[0].beneficiary_party_id,'缺少明确的实际履约商户，请先核对原单位',409);
  return {unit,source,account,merchantParty:merchants[0].beneficiary_party_id};
 }
 async function sourceOwnerAccess(c,p,permission,ctx,sourceId){
  const [source]=await rows(c,'SELECT account_id,context_id FROM commerce_funding_sources WHERE id=?',[sourceId]);assert(source&&source.context_id===ctx.id,'赔付资金来源不属于当前业务',409);const a=await ownAccount(c,ctx,source.account_id);await access(p,permission,{...ctx,party_id:a.party_id});
 }
 async function createCompensation(p,input){
  const ctx=await context(pool,input.context_id);await access(p,'settlement.fund.write',ctx);await sourceOwnerAccess(pool,p,'settlement.fund.write',ctx,input.source_id);
  const amount=minor(input.amount_minor);assert(BigInt(amount)>0n,'赔付金额必须大于零',422);
  const caseRef=text(input.case_ref,'售后赔付事项编号',128),evidence=text(input.evidence_ref,'赔付凭证',500),reason=text(input.reason,'赔付原因',1000);
  return command(p,'own-funds.compensation.create',input,async c=>{
   const current=await context(c,ctx.id);await access(p,'settlement.fund.write',current);await sourceOwnerAccess(c,p,'settlement.fund.write',current,input.source_id);const {unit,source,account}=await compensationInputs(c,current,input);
   const fingerprint=hash({context_id:ctx.id,original_unit_id:unit.id,source_id:source.id,account_id:account.id,account_version:account.version,amount_minor:amount,case_ref:caseRef,evidence_ref:evidence,reason});
   const [prior]=await rows(c,'SELECT * FROM commerce_real_compensations WHERE context_id=? AND case_ref=? FOR UPDATE',[ctx.id,caseRef]);if(prior){assert(prior.payload_hash===fingerprint,'同一赔付事项已申请，内容不可重复改写',409);return {...prior,reused:true};}
   const key=id();await c.execute('INSERT INTO commerce_real_compensations(id,context_id,original_unit_id,source_id,beneficiary_party_id,account_id,account_version,currency,amount_minor,case_ref,evidence_ref,reason,payload_hash,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[key,ctx.id,unit.id,source.id,account.party_id,account.id,account.version,ctx.currency,amount,caseRef,evidence,reason,fingerprint,actor(p)]);
   await workflow.audit(c,p,'own-funds.compensation.create',key,{context_id:ctx.id,amount_minor:amount,case_ref:caseRef});return {id:key,status:'DRAFT',amount_minor:amount};
  });
 }
 async function approveCompensation(p,input){
  const [existing]=await rows(pool,'SELECT * FROM commerce_real_compensations WHERE id=?',[input.id]);assert(existing,'赔付申请不存在',404);const ctx=await context(pool,existing.context_id);await access(p,'settlement.fund.review',ctx);await sourceOwnerAccess(pool,p,'settlement.fund.review',ctx,existing.source_id);
  return command(p,'own-funds.compensation.approve',input,async c=>{
   const [r]=await rows(c,'SELECT * FROM commerce_real_compensations WHERE id=? FOR UPDATE',[input.id]);const current=await context(c,r.context_id);await access(p,'settlement.fund.review',current);await sourceOwnerAccess(c,p,'settlement.fund.review',current,r.source_id);assert(r.created_by!==actor(p),'赔付申请人不能复核自己的申请',403);
   if(r.status==='APPROVED')return {id:r.id,item_id:String(r.item_id),status:'APPROVED',reused:true};assert(r.status==='DRAFT','赔付申请状态已变化',409);
   const {source,account,merchantParty}=await compensationInputs(c,current,r);assert(Number(account.version)===Number(r.account_version),'赔付收款账户版本已变化，请重新核对申请',409);
   const [locked]=await rows(c,'SELECT * FROM commerce_funding_sources WHERE id=? FOR UPDATE',[source.id]);
   assert(locked.status==='AVAILABLE'&&locked.context_id===r.context_id&&locked.currency===r.currency&&locked.payment_id==null&&['supplement','platform_own'].includes(locked.source_type),'独立资金状态已变化，请重新核对',409);
   const commitments=await rows(c,'SELECT payable_minor,discharged_minor,reserved_minor,cancelled_minor,offset_minor FROM commerce_settlement_items WHERE source_id=? ORDER BY id FOR UPDATE',[source.id]);
   const awaiting=commitments.reduce((sum,i)=>sum+BigInt(i.payable_minor)-BigInt(i.discharged_minor)-BigInt(i.reserved_minor)-BigInt(i.cancelled_minor)-BigInt(i.offset_minor),0n);
   const free=BigInt(locked.received_minor)-BigInt(locked.consumed_minor)-BigInt(locked.reserved_minor)-BigInt(locked.returned_minor||0)-awaiting;
   assert(free>=BigInt(r.amount_minor),'独立资金余额不足，已批准未付项目已计入占用',409);
   const note=text(input.note,'赔付复核意见',1000),component='supplement:'+r.id;
   const [result]=await c.execute("INSERT INTO commerce_settlement_items(batch_id,line_kind,basis_minor,payable_minor,status,context_id,unit_id,component_key,beneficiary_party_id,account_id,source_id,original_payable_minor,planned_minor,rule_ref) VALUES(NULL,'compensation',0,?,'DRAFT',?,NULL,?,?,?,?,?,?,?)",[r.amount_minor,r.context_id,component,r.beneficiary_party_id,r.account_id,r.source_id,r.amount_minor,r.amount_minor,hash({compensation_id:r.id,case_ref:r.case_ref,evidence_ref:r.evidence_ref})]);
   const [platform]=await rows(c,'SELECT party_id FROM commerce_payment_accounts WHERE id=?',[source.account_id]);
   const recoveryId=id();await c.execute('INSERT INTO commerce_compensation_recoveries(id,compensation_id,context_id,debtor_party_id,creditor_party_id,currency,amount_minor) VALUES(?,?,?,?,?,?,?)',[recoveryId,r.id,r.context_id,merchantParty,platform.party_id,r.currency,r.amount_minor]);
   await c.execute("UPDATE commerce_real_compensations SET status='APPROVED',item_id=?,reviewed_by=?,review_note=?,approved_at=? WHERE id=?",[result.insertId,actor(p),note,sqlDate(),r.id]);
   await postLedger(c,{event_key:'own-funds:compensation:'+r.id,context_id:r.context_id,source_type:'compensation',source_id:r.id,lines:[{side:'debit',account:'compensation_expense',amount_minor:r.amount_minor},{side:'credit',account:'payable:'+r.beneficiary_party_id,amount_minor:r.amount_minor}]});
   await workflow.audit(c,p,'own-funds.compensation.approve',r.id,{item_id:String(result.insertId),recovery_id:recoveryId,note});return {id:r.id,item_id:String(result.insertId),status:'APPROVED',recovery_id:recoveryId};
  });
 }
 async function listRows(p,kind,input={}){
  const tables={sources:'commerce_own_fund_receipts',compensations:'commerce_real_compensations',recoveries:'commerce_compensation_recoveries'};assert(tables[kind],'资料类型无效');
  const where=input.context_id?' WHERE r.context_id=?':'',all=await rows(pool,`SELECT r.*,c.party_id,c.biz_type,c.payment_mode FROM ${tables[kind]} r JOIN commerce_settlement_business_contexts c ON c.id=r.context_id${where} ORDER BY r.created_at DESC LIMIT 500`,input.context_id?[input.context_id]:[]),out=[];
  for(const r of all){try{await access(p,'settlement.fund.read',r);out.push(r);}catch(e){if(e.status!==403)throw e;}}return {rows:out};
 }
 async function netCompensationPaid(c,itemId){
  const pending=[String(itemId)],seen=new Set();let amount=0n;
  while(pending.length){
   const batch=pending.splice(0,100).filter(x=>!seen.has(x));if(!batch.length)continue;batch.forEach(x=>seen.add(x));assert(seen.size<=10000,'赔付重付链异常',409);
   const lines=await rows(c,"SELECT * FROM commerce_execution_lines WHERE item_id IN ("+batch.map(()=>'?').join(',')+") AND effect_kind='PAYOUT' AND status='SUCCEEDED' ORDER BY id",batch);
   for(const line of lines){const net=BigInt(line.amount_minor)-BigInt(line.returned_minor)-BigInt(line.bank_returned_minor);assert(net>=0n,'赔付净付款记录异常',409);amount+=net;}
   if(lines.length){const returned=await rows(c,"SELECT repayment_item_id FROM commerce_execution_returned WHERE line_id IN ("+lines.map(()=>'?').join(',')+") AND status='APPROVED' AND repayment_item_id IS NOT NULL",lines.map(l=>l.id));pending.push(...returned.map(x=>String(x.repayment_item_id)));}
  }
  return amount;
 }
 async function syncRecoveries(){
  // Round-robin all records: a bank return can arrive after a fully paid case.
  const pending=await rows(pool,'SELECT id FROM commerce_compensation_recoveries ORDER BY updated_at,id LIMIT 100'),out=[];
  for(const record of pending)await transaction(pool,async c=>{
   const [r]=await rows(c,'SELECT r.*,p.item_id FROM commerce_compensation_recoveries r JOIN commerce_real_compensations p ON p.id=r.compensation_id WHERE r.id=? FOR UPDATE',[record.id]);
   const paid=await netCompensationPaid(c,r.item_id),target=paid>BigInt(r.amount_minor)?BigInt(r.amount_minor):paid,delta=target-BigInt(r.activated_minor);
   if(delta===0n){await c.execute('UPDATE commerce_compensation_recoveries SET updated_at=? WHERE id=?',[sqlDate(),r.id]);return;}
   const version=Number(r.sync_version)+1,positive=delta>0n,amount=(positive?delta:-delta).toString();
   await postLedger(c,{event_key:'own-funds:recovery:'+r.id+':v'+version,context_id:r.context_id,source_type:'compensation_recovery',source_id:r.id,lines:[{side:positive?'debit':'credit',account:'receivable:'+r.debtor_party_id,amount_minor:amount},{side:positive?'credit':'debit',account:'compensation_recovery',amount_minor:amount}]});
   const returnDue=BigInt(r.recovered_minor)>target?BigInt(r.recovered_minor)-target:0n,status=returnDue>0n?'RETURN_DUE':target===0n?'PENDING_PAYMENT':target>BigInt(r.recovered_minor)?'RECEIVABLE':'RECOVERED';
   await c.execute('UPDATE commerce_compensation_recoveries SET activated_minor=?,return_due_minor=?,sync_version=?,status=?,updated_at=? WHERE id=?',[target.toString(),returnDue.toString(),version,status,sqlDate(),r.id]);out.push({id:r.id,activated_minor:target.toString(),return_due_minor:returnDue.toString()});
  });return {rows:out};
 }

 return {createSource,approveSource,createCompensation,approveCompensation,listSources:(p,i)=>listRows(p,'sources',i),listCompensations:(p,i)=>listRows(p,'compensations',i),listRecoveries:(p,i)=>listRows(p,'recoveries',i),syncRecoveries};
}
module.exports={ddl,migrate,createOwnFunds};
