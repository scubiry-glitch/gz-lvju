'use strict';
// Idempotent, explicitly unfunded fixture for sytest. Run with --apply after review.
const {createPool}=require('../../commerce/db.cjs');
const {SEED,PRODUCT_MARKER}=require('../../commerce/demo-life-checkout.cjs');
const parse=v=>typeof v==='string'?JSON.parse(v):v;
async function run(){
 const apply=process.argv.includes('--apply'),pool=createPool(),out={mode:apply?'apply':'dry-run',seed:SEED,product:null,voucher:null};
 const c=await pool.getConnection();try{
  const [[source]]=await c.execute("SELECT p.*,v.status AS vendor_status,v.payment_mode FROM jz_products p JOIN jz_vendors v ON v.id=p.vendor_id WHERE p.query='guiyang-life-demo-v1:sku:1' AND p.status='on' LIMIT 1");
  if(!source||source.vendor_status!=='active'||source.payment_mode==='pay_center'||String(source.price)!=='128.00'&&Number(source.price)!==128)throw Error('Reference demo cleaning product is not ready');
  const [[baseSku]]=await c.execute("SELECT * FROM commerce_skus WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.initialization.seed_key'))='guiyang-life-demo-v1:sku:cleaning-daily-2h' AND status='published' LIMIT 1");
  if(!baseSku)throw Error('Reference demo voucher is missing');
  const [[admin]]=await c.execute("SELECT id FROM accounts WHERE login_name='admin' AND status='active' LIMIT 1");
  if(!admin)throw Error('Admin account is missing');
  const [[existingProduct]]=await c.execute('SELECT id,title FROM jz_products WHERE query=? LIMIT 1',[PRODUCT_MARKER]);
  const [[existingSku]]=await c.execute("SELECT id,name,payload FROM commerce_skus WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.initialization.seed_key'))=? LIMIT 1",[SEED]);
  if(existingSku){const p=parse(existingSku.payload);if(p.initialization?.mode!=='demo'||p.use_mode!=='amount_offset'||Number(p.demo_face_minor)!==5000)throw Error('Existing voucher conflicts with this demo fixture');}
  out.product=existingProduct||{title:'日常保洁 · 2小时（抵用测试）',price_minor:12800,category:'cleaning',vendor_id:source.vendor_id,city_id:source.city_id};
  out.voucher=existingSku?{id:existingSku.id,name:existingSku.name}:{name:'保洁品类 ¥50 抵用券（无资金演示）',face_minor:5000};
  if(!apply){console.log(JSON.stringify(out));return;}
  await c.beginTransaction();
  let productId=existingProduct?.id;
  if(!productId){
   const [r]=await c.execute(`INSERT INTO jz_products(vendor_id,city_id,title,subtitle,category,duration_hours,unit,price,original_price,earliest_time,advance_booking_hours,sales_count,rating,service_tags,channel_sku_id,query,status,sort_order)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[source.vendor_id,source.city_id,'日常保洁 · 2小时（抵用测试）','无资金演示；不提供真实服务',source.category,source.duration_hours,source.unit,128,128,'演示预约',0,0,0,JSON.stringify(['抵用测试','无资金演示']),null,PRODUCT_MARKER,'on',source.sort_order||0]);
   productId=r.insertId;
  }
  // The standalone demo page finds this product by its marker. Keep it off the
  // public service shelf so it cannot replace or alter the regular checkout CTA.
  await c.execute('UPDATE jz_products SET channel_sku_id=NULL WHERE id=? AND query=?',[productId,PRODUCT_MARKER]);
  let skuId=existingSku?.id;
  if(!skuId){
   const payload={...parse(baseSku.payload),name:'保洁品类 ¥50 抵用券（无资金演示）',retail_minor:5000,demo_face_minor:5000,
    description:'贵阳日常保洁测试商品抵用 ¥50，仅用于无资金流程演示。',
    conditions:'仅适用「日常保洁 · 2小时（抵用测试）」；模拟差额 ¥78 不扣款，不提供真实服务。',
    use_mode:'amount_offset',use_domains:['jiazheng'],use_vendor_ids:[Number(source.vendor_id)],life_product_ids:[Number(productId)],
    initialization:{mode:'demo',batch:SEED,seed_key:SEED,note:'无资金演示初始化；不代表真实购买、商户签约或资金结算。'}};
   const [r]=await c.execute("INSERT INTO commerce_skus(name,city_id,vendor_id,merchant_id,store_id,payload,created_by,status,published_version,review_note) VALUES(?,?,?,?,?,?,0,'published',1,?)",
    [payload.name,source.city_id,source.vendor_id,baseSku.merchant_id,baseSku.store_id,JSON.stringify(payload),'无资金演示初始化；非真实商务审核']);
   skuId=r.insertId;
   await c.execute("INSERT INTO commerce_versions(kind,entity_id,version,snapshot,reviewed_by) VALUES('skus',?,1,?,0)",[skuId,JSON.stringify(payload)]);
   await c.execute('INSERT INTO commerce_inventory(sku_id,total) VALUES(?,100)',[skuId]);
   await c.execute("INSERT INTO commerce_events(aggregate_id,event_type,payload) VALUES(?,'demo.configuration.initialized',?)",[String(skuId),JSON.stringify({seed_key:SEED,kind:'skus',entity_id:skuId})]);
   await c.execute('INSERT INTO commerce_audit(actor_id,city_id,merchant_id,action,resource,detail) VALUES(0,?,?,?,?,?)',
    [source.city_id,baseSku.merchant_id,'demo.initialize','skus/'+skuId,JSON.stringify({seed_key:SEED,financial_posting:false})]);
  }
  await c.commit();out.product={id:productId,title:'日常保洁 · 2小时（抵用测试）',price_minor:12800};out.voucher={id:skuId,name:'保洁品类 ¥50 抵用券（无资金演示）',face_minor:5000};console.log(JSON.stringify(out));
 }catch(e){try{await c.rollback();}catch{}throw e;}finally{c.release();await pool.end();}
}
run().catch(e=>{console.error(e.code||e.message);process.exitCode=1});
