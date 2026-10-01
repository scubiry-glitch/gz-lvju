'use strict';
const {assert,rows}=require('./primitives.cjs');
const {AsyncLocalStorage}=require('node:async_hooks');
const systemPrincipal=Object.freeze({type:'account',account:{id:'settlement-worker',status:'active',principal_type:'service'},roles:[]});
// Narrow endpoint capabilities are scoped to one call chain. A merchant's
// evidence-submission permission must never become general finance-write access.
const operationContext=new AsyncLocalStorage();
const operationAliases=Object.freeze({
 merchant_submission:{'settlement.external.write':['settlement.external.submit']},
 finance_import:{'settlement.external.write':['settlement.external.import']},
 accrual_adjustment:{'settlement.external.write':['settlement.accrual.adjust']},
 trade_allocation:{'settlement.external.review':['settlement.external.link']},
});
function withExternalOperation(principal,operation,fn){
 assert(Object.hasOwn(operationAliases,operation),'外部资料操作无效',500);
 return operationContext.run({principal,operation},fn);
}
function createAuthorizer({pool}) {
 return async function authorize(p,permission,resource={}) {
  if(p===systemPrincipal){assert(!/review|approval\.act|policy\./.test(permission),'后台任务不能代替人工审核',403);return true;}
  assert(p?.account?.status==='active'&&p.account.principal_type==='user','请登录后继续',401);
  const aliases={'settlement.approval.act':['settlement.fund.review'],'settlement.fund.adjust':['settlement.fund.write'],
   'settlement.external.read':['settlement.external.write','settlement.external.import','settlement.external.review']};
  const active=operationContext.getStore();
  const endpointAliases=active?.principal===p?(operationAliases[active.operation][permission]||[]):[];
  const legacy={'settlement.fund.read':'commerce.fund.read','settlement.fund.write':'commerce.fund.write','settlement.fund.review':'commerce.fund.review','settlement.fund.adjust':'commerce.fund.write'};
  for(const role of p.roles||[]) {
   const perms=new Set(role.permissions||[]),scope=role.scope||{level:'self'};
   const shared=perms.has('*')||perms.has(permission)||[...(aliases[permission]||[]),...endpointAliases].some(x=>perms.has(x));
   const compatible=resource.biz_type==='commerce'&&perms.has(legacy[permission]);
   if(!shared&&!compatible)continue;
   if(scope.biz_types&&resource.biz_type&&!scope.biz_types.includes(resource.biz_type))continue;
   if(scope.payment_modes&&resource.payment_mode&&!scope.payment_modes.includes(resource.payment_mode))continue;
   const party=resource.party_id||resource.beneficiary_party_id;
   if(scope.party_ids&&party&&!scope.party_ids.map(String).includes(String(party)))continue;
   // An all-level role can still be explicitly restricted to business/channel/
   // legal parties. A request with missing dimensions cannot erase restrictions.
   if(scope.level==='all'&&((scope.party_ids&&!party)||(scope.biz_types&&!resource.biz_type)||(scope.payment_modes&&!resource.payment_mode)))continue;
   if(scope.level==='all')return true;
   if(!party)continue; // Global configuration and unscoped queries require an explicit all scope.
   if(scope.party_ids?.map(String).includes(String(party)))return true;
   if(String(party)==='account:'+String(p.account.id)&&permission.startsWith('settlement.statement.'))return true;
   const vendor=scope.vendor_id??p.account.vendor_id;
   if(vendor!=null&&resource.biz_type==='jiazheng'){
    const matches=await rows(pool,"SELECT id FROM commerce_settlement_party_bindings WHERE source_domain='jiazheng' AND source_entity_type='vendor' AND source_entity_id=? AND party_id=? AND status='approved'",[String(vendor),String(party)]);
    if(matches.length)return true;
   }
   if(vendor!=null&&resource.biz_type==='commerce'){
    const matches=await rows(pool,"SELECT b.id FROM commerce_settlement_party_bindings b JOIN commerce_merchants m ON m.id=b.source_entity_id WHERE b.source_domain='commerce' AND b.source_entity_type='merchant' AND m.vendor_id=? AND b.party_id=? AND b.status='approved'",[vendor,String(party)]);
    if(matches.length)return true;
   }
   if(scope.level==='city'&&resource.city_id!=null&&(scope.city_ids||[]).map(String).includes(String(resource.city_id)))return true;
  }
  assert(false,'无此结算操作或主体权限',403,'settlement_forbidden');
 };
}
module.exports={createAuthorizer,systemPrincipal,withExternalOperation};
