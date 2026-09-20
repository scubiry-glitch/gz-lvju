'use strict';
// 结算与对账 · 演示数据种子（sytest 预览库专用）。
// seed：幂等生成一套覆盖结算全流程的演示数据（名称一律「演示」前缀；机构为沙箱，金额非零但非真实资金）。
// clean：按 manifest 清单只删除本种子创建的行（子表在前），不触碰任何既有业务数据。
// 用法：node scripts/commerce/settlement-demo-seed.cjs seed|clean|status
const crypto=require('node:crypto');
const SEED_KEY='demo-settlement-v1';
const PWD='Demo#2026'; // 仅 sytest 演示环境登录用；权限仅在演示账号上，见 DEMO-DATA.md
const bj=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(v);
const day=n=>bj(new Date(Date.now()+n*86400000));
const P1=[day(-13),day(-7)],P2=[day(-6),day(0)];
const manifest=()=>({seed_key:SEED_KEY,at:new Date().toISOString(),periods:{p1:P1,p2:P2},accounts:{},vendors:{},entities:{},business:{batches:[],instructions:[],refunds:[],reversals:[],recoveries:[],compensations:[],recons:[],diffs:[],redemptions:[],orders:[],cases:[],gr_orders:[],jz_orders:[]}});
(async()=>{
 const mode=process.argv[2]||'status';
 const {createPool,initAuth}=require('../../commerce/db.cjs'),{migrate}=require('../../commerce/migrate.cjs'),{Service}=require('../../commerce/service.cjs'),settlement=require('../../commerce/settlement.cjs'),authCenter=require('../../auth_center.cjs');
 const parse=v=>typeof v==='string'?JSON.parse(v):v;
 const pool=createPool();
 try{
  await migrate(pool);
  const [existing]=await pool.execute("SELECT payload,created_at FROM commerce_events WHERE event_type='demo.settlement.initialized' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.seed_key'))=? ORDER BY id DESC LIMIT 1",[SEED_KEY]);
  if(mode==='status'){
   if(existing.length){const m=parse(existing[0].payload);console.log('seeded at',existing[0].created_at,'batches:',m.business.batches.length,'refunds:',m.business.refunds.length,'reversals:',m.business.reversals.length,'compensations:',m.business.compensations.length,'recons:',m.business.recons.length);}
   else console.log('not seeded');
   return;
  }
  if(mode==='clean'){
   if(!existing.length){console.log('nothing to clean');return;}
   const m=parse(existing[0].payload),b=m.business;
   const del=async(sql,args=[])=>{const [r]=await pool.execute(sql,args);return r.affectedRows;};
   let n=0;
   n+=await del("DELETE FROM commerce_recon_diffs WHERE id IN ("+b.diffs.map(()=>'?').join(',')+")",[...b.diffs.map(d=>d.id)]).catch(()=>0);
   n+=await del("DELETE FROM commerce_recon_batches WHERE id IN ("+b.recons.map(()=>'?').join(',')+")",[...b.recons.map(d=>d.id)]);
   for(const c of b.compensations){n+=await del("DELETE FROM commerce_ledger_entries WHERE source_type='compensation' AND source_id=?",[c.no]);n+=await del('DELETE FROM commerce_compensation_cases WHERE id=?',[c.id]);}
   for(const r of b.recoveries){n+=await del("DELETE FROM commerce_ledger_entries WHERE source_type='recovery' AND source_id IN (SELECT recovery_no FROM (SELECT recovery_no FROM commerce_recovery_cases WHERE id=?) x)",[r.id]);n+=await del('DELETE FROM commerce_recovery_cases WHERE id=?',[r.id]);}
   for(const r of b.reversals)n+=await del('DELETE FROM commerce_redemption_reversals WHERE id=?',[r.id]);
   for(const rf of b.refunds){
    const [rows]=await pool.execute('SELECT request_no,refund_no FROM commerce_refund_orders WHERE id=?',[rf.id]);
    for(const row of rows){n+=await del("DELETE FROM commerce_receipts WHERE request_no=?",[row.request_no]);n+=await del('DELETE FROM commerce_provider_requests WHERE request_no=?',[row.request_no]);n+=await del("DELETE FROM commerce_ledger_entries WHERE source_type='refund' AND source_id=?",[row.refund_no]);}
    n+=await del('DELETE FROM commerce_refund_orders WHERE id=?',[rf.id]);
   }
   for(const bi of b.batches){
    const [ins]=await pool.execute('SELECT id,instruction_no,request_no FROM commerce_payout_instructions WHERE batch_id=?',[bi.id]);
    for(const i of ins){n+=await del("DELETE FROM commerce_receipts WHERE request_no=?",[i.request_no]);n+=await del('DELETE FROM commerce_provider_requests WHERE request_no=?',[i.request_no]);n+=await del("DELETE FROM commerce_ledger_entries WHERE source_type='payout' AND source_id=?",[i.instruction_no]);n+=await del('DELETE FROM commerce_payout_instructions WHERE id=?',[i.id]);}
    n+=await del('DELETE FROM commerce_settlement_items WHERE batch_id=?',[bi.id]);
    n+=await del('DELETE FROM commerce_settlement_batches WHERE id=?',[bi.id]);
   }
   for(const rd of b.redemptions){n+=await del("DELETE FROM commerce_ledger_entries WHERE (source_type IN ('redemption','reversal','funding','recovery') AND (source_id=? OR memo LIKE CONCAT('%',?,'%'))) OR memo LIKE CONCAT('%',?,'%')",[rd.id,rd.id,rd.id]);}
   for(const rd of b.redemptions)n+=await del('DELETE FROM commerce_redemptions WHERE id=?',[rd.id]);
   for(const oid of b.orders){n+=await del("DELETE FROM commerce_ledger_entries WHERE source_type='funding' AND source_id=?",[oid]);n+=await del('DELETE FROM commerce_appointments WHERE coupon_id IN (SELECT id FROM commerce_coupons WHERE order_id=?)',[oid]);n+=await del('DELETE FROM commerce_coupons WHERE order_id=?',[oid]);n+=await del('DELETE FROM commerce_order_items WHERE order_id=?',[oid]);n+=await del('DELETE FROM gr_orders WHERE order_ref=?',[oid]);n+=await del('DELETE FROM commerce_orders WHERE id=?',[oid]);}
   for(const cid of b.cases){n+=await del('DELETE FROM jz_orders WHERE id=?',[cid]);n+=await del('DELETE FROM commerce_cases WHERE id=?',[cid]);}
   for(const [kind,ids] of Object.entries(m.entities)){for(const id of ids){n+=await del(`DELETE FROM commerce_versions WHERE kind='${kind}' AND entity_id=?`,[id]);n+=await del(`DELETE FROM commerce_${kind} WHERE id=?`,[id]);}}
   for(const v of Object.values(m.vendors))n+=await del('DELETE FROM jz_vendors WHERE id=?',[v]);
   for(const a of Object.values(m.accounts)){n+=await del('DELETE FROM commerce_audit WHERE actor_id=?',[a]);n+=await del('DELETE FROM account_roles WHERE account_id=?',[a]);n+=await del('DELETE FROM sessions WHERE account_id=?',[a]);n+=await del('DELETE FROM accounts WHERE id=?',[a]);}
   n+=await del("DELETE FROM commerce_events WHERE event_type='demo.settlement.initialized' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.seed_key'))=?",[SEED_KEY]);
   console.log('cleaned',n,'rows');
   return;
  }
  if(mode!=='seed'){console.log('usage: seed|clean|status');return;}
  if(existing.length){console.log('already seeded at',existing[0].created_at,'；先 clean 再 seed');return;}
  const auth=initAuth(pool),service=new Service(pool,auth);
  const m=manifest();
  const [[city]]=await pool.query("SELECT id,name FROM cities WHERE slug='guiyang'");
  if(!city)throw Error('贵阳城市不存在，请先跑 guiyang 种子');
  // ── 角色 ──
  const roles={'demo_fund_operator':['commerce.admin.read','commerce.admin.write','commerce.fund.read','commerce.fund.write'],'demo_fund_reviewer':['commerce.admin.read','commerce.admin.review','commerce.fund.read','commerce.fund.review'],'demo_settle_merchant':['commerce.merchant.read','commerce.merchant.write','commerce.merchant.redeem']};
  for(const [code,perms] of Object.entries(roles)){
   const [old]=await pool.execute('SELECT role_code FROM roles WHERE role_code=?',[code]);
   if(!old.length)await pool.execute('INSERT INTO roles(role_code,name,permissions,builtin) VALUES(?,?,?,0)',[code,code.replace('demo_','演示')+'（演示）',JSON.stringify(perms)]);
  }
  // ── 账号（按 display_name 幂等）──
  async function account(name,role,vendorId,withPwd){
   const [old]=await pool.execute("SELECT id FROM accounts WHERE display_name=? AND principal_type='user'",[name]);
   let id;
   if(old.length)id=old[0].id;
   else{
    const hash=await authCenter.hashPassword(PWD);
    const [r]=await pool.execute("INSERT INTO accounts(display_name,principal_type,status,vendor_id,password_hash) VALUES(?,'user','active',?,?)",[name,vendorId||null,hash]);
    id=r.insertId;
   }
   const [ar]=await pool.execute('SELECT role_code FROM account_roles WHERE account_id=? AND role_code=?',[id,role]);
   if(!ar.length)await pool.execute('INSERT INTO account_roles(account_id,role_code,scope) VALUES(?,?,?)',[id,role,JSON.stringify(vendorId?{level:'vendor',vendor_id:vendorId}:{level:'all'})]);
   m.accounts[name]=id;return {id};
  }
  const A=async i=>({type:'account',...(await authCenter.getAccountWithRoles(i))});
  // ── 商户（jz_vendors）──
  async function vendor(name){
   const [old]=await pool.execute('SELECT id FROM jz_vendors WHERE name=?',[name]);
   if(old.length){m.vendors[name]=old[0].id;return old[0].id;}
   const [r]=await pool.execute("INSERT INTO jz_vendors(type,name,status) VALUES('service',?,'active')",[name]);
   m.vendors[name]=r.insertId;return r.insertId;
  }
  const vendorA=await vendor('演示结算商户甲'),vendorB=await vendor('演示结算商户乙');
  const cashierA=await account('演示核销员甲','demo_settle_merchant',vendorA,true);
  const cashierB=await account('演示核销员乙','demo_settle_merchant',vendorB,true);
  const operator=(await account('演示·结算运营','demo_fund_operator',null,true)).id;
  const reviewer=(await account('演示·结算复核','demo_fund_reviewer',null,true)).id;
  const lin=(await account('演示客户·林女士','user',null,false)).id;
  const chen=(await account('演示客户·陈先生','user',null,false)).id;
  const promoter=(await account('演示推广员·沈晓','user',null,false)).id;
  const OPR=await A(operator),REV=await A(reviewer),USR=await A(lin),USR2=await A(chen),MER=await A(cashierA.id),MER2=await A(cashierB.id);
  // ── 演示范围预清理：上次中断/重跑残留（按演示账号关联，子表在前；不触碰任何非演示数据）──
  {
   const demoIds=Object.values(m.accounts);
   const idIn=arr=>arr.length?'('+arr.map(()=>'?').join(',')+')':'(NULL)';
   const [ords]=await pool.execute(`SELECT id FROM commerce_orders WHERE account_id IN ${idIn(demoIds)}`,demoIds);
   const orderIds=ords.map(o=>o.id);
   const [reds]=await pool.execute(`SELECT r.id FROM commerce_redemptions r JOIN commerce_coupons c ON c.id=r.coupon_id WHERE c.account_id IN ${idIn(demoIds)} OR c.order_id IN ${idIn(orderIds)}`,[...demoIds,...orderIds]);
   const redIds=reds.map(r=>r.id);
   const [rvs]=await pool.execute(`SELECT id,reversal_no FROM commerce_redemption_reversals WHERE redemption_id IN ${idIn(redIds)}`,redIds);
   const [rcs]=await pool.execute(`SELECT id,recovery_no FROM commerce_recovery_cases WHERE redemption_id IN ${idIn(redIds)}`,redIds);
   const [bis]=await pool.execute(`SELECT DISTINCT batch_id FROM commerce_settlement_items i JOIN commerce_redemptions r ON r.id=i.redemption_id WHERE i.redemption_id IN ${idIn(redIds)}`,redIds);
   const [dme]=await pool.execute("SELECT id FROM commerce_merchants WHERE name LIKE '演示%'");
   const [bs2]=await pool.execute(`SELECT id FROM commerce_settlement_batches WHERE merchant_id IN ${idIn(dme.map(x=>x.id))} OR promoter_account_id IN ${idIn(demoIds)} OR created_by IN ${idIn(demoIds)}`,[...dme.map(x=>x.id),...demoIds,...demoIds]);
   const batchIds=[...new Set([...bis.map(b=>b.batch_id),...bs2.map(b=>b.id)])];
   const [cps]=await pool.execute(`SELECT id,compensation_no FROM commerce_compensation_cases WHERE account_id IN ${idIn(demoIds)}`,demoIds);
   const [rfs]=await pool.execute(`SELECT id,refund_no,request_no FROM commerce_refund_orders WHERE order_id IN ${idIn(orderIds)}`,orderIds);
   const [rbs]=await pool.execute('SELECT id FROM commerce_recon_batches WHERE created_by=?',[operator]);
   const del=async(sql,args=[])=>{try{const [r]=await pool.execute(sql,args);return r.affectedRows;}catch{return 0;}};
   let n=0;
   for(const rb of rbs){n+=await del('DELETE FROM commerce_recon_diffs WHERE recon_id=?',[rb.id]);n+=await del('DELETE FROM commerce_recon_batches WHERE id=?',[rb.id]);}
   for(const cp of cps){n+=await del("DELETE FROM commerce_ledger_entries WHERE source_type='compensation' AND source_id=?",[cp.compensation_no]);n+=await del('DELETE FROM commerce_compensation_cases WHERE id=?',[cp.id]);}
   for(const rc of rcs){n+=await del("DELETE FROM commerce_ledger_entries WHERE source_type='recovery' AND source_id=?",[rc.recovery_no]);n+=await del('DELETE FROM commerce_recovery_cases WHERE id=?',[rc.id]);}
   for(const rv of rvs){n+=await del("DELETE FROM commerce_ledger_entries WHERE source_type='reversal' AND source_id=?",[rv.reversal_no]);n+=await del('DELETE FROM commerce_redemption_reversals WHERE id=?',[rv.id]);}
   for(const rf of rfs){n+=await del('DELETE FROM commerce_receipts WHERE request_no=?',[rf.request_no]);n+=await del('DELETE FROM commerce_provider_requests WHERE request_no=?',[rf.request_no]);n+=await del("DELETE FROM commerce_ledger_entries WHERE source_type='refund' AND source_id=?",[rf.refund_no]);n+=await del('DELETE FROM commerce_refund_orders WHERE id=?',[rf.id]);}
   for(const bi of batchIds){
    const [ins]=await pool.execute('SELECT id,instruction_no,request_no FROM commerce_payout_instructions WHERE batch_id=?',[bi]);
    for(const i of ins){n+=await del('DELETE FROM commerce_receipts WHERE request_no=?',[i.request_no]);n+=await del('DELETE FROM commerce_provider_requests WHERE request_no=?',[i.request_no]);n+=await del("DELETE FROM commerce_ledger_entries WHERE source_type='payout' AND source_id=?",[i.instruction_no]);n+=await del('DELETE FROM commerce_payout_instructions WHERE id=?',[i.id]);}
    n+=await del('DELETE FROM commerce_settlement_items WHERE batch_id=?',[bi]);
    n+=await del('DELETE FROM commerce_settlement_batches WHERE id=?',[bi]);
   }
   for(const rd of redIds){n+=await del("DELETE FROM commerce_ledger_entries WHERE source_type='redemption' AND source_id=?",[rd]);}
   for(const oid of orderIds){n+=await del("DELETE FROM commerce_ledger_entries WHERE source_type='funding' AND source_id=?",[oid]);n+=await del('DELETE FROM commerce_appointments WHERE coupon_id IN (SELECT id FROM commerce_coupons WHERE order_id=?)',[oid]);n+=await del('DELETE FROM commerce_coupons WHERE order_id=?',[oid]);n+=await del('DELETE FROM commerce_order_items WHERE order_id=?',[oid]);n+=await del('DELETE FROM gr_orders WHERE order_ref=?',[oid]);n+=await del('DELETE FROM commerce_orders WHERE id=?',[oid]);}
   for(const rd of redIds)n+=await del('DELETE FROM commerce_redemptions WHERE id=?',[rd]);
   const [dcs]=await pool.execute(`SELECT id FROM commerce_cases WHERE account_id IN ${idIn(demoIds)}`,demoIds);
   for(const dc of dcs){n+=await del('DELETE FROM jz_orders WHERE id=?',[dc.id]);n+=await del('DELETE FROM commerce_cases WHERE id=?',[dc.id]);}
   n+=await del(`DELETE FROM commerce_idempotency WHERE actor_id IN ${idIn(demoIds)}`,demoIds);
   console.error('[seed] preclean',n,'stale rows');
  }
  const W='commerce.admin.write',R='commerce.admin.review',FW='commerce.fund.write',FR='commerce.fund.review';
  // ── 配置实体（直接发布，created_by 0，guiyang 演示惯例）──
  async function entity(kind,payload,scope){
   const [old]=await pool.execute("SELECT payload FROM commerce_events WHERE event_type='demo.settlement.entity' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.seed_key'))=?",[SEED_KEY+':'+payload.name]);
   if(old.length){const receipt=parse(old[0].payload);const [[e]]=await pool.execute(`SELECT * FROM commerce_${kind} WHERE id=?`,[receipt.entity_id]);m.entities[kind]=m.entities[kind]||[];m.entities[kind].push(receipt.entity_id);return {...e,payload:parse(e.payload)};}
   const [r]=await pool.execute(`INSERT INTO commerce_${kind}(name,city_id,vendor_id,merchant_id,store_id,payload,created_by,status,published_version,review_note) VALUES(?,?,?,?,?,?,0,'published',1,?)`,
    [payload.name,scope.city_id??city.id,scope.vendor_id||null,scope.merchant_id||null,scope.store_id||null,JSON.stringify(payload),'演示初始化；非真实商务审核；机构为沙箱，不代表真实资金']);
   if(kind==='merchants')await pool.execute('UPDATE commerce_merchants SET merchant_id=id WHERE id=?',[r.insertId]);
   if(kind==='skus')await pool.execute('INSERT INTO commerce_inventory(sku_id,total) VALUES(?,999)',[r.insertId]);
   await pool.execute('INSERT INTO commerce_versions(kind,entity_id,version,snapshot,reviewed_by) VALUES(?,?,1,?,0)',[kind,r.insertId,JSON.stringify(payload)]);
   await pool.execute("INSERT INTO commerce_events(aggregate_id,event_type,payload) VALUES(?,'demo.settlement.entity',?)",[String(r.insertId),JSON.stringify({seed_key:SEED_KEY+':'+payload.name,entity_id:r.insertId})]);
   m.entities[kind]=m.entities[kind]||[];m.entities[kind].push(r.insertId);
   return {id:r.insertId,payload,city_id:scope.city_id??city.id,version:1};
  }
  // 演示账号的残留半截数据清理（seed 可重入）：上次中断留下的订单/券/幂等键
  {
   const [demoAccounts]=await pool.execute("SELECT id FROM accounts WHERE display_name LIKE '演示%' OR display_name LIKE 'load%'");
   for(const a of demoAccounts){
    const [ords]=await pool.execute('SELECT id FROM commerce_orders WHERE account_id=?',[a.id]);
    for(const o of ords){
     await pool.execute('DELETE FROM commerce_coupons WHERE order_id=?',[o.id]);
     await pool.execute('DELETE FROM commerce_order_items WHERE order_id=?',[o.id]);
     await pool.execute('DELETE FROM gr_orders WHERE order_ref=?',[o.id]);
     await pool.execute('DELETE FROM commerce_orders WHERE id=?',[o.id]);
    }
    await pool.execute('DELETE FROM commerce_idempotency WHERE actor_id=?',[a.id]);
   }
  }
  const merchantA=await entity('merchants',{name:'演示结算商户甲',vendor_id:vendorA,city_id:city.id,contract_ref:'DEMO-SETTLE-A',contact:'演示联系人',phone:'00000000000',description:'结算演示商户（沙箱口径，不代表真实资金）'},{vendor_id:vendorA});
  const merchantB=await entity('merchants',{name:'演示结算商户乙',vendor_id:vendorB,city_id:city.id,contract_ref:'DEMO-SETTLE-B',contact:'演示联系人',phone:'00000000000',description:'结算演示商户（沙箱口径，不代表真实资金）'},{vendor_id:vendorB});
  const storeA=await entity('stores',{name:'演示服务门店甲',merchant_id:merchantA.id,city_id:city.id,address:'演示路1号',phone:'00000000000',capacity:50,lead_hours:0,description:'每日服务（演示）'},{vendor_id:vendorA,merchant_id:merchantA.id});
  const storeB=await entity('stores',{name:'演示服务门店乙',merchant_id:merchantB.id,city_id:city.id,address:'演示路2号',phone:'00000000000',capacity:50,lead_hours:0,description:'每日服务（演示）'},{vendor_id:vendorB,merchant_id:merchantB.id});
  await entity('staff',{name:'演示核销员甲',merchant_id:merchantA.id,store_id:storeA.id,account_id:cashierA.id},{vendor_id:vendorA,merchant_id:merchantA.id,store_id:storeA.id});
  await entity('staff',{name:'演示核销员乙',merchant_id:merchantB.id,store_id:storeB.id,account_id:cashierB.id},{vendor_id:vendorB,merchant_id:merchantB.id,store_id:storeB.id});
  const skuA=await entity('skus',{name:'演示家政保洁服务',merchant_id:merchantA.id,store_id:storeA.id,supply_minor:3000,retail_minor:10000,valid_days:30,description:'全屋基础保洁一次（演示）',conditions:'提前预约，超出范围另行约定'},{vendor_id:vendorA,merchant_id:merchantA.id,store_id:storeA.id});
  const skuB=await entity('skus',{name:'演示家电检修服务',merchant_id:merchantB.id,store_id:storeB.id,supply_minor:3000,retail_minor:10000,valid_days:30,description:'基础检修一次（演示）',conditions:'提前预约，配件另计'},{vendor_id:vendorB,merchant_id:merchantB.id,store_id:storeB.id});
  const ruleA=await entity('rules',{name:'演示分配规则甲',merchant_id:merchantA.id,beike_bps:2000,channel_bps:5000,floor_bps:1000,description:'演示口径：贝壳 20%，渠道占贝壳佣金 50%'},{vendor_id:vendorA,merchant_id:merchantA.id});
  const ruleB=await entity('rules',{name:'演示分配规则乙',merchant_id:merchantB.id,beike_bps:2000,channel_bps:5000,floor_bps:1000,description:'演示口径：贝壳 20%，渠道占贝壳佣金 50%'},{vendor_id:vendorB,merchant_id:merchantB.id});
  // 券包快照富化：与正式发布同路径（references 补 items[].sku/rule 与版本号）
  const {validate}=require('../../commerce/configuration.cjs');
  async function entityPackage(payload){
   const valid=validate('packages',payload);
   await service.references(pool,'packages',valid,OPR,W,false);
   const created=await entity('packages',valid,{vendor_id:valid.items[0].sku.merchant_id===merchantB.id?vendorB:vendorA,merchant_id:valid.items[0].sku.merchant_id});
   // 命中旧种子数据时回填富化快照（正式发布路径的 items[].sku/rule 形状）
   const [[cur]]=await pool.execute('SELECT payload FROM commerce_packages WHERE id=?',[created.id]);
   const curPayload=typeof cur.payload==='string'?JSON.parse(cur.payload):cur.payload;
   if(!curPayload.items[0].sku){
    await pool.execute('UPDATE commerce_packages SET payload=? WHERE id=?',[JSON.stringify(valid),created.id]);
    await pool.execute("UPDATE commerce_versions SET snapshot=? WHERE kind='packages' AND entity_id=? AND version=1",[JSON.stringify(valid),created.id]);
   }
   return {...created,payload:valid};
  }
  const pkgA=await entityPackage({name:'演示居家服务券包',city_id:city.id,price_minor:10000,description:'演示券包：一张保洁服务券',items:[{sku_id:skuA.id,rule_id:ruleA.id,quantity:1,allocation_minor:10000}]});
  const pkgA2=await entityPackage({name:'演示安居双券包',city_id:city.id,price_minor:10000,description:'演示券包：两张保洁服务券',items:[{sku_id:skuA.id,rule_id:ruleA.id,quantity:2,allocation_minor:5000}]});
  const pkgB=await entityPackage({name:'演示安心检修券包',city_id:city.id,price_minor:10000,description:'演示券包：一张检修服务券',items:[{sku_id:skuB.id,rule_id:ruleB.id,quantity:1,allocation_minor:10000}]});
  // ── 业务流工具 ──
  async function buy(user,usr,pkg,key,attributed){
   const referral=attributed?await (async()=>{const payload=Buffer.from(JSON.stringify({aid:promoter,kind:'packages',id:pkg.id,v:1,exp:Math.floor(Date.now()/1000)+86400})).toString('base64url');const secret=process.env.JUZHU_API_KEY||process.env.JUZHU_ADMIN_PASSWORD;return payload+'.'+crypto.createHmac('sha256',secret).update('commerce-share:'+payload).digest('base64url');})():null;
   const order=await service.reserveOrder(usr,{kind:'packages',product_id:pkg.id,...(referral?{referral}:{})},'demoseed-'+key);
   await service.fulfillPaidOrder(order.id,'demo-settle-'+key,10000);
   m.business.orders.push(order.id);
   return (await service.my(usr)).coupons.filter(c=>c.order_id===order.id);
  }
  async function redeem(usr,coupon,key,mer){
   await service.appointment(usr,{coupon_id:coupon.id,service_date:day(1)},'demoseed-appt-'+key);
   await pool.execute("UPDATE commerce_appointments SET service_date=? WHERE coupon_id=? AND status='booked'",[day(0),coupon.id]);
   const t=await service.token(usr,coupon.id);
   const r=await service.redeem(mer,'commerce.merchant.redeem',{coupon_id:coupon.id,token:t.token},'demoseed-redeem-'+key);
   m.business.redemptions.push(r.id);
   return r;
  }
  async function backdate(redemptionId,days){await pool.execute('UPDATE commerce_redemptions SET created_at=UTC_TIMESTAMP()-INTERVAL ? DAY WHERE id=?',[days,redemptionId]);}
  async function settle(kind,start,end){
   const gen=await settlement.generateBatches(service,OPR,{kind,period_start:start,period_end:end},'demoseed-gen-'+kind+'-'+start+'-'+end);
   for(const b of gen.batches)m.business.batches.push({id:b.batch_id,no:b.batch_no,kind});
   return gen;
  }
  async function lifecycle(batchId,executeInput){await settlement.batchAction(service,OPR,FW,batchId,{},'submit');await settlement.batchAction(service,REV,FR,batchId,{action:'approve',note:'演示：账单复核通过'},'review');return settlement.batchAction(service,OPR,FW,batchId,executeInput||{},'execute');}
  async function pay(batchId){
   const view=await service.tx(c=>settlement.batchView(c,batchId));
   if(!view.instructions.length)throw new Error('pay: 批次 '+view.batch_no+'('+view.kind+'/'+view.status+') 无指令，payable='+view.payable_minor+' items='+view.items.length);
   for(const i of view.instructions)await settlement.ingestReceipt(service,OPR,{request_no:i.request_no,outcome:'paid',payload:{demo:'settlement-seed'}});
  }
  // ── 场景 ──
  // P1（已关账周期）：甲 2 单（1 无归属 + 1 推广归属）→ 商户批与渠道批均执行已付；乙 1 单已付
  const step=t=>console.error('[seed]',t);
  step('buy a1');
  let c=await buy(lin,USR,pkgA,'a1');await backdate((await redeem(USR,c[0],'a1',MER)).id,10);
  step('buy a2');
  c=await buy(chen,USR2,pkgA,'a2',true);await backdate((await redeem(USR2,c[0],'a2',MER)).id,9);
  let gen=await settle('both',P1[0],P1[1]);
  for(const b of gen.batches.filter(x=>(x.kind==='merchant'&&x.payee_id===merchantA.id)||x.kind==='promoter')){await lifecycle(b.batch_id);await pay(b.batch_id);}
  c=await buy(lin,USR,pkgB,'b1');await backdate((await redeem(USR,c[0],'b1',MER2)).id,9);
  step('settle p1 merchantB');
  gen=await settle('merchant',P1[0],P1[1]);
  for(const b of gen.batches){await lifecycle(b.batch_id);await pay(b.batch_id);}
  // P2（上一周期）：甲 1 批已复核待执行；乙 1 批执行后 UNKNOWN（演示查单）；渠道批草稿
  step('buy a3 p2');
  c=await buy(lin,USR,pkgA2,'a3');await backdate((await redeem(USR,c[0],'a3',MER)).id,3);
  gen=await settle('merchant',P2[0],P2[1]);
  const p2A=gen.batches.find(b=>b.payee_id===merchantA.id);
  await settlement.batchAction(service,OPR,FW,p2A.batch_id,{},'submit');
  await settlement.batchAction(service,REV,FR,p2A.batch_id,{action:'approve',note:'演示：复核通过，待执行'},'review');
  step('buy b2 p2');
  c=await buy(chen,USR2,pkgB,'b2',true);const b2red=await redeem(USR2,c[0],'b2',MER2);await backdate(b2red.id,3);
  gen=await settle('both',P2[0],P2[1]);
  const p2B=gen.batches.find(b=>b.kind==='merchant');
  const viewB=await lifecycle(p2B.batch_id);
  await service.tx(x=>settlement.sandboxSimulate(x,viewB.instructions[0].request_no,'unknown'));
  await settlement.ingestReceipt(service,OPR,{request_no:viewB.instructions[0].request_no,outcome:'unknown'}).catch(()=>{});
  // 退款：1 笔未用退款已付 + 1 笔到期/未用退款处理中
  step('refund a4');
  c=await buy(lin,USR,pkgA,'a4');
  const refundCase=await service.openCase(USR,{coupon_id:c[0].id,kind:'refund',reason:'演示：未使用退款申请'},'demoseed-case-a4');
  await service.resolveCase(OPR,W,refundCase.id,{action:'accept',resolution:'演示：受理并进入退款通道'});
  const refund1=await settlement.createRefundOrder(service,OPR,{case_id:refundCase.id},'demoseed-refund-a4');
  const ex=await settlement.refundAction(service,OPR,refund1.id,'execute',{});
  await settlement.ingestReceipt(service,OPR,{request_no:ex.request_no,outcome:'paid'});
  m.business.refunds.push({id:refund1.id});
  step('refund b3');
  c=await buy(chen,USR2,pkgB,'b3');
  const refundCase2=await service.openCase(USR2,{coupon_id:c[0].id,kind:'refund',reason:'演示：未使用退款申请（处理中）'},'demoseed-case-b3');
  await service.resolveCase(OPR,W,refundCase2.id,{action:'accept',resolution:'演示：受理，待退款执行'});
  const refund2=await settlement.createRefundOrder(service,OPR,{case_id:refundCase2.id},'demoseed-refund-b3');
  await settlement.refundAction(service,OPR,refund2.id,'execute',{});
  m.business.refunds.push({id:refund2.id});
  // 误核销撤销：撤销 P1 甲已付核销 → 商户/渠道追偿 open
  step('reversal');
  const targetRed=m.business.redemptions[1]; // P1 甲归属单：商户批与渠道批均已付，撤销产生双追偿
  const reversal=await settlement.requestReversal(service,OPR,{redemption_id:targetRed,reason:'演示：误核销撤销（服务未实际履约）'},'demoseed-reversal-01');
  await settlement.reviewReversal(service,REV,reversal.id,{action:'approve',note:'演示：确认误核销，同意撤销'});
  m.business.reversals.push({id:reversal.id});
  const [recs]=(await pool.execute("SELECT id FROM commerce_recovery_cases WHERE redemption_id=? ORDER BY id",[targetRed]));
  for(const r of recs)m.business.recoveries.push({id:r.id});
  // 赔付：甲券服务失败 → 受理 → 建单 → 复核赔付（应收代偿）
  step('compensation');
  c=await buy(lin,USR,pkgA,'a5');
  const t5=await (async()=>{await service.appointment(USR,{coupon_id:c[0].id,service_date:day(1)},'demoseed-appt-a5');await pool.execute("UPDATE commerce_appointments SET service_date=? WHERE coupon_id=? AND status='booked'",[day(0),c[0].id]);return service.token(USR,c[0].id);})();
  const red5=await service.redeem(MER,'commerce.merchant.redeem',{coupon_id:c[0].id,token:t5.token},'demoseed-redeem-a5');
  m.business.redemptions.push(red5.id);
  const compCase=await service.openCase(USR,{coupon_id:c[0].id,kind:'compensation',reason:'演示：服务失败申请赔付'},'demoseed-case-comp');
  await service.resolveCase(OPR,W,compCase.id,{action:'accept',resolution:'演示：核实服务失败，进入赔付处理'});
  const comp=await settlement.createCompensation(service,OPR,{case_id:compCase.id},'demoseed-comp-01');
  const compPaid=await settlement.reviewCompensation(service,REV,comp.id,{action:'approve',note:'演示：核实属实，同意先行赔付'});
  m.business.compensations.push({id:comp.id,no:comp.compensation_no});
  const [compRec]=(await pool.execute("SELECT id FROM commerce_recovery_cases WHERE reason LIKE ?",['%'+comp.compensation_no+'%']))[0];
  if(compRec)m.business.recoveries.push({id:compRec});
  // 对账：P1 对平 + 1 条已关闭演练差异 + 1 条待处理差异（标注演练注入）
  step('recon');
  const recon=await settlement.runReconciliation(service,OPR,{period_start:day(-40),period_end:day(0)},'demoseed-recon-1');
  m.business.recons.push({id:recon.recon_id});
  const [d1]=await pool.execute(`INSERT INTO commerce_recon_diffs(recon_id,diff_no,biz_type,biz_id,kind,expected_minor,actual_minor,detail,owner_id,status,resolution,closed_by,closed_reason,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`,
   [recon.recon_id,'DF-demoseed-0001','payout','1','status_mismatch',8000,8000,'演示：机构回执迟到造成的时点差异，已核实恢复一致',operator,'closed','演示：核实为回执时点差，机构已确认',reviewer,'演示：差异核实完毕，关闭依据充分'])&&[{}];
  m.business.diffs.push({id:d1.insertId});
  const [d2]=await pool.execute("INSERT INTO commerce_recon_diffs(recon_id,diff_no,biz_type,biz_id,kind,expected_minor,actual_minor,detail) VALUES(?,?,?,?,?,?,?,?)",
   [recon.recon_id,'DF-demoseed-0002','payout','2','missing_external',10000,null,'演示：机构账单缺失待核实（对账差异处理演示）']);
  await pool.execute("UPDATE commerce_recon_diffs SET owner_id=?,status='processing' WHERE id=?",[operator,d2.insertId]);
  m.business.diffs.push({id:d2.insertId});
  // 完成标记
  await pool.execute("INSERT INTO commerce_events(aggregate_id,event_type,payload) VALUES(?,'demo.settlement.initialized',?)",['demo-settlement',JSON.stringify(m)]);
  console.log('seeded：批次 '+m.business.batches.length+'，退款单 '+m.business.refunds.length+'，撤销 '+m.business.reversals.length+'，追偿 '+m.business.recoveries.length+'，赔付 '+m.business.compensations.length+'，对账 '+m.business.recons.length+'（差异 '+m.business.diffs.length+'）');
  console.log('演示账号密码：'+PWD+'（仅 sytest 演示环境；演示·结算运营 / 演示核销员甲乙 可登录）');
 }finally{await pool.end();}
})().catch(e=>{console.error('ERR',e.message,e.code||'');console.error((e.stack||'').split('\n').slice(1,5).join('\n'));process.exitCode=1;});
