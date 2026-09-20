'use strict';
// 酒店通兑 + 本地生活三品类演示批次。
// 名单来自真实报名 Excel（commerce/hotel-roster.json），演示环境不提供真实入住/履约/资金；
// 抽样为确定性算法（档位 → 品牌分层 → 酒店编码字典序轮转），可重跑、可复算。
const {EXCHANGE_TIERS}=require('./configuration.cjs');
const roster=require('./hotel-roster.json');
const BATCH='hotel-exchange-demo-v1';
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const tierOf=h=>'t'+h.tier;
const TIER_BY_VALUE=Object.fromEntries(EXCHANGE_TIERS.map(t=>[t.value,t]));

// 确定性抽样：贵阳/沈阳（演示城市与试点口径）名单门店全量入围，其余名额按
// 品牌分层 + hotel_code 字典序轮转补足；每档总量仍为 perTier，可重跑、可复算。
// 返回项保留数值 tier，并附 exchange_tier（t80…t200）；不要用 tierOf 再包一层。
const PINNED_CITIES=['贵阳','沈阳'];
function sampleHotels(list=roster.hotels,perTier=8){
 const pinned=new Set(list.filter(h=>PINNED_CITIES.some(c=>h.name.includes(c))).map(h=>h.code));
 const byTier=new Map();
 for(const h of list){const tier=tierOf(h);if(TIER_BY_VALUE[tier]){if(!byTier.has(tier))byTier.set(tier,[]);byTier.get(tier).push(h);}}
 const picked=[];
 for(const tier of [...byTier.keys()].sort((a,b)=>TIER_BY_VALUE[a].minor-TIER_BY_VALUE[b].minor)){
  const group=byTier.get(tier);
  for(const h of group.filter(h=>pinned.has(h.code)).sort((a,b)=>a.code<b.code?-1:1))picked.push({...h,exchange_tier:tier});
  const brands=new Map();
  for(const h of group){if(pinned.has(h.code))continue;if(!brands.has(h.brand))brands.set(h.brand,[]);brands.get(h.brand).push(h);}
  for(const arr of brands.values())arr.sort((a,b)=>a.code<b.code?-1:a.code>b.code?1:0);
  const queues=[...brands.keys()].sort().map(b=>brands.get(b));
  for(let i=0,taken=group.filter(h=>pinned.has(h.code)).length;taken<perTier&&queues.some(q=>q.length);i++){const h=queues[i%queues.length].shift();if(h){picked.push({...h,exchange_tier:tier});taken++;}}
 }
 return picked;
}

