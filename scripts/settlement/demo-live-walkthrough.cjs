'use strict';
// Real HTTP and browser walkthrough for an explicitly supplied settlement seed.
// No frontend fixtures, database access, provider overrides, or default website.
// Example (credentials remain in the host environment):
// node scripts/settlement/demo-live-walkthrough.cjs --origin http://127.0.0.1:38780 \
//   --manifest /tmp/settlement-seed.json --password-env SETTLEMENT_DEMO_PASSWORD \
//   --output /tmp/settlement-walkthrough
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const BASE='/api/settlement/v1',ROLES=['operator','reviewer','reviewer2','merchant','promoter','platform'];
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const list=value=>Array.isArray(value)?value:value?.rows||[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function argsOf(argv){const out={};for(let i=0;i<argv.length;i++){const name=argv[i];assert(name.startsWith('--'),'Arguments must use named options');const key=name.slice(2);if(['help','validate-only','read-only'].includes(key))out[key]=true;else{assert(argv[i+1]&&!argv[i+1].startsWith('--'),'Missing value for '+name);out[key]=argv[++i];}}return out;}
function readJSON(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function normalizeManifest(raw){
 const scenarios=raw.scenarios||raw,actors=raw.actors||raw.accounts;
 assert(raw.run_id||raw.seed_id,'Manifest requires run_id');assert(actors,'Manifest requires actors');
 const normalized={...raw,run_id:String(raw.run_id||raw.seed_id),actors,scenarios};
 for(const role of ROLES){const a=actors[role];assert(a,'Missing manifest actor '+role);a.login_name=a.login_name||a.login;assert(a.login_name==='settlement_demo_'+role,'Refusing a non-walkthrough login');a.id=String(a.account_id||a.id||a.principal?.account?.id||'');assert(a.id,'Missing account ID for '+role);a.party_ids=(a.party_ids||a.parties||a.principal?.roles?.flatMap(r=>r.scope?.party_ids||[])||[]).map(String);assert(a.party_ids.length,'Missing party scope for '+role);}
 const adjustment=scenarios.adjustment;assert(adjustment?.item_id&&adjustment.context_id&&adjustment.alternate_account_id,'Missing adjustment item/context/alternate account');
 const unknown=scenarios.unknown;assert(unknown?.item_id&&(unknown.execution_order_id||unknown.order_id)&&unknown.request_no,'Missing UNKNOWN execution scenario');unknown.execution_order_id=unknown.execution_order_id||unknown.order_id;
 assert(scenarios.external?.party_id&&scenarios.external.context_id,'Missing external evidence scenario');
 assert(/^\d+$/.test(String(scenarios.external.amount_minor||''))&&BigInt(scenarios.external.amount_minor)>0n,'External walkthrough requires an explicit payment amount');
 for(const field of ['channel','environment','merchant_account','occurred_at'])assert(scenarios.external[field],'External walkthrough requires '+field);
 normalized.statements=raw.statements||scenarios.statements;assert(Array.isArray(normalized.statements)&&normalized.statements.length,'Missing seeded statements');
 for(const s of normalized.statements)assert(s.id&&s.party_id&&actors[s.actor||'merchant'],'Statement requires id, party_id, and valid actor');
 normalized.allowed_item_ids=[...new Set([...(raw.allowed_item_ids||[]),adjustment.item_id,unknown.item_id].map(String))];
 normalized.allowed_context_ids=[...new Set([...(raw.allowed_context_ids||[]),adjustment.context_id,scenarios.external.context_id].map(String))];
 normalized.allowed_party_ids=[...new Set([...(raw.allowed_party_ids||[]),...Object.values(actors).flatMap(a=>a.party_ids)].map(String))];
 assert(normalized.allowed_party_ids.every(p=>p.startsWith('demo-')),'Only seeded demo legal parties may be modified');
 return normalized;
}
function createBoundary(manifest){
 const items=new Set(manifest.allowed_item_ids),contexts=new Set(manifest.allowed_context_ids),parties=new Set(manifest.allowed_party_ids),statements=new Set(manifest.statements.map(s=>String(s.id)));
 const approvals=new Set(),evidence=new Set(),exports=new Set();
 const orders=new Set([String(manifest.scenarios.unknown.execution_order_id)]);
 function check(route,body){
  const p=new URL(route,'http://walkthrough.invalid').pathname;let m;
  if((m=p.match(/^\/admin\/items\/([^/]+)\/adjustments(?:\/preview)?$/))){assert(items.has(m[1]),'Mutation outside seeded item');assert.equal(m[1],String(manifest.scenarios.adjustment.item_id));assert(body.kind==='PAYMENT_ARRANGEMENT','Walkthrough only changes payment arrangement');assert.equal(String(body.account_id),String(manifest.scenarios.adjustment.alternate_account_id));assert(!body.delta_minor&&!body.source_id,'Walkthrough must not create financial entitlement');return;}
  if((m=p.match(/^\/admin\/approval-tasks\/([^/]+)\/actions$/))){assert(approvals.has(m[1]),'Approval was not discovered from seeded item');assert(['approve','reject'].includes(body.action));return;}
  if((m=p.match(/^\/admin\/execution-orders\/([^/]+)\/query$/))){assert(orders.has(m[1]),'Query outside seeded execution order');return;}
  if(p==='/me/external-evidence-submissions'){assert.equal(String(body.party_id),String(manifest.scenarios.external.party_id));assert(contexts.has(String(body.context_id)));assert.equal(String(body.context_id),String(manifest.scenarios.external.context_id));assert.equal(body.event_kind,'PAYMENT');assert(body.transaction_id===manifest.walkthrough_transaction_id,'Evidence must use the walkthrough transaction');assert.equal(String(body.amount_minor),String(manifest.scenarios.external.amount_minor));assert.equal(body.currency,'CNY');for(const field of ['channel','environment','merchant_account'])assert.equal(String(body[field]),String(manifest.scenarios.external[field]),'Evidence route differs from dedicated seed');return;}
  if((m=p.match(/^\/admin\/external-evidence\/([^/]+)\/reviews$/))){assert(evidence.has(m[1]),'Review outside walkthrough evidence');assert.equal(body.decision,'verify');return;}
  if((m=p.match(/^\/me\/settlement-statements\/([^/]+)\/(exports|confirmations|disputes)$/))){assert(statements.has(m[1]),'Statement mutation outside seed');if(m[2]==='exports')assert(['csv','xlsx','pdf'].includes(body.format));return;}
  throw new Error('Unplanned mutation blocked: '+p);
 }
 return {check,items,contexts,parties,statements,approvals,evidence,exports,orders};
}
const yuan=value=>{const n=BigInt(value);assert(n>=0n);return String(n/100n)+'.'+String(n%100n).padStart(2,'0');};
function instant(value){return new Date(typeof value==='string'&&/^\d{4}-\d\d-\d\d \d\d:/.test(value)?value.replace(' ','T')+'Z':value);}
async function run(options){
 assert(options.origin&&options.manifest,'Explicit --origin and --manifest are required');
 const origin=new URL(options.origin).origin;assert(/^https?:/.test(origin));
 assert(['127.0.0.1','localhost','[::1]','sytest.meizu.life'].includes(new URL(origin).hostname),'Only loopback or the designated test site is supported');
 const manifest=normalizeManifest(readJSON(path.resolve(options.manifest)));
 if(manifest.origin)assert.equal(new URL(manifest.origin).origin,origin,'Origin does not match seed manifest');
 manifest.walkthrough_transaction_id=manifest.scenarios.external.transaction_id||'walkthrough-'+hash(manifest.run_id).slice(0,24);
 const boundary=createBoundary(manifest);
 if(options['validate-only'])return {validated:true,run_id:manifest.run_id,actors:ROLES,statements:manifest.statements.length};
 const credentials=options.credentials?readJSON(path.resolve(options.credentials)):{};
 const passwordEnv=options['password-env']||'SETTLEMENT_DEMO_PASSWORD';
 const passwordFor=role=>credentials.actors?.[role]?.password||credentials[role]?.password||credentials.password||process.env[passwordEnv];
 ROLES.forEach(role=>assert(typeof passwordFor(role)==='string'&&passwordFor(role).length>=12,'Missing host-managed credentials for '+role));
 const output=path.resolve(options.output||path.join('/tmp','settlement-walkthrough-'+hash(manifest.run_id).slice(0,12)));fs.mkdirSync(output,{recursive:true,mode:0o700});
 const stateFile=path.join(output,'walkthrough-state.json'),manifestHash=hash({run_id:manifest.run_id,actors:Object.fromEntries(ROLES.map(k=>[k,manifest.actors[k].id])),scenarios:manifest.scenarios,statements:manifest.statements});
 const journal=fs.existsSync(stateFile)?readJSON(stateFile):{run_id:manifest.run_id,manifest_hash:manifestHash,origin,operations:{},targets:{}};
 assert.equal(journal.manifest_hash,manifestHash,'Existing output belongs to a different seed');assert.equal(journal.origin,origin);
 const save=()=>fs.writeFileSync(stateFile,JSON.stringify(journal,null,2),{mode:0o600});
 const report={run_id:manifest.run_id,origin,read_only:!!options['read-only'],checks:[],screenshots:[],downloads:[],requests:[],started_at:new Date().toISOString()};
 const tokens={},identities={},browserErrors=[],blocked=[];
 function recordCheck(name){report.checks.push(name);console.log('[walkthrough] '+name);}
 async function http(role,route,body,operation){
  const headers={Accept:'application/json',Authorization:'Bearer '+tokens[role]};let stored;
  if(body!==undefined){assert(operation,'Every mutation requires a durable operation name');assert(!options['read-only'],'Read-only mode prohibits mutations');stored=journal.operations[operation];if(stored){assert.equal(stored.role,role);assert.equal(stored.route,route);body=stored.body;}boundary.check(route,body);const key=stored?.key||'walkthrough:'+hash([manifest.run_id,role,operation]).slice(0,48);headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(!stored){stored=journal.operations[operation]={role,route,key,body};save();}}
  const response=await fetch(origin+BASE+route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error'});
  report.requests.push({role,method:body===undefined?'GET':'POST',path:route.split('?')[0],status:response.status});
  let data;try{data=await response.json();}catch{throw new Error('Expected JSON from '+route+' (HTTP '+response.status+')');}
  if(!response.ok||data.error){const e=new Error('HTTP '+response.status+' at '+route+': '+String(data.code||data.error||'request failed'));e.status=response.status;throw e;}
  const result=data.data??data;if(stored){stored.result=result;save();}return result;
 }
 for(const role of ROLES){
  const actor=manifest.actors[role];const response=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login_name:actor.login_name,password:passwordFor(role)}),redirect:'error'});
  const result=await response.json();assert(response.ok&&typeof result.token==='string','Login failed for '+role+' (HTTP '+response.status+')');tokens[role]=result.token;
  const me=await http(role,'/me');assert.equal(String(me.account.id),actor.id,'Authenticated actor differs from manifest');assert(me.parties.every(p=>actor.party_ids.includes(String(p.id))),'Role sees a legal party outside its seed scope');identities[role]=me;
 }
 recordCheck('six-real-logins-and-party-scope');
 const {chromium}=require(process.env.COMMERCE_PLAYWRIGHT_MODULE||'/tmp/e2e/node_modules/playwright-core');
 const browser=await chromium.launch({executablePath:process.env.COMMERCE_CHROME||'/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
 const sessions={},intents=new Map();
 async function pageFor(role){
  if(sessions[role])return sessions[role].page;
  const context=await browser.newContext({viewport:{width:1440,height:1050},acceptDownloads:true,timezoneId:'Asia/Shanghai'});
  await context.addInitScript(token=>{localStorage.setItem('BZF_SESSION_TOKEN',token);localStorage.removeItem('BJZ_TOKEN');},tokens[role]);
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(!/^https?:$/.test(url.protocol))return route.continue();
   if(url.origin!==origin){blocked.push('Cross-origin browser request blocked');return route.abort();}
   if(['GET','HEAD'].includes(req.method()))return route.continue();
   const intent=intents.get(role);
   try{
    assert(!options['read-only'],'Browser writes disabled');assert(req.method()==='POST'&&url.pathname.startsWith(BASE+'/'),'Unexpected browser mutation');
    const relative=url.pathname.slice(BASE.length);assert(intent&&intent.route===relative,'No scoped intent for browser mutation');
    let body=req.postDataJSON(),stored=journal.operations[intent.operation];
    if(stored){assert.equal(stored.role,role);assert.equal(stored.route,relative);body=stored.body;}boundary.check(relative,body);
    const key=stored?.key||'walkthrough:'+hash([manifest.run_id,role,intent.operation]).slice(0,48);
    if(!stored){journal.operations[intent.operation]={role,route:relative,key,body};save();}
    await route.continue({headers:{...req.headers(),'idempotency-key':key},postData:JSON.stringify(body)});
   }catch(e){blocked.push(e.message);await route.abort();}
  });
  const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>browserErrors.push(role+': '+error.message));sessions[role]={context,page};return page;
 }
 async function uiWrite(role,operation,route,action){
  const page=await pageFor(role);intents.set(role,{operation,route});
  try{const pending=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===BASE+route);await action(page);const response=await pending;const payload=await response.json();assert(response.ok()&&!payload.error,'Browser mutation failed ('+response.status()+') at '+route+': '+String(payload.code||payload.error||''));const result=payload.data??payload;assert(journal.operations[operation],'Browser write was not journaled');journal.operations[operation].result=result;save();report.requests.push({role,method:'POST',path:route,status:response.status()});return result;}finally{intents.delete(role);}
 }
 async function goto(role,kind='admin'){const page=await pageFor(role);await page.goto(origin+'/screens/settlement-'+kind+'.html',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#settlement-content')?.getAttribute('aria-busy')==='false');assert.equal(await page.getByText('暂时无法读取结算数据',{exact:true}).count(),0);return page;}
 async function closeDialogs(page){await page.evaluate(()=>document.querySelectorAll('dialog').forEach(d=>d.close()));}
 async function screenshot(page,name){const file=path.join(output,name+'.png');await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);}
 async function tab(role,name,party){const page=await goto(role);await page.locator('[data-action=tab][data-id="'+name+'"]').click();await page.waitForFunction(()=>document.querySelector('#settlement-content').getAttribute('aria-busy')==='false');if(party){await page.locator('#settlement-filter [name=party_id]').selectOption(party);await page.locator('#settlement-filter [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#settlement-content').getAttribute('aria-busy')==='false');}assert(await page.locator('#settlement-content tbody tr').count()>0,'Empty walkthrough tab '+role+'/'+name);return page;}
 try{
  for(const name of ['items','policies','configuration','own-funds'])await tab('operator',name);
  await tab('operator','external',manifest.scenarios.external.party_id);await screenshot(await tab('operator','items'),'01-admin-items');
  await tab('reviewer','approvals');recordCheck('all-admin-tabs-have-persisted-data');
  const adjustment=manifest.scenarios.adjustment,adjustId=String(adjustment.item_id),adjustRoute='/admin/items/'+encodeURIComponent(adjustId);
  const original=await http('operator',adjustRoute);assert.equal(String(original.context_id),String(adjustment.context_id));assert(boundary.parties.has(String(original.beneficiary_party_id)));
  const accounts=list(await http('operator','/admin/accounts?party_id='+encodeURIComponent(original.beneficiary_party_id)));
  assert(accounts.some(a=>String(a.id)===String(adjustment.alternate_account_id)&&String(a.party_id)===String(original.beneficiary_party_id)&&a.status==='approved'),'Alternate account is not approved for the seeded beneficiary');
  if(!options['read-only']){
   if(journal.operations['adjustment.submit']&&!journal.operations['adjustment.submit'].result)await http('operator',adjustRoute+'/adjustments',journal.operations['adjustment.submit'].body,'adjustment.submit');
   if(!journal.operations['adjustment.submit']?.result){
    const planned=BigInt(original.planned_minor);assert(planned>1n,'Seed needs an adjustable positive amount');
    journal.targets.adjustment=journal.targets.adjustment||{planned_minor:String(adjustment.planned_minor||planned-(planned>100n?100n:1n)),not_before_at:adjustment.not_before_at||new Date(Date.now()+3600000).toISOString()};save();
    const target=journal.targets.adjustment,page=await tab('operator','items');await page.locator('[data-action=item][data-id="'+adjustId+'"]').click();await page.locator('dialog [data-action=adjust]').click();
    await page.locator('dialog [name=planned]').fill(yuan(target.planned_minor));await page.locator('dialog [name=account_id]').selectOption(String(adjustment.alternate_account_id));
    const local=await page.evaluate(date=>{const d=new Date(date);return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);},target.not_before_at);await page.locator('dialog [name=not_before_at]').fill(local);await page.locator('dialog [name=reason]').fill('结算走查：按约定调整单次付款金额、时间和已准入收款账户');await page.locator('dialog [name=evidence]').fill('walkthrough:'+manifest.run_id);
    await uiWrite('operator','adjustment.preview',adjustRoute+'/adjustments/preview',p=>p.locator('dialog [type=submit]').click());await page.getByRole('button',{name:'确认提交调整',exact:true}).waitFor();await screenshot(page,'02-adjustment-preview');
    await uiWrite('operator','adjustment.submit',adjustRoute+'/adjustments',p=>p.locator('dialog [type=submit]').click());await page.waitForFunction(()=>!document.querySelector('dialog'));
   }
   const submitted=journal.operations['adjustment.submit'].result;assert(submitted.approval_id,'Adjustment did not create a review task');boundary.approvals.add(String(submitted.approval_id));
   const route='/admin/approval-tasks/'+encodeURIComponent(submitted.approval_id)+'/actions';
   for(const role of ['reviewer','reviewer2']){
    const tasks=list(await http(role,'/admin/approval-tasks')),task=tasks.find(t=>String(t.id)===String(submitted.approval_id)&&String(t.item_id)===adjustId);if(!task)continue;
    const page=await tab(role,'approvals');await page.locator('[data-action=approval][data-id="'+task.id+'"]').click();await page.locator('dialog [name=note]').fill('独立走查复核：金额、付款时间及同主体账户已核对');await screenshot(page,'03-'+role+'-approval');
    await uiWrite(role,'adjustment.approve.'+role,route,p=>p.locator('dialog [type=submit]').click());await page.waitForFunction(()=>!document.querySelector('dialog'));
   }
   const changed=await http('operator',adjustRoute),saved=journal.operations['adjustment.submit'].body;
   assert.equal(String(changed.planned_minor),String(saved.planned_minor));assert.equal(String(changed.account_id),String(saved.account_id));assert.equal(instant(changed.not_before_at).getTime(),instant(saved.not_before_at).getTime());assert.equal(String(changed.payable_minor),String(original.payable_minor),'Payment arrangement changed the financial entitlement');
   const record=changed.adjustments.find(a=>String(a.id)===String(submitted.adjustment_id));assert.equal(record?.status,'APPLIED');assert.notEqual(String(record.created_by),String(record.reviewed_by));recordCheck('browser-adjustment-amount-time-account-independent-review');
   // A replay must use exactly the journaled body and original Idempotency-Key.
   const replay=await http('operator',adjustRoute+'/adjustments',saved,'adjustment.submit');assert.equal(replay.adjustment_id,submitted.adjustment_id);recordCheck('same-key-adjustment-replay');
   const unknown=manifest.scenarios.unknown,orders=list(await http('operator','/admin/execution-orders?item_id='+encodeURIComponent(unknown.item_id))),before=orders.find(o=>String(o.id)===String(unknown.execution_order_id));assert(before,'Seeded UNKNOWN order missing');assert.equal(before.request_no,unknown.request_no);
   const page=await tab('operator','items');await page.locator('[data-action=item][data-id="'+unknown.item_id+'"]').click();await uiWrite('operator','execution.query','/admin/execution-orders/'+encodeURIComponent(unknown.execution_order_id)+'/query',p=>p.locator('dialog [data-action=query-execution][data-id="'+unknown.execution_order_id+'"]').click());await closeDialogs(page);
   let afterOrders,after;const expectedStatus=unknown.expected_status||'SUCCEEDED';
   for(let attempt=0;attempt<60;attempt++){afterOrders=list(await http('operator','/admin/execution-orders?item_id='+encodeURIComponent(unknown.item_id)));after=afterOrders.find(o=>String(o.id)===String(unknown.execution_order_id));assert.equal(after?.request_no,unknown.request_no);if(after.status===expectedStatus)break;assert(!['FAILED_FINAL','CANCELLED'].includes(after.status),'Seeded provider query failed');if(attempt%20===0)console.log('[walkthrough] waiting for original provider request query');await sleep(1000);}
   assert.equal(after.status,expectedStatus,'Original provider request did not reach expected status');assert.deepEqual(afterOrders.map(o=>String(o.id)).sort(),orders.map(o=>String(o.id)).sort(),'Query created a new payment order');recordCheck('unknown-query-keeps-original-provider-request');
   const external=manifest.scenarios.external;
   const externalBefore=list(await http('operator','/admin/external-evidence?party_id='+encodeURIComponent(external.party_id))).filter(e=>String(e.context_id)===String(external.context_id)&&e.event_kind==='PAYMENT');
   assert(!externalBefore.some(e=>e.transaction_id!==manifest.walkthrough_transaction_id&&e.amount_minor!=null&&BigInt(e.amount_minor)>0n),'Refusing to add a second payment to an already known-payment context');

   if(journal.operations['external.submit']&&!journal.operations['external.submit'].result)await http('merchant','/me/external-evidence-submissions',journal.operations['external.submit'].body,'external.submit');
   if(!journal.operations['external.submit']?.result){const page=await goto('merchant','statements');await page.locator('[data-action=submit-evidence]').click();for(const [name,value] of Object.entries({party_id:external.party_id,event_kind:'PAYMENT',environment:external.environment}))await page.locator('dialog [name='+name+']').selectOption(String(value));for(const [name,value] of Object.entries({channel:external.channel,merchant_account:external.merchant_account,transaction_id:manifest.walkthrough_transaction_id,context_id:external.context_id,amount:yuan(external.amount_minor),evidence_ref:'walkthrough:'+manifest.run_id+':external-payment'}))await page.locator('dialog [name='+name+']').fill(String(value));
    journal.targets.external_time=journal.targets.external_time||external.occurred_at||new Date().toISOString();save();const local=await page.evaluate(date=>{const d=new Date(date);return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);},journal.targets.external_time);await page.locator('dialog [name=occurred_at]').fill(local);await uiWrite('merchant','external.submit','/me/external-evidence-submissions',p=>p.locator('dialog [type=submit]').click());await page.waitForFunction(()=>!document.querySelector('dialog'));}
   const submittedEvidence=journal.operations['external.submit'].result;assert(submittedEvidence.evidence_id&&submittedEvidence.event_id);boundary.evidence.add(String(submittedEvidence.evidence_id));
   if(journal.operations['external.review']&&!journal.operations['external.review'].result)await http('reviewer','/admin/external-evidence/'+encodeURIComponent(submittedEvidence.evidence_id)+'/reviews',journal.operations['external.review'].body,'external.review');
   if(!journal.operations['external.review']?.result){const page=await tab('reviewer','external',external.party_id);await page.locator('[data-action=review-evidence][data-id="'+submittedEvidence.event_id+'"]').click();await page.locator('dialog [name=note]').fill('独立走查核验：外部交易时间、币种、金额和凭证一致');await uiWrite('reviewer','external.review','/admin/external-evidence/'+encodeURIComponent(submittedEvidence.evidence_id)+'/reviews',p=>p.locator('dialog [type=submit]').click());await page.waitForFunction(()=>!document.querySelector('dialog'));}
   assert.equal(journal.operations['external.review'].result.status,'VERIFIED');
   const externalAfter=list(await http('operator','/admin/external-evidence?party_id='+encodeURIComponent(external.party_id))).filter(e=>String(e.context_id)===String(external.context_id)&&e.event_kind==='PAYMENT'&&e.verification_status==='VERIFIED');assert.equal(externalAfter.reduce((total,e)=>total+BigInt(e.amount_minor||0),0n).toString(),String(external.amount_minor),'Verified external payments exceed this dedicated order amount');recordCheck('merchant-external-evidence-independent-verification');
  }
  for(const role of ['merchant','promoter','platform']){
   const owned=manifest.statements.find(s=>(s.actor||'merchant')===role);assert(owned,'Missing '+role+' statement');
   const own=await http(role,'/me/settlement-statements/'+owned.id);assert.equal(String(own.party_id),String(owned.party_id));
   const foreign=manifest.statements.find(s=>!manifest.actors[role].party_ids.includes(String(s.party_id)));assert(foreign,'No foreign statement to verify isolation');await assert.rejects(http(role,'/me/settlement-statements/'+foreign.id),e=>[403,404].includes(e.status));
   const page=await goto(role,'statements');await page.locator('#settlement-filter [name=party_id]').selectOption(String(owned.party_id));await page.locator('#settlement-filter [type=submit]').click();await page.locator('[data-action=statement][data-id="'+owned.id+'"]').waitFor();assert.equal(await page.locator('[data-action=generate-statement]').count(),0);assert.equal(await page.locator('[data-action=tab]').count(),0);await screenshot(page,'04-statements-'+role);
  }
  recordCheck('merchant-promoter-platform-statement-isolation');
  if(!options['read-only']){
   const statement=manifest.statements.find(s=>(s.actor||'merchant')==='merchant'),page=await goto('merchant','statements');await page.locator('#settlement-filter [name=party_id]').selectOption(String(statement.party_id));await page.locator('#settlement-filter [type=submit]').click();await page.locator('[data-action=statement][data-id="'+statement.id+'"]').click();
   for(const format of ['csv','xlsx','pdf']){
    const route='/me/settlement-statements/'+statement.id+'/exports',result=await http('merchant',route,{format},'export.'+format);boundary.exports.add(String(result.id));let job=result;
    for(let attempts=0;job.status!=='READY'&&attempts<90;attempts++){assert(!['FAILED','REJECTED','EXPIRED'].includes(job.status),'Export job '+format+' failed: '+String(job.error_code||job.status));await sleep(1000);job=await http('merchant','/me/statement-exports/'+result.id);}assert.equal(job.status,'READY','Export worker did not complete '+format);
    const downloaded=page.waitForEvent('download');await uiWrite('merchant','export.browser.'+format,route,p=>p.locator('[data-action=export-'+format+']').click());const file=await downloaded;assert(file.suggestedFilename().endsWith('.'+format));const filename=path.join(output,'statement-'+format+'.'+format);await file.saveAs(filename);const bytes=fs.readFileSync(filename);assert(bytes.length>20,'Empty downloaded statement');if(format==='pdf')assert.equal(bytes.subarray(0,5).toString(),'%PDF-');if(format==='xlsx')assert.equal(bytes.subarray(0,2).toString(),'PK');if(format==='csv')assert(!/^\s*</.test(bytes.toString('utf8')),'CSV response was HTML');report.downloads.push({format,path:filename,bytes:bytes.length,sha256:hash(bytes)});
   }
   await screenshot(page,'05-statement-detail-downloads');await closeDialogs(page);recordCheck('browser-downloads-real-csv-xlsx-pdf');
  }
  const mobile=await goto('merchant','statements');await mobile.setViewportSize({width:390,height:844});await screenshot(mobile,'06-statements-mobile');assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);recordCheck('mobile-without-horizontal-page-overflow');
  assert.deepEqual(blocked,[],'Unexpected browser requests were blocked');assert.deepEqual(browserErrors,[],'Browser execution errors');report.passed=true;
 }finally{report.finished_at=new Date().toISOString();fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2),{mode:0o600});await browser.close();}
 return {passed:report.passed,run_id:manifest.run_id,checks:report.checks,output,requests:report.requests.length,screenshots:report.screenshots.length,downloads:report.downloads.length};
}
async function main(){const options=argsOf(process.argv.slice(2));if(options.help){console.log('Usage: node scripts/settlement/demo-live-walkthrough.cjs --origin URL --manifest PATH [--credentials HOST_JSON | --password-env NAME] [--output DIR] [--validate-only | --read-only]\nOnly the manifest seed is modified. Writes retain their request bodies and idempotency keys in the private output journal; no passwords or session tokens are saved.');return;}console.log(JSON.stringify(await run(options),null,2));}
if(require.main===module)main().catch(error=>{console.error('Walkthrough failed: '+error.message);process.exitCode=1;});
module.exports={argsOf,normalizeManifest,createBoundary,run};
