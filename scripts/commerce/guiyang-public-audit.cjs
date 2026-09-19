'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
async function run({browser,origin,check}){
 const output=path.resolve(__dirname,'../../docs/verification/guiyang-life-demo');fs.mkdirSync(output,{recursive:true});
 const city=encodeURIComponent('贵阳');let skus,catalog;
 const get=async route=>{const r=await fetch(origin+route);assert.equal(r.status,200,route);return r.json();};
 await check('Guiyang public catalogue has 12 populated categories and complete service details',async()=>{
  skus=(await get('/api/juzhu/jiazheng/skus?city='+city)).items;assert(skus.length>=46);assert.equal(new Set(skus.map(s=>s.category_id)).size,12);
  for(let offset=0;offset<skus.length;offset+=6)await Promise.all(skus.slice(offset,offset+6).map(async sku=>{const d=await get('/api/juzhu/jiazheng/skus/'+sku.slug+'?city='+city);assert(d.product&&d.product.city_id===3,sku.slug);assert(d.vendor?.name.includes('演示'),sku.slug);assert(d.workers?.length,sku.slug);assert(d.item.includes?.length&&d.item.service_flow?.length,sku.slug);assert.equal(d.product.sales_count,0);}));
 });
 await check('Guiyang public single vouchers, five topics and member expose demo purchase only',async()=>{
  catalog=(await get('/api/commerce/v1/catalog?city='+city)).data;assert.equal(catalog.filter(p=>p.kind==='skus').length,38);assert.equal(catalog.filter(p=>p.kind==='packages').length,6);assert.equal(catalog.filter(p=>p.kind==='plans').length,1);assert(catalog.every(p=>p.city_id===3&&p.is_demo&&p.demo_purchase_enabled));assert.equal(new Set(catalog.filter(p=>p.topic_id).map(p=>p.topic_id)).size,5);
  assert(!(await get('/api/commerce/v1/catalog?city=shenyang')).data.some(p=>p.city_id===3));assert.deepEqual((await get('/api/commerce/v1/catalog?city=missing-city')).data,[]);
 });
 await check('Guiyang channel, 12 category pages, five topic links and single-voucher detail connect',async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.goto(origin+'/index.html?tab=jiazheng&city='+city);await page.waitForSelector('#jzCoupon a[href*="product=skus"]');assert.equal(await page.locator('.jz-cat-grid a').count(),12);await page.screenshot({path:path.join(output,'guiyang-channel-390.png')});
   for(const category of [...new Set(skus.map(s=>s.category_id))]){await page.goto(origin+'/juzhu-jiazheng-list.html?type='+category+'&city='+city);await page.waitForFunction(()=>document.querySelectorAll('#list a[href*="detail"]').length>0);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
   for(const topic of ['new-home','care','asset','green','neighbor']){await page.goto(origin+'/juzhu-topic.html?id='+topic+'&city='+city);await page.waitForSelector('.j-step .svc');const link=page.locator('a[href*="juzhu-commerce.html"]');assert((await link.getAttribute('href')).includes('topic='+topic));assert(new URL(await link.getAttribute('href'),origin).searchParams.get('city')==='贵阳');}
   await page.goto(origin+'/juzhu-jiazheng-detail.html?sku=cleaning-daily-2h&city='+city);await page.waitForSelector('.demo-service-note');await page.screenshot({path:path.join(output,'guiyang-service-detail-390.png')});await page.locator('#submitBtn').click();await page.waitForURL('**/juzhu-voucher.html?**');await page.waitForSelector('.consumer-product-detail');assert((await page.locator('#commerce-content').innerText()).includes('演示')); 
   await page.screenshot({path:path.join(output,'guiyang-single-detail-390.png')});assert.deepEqual(errors,[]);
  }finally{await context.close();}
 });
 fs.writeFileSync(path.join(output,'public-catalog.json'),JSON.stringify({at:new Date().toISOString(),channel_services:skus.length,categories:12,products:catalog,data_mutations:0},null,2));
}
module.exports={run};
