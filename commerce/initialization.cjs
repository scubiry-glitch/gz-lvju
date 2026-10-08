'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const DESIGN='/root/.openclaw/workspace/98wiki/projects/新居住券包与会员卡/新居住券包与会员卡系统需求与设计文档_v1.9.md';
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function readTopics(){const text=fs.readFileSync(path.join(ROOT,'juzhu-topic.html'),'utf8');const start=text.indexOf('var TOPICS = '),end=text.indexOf('\n  var topic =',start);if(start<0||end<0)throw Error('Topic source changed; review parser');const literal=text.slice(start+'var TOPICS = '.length,end).trim().replace(/;$/,'');return {topics:vm.runInNewContext('('+literal+')',Object.create(null),{timeout:1000}),sha256:hash(text)};}
const parseArray=value=>{if(!value)return [];if(Array.isArray(value))return value;try{const parsed=JSON.parse(value);if(Array.isArray(parsed))return parsed;}catch{}return String(value).split(',').map(s=>s.trim()).filter(Boolean);};
function buildPlan({topics,topicHash,designHash,city,skus,products,vendors}){
 const records=[],keys=new Set(),vendorById=new Map(vendors.map(v=>[v.id,v])),skuBySlug=new Map(skus.map(s=>[s.slug,s]));
 const add=(kind,key,payload,refs={},extra={})=>{if(keys.has(key))return;keys.add(key);records.push({kind,key,payload,refs,city_id:city.id,...extra});};
 const linked=new Map(),externalReason=slug=>/^(insurance-|finance-)/.test(slug)?'专题保险及额度服务保持原服务入口，不作为通用付费券':/^(recycle-|telecom-portability|community-groupbuy|asset-custody)/.test(slug)?'估价、咨询或非固定商品，不按零元付费券组包':null;
 const sourceSkus=[...new Set(Object.values(topics).flatMap(t=>[...t.journey.map(j=>j.sku),...t.picks.map(p=>p.slug)]))];
 for(const slug of sourceSkus){
  const sku=skuBySlug.get(slug);if(!sku||!sku.enabled)throw Error('Missing enabled topic SKU: '+slug);
  const candidates=products.filter(p=>p.channel_sku_id===sku.id&&p.status==='on'&&(p.city_id===null||p.city_id===city.id)&&vendorById.get(p.vendor_id)?.status==='active').filter(p=>{const ids=parseArray(vendorById.get(p.vendor_id).city_ids).map(Number);return !ids.length||ids.includes(city.id);});
  candidates.sort((a,b)=>Number(b.city_id===city.id)-Number(a.city_id===city.id)||Number(parseArray(vendorById.get(b.vendor_id).city_ids).map(Number).includes(city.id))-Number(parseArray(vendorById.get(a.vendor_id).city_ids).map(Number).includes(city.id))||a.id-b.id);
  const product=candidates[0],vendor=product&&vendorById.get(product.vendor_id);if(!vendor)throw Error('No existing supplier for topic SKU: '+slug);
  const merchantKey='merchant:'+vendor.id+':'+city.id,storeKey='store:'+vendor.id+':'+city.id;
  const source={topic_file:'juzhu-topic.html',channel_sku_id:sku.id,slug,product_id:product.id,vendor_id:vendor.id,source_price_minor:Math.round(Number(product.price)*100),source_price_unit:sku.price_unit,candidate_product_ids:candidates.map(p=>p.id)};
  add('merchants',merchantKey,{name:vendor.name,vendor_id:vendor.id,city_id:city.id,contract_ref:null,contact:null,phone:vendor.phone||null,description:'从生活服务频道既有商家档案关联。沈阳履约主体、合同及联系方式待核实。',initialization:{source:{table:'jz_vendors',id:vendor.id,original_address:vendor.address},missing:['沈阳履约授权','合同编号','业务联系人',...(!vendor.phone?['联系电话']:[])]}}, {},{vendor_id:vendor.id});
  add('stores',storeKey,{name:vendor.name+' · 沈阳服务点（待确认）',city_id:city.id,address:null,phone:vendor.phone||null,capacity:null,lead_hours:null,description:'拟用于沈阳权益履约，实际门店地址、预约名额及服务时段待商户确认。原档案地址仅作来源记录，不作为沈阳门店地址。',initialization:{source:{table:'jz_vendors',id:vendor.id,original_address:vendor.address},missing:['实际门店','沈阳服务地址','每日履约产能','提前预约时间','营业服务时段']}},{merchant_id:merchantKey},{vendor_id:vendor.id});
  const reason=externalReason(slug)||(Number(product.price)<=0?'原服务需要报价，不将零价格视为免费权益':null);
  linked.set(slug,{source,sku,product,vendor,merchantKey,storeKey,external:reason});
  if(reason)continue;
  const ruleKey='rule:'+vendor.id+':'+city.id;
  add('rules',ruleKey,{name:vendor.name+' · 权益分配规则',beike_bps:null,channel_bps:null,floor_bps:null,description:'供货报价、最低佣金标准与渠道比例待商务审核。v1.9中20%/50%为演算参考，不构成商户承诺。',initialization:{source:{document:'v1.9',section:'5.4.7 / 18.1'},missing:['贝壳佣金比例','渠道分佣比例','最低佣金率门槛']}},{merchant_id:merchantKey},{vendor_id:vendor.id});
  add('skus','sku:'+slug,{name:sku.name+'服务券',supply_minor:null,retail_minor:Math.round(Number(product.price)*100),valid_days:null,description:[sku.spec,...parseArray(sku.includes)].join('；'),conditions:[...parseArray(sku.service_notice),'频道展示价为参考'+sku.price_unit+'，券服务规格、有效期、供货报价与适用门店以复核后版本为准。'].join('；'),initialization:{source,missing:['商户供货报价','券有效期','券规格及实际成交价确认','可售库存与门店产能']}},{merchant_id:merchantKey,store_id:storeKey},{vendor_id:vendor.id});
 }
 for(const [slug,topic]of Object.entries(topics)){
  const core=topic.journey.filter(j=>!linked.get(j.sku).external&&!j.when.includes('可选'));
  const related=[...new Set([...topic.journey.map(j=>j.sku),...topic.picks.map(p=>p.slug)])].filter(s=>!core.some(c=>c.sku===s)).map(s=>({name:linked.get(s).sku.name,slug:s,href:'juzhu-jiazheng-detail.html?sku='+encodeURIComponent(s)+'&city='+encodeURIComponent(city.slug),reason:linked.get(s).external||'专题可选服务，未纳入基础组合'}));
  const items=core.map(j=>({sku_key:'sku:'+j.sku,rule_key:'rule:'+linked.get(j.sku).vendor.id+':'+city.id,quantity:1,allocation_minor:null}));
  if(!items.length)throw Error('Topic has no service-voucher items: '+slug);
  add('packages','package:topic:'+slug,{name:topic.title+' · 专题券包',city_id:city.id,price_minor:null,description:topic.lede+' '+topic.bundle.items.join('；'),items,initialization:{source:{topic_id:slug,topic_url:'juzhu-topic.html?id='+slug,topic_sha256:topicHash},reference_total_minor:core.reduce((s,j)=>s+Math.round(Number(linked.get(j.sku).product.price)*100),0),reference_price_note:'仅为频道展示参考价合计，包含起价或按期服务，非券包最终售价。',related_services:related,missing:['券包零售价','逐券分摊金额','关联商户及门店审核','供货与分配规则确认']}});
 }
 const memberItems=[['cleaning','保洁',19980,['cleaning-daily-2h','raw-clean-new']],['repair','维修',13320,['appliance-repair']],['moving','搬家',27750,['moving-city-standard']],['travel','旅居',33300,[]],['report','报告',5550,['asset-appraisal']]];
 for(const [key,name,allocation,slugs]of memberItems){
  add('skus','sku:membership:'+key,{name:'新居住会员 · '+name+'权益券',merchant_id:null,store_id:null,supply_minor:null,retail_minor:null,valid_days:null,description:'v1.9沈阳L1基础权益中的'+name+'服务，单券单次独立发放及核销。具体服务规格与供应商需按18.1逐券确认。',conditions:'需预约；券有效期独立于会员有效期；未使用到期自动申请原路退款。具体适用范围以审核版本为准。',initialization:{source:{document:'v1.9',section:'5.4.7 / 5.4.8 / 18.1',design_sha256:designHash},reference_allocation_minor:allocation,candidate_channel_skus:slugs.map(s=>linked.get(s)?.source).filter(Boolean),missing:['履约商户','实际门店','服务规格','供货报价','零售价口径','券有效期']}});
  add('rules','rule:membership:'+key,{name:'新居住会员 · '+name+'分配规则',merchant_id:null,beike_bps:null,channel_bps:null,floor_bps:null,description:'按v1.9逐券商务模板补齐实际供应商报价与佣金依据，未确认前不使用文档演算值代替真实条件。',initialization:{source:{document:'v1.9',section:'18.1'},missing:['履约商户','报价与佣金合同','佣金比例及门槛']}});
 }
 add('packages','package:membership:l1',{name:'新居住基础权益礼包',city_id:city.id,price_minor:99900,description:'沈阳试点L1基础权益：保洁、维修、搬家、旅居、报告各一张。独立券包商品，也作为新居住会员赠送权益。供应商、服务规格与单券有效期待逐项确认。',items:memberItems.map(([key])=>({sku_key:'sku:membership:'+key,rule_key:'rule:membership:'+key,quantity:1,allocation_minor:null})),initialization:{source:{document:'v1.9',section:'5.4.7 / 5.4.8',design_sha256:designHash},reference_allocation_minor:memberItems.map(([,name,amount])=>({name,amount})),missing:['五项正式供应商及服务规格','逐券分摊审批','商户报价与规则']}});
 add('plans','plan:membership:l1',{name:'新居住会员',city_id:city.id,price_minor:99900,valid_days:365,description:'沈阳L1基础会员，999元/年；开通后一次性赠送基础权益礼包，保洁、维修、搬家、旅居、报告各一张。会员与券有效期独立，不因会员到期自动作废已发券。一期仅配置此卡种。',initialization:{source:{document:'v1.9',section:'3.3 / 5.4.8',design_sha256:designHash},missing:['赠送礼包及五项供给完成审核']}},{package_id:'package:membership:l1'});
 return {batch:'living-topics-v19-shenyang-v1',city,topicHash,designHash,records};
}
async function loadPlan(pool){const {topics,sha256}=readTopics(),design=fs.readFileSync(DESIGN,'utf8');if(!design.includes('一期只上架一个卡种')||!design.includes('999'))throw Error('Design assumptions changed');const [[city]]=await pool.query("SELECT id,name,slug FROM cities WHERE slug='shenyang'");if(!city)throw Error('Shenyang city is not configured');const [skus]=await pool.query('SELECT * FROM jz_skus WHERE enabled=1');const [products]=await pool.query("SELECT id,vendor_id,city_id,price,channel_sku_id,status FROM jz_products WHERE status='on'");const [vendors]=await pool.query('SELECT id,type,name,status,city_ids,address,phone FROM jz_vendors');return buildPlan({topics,topicHash:sha256,designHash:hash(design),city,skus,products,vendors});}
async function applyPlan(pool,plan){
 const c=await pool.getConnection(),ids=new Map(),result={batch:plan.batch,created:[],existing:[]};let locked=false;
 try{const [[lock]]=await c.query("SELECT GET_LOCK('commerce_topic_initialization',30) acquired");if(!lock.acquired)throw Error('Initialization already running');locked=true;await c.beginTransaction();
  for(const record of plan.records){
   const [events]=await c.execute("SELECT payload FROM commerce_events WHERE event_type='configuration.initialized' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.seed_key'))=?",[plan.batch+':'+record.key]);
   if(events.length){const saved=typeof events[0].payload==='string'?JSON.parse(events[0].payload):events[0].payload;if(saved.kind!==record.kind)throw Error('Seed kind conflict');const [rows]=await c.execute('SELECT id FROM commerce_'+record.kind+' WHERE id=?',[saved.entity_id]);if(!rows.length)throw Error('Initialized record missing; manual reconciliation required');ids.set(record.key,saved.entity_id);result.existing.push({kind:record.kind,id:saved.entity_id,key:record.key});continue;}
   const payload=JSON.parse(JSON.stringify(record.payload));for(const [field,key]of Object.entries(record.refs)){if(!ids.has(key))throw Error('Unresolved seed dependency: '+key);payload[field]=ids.get(key);}
   if(payload.items)payload.items=payload.items.map(item=>{const {sku_key,rule_key,...rest}=item;if(!ids.has(sku_key)||!ids.has(rule_key))throw Error('Unresolved package item');return {...rest,sku_id:ids.get(sku_key),rule_id:ids.get(rule_key)};});
   // Batch initialization records provenance, never invents human submission or approval.
   payload.initialization={...payload.initialization,seed_key:plan.batch+':'+record.key};
   const [insert]=await c.execute('INSERT INTO commerce_'+record.kind+"(name,city_id,vendor_id,merchant_id,store_id,payload,created_by,status) VALUES(?,?,?,?,?,?,0,'draft')",[payload.name,record.city_id,record.vendor_id||null,payload.merchant_id||null,payload.store_id||null,JSON.stringify(payload)]);
   const entityId=insert.insertId;ids.set(record.key,entityId);if(record.kind==='merchants')await c.execute('UPDATE commerce_merchants SET merchant_id=id WHERE id=?',[entityId]);if(record.kind==='skus')await c.execute('INSERT INTO commerce_inventory(sku_id,total) VALUES(?,0)',[entityId]);
   const receipt={seed_key:plan.batch+':'+record.key,kind:record.kind,entity_id:entityId,digest:hash(payload),source:payload.initialization.source};
   await c.execute('INSERT INTO commerce_events(aggregate_id,event_type,payload) VALUES(?,?,?)',[String(entityId),'configuration.initialized',JSON.stringify(receipt)]);
   await c.execute('INSERT INTO commerce_audit(actor_id,city_id,merchant_id,action,resource,detail) VALUES(0,?,?,?,?,?)',[record.city_id,payload.merchant_id||null,'configuration.initialize',record.kind+'/'+entityId,JSON.stringify(receipt)]);
   result.created.push({kind:record.kind,id:entityId,key:record.key,name:payload.name});
  }
  await c.commit();return result;
 }catch(e){await c.rollback();throw e;}finally{if(locked)await c.query("SELECT RELEASE_LOCK('commerce_topic_initialization')").catch(()=>{});c.release();}
}
module.exports={loadPlan,buildPlan,applyPlan,readTopics,hash};
