'use strict';
// Runs the real HTTP router and authorization module against bounded service
// contracts. Only an ephemeral loopback server is opened; no database/provider.
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createHandler,prefix}=require('../settlement/http.cjs');
const {createAuthorizer,withExternalOperation,systemPrincipal}=require('../settlement/access.cjs');
const ID='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const externalScope={party_id:'party-A',biz_type:'jiazheng',payment_mode:'wechat_mini'};
const role=(permissions,scope={level:'all'})=>({permissions,scope});
const principal=(id,roles)=>({type:'account',account:{id,status:'active',principal_type:'user'},roles});
const restricted={level:'all',party_ids:['party-A'],biz_types:['jiazheng'],payment_modes:['wechat_mini']};
const pool={async execute(sql,args){assert(sql.startsWith('SELECT'));return [[args.includes('bound-party')&&args.includes('17')?{id:'binding'}:null].filter(Boolean)];}};
const authorize=createAuthorizer({pool});
const sessions={
 admin:principal('admin',[role(['*'])]),submit:principal('submit',[role(['settlement.external.submit'],restricted)]),
 importer:principal('importer',[role(['settlement.external.import'],restricted)]),reviewer:principal('reviewer',[role(['settlement.external.review'],restricted)]),
 linker:principal('linker',[role(['settlement.external.link'],restricted)]),accrual:principal('accrual',[role(['settlement.accrual.adjust'],restricted)]),
 reader:principal('reader',[role(['settlement.statement.read','settlement.statement.export'],restricted)]),
 service:{type:'account',account:{id:'machine',status:'active',principal_type:'service'},roles:[role(['*'])]},
 disabled:{...principal('disabled',[role(['*'])]),account:{id:'disabled',status:'disabled',principal_type:'user'}},
};
let calls=[];
const accountRows=[{id:'approved-A',party_id:'party-A',status:'approved'},{id:'draft-A',party_id:'party-A',status:'draft'},{id:'approved-B',party_id:'party-B',status:'approved'}];
const scopeFor=i=>({party_id:i.party_id||((i.statement_id||i.export_id||i.evidence_id||i.event_id)===OTHER?'party-B':'party-A'),biz_type:'jiazheng',payment_mode:'wechat_mini'});
function group(name){return new Proxy({}, {get(_,method){return async(p,i={})=>{
 const operation=String(method);
 let perm='settlement.fund.read';
 if(name==='S'){
  if(['ingestEvidence','syncExternalOrders','importExternalEvidence','submitCoverage','recordExternalAccrual'].includes(operation))perm='settlement.external.write';
  else if(['reviewEvidence','reviewImport','reviewCoverage','reviewExternalAccrual','allocateExternalTrade'].includes(operation))perm='settlement.external.review';
  else if(operation==='listExternalEvents')perm='settlement.external.read';
  else if(['requestExport','getExport','downloadExport','retryExport'].includes(operation))perm='settlement.statement.export';
  else if(['generateStatement','setStatementPolicy'].includes(operation))perm='settlement.statement.generate';
  else if(operation==='resolveDispute')perm='settlement.statement.review';
  else if(operation==='raiseDispute')perm='settlement.statement.dispute';
  else if(operation==='confirmStatement')perm='settlement.statement.confirm';
  else perm='settlement.statement.read';
 }
 await authorize(p,perm,scopeFor(i));calls.push({name,method:operation,p,input:i});
 if(name==='C'&&operation==='list')return {rows:accountRows};
 if(name==='E'&&operation==='listPlans')return {rows:[{id:ID}]};
 if(operation==='downloadExport')return {buffer:Buffer.from('approved export'),contentType:'text/csv; charset=utf-8',filename:'测试账单.csv'};
 return {name,method:operation,...i};
 };}});}
const service={authorize,workflow:group('W'),execution:group('E'),statements:group('S'),configuration:group('C'),business:group('B'),ownFunds:group('O'),reversals:group('R'),
 async me(p){calls.push({name:'root',method:'me',p,input:{}});return {account:p.account};},
 async fundingSources(p,i){await authorize(p,'settlement.fund.read',scopeFor(i));calls.push({name:'root',method:'fundingSources',p,input:i});return {rows:[]};},
 async executionOrders(p,i){await authorize(p,'settlement.fund.read',scopeFor(i));calls.push({name:'root',method:'executionOrders',p,input:i});return {rows:[{id:ID}]};},
 async acceptanceStatus(p,i){calls.push({name:'root',method:'acceptanceStatus',p,input:i});return {eligible:true,confirmed:false};},
};
const auth={bearerToken:req=>(req.headers.authorization||'').replace(/^Bearer /,''),verifySessionToken:async token=>sessions[token]||null,
 principalOf:async req=>req.headers.cookie==='lianjia_token=verified'?{...sessions.submit,via:'lianjia_token'}:{type:'key',via:'legacy',account:sessions.admin.account},};
