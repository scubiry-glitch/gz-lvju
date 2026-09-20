'use strict';
// 酒店通兑 + 线上/线下核销域回归：档内任选、跨档拒绝、线上免预约、核销归集与资金隔离。
const assert=require('node:assert/strict');
const demoOrderMod=require('../../commerce/demo-order.cjs');
const {sampleHotels,seed:hotelSeed,clean:hotelClean}=require('../../commerce/hotel-exchange-demo.cjs');
const bjDate=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(v);
const pj=v=>typeof v==='string'?JSON.parse(v):v; // mysql2 对 JSON 列可能已返回对象
async function run({pool,service,actors,check,origin,auth}){
 const write='commerce.admin.write';
 async function configEntity(kind,payload){let e=await service.save(actors.writer,write,kind,null,{payload});e=await service.transition(actors.writer,write,kind,e.id,{version:e.version,action:'submit'});e=await service.transition(actors.reviewer,'commerce.admin.review',kind,e.id,{version:e.version,action:'approve',note:'验收资料已复核'});e=await service.transition(actors.writer,write,kind,e.id,{version:e.version,action:'publish'});return e;}
 const demoInput=p=>({kind:p.kind,product_id:p.id,version:p.version,demo_ack:true});
 let sample,warVendorId,exchangeSku,ticketSku,onlineSku,coupon,t80a,t80b,t100,anchor,onlineCoupon;
 let counterStoreId,counterMerchantId,counterVendorId;
 async function hotelStore(tier,excludeCode){
  const [rows]=await pool.query("SELECT e.id,e.status,JSON_UNQUOTE(JSON_EXTRACT(v.snapshot,'$.hotel_code')) code FROM commerce_stores e JOIN commerce_versions v ON v.kind='stores' AND v.entity_id=e.id AND v.version=e.published_version WHERE e.status='published' AND JSON_UNQUOTE(JSON_EXTRACT(v.snapshot,'$.kind'))='hotel' AND JSON_UNQUOTE(JSON_EXTRACT(v.snapshot,'$.exchange_tier'))=? ORDER BY e.id",[tier]);
  return rows.find(r=>!excludeCode||r.code!==excludeCode);
 }
 async function staffPrincipal(accountId,vendorId){
  await pool.execute("INSERT IGNORE INTO roles(role_code,name,permissions,builtin) VALUES('merchant','商户',?,0)",[JSON.stringify(['commerce.merchant.read','commerce.merchant.write','commerce.merchant.redeem'])]);
  await pool.execute('INSERT INTO account_roles(account_id,role_code,scope) VALUES(?,?,?) ON DUPLICATE KEY UPDATE scope=VALUES(scope)',[accountId,'merchant',JSON.stringify({level:'vendor',vendor_id:Number(vendorId)})]);
  return {type:'account',...await auth.getAccountWithRoles(accountId)};
 }
 async function staffAt(name,storeId,accountId,vendorId){
  await configEntity('staff',{name,merchant_id:(await service.entity(pool,'stores',storeId)).merchant_id,store_id:storeId,account_id:accountId});
  return staffPrincipal(accountId,vendorId);
 }
 await check('Hotel roster sampling is deterministic and covers every tier with brand rotation',async()=>{
  const a=sampleHotels(undefined,8),b=sampleHotels(undefined,8);
  assert.deepEqual(a,b);assert.equal(a.length,48);
  const byTier={};for(const h of a)byTier[h.exchange_tier]=(byTier[h.exchange_tier]||0)+1;
  assert.deepEqual(Object.keys(byTier).sort(),['t100','t120','t160','t180','t200','t80']);
  for(const n of Object.values(byTier))assert.equal(n,8);
 });
 await check('Hotel exchange demo seeds hotels, anchors, categories and an exchange package',async()=>{
  await pool.query("INSERT IGNORE INTO cities(id,name,slug) VALUES(3,'贵阳','guiyang')");
  await hotelSeed(pool);
  const city=await service.catalog('贵阳');
  const skus=city.filter(p=>p.kind==='skus');
  exchangeSku=skus.find(p=>p.exchange_tier==='t80');ticketSku=skus.find(p=>p.category_id==='scenic_ticket');onlineSku=skus.find(p=>p.redeem_channel==='online');
  assert(exchangeSku&&ticketSku&&onlineSku);
  assert.equal(skus.filter(p=>p.category_id==='hotel_exchange').length,6);
  assert(city.some(p=>p.kind==='packages'&&p.items.length===3));
  assert.equal(onlineSku.redeem_channel,'online');assert.equal(ticketSku.redeem_channel,'offline');
  [[sample]]=await pool.query("SELECT e.id,v.snapshot FROM commerce_stores e JOIN commerce_versions v ON v.kind='stores' AND v.entity_id=e.id AND v.version=e.published_version WHERE JSON_UNQUOTE(JSON_EXTRACT(v.snapshot,'$.kind'))='hotel' LIMIT 1");
  [[{vendor_id:warVendorId}]]=await pool.query('SELECT vendor_id FROM commerce_merchants WHERE id=?',[pj(sample.snapshot).merchant_id]);
 });
 await check('Exchange coupon books any same-tier hotel; anchors and other tiers are rejected',async()=>{
  t80a=await hotelStore('t80');t80b=await hotelStore('t80',t80a.code);t100=await hotelStore('t100');
  [[{id:anchor}]]=await pool.query("SELECT e.id FROM commerce_stores e JOIN commerce_versions v ON v.kind='stores' AND v.entity_id=e.id AND v.version=e.published_version WHERE e.status='published' AND JSON_UNQUOTE(JSON_EXTRACT(v.snapshot,'$.exchange_tier'))='t80' AND JSON_EXTRACT(v.snapshot,'$.kind') IS NULL LIMIT 1");
  const order=await demoOrderMod.demoOrder(service,actors.user,demoInput(exchangeSku),'hotel-order-01');
  coupon=(await service.my(actors.user)).coupons.find(c=>c.order_id===order.id);
  await assert.rejects(()=>service.appointment(actors.user,{coupon_id:coupon.id,service_date:bjDate(Date.now()+2*86400000)},'hotel-appt-need-store'),/请选择要入住的酒店/);
  await assert.rejects(()=>service.appointment(actors.user,{coupon_id:coupon.id,store_id:t100.id,service_date:bjDate(Date.now()+2*86400000)},'hotel-appt-cross-tier'),/同档位试点名单/);
  await assert.rejects(()=>service.appointment(actors.user,{coupon_id:coupon.id,store_id:anchor,service_date:bjDate(Date.now()+2*86400000)},'hotel-appt-anchor'),/同档位试点名单/);
  const ok=await service.appointment(actors.user,{coupon_id:coupon.id,store_id:t80a.id,service_date:bjDate(Date.now()+2*86400000)},'hotel-appt-01');
  assert.equal(ok.store_id,t80a.id);
  const [[capA1]]=await pool.execute('SELECT reserved FROM commerce_capacity WHERE store_id=?',[t80a.id]);assert.equal(capA1.reserved,1);
  // 换店改期：旧店产能对称释放，新店占用。
  const moved=await service.appointment(actors.user,{coupon_id:coupon.id,store_id:t80b.id,service_date:bjDate(Date.now()+3*86400000)},'hotel-appt-02');
  assert.equal(moved.store_id,t80b.id);coupon.appointmentId=moved.id;
  const [[capA]]=await pool.execute('SELECT COALESCE(SUM(reserved),0) r FROM commerce_capacity WHERE store_id=?',[t80a.id]);
  const [[capB]]=await pool.execute('SELECT COALESCE(SUM(reserved),0) r FROM commerce_capacity WHERE store_id=?',[t80b.id]);
  assert.equal(Number(capA.r),0);assert.equal(Number(capB.r),1);
 });
 await check('Non-exchange offline coupons ignore extra store_id and keep legacy booking',async()=>{
  const order=await demoOrderMod.demoOrder(service,actors.user,demoInput(ticketSku),'ticket-order-01');
  const ticketCoupon=(await service.my(actors.user)).coupons.find(c=>c.order_id===order.id);
  const booked=await service.appointment(actors.user,{coupon_id:ticketCoupon.id,store_id:t100.id,service_date:bjDate(Date.now()+2*86400000)},'ticket-appt-01');
  const [[row]]=await pool.execute('SELECT store_id,merchant_id FROM commerce_appointments WHERE id=?',[booked.id]);
  assert.equal(row.store_id,ticketCoupon.store_id);assert.equal(row.merchant_id,ticketCoupon.merchant_id);
 });
 await check('Online coupons cannot book; they redeem via online-counter staff without appointment',async()=>{
  const order=await demoOrderMod.demoOrder(service,actors.user,demoInput(onlineSku),'online-order-01');
  onlineCoupon=(await service.my(actors.user)).coupons.find(c=>c.order_id===order.id);
  await assert.rejects(()=>service.appointment(actors.user,{coupon_id:onlineCoupon.id,service_date:bjDate(Date.now()+2*86400000)},'online-appt-01'),/线上核销券无需预约/);
  [[{id:counterStoreId,merchant_id:counterMerchantId,vendor_id:counterVendorId}]]=await pool.query("SELECT e.id,m.id merchant_id,m.vendor_id FROM commerce_stores e JOIN commerce_versions v ON v.kind='stores' AND v.entity_id=e.id AND v.version=e.published_version JOIN commerce_merchants m ON m.id=e.merchant_id WHERE JSON_UNQUOTE(JSON_EXTRACT(v.snapshot,'$.service_channel'))='online' LIMIT 1");
  for(const [i,vendor] of [[22,counterVendorId],[23,warVendorId],[24,warVendorId]])await pool.execute("INSERT INTO accounts(id,display_name,principal_type,status,vendor_id) VALUES(?,?,'user','active',?)",[i,'核销账号'+i,vendor]);
  const counterPrincipal=await staffAt('线上核销员',counterStoreId,22,counterVendorId);
  const hotelStaff=await staffAt('入住酒店核销员',t80b.id,23,warVendorId);
  const otherHotelStaff=await staffAt('其他门店核销员',t80a.id,24,warVendorId);
  const token=await service.token(actors.user,onlineCoupon.id);
  const result=await service.redeem(counterPrincipal,'commerce.merchant.redeem',{coupon_id:onlineCoupon.id,token:token.token},'online-redeem-01');
  assert.equal(result.online,true);assert.equal(result.store_id,counterStoreId);
  const [[redemption]]=await pool.execute('SELECT merchant_id,store_id FROM commerce_redemptions WHERE id=?',[result.id]);
  assert.equal(redemption.store_id,counterStoreId);assert.equal(redemption.merchant_id,counterMerchantId);
  // 把预约改到今天以演示当日核销（正式环境由当日预约自然满足）。
  await pool.execute("UPDATE commerce_appointments SET service_date=? WHERE id=?",[bjDate(Date.now()),coupon.appointmentId]);
  const hotelToken=await service.token(actors.user,coupon.id);
  await assert.rejects(()=>service.redeem(otherHotelStaff,'commerce.merchant.redeem',{coupon_id:coupon.id,token:hotelToken.token},'hotel-redeem-wrong'),/未获该门店核销授权/);
  const preview=await service.previewRedeem(hotelStaff,'commerce.merchant.redeem',{coupon_id:coupon.id,token:hotelToken.token});
  assert.equal(preview.service_date,bjDate(Date.now()));assert(preview.store);
  const redeemed=await service.redeem(hotelStaff,'commerce.merchant.redeem',{coupon_id:coupon.id,token:hotelToken.token},'hotel-redeem-01');
  const [[row]]=await pool.execute('SELECT merchant_id,store_id FROM commerce_redemptions WHERE id=?',[redeemed.id]);
  assert.equal(row.store_id,t80b.id);
  const [[storeRow]]=await pool.execute('SELECT merchant_id FROM commerce_stores WHERE id=?',[t80b.id]);
  assert.equal(row.merchant_id,storeRow.merchant_id,'核销归集到所选酒店商户');
  const [[ledger]]=await pool.execute('SELECT COUNT(*) n FROM commerce_ledger_entries WHERE source_id=?',[redeemed.id]);
  assert.equal(ledger.n,0,'演示核销不产生资金分录');
 });
 await check('Public hotel directory exposes tiers and public fields only',async()=>{
  const r=await fetch(origin+'/api/commerce/v1/hotels?tier=t80');assert.equal(r.status,200);
  const data=(await r.json()).data;
  assert.equal(data.tiers.length,6);assert(data.tiers.every(t=>t.count===8));
  assert(data.hotels.length>0&&data.hotels.every(h=>h.tier==='t80'));
  assert(data.hotels.every(h=>h.name&&h.brand&&h.hotel_code));
  assert(!/merchant_id|supply_minor|capacity|vendor_id/.test(JSON.stringify(data.hotels)));
  const all=await (await fetch(origin+'/api/commerce/v1/hotels')).json();
  assert.equal(all.data.total,48);
  const q=await (await fetch(origin+'/api/commerce/v1/hotels?q='+encodeURIComponent(all.data.hotels[0].brand))).json();
  assert(q.data.hotels.length>=1);
 });
 await check('Demo clean refuses while business records reference the batch',async()=>{
  await assert.rejects(()=>hotelClean(pool),/业务单据/);
 });
}
module.exports={run};
