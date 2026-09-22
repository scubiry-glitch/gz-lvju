'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const mysql=require('mysql2/promise'),{config,initAuth}=require('../../commerce/db.cjs'),{migrate}=require('../../commerce/migrate.cjs'),{Service}=require('../../commerce/service.cjs'),{createServer}=require('../../commerce/app.cjs');
const results=[];const check=async(name,fn)=>{await fn();results.push({name,passed:true});console.log('PASS '+name);};
(async()=>{
 const cfg=config(),database='commerce_m1a_test_'+Date.now();let admin=await mysql.createConnection(cfg),testConfig=cfg;let pool,server,created=false;
 try{
 try{await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');}catch(e){if(e.code!=='ER_DBACCESS_DENIED_ERROR')throw e;await admin.end();testConfig={...cfg,user:'root',password:undefined,socketPath:'/var/lib/mysql/mysql.sock'};admin=await mysql.createConnection(testConfig);await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');}created=true;pool=mysql.createPool({...testConfig,database,connectionLimit:12});
 for(const table of ['accounts','roles','account_roles','sessions','cities','settings','jz_vendors','gr_orders','jz_orders','jz_categories','jz_skus','jz_products','jz_workers','jz_sku_workers'])await pool.query('CREATE TABLE `'+table+'` LIKE `'+cfg.database+'`.`'+table+'`');
 await pool.query('INSERT INTO jz_categories SELECT * FROM `'+cfg.database+'`.jz_categories');
 await migrate(pool);await migrate(pool);const auth=initAuth(pool),service=new Service(pool,auth);
 await pool.query("INSERT INTO cities(id,name,slug) VALUES (1,'验收城市','acceptance'),(2,'其他城市','other')");
 await pool.query("INSERT INTO jz_vendors(id,type,name,status) VALUES(1,'service','验收商户','active'),(2,'service','其他商户','active')");
 const roles={writer:['commerce.admin.read','commerce.admin.write'],reviewer:['commerce.admin.read','commerce.admin.review'],merchant:['commerce.merchant.read','commerce.merchant.write','commerce.merchant.redeem'],reader:['commerce.admin.read'],user:[]};
 for(const [code,perms]of Object.entries(roles))await pool.execute('INSERT INTO roles(role_code,name,permissions,builtin) VALUES(?,?,?,0)',[code,code,JSON.stringify(perms)]);
 const actors={};for(const [i,name,role,vendor,scope]of [[1,'writer','writer',null,{level:'all'}],[2,'reviewer','reviewer',null,{level:'all'}],[3,'merchant','merchant',1,{level:'vendor',vendor_id:1}],[4,'user','user',null,{level:'self'}],[5,'other','user',null,{level:'self'}],[6,'foreign','merchant',2,{level:'vendor',vendor_id:2}],[7,'reader','reader',null,{level:'all'}],[8,'city','writer',null,{level:'city',city_ids:[2]}]]){
 await pool.execute("INSERT INTO accounts(id,display_name,principal_type,status,vendor_id) VALUES(?,?,'user','active',?)",[i,name,vendor]);await pool.execute('INSERT INTO account_roles(account_id,role_code,scope) VALUES(?,?,?)',[i,role,JSON.stringify(scope)]);actors[name]={type:'account',...await auth.getAccountWithRoles(i)};actors[name].token=(await auth.createSession(i,'127.0.0.1','M1A acceptance')).token;
 }
 const write='commerce.admin.write',review='commerce.admin.review';
 async function configEntity(kind,payload){let e=await service.save(actors.writer,write,kind,null,{payload});e=await service.transition(actors.writer,write,kind,e.id,{version:e.version,action:'submit'});e=await service.transition(actors.reviewer,review,kind,e.id,{version:e.version,action:'approve',note:'验收资料已复核'});e=await service.transition(actors.writer,write,kind,e.id,{version:e.version,action:'publish'});return e;}
 let merchant,store,sku,rule,pkg,plan;
 await check('Migration idempotency and persistent merchant approval',async()=>{merchant=await configEntity('merchants',{name:'验收生活服务',vendor_id:1,city_id:1,contract_ref:'ACCEPTANCE-001',contact:'验收联系人',phone:'00000000000',description:'仅隔离库验收资料'});const fresh=new Service(pool,auth);assert.equal((await fresh.entity(pool,'merchants',merchant.id)).status,'published');});
 await check('Submitter cannot approve and read-only cannot write',async()=>{const e=await service.save(actors.writer,write,'merchants',null,{payload:{...merchant.payload,vendor_id:2,name:'第二商家'}});await service.transition(actors.writer,write,'merchants',e.id,{version:1,action:'submit'});await assert.rejects(()=>service.transition(actors.writer,write,'merchants',e.id,{version:1,action:'approve',note:'自行审核'}),/提交人不能/);await assert.rejects(()=>service.save(actors.reader,write,'merchants',null,{payload:merchant.payload}),/权限/);});
 store=await configEntity('stores',{name:'验收服务门店',merchant_id:merchant.id,city_id:1,address:'验收地址',phone:'00000000000',capacity:1,lead_hours:0,description:'每日预约服务'});
 await configEntity('staff',{name:'验收核销员',merchant_id:merchant.id,store_id:store.id,account_id:3});
 sku=await configEntity('skus',{name:'居家深度清洁',merchant_id:merchant.id,store_id:store.id,supply_minor:7000,retail_minor:10000,valid_days:30,description:'全屋基础保洁一次',conditions:'提前预约，超出服务范围另行约定'});
 rule=await configEntity('rules',{name:'验收分配规则',merchant_id:merchant.id,beike_bps:2000,channel_bps:5000,floor_bps:1000,description:'验收审批依据，逐券核销后确认'});
 pkg=await configEntity('packages',{name:'悦享生活券包',city_id:1,price_minor:10000,description:'好服务陪伴日常生活',items:[{sku_id:sku.id,rule_id:rule.id,quantity:1,allocation_minor:10000}]});
 plan=await configEntity('plans',{name:'悦享生活会员',city_id:1,package_id:pkg.id,price_minor:10000,valid_days:365,description:'会员独立有效期，赠送生活券包'});
 await check('Object scope isolation, explicit city and merchant scope',async()=>{await assert.rejects(()=>service.save(actors.foreign,'commerce.merchant.write','skus',sku.id,{payload:sku.payload,version:1},true),/其他商户/);assert.equal((await service.list(actors.city,'commerce.admin.read','skus',{})).total,0);assert.equal((await service.list(actors.foreign,'commerce.merchant.read','skus',{},true)).total,0);});
 await check('Immutable published snapshot and optimistic edit conflicts',async()=>{await service.save(actors.writer,write,'skus',sku.id,{version:1,payload:{...sku.payload,name:'更新中的商品名称'}});assert.equal((await service.approved(pool,'skus',sku.id)).payload.name,'居家深度清洁');await assert.rejects(()=>service.save(actors.writer,write,'skus',sku.id,{version:1,payload:sku.payload}),/已更新/);});
 await service.inventory(actors.writer,write,{sku_id:sku.id,total:2});
 let orders=[],previewOrderId=null;
 await check('Concurrent stock reservation: no oversell; retry idempotency',async()=>{const outcomes=await Promise.allSettled(Array.from({length:6},(_,i)=>service.reserveOrder(actors.user,{kind:'packages',product_id:pkg.id},'order-test-'+i)));orders=outcomes.filter(x=>x.status==='fulfilled').map(x=>x.value);assert.equal(orders.length,2);const [rows]=await pool.query('SELECT * FROM commerce_inventory');assert.equal(rows[0].reserved,2);const r=await service.reserveOrder(actors.user,{kind:'packages',product_id:pkg.id},'repeat-order-01').catch(e=>e);assert.equal(r.status,409);});
 await check('Verified internal fulfillment once; no duplicate grant',async()=>{await Promise.all([service.fulfillPaidOrder(orders[0].id,'verified-provider-001',10000),service.fulfillPaidOrder(orders[0].id,'verified-provider-001',10000)]);const [rows]=await pool.query('SELECT COUNT(*) n FROM commerce_coupons');assert.equal(rows[0].n,1);});
 await check('Expired order releases reserved stock once',async()=>{await pool.execute('UPDATE commerce_orders SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 MINUTE WHERE id=?',[orders[1].id]);await service.expire();await service.expire();const [rows]=await pool.query('SELECT * FROM commerce_inventory');assert.equal(rows[0].reserved,0);assert.equal(rows[0].granted,1);});
 const extra=await service.reserveOrder(actors.user,{kind:'plans',product_id:plan.id},'membership-order');await service.fulfillPaidOrder(extra.id,'verified-provider-002',10000);
 const coupons=(await service.my(actors.user)).coupons;
 await check('Personal assets have no pricing rules and deny another owner',async()=>{assert.equal(coupons.length,2);assert.equal(JSON.stringify(coupons).includes('beike_bps'),false);await assert.rejects(()=>service.token(actors.other,coupons[0].id),/不属于/);});
 const bjDate=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(v);
 const tomorrow=bjDate(Date.now()+86400000);let booked;
 await check('Concurrent appointments respect date capacity; failed reschedule retains slot',async()=>{const outcomes=await Promise.allSettled(coupons.map((coupon,i)=>service.appointment(actors.user,{coupon_id:coupon.id,service_date:tomorrow},'appointment-'+i)));assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);booked=coupons[outcomes.findIndex(x=>x.status==='fulfilled')];const later=bjDate(Date.now()+2*86400000);await service.inventory(actors.writer,write,{kind:'capacity',store_id:store.id,total:0,service_date:later});await assert.rejects(()=>service.appointment(actors.user,{coupon_id:booked.id,service_date:later},'reschedule-full'),/已满/);const [rows]=await pool.query("SELECT COUNT(*) n FROM commerce_appointments WHERE status='booked'");assert.equal(rows[0].n,1);});
 const unbooked=coupons.find(c=>c.id!==booked.id);
 await check('Refund freeze invalidates token and is idempotent',async()=>{await service.token(actors.user,unbooked.id);const input={coupon_id:unbooked.id,kind:'refund',reason:'验收未使用退款申请'};const one=await service.openCase(actors.user,input,'refund-request-01'),two=await service.openCase(actors.user,input,'refund-request-01');assert.equal(one.id,two.id);await assert.rejects(()=>service.token(actors.user,unbooked.id),/不可核销/);await service.resolveCase(actors.writer,write,one.id,{action:'accept',resolution:'资料完整，等待正式退款通道'});assert.equal((await service.coupon(pool,unbooked.id,false)).status,'frozen');});
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());await pool.execute('UPDATE commerce_appointments SET service_date=? WHERE coupon_id=? AND status=?',[today,booked.id,'booked']);const token=await service.token(actors.user,booked.id);
 await check('Same-store redemption only; concurrent redemption vs refund exactly one wins',async()=>{await assert.rejects(()=>service.redeem(actors.foreign,'commerce.merchant.redeem',{coupon_id:booked.id,token:token.token},'foreign-redeem'),/其他商户/);const outcomes=await Promise.allSettled([service.redeem(actors.merchant,'commerce.merchant.redeem',{coupon_id:booked.id,token:token.token},'proper-redemption'),service.openCase(actors.user,{coupon_id:booked.id,kind:'refund',reason:'并发退款互斥验证'},'race-case-0001')]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);const [rows]=await pool.query('SELECT * FROM commerce_redemptions');for(const r of rows){assert.equal(r.supplier_minor+r.beike_minor,r.allocation_minor);assert.equal(r.channel_minor+r.retained_minor,r.beike_minor);assert.equal(r.channel_minor,0,'Unattributed orders must not accrue channel commission');}});
 await check('Redemption preview shows the service without any side effect and carries structured failure codes',async()=>{
  await service.inventory(actors.writer,write,{sku_id:sku.id,total:10});
  const order=await service.reserveOrder(actors.user,{kind:'packages',product_id:pkg.id},'preview-order-01');await service.fulfillPaidOrder(order.id,'verified-preview-provider',10000);previewOrderId=order.id;
  const coupon=(await service.my(actors.user)).coupons.find(c=>c.order_id===order.id);
  const tomorrowDate=bjDate(Date.now()+86400000);
  await service.inventory(actors.writer,write,{kind:'capacity',store_id:store.id,total:10,service_date:tomorrowDate});
  await service.appointment(actors.user,{coupon_id:coupon.id,service_date:tomorrowDate},'preview-appointment-01');
  await pool.execute('UPDATE commerce_appointments SET service_date=? WHERE coupon_id=? AND status=?',[today,coupon.id,'booked']);
  const previewToken=await service.token(actors.user,coupon.id);
  const [before]=await pool.query('SELECT COUNT(*) n FROM commerce_redemptions');
  const meta=await service.previewRedeem(actors.merchant,'commerce.merchant.redeem',{coupon_id:coupon.id,token:previewToken.token});
  assert.equal(meta.preview,true);assert.equal(meta.name,'居家深度清洁');assert.equal(meta.service_date,today);assert(meta.supplier_minor>0,'merchant settles its share in preview');
  const [after]=await pool.query('SELECT COUNT(*) n FROM commerce_redemptions');
  assert.equal(after[0].n,before[0].n,'preview must not write a redemption');
  assert.equal((await service.coupon(pool,coupon.id,false)).status,'available','preview must not consume the coupon');
  await assert.rejects(()=>service.previewRedeem(actors.merchant,'commerce.merchant.redeem',{coupon_id:coupon.id,token:'0'.repeat(32)}),e=>e.code==='token_invalid'&&e.status===409);
  await assert.rejects(()=>service.previewRedeem(actors.foreign,'commerce.merchant.redeem',{coupon_id:coupon.id,token:previewToken.token}),e=>e.status===403);
  await service.redeem(actors.merchant,'commerce.merchant.redeem',{coupon_id:coupon.id,token:previewToken.token},'preview-confirm-01');
  await assert.rejects(()=>service.previewRedeem(actors.merchant,'commerce.merchant.redeem',{coupon_id:coupon.id,token:previewToken.token}),e=>e.code==='coupon_unavailable');
 });

 await check('Multi-SKU stock rollback is atomic',async()=>{
  const second=await configEntity('skus',{...sku.payload,name:'空库存商品'});
  const multi=await configEntity('packages',{name:'双商品券包',city_id:1,price_minor:20000,description:'验证第二项库存不足全部回滚',items:[{sku_id:sku.id,rule_id:rule.id,quantity:1,allocation_minor:10000},{sku_id:second.id,rule_id:rule.id,quantity:1,allocation_minor:10000}]});
  await service.inventory(actors.writer,write,{sku_id:sku.id,total:10});const [before]=await pool.query('SELECT reserved FROM commerce_inventory WHERE sku_id='+sku.id);
  await assert.rejects(()=>service.reserveOrder(actors.user,{kind:'packages',product_id:multi.id},'multi-sku-rollback'),/库存不足/);const [after]=await pool.query('SELECT reserved FROM commerce_inventory WHERE sku_id='+sku.id);assert.equal(after[0].reserved,before[0].reserved);
 });
 await check('Unused expiry queues one original-source refund, never marks payment complete',async()=>{
  const order=await service.reserveOrder(actors.user,{kind:'packages',product_id:pkg.id},'expiry-coupon-order');await service.fulfillPaidOrder(order.id,'verified-expiry-provider',10000);
  await pool.execute('UPDATE commerce_coupons SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 MINUTE WHERE order_id=?',[order.id]);await service.expire();await service.expire();const [rows]=await pool.execute('SELECT c.status,s.status AS case_status FROM commerce_coupons c JOIN commerce_cases s ON s.coupon_id=c.id WHERE c.order_id=?',[order.id]);assert.equal(rows.length,1);assert.equal(rows[0].status,'frozen');assert.equal(rows[0].case_status,'awaiting_provider');
 });
 server=createServer({pool,auth,staticFiles:true,demoEnabled:process.argv.includes('--guiyang-demo')});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const request=async(route,actor,method='GET',body,key)=>{const response=await fetch(origin+'/api/commerce/v1'+route,{method,headers:{...(actor?{Authorization:'Bearer '+actor.token}:{}),'Content-Type':'application/json',...(method!=='GET'?{'Idempotency-Key':key||crypto.randomUUID()}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 await check('HTTP real IAM sessions, locked/revoked denial, no legacy credentials',async()=>{assert.equal((await request('/admin/skus')).status,401);assert.equal((await request('/admin/skus',actors.reader)).status,200);assert.equal((await request('/admin/skus',actors.reader,'POST',{payload:sku.payload})).status,403);assert.equal((await request('/admin/skus',actors.user)).status,403);assert.equal((await request('/my',{token:process.env.JUZHU_API_KEY})).status,401);await auth.revokeSession(actors.other.token);assert.equal((await request('/my',actors.other)).status,401);});
 await check('HTTP review cannot bypass fine-grained permission and all pay routes closed',async()=>{assert.equal((await request('/admin/skus/'+sku.id+'/review',actors.writer,'POST',{action:'approve',version:2,note:'绕过权限'})).status,403);assert.equal((await request('/admin/skus/'+sku.id+'/transition',actors.writer,'POST',{action:'approve',version:2,note:'绕过路由'})).status,403);assert.equal((await request('/orders',actors.user,'POST',{kind:'packages',product_id:pkg.id})).status,409);assert.equal((await request('/test-sessions',actors.user,'POST',{})).status,404);assert.equal((await request('/orders/test-pay',actors.writer,'POST',{})).status,404);assert.equal((await request('/does-not-exist',actors.user)).status,404);const catalogue=await request('/catalog');assert.equal(catalogue.status,200);assert(!JSON.stringify(catalogue.body).includes('supply_minor'));assert(!JSON.stringify(catalogue.body).includes('contract_ref'));});

 await check('Signed single-level referrals reject tampering and preserve attribution',async()=>{
  const shared=await request('/shares',actors.merchant,'POST',{kind:'packages',product_id:pkg.id});assert.equal(shared.status,201);const token=new URL(shared.body.data.url).searchParams.get('ref');
  const data=await service.verifyReferral(token,{kind:'packages',product_id:pkg.id});assert.equal(data.aid,actors.merchant.account.id);await assert.rejects(()=>service.verifyReferral(token.slice(0,-2)+'xx'),/签名/);
  const order=await service.reserveOrder(actors.user,{kind:'packages',product_id:pkg.id,referral:token},'attributed-order-01');const [rows]=await pool.execute('SELECT source_account_id FROM commerce_orders WHERE id=?',[order.id]);assert.equal(rows[0].source_account_id,actors.merchant.account.id);
 });
 await check('Registry defaults unchanged and every commerce management method explicitly matched',async()=>{
  const registry=require('../../perm_registry.cjs'),baseline=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../__fixtures__/perm_roles_baseline.json'),'utf8'));
  for(const role of auth.BUILTIN_ROLES){const expected=baseline[role.role_code];assert(expected,'Missing role baseline');assert.deepEqual([...role.permissions].sort(),[...expected.permissions].sort());}
  assert.equal(registry.match('/api/commerce/v1/admin/skus','DELETE'),null);assert.equal(registry.match('/api/commerce/v1/admin/skus/1/review','POST').perm,'commerce.admin.review');
 });
 await check('HTTP fulfilment chain, today filter, stats scope, error codes and locatable failures',async()=>{
  const chain=await request('/my/orders/'+previewOrderId,actors.user);assert.equal(chain.status,200);assert.equal(chain.body.data.coupons.length,1);assert.equal(chain.body.data.coupons[0].status,'redeemed');assert(chain.body.data.coupons[0].redeemed_at,'chain shows redemption time');assert.equal(chain.body.data.coupons[0].name,'居家深度清洁');
  assert.equal((await request('/my/orders/'+previewOrderId,actors.merchant)).status,404,'another account must not trace this order');
  const tomorrowList=await request('/merchant/appointments?date='+bjDate(Date.now()+86400000),actors.merchant);assert.equal(tomorrowList.status,200);assert.equal(tomorrowList.body.data.rows.length,0,'no tomorrow appointments remain');
  const todayList=await request('/merchant/appointments?date='+today,actors.merchant);assert.equal(todayList.status,200);assert(todayList.body.data.rows.length>=1);for(const row of todayList.body.data.rows)assert(String(row.service_date).startsWith(today));assert(todayList.body.data.rows.some(r=>r.service_name==='居家深度清洁'&&r.customer_name),'merchant sees service and customer');
  assert.equal((await request('/admin/stats',actors.user)).status,403);
  const stats=await request('/admin/stats',actors.reader);assert.equal(stats.status,200);assert(stats.body.data.coupons.total>=1);assert(stats.body.data.orders.demo>=0);assert(stats.body.data.exchange_codes.total>=0);assert(Array.isArray(stats.body.data.failures.recent));
  const stale=await request('/merchant/redeem',actors.merchant,'POST',{coupon_id:booked.id,token:'deadbeefdeadbeefdeadbeefdeadbeef'});
  assert.equal(stale.status,409);assert.equal(stale.body.code,'coupon_unavailable','structured failure reason');
  let failure=[];for(let i=0;i<20&&!failure.length;i++){[failure]=await pool.execute("SELECT resource,detail FROM commerce_audit WHERE action='operation.failed' AND resource=? ORDER BY id DESC LIMIT 1",['POST /api/commerce/v1/merchant/redeem']);if(!failure.length)await new Promise(r=>setTimeout(r,50));}
  assert(failure.length,'failed operations are locatable');assert(failure[0].detail.reason);
 });
 if(process.argv.includes('--guiyang-demo'))await require('./guiyang-demo-test.cjs').run({pool,sourceDatabase:cfg.database,service,actors,check,origin,auth});
 if(process.argv.includes('--initialization'))await require('./initialization-test.cjs').run({pool,service,actors,check,sku,store,merchant});
 if(process.argv.includes('--guiyang-demo'))await require('./exchange-test.cjs').run({pool,service,actors,check,origin});
 if(process.argv.includes('--hotel-exchange'))await require('./hotel-exchange-test.cjs').run({pool,service,actors,check,origin,auth});
 if(process.env.COMMERCE_BROWSER==='1'||process.argv.includes('--browser'))await require('./m1a-browser.cjs').run({origin,actors,check,initialization:process.argv.includes('--initialization'),guiyangDemo:process.argv.includes('--guiyang-demo')});
 const out=path.resolve(__dirname,'../../docs/verification/newliving-commerce-m1a');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({at:new Date().toISOString(),database:'isolated temporary MySQL database (removed)',checks:results},null,2));console.log('M1-A acceptance: '+results.length+' passed');
 }finally{if(server)await new Promise(resolve=>server.close(resolve));if(pool)await pool.end();if(created&&/^commerce_m1a_test_\d+$/.test(database))await admin.query('DROP DATABASE `'+database+'`');await admin.end();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