let server,origin;
test.before(async()=>{server=http.createServer(createHandler({service,auth}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));});
async function request(path,{method='GET',body,token='admin',headers={},raw}={}){
 const h={...(token?{Authorization:'Bearer '+token}:{}),...(method==='POST'?{'Content-Type':'application/json','Idempotency-Key':'http-test-key-001'}:{}),...headers};
 for(const k of Object.keys(h))if(h[k]===null)delete h[k];
 const response=await fetch(origin+prefix+path,{method,headers:h,body:method==='POST'?(raw??JSON.stringify(body||{})):undefined});
 const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:response.status,headers:response.headers,body:data};
}

test('real session required; inactive, service and legacy cookie identities denied',async()=>{
 for(const token of [null,'forged','disabled','service'])assert.equal((await request('/me',{token})).status,401);
 assert.equal((await request('/me',{token:null,headers:{Cookie:'lianjia_token=forged'}})).status,401);
 const ok=await request('/me',{token:null,headers:{Cookie:'lianjia_token=verified'}});assert.equal(ok.status,200);assert.equal(ok.body.data.account.id,'submit');
});
test('GET never invokes POST-only methods, including approvals and retries',async()=>{
 const paths=[`/admin/policies/${ID}/disable`,`/admin/own-fund-sources/${ID}/approve`,`/admin/compensations/${ID}/approve`,`/admin/configuration/accounts/${ID}/approve`,`/admin/policies/${ID}/publish`,`/admin/items/9/adjustments`,`/admin/items/9/authorize`,`/admin/execution-plans/${ID}/cancel`,`/admin/execution-orders/${ID}/query`,`/admin/external-imports/${ID}/reviews`,`/admin/external-coverage/${ID}/reviews`,`/admin/statement-disputes/${ID}/resolve`,`/me/statement-exports/${ID}/retry`,`/me/settlement-statements/${ID}/exports`];
 const before=calls.length;for(const path of paths)assert.equal((await request(path)).status,405,path);assert.equal(calls.length,before);
});
test('JSON, bounded idempotency header and same-origin checks precede all mutation calls',async()=>{
 const before=calls.length;const path='/admin/policies';
 assert.equal((await request(path,{method:'POST',headers:{'Idempotency-Key':null}})).status,400);
 assert.equal((await request(path,{method:'POST',headers:{'Idempotency-Key':'x'.repeat(101)}})).status,400);
 assert.equal((await request(path,{method:'POST',headers:{'Content-Type':'text/plain'}})).status,415);
 assert.equal((await request(path,{method:'POST',raw:'[]'})).status,400);
 assert.equal((await request(path,{method:'POST',raw:'{bad'})).status,400);
 assert.equal((await request(path,{method:'POST',headers:{Origin:'https://elsewhere.invalid'}})).status,403);
 assert.equal((await request(path,{method:'POST',headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal(calls.length,before);
 const ok=await request(path,{method:'POST',body:{request_key:'forged-body-key',actor_id:'different-user',note:'中文说明'}});assert.equal(ok.status,200);assert.equal(calls.at(-1).input.request_key,'http-test-key-001');assert.equal(calls.at(-1).p.account.id,'admin');assert.equal(calls.at(-1).input.note,'中文说明');
});
test('cookie writes require same-origin browser proof',async()=>{
 const path='/me/external-evidence-submissions',opt={method:'POST',token:null,body:{party_id:'party-A'}};
 assert.equal((await request(path,{...opt,headers:{Cookie:'lianjia_token=verified'}})).status,403);
 assert.equal((await request(path,{...opt,headers:{Cookie:'lianjia_token=verified',Origin:origin}})).status,200);
});
test('execution list has one rows layer; receiving account choices contain only approved requested-party rows',async()=>{
 assert.deepEqual((await request('/admin/execution-plans')).body.data,{rows:[{id:ID}]});
 assert.deepEqual((await request('/admin/accounts?party_id=party-A')).body.data.rows,[accountRows[0]]);
 const detail=await request('/admin/items/17');assert.equal(detail.body.data.id,'17');assert.deepEqual(detail.body.data.execution_orders,[{id:ID}]);
});
test('all mutation routes pass the correct entity parameter and trusted request key',async()=>{
 const matrix=[
 ['/admin/own-fund-sources','O','createSource'],[`/admin/own-fund-sources/${ID}/approve`,'O','approveSource','id',ID],['/admin/compensations','O','createCompensation'],[`/admin/compensations/${ID}/approve`,'O','approveCompensation','id',ID],[`/admin/policies/${ID}/disable`,'W','pausePolicy','id',ID],
 ['/admin/items/17/adjustments/preview','W','previewAdjustment','id','17'],['/admin/items/17/adjustments','W','adjust','id','17'],['/admin/items/17/authorize','W','authorizeItem','id','17'],
 [`/admin/configuration/bindings/${ID}/approve`,'C','approve','id',ID],['/admin/configuration/profiles','C','create','kind','profiles'],
 [`/admin/policies/${ID}/publish`,'W','publishPolicy','id',ID],[`/admin/approval-tasks/${ID}/actions`,'W','approve','id',ID],
 ['/admin/execution-plans','E','createPlan'],[`/admin/execution-plans/${ID}/cancel`,'E','cancel','plan_id',ID],
 ...['query','retry','approve-reverse'].map((x,j)=>[`/admin/execution-orders/${ID}/${x}`,'E',['query','retry','approveReverse'][j],'order_id',ID]),
 ['/admin/return-plans','E','createReturn'],['/admin/refund-plans','E','createRefund'],['/admin/returned-funds','E','recordReturned'],[`/admin/returned-funds/${ID}/approve`,'E','approveReturned','returned_id',ID],
 ['/me/service-orders/order%3A17/acceptance','B','acceptService','id','order:17'],['/admin/settlement-statements/generate','S','generateStatement'],['/admin/statement-policies','S','setStatementPolicy'],
 ...['exports','confirmations','disputes'].map((x,j)=>[`/me/settlement-statements/${ID}/${x}`,'S',['requestExport','confirmStatement','raiseDispute'][j],'statement_id',ID]),
 [`/admin/statement-disputes/${ID}/resolve`,'S','resolveDispute','dispute_id',ID],[`/me/statement-exports/${ID}/retry`,'S','retryExport','export_id',ID],
 ['/admin/external-orders/sync','S','syncExternalOrders'],['/admin/external-evidence','S','ingestEvidence'],[`/admin/external-evidence/${ID}/reviews`,'S','reviewEvidence','evidence_id',ID],
 ['/admin/external-imports','S','importExternalEvidence'],[`/admin/external-imports/${ID}/reviews`,'S','reviewImport','import_id',ID],
 ['/admin/external-coverage','S','submitCoverage'],[`/admin/external-coverage/${ID}/reviews`,'S','reviewCoverage','coverage_id',ID],
 ['/admin/external-allocations','S','allocateExternalTrade'],['/admin/external-accruals','S','recordExternalAccrual'],['/admin/external-accrual-adjustments','S','recordExternalAccrual','event_kind','REDUCTION'],['/admin/external-settlements','S','recordExternalAccrual','event_kind','SETTLEMENT'],[`/admin/external-accruals/${ID}/reviews`,'S','reviewExternalAccrual','event_id',ID],
 ];
 for(const [path,name,method,key,value] of matrix){const result=await request(path,{method:'POST',body:{party_id:'party-A',id:'body-cannot-override'}});assert.equal(result.status,200,path+': '+JSON.stringify(result.body));const got=calls.at(-1);assert.equal(got.name,name);assert.equal(got.method,method);if(key)assert.equal(got.input[key],value);assert.equal(got.input.request_key,'http-test-key-001');}
});
test('funding and recovery lists are read-only service calls',async()=>{
 for(const [path,group,method] of [['/admin/own-fund-sources','O','listSources'],['/admin/compensations','O','listCompensations'],['/admin/compensation-recoveries','O','listRecoveries'],['/admin/recoveries','R','listRecoveries']]){assert.equal((await request(path)).status,200);assert.equal(calls.at(-1).name,group);assert.equal(calls.at(-1).method,method);}
});
test('statement metadata, dispute list and binary downloads use the actual service DTO',async()=>{
 for(const [suffix,method,key] of [[`/me/settlement-statements/${ID}`,'getStatement','statement_id'],[`/me/settlement-statements/${ID}/disputes`,'listDisputes','statement_id'],[`/me/statement-exports/${ID}`,'getExport','export_id']]){assert.equal((await request(suffix)).status,200);assert.equal(calls.at(-1).method,method);assert.equal(calls.at(-1).input[key],ID);}
 const file=await request(`/me/statement-exports/${ID}/download`);assert.equal(file.status,200);assert.equal(file.body,'approved export');assert.match(file.headers.get('content-disposition'),/filename\*=UTF-8''/);assert.equal(file.headers.get('cache-control'),'no-store');
 assert.equal((await request(`/me/settlement-statements/${OTHER}`,{token:'reader'})).status,403);
 assert.equal((await request(`/me/statement-exports/${OTHER}/download`,{token:'reader'})).status,403);
});
test('merchant submit is limited to own-party unverified reports and cannot import, link, review or accrue',async()=>{
 const good=await request('/me/external-evidence-submissions',{method:'POST',token:'submit',body:{party_id:'party-A',source_type:'PROVIDER_QUERY'}});assert.equal(good.status,200);assert.equal(calls.at(-1).input.source_type,'MERCHANT_REPORT');
 assert.equal((await request('/me/external-evidence-submissions',{method:'POST',token:'submit',body:{party_id:'party-B'}})).status,403);
 assert.equal((await request('/me/external-evidence-submissions',{method:'POST',token:'submit',body:{party_id:'party-A',alias_event_id:ID}})).status,403);
 for(const path of ['/admin/external-evidence','/admin/external-imports','/admin/external-accruals',`/admin/external-evidence/${ID}/reviews`])assert.equal((await request(path,{method:'POST',token:'submit',body:{party_id:'party-A'}})).status,403,path);
 await assert.rejects(authorize(sessions.submit,'settlement.external.write',externalScope),e=>e.status===403);
});
test('finance import aliases do not grant review or financial entitlement modification',async()=>{
 for(const path of ['/admin/external-evidence','/admin/external-imports','/admin/external-coverage'])assert.equal((await request(path,{method:'POST',token:'importer',body:{party_id:'party-A'}})).status,200,path);
 assert.equal((await request('/admin/external-evidence?party_id=party-A',{token:'importer'})).status,200);
 assert.equal((await request('/admin/external-evidence?party_id=party-B',{token:'importer'})).status,403);
 for(const path of [`/admin/external-evidence/${ID}/reviews`,`/admin/external-imports/${ID}/reviews`,'/admin/external-accruals','/admin/external-settlements'])assert.equal((await request(path,{method:'POST',token:'importer',body:{party_id:'party-A'}})).status,403,path);
 assert.equal((await request('/admin/external-evidence',{method:'POST',token:'importer',body:{party_id:'party-A',source_type:'PROVIDER_QUERY'}})).status,422);
});
test('allocation and accrual roles authorize only their specific route operations',async()=>{
 assert.equal((await request('/admin/external-allocations',{method:'POST',token:'linker',body:{party_id:'party-A'}})).status,200);
 assert.equal((await request(`/admin/external-evidence/${ID}/reviews`,{method:'POST',token:'linker',body:{party_id:'party-A'}})).status,403);
 assert.equal((await request('/admin/external-settlements',{method:'POST',token:'accrual',body:{party_id:'party-A'}})).status,200);
 assert.equal((await request('/admin/external-imports',{method:'POST',token:'accrual',body:{party_id:'party-A'}})).status,403);
});
test('permission and scope stay on the same role; beneficiary ids and missing dimensions cannot bypass restrictions',async()=>{
 const p=principal('mixed',[role(['settlement.fund.read'],{level:'all',party_ids:['party-A']}),role(['settlement.statement.read'],{level:'all',party_ids:['party-B']})]);
 await assert.rejects(authorize(p,'settlement.fund.read',{beneficiary_party_id:'party-B'}),e=>e.status===403);
 await assert.rejects(authorize(p,'settlement.fund.read',{}),e=>e.status===403);
 assert.equal(await authorize(p,'settlement.fund.read',{party_id:'party-A'}),true);
 await assert.rejects(authorize(sessions.importer,'settlement.external.read',{party_id:'party-A',biz_type:'jiazheng'}),e=>e.status===403);
 const legacy=principal('legacy',[role(['commerce.fund.write'])]);assert.equal(await authorize(legacy,'settlement.fund.write',{biz_type:'commerce'}),true);await assert.rejects(authorize(legacy,'settlement.fund.write',{biz_type:'jiazheng'}),e=>e.status===403);
});
test('operation delegation remains bound to principal and concurrent async chain',async()=>{
 await Promise.all([
  withExternalOperation(sessions.submit,'merchant_submission',async()=>{await new Promise(r=>setTimeout(r,5));assert.equal(await authorize(sessions.submit,'settlement.external.write',externalScope),true);await assert.rejects(authorize(sessions.importer,'settlement.external.write',externalScope),e=>e.status===403);}),
  (async()=>{await new Promise(r=>setTimeout(r,2));await assert.rejects(authorize(sessions.submit,'settlement.external.write',externalScope),e=>e.status===403);})(),
 ]);
 await assert.rejects(authorize(systemPrincipal,'settlement.external.review',externalScope),e=>e.status===403);
});
