'use strict';
const crypto=require('node:crypto');
const {definitions,kinds,Fault,assert,validate}=require('./configuration.cjs');
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const id=()=>crypto.randomUUID();
const digest=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const date=v=>new Date(v).toISOString().slice(0,19).replace('T',' ');
const row=v=>v&&({...v,...(v.payload?{payload:parse(v.payload)}:{}),...(v.snapshot?{snapshot:parse(v.snapshot)}:{})});
const collection=['orders','coupons','memberships','appointments','redemptions','cases','audit','inventory','capacity'];
class Service {
 constructor(pool,auth){this.pool=pool;this.auth=auth;}
 async tx(fn,depth=0){const c=await this.pool.getConnection();try{await c.beginTransaction();const result=await fn(c);await c.commit();c.release();return result;}catch(e){try{await c.rollback();}catch(_){}c.release();
  // 死锁/锁等待是并发调度冲突：事务体均为整事务回滚的纯 DB 序列，可安全重试（M1-A4 性能验收发现并修复）。
  if((e.code==='ER_LOCK_DEADLOCK'||e.code==='ER_LOCK_WAIT_TIMEOUT')&&depth<3)return this.tx(fn,depth+1);
  throw e;}}
 async get(c,sql,args=[]){return (await c.execute(sql,args))[0];}
 async audit(c,p,action,resource,detail={},scope={}){await c.execute('INSERT INTO commerce_audit(actor_id,city_id,merchant_id,action,resource,detail) VALUES(?,?,?,?,?,?)',[p.account.id,scope.city_id||null,scope.merchant_id||null,action,String(resource),JSON.stringify(detail)]);}
 scope(p,perm){const roles=p.roles.filter(r=>(r.permissions||[]).some(v=>v==='*'||v===perm));assert(roles.length,'没有该操作权限',403);return this.auth.scopeOf({...p,roles});}
 filter(p,perm,alias='e',merchantOnly=false){const s=this.scope(p,perm),pre=alias?alias+'.':'';
  if(merchantOnly){assert(s.vendorId,'账号未绑定商户，请联系账号管理员',403);return {sql:`${pre}merchant_id IN (SELECT id FROM commerce_merchants WHERE vendor_id=?)`,args:[s.vendorId]};}
  if(s.level==='all') return {sql:'1=1',args:[]};
  if(s.level==='city'&&s.cityIds.length)return {sql:`${pre}city_id IN (${s.cityIds.map(()=>'?').join(',')})`,args:s.cityIds};
  if(s.level==='org'&&s.orgId)return {sql:`${pre}merchant_id IN (SELECT m.id FROM commerce_merchants m JOIN jz_vendors v ON v.id=m.vendor_id WHERE v.org_id=?)`,args:[s.orgId]};
  if(s.level==='vendor'&&s.vendorId)return {sql:`${pre}merchant_id IN (SELECT id FROM commerce_merchants WHERE vendor_id=?)`,args:[s.vendorId]};
  return {sql:'1=0',args:[]};
 }
 async allowed(c,p,perm,resource,merchantOnly=false){const s=this.scope(p,perm);
  if(merchantOnly||s.level==='vendor'){assert(s.vendorId,'账号未绑定商户',403);let vendor=resource.vendor_id;
   if(!vendor&&resource.merchant_id){const m=await this.get(c,'SELECT vendor_id FROM commerce_merchants WHERE id=?',[resource.merchant_id]);vendor=m[0]?.vendor_id;}
   assert(Number(vendor)===s.vendorId,'不允许访问其他商户的数据',403);return;}
  if(s.level==='org'&&s.orgId){const vendors=await this.get(c,'SELECT v.org_id FROM commerce_merchants m JOIN jz_vendors v ON v.id=m.vendor_id WHERE m.id=?',[resource.merchant_id||-1]);assert(vendors[0]?.org_id===s.orgId,'数据不在授权机构内',403);return;}
  assert(s.level==='all'||(s.level==='city'&&s.cityIds.includes(Number(resource.city_id))),'数据不在授权范围内',403);
 }
 async entity(c,kind,key,lock=false){assert(kinds.includes(kind),'资源不存在',404);const rows=await this.get(c,`SELECT * FROM commerce_${kind} WHERE id=?${lock?' FOR UPDATE':''}`,[key]);assert(rows.length,'记录不存在',404);return row(rows[0]);}
 async approved(c,kind,key){const e=await this.entity(c,kind,key);assert(e.published_version&&e.status!=='archived',`${definitions[kind].label}尚未发布或已停用`);const versions=await this.get(c,'SELECT snapshot FROM commerce_versions WHERE kind=? AND entity_id=? AND version=?',[kind,key,e.published_version]);assert(versions.length,'发布版本缺失',409);return {...e,payload:parse(versions[0].snapshot),version:e.published_version};}
 async references(c,kind,payload,p,perm,merchantOnly){
  const scope={city_id:payload.city_id||null,merchant_id:payload.merchant_id||null,store_id:payload.store_id||null,vendor_id:payload.vendor_id||null};
  if(kind==='merchants'){const v=await this.get(c,'SELECT id FROM jz_vendors WHERE id=?',[payload.vendor_id]);assert(v.length,'账号中心商家ID不存在');const city=await this.get(c,'SELECT id FROM cities WHERE id=?',[payload.city_id]);assert(city.length,'城市ID不存在');}
  if(payload.merchant_id){const merchant=await this.approved(c,'merchants',payload.merchant_id);scope.city_id=merchant.city_id;scope.vendor_id=merchant.vendor_id;}
  if(payload.store_id){const store=await this.approved(c,'stores',payload.store_id);assert(store.merchant_id===payload.merchant_id,'门店不属于选定商户');scope.city_id=store.city_id;}
  if(kind==='stores')assert(payload.city_id===scope.city_id,'门店城市必须与商户经营城市一致');
  if(kind==='staff'){const a=await this.get(c,'SELECT id,vendor_id,principal_type,status FROM accounts WHERE id=?',[payload.account_id]);assert(a.length&&a[0].principal_type==='user'&&a[0].status==='active'&&a[0].vendor_id===scope.vendor_id,'核销人员必须为本商户有效个人账号');}
  if(kind==='packages'){
   for(const item of payload.items){const sku=await this.approved(c,'skus',item.sku_id),rule=await this.approved(c,'rules',item.rule_id);assert(sku.city_id===payload.city_id&&rule.merchant_id===sku.merchant_id,'券商品城市或分配规则商户不匹配');assert(item.allocation_minor>=sku.payload.supply_minor,'逐券分摊金额不得低于供货价');assert(item.allocation_minor-sku.payload.supply_minor>=Math.floor(item.allocation_minor*rule.payload.floor_bps/10000),'逐券佣金低于规则底线');assert(item.allocation_minor-sku.payload.supply_minor>=Math.floor(item.allocation_minor*rule.payload.beike_bps/10000),'分配金额不足以覆盖规则佣金');item.sku_version=sku.version;item.rule_version=rule.version;item.sku=sku.payload;item.rule=rule.payload;}
  }
  if(kind==='plans'){const pkg=await this.approved(c,'packages',payload.package_id);assert(pkg.city_id===payload.city_id,'会员与券包城市不一致');assert(payload.price_minor===pkg.payload.price_minor,'本阶段会员售价必须等于赠送券包分摊合计');payload.package_version=pkg.version;payload.package=pkg.payload;}
  await this.allowed(c,p,perm,scope,merchantOnly);return scope;
 }
 async lookups(p,perm,kind,merchantOnly=false){
  assert(['cities','vendors','accounts'].includes(kind),'选项类型不存在',404);const scope=this.scope(p,perm);
  if(kind==='cities'){
   if(merchantOnly||scope.level==='vendor'){return this.get(this.pool,'SELECT DISTINCT c.id,c.name FROM cities c JOIN commerce_merchants m ON m.city_id=c.id WHERE m.vendor_id=? ORDER BY c.name',[scope.vendorId||-1]);}
   if(scope.level==='all')return this.get(this.pool,'SELECT id,name FROM cities ORDER BY name');
   if(scope.level==='city'&&scope.cityIds.length)return this.get(this.pool,'SELECT id,name FROM cities WHERE id IN ('+scope.cityIds.map(()=>'?').join(',')+') ORDER BY name',scope.cityIds);
   return [];
  }
  let where='1=0',args=[];
  if(merchantOnly||scope.level==='vendor'){where='v.id=?';args=[scope.vendorId||-1];}
  else if(scope.level==='all')where='1=1';
  else if(scope.level==='org'){where='v.org_id=?';args=[scope.orgId||-1];}
  else if(scope.level==='city'&&scope.cityIds.length){where='EXISTS (SELECT 1 FROM commerce_merchants m WHERE m.vendor_id=v.id AND m.city_id IN ('+scope.cityIds.map(()=>'?').join(',')+'))';args=scope.cityIds;}
  if(kind==='vendors')return this.get(this.pool,'SELECT v.id,v.name FROM jz_vendors v WHERE '+where+" AND v.status='active' ORDER BY v.name LIMIT 1000",args);
  return this.get(this.pool,"SELECT a.id,a.display_name AS name,a.vendor_id FROM accounts a JOIN jz_vendors v ON v.id=a.vendor_id WHERE "+where+" AND a.status='active' AND a.principal_type='user' ORDER BY a.id LIMIT 1000",args);
 }

