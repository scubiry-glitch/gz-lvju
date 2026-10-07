'use strict';
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const mysql=require('mysql2/promise');
const {config}=require('../../commerce/db.cjs');
const {Service}=require('../../commerce/service.cjs');
const {createServer}=require('../../commerce/app.cjs');
const {validate}=require('../../commerce/configuration.cjs');
const grOrders=require('../../gr_orders.cjs');

const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function main(){
 const cfg=config(),name='commerce_coupon_functional_'+Date.now();
 let admin=await mysql.createConnection(cfg),testConfig=cfg,created=false;
 let pool;
 try{
  try{await admin.query('CREATE DATABASE '+mysql.escapeId(name)+' CHARACTER SET utf8mb4');}
  catch(error){if(error.code!=='ER_DBACCESS_DENIED_ERROR')throw error;await admin.end();testConfig={...cfg,user:'root',password:undefined,socketPath:'/var/lib/mysql/mysql.sock'};admin=await mysql.createConnection(testConfig);await admin.query('CREATE DATABASE '+mysql.escapeId(name)+' CHARACTER SET utf8mb4');}
  created=true;pool=mysql.createPool({...testConfig,database:name,connectionLimit:4});
  for(const table of ['cities','spots','gr_orders','jz_products','jz_skus','jz_orders','commerce_orders','commerce_coupons','commerce_appointments','commerce_redemptions','commerce_memberships','commerce_cases','commerce_refund_orders','commerce_compensation_cases','commerce_skus','commerce_packages','commerce_plans','commerce_stores','commerce_versions','commerce_inventory','commerce_capacity','commerce_merchants']){
   await pool.query('CREATE TABLE '+mysql.escapeId(table)+' LIKE '+mysql.escapeId(cfg.database)+'.'+mysql.escapeId(table));
  }
  await pool.execute("INSERT INTO cities(id,name,slug) VALUES(3,'贵阳','guiyang')");
  const order=randomUUID(),actor={account:{id:101}},other={account:{id:102}};
  await pool.execute("INSERT INTO commerce_orders(id,account_id,city_id,product_kind,product_id,product_version,amount_minor,status,expires_at,snapshot) VALUES(?,101,3,'packages',201,1,0,'fulfilled','2099-01-01','{}')",[order]);
  const sku={name:'景点体验券',description:'演示商品',conditions:'预约后使用',valid_days:30,store_id:1,redeem_channel:'offline',is_demo:true};
  const snapshot=JSON.stringify({sku,is_demo:true});
  const ids=[];
  for(let unit=1;unit<=101;unit++){
   const id=randomUUID();ids.push(id);
   await pool.execute("INSERT INTO commerce_coupons(id,order_id,item_id,unit_no,account_id,merchant_id,store_id,city_id,status,expires_at,allocation_minor,snapshot) VALUES(?,?,1,?,101,1,1,3,?,'2099-01-01',0,?)",[id,order,unit,unit===101?'refunded':'available',snapshot]);
  }
  const service=new Service(pool,{});
  const storePayload={name:'演示门店',capacity:2,lead_hours:0,service_channel:'store'};
  await pool.execute("INSERT INTO commerce_stores(id,name,city_id,version,published_version,status,payload,created_by) VALUES(1,'演示门店',3,1,1,'published',?,1)",[JSON.stringify(storePayload)]);
  await pool.execute("INSERT INTO commerce_versions(kind,entity_id,version,snapshot,reviewed_by) VALUES('stores',1,1,?,1)",[JSON.stringify(storePayload)]);
  const plusDays=n=>new Date(Date.parse(today()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  await pool.execute('INSERT INTO commerce_capacity(store_id,service_date,total,reserved) VALUES(1,?,1,1)',[plusDays(2)]);
  const availability=await service.couponAvailability(actor,ids[0],{from:today(),days:4});
  assert.equal(availability.dates.find(r=>r.date===plusDays(2)).reason,'full');
  assert.equal(availability.dates.find(r=>r.date===plusDays(3)).remaining,2);
  await assert.rejects(()=>service.couponAvailability(other,ids[0]),/不属于当前账号/);
  for(let n=0;n<101;n++)await pool.execute("INSERT INTO commerce_appointments(id,coupon_id,account_id,merchant_id,store_id,city_id,service_date,status) VALUES(?,?,101,1,1,3,'2099-01-01','cancelled')",[randomUUID(),ids[0]]);
  const appointmentPage=await service.myAssets(actor,'appointments',{page:4,size:30});
  assert.equal(appointmentPage.total,101);assert.equal(appointmentPage.rows.length,11);assert.equal(appointmentPage.has_more,false);
  assert.equal((await service.myAssets(other,'appointments')).total,0);
  for(let n=0;n<101;n++)await pool.execute("INSERT INTO commerce_cases(id,coupon_id,account_id,merchant_id,store_id,city_id,kind,reason,status) VALUES(?,?,101,1,1,3,'help','分页验收','closed')",[randomUUID(),ids[0]]);
  assert.equal((await service.myAssets(actor,'cases',{page:4,size:30})).rows.length,11);
  await pool.execute("INSERT INTO commerce_refund_orders(refund_no,case_id,coupon_id,order_id,account_id,merchant_id,city_id,amount_minor,request_no,created_by,status) VALUES('refund-1',?,?,?,?,1,3,100,'request-1',101,'paid')",[randomUUID(),ids[0],order,101]);
  await pool.execute("INSERT INTO commerce_compensation_cases(compensation_no,case_id,coupon_id,order_id,account_id,merchant_id,city_id,amount_minor,reason,requested_by,status) VALUES('compensation-1',?,?,?,?,1,3,50,'履约失败',101,'paid')",[randomUUID(),ids[0],order,101]);
  const afterSales=[...(await service.myAfterSales(actor,{page:1,size:100})).rows,...(await service.myAfterSales(actor,{page:2,size:100})).rows];
  assert.equal(afterSales.length,103);
  assert.equal(afterSales.find(r=>r.entry_type==='refund').display_status,'已退款');
  assert.equal(afterSales.find(r=>r.entry_type==='compensation').display_status,'已先行赔付');
  assert.equal((await service.myAfterSales(other)).total,0);
  const first=await service.myCoupons(actor,{size:30,status:'available',page:1});
  const last=await service.myCoupons(actor,{size:30,status:'available',page:4});
  assert.equal(first.rows.length,30);assert.equal(last.rows.length,10);
  assert.equal(first.counts.available,100);assert.equal(first.counts.refunded,1);
  assert.equal(first.has_more,true);assert.equal(last.has_more,false);
  assert.equal((await service.myCoupon(actor,ids[100])).coupon.id,ids[100]);
  await assert.rejects(()=>service.myCoupon(other,ids[100]),/无权查看/);
  const auth={bearerToken:req=>(req.headers.authorization||'').replace(/^Bearer /,''),verifySessionToken:async token=>token==='owner'?{account:{id:101,status:'active',principal_type:'user'},roles:[]}:null};
  const server=createServer({pool,auth,paymentCore:null,paymentConfig:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const base='http://127.0.0.1:'+server.address().port+'/api/commerce/v1/my/coupons';
   const headers={Authorization:'Bearer owner'};
   const list=await fetch(base+'?status=refunded&size=10',{headers});
   assert.equal(list.status,200);assert.equal((await list.json()).data.rows[0].id,ids[100]);
   const detail=await fetch(base+'/'+ids[100],{headers});
   assert.equal(detail.status,200);assert.equal((await detail.json()).data.coupon.id,ids[100]);
   const days=await fetch(base+'/'+ids[0]+'/availability?days=4',{headers});
   assert.equal(days.status,200);assert.equal((await days.json()).data.dates.length,4);
   const paged=await fetch(base.replace('/my/coupons','/my/assets/appointments')+'?page=4&size=30',{headers});
   assert.equal(paged.status,200);assert.equal((await paged.json()).data.rows.length,11);
   const afterSalesResponse=await fetch(base.replace('/my/coupons','/my/assets/after-sales')+'?page=4&size=30',{headers});
   assert.equal(afterSalesResponse.status,200);assert.equal((await afterSalesResponse.json()).data.rows.length,13);
   assert.equal((await fetch(base+'/'+ids[100])).status,401);
  }finally{await new Promise(resolve=>server.close(resolve));}
  await assert.rejects(()=>service.token(actor,ids[0]),/请先完成预约/);
  const appointment=randomUUID();
  await pool.execute("INSERT INTO commerce_appointments(id,coupon_id,account_id,merchant_id,store_id,city_id,service_date,status) VALUES(?,?,101,1,1,3,'2099-01-01','booked')",[appointment,ids[0]]);
  await assert.rejects(()=>service.token(actor,ids[0]),/预约服务当日/);
  await pool.execute('UPDATE commerce_appointments SET service_date=? WHERE id=?',[today(),appointment]);
  assert.equal((await service.token(actor,ids[0])).expires_in,120);
  await pool.execute("INSERT INTO commerce_memberships(order_id,account_id,name,expires_at,snapshot) VALUES(?,101,'演示会员','2099-01-01',?)",[order,JSON.stringify({name:'演示会员',valid_days:365,package:{items:[]}})]);
  const member=(await service.my(actor)).memberships[0];
  assert.equal(member.city_id,3);assert.equal(member.product_id,201);assert.equal(member.city_name,'贵阳');
  assert.equal((await service.myAssets(actor,'memberships')).rows[0].city_name,'贵阳');
  for(let n=0;n<101;n++){
   const nextOrder=randomUUID();
   await pool.execute("INSERT INTO commerce_orders(id,account_id,city_id,product_kind,product_id,product_version,amount_minor,status,expires_at,snapshot) VALUES(?,101,3,'plans',201,1,0,'fulfilled','2099-01-01','{}')",[nextOrder]);
   await pool.execute("INSERT INTO commerce_memberships(order_id,account_id,name,expires_at,snapshot) VALUES(?,101,'演示会员','2099-01-01',?)",[nextOrder,JSON.stringify({name:'演示会员',valid_days:365,package:{items:[]}})]);
  }
  assert.equal((await service.myAssets(actor,'memberships',{page:4,size:30})).rows.length,12);
  assert.equal((await service.myAssets(actor,'orders',{page:4,size:30})).rows.length,12);
  await pool.execute("INSERT INTO commerce_skus(id,name,city_id,version,published_version,status,payload,created_by) VALUES(101,'景点体验券',3,1,1,'published',?,1)",[JSON.stringify(sku)]);
  const scenicSku={...sku,category_id:'scenic_ticket',spot_ids:[19]};
  await pool.execute("INSERT INTO commerce_versions(kind,entity_id,version,snapshot,reviewed_by) VALUES('skus',101,1,?,1)",[JSON.stringify(scenicSku)]);
  assert.deepEqual((await service.catalog('guiyang')).find(p=>p.kind==='skus').spot_ids,[19]);
  const form={name:'景点体验券',merchant_id:1,store_id:1,supply_minor:1,retail_minor:100,valid_days:30,description:'演示',conditions:'预约',category_id:'scenic_ticket',spot_ids:[19]};
  assert.deepEqual(validate('skus',form).spot_ids,[19]);
  assert.throws(()=>validate('skus',{...form,category_id:'dining'}),/关联景点仅适用于景点门票券/);
  await pool.execute("INSERT INTO cities(id,name,slug) VALUES(4,'其他城市','other-city')");
  await pool.execute("INSERT INTO spots(id,city_id,type,name,slug,enabled) VALUES(19,3,'scenic','本市景区','local-scenic',1),(20,4,'scenic','异地景区','foreign-scenic',1),(21,NULL,'scenic','跨市景区','province-scenic',1)");
  const merchantPayload={name:'演示商户',city_id:3,vendor_id:1};
  await pool.execute("INSERT INTO commerce_merchants(id,name,city_id,vendor_id,version,published_version,status,payload,created_by) VALUES(1,'演示商户',3,1,1,1,'published',?,1)",[JSON.stringify(merchantPayload)]);
  await pool.execute("INSERT INTO commerce_versions(kind,entity_id,version,snapshot,reviewed_by) VALUES('merchants',1,1,?,1)",[JSON.stringify(merchantPayload)]);
  await pool.execute('UPDATE commerce_stores SET merchant_id=1 WHERE id=1');
  const scopedService=new Service(pool,{scopeOf:()=>({level:'all'})});
  const adminActor={account:{id:101},roles:[{permissions:['*']}]};
  await scopedService.references(pool,'skus',validate('skus',{...form,spot_ids:[19,21]}),adminActor,'commerce.admin.write',false);
  await assert.rejects(()=>scopedService.references(pool,'skus',validate('skus',{...form,spot_ids:[20]}),adminActor,'commerce.admin.write',false),/适用景点/);
  await pool.execute("INSERT INTO commerce_packages(id,name,city_id,version,published_version,status,payload,created_by) VALUES(201,'门票券包',3,1,1,'published',?,1)",[JSON.stringify({name:'门票券包',price_minor:1000,is_demo:true,items:[{sku_id:101,sku,quantity:1,allocation_minor:1000,rule:{}}]})]);
  await pool.execute("INSERT INTO commerce_versions(kind,entity_id,version,snapshot,reviewed_by) VALUES('packages',201,1,?,1)",[JSON.stringify({name:'门票券包',price_minor:1000,is_demo:true,items:[{sku_id:101,sku,quantity:1,allocation_minor:1000,rule:{}}]})]);
  await pool.execute('INSERT INTO commerce_inventory(sku_id,total,reserved,granted) VALUES(101,0,0,0)');
  assert.equal((await service.catalog('guiyang'))[0].in_stock,false);
  await pool.execute('UPDATE commerce_inventory SET total=2 WHERE sku_id=101');
  assert.equal((await service.catalog('guiyang'))[0].in_stock,true);
  const duplicateSku={name:'门票券包',price_minor:1000,is_demo:true,items:[{sku_id:101,sku,quantity:1},{sku_id:101,sku,quantity:1}]};
  await pool.execute("UPDATE commerce_versions SET snapshot=? WHERE kind='packages' AND entity_id=201",[JSON.stringify(duplicateSku)]);
  await pool.execute('UPDATE commerce_inventory SET total=1 WHERE sku_id=101');
  assert.equal((await service.catalog('guiyang'))[0].in_stock,false);
  await pool.execute('UPDATE commerce_inventory SET total=2 WHERE sku_id=101');
  assert.equal((await service.catalog('guiyang'))[0].in_stock,true);
  for(let n=0;n<101;n++)await pool.execute("INSERT INTO gr_orders(order_ref,user_id,sku,city,status,payment_mode,created_at) VALUES(?,?,'test','贵阳',?,'pay_center',?)",['fixture-gr-'+n,'fixture-order-user',n<50?'paid':'completed','2026-10-08 12:00:00']);
  await pool.execute("INSERT INTO gr_orders(order_ref,user_id,sku,city,status,payment_mode,created_at) VALUES('fixture-hidden','fixture-order-user','test','贵阳','pending','wechat_mini','2026-10-08 12:00:00'),('fixture-other','another-order-user','test','贵阳','paid','pay_center','2026-10-08 12:00:00')");
  const ordersPage=await grOrders.listUserOrders(pool,'fixture-order-user',30,4);
  assert.equal(ordersPage.total,101);assert.equal(ordersPage.list.length,11);assert.equal(ordersPage.has_more,false);
  assert.equal(ordersPage.counts.paid,50);assert.equal(ordersPage.counts.completed,51);
  const paidPage=await grOrders.listUserOrders(pool,'fixture-order-user',30,2,'paid');
  assert.equal(paidPage.total,50);assert.equal(paidPage.list.length,20);assert.equal(paidPage.has_more,false);
  assert.equal((await grOrders.listUserOrders(pool,'another-order-user')).total,1);
  console.log('PASS coupon availability, assets, spot city validation, main order pagination and stock');
 }finally{
  if(pool)await pool.end();
  try{if(created)await admin.query('DROP DATABASE IF EXISTS '+mysql.escapeId(name));}finally{await admin.end();}
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
