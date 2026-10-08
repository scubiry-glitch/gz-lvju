'use strict';
const crypto=require('node:crypto');
const {assert}=require('./configuration.cjs');
const {isDemo}=require('./guiyang-demo.cjs');
const date=v=>new Date(v).toISOString().slice(0,19).replace('T',' ');
// Does not invoke fulfillment/payment adapters. Every accounting amount stays zero.
async function demoOrder(service,p,input,key){
 assert(['skus','packages','plans'].includes(input.kind),'商品类型无效');
 assert(Number.isSafeInteger(input.product_id)&&input.product_id>0,'商品编号无效');
 assert(input.demo_ack===true,'请确认此订单仅用于演示，不发生真实支付');
 // Demo orders stay at zero funds, but promotion attribution is still recorded for traceability.
 const referral=input.referral?await service.verifyReferral(input.referral,{kind:input.kind,product_id:input.product_id}):null;
 const sourceAccountId=referral&&referral.aid!==p.account.id?referral.aid:null;
 return service.tx(c=>service.idem(c,p,'demo-order',key,{...input,referral:null},async()=>{
  const product=await service.approved(c,input.kind,input.product_id);
  assert(isDemo(product.payload),'该商品不支持演示购买',409);
  assert(input.version===product.version,'商品已更新，请重新查看详情',409);
  return grantDemoOrder(service,c,p,input,product,sourceAccountId);
 }));
}
async function grantDemoOrder(service,c,p,input,product,sourceAccountId=null){
  const payload=product.payload;
  const source=input.kind==='skus'?[{sku_id:product.id,quantity:1,sku:payload}]:input.kind==='plans'?payload.package?.items:payload.items;
  assert(Array.isArray(source)&&source.length>0,'商品权益配置不完整',409);
  const items=[...source].sort((a,b)=>a.sku_id-b.sku_id);
  for(const item of items){
   const sku=await service.approved(c,'skus',item.sku_id),store=await service.approved(c,'stores',sku.store_id),merchant=await service.approved(c,'merchants',sku.merchant_id);
   assert(isDemo(sku.payload)&&isDemo(item.sku)&&isDemo(store.payload)&&isDemo(merchant.payload)&&sku.city_id===product.city_id&&sku.store_id===item.sku.store_id&&sku.merchant_id===item.sku.merchant_id,'演示商品不能混入真实服务或其他城市服务',409);
   const [r]=await c.execute('UPDATE commerce_inventory SET granted=granted+? WHERE sku_id=? AND total-reserved-granted>=?',[item.quantity,item.sku_id,item.quantity]);assert(r.affectedRows,'演示库存不足',409);
  }
  const orderId=crypto.randomUUID(),snapshot={...payload,is_demo:true,demo_price_minor:input.kind==='skus'?payload.retail_minor:payload.price_minor};
  await c.execute("INSERT INTO commerce_orders(id,account_id,city_id,product_kind,product_id,product_version,amount_minor,status,expires_at,snapshot,source_account_id) VALUES(?,?,?,?,?,?,0,'fulfilled',?,?,?)",[orderId,p.account.id,product.city_id,input.kind,product.id,product.version,date(Date.now()),JSON.stringify(snapshot),sourceAccountId]);
  await require('./main-system.cjs').linkOrder(c,{id:orderId,account_id:p.account.id,city_id:product.city_id,product_kind:input.kind,amount_minor:0,status:'fulfilled',snapshot});
  const coupons=[];
  for(const item of items){
   const snap={...item,allocation_minor:0,is_demo:true,rule:{beike_bps:0,channel_bps:0,floor_bps:0}};
   const [r]=await c.execute('INSERT INTO commerce_order_items(order_id,sku_id,merchant_id,store_id,quantity,allocation_minor,snapshot) VALUES(?,?,?,?,?,0,?)',[orderId,item.sku_id,item.sku.merchant_id,item.sku.store_id,item.quantity,JSON.stringify(snap)]);
   for(let unit=1;unit<=item.quantity;unit++){const id=crypto.randomUUID();await c.execute("INSERT INTO commerce_coupons(id,order_id,item_id,unit_no,account_id,merchant_id,store_id,city_id,status,expires_at,allocation_minor,snapshot) VALUES(?,?,?,?,?,?,?,?,'available',?,0,?)",[id,orderId,r.insertId,unit,p.account.id,item.sku.merchant_id,item.sku.store_id,product.city_id,date(Date.now()+item.sku.valid_days*86400000),JSON.stringify(snap)]);coupons.push(id);}
  }
  if(input.kind==='plans')await c.execute('INSERT INTO commerce_memberships(order_id,account_id,name,expires_at,snapshot) VALUES(?,?,?,?,?)',[orderId,p.account.id,payload.name,date(Date.now()+payload.valid_days*86400000),JSON.stringify(snapshot)]);
  await service.audit(c,p,'demo.order',orderId,{kind:input.kind,product_id:product.id,coupons:coupons.length,paid_minor:0,source_account_id:sourceAccountId},product);
  await c.execute('INSERT INTO commerce_events(aggregate_id,event_type,payload) VALUES(?,?,?)',[orderId,'demo.order.granted',JSON.stringify({order_id:orderId,coupons:coupons.length,paid_minor:0,source_account_id:sourceAccountId})]);
  return {id:orderId,status:'fulfilled',is_demo:true,paid_minor:0,coupon_count:coupons.length};
}
module.exports={demoOrder,grantDemoOrder};
