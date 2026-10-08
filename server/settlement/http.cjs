'use strict';
const {assert,fault}=require('./primitives.cjs');
const {withExternalOperation}=require('./access.cjs');
const prefix='/api/settlement/v1';
const UUID='([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
const list=value=>Array.isArray(value)?{rows:value}:value;
function createHandler({service,auth,publicOrigin=''}) {
 const W=service.workflow,E=service.execution,S=service.statements,C=service.configuration;
 const routes=[];
 const route=(method,path,run)=>routes.push({method,re:path instanceof RegExp?path:new RegExp('^'+path+'$'),run});
 const externalScope=input=>({party_id:input.party_id,biz_type:'jiazheng',payment_mode:'wechat_mini'});
 async function importEvidence(p,input){
  // Browser reports cannot impersonate trusted provider-query adapters.
  assert(!input.source_type||['MERCHANT_REPORT','PROVIDER_STATEMENT','MANUAL_REVIEW'].includes(input.source_type),'请选择人工报送或机构账单凭证来源',422);
  if(input.alias_event_id)await service.authorize(p,'settlement.external.link',externalScope(input));
  return withExternalOperation(p,'finance_import',()=>S.ingestEvidence(p,input));
 }
 async function accrual(p,input){
  await service.authorize(p,'settlement.accrual.adjust',externalScope(input));
  return withExternalOperation(p,'accrual_adjustment',()=>S.recordExternalAccrual(p,input));
 }
 route('GET','/me',p=>service.me(p));
 route('GET','/admin/items',(p,i)=>W.listItems(p,i));
 route('GET',/^\/admin\/items\/(\d+)$/,async(p,i,m)=>{
  const result=await W.detail(p,{...i,id:m[1]});
  return {...result,execution_orders:list(await service.executionOrders(p,{item_id:m[1]})).rows};
 });
 route('POST',/^\/admin\/items\/(\d+)\/adjustments\/preview$/,(p,i,m)=>W.previewAdjustment(p,{...i,id:m[1]}));
 route('POST',/^\/admin\/items\/(\d+)\/adjustments$/,(p,i,m)=>W.adjust(p,{...i,id:m[1]}));
 route('POST',/^\/admin\/items\/(\d+)\/authorize$/,(p,i,m)=>W.authorizeItem(p,{...i,id:m[1]}));
 route('GET','/admin/accounts',async(p,i)=>{
  const result=list(await C.list(p,{...i,kind:'accounts'}));
  return {...result,rows:result.rows.filter(a=>a.status==='approved'&&(!i.party_id||String(a.party_id)===String(i.party_id)))};
 });
 route('GET','/admin/funding-sources',(p,i)=>service.fundingSources(p,i));
 route('GET','/admin/vendor-directory',(p,i)=>service.vendorDirectory(p,i));
 route('GET','/admin/own-fund-sources',(p,i)=>service.ownFunds.listSources(p,i));
 route('POST','/admin/own-fund-sources',(p,i)=>service.ownFunds.createSource(p,i));
 route('POST',new RegExp('^/admin/own-fund-sources/'+UUID+'/approve$'),(p,i,m)=>service.ownFunds.approveSource(p,{...i,id:m[1]}));
 route('GET','/admin/compensations',(p,i)=>service.ownFunds.listCompensations(p,i));
 route('POST','/admin/compensations',(p,i)=>service.ownFunds.createCompensation(p,i));
 route('POST',new RegExp('^/admin/compensations/'+UUID+'/approve$'),(p,i,m)=>service.ownFunds.approveCompensation(p,{...i,id:m[1]}));
 route('GET','/admin/compensation-recoveries',(p,i)=>service.ownFunds.listRecoveries(p,i));
 for(const kind of ['accounts','profiles','bindings']){
  route('GET','/admin/configuration/'+kind,(p,i)=>C.list(p,{...i,kind}));
  route('POST','/admin/configuration/'+kind,(p,i)=>C.create(p,{...i,kind}));
  route('POST',new RegExp('^/admin/configuration/'+kind+'/'+UUID+'/approve$'),(p,i,m)=>C.approve(p,{...i,kind,id:m[1]}));
 }
 route('GET','/admin/policies',(p,i)=>W.listPolicies(p,i));
 route('POST','/admin/policies',(p,i)=>W.savePolicy(p,i));
 route('POST',new RegExp('^/admin/policies/'+UUID+'/publish$'),(p,i,m)=>W.publishPolicy(p,{...i,id:m[1]}));
 route('POST',new RegExp('^/admin/policies/'+UUID+'/disable$'),(p,i,m)=>W.pausePolicy(p,{...i,id:m[1]}));
 route('GET','/admin/approval-tasks',(p,i)=>W.approvalTasks(p,i));
 route('POST',new RegExp('^/admin/approval-tasks/'+UUID+'/actions$'),(p,i,m)=>W.approve(p,{...i,id:m[1]}));
 route('GET','/admin/execution-plans',async(p,i)=>list(await E.listPlans(p,i)));
 route('POST','/admin/execution-plans',(p,i)=>E.createPlan(p,i));
 route('GET',new RegExp('^/admin/execution-plans/'+UUID+'$'),(p,i,m)=>E.getPlan(p,{...i,plan_id:m[1]}));
 route('POST',new RegExp('^/admin/execution-plans/'+UUID+'/cancel$'),(p,i,m)=>E.cancel(p,{...i,plan_id:m[1]}));
 route('GET','/admin/execution-orders',(p,i)=>service.executionOrders(p,i));
 for(const [action,fn] of [['query','query'],['retry','retry'],['approve-reverse','approveReverse']])
  route('POST',new RegExp('^/admin/execution-orders/'+UUID+'/'+action+'$'),(p,i,m)=>E[fn](p,{...i,order_id:m[1]}));
 route('POST','/admin/return-plans',(p,i)=>E.createReturn(p,i));
 route('POST','/admin/refund-plans',(p,i)=>E.createRefund(p,i));
 route('POST','/admin/returned-funds',(p,i)=>E.recordReturned(p,i));
 route('POST',new RegExp('^/admin/returned-funds/'+UUID+'/approve$'),(p,i,m)=>E.approveReturned(p,{...i,returned_id:m[1]}));
 route('GET','/admin/invariants',p=>E.verifyInvariants(p,{}));
 route('GET','/admin/recoveries',(p,i)=>service.reversals.listRecoveries(p,i));
 route('GET',/^\/me\/service-orders\/([^/]+)\/acceptance$/,(p,i,m)=>service.acceptanceStatus(p,{id:decodeURIComponent(m[1])}));
 route('POST',/^\/me\/service-orders\/([^/]+)\/acceptance$/,(p,i,m)=>service.business.acceptService(p,{...i,id:decodeURIComponent(m[1])}));
 route('POST','/admin/settlement-statements/generate',(p,i)=>S.generateStatement(p,i));
 route('POST','/admin/statement-policies',(p,i)=>S.setStatementPolicy(p,i));
 route('GET','/me/statement-policy',(p,i)=>S.listStatementPolicies(p,i));
 route('GET','/me/settlement-statements',(p,i)=>S.listStatements(p,i));
 route('GET',new RegExp('^/me/settlement-statements/'+UUID+'$'),(p,i,m)=>S.getStatement(p,{...i,statement_id:m[1]}));
 for(const [action,fn] of [['exports','requestExport'],['confirmations','confirmStatement'],['disputes','raiseDispute']])
  route('POST',new RegExp('^/me/settlement-statements/'+UUID+'/'+action+'$'),(p,i,m)=>S[fn](p,{...i,statement_id:m[1]}));
 route('GET',new RegExp('^/me/settlement-statements/'+UUID+'/disputes$'),(p,i,m)=>S.listDisputes(p,{...i,statement_id:m[1]}));
 route('POST',new RegExp('^/admin/statement-disputes/'+UUID+'/resolve$'),(p,i,m)=>S.resolveDispute(p,{...i,dispute_id:m[1]}));
 route('GET',new RegExp('^/me/statement-exports/'+UUID+'$'),(p,i,m)=>S.getExport(p,{...i,export_id:m[1]}));
 route('POST',new RegExp('^/me/statement-exports/'+UUID+'/retry$'),(p,i,m)=>S.retryExport(p,{...i,export_id:m[1]}));
 route('GET',new RegExp('^/me/statement-exports/'+UUID+'/download$'),async(p,i,m)=>({download:await S.downloadExport(p,{...i,export_id:m[1]})}));
 route('POST','/admin/external-orders/sync',(p,i)=>withExternalOperation(p,'finance_import',()=>S.syncExternalOrders(p,i)));
 route('GET','/admin/external-evidence',(p,i)=>S.listExternalEvents(p,i));
 route('GET','/admin/external-facts',(p,i)=>S.listExternalEvents(p,i));
 route('POST','/admin/external-evidence',importEvidence);
 route('POST','/me/external-evidence-submissions',(p,i)=>{
  assert(!i.alias_event_id,'交易关联变更需独立授权',403);
  return withExternalOperation(p,'merchant_submission',()=>S.ingestEvidence(p,{...i,source_type:'MERCHANT_REPORT'}));
 });
 route('POST',new RegExp('^/admin/external-evidence/'+UUID+'/reviews$'),(p,i,m)=>S.reviewEvidence(p,{...i,evidence_id:m[1]}));
 route('POST','/admin/external-imports',(p,i)=>{
  assert(!i.source_type||['MERCHANT_REPORT','PROVIDER_STATEMENT','MANUAL_REVIEW'].includes(i.source_type),'导入凭证来源无效',422);
  return withExternalOperation(p,'finance_import',()=>S.importExternalEvidence(p,i));
 });
 route('POST',new RegExp('^/admin/external-imports/'+UUID+'/reviews$'),(p,i,m)=>S.reviewImport(p,{...i,import_id:m[1]}));
 route('POST','/admin/external-coverage',(p,i)=>withExternalOperation(p,'finance_import',()=>S.submitCoverage(p,i)));
 route('POST','/me/external-coverage-submissions',(p,i)=>withExternalOperation(p,'merchant_submission',()=>S.submitCoverage(p,i)));
 route('POST',new RegExp('^/admin/external-coverage/'+UUID+'/reviews$'),(p,i,m)=>S.reviewCoverage(p,{...i,coverage_id:m[1]}));
 route('POST','/admin/external-allocations',(p,i)=>withExternalOperation(p,'trade_allocation',()=>S.allocateExternalTrade(p,i)));
 route('POST','/admin/external-accruals',accrual);
 route('POST','/admin/external-accrual-adjustments',(p,i)=>accrual(p,{...i,event_kind:'REDUCTION'}));
 route('POST','/admin/external-settlements',(p,i)=>accrual(p,{...i,event_kind:'SETTLEMENT'}));
 route('POST',new RegExp('^/admin/external-accruals/'+UUID+'/reviews$'),(p,i,m)=>S.reviewExternalAccrual(p,{...i,event_id:m[1]}));

 return async function handle(req,res){
  const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
  try{
   const url=new URL(req.url,'http://localhost'),path=url.pathname.slice(prefix.length),method=req.method;
   assert(url.pathname.startsWith(prefix+'/'),'接口不存在',404);
   assert(['GET','POST'].includes(method),'请求方法不支持',405);
   let session=await auth.verifySessionToken(auth.bearerToken(req)),cookieSession=false;
   if(!session&&/(?:^|;\s*)(?:lianjia_token|lj_token)=/.test(req.headers.cookie||'')){
    const cookie=await auth.principalOf(req);
    if(cookie?.type==='account'&&cookie.via==='lianjia_token'){session=cookie;cookieSession=true;}
   }
   assert(session?.account?.status==='active'&&session.account.principal_type==='user','请登录后继续',401);
   const p={...session,type:'account'};
   const matched=routes.map(r=>({r,m:path.match(r.re)})).filter(x=>x.m);
   assert(matched.length,'接口不存在',404);
   const selected=matched.find(x=>x.r.method===method);
   assert(selected,'请求方法不支持',405);
   let input=Object.fromEntries(url.searchParams);
   if(method==='POST'){
    const expected=new URL(publicOrigin||'http://'+req.headers.host);
    const originMatches=value=>{try{const parsed=new URL(value);return /^https?:$/.test(parsed.protocol)&&parsed.host===expected.host&&(!publicOrigin||parsed.origin===expected.origin);}catch{return false;}};
    if(req.headers.origin)assert(originMatches(req.headers.origin),'不允许跨站操作',403);
    assert(req.headers['sec-fetch-site']!=='cross-site','不允许跨站操作',403);
    if(cookieSession&&!req.headers.origin)assert(req.headers['sec-fetch-site']==='same-origin'||originMatches(req.headers.referer),'Cookie操作须有同源请求证明',403);
    assert((req.headers['content-type']||'').split(';')[0].trim().toLowerCase()==='application/json','请求格式必须为JSON',415);
    const key=req.headers['idempotency-key'];
    assert(typeof key==='string'&&/^[\x21-\x7e]{8,100}$/.test(key),'请提供8至100个可打印字符的 Idempotency-Key');
    let bytes=0;const limit=path==='/admin/external-imports'?12*1024*1024:4*1024*1024;
    const chunks=[];
    for await(const part of req){bytes+=part.length;assert(bytes<=limit,'请求内容过大',413);chunks.push(part);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw fault('JSON格式无效');}
    assert(body&&typeof body==='object'&&!Array.isArray(body),'请求格式无效');
    input={...input,...body,request_key:key};
   }
   const result=await selected.r.run(p,input,selected.m);
   assert(result!==undefined,'接口没有返回结果',500);
   if(result.download){
    const file=result.download;
    res.writeHead(200,{'Content-Type':file.contentType||file.content_type||'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.filename),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(file.buffer);return;
   }
   reply(200,{data:result});
  }catch(e){const status=e.status||e.statusCode||500;reply(status,{error:status<500?e.message:'结算服务暂时不可用',code:e.code||'settlement_error'});}
 };
}
module.exports={createHandler,prefix};
