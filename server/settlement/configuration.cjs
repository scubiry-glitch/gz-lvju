'use strict';
const {assert,id,parse,hash,rows,minor,calculate,makerCheckerRequired}=require('./primitives.cjs');
function createConfiguration({pool,workflow,authorize}) {
 const tables={accounts:'commerce_payment_accounts',profiles:'commerce_settlement_profiles',bindings:'commerce_settlement_party_bindings'};
 async function list(p,input){assert(tables[input.kind],'配置类型无效');const all=await rows(pool,`SELECT * FROM ${tables[input.kind]} ORDER BY created_at DESC LIMIT 500`),out=[];for(const r of all){try{await authorize(p,'settlement.fund.read',r);if(input.kind==='accounts'){const capabilities=parse(r.capabilities);r.account_label=capabilities.account_label||null;r.name=r.account_label;}out.push(r);}catch(e){if(e.status!==403)throw e;}}return {rows:out};}
 async function create(p,input){await authorize(p,'settlement.policy.write',input);return workflow.command(p,'configuration.'+input.kind,input,async c=>{
  const key=id();assert(typeof input.party_id==='string'&&/^[A-Za-z0-9_.:-]{1,64}$/.test(input.party_id),'主体标识无效');
  if(input.kind==='bindings'){
   assert(['commerce','jiazheng','booking','identity','platform'].includes(input.source_domain),'来源域无效');assert(['merchant','vendor','account','entity'].includes(input.source_entity_type),'主体类型无效');
   if(input.source_domain==='platform')await authorize(p,'settlement.policy.write',{});
   await c.execute('INSERT INTO commerce_settlement_party_bindings(id,source_domain,source_entity_type,source_entity_id,party_id,created_by) VALUES(?,?,?,?,?,?)',[key,input.source_domain,input.source_entity_type,String(input.source_entity_id),input.party_id,String(p.account.id)]);
  }else if(input.kind==='accounts'){
   assert(/^[A-Z]{3}$/.test(input.currency),'币种无效');assert(input.provider&&input.environment&&input.merchant_no,'账户来源配置不完整');
   await c.execute('INSERT INTO commerce_payment_accounts(id,party_id,provider,environment,merchant_no,contract_no,currency,capabilities,created_by) VALUES(?,?,?,?,?,?,?,?,?)',[key,input.party_id,input.provider,input.environment,input.merchant_no,input.contract_no||null,input.currency,JSON.stringify(input.capabilities||{}),String(p.account.id)]);
  }else if(input.kind==='profiles'){
   assert(['commerce','jiazheng','booking'].includes(input.biz_type)&&(input.payment_mode==='pay_center'||input.biz_type==='jiazheng'&&input.payment_mode==='wechat_mini'||input.biz_type==='booking'&&input.payment_mode==='offline'),'业务或支付模式无效');const snapshot=input.snapshot||{};
   assert(snapshot.contract_ref&&snapshot.calculation&&snapshot.recognition_policy,'缺少合同、计算或履约确认规则');
   assert(snapshot.calculation.contract_ref||snapshot.contract_ref,'规则缺少有效合同');
   calculate({...snapshot.calculation,amount_minor:snapshot.calculation.mode==='FIXED_COST'?minor(BigInt(snapshot.calculation.fixed_cost_minor)+BigInt(snapshot.calculation.fixed_commission_minor)): '10000'});
   if(input.payment_mode==='pay_center'){
    assert(['CONTROLLED_COLLECTION','MERCHANT_CONTROLLED_RECEIPT','MERCHANT_ALREADY_SETTLED'].includes(snapshot.funding_mode)&&snapshot.source_account_id&&snapshot.platform_account_id&&snapshot.merchant_account_id,'站内资金配置不完整');
    for(const accountId of [snapshot.source_account_id,snapshot.platform_account_id]){const [a]=await rows(c,"SELECT party_id FROM commerce_payment_accounts WHERE id=? AND status='approved'",[accountId]);assert(a,'资金路线账户尚未准入',409);await authorize(p,'settlement.policy.write',{...input,party_id:a.party_id});}
   }
   const [[v]]=await c.execute('SELECT COALESCE(MAX(version),0)+1 n FROM commerce_settlement_profiles WHERE party_id=? AND biz_type=? AND payment_mode=?',[input.party_id,input.biz_type,input.payment_mode]);
   snapshot.version=Number(v.n);snapshot.profile_id=key;snapshot.rule_hash=hash(snapshot.calculation);
   await c.execute('INSERT INTO commerce_settlement_profiles(id,party_id,biz_type,payment_mode,version,snapshot,created_by) VALUES(?,?,?,?,?,?,?)',[key,input.party_id,input.biz_type,input.payment_mode,v.n,JSON.stringify(snapshot),String(p.account.id)]);
  }else assert(false,'配置类型无效');
  await workflow.audit(c,p,'configuration.create',key,{kind:input.kind,party_id:input.party_id});return {id:key,status:'draft'};
 });}
 async function approve(p,input){assert(tables[input.kind],'配置类型无效');return workflow.command(p,'configuration.approve.'+input.kind,input,async c=>{
  const [r]=await rows(c,`SELECT * FROM ${tables[input.kind]} WHERE id=? FOR UPDATE`,[input.id]);assert(r,'配置不存在',404);await authorize(p,'settlement.policy.review',r);if(makerCheckerRequired())assert(r.created_by!==String(p.account.id),'配置准入需要非申请人复核',403);assert(r.status==='draft','配置已审批',409);
  if(input.kind==='bindings'&&r.source_domain==='platform')await authorize(p,'settlement.policy.review',{});
  if(input.kind==='profiles'&&r.payment_mode==='pay_center'){
   const s=parse(r.snapshot);for(const field of ['source_account_id','merchant_account_id','platform_account_id']){const [a]=await rows(c,"SELECT * FROM commerce_payment_accounts WHERE id=? AND status='approved'",[s[field]]);assert(a,'账户尚未完成准入',409);if(field==='merchant_account_id')assert(a.party_id===r.party_id,'商户账户主体不一致',409);if(field==='source_account_id'){const collection=s.collection;assert(collection&&collection.mapping_version&&collection.contract_no===a.contract_no&&collection.source_merchant_no===a.merchant_no&&collection.provider===a.provider&&collection.environment===a.environment,'收款契约映射与原款账户不一致',409);}}
   assert(s.contract_mapping_version&&s.funding_evidence_ref,'需提供机构契约版本和原款控制证据',409);
   const accounts=await rows(c,"SELECT * FROM commerce_payment_accounts WHERE id IN (?,?,?) AND status='approved' FOR UPDATE",[s.source_account_id,s.merchant_account_id,s.platform_account_id]);
   const base=accounts.find(a=>a.id===s.source_account_id);assert(base.currency===(s.currency||'CNY')&&accounts.every(a=>a.currency===base.currency&&a.provider===base.provider&&a.environment===base.environment),'资金账户的币种、机构与环境必须一致',409);
   for(const accountId of [s.source_account_id,s.platform_account_id]){const a=accounts.find(x=>x.id===accountId);await authorize(p,'settlement.policy.review',{...r,party_id:a.party_id});}
   const platform=accounts.find(a=>a.id===s.platform_account_id),[binding]=await rows(c,"SELECT id FROM commerce_settlement_party_bindings WHERE source_domain='platform' AND source_entity_type='entity' AND party_id=? AND status='approved'",[platform.party_id]);assert(binding,'平台佣金账户所属主体尚未由全局资金治理准入',409,'platform_party_not_approved');
  }
  await c.execute(`UPDATE ${tables[input.kind]} SET status='approved',reviewed_by=? WHERE id=?`,[String(p.account.id),r.id]);await workflow.audit(c,p,'configuration.approve',r.id,{kind:input.kind});return {id:r.id,status:'approved'};
 });}
 async function forOrder(c,{biz_type,entity_id,payment_mode}) {
  const domain=biz_type,type=biz_type==='commerce'?'merchant':'vendor';
  const [binding]=await rows(c,"SELECT * FROM commerce_settlement_party_bindings WHERE source_domain=? AND source_entity_type=? AND source_entity_id=? AND status='approved'",[domain,type,String(entity_id)]);
  assert(binding,'商户结算主体尚未准入',409,'settlement_profile_missing');
  const [profile]=await rows(c,"SELECT * FROM commerce_settlement_profiles WHERE party_id=? AND biz_type=? AND payment_mode=? AND status='approved' ORDER BY version DESC LIMIT 1",[binding.party_id,biz_type,payment_mode]);
  assert(profile,'商户结算协议尚未准入',409,'settlement_profile_missing');return {...parse(profile.snapshot),profile_id:profile.id,party_id:binding.party_id,version:Number(profile.version)};
 }
 return {list,create,approve,forOrder};
}
module.exports={createConfiguration};