 async list(p,perm,kind,query,merchantOnly=false){assert(kinds.includes(kind)||collection.includes(kind),'资源不存在',404);
  if(merchantOnly&&kinds.includes(kind))assert(definitions[kind].merchant,'商户不能访问平台配置',403);
  let table=`commerce_${kind}`,extra='',alias='e',f=this.filter(p,perm,alias,merchantOnly);
  if(kind==='merchants'&&(merchantOnly||this.scope(p,perm).level==='vendor'))f={sql:'e.vendor_id=?',args:[this.scope(p,perm).vendorId||-1]};
  if(kind==='inventory'){extra=' JOIN commerce_skus s ON s.id=e.sku_id';f=this.filter(p,perm,'s',merchantOnly);}
  if(kind==='capacity'){extra=' JOIN commerce_stores s ON s.id=e.store_id';f=this.filter(p,perm,'s',merchantOnly);}
  if(kind==='memberships'){assert(!merchantOnly,'商户不可访问会员信息',403);extra=' JOIN commerce_orders o ON o.id=e.order_id';f=this.filter(p,perm,'o');}
  if(kind==='orders'&&merchantOnly) {const s=this.scope(p,perm);f={sql:'EXISTS (SELECT 1 FROM commerce_order_items oi JOIN commerce_merchants m ON m.id=oi.merchant_id WHERE oi.order_id=e.id AND m.vendor_id=?)',args:[s.vendorId||-1]};}
  const page=Math.max(1,Math.min(10000,Number(query.page)||1)),size=20;let where=f.sql;const args=[...f.args];
  if(query.status&&kind!=='audit'&&kind!=='inventory'&&kind!=='capacity'&&kind!=='memberships'){where+=' AND e.status=?';args.push(query.status);}
  if(kind==='appointments'&&/^\d{4}-\d{2}-\d{2}$/.test(query.date||'')){where+=' AND e.service_date=?';args.push(query.date);}
  if(query.q&&kinds.includes(kind)){where+=' AND e.name LIKE ?';args.push('%'+String(query.q).slice(0,100)+'%');}
  const [count]=await this.get(this.pool,`SELECT COUNT(*) AS total FROM ${table} e${extra} WHERE ${where}`,args);
  const order=kind==='inventory'?'e.sku_id':kind==='capacity'?'e.service_date':kind==='memberships'?'e.order_id':'e.id';
  let rows=(await this.get(this.pool,`SELECT e.* FROM ${table} e${extra} WHERE ${where} ORDER BY ${order} DESC LIMIT ${size} OFFSET ${(page-1)*size}`,args)).map(row);
  if(kind==='coupons')rows=rows.map(r=>{delete r.token_hash;delete r.token_expires_at;return r;});
  if(merchantOnly){rows=rows.map(r=>{delete r.beike_minor;delete r.channel_minor;delete r.retained_minor;if(r.snapshot){r.name=r.snapshot.sku?.name||r.snapshot.name;delete r.snapshot;}return r;});}
  if(merchantOnly&&kind==='orders')rows=await Promise.all(rows.map(async o=>({id:o.id,status:o.status,created_at:o.created_at,items:(await this.get(this.pool,'SELECT oi.sku_id,oi.quantity,oi.allocation_minor FROM commerce_order_items oi JOIN commerce_merchants m ON m.id=oi.merchant_id WHERE oi.order_id=? AND m.vendor_id=?',[o.id,this.scope(p,perm).vendorId]))})));
  if(merchantOnly&&kind==='appointments')rows=await this.hydrateAppointments(rows);
  return {rows,total:count.total,page,size};
 }
 // Merchant view: show the purchased service and the customer behind each appointment.
 async hydrateAppointments(rows){
  const couponIds=[...new Set(rows.map(r=>r.coupon_id).filter(Boolean))],accountIds=[...new Set(rows.map(r=>r.account_id).filter(Boolean))];
  const names=new Map(),people=new Map();
  if(couponIds.length)for(const c of await this.get(this.pool,"SELECT id,JSON_UNQUOTE(JSON_EXTRACT(snapshot,'$.sku.name')) name FROM commerce_coupons WHERE id IN ("+couponIds.map(()=>'?').join(',')+')',couponIds))names.set(c.id,c.name);
  if(accountIds.length)for(const a of await this.get(this.pool,'SELECT id,display_name FROM accounts WHERE id IN ('+accountIds.map(()=>'?').join(',')+')',accountIds))people.set(a.id,a.display_name);
  return rows.map(r=>({...r,service_name:names.get(r.coupon_id)||'生活权益',customer_name:people.get(r.account_id)||'演示客户'}));
 }
 async save(p,perm,kind,key,input,merchantOnly=false){assert(!merchantOnly||definitions[kind]?.merchant,'不允许修改平台配置',403);const payload=validate(kind,input.payload||{});
  return this.tx(async c=>{let old;if(key){old=await this.entity(c,kind,key,true);await this.allowed(c,p,perm,old,merchantOnly);assert(old.version===input.version,'记录已更新，请刷新后重试',409);assert(!['submitted','approved'].includes(old.status),'审核中的记录不能编辑',409);}
   const scope=await this.references(c,kind,payload,p,perm,merchantOnly);
   if(old){const canBindMissing=old.created_by===0&&!old.published_version&&Boolean(old.payload.initialization);const same=(a,b)=>a===b||(canBindMissing&&a===null);assert(same(old.vendor_id,scope.vendor_id)&&(kind==='merchants'||same(old.merchant_id,scope.merchant_id))&&same(old.store_id,scope.store_id)&&old.city_id===scope.city_id,'已建记录不能变更所属商户、门店或城市');if(old.payload.initialization)payload.initialization=old.payload.initialization;}
   const version=old?old.version+1:1;
   if(key)await c.execute(`UPDATE commerce_${kind} SET name=?,payload=?,version=?,vendor_id=?,merchant_id=?,store_id=?,status='draft',submitted_by=NULL,reviewed_by=NULL,review_note=NULL WHERE id=?`,[payload.name,JSON.stringify(payload),version,scope.vendor_id,kind==='merchants'?key:scope.merchant_id,scope.store_id,key]);
   else {const [r]=await c.execute(`INSERT INTO commerce_${kind}(name,city_id,vendor_id,merchant_id,store_id,payload,created_by) VALUES(?,?,?,?,?,?,?)`,[payload.name,scope.city_id,scope.vendor_id,scope.merchant_id,scope.store_id,JSON.stringify(payload),p.account.id]);key=r.insertId;if(kind==='merchants')await c.execute('UPDATE commerce_merchants SET merchant_id=id WHERE id=?',[key]);if(kind==='skus')await c.execute('INSERT INTO commerce_inventory(sku_id) VALUES(?)',[key]);}
   await this.audit(c,p,'configuration.save',`${kind}/${key}`,{version},scope);return this.entity(c,kind,key);
  });
 }
 async transition(p,perm,kind,key,input,merchantOnly=false){return this.tx(async c=>{const e=await this.entity(c,kind,key,true);await this.allowed(c,p,perm,e,merchantOnly);assert(!merchantOnly||definitions[kind].merchant,'不允许操作平台配置',403);assert(e.version===input.version,'记录已更新，请刷新',409);
  const action=input.action;const states={submit:['draft','rejected'],approve:['submitted'],reject:['submitted'],publish:['approved'],archive:['published','draft','rejected']};assert(states[action]?.includes(e.status),'当前状态不能执行该操作',409);assert(!merchantOnly||action==='submit','商户只能提交审核',403);
  if(['approve','reject'].includes(action)){assert(e.submitted_by!==p.account.id,'提交人不能复核自己的申请',403);assert(typeof input.note==='string'&&input.note.trim().length>=2&&input.note.length<=1000,'请填写审核意见');}
  if(['submit','approve','publish'].includes(action)){const valid=validate(kind,e.payload);await this.references(c,kind,valid,p,perm,merchantOnly);if(action==='approve') {if(e.payload.initialization)valid.initialization=e.payload.initialization;await c.execute('UPDATE commerce_'+kind+' SET payload=? WHERE id=?',[JSON.stringify(valid),key]);await c.execute('INSERT INTO commerce_versions(kind,entity_id,version,snapshot,reviewed_by) VALUES(?,?,?,?,?)',[kind,key,e.version,JSON.stringify(valid),p.account.id]);}}
  const status={submit:'submitted',approve:'approved',reject:'rejected',publish:'published',archive:'archived'}[action];
  await c.execute(`UPDATE commerce_${kind} SET status=?,submitted_by=?,reviewed_by=?,review_note=?,published_version=? WHERE id=?`,[status,action==='submit'?p.account.id:e.submitted_by,['approve','reject'].includes(action)?p.account.id:e.reviewed_by,input.note||e.review_note,action==='publish'?e.version:(action==='archive'?null:e.published_version),key]);
  await this.audit(c,p,`configuration.${action}`,`${kind}/${key}`,{version:e.version,note:input.note||null},e);return this.entity(c,kind,key);
 });}
 async catalog(city=''){const out=[],{isDemo}=require('./guiyang-demo.cjs');for(const kind of ['packages','plans','skus']){const args=[kind];let where="e.status<>'archived'";if(city){where+=' AND (c.name=? OR c.slug=? OR CAST(c.id AS CHAR)=?)';args.push(city,city,city);}const rows=await this.get(this.pool,`SELECT e.id,e.city_id,e.published_version,v.snapshot,c.name city_name FROM commerce_${kind} e JOIN commerce_versions v ON v.kind=? AND v.entity_id=e.id AND v.version=e.published_version JOIN cities c ON c.id=e.city_id WHERE ${where}`,args);for(const e of rows){const p=parse(e.snapshot),demo=isDemo(p);out.push({id:e.id,kind,city_id:e.city_id,city_name:e.city_name,version:e.published_version,name:p.name,description:p.description,price_minor:kind==='skus'?p.retail_minor:p.price_minor,valid_days:kind==='plans'?p.valid_days:null,is_demo:demo,category_id:p.category_id||null,topic_id:p.topic_id||p.initialization?.topic_id||null,channel_slug:p.channel_slug||null,items:(kind==='skus'?[{sku:p,quantity:1}]:(p.items||p.package?.items||[])).map(i=>({name:i.sku.name,quantity:i.quantity,description:i.sku.description,conditions:i.sku.conditions,valid_days:i.sku.valid_days,store_id:i.sku.store_id}))});}}return out;}
 async inventory(p,perm,input,merchantOnly=false){assert(Number.isSafeInteger(input.total)&&input.total>=0&&input.total<=10000000,'库存或产能总量无效');return this.tx(async c=>{const capacity=input.kind==='capacity';const e=await this.entity(c,capacity?'stores':'skus',capacity?input.store_id:input.sku_id,true);await this.allowed(c,p,perm,e,merchantOnly);
  if(capacity){assert(/^\d{4}-\d{2}-\d{2}$/.test(input.service_date)&&input.service_date>=new Date().toISOString().slice(0,10),'请选择今天或之后的日期');await c.execute('INSERT IGNORE INTO commerce_capacity(store_id,service_date,total) VALUES(?,?,?)',[e.id,input.service_date,input.total]);const rows=await this.get(c,'SELECT * FROM commerce_capacity WHERE store_id=? AND service_date=? FOR UPDATE',[e.id,input.service_date]);assert(rows[0].reserved<=input.total,'产能不能低于已预约量',409);await c.execute('UPDATE commerce_capacity SET total=? WHERE store_id=? AND service_date=?',[input.total,e.id,input.service_date]);}
  else {const [r]=await c.execute('UPDATE commerce_inventory SET total=? WHERE sku_id=? AND reserved+granted<=?',[input.total,e.id,input.total]);assert(r.affectedRows,'库存不能低于已预占与已发放数量',409);}
  await this.audit(c,p,capacity?'capacity.adjust':'inventory.adjust',e.id,{total:input.total,date:input.service_date||null},e);return {updated:true};
 });}
 async idem(c,p,operation,key,input,fn){assert(typeof key==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(key),'缺少有效的幂等请求标识');const hash=digest(input);
  await c.execute('INSERT IGNORE INTO commerce_idempotency(actor_id,operation,request_key,digest) VALUES(?,?,?,?)',[p.account.id,operation,key,hash]);const [previous]=await this.get(c,'SELECT digest,response FROM commerce_idempotency WHERE actor_id=? AND operation=? AND request_key=? FOR UPDATE',[p.account.id,operation,key]);assert(previous.digest===hash,'重复请求标识对应不同内容',409);if(previous.response)return parse(previous.response);
  const result=await fn();await c.execute('UPDATE commerce_idempotency SET response=? WHERE actor_id=? AND operation=? AND request_key=?',[JSON.stringify(result),p.account.id,operation,key]);return result;
 }
 // Internal application use only. HTTP purchase is disabled until a verified payment adapter is admitted.
 async reserveOrder(p,input,key){const referral=input.referral?await this.verifyReferral(input.referral,input):null;return this.tx(c=>this.idem(c,p,'order',key,input,async()=>{assert(['packages','plans'].includes(input.kind),'商品类型无效');const product=await this.approved(c,input.kind,input.product_id);const packagePayload=input.kind==='plans'?product.payload.package:product.payload;const items=[...packagePayload.items].sort((a,b)=>a.sku_id-b.sku_id);const orderId=id();
  for(const item of items){await this.approved(c,'skus',item.sku_id);const [r]=await c.execute('UPDATE commerce_inventory SET reserved=reserved+? WHERE sku_id=? AND total-reserved-granted>=?',[item.quantity,item.sku_id,item.quantity]);assert(r.affectedRows,'库存不足',409);}
  await c.execute('INSERT INTO commerce_orders(id,account_id,city_id,product_kind,product_id,product_version,amount_minor,status,expires_at,snapshot,source_account_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[orderId,p.account.id,product.city_id,input.kind,product.id,product.version,product.payload.price_minor,'reserved',date(Date.now()+15*60000),JSON.stringify(product.payload),referral&&referral.aid!==p.account.id?referral.aid:null]);
  for(const item of items)await c.execute('INSERT INTO commerce_order_items(order_id,sku_id,merchant_id,store_id,quantity,allocation_minor,snapshot) VALUES(?,?,?,?,?,?,?)',[orderId,item.sku_id,item.sku.merchant_id,item.sku.store_id,item.quantity,item.allocation_minor,JSON.stringify(item)]);
  return {id:orderId,status:'reserved'};
 }));}
 async fulfillPaidOrder(orderId,providerRef,amountMinor){assert(typeof providerRef==='string'&&providerRef.length>=8&&providerRef.length<=128,'支付凭据无效');return this.tx(async c=>{const [order]=await this.get(c,'SELECT * FROM commerce_orders WHERE id=? FOR UPDATE',[orderId]);assert(order,'订单不存在',404);assert(order.amount_minor===amountMinor,'支付金额不匹配',409);if(order.status==='fulfilled'){assert(order.provider_ref===providerRef,'支付凭据冲突',409);return {id:orderId,status:'fulfilled'};}assert(order.status==='reserved'&&new Date(order.expires_at)>new Date(),'预占已关闭，需要支付异常处理',409);
  const items=await this.get(c,'SELECT * FROM commerce_order_items WHERE order_id=? ORDER BY sku_id',[orderId]);for(const item of items){const snapshot=parse(item.snapshot);await c.execute('UPDATE commerce_inventory SET reserved=reserved-?,granted=granted+? WHERE sku_id=?',[item.quantity,item.quantity,item.sku_id]);for(let unit=1;unit<=item.quantity;unit++)await c.execute('INSERT INTO commerce_coupons(id,order_id,item_id,unit_no,account_id,merchant_id,store_id,city_id,status,expires_at,allocation_minor,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id(),orderId,item.id,unit,order.account_id,item.merchant_id,item.store_id,order.city_id,'available',date(Date.now()+snapshot.sku.valid_days*86400000),item.allocation_minor,JSON.stringify(snapshot)]);}
  if(order.product_kind==='plans'){const plan=parse(order.snapshot);
   // 续费顺延：已有效会员的到期日为起点叠加新周期；无有效会员则从当下起算（M0 口径回归）。
   const prev=await this.get(c,'SELECT MAX(expires_at) latest FROM commerce_memberships WHERE account_id=?',[order.account_id]);
   const base=prev[0]?.latest&&new Date(prev[0].latest)>new Date()?new Date(prev[0].latest):new Date();
   const expires=new Date(base.getTime()+plan.valid_days*86400000);
   await c.execute('INSERT INTO commerce_memberships(order_id,account_id,name,expires_at,snapshot) VALUES(?,?,?,?,?)',[orderId,order.account_id,plan.name,date(expires),JSON.stringify({...plan,extends_from:prev[0]?.latest||null})]);}
  if(parse(order.snapshot).is_demo!==true)await require('./settlement.cjs').post(c,{sourceType:'funding',sourceId:orderId,lines:[{side:'debit',account:'provider_receivable',amount:order.amount_minor},{side:'credit',account:'unredeemed_liability',amount:order.amount_minor}],memo:'funding '+orderId});
  await c.execute("UPDATE commerce_orders SET status='fulfilled',provider_ref=? WHERE id=?",[providerRef,orderId]);await require('./main-system.cjs').linkOrder(c,{...order,status:'fulfilled'});await c.execute('INSERT INTO commerce_events(aggregate_id,event_type,payload) VALUES(?,?,?)',[orderId,'order.fulfilled',JSON.stringify({orderId,providerRef})]);return {id:orderId,status:'fulfilled'};
 });}
 async expire(){const orders=await this.get(this.pool,"SELECT id FROM commerce_orders WHERE status='reserved' AND expires_at<=UTC_TIMESTAMP() LIMIT 100");for(const o of orders)await this.tx(async c=>{const [locked]=await this.get(c,'SELECT status FROM commerce_orders WHERE id=? FOR UPDATE',[o.id]);if(locked.status!=='reserved')return;const items=await this.get(c,'SELECT sku_id,quantity FROM commerce_order_items WHERE order_id=? ORDER BY sku_id',[o.id]);for(const i of items)await c.execute('UPDATE commerce_inventory SET reserved=reserved-? WHERE sku_id=?',[i.quantity,i.sku_id]);await c.execute("UPDATE commerce_orders SET status='expired' WHERE id=?",[o.id]);});await this.expireCoupons();return orders.length;}
 async expireCoupons(){
  const candidates=await this.get(this.pool,"SELECT id,account_id FROM commerce_coupons WHERE status='available' AND expires_at<=UTC_TIMESTAMP() LIMIT 100");
  for(const candidate of candidates)await this.tx(async c=>{
   const coupon=await this.coupon(c,candidate.id);if(coupon.status!=='available'||new Date(coupon.expires_at)>new Date())return;
   const [old]=await this.get(c,"SELECT id FROM commerce_cases WHERE coupon_id=? AND kind='refund' AND status IN ('open','processing','awaiting_provider') FOR UPDATE",[coupon.id]);
   if(old){await c.execute("UPDATE commerce_coupons SET status='frozen',token_hash=NULL WHERE id=?",[coupon.id]);return;}
   const caseId=id();await c.execute("UPDATE commerce_coupons SET status='frozen',token_hash=NULL WHERE id=?",[coupon.id]);
   await c.execute('INSERT INTO commerce_cases(id,coupon_id,account_id,merchant_id,store_id,city_id,kind,reason,status) VALUES(?,?,?,?,?,?,?,?,?)',[caseId,coupon.id,coupon.account_id,coupon.merchant_id,coupon.store_id,coupon.city_id,'refund',coupon.snapshot.is_demo?'演示卡券到期，无实际退款':'未使用卡券到期，自动申请原路退款',coupon.snapshot.is_demo?'closed':'awaiting_provider']);
   const appointments=await this.get(c,"SELECT * FROM commerce_appointments WHERE coupon_id=? AND status='booked' FOR UPDATE",[coupon.id]);for(const a of appointments){await c.execute("UPDATE commerce_appointments SET status='cancelled' WHERE id=?",[a.id]);await c.execute('UPDATE commerce_capacity SET reserved=reserved-1 WHERE store_id=? AND service_date=?',[a.store_id,date(a.service_date).slice(0,10)]);}
   await require('./main-system.cjs').linkCase(c,{id:caseId,reason:'未使用权益到期处理'+(coupon.snapshot.is_demo?'（演示，无实际退款）':''),status:coupon.snapshot.is_demo?'closed':'awaiting_provider'},coupon);
   await c.execute('INSERT INTO commerce_events(aggregate_id,event_type,payload) VALUES(?,?,?)',[coupon.id,coupon.snapshot.is_demo?'demo.coupon.expired':'coupon.expired_refund_requested',JSON.stringify({coupon_id:coupon.id,case_id:caseId})]);
  });
 }
 async verifyReferral(token,product){
  assert(typeof token==='string'&&token.length<1500,'推广链接无效',422);const [payload,signature,...rest]=token.split('.');assert(payload&&signature&&!rest.length,'推广链接无效',422);
  const secret=process.env.JUZHU_API_KEY||process.env.JUZHU_ADMIN_PASSWORD;assert(secret,'分享服务暂不可用',503);const expected=crypto.createHmac('sha256',secret).update('commerce-share:'+payload).digest('base64url');
  assert(signature.length===expected.length&&crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)),'推广链接签名无效',422);
  let data;try{data=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{throw new Fault(422,'推广链接无效');}
  assert(data.exp>Math.floor(Date.now()/1000)&&['packages','plans','skus'].includes(data.kind),'推广链接已过期',422);
  const entity=await this.approved(this.pool,data.kind,data.id);assert(entity.version===data.v,'推广商品已更新，请获取新链接',409);
  if(product)assert(product.kind===data.kind&&product.product_id===data.id,'推广链接与商品不匹配',422);
  const accounts=await this.get(this.pool,"SELECT id FROM accounts WHERE id=? AND status='active' AND principal_type='user'",[data.aid]);assert(accounts.length,'推广来源不可用',422);return data;
 }

 async my(p){const out={};for(const kind of ['orders','coupons','memberships','appointments','cases','redemptions']) {const rows=await this.get(this.pool,`SELECT * FROM commerce_${kind} WHERE account_id=? ORDER BY ${kind==='memberships'?'order_id':'id'} DESC LIMIT 100`,[p.account.id]);out[kind]=rows.map(r=>{const e=row(r);delete e.token_hash;delete e.token_expires_at;delete e.provider_ref;if(e.snapshot){const s=e.snapshot;e.name=s.name||s.sku?.name;e.description=s.description||s.sku?.description;e.conditions=s.sku?.conditions;e.is_demo=s.is_demo===true;e.demo_price_minor=s.demo_price_minor??null;if(kind==='memberships'){e.valid_days=s.valid_days;e.items=(s.package?.items||[]).map(i=>({name:i.sku?.name,quantity:i.quantity,description:i.sku?.description,conditions:i.sku?.conditions,valid_days:i.sku?.valid_days}));}delete e.snapshot;}if(kind==='orders')e.main_order_ref=e.id;if(kind==='cases')e.work_order_id=e.id;return e;});if(kind==='redemptions')out[kind]=out[kind].map(({id,coupon_id,created_at})=>({id,coupon_id,created_at}));}
 out.refunds=(await this.get(this.pool,`SELECT ro.refund_no,ro.coupon_id,ro.order_id,ro.amount_minor,ro.kind,ro.status,ro.fail_reason,ro.created_at,ro.settled_at,JSON_UNQUOTE(JSON_EXTRACT(cc.snapshot,'$.sku.name')) coupon_name FROM commerce_refund_orders ro LEFT JOIN commerce_coupons cc ON cc.id=ro.coupon_id WHERE ro.account_id=? ORDER BY ro.id DESC LIMIT 100`,[p.account.id])).map(r=>({refund_no:r.refund_no,coupon_id:r.coupon_id,coupon_name:r.coupon_name,order_id:r.order_id,amount_minor:r.amount_minor,kind:r.kind,status:r.status==='paid'?'refunded':r.status,fail_reason:r.fail_reason,created_at:r.created_at,settled_at:r.settled_at}));
 out.compensations=(await this.get(this.pool,`SELECT cp.compensation_no,cp.coupon_id,cp.amount_minor,cp.status,cp.review_note,cp.created_at,JSON_UNQUOTE(JSON_EXTRACT(cpv.snapshot,'$.sku.name')) coupon_name FROM commerce_compensation_cases cp LEFT JOIN commerce_coupons cpv ON cpv.id=cp.coupon_id WHERE cp.account_id=? ORDER BY cp.id DESC LIMIT 100`,[p.account.id])).map(r=>({compensation_no:r.compensation_no,coupon_id:r.coupon_id,coupon_name:r.coupon_name,amount_minor:r.amount_minor,status:r.status,note:r.review_note,created_at:r.created_at}));
 return out;}
 async coupon(c,key,lock=true){const [v]=await this.get(c,`SELECT * FROM commerce_coupons WHERE id=?${lock?' FOR UPDATE':''}`,[key]);assert(v,'卡券不存在',404);return row(v);}
 async appointment(p,input,key){return this.tx(c=>this.idem(c,p,'appointment',key,input,async()=>{const coupon=await this.coupon(c,input.coupon_id);assert(coupon.account_id===p.account.id,'不能操作其他人的卡券',403);assert(coupon.status==='available','卡券当前不可预约',409);const [old]=await this.get(c,"SELECT * FROM commerce_appointments WHERE coupon_id=? AND status='booked' FOR UPDATE",[coupon.id]);
  if(input.action==='cancel'){assert(old,'预约不存在',404);await c.execute("UPDATE commerce_appointments SET status='cancelled' WHERE id=?",[old.id]);await c.execute('UPDATE commerce_capacity SET reserved=reserved-1 WHERE store_id=? AND service_date=?',[old.store_id,date(old.service_date).slice(0,10)]);return {cancelled:true};}
  const store=await this.approved(c,'stores',coupon.store_id);assert(/^\d{4}-\d{2}-\d{2}$/.test(input.service_date),'预约日期无效');const when=Date.parse(input.service_date+'T00:00:00+08:00');assert(Number.isFinite(when)&&when>=Date.now()+store.payload.lead_hours*3600000&&when<new Date(coupon.expires_at).getTime(),'预约日期应满足提前量且在卡券有效期内');assert(!old||date(old.service_date).slice(0,10)!==input.service_date,'已预约该日期',409);
  // 先 UPDATE（常态无间隙锁）；仅当日历行缺失才 INSERT IGNORE 兜底（并发首订场景，配合 tx 层死锁重试）。
  let [r]=await c.execute('UPDATE commerce_capacity SET reserved=reserved+1 WHERE store_id=? AND service_date=? AND reserved<total',[coupon.store_id,input.service_date]);
  if(!r.affectedRows){
   await c.execute('INSERT IGNORE INTO commerce_capacity(store_id,service_date,total) VALUES(?,?,?)',[coupon.store_id,input.service_date,store.payload.capacity]);
   [r]=await c.execute('UPDATE commerce_capacity SET reserved=reserved+1 WHERE store_id=? AND service_date=? AND reserved<total',[coupon.store_id,input.service_date]);
  }
  assert(r.affectedRows,'当日预约已满，请选择其他日期',409);
  if(old){await c.execute('UPDATE commerce_capacity SET reserved=reserved-1 WHERE store_id=? AND service_date=?',[old.store_id,date(old.service_date).slice(0,10)]);await c.execute("UPDATE commerce_appointments SET status='rescheduled' WHERE id=?",[old.id]);}
  const appointmentId=id();await c.execute('INSERT INTO commerce_appointments(id,coupon_id,account_id,merchant_id,store_id,city_id,service_date,status) VALUES(?,?,?,?,?,?,?,?)',[appointmentId,coupon.id,p.account.id,coupon.merchant_id,coupon.store_id,coupon.city_id,input.service_date,'booked']);return {id:appointmentId,service_date:input.service_date};
 }));}
 async token(p,key){return this.tx(async c=>{const coupon=await this.coupon(c,key);assert(coupon.account_id===p.account.id,'卡券不属于当前账号',403);assert(coupon.status==='available'&&new Date(coupon.expires_at)>new Date(),'卡券不可核销',409);const token=crypto.randomBytes(16).toString('hex');await c.execute('UPDATE commerce_coupons SET token_hash=?,token_expires_at=? WHERE id=?',[digest(token),date(Date.now()+120000),key]);return {coupon_id:key,token,expires_in:120};});}
 // Two-stage fulfilment: preview validates everything redeem() validates without any side effect.
 async checkRedeemable(c,p,perm,input,merchantOnly=true){
  const coupon=await this.coupon(c,input.coupon_id);
  await this.allowed(c,p,perm,coupon,merchantOnly);
  const staff=await this.get(c,"SELECT v.snapshot FROM commerce_staff e JOIN commerce_versions v ON v.kind='staff' AND v.entity_id=e.id AND v.version=e.published_version WHERE e.status<>'archived' AND e.store_id=?",[coupon.store_id]);assert(staff.some(s=>parse(s.snapshot).account_id===p.account.id),'未获该门店核销授权',403,'no_redeem_auth');
  assert(coupon.status==='available'&&new Date(coupon.expires_at)>new Date(),'卡券已使用、冻结或过期',409,'coupon_unavailable');assert(typeof input.token==='string'&&coupon.token_hash===digest(input.token)&&new Date(coupon.token_expires_at)>new Date(),'核销码无效或已过期',409,'token_invalid');
  const [appointment]=await this.get(c,"SELECT * FROM commerce_appointments WHERE coupon_id=? AND status='booked' FOR UPDATE",[coupon.id]);assert(appointment,'请先完成预约',409,'no_appointment');const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());assert(date(appointment.service_date).slice(0,10)===today,'仅可核销当日预约',409,'not_service_date');
  return {coupon,appointment};
 }
 async redeemPreviewMeta(coupon,appointment){
  const sku=coupon.snapshot.sku||{};
  const [store]=await this.get(this.pool,'SELECT name FROM commerce_stores WHERE id=?',[coupon.store_id]);
  const [customer]=await this.get(this.pool,'SELECT display_name FROM accounts WHERE id=?',[coupon.account_id]);
  const amount=coupon.allocation_minor,rule=coupon.snapshot.rule||{};
  return {coupon_id:coupon.id,name:sku.name||coupon.snapshot.name||'生活权益',description:sku.description||coupon.snapshot.description||'',conditions:sku.conditions||'',store:store?.name||'',service_date:date(appointment.service_date).slice(0,10),customer:customer?.display_name||'',expires_at:coupon.expires_at,allocation_minor:amount,supplier_minor:amount-Math.floor(amount*(rule.beike_bps||0)/10000),is_demo:coupon.snapshot.is_demo===true};
 }
 async previewRedeem(p,perm,input){
  assert(input&&typeof input.coupon_id==='string'&&typeof input.token==='string','请提供卡券编号与动态核销码',422,'redeem_input_invalid');
  return this.tx(async c=>{const {coupon,appointment}=await this.checkRedeemable(c,p,perm,input);return {...await this.redeemPreviewMeta(coupon,appointment),preview:true};});
 }
 async redeem(p,perm,input,key){return this.tx(c=>this.idem(c,p,'redeem',key,input,async()=>{const {coupon,appointment}=await this.checkRedeemable(c,p,perm,input);
  const existing=await this.get(c,"SELECT id FROM commerce_redemptions WHERE coupon_id=? AND status='confirmed'",[coupon.id]);assert(!existing.length,'该卡券已存在有效核销',409,'coupon_unavailable');
  const [order]=await this.get(c,'SELECT source_account_id FROM commerce_orders WHERE id=?',[coupon.order_id]);
  const rule=coupon.snapshot.rule,amount=coupon.allocation_minor,beike=Math.floor(amount*rule.beike_bps/10000),channel=order.source_account_id?Math.floor(beike*rule.channel_bps/10000):0;const redemption=id();await c.execute('INSERT INTO commerce_redemptions(id,coupon_id,account_id,merchant_id,store_id,city_id,operator_id,allocation_minor,supplier_minor,beike_minor,channel_minor,retained_minor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[redemption,coupon.id,coupon.account_id,coupon.merchant_id,coupon.store_id,coupon.city_id,p.account.id,amount,amount-beike,beike,channel,beike-channel]);
  if(coupon.snapshot.is_demo!==true)await require('./settlement.cjs').post(c,{sourceType:'redemption',sourceId:redemption,lines:require('./settlement.cjs').confirmLines({merchant_id:coupon.merchant_id,allocation_minor:amount,supplier_minor:amount-beike,beike_minor:beike,channel_minor:channel,retained_minor:beike-channel,source_account_id:order.source_account_id}),rule_ref:'rule:'+coupon.snapshot.rule_id+'.v'+(coupon.snapshot.rule_version??'?'),memo:'redemption '+redemption});
  await c.execute("UPDATE commerce_coupons SET status='redeemed',token_hash=NULL,token_expires_at=NULL WHERE id=?",[coupon.id]);await c.execute("UPDATE commerce_appointments SET status='completed' WHERE id=?",[appointment.id]);await this.audit(c,p,'coupon.redeem',coupon.id,{redemption},coupon);return {id:redemption,status:'redeemed'};
 }));}
 async openCase(p,input,key){return this.tx(c=>this.idem(c,p,'case',key,input,async()=>{assert(['refund','help','compensation'].includes(input.kind)&&typeof input.reason==='string'&&input.reason.trim().length>=5&&input.reason.length<=1000,'请选择售后类型并填写至少5字说明');const coupon=await this.coupon(c,input.coupon_id);assert(coupon.account_id===p.account.id,'不能操作其他人的卡券',403);const existing=await this.get(c,"SELECT id FROM commerce_cases WHERE coupon_id=? AND status IN ('open','processing','awaiting_provider')",[coupon.id]);assert(!existing.length,'已有处理中售后，请勿重复提交',409);
  if(input.kind==='refund'){assert(coupon.status==='available','卡券已使用或冻结，不能申请未使用退款',409);await c.execute("UPDATE commerce_coupons SET status='frozen',token_hash=NULL WHERE id=?",[coupon.id]);const appts=await this.get(c,"SELECT * FROM commerce_appointments WHERE coupon_id=? AND status='booked' FOR UPDATE",[coupon.id]);for(const a of appts){await c.execute("UPDATE commerce_appointments SET status='cancelled' WHERE id=?",[a.id]);await c.execute('UPDATE commerce_capacity SET reserved=reserved-1 WHERE store_id=? AND service_date=?',[a.store_id,date(a.service_date).slice(0,10)]);}}
  if(input.kind==='compensation'){assert(coupon.status==='redeemed'&&coupon.snapshot.is_demo!==true,'服务失败赔付仅面向已核销的非演示卡券（未核销请申请退款）',409);}
  const caseId=id();await c.execute('INSERT INTO commerce_cases(id,coupon_id,account_id,merchant_id,store_id,city_id,kind,reason,status) VALUES(?,?,?,?,?,?,?,?,?)',[caseId,coupon.id,p.account.id,coupon.merchant_id,coupon.store_id,coupon.city_id,input.kind,input.reason.trim(),'open']);await require('./main-system.cjs').linkCase(c,{id:caseId,reason:input.reason.trim(),status:'open'},coupon);return {id:caseId,status:'open',work_order_id:caseId};
 }));}
 async resolveCase(p,perm,key,input,merchantOnly=false){return this.tx(async c=>{const [peek]=await this.get(c,'SELECT coupon_id FROM commerce_cases WHERE id=?',[key]);assert(peek,'售后单不存在',404);const coupon=await this.coupon(c,peek.coupon_id);const [e]=await this.get(c,'SELECT * FROM commerce_cases WHERE id=? FOR UPDATE',[key]);await this.allowed(c,p,perm,e,merchantOnly);assert(['open','processing'].includes(e.status),'该工单已处理',409);assert(typeof input.resolution==='string'&&input.resolution.trim().length>=5&&input.resolution.length<=1000,'请输入至少5字处理说明');let status='processing';
  if(!merchantOnly){assert(['reject','accept','close'].includes(input.action),'处理动作无效');assert(e.kind==='help'||input.action!=='close','退款单不能手工标记完成');status=input.action==='reject'?'rejected':(e.kind==='refund'||e.kind==='compensation')&&!coupon.snapshot.is_demo?'awaiting_provider':'closed';if(e.kind==='refund'&&input.action==='reject')await c.execute("UPDATE commerce_coupons SET status='available' WHERE id=? AND status='frozen'",[coupon.id]);}
  await c.execute('UPDATE commerce_cases SET status=?,resolution=? WHERE id=?',[status,input.resolution.trim(),key]);if(['closed','rejected','awaiting_provider'].includes(status))await require('./main-system.cjs').resolveWork(c,key,input.resolution.trim());await this.audit(c,p,'case.handle',key,{status,resolution:input.resolution.trim()},e);return {id:key,status};
 });
 }
 // Order fulfilment chain for the customer: grant → appointment → redemption, one entry per coupon.
 async track(p,orderId){
  const [order]=await this.get(this.pool,'SELECT * FROM commerce_orders WHERE id=? AND account_id=?',[orderId,p.account.id]);assert(order,'订单不存在或无权查看',404);
  const snap=parse(order.snapshot);
  const coupons=(await this.get(this.pool,"SELECT c.id,c.status,c.expires_at,JSON_UNQUOTE(JSON_EXTRACT(c.snapshot,'$.sku.name')) name,a.service_date appointment_date,a.status appointment_status,r.created_at redeemed_at FROM commerce_coupons c LEFT JOIN commerce_appointments a ON a.coupon_id=c.id AND a.status='booked' LEFT JOIN commerce_redemptions r ON r.coupon_id=c.id WHERE c.order_id=? ORDER BY c.item_id,c.unit_no",[orderId])).map(c=>({id:c.id,name:c.name||snap.name||'生活权益',status:c.status,expires_at:c.expires_at,appointment_date:c.appointment_date?date(c.appointment_date).slice(0,10):null,appointment_status:c.appointment_status||null,redeemed_at:c.redeemed_at}));
  return {id:order.id,status:order.status,product_kind:order.product_kind,product_name:snap.name||'生活权益',amount_minor:order.amount_minor,is_demo:snap.is_demo===true,created_at:order.created_at,coupons};
 }
 // Operations overview: issuance, appointments, redemption, exchange and after-sales in one read.
 async stats(p,perm){
  const s=this.scope(p,perm),city=(s.level==='city'&&s.cityIds.length)?s.cityIds:null;
  const cond=sql=>city?sql+' WHERE city_id IN ('+city.map(()=>'?').join(',')+')':sql;const args=()=>city?[...city]:[];
  const one=async(sql,queryArgs=[])=>(await this.get(this.pool,sql,queryArgs))[0];const n=v=>Number(v)||0;
  const coupons=await one("SELECT COUNT(*) total,SUM(status='available') available,SUM(status='redeemed') redeemed,SUM(status='frozen') frozen FROM commerce_coupons"+cond(''),args());
  const orders=await one("SELECT COUNT(*) total,SUM(status='fulfilled') fulfilled,SUM(JSON_EXTRACT(snapshot,'$.is_demo')=true) demo FROM commerce_orders"+cond(''),args());
  const appointments=await one("SELECT COUNT(*) total,SUM(status='booked') booked,SUM(status='booked' AND service_date=DATE(CONVERT_TZ(NOW(),'+00:00','+08:00'))) today FROM commerce_appointments"+cond(''),args());
  const redemptions=await one('SELECT COUNT(*) total,COALESCE(SUM(supplier_minor),0) supplier_minor,COALESCE(SUM(beike_minor),0) beike_minor,COALESCE(SUM(channel_minor),0) channel_minor FROM commerce_redemptions'+cond(''),args());
  const codes=await one("SELECT COUNT(*) total,SUM(status<>'disabled' AND redeemed_by IS NULL AND expires_at>UTC_TIMESTAMP()) unused,SUM(status<>'disabled' AND redeemed_by IS NOT NULL) redeemed,SUM(status<>'disabled' AND redeemed_by IS NULL AND expires_at<=UTC_TIMESTAMP()) expired,SUM(status='disabled') disabled FROM commerce_exchange_codes"+cond(''),args());
  const cases=await one("SELECT COUNT(*) total,SUM(kind='refund') refund,SUM(kind='help') help,SUM(kind='compensation') compensation,SUM(status='open') open,SUM(status='processing') processing,SUM(status='awaiting_provider') awaiting_provider,SUM(status='closed') closed,SUM(status='rejected') rejected FROM commerce_cases"+cond(''),args());
  const failures=await one("SELECT COUNT(*) total FROM commerce_audit WHERE action='operation.failed'");
  const recent=(await this.get(this.pool,"SELECT b.id,b.actor_id,b.resource,b.detail,b.created_at,acc.display_name actor_name FROM commerce_audit b LEFT JOIN accounts acc ON acc.id=b.actor_id WHERE b.action='operation.failed' ORDER BY b.id DESC LIMIT 20")).map(r=>({...r,detail:parse(r.detail)}));
  return {
   coupons:{total:n(coupons.total),available:n(coupons.available),redeemed:n(coupons.redeemed),frozen:n(coupons.frozen)},
   orders:{total:n(orders.total),fulfilled:n(orders.fulfilled),demo:n(orders.demo),real:n(orders.total)-n(orders.demo)},
   appointments:{total:n(appointments.total),booked:n(appointments.booked),today:n(appointments.today)},
   redemptions:{total:n(redemptions.total),supplier_minor:n(redemptions.supplier_minor),beike_minor:n(redemptions.beike_minor),channel_minor:n(redemptions.channel_minor)},
   exchange_codes:{total:n(codes.total),unused:n(codes.unused),redeemed:n(codes.redeemed),expired:n(codes.expired),disabled:n(codes.disabled)},
   cases:{total:n(cases.total),refund:n(cases.refund),help:n(cases.help),compensation:n(cases.compensation),open:n(cases.open),processing:n(cases.processing),awaiting_provider:n(cases.awaiting_provider),closed:n(cases.closed),rejected:n(cases.rejected)},
   failures:{total:n(failures.total),recent}
  };
 }
}
module.exports={Service,parse,digest};