async function seed(pool,{perTier=8}={}){
 const c=await pool.getConnection(),result={batch:BATCH,created:[],existing:[],sampled:0};let locked=false;
 try{
  const [[lock]]=await c.query("SELECT GET_LOCK('hotel_exchange_demo',20) acquired");if(!lock.acquired)throw Error('Hotel exchange demo initialization already running');locked=true;
  await c.beginTransaction();
  const [[city]]=await c.query("SELECT id,name,slug FROM cities WHERE slug='guiyang'");if(!city)throw Error('Guiyang city missing');result.city=city;
  const refs={};
  async function entity(kind,key,payload,scope){
   const seedKey=BATCH+':'+key;
   const [events]=await c.execute("SELECT payload FROM commerce_events WHERE event_type='demo.configuration.initialized' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.seed_key'))=?",[seedKey]);
   if(events.length){const receipt=parse(events[0].payload);const [[e]]=await c.execute('SELECT * FROM commerce_'+kind+' WHERE id=?',[receipt.entity_id]);if(!e||parse(e.payload).initialization?.mode!=='demo')throw Error('Demo receipt conflict: '+key);result.existing.push({kind,id:e.id});return {...e,payload:parse(e.payload)};}
   payload.initialization={...payload.initialization,batch:BATCH,mode:'demo',seed_key:seedKey,note:'酒店报名上线名单试点演示，系统初始化；不构成商户签约、人工复核或真实履约承诺，不发生资金往来。'};
   const [r]=await c.execute('INSERT INTO commerce_'+kind+'(name,city_id,vendor_id,merchant_id,store_id,payload,created_by,status,published_version,review_note) VALUES(?,?,?,?,?,?,0,\'published\',1,?)',[payload.name,city.id,scope.vendor_id||null,scope.merchant_id||null,scope.store_id||null,JSON.stringify(payload),'名单试点演示初始化；非真实商务审核']);
   if(kind==='merchants')await c.execute('UPDATE commerce_merchants SET merchant_id=id WHERE id=?',[r.insertId]);
   if(kind==='skus')await c.execute('INSERT INTO commerce_inventory(sku_id,total) VALUES(?,1000)',[r.insertId]);
   await c.execute('INSERT INTO commerce_versions(kind,entity_id,version,snapshot,reviewed_by) VALUES(?,?,1,?,0)',[kind,r.insertId,JSON.stringify(payload)]);
   const receipt={seed_key:seedKey,kind,entity_id:r.insertId};
   await c.execute('INSERT INTO commerce_events(aggregate_id,event_type,payload) VALUES(?,?,?)',[String(r.insertId),'demo.configuration.initialized',JSON.stringify(receipt)]);
   await c.execute('INSERT INTO commerce_audit(actor_id,city_id,merchant_id,action,resource,detail) VALUES(0,?,?,?,?,?)',[city.id,scope.merchant_id||null,'demo.initialize',kind+'/'+r.insertId,JSON.stringify(receipt)]);
   result.created.push({kind,id:r.insertId});return {id:r.insertId,version:1,published_version:1,city_id:city.id,...scope,payload};
  }
  async function vendor(key,name,intro){
   const vendorNo=BATCH+':'+key;
   let [[row]]=await c.execute('SELECT id,name FROM jz_vendors WHERE vendor_no=?',[vendorNo]);
   if(!row){const [r]=await c.execute("INSERT INTO jz_vendors(type,name,logo,address,city_ids,phone,rating,review_count,badges,start_price,unit,hours,vendor_no,status,review_status,intro) VALUES('hotel',?,NULL,?,NULL,0,0,0,?,0,'起','09:00—18:00（演示）',?,'active','pending',?)",[name,'试点名单演示接入（无实际接待地址）',JSON.stringify(['试点演示']),vendorNo,intro]);row={id:r.insertId,name};result.created.push({kind:'channel_vendors',id:row.id});}
   else result.existing.push({kind:'channel_vendors',id:row.id});
   refs[key]={vendor:row};return row;
  }
  const sampled=sampleHotels(roster.hotels,perTier);result.sampled=sampled.length;
  // 1) 事业群（战区）商户：每档抽样酒店按战区归属。
  const warZones=[...new Set(sampled.map(h=>h.war_zone))].sort();
  for(const war of warZones){
   await vendor('war:'+war,war+'（酒店通兑试点演示）','来自报名上线名单的事业群；演示环境不提供真实入住与履约。');
   const v=refs['war:'+war].vendor;
   const merchant=await entity('merchants','merchant:war:'+war,{name:v.name,vendor_id:v.id,city_id:city.id,contract_ref:'DEMO-NO-CONTRACT',contact:'演示服务台',phone:'未开通',description:war+'报名上线酒店试点演示商户；无真实合同、服务承诺或可拨打电话。'},{vendor_id:v.id});
   const rule=await entity('rules','rule:war:'+war,{name:war+'通兑分配规则（演示）',merchant_id:merchant.id,beike_bps:0,channel_bps:0,floor_bps:0,description:'演示无佣金、无结算、无提现；展示金额不记入资金流水。'},{vendor_id:v.id,merchant_id:merchant.id});
   refs['war:'+war]={vendor:v,merchant,rule};
  }
  for(const h of sampled){
   const ref=refs['war:'+h.war_zone];
   await entity('stores','hotel:'+h.code,{name:h.name+'（试点演示）',merchant_id:ref.merchant.id,city_id:city.id,address:'上线名单收录门店（演示环境不提供实际入住）',phone:'未开通',capacity:3,lead_hours:0,service_channel:'store',kind:'hotel',exchange_tier:h.exchange_tier,hotel_code:h.code,hotel_brand:h.brand,hotel_region:h.region,hotel_branch:h.branch,hotel_war_zone:h.war_zone,description:h.brand+' · '+h.region+'（'+h.branch+'，'+h.war_zone+'）；OTA 报名价格档位 '+h.tier+' 元。试点演示数据，不提供真实入住。'},{vendor_id:ref.vendor.id,merchant_id:ref.merchant.id});
  }
  // 2) 通兑运营商户：每档一个锚点虚拟门店（capacity 0，不可直接预约）+ 每档一个通兑券 SKU。
  await vendor('exchange','筑城酒店通兑运营台（演示）','酒店通兑券的运营与档位锚点主体；演示环境无真实资金。');
  {
   const v=refs.exchange.vendor;
   const merchant=await entity('merchants','merchant:exchange',{name:v.name,vendor_id:v.id,city_id:city.id,contract_ref:'DEMO-NO-CONTRACT',contact:'演示服务台',phone:'未开通',description:'酒店通兑运营演示商户；锚点门店为虚拟服务台，不提供真实入住。'},{vendor_id:v.id});
   const rule=await entity('rules','rule:exchange',{name:'酒店通兑分配规则（演示）',merchant_id:merchant.id,beike_bps:0,channel_bps:0,floor_bps:0,description:'演示无佣金、无结算、无提现。'},{vendor_id:v.id,merchant_id:merchant.id});
   refs.exchange={vendor:v,merchant,rule};
   for(const tier of EXCHANGE_TIERS){
    const anchor=await entity('stores','anchor:'+tier.value,{name:tier.label+' 通兑锚点（虚拟，勿直接预约）',merchant_id:merchant.id,city_id:city.id,address:'线上通兑服务台（虚拟锚点门店）',phone:'未开通',capacity:0,lead_hours:0,service_channel:'store',exchange_tier:tier.value,description:'该档通兑券的档位锚点：券在发券时绑定锚点，预约时在档内任选试点名单酒店。产能为 0，不能直接预约本店。'},{vendor_id:v.id,merchant_id:merchant.id});
    refs['anchor:'+tier.value]={store:anchor};
    const tierMinor=tier.minor;
    const sku=await entity('skus','sku:exchange:'+tier.value,{name:'酒店通兑 · '+tier.label+'（试点名单任选，演示）',merchant_id:merchant.id,store_id:anchor.id,supply_minor:1,retail_minor:tierMinor,valid_days:90,redeem_channel:'offline',exchange_tier:tier.value,exchange_tier_minor:tierMinor,category_id:'hotel_exchange',description:'【演示】'+tier.label+' 酒店通兑券：同一价格档位内任选试点名单酒店，预约入住一晚。名单来自《门店长租价格建议及报名表》报名上线酒店（共 '+roster.meta.count+' 家，本演示抽样接入 '+sampled.length+' 家）。演示环境不提供真实入住与履约，不发生资金往来。',conditions:'线下到店核销：先在档内任选酒店与日期预约，入住当日出示动态码核销；一券一晚，90 天有效。试点演示，不构成真实预订或价格承诺。'},{vendor_id:v.id,merchant_id:merchant.id,store_id:anchor.id});
    refs['sku:exchange:'+tier.value]={sku,rule};
   }
  }
  // 3) 景点门票 / 餐饮（线下单店绑定）与线上核销演示券。
  async function simpleCategory(key,kindLabel,vendorName,storeName,skuName,priceMinor,categoryId,extra,skuDesc,skuConditions){
   await vendor(key,vendorName,kindLabel+'试点演示；无真实履约与资金。');
   const v=refs[key].vendor;
   const merchant=await entity('merchants','merchant:'+key,{name:v.name,vendor_id:v.id,city_id:city.id,contract_ref:'DEMO-NO-CONTRACT',contact:'演示服务台',phone:'未开通',description:kindLabel+'演示商户；无真实合同、服务承诺或可拨打电话。'},{vendor_id:v.id});
   const rule=await entity('rules','rule:'+key,{name:kindLabel+'分配规则（演示）',merchant_id:merchant.id,beike_bps:0,channel_bps:0,floor_bps:0,description:'演示无佣金、无结算、无提现。'},{vendor_id:v.id,merchant_id:merchant.id});
   const store=await entity('stores','store:'+key,{name:storeName,merchant_id:merchant.id,city_id:city.id,address:extra.storeAddress,phone:'未开通',capacity:30,lead_hours:0,service_channel:extra.serviceChannel||'store',...(extra.storePayload||{}),description:extra.storeDescription},{vendor_id:v.id,merchant_id:merchant.id});
   const sku=await entity('skus','sku:'+key,{name:skuName,merchant_id:merchant.id,store_id:store.id,supply_minor:1,retail_minor:priceMinor,valid_days:90,redeem_channel:extra.redeemChannel||'offline',category_id:categoryId,description:skuDesc,conditions:skuConditions},{vendor_id:v.id,merchant_id:merchant.id,store_id:store.id});
   refs[key]={vendor:v,merchant,rule,store};refs['sku:'+key]={sku,rule};return refs[key];
  }
  await simpleCategory('scenic','景点门票','筑城景区票务服务站（演示）','贵阳演示景区售票处（虚构，不提供实际入园）','城市漫游 · 景点门票（演示）',5550,'scenic_ticket',
   {storeAddress:'贵阳演示景区入口（虚构地址，无实际景区）',storeDescription:'演示预约入园，每日 30 个演示名额，不提供真实入园。'},
   '【演示】指定演示景区单人票一张，预约日期当日有效。演示环境不提供真实入园与履约，不发生资金往来。',
   '线下到店核销：提前预约当日出示动态码；一券一次，90 天有效。试点演示，不构成真实入园承诺。');
  await simpleCategory('dining','餐饮','筑城餐饮服务站（演示）','贵阳演示餐厅（虚构，不提供实际用餐）','本地风味 · 餐饮代金（演示）',6990,'dining',
   {storeAddress:'贵阳演示商圈（虚构地址，无实际门店）',storeDescription:'演示到店用餐核销，每日 30 个演示名额，不提供真实餐食。'},
   '【演示】演示餐厅餐饮代金券一张，到店核销。演示环境不提供真实餐食与履约，不发生资金往来。',
   '线下到店核销：提前预约当日出示动态码；一券一次，90 天有效。试点演示，不构成真实用餐承诺。');
  await simpleCategory('online','线上核销','筑城线上生活服务站（演示）','线上服务台（演示，虚拟门店）','线上生活咨询权益（演示）',1990,'online_service',
   {redeemChannel:'online',serviceChannel:'online',storeAddress:'线上（无实体门店）',storeDescription:'线上核销通道：无需预约，出示动态码由线上服务台确认。',storePayload:{kind:'online_counter'}},
   '【演示】线上生活咨询权益一次，免预约，出示动态码由线上服务台确认后核销。演示环境不提供真实服务，不发生资金往来。',
   '线上核销：无需预约门店，直接出示动态码；一券一次，90 天有效。试点演示。');
  // 4) 组合券包：通兑（120 元档）+ 门票 + 餐饮，展示三品类编排。
  const items=[['sku:exchange:t120','exchange'],['sku:scenic','scenic'],['sku:dining','dining']].map(([skuKey,refKey])=>{
   const v=refs[skuKey];if(!v)throw Error('Missing demo voucher: '+skuKey);
   return {sku_id:v.sku.id,sku_version:v.sku.published_version||1,rule_id:v.rule.id,rule_version:1,quantity:1,allocation_minor:v.sku.payload.retail_minor,sku:v.sku.payload,rule:v.rule.payload};
  });
  await entity('packages','package:lifestyle',{name:'本地生活 · 酒店通兑体验包（演示）',city_id:city.id,price_minor:items.reduce((s,i)=>s+i.allocation_minor,0),description:'【贵阳演示】酒店通兑（120元档任选一晚）+ 景点门票 + 餐饮代金，三品类各一张，单券 90 天有效；全部为试点演示权益，不发生资金往来。',items},{});
  await c.commit();return result;
 }catch(e){await c.rollback();throw e;}finally{if(locked)await c.query("SELECT RELEASE_LOCK('hotel_exchange_demo')").catch(()=>{});c.release();}
}

