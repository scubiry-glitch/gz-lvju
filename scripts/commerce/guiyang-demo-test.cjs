'use strict';
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const bjDate=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(v);
const {seed}=require('../../commerce/guiyang-demo.cjs');
const {demoOrder}=require('../../commerce/demo-order.cjs');
const {createServer}=require('../../commerce/app.cjs');
async function run({pool,sourceDatabase,service,actors,check,origin,auth}){
 for(const table of ['jz_categories','jz_skus','jz_products','jz_workers','jz_sku_workers'])await pool.query('CREATE TABLE IF NOT EXISTS `'+table+'` LIKE `'+sourceDatabase+'`.`'+table+'`');
 for(const table of ['jz_categories','jz_skus'])await pool.query('INSERT IGNORE INTO `'+table+'` SELECT * FROM `'+sourceDatabase+'`.`'+table+'`');
 await pool.query("INSERT INTO cities(id,name,slug) VALUES(3,'贵阳','guiyang')");
 let result,catalog;
 await check('Guiyang seed covers every enabled service and 12 categories without replacing existing data',async()=>{
  result=await seed(pool);const [[expected]]=await pool.query('SELECT COUNT(*) n FROM jz_skus WHERE enabled=1');
  assert.equal(result.created.filter(r=>r.kind==='channel_products').length,expected.n);
  assert.equal(result.created.filter(r=>r.kind==='channel_vendors').length,12);
  assert.equal(result.created.filter(r=>r.kind==='channel_workers').length,12);
  const [[original]]=await pool.query('SELECT name FROM jz_vendors WHERE id=1');assert.equal(original.name,'验收商户');
  catalog=await service.catalog('guiyang');assert(catalog.every(p=>p.is_demo&&p.city_id===3));assert.equal(catalog.filter(p=>p.kind==='packages').length,6);assert.equal(catalog.filter(p=>p.kind==='plans').length,1);assert(catalog.filter(p=>p.kind==='skus').length>=30);
  assert(!(await service.catalog('acceptance')).some(p=>p.city_id===3));assert.deepEqual(await service.catalog('missing-city'),[]);
  assert(!/supply_minor|beike_bps|contract_ref/.test(JSON.stringify(catalog)));
 });
 await check('Guiyang seed retries create no duplicates and preserve inventory already consumed',async()=>{
  const sku=catalog.find(p=>p.kind==='skus');await pool.execute('UPDATE commerce_inventory SET total=50 WHERE sku_id=?',[sku.id]);
  const repeat=await seed(pool);assert.equal(repeat.created.length,0);const [[stock]]=await pool.execute('SELECT total FROM commerce_inventory WHERE sku_id=?',[sku.id]);assert.equal(stock.total,50);
 });
 const single=catalog.find(p=>p.kind==='skus'),pkg=catalog.find(p=>p.kind==='packages'),plan=catalog.find(p=>p.kind==='plans');
 const input=p=>({kind:p.kind,product_id:p.id,version:p.version,demo_ack:true});
 const request=async(body,key='demo-http-order-01',actor=actors.user)=>{const r=await fetch(origin+'/api/commerce/v1/demo-orders',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+actor.token,'Idempotency-Key':key},body:JSON.stringify(body)});return {status:r.status,json:await r.json()};};
 await check('Single voucher checkout is authenticated, acknowledged, versioned and idempotent',async()=>{
  assert.equal((await fetch(origin+'/api/commerce/v1/demo-orders',{method:'POST'})).status,401);
  assert.equal((await request({...input(single),demo_ack:false})).status,422);
  assert.equal((await request({...input(single),version:999})).status,409);
  const a=await request(input(single)),b=await request(input(single));assert.equal(a.status,201);assert.equal(b.status,201);assert.equal(a.json.data.id,b.json.data.id);assert.equal(a.json.data.coupon_count,1);assert.equal(a.json.data.paid_minor,0);
  const changed=await request(input(pkg));assert.equal(changed.status,409);
  const mine=await service.my(actors.user);assert(mine.coupons.some(c=>c.order_id===a.json.data.id&&c.is_demo));assert(!(await service.my(actors.other)).orders.some(o=>o.id===a.json.data.id));
 });
 await check('Demo package and member issue correct independent coupons without payment or commissions',async()=>{
  const p=await request(input(pkg),'demo-package-0001'),m=await request(input(plan),'demo-membership-001');assert.equal(p.status,201);assert.equal(m.status,201);assert.equal(p.json.data.coupon_count,pkg.items.reduce((n,i)=>n+i.quantity,0));assert.equal(m.json.data.coupon_count,5);
  const [[order]]=await pool.execute('SELECT amount_minor,provider_ref,source_account_id FROM commerce_orders WHERE id=?',[m.json.data.id]);assert.equal(order.amount_minor,0);assert.equal(order.provider_ref,null);assert.equal(order.source_account_id,null);
  const [coupons]=await pool.execute('SELECT allocation_minor FROM commerce_coupons WHERE order_id=?',[m.json.data.id]);assert(coupons.every(c=>c.allocation_minor===0));
  const [[member]]=await pool.execute('SELECT expires_at FROM commerce_memberships WHERE order_id=?',[m.json.data.id]);assert(new Date(member.expires_at)>new Date(Date.now()+364*86400000));
  assert((await service.my(actors.user)).memberships.some(v=>v.order_id===m.json.data.id&&v.city_id===3&&v.product_id===plan.id));
  const [events]=await pool.execute('SELECT event_type FROM commerce_events WHERE aggregate_id=?',[m.json.data.id]);assert.deepEqual(events.map(e=>e.event_type),['demo.order.granted']);
 });
 await check('Demo stock concurrency cannot oversell; real products and disabled environment cannot use demo purchase',async()=>{
  await pool.execute('UPDATE commerce_inventory SET total=granted+1 WHERE sku_id=?',[single.id]);
  const outcomes=await Promise.allSettled([0,1,2].map(n=>demoOrder(service,actors.user,input(single),'demo-race-stock-'+n)));assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  const soldOut=(await fetch(origin+'/api/commerce/v1/catalog?city=guiyang').then(r=>r.json())).data.find(p=>p.kind==='skus'&&p.id===single.id);
  assert.equal(soldOut.in_stock,false);assert.equal(soldOut.demo_purchase_enabled,false);
  const real=(await service.catalog('acceptance')).find(p=>p.kind==='packages');await assert.rejects(()=>demoOrder(service,actors.user,input(real),'demo-real-denied'),/不支持演示/);
  const server=createServer({pool,auth,demoEnabled:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/commerce/v1/demo-orders',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+actors.user.token},body:JSON.stringify(input(pkg))});assert.equal(r.status,409);}finally{await new Promise(r=>server.close(r));}
  // Restore enough stock for browser acceptance.
  await pool.execute('UPDATE commerce_inventory SET total=1000 WHERE sku_id=?',[single.id]);
 });
 await check('Demo coupon appointment and refund remain a zero-funds service workflow',async()=>{
  const order=await demoOrder(service,actors.user,input(single),'demo-service-flow');const coupon=(await service.my(actors.user)).coupons.find(c=>c.order_id===order.id);
  await assert.rejects(()=>service.token(actors.user,coupon.id),/请先完成预约/);
  await service.appointment(actors.user,{coupon_id:coupon.id,service_date:bjDate(Date.now()+2*86400000)},'demo-appointment');
  await assert.rejects(()=>service.token(actors.user,coupon.id),/预约服务当日/);
  const result=await service.openCase(actors.user,{coupon_id:coupon.id,kind:'refund',reason:'演示取消未使用服务'},'demo-refund-case');
  const resolved=await service.resolveCase(actors.writer,'commerce.admin.write',result.id,{action:'accept',resolution:'演示订单取消，无实际资金退款'});assert.equal(resolved.status,'closed');
 });
 await check('Customer coupon pagination and direct detail keep ownership beyond 100 rows',async()=>{
  const [sampleRows]=await pool.execute('SELECT * FROM commerce_coupons WHERE account_id=? LIMIT 1',[actors.user.account.id]);
  const sample=sampleRows[0],ids=[];
  try{
   for(let n=1000;n<1101;n++){
    const key=randomUUID();ids.push(key);
    await pool.execute('INSERT INTO commerce_coupons(id,order_id,item_id,unit_no,account_id,merchant_id,store_id,city_id,status,expires_at,allocation_minor,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[key,sample.order_id,sample.item_id,n,sample.account_id,sample.merchant_id,sample.store_id,sample.city_id,'available',sample.expires_at,sample.allocation_minor,sample.snapshot]);
   }
   const first=await service.myCoupons(actors.user,{size:30,page:1,status:'available'});
   assert.equal(first.rows.length,30);assert.equal(first.has_more,true);assert(first.counts.available>=101);
   const fourth=await service.myCoupons(actors.user,{size:30,page:4,status:'available'});
   assert(fourth.rows.length>0);
   const detail=await service.myCoupon(actors.user,ids[100]);assert.equal(detail.coupon.id,ids[100]);
   await assert.rejects(()=>service.myCoupon(actors.other,ids[100]),/无权查看/);
   const response=await fetch(origin+'/api/commerce/v1/my/coupons/'+ids[100],{headers:{Authorization:'Bearer '+actors.user.token}});
   assert.equal(response.status,200);assert.equal((await response.json()).data.coupon.id,ids[100]);
  }finally{if(ids.length)await pool.execute('DELETE FROM commerce_coupons WHERE id IN ('+ids.map(()=>'?').join(',')+')',ids);}
 });
}
module.exports={run};
