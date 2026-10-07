'use strict';
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const mysql=require('mysql2/promise');
const {config}=require('../../commerce/db.cjs');
const {Service}=require('../../commerce/service.cjs');
const {createServer}=require('../../commerce/app.cjs');

const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function main(){
 const cfg=config(),name='commerce_coupon_functional_'+Date.now();
 let admin=await mysql.createConnection(cfg),testConfig=cfg,created=false;
 let pool;
 try{
  try{await admin.query('CREATE DATABASE '+mysql.escapeId(name)+' CHARACTER SET utf8mb4');}
  catch(error){if(error.code!=='ER_DBACCESS_DENIED_ERROR')throw error;await admin.end();testConfig={...cfg,user:'root',password:undefined,socketPath:'/var/lib/mysql/mysql.sock'};admin=await mysql.createConnection(testConfig);await admin.query('CREATE DATABASE '+mysql.escapeId(name)+' CHARACTER SET utf8mb4');}
  created=true;pool=mysql.createPool({...testConfig,database:name,connectionLimit:4});
  for(const table of ['cities','commerce_orders','commerce_coupons','commerce_appointments','commerce_redemptions','commerce_memberships','commerce_cases','commerce_refund_orders','commerce_compensation_cases','commerce_skus','commerce_packages','commerce_plans','commerce_versions','commerce_inventory','commerce_merchants']){
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
  await pool.execute("INSERT INTO commerce_skus(id,name,city_id,version,published_version,status,payload,created_by) VALUES(101,'景点体验券',3,1,1,'published',?,1)",[JSON.stringify(sku)]);
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
  console.log('PASS coupon pagination, ownership, membership city, booking code and package stock');
 }finally{
  if(pool)await pool.end();
  try{if(created)await admin.query('DROP DATABASE IF EXISTS '+mysql.escapeId(name));}finally{await admin.end();}
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
