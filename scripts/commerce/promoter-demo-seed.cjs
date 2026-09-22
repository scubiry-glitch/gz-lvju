'use strict';
// 推广员端 · 演示数据种子（sytest 预览库专用，配合 settlement-demo-seed 的「演示推广员·沈晓」）。
// seed：为 demo_promoter 补三类演示数据——① 分享链接落地点击（referral.click 事件，转化率分母）；
//       ② 演示归因订单（demo 买家经推广链接演示购买，is_demo 打标）；③ 演示核销（channel=0，永不进资金域，规则 21）。
// clean：只删本种子创建的行（演示买家 + demo_promoter 关联的 is_demo 行与 seed 标记事件）。
// 用法：node scripts/commerce/promoter-demo-seed.cjs seed|clean|status
const crypto=require('node:crypto');
const SEED_KEY='promoter-demo-v1';
(async()=>{
 const mode=process.argv[2]||'status';
 const {createPool,initAuth}=require('../../commerce/db.cjs'),{Service}=require('../../commerce/service.cjs'),authCenter=require('../../auth_center.cjs');
 const parse=v=>typeof v==='string'?JSON.parse(v):v;
 const pool=createPool();
 const q=async(s,a=[])=>(await pool.execute(s,a))[0];
 const step=t=>console.error('[promoter-seed]',t);
 try{
  const [promoter]=await q("SELECT id,display_name FROM accounts WHERE login_name='demo_promoter'");
  if(!promoter){console.log('demo_promoter 不存在：先跑 node scripts/commerce/settlement-demo-seed.cjs seed');return;}
  const [lin]=await q("SELECT id FROM accounts WHERE login_name='demo_lin'"),[chen]=await q("SELECT id FROM accounts WHERE login_name='demo_chen'");
  if(!lin||!chen){console.log('演示买家（demo_lin/demo_chen）不存在：先跑 settlement-demo-seed');return;}
  const auth=initAuth(pool),service=new Service(pool,auth);
  const mkPrincipal=async id=>({type:'account',...await auth.getAccountWithRoles(id),token:(await auth.createSession(id,'127.0.0.1','promoter-demo-seed')).token});
  const referralToken=(kind,id,v)=>{const payload=Buffer.from(JSON.stringify({aid:promoter.id,kind,id,v,exp:Math.floor(Date.now()/1000)+86400})).toString('base64url');const secret=process.env.JUZHU_API_KEY||process.env.JUZHU_ADMIN_PASSWORD;return payload+'.'+crypto.createHmac('sha256',secret).update('commerce-share:'+payload).digest('base64url');};
  if(mode==='status'){
   const clicks=await q("SELECT COUNT(*) n FROM commerce_events WHERE event_type='referral.click' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.seed'))=?",[SEED_KEY]);
   const [ords]=await q("SELECT COUNT(*) n FROM commerce_orders WHERE source_account_id=? AND JSON_EXTRACT(snapshot,'$.seed_key')=?",[promoter.id,SEED_KEY]);
   console.log('clicks:',clicks[0].n,'demo attributed orders:',ords.n);
   return;
  }
  if(mode==='clean'){
   let n=0;
   for(const oid of (await q('SELECT id FROM commerce_orders WHERE source_account_id=? AND JSON_EXTRACT(snapshot,\'$.seed_key\')=?',[promoter.id,SEED_KEY])).map(r=>r.id)){
    n+=await pool.execute('DELETE FROM commerce_redemptions WHERE coupon_id IN (SELECT id FROM commerce_coupons WHERE order_id=?)',[oid]).then(([r])=>r.affectedRows).catch(()=>0);
    n+=await pool.execute('DELETE FROM commerce_cases WHERE coupon_id IN (SELECT id FROM commerce_coupons WHERE order_id=?)',[oid]).then(([r])=>r.affectedRows).catch(()=>0);
    n+=await pool.execute('DELETE FROM commerce_appointments WHERE coupon_id IN (SELECT id FROM commerce_coupons WHERE order_id=?)',[oid]).then(([r])=>r.affectedRows).catch(()=>0);
    n+=await pool.execute('DELETE FROM commerce_coupons WHERE order_id=?',[oid]).then(([r])=>r.affectedRows);
    n+=await pool.execute('DELETE FROM commerce_order_items WHERE order_id=?',[oid]).then(([r])=>r.affectedRows);
    n+=await pool.execute("DELETE FROM gr_orders WHERE order_ref=?",[oid]).then(([r])=>r.affectedRows).catch(()=>0);
    n+=await pool.execute('DELETE FROM commerce_orders WHERE id=?',[oid]).then(([r])=>r.affectedRows);
   }
   n+=await pool.execute("DELETE FROM commerce_events WHERE event_type='referral.click' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.seed'))=?",[SEED_KEY]).then(([r])=>r.affectedRows);
   // 幂等键一并清理，否则重种时 demo-order 重放已删订单（幽灵单）。
   n+=await pool.execute("DELETE FROM commerce_idempotency WHERE request_key LIKE 'promoter-demo-%'").then(([r])=>r.affectedRows).catch(()=>0);
   console.log('cleaned',n,'rows');return;
  }
  // ── seed ──
  const products=(await service.promoterCatalog('贵阳')).filter(p=>p.is_demo).slice(0,3);
  if(!products.length){console.log('贵阳演示商品不存在');return;}
  // ① 点击：逐商品不同量级，转化率才有区分度。
  const clickPlan=products.map((p,i)=>({p,n:[23,9,14][i]||8}));
  let clicks=0;
  for(const {p,n} of clickPlan){
   const [exist]=await q("SELECT COUNT(*) n FROM commerce_events WHERE event_type='referral.click' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.seed'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.pid'))=?",[SEED_KEY,String(p.kind+':'+p.id)]);
   if(exist.n){step('clicks already seeded for '+p.name);continue;}
   for(let k=0;k<n;k++){await pool.execute('INSERT INTO commerce_events(aggregate_id,event_type,payload) VALUES(?,?,?)',['referral:'+p.kind+':'+p.id,'referral.click',JSON.stringify({aid:promoter.id,kind:p.kind,id:p.id,seed:SEED_KEY,pid:p.kind+':'+p.id})]);clicks++;}
  }
  step('clicks inserted: '+clicks);
  // ② 演示归因订单：两个演示买家各经推广链接演示购买（幂等键固定，重跑安全）。
  const buyers=[{id:lin.id,key:'lin'},{id:chen.id,key:'chen'}];
  let seededOrders=0;
  for(const [i,p] of products.entries()){
   const buyer=buyers[i%buyers.length],key='promoter-demo-'+buyer.key+'-'+p.id;
   const principal=await mkPrincipal(buyer.id);
   try{
    const r=await require('../../commerce/demo-order.cjs').demoOrder(service,principal,{kind:p.kind,product_id:p.id,version:p.version,demo_ack:true,referral:referralToken(p.kind,p.id,p.version)},key);
    // 在订单快照上补种子标记（demo-order 的 snapshot=商品 payload，这里追加 seed_key 便于 clean 定位）。
    await pool.execute("UPDATE commerce_orders SET snapshot=JSON_SET(snapshot,'$.seed_key',?) WHERE id=?",[SEED_KEY,r.id]);
    seededOrders++;step('demo order '+r.id+' ('+p.name+' × '+buyer.key+')');
   }catch(e){step('skip '+p.name+' ('+buyer.key+'): '+e.message);}
  }
  // ③ 演示核销：抽每单第一张券直接落 confirmed 核销行（channel=0、is_demo，与 demo-order 口径一致；不写账、不进批次）。
  let reds=0;
  for(const oid of (await q('SELECT id FROM commerce_orders WHERE source_account_id=? AND JSON_EXTRACT(snapshot,\'$.seed_key\')=?',[promoter.id,SEED_KEY])).map(r=>r.id)){
   const [cps]=await q("SELECT c.id,c.merchant_id,c.store_id,c.city_id,c.account_id FROM commerce_coupons c WHERE c.order_id=? AND c.status='available' LIMIT 1",[oid]);
   if(!cps)continue;
   const [exist]=await q('SELECT COUNT(*) n FROM commerce_redemptions WHERE coupon_id=?',[cps.id]);
   if(exist.n)continue;
   const rid=crypto.randomUUID();
   await pool.execute("INSERT INTO commerce_redemptions(id,coupon_id,account_id,merchant_id,store_id,city_id,operator_id,allocation_minor,supplier_minor,beike_minor,channel_minor,retained_minor,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'confirmed')",[rid,cps.id,cps.account_id,cps.merchant_id,cps.store_id,cps.city_id,0,0,0,0,0,0]);
   await pool.execute("UPDATE commerce_coupons SET status='redeemed',token_hash=NULL,token_expires_at=NULL WHERE id=?",[cps.id]);
   await pool.execute('INSERT INTO commerce_events(aggregate_id,event_type,payload) VALUES(?,?,?)',[cps.id,'demo.coupon.redeemed',JSON.stringify({coupon_id:cps.id,seed:SEED_KEY,demo:true})]);
   reds++;
  }
  step('demo redemptions inserted: '+reds);
  console.log('seeded: clicks +'+clicks+', demo orders +'+seededOrders+', demo redemptions +'+reds);
 }finally{await pool.end();}
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
