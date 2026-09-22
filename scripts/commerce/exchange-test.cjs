'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
async function run({pool,service,actors,check,origin}){
 actors.other.token=(await service.auth.createSession(actors.other.account.id,'127.0.0.1','exchange acceptance')).token;
 // Fresh accounts keep the per-account invalid-attempt limiter from interfering with batch scenarios.
 const freshAccount=async(id,name)=>{await pool.execute("INSERT IGNORE INTO accounts(id,display_name,principal_type,status) VALUES(?,?,'user','active')",[id,name]);return {type:'account',...await service.auth.getAccountWithRoles(id),token:(await service.auth.createSession(id,'127.0.0.1','exchange acceptance')).token};};
 const catalog=await service.catalog('guiyang'),issued=[];
 const call=async(path,input,actor=actors.user,key=crypto.randomUUID())=>{const r=await fetch(origin+'/api/commerce/v1'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+actor.token,'Idempotency-Key':key},body:JSON.stringify(input)});return {status:r.status,...await r.json()};};
 const issue=async(p,actor=actors.writer,key=crypto.randomUUID())=>call('/admin/exchange-codes',{kind:p.kind,product_id:p.id,version:p.version,expires_days:30},actor,key);
 await check('Exchange issuance enforces account, permission and city scope; immutable version and idempotency',async()=>{
  const p=catalog.find(p=>p.kind==='plans');assert.equal((await fetch(origin+'/api/commerce/v1/admin/exchange-codes',{method:'POST'})).status,401);
  assert.equal((await issue(p,actors.user)).status,403);assert.equal((await issue(p,actors.reader)).status,403);assert.equal((await issue(p,actors.city)).status,403);
  const key=crypto.randomUUID(),a=await issue(p,actors.writer,key),b=await issue(p,actors.writer,key);assert.equal(a.status,201);assert.equal(a.data.code,b.data.code);assert.equal((await call('/admin/exchange-codes',{kind:p.kind,product_id:p.id,version:999,expires_days:30},actors.writer)).status,409);
 });
 await check('Single, package and membership codes grant correct owned rights, zero funds and native orders',async()=>{
  for(const kind of ['skus','packages','plans']){const p=catalog.find(p=>p.kind===kind),a=await issue(p);assert.equal(a.status,201);issued.push(a.data);const key=crypto.randomUUID(),input={code:a.data.code.toLowerCase(),demo_ack:true};const r=await call('/exchange',input,actors.user,key),repeat=await call('/exchange',input,actors.user,key);assert.equal(r.status,201,JSON.stringify(r));assert.equal(r.data.id,repeat.data.id);assert.equal(r.data.coupon_count,p.items.reduce((n,i)=>n+i.quantity,0));assert.equal(r.data.paid_minor,0);assert.equal((await call('/exchange',input,actors.other)).status,409);
   const mine=await service.my(actors.user);assert.equal(mine.coupons.filter(c=>c.order_id===r.data.id).length,r.data.coupon_count);assert(!(await service.my(actors.other)).orders.some(o=>o.id===r.data.id));
   const [[native]]=await pool.execute('SELECT order_ref FROM gr_orders WHERE order_ref=?',[r.data.id]);assert(native);
   if(kind==='plans'){const m=mine.memberships.find(m=>m.order_id===r.data.id);assert.equal(m.items.length,p.items.length);assert(!JSON.stringify(m).includes('supply_minor'));}
  }
 });
 await check('Invalid, expired, unacknowledged and competing code claims cannot grant twice',async()=>{
  assert.equal((await call('/exchange',{code:'bad',demo_ack:true})).status,422);
  const single=catalog.find(p=>p.kind==='skus'),a=await issue(single);assert.equal((await call('/exchange',{code:a.data.code,demo_ack:false})).status,422);
  const race=await Promise.all([actors.user,actors.other].map(actor=>call('/exchange',{code:a.data.code,demo_ack:true},actor)));assert.equal(race.filter(r=>r.status===201).length,1);
  const expired=await issue(single);await pool.execute('UPDATE commerce_exchange_codes SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE id=?',[expired.data.id]);assert.equal((await call('/exchange',{code:expired.data.code,demo_ack:true},actors.other)).status,409);
 });
 await check('Insufficient stock rolls back the code claim and all grant records',async()=>{
  const single=catalog.find(p=>p.kind==='skus'),a=await issue(single);await pool.execute('UPDATE commerce_inventory SET total=granted+reserved WHERE sku_id=?',[single.id]);assert.equal((await call('/exchange',{code:a.data.code,demo_ack:true},actors.other)).status,409);
  const [[code]]=await pool.execute('SELECT redeemed_by,order_id FROM commerce_exchange_codes WHERE id=?',[a.data.id]);assert.equal(code.redeemed_by,null);assert.equal(code.order_id,null);await pool.execute('UPDATE commerce_inventory SET total=1000 WHERE sku_id=?',[single.id]);assert.equal((await call('/exchange',{code:a.data.code,demo_ack:true},actors.other)).status,201);
 });
 await check('Batch issuance returns distinct single-use codes under one idempotent key',async()=>{
  const p=catalog.find(p=>p.kind==='packages'),redeemer=await freshAccount(21,'批量兑换用户');
  const key=crypto.randomUUID(),a=await call('/admin/exchange-codes',{kind:p.kind,product_id:p.id,version:p.version,expires_days:45,quantity:5},actors.writer,key),b=await call('/admin/exchange-codes',{kind:p.kind,product_id:p.id,version:p.version,expires_days:45,quantity:5},actors.writer,key);
  assert.equal(a.status,201);assert.equal(a.data.codes.length,5);assert.equal(a.data.count,5);assert.deepEqual(a.data.codes,b.data.codes);
  assert.equal(new Set(a.data.codes.map(c=>c.code)).size,5,'codes must be distinct');
  assert.equal((await call('/admin/exchange-codes',{kind:p.kind,product_id:p.id,version:p.version,expires_days:45,quantity:0},actors.writer)).status,422);
  assert.equal((await call('/admin/exchange-codes',{kind:p.kind,product_id:p.id,version:p.version,expires_days:45,quantity:201},actors.writer)).status,422);
  await pool.execute('UPDATE commerce_inventory SET total=10000');
  const results=await Promise.all(a.data.codes.map(c=>call('/exchange',{code:c.code,demo_ack:true},redeemer)));
  assert.equal(results.filter(r=>r.status===201).length,5,'every batched code redeems exactly once');
 });
 await check('Code list supports status query, records and scope; plaintext never returns',async()=>{
  assert.equal((await fetch(origin+'/api/commerce/v1/admin/exchange-codes',{headers:{Authorization:'Bearer '+actors.user.token}})).status,403);
  const list=async(q,actor=actors.writer)=>{const r=await fetch(origin+'/api/commerce/v1/admin/exchange-codes?'+new URLSearchParams(q),{headers:{Authorization:'Bearer '+actor.token}});assert.equal(r.status,200);return r.json();};
  const all=await list({});assert(all.data.total>=10);assert.equal(JSON.stringify(all.data).includes('code_hash'),false,'hashes must not leak');
  const redeemed=await list({state:'redeemed'});assert(redeemed.data.rows.length>=4);
  for(const row of redeemed.data.rows){assert(row.redeemed_name,'redemption record keeps who redeemed');assert(row.order_id);assert.equal(row.state,'redeemed');}
  const unused=await list({state:'unused',kind:'plans'});for(const row of unused.data.rows)assert.equal(row.product_kind,'plans');
  assert.equal((await list({},actors.city)).data.total,0,'city-scoped operator outside city sees nothing');
  const summary=await list({});
  for(const key of ['unused','redeemed','expired','disabled'])assert(Number.isInteger(summary.data.summary[key]),'summary '+key+' must be a count');
  assert(summary.data.summary.redeemed>=4,'summary counts redeemed codes');
 });
 await check('Disable keeps unredeemed codes from exchange; redeemed codes are immutable',async()=>{
  const p=catalog.find(p=>p.kind==='skus'),a=await issue(p),redeemer=await freshAccount(22,'停用验证用户');
  const disable=async(id,actor=actors.writer)=>{const r=await fetch(origin+'/api/commerce/v1/admin/exchange-codes/'+id+'/disable',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+actor.token},body:'{}'});return {status:r.status,...await r.json()};};
  assert.equal((await disable(a.data.id,actors.user)).status,403);
  assert.equal((await disable(a.data.id)).status,200);
  assert.equal((await call('/exchange',{code:a.data.code,demo_ack:true},redeemer)).status,409,'disabled code must not redeem');
  assert.equal((await disable(a.data.id)).status,200,'disabling twice stays idempotent');
  const [[row]]=await pool.execute('SELECT disabled_by,disabled_at FROM commerce_exchange_codes WHERE id=?',[a.data.id]);assert.equal(row.disabled_by,actors.writer.account.id);assert(row.disabled_at);
  const [redeemedRow]=await pool.execute('SELECT id FROM commerce_exchange_codes WHERE redeemed_by IS NOT NULL LIMIT 1');
  assert.equal((await disable(redeemedRow[0].id)).status,409,'redeemed codes cannot be disabled');
 });
 await check('Demo orders record signed referral attribution while every amount stays zero',async()=>{
  const p=catalog.find(p=>p.kind==='packages'),promoter=await freshAccount(23,'归属验证推广员');
  const callAny=async(path,actor,method='GET',body)=>{const r=await fetch(origin+'/api/commerce/v1'+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+actor.token,...(method!=='GET'?{'Idempotency-Key':crypto.randomUUID()}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,...await r.json()};};
  const share=await callAny('/shares',promoter,'POST',{kind:p.kind,product_id:p.id});assert.equal(share.status,201);
  const ref=new URL(share.data.url).searchParams.get('ref');
  await assert.rejects(()=>service.verifyReferral(ref.slice(0,-2)+'xx'),/签名/);
  const order=await callAny('/demo-orders',actors.other,'POST',{kind:p.kind,product_id:p.id,version:p.version,demo_ack:true,referral:ref});assert.equal(order.status,201);
  const [[row]]=await pool.execute('SELECT source_account_id FROM commerce_orders WHERE id=?',[order.data.id]);assert.equal(row.source_account_id,promoter.account.id,'demo purchase keeps its promoter');
  const coupons=(await service.my(actors.other)).coupons.filter(c=>c.order_id===order.data.id);const coupon=coupons.find(c=>c.store_id===p.items[0].store_id)||coupons[0];assert(coupon,'attributed demo coupon granted');
  const [[ruleSnap]]=await pool.execute("SELECT JSON_EXTRACT(snapshot,'$.rule.beike_bps') b, JSON_EXTRACT(snapshot,'$.rule.channel_bps') c FROM commerce_coupons WHERE id=?",[coupon.id]);
  assert.equal(Number(ruleSnap.b),0);assert.equal(Number(ruleSnap.c),0,'demo rule keeps every share at zero');
  const unattributed=await callAny('/demo-orders',actors.other,'POST',{kind:'skus',product_id:catalog.find(x=>x.kind==='skus').id,version:catalog.find(x=>x.kind==='skus').version,demo_ack:true});assert.equal(unattributed.status,201);
  const [[plain]]=await pool.execute('SELECT source_account_id FROM commerce_orders WHERE id=?',[unattributed.data.id]);assert.equal(plain.source_account_id,null,'no referral means no attribution');
  const promo=await callAny('/promotion',promoter);assert.equal(promo.status,200);
  assert(promo.data.demo_orders>=1,'promotion view separates demo orders');assert.equal(Number(promo.data.confirmed_minor),0,'demo confirmation keeps commission at zero');
  assert.equal(Number(promo.data.orders),0,'demo attribution must not inflate attributed orders');
  assert(String(promo.data.demo_note||'').includes('分开')||String(promo.data.demo_note||'').includes('演示'));
  // 归因演示券被核销后同样不得进入推广口径：演示核销永不进结算批次，awaiting_batch 不许被它永久顶高（规则 21）。
  const storeRow=await service.approved(pool,'stores',p.items[0].store_id);
  const accountId=24;
  await pool.execute("INSERT IGNORE INTO accounts(id,display_name,principal_type,status,vendor_id) VALUES(?,?,'user','active',?)",[accountId,'归因核销员',storeRow.vendor_id]);
  await pool.execute('INSERT IGNORE INTO account_roles(account_id,role_code,scope) VALUES(?,\'merchant\',?)',[accountId,JSON.stringify({level:'vendor',vendor_id:storeRow.vendor_id})]);
  const existingStaff=await service.get(pool,'SELECT id FROM commerce_staff WHERE store_id=?',[p.items[0].store_id]);
  let staff;
  if(existingStaff.length){staff=await service.entity(pool,'staff',existingStaff[0].id);}
  else{staff=await service.save(actors.writer,'commerce.admin.write','staff',null,{payload:{name:'归因核销员',merchant_id:storeRow.merchant_id,store_id:p.items[0].store_id,account_id:accountId}});staff=await service.transition(actors.writer,'commerce.admin.write','staff',staff.id,{version:staff.version,action:'submit'});staff=await service.transition(actors.reviewer,'commerce.admin.review','staff',staff.id,{version:staff.version,action:'approve',note:'归因验收核销授权'});staff=await service.transition(actors.writer,'commerce.admin.write','staff',staff.id,{version:staff.version,action:'publish'});}
  const redeemer={type:'account',...await service.auth.getAccountWithRoles(accountId),token:(await service.auth.createSession(accountId,'127.0.0.1','attribution acceptance')).token};
  const bj=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(v);
  await service.appointment(actors.other,{coupon_id:coupon.id,service_date:bj(Date.now()+86400000)},'attrib-appt');
  await pool.execute("UPDATE commerce_appointments SET service_date=CURDATE() WHERE coupon_id=? AND status='booked'",[coupon.id]);
  const redeemToken=await service.token(actors.other,coupon.id);
  await service.redeem(redeemer,'commerce.merchant.redeem',{coupon_id:coupon.id,token:redeemToken.token},'attrib-redeem');
  const promo2=await callAny('/promotion',promoter);assert.equal(promo2.status,200);
  assert.equal(Number(promo2.data.orders),0,'demo redemption must not inflate attributed orders');
  assert.equal(Number(promo2.data.redemptions),0,'demo redemption must not inflate valid redemptions');
  assert.equal(Number(promo2.data.settlement.awaiting_batch),0,'demo redemption must never await settlement batches');
  assert.equal(Number(promo2.data.settlement.confirmed_minor),0,'demo redemption must not create commission');
  // 逐券明细接口（本人 scope）：归因订单与演示核销进列表，代发记录为空数组形状。
  const rec=await callAny('/promotion/records',promoter);assert.equal(rec.status,200);
  assert((rec.data.orders||[]).some(o=>o.order_id===order.data.id&&Number(o.is_demo)===1),'records list attributed demo orders');
  assert((rec.data.redemptions||[]).some(r=>r.id&&Number(r.is_demo)===1),'records list demo redemptions');
  assert(Array.isArray(rec.data.payouts),'records expose payout history');
  // 选品接口：预估佣金 + 本人点击/归因统计。演示商品佣金恒 0；真实归因计数排除演示（规则 21）。
  await callAny('/referral?token='+encodeURIComponent(ref),promoter);
  const pc=await callAny('/promotion/products',promoter);assert.equal(pc.status,200);
  const mine=(pc.data.products||[]).find(x=>x.kind===p.kind&&x.id===p.id);assert(mine,'product enrichment returned');
  assert(mine.is_demo===true&&mine.commission_minor===0&&mine.commission_bps===null,'demo product discloses zero commission');
  assert(Number(mine.clicks)>=1,'referral landing click counted');
  assert(Number(mine.demo_orders)>=1,'demo attribution visible per product');
  assert(Number(mine.orders)===0,'per-product real orders exclude demo');
  // 推广资格闸：settings.promoter_gate='1' 时无 promoter 角色被拒；授予角色后恢复；页面状态随 /promotion 下发。
  await pool.execute("INSERT INTO settings(`key`,value) VALUES('promoter_gate','1') ON DUPLICATE KEY UPDATE value='1'");
  const outsider=await freshAccount(25,'无资格账号');
  assert.equal((await callAny('/shares',outsider,'POST',{kind:p.kind,product_id:p.id})).status,403,'gate blocks unqualified accounts');
  const outsiderPromo=await callAny('/promotion',outsider);
  assert.equal(outsiderPromo.data.promoter_gate,true);assert.equal(outsiderPromo.data.share_qualified,false,'promotion view reflects qualification');
  await pool.execute("INSERT IGNORE INTO roles(role_code,name,permissions,builtin) VALUES('promoter','推广员','[]',0)");
  await pool.execute('INSERT IGNORE INTO account_roles(account_id,role_code,scope) VALUES(?,\'promoter\',?)',[promoter.account.id,JSON.stringify({level:'self'})]);
  assert.equal((await callAny('/shares',promoter,'POST',{kind:p.kind,product_id:p.id})).status,201,'promoter role passes the gate');
  assert.equal((await callAny('/promotion',promoter)).data.share_qualified,true,'qualified promoter reflected');
  await pool.execute("UPDATE settings SET value='0' WHERE `key`='promoter_gate'");
 });
 await check('Two customers and three demo merchants reject every cross-account access',async()=>{
  // Build redeemers for three distinct demo merchants with a published staff authorisation each.
  const skusByMerchant=new Map();
  for(const p of catalog.filter(x=>x.kind==='skus')){if(!skusByMerchant.has(p.items[0].store_id))skusByMerchant.set(p.items[0].store_id,p);}
  const picked=[...skusByMerchant.values()].slice(0,3);assert.equal(picked.length,3,'three demo stores');
  const redeemers=[];
  for(const [index,p] of picked.entries()){
   const vendorId=(await service.approved(pool,'stores',p.items[0].store_id)).vendor_id;
   const accountId=30+index;
   await pool.execute("INSERT IGNORE INTO accounts(id,display_name,principal_type,status,vendor_id) VALUES(?,?,'user','active',?)",[accountId,'交叉核销员'+(index+1),vendorId]);
   await pool.execute('INSERT IGNORE INTO account_roles(account_id,role_code,scope) VALUES(?,\'merchant\',?)',[accountId,JSON.stringify({level:'vendor',vendor_id:vendorId})]);
   const storeRow=await service.approved(pool,'stores',p.items[0].store_id);
   // 每个核销员账号各自建一份门店授权；不复用既有 staff（可能绑定别的账号，如归因场景的核销员）。
   let staff=await service.save(actors.writer,'commerce.admin.write','staff',null,{payload:{name:'交叉核销员'+(index+1)+'-'+accountId,merchant_id:storeRow.merchant_id,store_id:p.items[0].store_id,account_id:accountId}});staff=await service.transition(actors.writer,'commerce.admin.write','staff',staff.id,{version:staff.version,action:'submit'});staff=await service.transition(actors.reviewer,'commerce.admin.review','staff',staff.id,{version:staff.version,action:'approve',note:'交叉验收核销授权'});staff=await service.transition(actors.writer,'commerce.admin.write','staff',staff.id,{version:staff.version,action:'publish'});
   redeemers.push({type:'account',...await service.auth.getAccountWithRoles(accountId),token:(await service.auth.createSession(accountId,'127.0.0.1','cross acceptance')).token});
  }
  const customerA=await freshAccount(31,'交叉客户A'),customerB=await freshAccount(32,'交叉客户B');
  // Customer A redeems codes for all three merchants; customer B never gains access to them.
  const ownedCoupons=[];
  for(const p of picked){const a=await issue(p);const r=await call('/exchange',{code:a.data.code,demo_ack:true},customerA);assert.equal(r.status,201);const mine=await service.my(customerA);ownedCoupons.push(mine.coupons.filter(c=>c.order_id===r.data.id)[0]);}
  await assert.rejects(()=>service.token(customerB,ownedCoupons[0].id),/不属于|卡券不存在/,'cross-customer token denied');
  assert.equal((await fetch(origin+'/api/commerce/v1/my/orders/'+ownedCoupons[0].order_id,{headers:{Authorization:'Bearer '+customerB.token}})).status,404,'cross-customer tracking denied');
  // Booking then same-day redemption through the two-step manual/QR flow, one per merchant store.
  const bj=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(v);
  const todayStr=bj(Date.now());
  for(const [index,coupon] of ownedCoupons.entries()){
   const tomorrowStr=bj(Date.now()+86400000);
   await service.appointment(customerA,{coupon_id:coupon.id,service_date:tomorrowStr},'cross-appt-'+index);
   await pool.execute('UPDATE commerce_appointments SET service_date=? WHERE coupon_id=? AND status=?',[todayStr,coupon.id,'booked']);
   const token=await service.token(customerA,coupon.id);
   await assert.rejects(()=>service.previewRedeem(redeemers[(index+1)%3],'commerce.merchant.redeem',{coupon_id:coupon.id,token:token.token}),e=>e.status===403,'cross-merchant preview denied');
   const meta=await service.previewRedeem(redeemers[index],'commerce.merchant.redeem',{coupon_id:coupon.id,token:token.token});
   assert.equal(meta.coupon_id,coupon.id);assert(meta.name);
   const done=await service.redeem(redeemers[index],'commerce.merchant.redeem',{coupon_id:coupon.id,token:token.token},'cross-redeem-'+index);
   assert.equal(done.status,'redeemed');
   await assert.rejects(()=>service.redeem(redeemers[index],'commerce.merchant.redeem',{coupon_id:coupon.id,token:token.token},'cross-redeem-repeat-'+index),/已使用|已核销/,'double redeem denied');
   const chain=await service.track(customerA,coupon.order_id);assert.equal(chain.coupons[0].status,'redeemed');
  }
  const [[grantedTotal]]=await pool.execute('SELECT COUNT(*) n FROM commerce_redemptions WHERE account_id=?',[customerA.account.id]);assert.equal(grantedTotal.n,3,'exactly one redemption per coupon');
 });
}
module.exports={run};