// clean：按 seed 收据反查本批次实体并删除；有业务单据（订单/卡券）引用时拒绝，演示购买数据需先清。
async function clean(pool){
 const c=await pool.getConnection();let locked=false;
 try{
  const [[lock]]=await c.query("SELECT GET_LOCK('hotel_exchange_demo',20) acquired");if(!lock.acquired)throw Error('Hotel exchange demo clean already running');locked=true;
  const [events]=await c.query("SELECT payload FROM commerce_events WHERE event_type='demo.configuration.initialized' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.seed_key')) LIKE '"+BATCH+":%'");
  const ids={};for(const e of events){const r=parse(e.payload);(ids[r.kind]=ids[r.kind]||[]).push(r.entity_id);}
  const kinds=Object.keys(ids);
  if(!kinds.length)return {removed:0,note:'本批次无演示实体'};
  const idIn=a=>'('+a.map(()=>'?').join(',')+')';
  for(const [table,column,kindList] of [['commerce_orders','product_id',['packages','plans']],['commerce_order_items','sku_id',['skus']],['commerce_coupons','merchant_id',['merchants']],['commerce_appointments','store_id',['stores']]]){
   const list=kinds.filter(k=>kindList.includes(k)).flatMap(k=>ids[k]);if(!list.length)continue;
   const [rows]=await c.execute(`SELECT id FROM ${table} WHERE ${column} IN ${idIn(list)} LIMIT 1`,list);
   if(rows.length)throw Error('本批次演示实体已有业务单据（'+table+'），先清理演示订单/卡券后再 clean');
  }
  await c.beginTransaction();
  let removed=0;
  for(const [sql,args] of [
   ['DELETE FROM commerce_inventory WHERE sku_id IN '+idIn(ids.skus||[]),ids.skus||[]],
   ['DELETE FROM commerce_versions WHERE '+kinds.map(k=>'(kind=? AND entity_id IN '+idIn(ids[k])+')').join(' OR '),kinds.flatMap(k=>[k,...ids[k]])],
   ...['packages','skus','stores','rules','merchants'].filter(k=>ids[k]).map(k=>['DELETE FROM commerce_'+k+' WHERE id IN '+idIn(ids[k]),ids[k]]),
   ['DELETE FROM commerce_events WHERE event_type=\'demo.configuration.initialized\' AND JSON_UNQUOTE(JSON_EXTRACT(payload,\'$.seed_key\')) LIKE ?', [BATCH+':%']],
  ]){if(!args.length&&!sql.includes('seed_key'))continue;const [r]=await c.execute(sql,args);removed+=r.affectedRows;}
  const [v]=await c.execute("DELETE FROM jz_vendors WHERE vendor_no LIKE ?",[BATCH+':%']);removed+=v.affectedRows;
  await c.commit();return {removed,by_kind:Object.fromEntries(kinds.map(k=>[k,ids[k].length]))};
 }catch(e){await c.rollback();throw e;}finally{if(locked)await c.query("SELECT RELEASE_LOCK('hotel_exchange_demo')").catch(()=>{});c.release();}
}
module.exports={BATCH,seed,clean,sampleHotels,roster};
