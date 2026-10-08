'use strict';

// Test-site-only walkthrough. Display values never enter jz_orders, payment, or settlement.
const crypto=require('node:crypto');
const {assert}=require('./configuration.cjs');
const SEED='coupon-offset-demo-20261008';
const PRODUCT_MARKER='guiyang-life-demo-v1:'+SEED;
const DDL=`CREATE TABLE IF NOT EXISTS commerce_demo_life_orders (
 id VARCHAR(36) PRIMARY KEY, account_id BIGINT NOT NULL, request_key VARCHAR(100) NOT NULL,
 product_id BIGINT NOT NULL, coupon_id VARCHAR(40) NOT NULL,
 listed_minor BIGINT NOT NULL, coupon_minor BIGINT NOT NULL, simulated_cash_minor BIGINT NOT NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'simulated', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uk_demo_request(account_id,request_key), UNIQUE KEY uk_demo_coupon(coupon_id),
 KEY account_created(account_id,created_at)
) ENGINE=InnoDB`;
const parse=v=>typeof v==='string'?JSON.parse(v):v||{};
const minor=v=>{const m=/^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(String(v));assert(m,'演示商品价格无效',409);return Number(m[1])*100+Number((m[2]||'').padEnd(2,'0'));};

async function ensure(pool){await pool.query(DDL);}
async function assertAdmin(conn,principal){
 const [rows]=await conn.execute('SELECT login_name FROM accounts WHERE id=? AND status=\'active\'',[principal.account.id]);
 assert(rows[0]?.login_name==='admin','仅 admin 演示账号可访问此测试流程',403);
}
async function fixture(conn){
 const [products]=await conn.execute(`SELECT p.id,p.title,p.price,p.city_id,p.vendor_id,p.category,p.query,v.payment_mode,v.status AS vendor_status
  FROM jz_products p JOIN jz_vendors v ON v.id=p.vendor_id WHERE p.query=? AND p.status='on' LIMIT 1`,[PRODUCT_MARKER]);
 const product=products[0];assert(product&&product.vendor_status==='active'&&!product.payment_mode,'演示商品尚未就绪',409);
 const [skus]=await conn.execute("SELECT id,name,published_version,payload FROM commerce_skus WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.initialization.seed_key'))=? AND status='published' LIMIT 1",[SEED]);
 const sku=skus[0];assert(sku&&sku.published_version,'演示券尚未就绪',409);
 return {product,sku};
}
async function config(pool,principal){
 await ensure(pool);
 const c=await pool.getConnection();try{
  await assertAdmin(c,principal);const {product,sku}=await fixture(c);
  const [coupons]=await c.execute(`SELECT id,status,expires_at FROM commerce_coupons
   WHERE account_id=? AND status='available' AND expires_at>UTC_TIMESTAMP()
    AND JSON_UNQUOTE(JSON_EXTRACT(snapshot,'$.sku.initialization.seed_key'))=? ORDER BY expires_at,id LIMIT 30`,[principal.account.id,SEED]);
  const [orders]=await c.execute('SELECT id,product_id,coupon_id,listed_minor,coupon_minor,simulated_cash_minor,status,created_at FROM commerce_demo_life_orders WHERE account_id=? ORDER BY created_at DESC LIMIT 20',[principal.account.id]);
  const payload=parse(sku.payload);
  return {product:{id:product.id,title:product.title,category:product.category,price_minor:minor(product.price)},voucher:{id:sku.id,name:sku.name,version:sku.published_version,face_minor:Number(payload.demo_face_minor)},coupons,orders,demo:true};
 }finally{c.release();}
}
async function quoteOn(conn,principal,couponId,lock=false){
 assert(/^[0-9a-f-]{36}$/i.test(String(couponId||'')),'券编号无效',400);
 const {product}=await fixture(conn);
 const [rows]=await conn.execute(`SELECT *,expires_at>UTC_TIMESTAMP() AS still_valid FROM commerce_coupons WHERE id=?${lock?' FOR UPDATE':''}`,[couponId]);
 const coupon=rows[0];assert(coupon&&String(coupon.account_id)===String(principal.account.id),'券不存在或不属于当前账号',404);
 assert(coupon.status==='available'&&Number(coupon.still_valid)===1,'券已使用或过期',409);
 const snapshot=parse(coupon.snapshot),sku=snapshot.sku||{};
 assert(snapshot.is_demo===true&&sku.initialization?.seed_key===SEED&&sku.initialization?.mode==='demo','此券不属于本演示流程',409);
 assert(sku.use_mode==='amount_offset'&&sku.use_domains?.includes('jiazheng')
  &&sku.use_vendor_ids?.map(Number).includes(Number(product.vendor_id))
  &&sku.life_product_ids?.map(Number).includes(Number(product.id))
  &&Number(coupon.city_id)===Number(product.city_id),'券不适用于该服务',409);
 const listed=minor(product.price),face=Number(sku.demo_face_minor);
 assert(Number.isSafeInteger(face)&&face>0&&face<=listed,'演示抵用金额无效',409);
 return {product_id:product.id,product_name:product.title,coupon_id:coupon.id,coupon_name:sku.name,
  listed_minor:listed,coupon_minor:face,simulated_cash_minor:listed-face,demo:true,
  notice:'无资金演示：差额仅展示，不会扣款、预约真实服务或记入结算。'};
}
async function quote(pool,principal,couponId){await ensure(pool);const c=await pool.getConnection();try{await assertAdmin(c,principal);return await quoteOn(c,principal,couponId);}finally{c.release();}}
async function order(pool,principal,input,key){
 assert(input.demo_ack===true,'请确认这是无资金演示',422);
 assert(/^[A-Za-z0-9_.:-]{8,100}$/.test(String(key||'')),'请提供有效的幂等请求键',400);
 await ensure(pool);const c=await pool.getConnection();try{
  await c.beginTransaction();await assertAdmin(c,principal);
  const [old]=await c.execute('SELECT * FROM commerce_demo_life_orders WHERE account_id=? AND request_key=? FOR UPDATE',[principal.account.id,key]);
  if(old.length){assert(old[0].coupon_id===input.coupon_id,'同一请求键不能更换卡券',409);await c.commit();return {...old[0],demo:true,reused:true};}
  const q=await quoteOn(c,principal,input.coupon_id,true);const id=crypto.randomUUID();
  await c.execute(`INSERT INTO commerce_demo_life_orders
   (id,account_id,request_key,product_id,coupon_id,listed_minor,coupon_minor,simulated_cash_minor)
   VALUES(?,?,?,?,?,?,?,?)`,[id,principal.account.id,key,q.product_id,q.coupon_id,q.listed_minor,q.coupon_minor,q.simulated_cash_minor]);
  const [updated]=await c.execute("UPDATE commerce_coupons SET status='redeemed' WHERE id=? AND status='available'",[q.coupon_id]);
  assert(updated.affectedRows===1,'券已被使用',409);
  await c.execute('INSERT INTO commerce_audit(actor_id,city_id,merchant_id,action,resource,detail) VALUES(?,?,?,?,?,?)',
   [principal.account.id,null,null,'demo.life.offset',id,JSON.stringify({product_id:q.product_id,coupon_id:q.coupon_id,listed_minor:q.listed_minor,coupon_minor:q.coupon_minor,simulated_cash_minor:q.simulated_cash_minor,financial_posting:false})]);
  await c.commit();return {id,account_id:principal.account.id,...q,status:'simulated',reused:false};
 }catch(e){await c.rollback();throw e;}finally{c.release();}
}
module.exports={ensure,config,quote,order,SEED,PRODUCT_MARKER};
