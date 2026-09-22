'use strict';
// Read-only wallet visual audit. All account/catalog responses are browser-local
// route stubs; no network mutation or real login is performed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.COMMERCE_PLAYWRIGHT_MODULE || '/tmp/e2e/node_modules/playwright-core');
const origin = (process.env.COMMERCE_ORIGIN || 'https://sytest.meizu.life').replace(/\/$/, '');
const out = path.resolve(__dirname, '../../docs/verification/member-wallet');
const now = Date.now();
const iso = n => new Date(now + n * 86400000).toISOString();
const assets = {
  coupons: [
    {id:'coupon-available-0001', name:'贵阳深度保洁券', description:'全屋深度保洁服务，包含厨房、卫生间和客厅区域，适用于新居入住前的完整清洁。', status:'available', expires_at:iso(30), redeem_channel:'store', is_demo:true},
    {id:'coupon-online-0002', name:'线上家电清洗券', description:'线上提交服务需求，确认后由授权服务商安排家电清洗。', status:'available', expires_at:iso(30), redeem_channel:'online', is_demo:true},
    {id:'coupon-used-0003', name:'开荒保洁券', description:'新居开荒保洁演示权益。', status:'redeemed', expires_at:iso(10), redeem_channel:'store', is_demo:true},
    {id:'coupon-expired-0004', name:'搬家服务券', description:'同城搬家服务演示权益。', status:'available', expires_at:iso(-2), redeem_channel:'store', is_demo:true},
    {id:'coupon-frozen-0005', name:'家电维修券', description:'售后处理中，权益暂时冻结。', status:'frozen', expires_at:iso(30), redeem_channel:'store', is_demo:true}
  ], appointments:[{coupon_id:'coupon-available-0001',status:'booked',service_date:iso(5)}], memberships:[]
};
const catalog = [{id:'plan-001',kind:'plans',name:'新居住会员',price_minor:99900,valid_days:365,is_demo:true,items:[{name:'保洁券',quantity:5,description:'会员赠券',valid_days:365,conditions:'演示'}]}];
function payload(data){return {data};}
async function main(){
 fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({executablePath:process.env.COMMERCE_CHROME||'/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
 const checks=[];const errors=[];
 for(const width of [320,390]){
  const context=await browser.newContext({viewport:{width,height:844},permissions:['clipboard-read','clipboard-write']});
  await context.addInitScript(()=>localStorage.setItem('BZF_SESSION_TOKEN','visual-audit-local-token'));
  const page=await context.newPage();page.on('pageerror',e=>errors.push({width,message:e.message}));
  await page.route('**/api/commerce/v1/**',async route=>{
   const request=route.request(),url=new URL(request.url()),p=url.pathname.replace('/api/commerce/v1','');
   if(p==='/me') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload({account:{display_name:'视觉审计用户'},permissions:['*'] }))});
   if(p==='/my') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload(assets))});
   if(p==='/catalog') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload(catalog))});
   if(/^\/coupons\/[^/]+\/token$/.test(p)) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload({coupon_id:'coupon-available-0001',token:'a'.repeat(32),expires_in:2}))});
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload({}))});
  });
  await page.goto(origin+'/juzhu-commerce.html?view=coupons&city=贵阳',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>{const c=document.querySelector('#commerce-content');return c&&!c.hasAttribute('aria-busy')&&c.querySelector('.consumer-asset-card')});
  const stateData=await page.locator('.consumer-asset-card').evaluateAll(cards=>cards.map(card=>({text:card.innerText,state:[...card.querySelectorAll('.asset-status')].map(x=>x.textContent.trim())[0],buttons:[...card.querySelectorAll('[data-action]')].map(x=>x.textContent.trim()),height:card.getBoundingClientRect().height,overflow:card.scrollWidth>card.clientWidth+1})));
  assert.equal(stateData.length,5,'mock wallet should render all states');
  assert.deepEqual(stateData.map(x=>x.state),['可使用','可使用','已核销','已过期','售后处理中']);
  const indexed=await page.locator('.consumer-asset-card').evaluateAll(cards=>cards.map(card=>({hasBooking:!!card.querySelector('[data-action="book"]'),hasCode:!!card.querySelector('[data-action="code"]'),hasCase:!!card.querySelector('[data-action="case"]'),hasDetail:!!card.querySelector('[data-action="coupon-detail"]'),hasProgress:!!card.querySelector('[data-tab="cases"]'),id:card.querySelector('.asset-id b')?.textContent.trim(),copy:card.querySelector('[data-action="copy-coupon-id"]')?.textContent.trim()})));
  assert.deepEqual(indexed.map(x=>[x.hasBooking,x.hasCode,x.hasCase,x.hasDetail,x.hasProgress]),[[true,true,true,true,false],[false,true,true,true,false],[false,false,false,true,false],[false,false,false,true,false],[false,false,false,true,true]]);
  assert(indexed.every(x=>x.id&&x.id.length===8&&x.copy==='复制券编号'),'wallet keeps short ID plus copy entry');
  assert(stateData.every(x=>x.height>0&&!x.overflow),'cards keep layout with no horizontal overflow');
  const actionHeights=await page.locator('.consumer-asset-card [data-action]').evaluateAll(btns=>btns.map(b=>b.getBoundingClientRect().height));
  assert(actionHeights.every(h=>h>=44-0.5),JSON.stringify(actionHeights));
  await page.screenshot({path:path.join(out,'wallet-mock-'+width+'.png'),fullPage:false});
  // Copy action must use the full ID despite only the last 8 digits being displayed.
  await page.locator('.consumer-asset-card').first().locator('[data-action="copy-coupon-id"]').click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'coupon-available-0001');
  checks.push({width,name:'coupon states, CTA gating, compact IDs, 44px controls',passed:true});
  // QR dialog: QR box remains stable after expiry, and the refresh control stays available.
  await page.locator('.consumer-asset-card').first().locator('[data-action="code"]').click();
  await page.waitForSelector('.voucher-code-dialog .voucher-qr');
  const before=await page.locator('.voucher-code-dialog .voucher-qr').boundingBox();
  await page.waitForTimeout(2200);
  const expired=await page.locator('.voucher-code-dialog .qr-expired').count();
  const after=await page.locator('.voucher-code-dialog .voucher-qr').boundingBox();
  assert.equal(expired,1,'expired QR explains next action');
  assert(before&&after&&Math.abs(before.height-after.height)<2,JSON.stringify({before,after}));
  assert.equal(await page.locator('.voucher-code-dialog .refresh-code').isVisible(),true);
  await page.screenshot({path:path.join(out,'wallet-qr-expired-'+width+'.png'),fullPage:false});
  await page.locator('.voucher-code-dialog .refresh-code').click();
  await page.waitForSelector('.voucher-code-dialog .voucher-qr svg');
  assert.equal(await page.locator('.voucher-code-dialog .qr-expired').count(),0,'refresh regenerates QR');
  checks.push({width,name:'QR expiry preserves box and refresh action',passed:true});
  await context.close();
 }
 assert.deepEqual(errors,[]);
 const result={passed:true,checks,page_errors:errors,captured_at:new Date().toISOString(),data_mutations:0};
 fs.writeFileSync(path.join(out,'consumer-wallet-visual-audit.json'),JSON.stringify(result,null,2)+'\n');
 await browser.close();console.log('PASS consumer wallet visual audit: '+checks.length+' checks; zero page errors');
}
main().catch(async e=>{fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'consumer-wallet-visual-audit.json'),JSON.stringify({passed:false,error:e.stack||String(e),captured_at:new Date().toISOString(),data_mutations:0},null,2)+'\n');console.error(e.stack||e);process.exitCode=1;});
