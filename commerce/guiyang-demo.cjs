'use strict';
// Explicitly fictional test-site fixtures; no real merchant claims or financial postings.
const {readTopics}=require('./initialization.cjs');
const BATCH='guiyang-life-demo-v1';
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const isDemo=p=>p?.initialization?.batch===BATCH&&p.initialization.mode==='demo';
async function seed(pool){
 const c=await pool.getConnection(),result={batch:BATCH,created:[],existing:[]};let locked=false;
 try{
  const [[lock]]=await c.query("SELECT GET_LOCK('guiyang_life_demo',20) acquired");if(!lock.acquired)throw Error('Demo initialization already running');locked=true;
  await c.beginTransaction();
  const [[city]]=await c.query("SELECT id,name,slug FROM cities WHERE slug='guiyang'");if(!city)throw Error('Guiyang city missing');result.city=city;
  const [categories]=await c.query('SELECT id,name,icon FROM jz_categories WHERE enabled=1 ORDER BY sort_order');
  const [skus]=await c.query('SELECT * FROM jz_skus WHERE enabled=1 ORDER BY id');
  const refs={},vouchers=new Map();
  async function entity(kind,key,payload,scope){
   const seedKey=BATCH+':'+key;
   const [events]=await c.execute("SELECT payload FROM commerce_events WHERE event_type='demo.configuration.initialized' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.seed_key'))=?",[seedKey]);
   if(events.length){const receipt=parse(events[0].payload);const [[e]]=await c.execute('SELECT * FROM commerce_'+kind+' WHERE id=?',[receipt.entity_id]);if(!e||!isDemo(parse(e.payload)))throw Error('Demo receipt conflict: '+key);result.existing.push({kind,id:e.id});return {...e,payload:parse(e.payload)};}
   payload.initialization={...payload.initialization,batch:BATCH,mode:'demo',seed_key:seedKey,note:'用户授权的贵阳演示资料，系统初始化；不代表商户签约、人工复核或真实服务承诺。'};
   const [r]=await c.execute('INSERT INTO commerce_'+kind+"(name,city_id,vendor_id,merchant_id,store_id,payload,created_by,status,published_version,review_note) VALUES(?,?,?,?,?,?,0,'published',1,?)",[payload.name,city.id,scope.vendor_id||null,scope.merchant_id||null,scope.store_id||null,JSON.stringify(payload),'演示初始化；非真实商务审核']);
   if(kind==='merchants')await c.execute('UPDATE commerce_merchants SET merchant_id=id WHERE id=?',[r.insertId]);
   await c.execute('INSERT INTO commerce_versions(kind,entity_id,version,snapshot,reviewed_by) VALUES(?,?,1,?,0)',[kind,r.insertId,JSON.stringify(payload)]);
   if(kind==='skus')await c.execute('INSERT INTO commerce_inventory(sku_id,total) VALUES(?,1000)',[r.insertId]);
   const receipt={seed_key:seedKey,kind,entity_id:r.insertId};
   await c.execute('INSERT INTO commerce_events(aggregate_id,event_type,payload) VALUES(?,?,?)',[String(r.insertId),'demo.configuration.initialized',JSON.stringify(receipt)]);
   await c.execute('INSERT INTO commerce_audit(actor_id,city_id,merchant_id,action,resource,detail) VALUES(0,?,?,?,?,?)',[city.id,scope.merchant_id||null,'demo.initialize',kind+'/'+r.insertId,JSON.stringify(receipt)]);
   result.created.push({kind,id:r.insertId});return {id:r.insertId,version:1,city_id:city.id,...scope,payload};
  }
  for(const cat of categories){
   const vendorNo=BATCH+':'+cat.id;
   let [[vendor]]=await c.execute('SELECT id,name FROM jz_vendors WHERE vendor_no=?',[vendorNo]);
   if(!vendor){const name='筑城'+cat.name+'服务站（演示）';const [r]=await c.execute("INSERT INTO jz_vendors(type,name,logo,address,city_ids,phone,rating,review_count,badges,start_price,unit,hours,vendor_no,status,review_status,intro) VALUES(?,?,?,?,?,NULL,0,0,?,0,'起','09:00—18:00（演示）',?,'active','pending',?)",[cat.id,name,cat.icon,'贵阳演示服务区（虚构门店，无实际接待地址）',String(city.id),JSON.stringify(['演示商家']),vendorNo,'用于贵阳本地生活频道的浏览、选品与预约流程演示；名称、门店及服务者均为虚构，不接受实际服务委托。']);vendor={id:r.insertId,name};result.created.push({kind:'channel_vendors',id:vendor.id});}else result.existing.push({kind:'channel_vendors',id:vendor.id});
   const merchant=await entity('merchants','merchant:'+cat.id,{name:vendor.name,vendor_id:vendor.id,city_id:city.id,contract_ref:'DEMO-NO-CONTRACT',contact:'演示服务台',phone:'未开通',description:'贵阳'+cat.name+'演示商户；无真实合同、服务承诺或可拨打电话。'},{vendor_id:vendor.id});
   const store=await entity('stores','store:'+cat.id,{name:'贵阳'+cat.name+'体验站（演示）',merchant_id:merchant.id,city_id:city.id,address:'贵阳演示服务区；非实际门店地址',phone:'未开通',capacity:30,lead_hours:0,description:'演示预约时段 09:00—18:00，每日30个演示名额，不派发真实服务。'},{vendor_id:vendor.id,merchant_id:merchant.id});
   const rule=await entity('rules','rule:'+cat.id,{name:cat.name+'无资金演示规则',merchant_id:merchant.id,beike_bps:0,channel_bps:0,floor_bps:0,description:'演示无佣金、无结算、无提现；展示金额不记入资金流水。'},{vendor_id:vendor.id,merchant_id:merchant.id});
   const [[worker]]=await c.execute('SELECT id FROM jz_workers WHERE vendor_id=? AND name=?',[vendor.id,cat.name+'服务员（演示）']);let workerId=worker?.id;
   if(!workerId){const [r]=await c.execute("INSERT INTO jz_workers(name,avatar,level,credit_score,tags,certs,is_whitelisted,rating,completed_orders,years_experience,online,vendor_id,status) VALUES(?,'👤','L1',0,?, '[]',0,0,0,0,0,?,'active')",[cat.name+'服务员（演示）',JSON.stringify(['虚构演示人物','不派发实际服务']),vendor.id]);workerId=r.insertId;result.created.push({kind:'channel_workers',id:workerId});}else result.existing.push({kind:'channel_workers',id:workerId});
   refs[cat.id]={vendor,merchant,store,rule,workerId};
  }
  async function voucher(sku,ref,price){
   const description='【演示服务券】'+sku.name+'；'+(sku.spec||'服务内容展示')+'。仅供无资金流程体验，不代表已购买真实服务。';
   return entity('skus','sku:'+sku.slug,{name:sku.name+' · 单品券（演示）',merchant_id:ref.merchant.id,store_id:ref.store.id,supply_minor:1,retail_minor:price,valid_days:90,description,conditions:'限贵阳演示场景，一券一次；提前预约，90天有效。演示权益不兑付真实服务，不发生扣款或退款。',category_id:sku.category_id,channel_slug:sku.slug,initialization:{channel_sku_id:sku.id||null}},{vendor_id:ref.vendor.id,merchant_id:ref.merchant.id,store_id:ref.store.id});
  }
  for(const sku of skus){
   const ref=refs[sku.category_id];if(!ref)continue;
   const marker=BATCH+':sku:'+sku.id;
   let [[product]]=await c.execute('SELECT id FROM jz_products WHERE vendor_id=? AND channel_sku_id=? AND city_id=? AND query=?',[ref.vendor.id,sku.id,city.id,marker]);
   if(!product){const price=Number(sku.price_from)||0;const [r]=await c.execute("INSERT INTO jz_products(vendor_id,city_id,title,subtitle,category,duration_hours,unit,price,original_price,earliest_time,advance_booking_hours,sales_count,rating,service_tags,channel_sku_id,query,status,sort_order) VALUES(?,?,?,?,?,?,?,?,?,'演示预约',0,0,0,?,?,?,'on',?)",[ref.vendor.id,city.id,sku.name+'（演示）','贵阳演示服务 · '+(sku.spec||'详情体验'),sku.category_id,(sku.duration_min||60)/60,sku.price_unit||'次',price,price,JSON.stringify(['演示商品','不提供真实履约']),sku.id,marker,sku.sort_order||0]);product={id:r.insertId};result.created.push({kind:'channel_products',id:product.id});}else result.existing.push({kind:'channel_products',id:product.id});
   await c.execute('INSERT IGNORE INTO jz_sku_workers(product_id,worker_id) VALUES(?,?)',[product.id,ref.workerId]);
   if(Number(sku.price_from)>0&&!['insurance','consumer_finance'].includes(sku.category_id)){const v=await voucher(sku,ref,Math.round(sku.price_from*100));vouchers.set(sku.slug,{entity:v,ref});}
  }
  const travel=await voucher({name:'旅居体验服务',slug:'guiyang-demo-travel',spec:'一次旅居行程沟通与入住流程体验',category_id:'community'},refs.community,39900);vouchers.set('guiyang-demo-travel',{entity:travel,ref:refs.community});
  const {topics}=readTopics();
  function item(slug,amount){const v=vouchers.get(slug);if(!v)throw Error('Missing demo voucher: '+slug);return {sku_id:v.entity.id,sku_version:v.entity.published_version||v.entity.version||1,rule_id:v.ref.rule.id,rule_version:1,quantity:1,allocation_minor:amount??v.entity.payload.retail_minor,sku:v.entity.payload,rule:v.ref.rule.payload};}
  for(const [key,topic]of Object.entries(topics)){
   const slugs=[...new Set(topic.journey.map(x=>x.sku).filter(x=>vouchers.has(x)))];if(!slugs.length)throw Error('Empty demo topic: '+key);
   const items=slugs.map(s=>item(s));
   await entity('packages','topic:'+key,{name:topic.title+' · 券包（演示）',city_id:city.id,price_minor:items.reduce((s,i)=>s+i.allocation_minor,0),description:'【贵阳演示】'+topic.lede,items,topic_id:key,initialization:{topic_id:key,topic_url:'juzhu-topic.html?id='+key,related_services:topic.journey.filter(x=>!vouchers.has(x.sku)).map(x=>({name:x.title,slug:x.sku,category:x.cat}))}},{});
  }
  const giftItems=[['cleaning-daily-2h',19980],['appliance-repair',13320],['moving-city-standard',27750],['guiyang-demo-travel',33300],['asset-appraisal',5550]].map(([slug,amount])=>item(slug,amount));
  const gift=await entity('packages','member-gift',{name:'新居住基础权益礼包（演示）',city_id:city.id,price_minor:99900,description:'贵阳演示版：保洁、维修、搬家、旅居、报告各一张，单券90天有效。',items:giftItems},{});
  await entity('plans','membership',{name:'新居住会员（演示）',city_id:city.id,package_id:gift.id,package_version:1,package:gift.payload,price_minor:99900,valid_days:365,description:'参考v1.9：999元/年，赠送五项独立生活权益。贵阳无资金演示，不开通真实付费会员。'},{});
  await c.commit();return result;
 }catch(e){await c.rollback();throw e;}finally{if(locked)await c.query("SELECT RELEASE_LOCK('guiyang_life_demo')").catch(()=>{});c.release();}
}
module.exports={seed,isDemo,BATCH};
