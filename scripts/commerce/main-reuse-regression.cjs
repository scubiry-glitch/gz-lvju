'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Service}=require('../../commerce/service.cjs');
const {seed}=require('../../commerce/guiyang-demo.cjs');
const {demoOrder}=require('../../commerce/demo-order.cjs');
async function run({base,db,auth,sourceDatabase,root,database}){
 const results=[],check=async(name,fn)=>{await fn();results.push({name,passed:true});console.log('PASS '+name);};
 for(const t of ['jz_categories','jz_skus'])await root.query('INSERT IGNORE INTO `'+database+'`.`'+t+'` SELECT * FROM `'+sourceDatabase+'`.`'+t+'`');
 await db.query("INSERT IGNORE INTO cities(id,name,slug) VALUES(3,'贵阳','guiyang')");await seed(db);
 for(const [code,permissions]of [['reuse-user',[]],['reuse-operator',['*']]])await db.execute('INSERT INTO roles(role_code,name,permissions,builtin) VALUES(?,?,?,0)',[code,code,JSON.stringify(permissions)]);
 const actors={};for(const [name,role]of [['owner','reuse-user'],['other','reuse-user'],['operator','reuse-operator']]){const [r]=await db.execute("INSERT INTO accounts(display_name,principal_type,status) VALUES(?,'user','active')",[name]);await db.execute('INSERT INTO account_roles(account_id,role_code,scope) VALUES(?,?,?)',[r.insertId,role,JSON.stringify({level:role==='reuse-operator'?'all':'self'})]);actors[name]={type:'account',...await auth.getAccountWithRoles(r.insertId)};actors[name].token=(await auth.createSession(r.insertId,'127.0.0.1','isolated main-system acceptance')).token;}
 const service=new Service(db,auth),catalog=await service.catalog('guiyang'),sku=catalog.find(p=>p.kind==='skus');
 const order=await demoOrder(service,actors.owner,{kind:'skus',product_id:sku.id,version:sku.version,demo_ack:true},'main-system-purchase');
 const coupon=(await service.my(actors.owner)).coupons.find(c=>c.order_id===order.id);
 const call=async(route,actor=actors.owner,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{Authorization:'Bearer '+actor.token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
 let work;
 await check('Main order centre reads the same entitlement order with correct account ownership',async()=>{
  const mine=await call('/api/juzhu/gr/orders?source=account');assert.equal(mine.status,200);assert(mine.data.list.some(o=>o.order_ref===order.id&&o.product_name===sku.name&&o.is_demo&&o.fee===0));
  const detail=await call('/api/juzhu/gr/orders/'+order.id+'?source=account');assert.equal(detail.data.order.order_ref,order.id);
  assert.equal((await call('/api/juzhu/gr/orders/'+order.id+'?source=account',actors.other)).status,404);
  assert.equal((await fetch(base+'/api/juzhu/gr/orders?user_id=commerce-account-'+actors.owner.account.id)).status,401);
  assert.equal((await call('/api/juzhu/gr/orders?user_id=commerce-account-'+actors.owner.account.id,actors.other)).status,403);
 });
 await check('After-sale request enters the existing main work pool without pretending it was paid',async()=>{
  work=await service.openCase(actors.owner,{coupon_id:coupon.id,kind:'help',reason:'请协助确认演示服务范围'},'main-case-create');
  const [rows]=await db.execute('SELECT * FROM jz_orders WHERE id=?',[work.id]);assert.equal(rows.length,1);assert.equal(rows[0].pay_status,'not_required');assert.equal(rows[0].fee,0);
  const list=await call('/api/juzhu/jiazheng/orders?pay_status=paid,not_required&status=pending',actors.operator);assert.equal(list.status,200);assert(list.data.items.some(o=>o.id===work.id));
  assert.equal((await call('/api/juzhu/jiazheng/orders/'+work.id)).status,200);assert.equal((await call('/api/juzhu/jiazheng/orders/'+work.id+'/pay',actors.operator,'POST',{})).status,409);
  assert.equal((await call('/api/juzhu/jiazheng/orders/'+work.id,actors.other)).status,403);
 });
 await check('Main dispatch and processing close the same after-sale case and update the customer progress',async()=>{
  const dispatched=await call('/api/juzhu/jiazheng/orders/'+work.id+'/dispatch',actors.operator,'POST',{worker:{id:1,name:'隔离验收客服',level:'L1'}});assert.equal(dispatched.status,200);
  for(const status of ['accepted','serving','done']){const r=await call('/api/juzhu/jiazheng/orders/'+work.id+'/advance',actors.operator,'POST',{});assert.equal(r.status,200);assert.equal(r.data.order.status,status);}
  const mine=await service.my(actors.owner);const entry=mine.cases.find(c=>c.id===work.id);assert.equal(entry.status,'closed');assert(entry.resolution.includes('主站'));assert.equal(entry.work_order_id,work.id);
 });
 const {chromium}=require('/tmp/e2e/node_modules/playwright-core');const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
 const output=path.resolve(__dirname,'../../docs/verification/guiyang-life-demo');fs.mkdirSync(output,{recursive:true});
 try{await check('Existing main order list/detail and work progress render the linked customer records',async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});await context.addInitScript(token=>localStorage.setItem('BZF_SESSION_TOKEN',token),actors.owner.token);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{await page.goto(base+'/juzhu-jiazheng-orders.html');await page.waitForSelector('.ordcard');assert((await page.locator('#list').innerText()).includes(sku.name));await page.screenshot({path:path.join(output,'main-order-list-390.png')});await page.getByRole('link',{name:'查看详情'}).first().click();await page.waitForSelector('#body .info');assert((await page.locator('#body').innerText()).includes('演示权益已发放'));await page.screenshot({path:path.join(output,'main-order-detail-390.png')});await page.goto(base+'/juzhu-order-progress.html?order='+work.id);await page.waitForFunction(()=>document.body.innerText.includes('主站工单池'));assert(!(await page.locator('body').innerText()).includes('API 加载失败'));assert.equal(await page.locator('#ctaBtn').textContent(),'返回售后');assert(!(await page.locator('body').innerText()).includes('去支付'));await page.screenshot({path:path.join(output,'main-case-progress-390.png')});assert.deepEqual(errors,[]);}finally{await context.close();}
 });}finally{await browser.close();}
 fs.writeFileSync(path.join(output,'main-reuse-results.json'),JSON.stringify({at:new Date().toISOString(),database:'isolated database, removed after verification',checks:results},null,2));
}
module.exports={run};
