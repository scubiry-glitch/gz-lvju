'use strict';
// This port never imports a payment client or performs network I/O. It is only
// reachable for the explicitly marked, database-backed sytest walkthrough.
const {digest,fault}=require('./provider.cjs');
const SEED_KEY='settlement-walkthrough-v1',PROVIDER='SYTEST_MOCK',ENVIRONMENT='SANDBOX',VERSION='sytest-mock-v1';
const parse=v=>typeof v==='string'?JSON.parse(v):v||{};
const enabled=config=>config?.SETTLEMENT_DEMO_ENABLED==='1'&&config?.JUZHU_ENV==='test';
const reject=message=>{throw fault(message,'SYTEST_MOCK_SCOPE_DENIED');};
function assertSource(source){
 if(source.provider!==PROVIDER||source.environment!==ENVIRONMENT||parse(source.evidence).demo_seed_key!==SEED_KEY||source.payment_id!=null)reject('走查原款必须为本批次模拟来源，且不得关联真实支付');
 return true;
}
function assertAccount(account){
 if(account.provider!==PROVIDER||account.environment!==ENVIRONMENT||parse(account.capabilities).demo_seed_key!==SEED_KEY)reject('模拟资金账户缺少同批次隔离标记');
 return true;
}
function assertRoute(config,context,source){
 const snapshot=parse(context.snapshot),demo=snapshot.demo,profile=context.profile||snapshot.settlement_profile;
 const candidate=source.provider===PROVIDER||profile?.contract_mapping_version===VERSION||demo?.seed_key===SEED_KEY;
 if(!candidate)return false;
 if(!enabled(config)||demo?.seed_key!==SEED_KEY||profile?.contract_mapping_version!==VERSION||context.execution_scope!=='INTERNAL_FUNDED'||context.payment_mode!=='pay_center')reject('模拟机构仅允许已开启的测试站及本批次受控业务');
 assertSource(source);return true;
}
const frozen={provider:PROVIDER,environment:ENVIRONMENT,version:VERSION,evidence_ref:SEED_KEY,operations:['SPLIT','PAYOUT','RETURN','RELEASE','REFUND']};
const contractHash=digest(frozen);
function createProvider(config){
 function contract(version,operation){if(!enabled(config)||version!==VERSION||!frozen.operations.includes(operation))reject('模拟机构能力未启用');return {...frozen,contract_hash:contractHash};}
 function build(version,operation,input){contract(version,operation);if(input.demo?.seed_key!==SEED_KEY)reject('模拟请求未冻结隔离标记');return {submit:{request_no:input.request_no,operation,demo:input.demo},query:{request_no:input.request_no,operation},contract_hash:contractHash,version};}
 async function invoke(order,action){
  contract(order.mapping_version,order.operation);const input=parse(order.canonical_request);
  if(order.provider!==PROVIDER||order.environment!==ENVIRONMENT||input.demo?.seed_key!==SEED_KEY||order.contract_hash!==contractHash||!['submit','query'].includes(action))reject('模拟机构原请求归属不匹配');
  const scenario=input.demo.scenario||'SUCCESS';
  if(!['SUCCESS','UNKNOWN_THEN_SUCCESS','PARTIAL_THEN_SUCCESS','FAILED_FINAL','PARTIAL'].includes(scenario))reject('模拟机构场景未定义');
  const lines=input.effects.map((effect,index)=>{
   let status='SUCCEEDED';
   if(scenario==='FAILED_FINAL'||scenario==='PARTIAL'&&index>0)status='FAILED_FINAL';
   if(action==='submit'&&(scenario==='UNKNOWN_THEN_SUCCESS'||scenario==='PARTIAL_THEN_SUCCESS'&&index>0))status='UNKNOWN';
   return {id:effect.id,status,provider_line_id:status==='SUCCEEDED'?'SYTEST-LINE-'+effect.id:null,evidence:{simulated:true,seed_key:SEED_KEY,request_no:order.request_no,amount_minor:effect.amount_minor,payee_merchant_no:effect.payee_merchant_no,no_debit:status==='FAILED_FINAL',reservation_released:status==='FAILED_FINAL'}};
  });
  const raw={simulated:true,seed_key:SEED_KEY,request_no:order.request_no,action,scenario,lines};
  return {raw,normalized:{request_no:order.request_no,provider_order_no:'SYTEST-'+order.request_no,lines,raw_hash:digest(raw)}};
 }
 return {contract,build,invoke};
}
module.exports={SEED_KEY,PROVIDER,ENVIRONMENT,VERSION,enabled,assertSource,assertAccount,assertRoute,createProvider};
