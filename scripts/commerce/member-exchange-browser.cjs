'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
async function run({browser,origin,actors,check}){
 const out=path.resolve(__dirname,'../../docs/verification/member-wallet');fs.mkdirSync(out,{recursive:true});
 const admin=await browser.newContext({viewport:{width:1280,height:900}}),user=await browser.newContext({viewport:{width:390,height:844},permissions:['clipboard-read','clipboard-write']});
 await admin.addInitScript(token=>localStorage.setItem('BZF_SESSION_TOKEN',token),actors.writer.token);await user.addInitScript(token=>localStorage.setItem('BZF_SESSION_TOKEN',token),actors.user.token);
 const a=await admin.newPage(),p=await user.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));a.on('pageerror',e=>errors.push(e.message));let code;
 const ready=()=>p.waitForFunction(()=>document.querySelector('#commerce-content .commerce-card')&&!document.querySelector('#commerce-content').hasAttribute('aria-busy'));
 const readyAdmin=()=>a.waitForFunction(()=>!document.querySelector('#commerce-content')?.hasAttribute('aria-busy')&&document.querySelector('#commerce-content .commerce-card'));
 try{
 await check('Browser admin issues one-time member code and customer redeems through My',async()=>{
  await a.goto(origin+'/screens/commerce-admin-plans.html');await a.locator('[data-action=issue-code]').first().click();await a.waitForSelector('#commerce-dialog [name=product]');await a.locator('#commerce-dialog [type=submit]').click();await a.waitForSelector('#commerce-dialog textarea[readonly]');code=(await a.locator('#commerce-dialog textarea').inputValue()).trim();assert(/^NL[A-F0-9]{32}$/.test(code));
  await p.goto(origin+'/juzhu-commerce.html?city=guiyang&view=account');await ready();assert.equal(await p.locator('#account-logout').isVisible(),false);await p.locator('[data-action=exchange]').click();await p.locator('[name=code]').fill(code);await p.locator('[name=demo_ack]').check();await p.screenshot({path:path.join(out,'exchange-390.png')});await p.getByRole('button',{name:'确认兑换',exact:true}).click();await p.waitForSelector('#commerce-dialog',{state:'detached'});await p.waitForSelector('.member-pass.is-owned');assert((await p.locator('#commerce-content').innerText()).includes('兑换成功'));assert.equal(await p.locator('#commerce-tabs [aria-current]').getAttribute('data-tab'),'memberships');assert.equal(await p.locator('.member-benefit').count(),5);
  await p.locator('.member-benefit summary').first().click();assert((await p.locator('.member-benefit[open]').innerText()).includes('使用条件'));await p.screenshot({path:path.join(out,'membership-owned-390.png')});
 });
 await check('Browser coupon wallet filters available, used and expired states',async()=>{
  await p.goto(origin+'/juzhu-commerce.html?city=guiyang&view=coupons');await ready();
  const chips=p.locator('.coupon-filter button');assert.equal(await chips.count(),4,'all/available/used/expired chips');
  const chipNum=async i=>Number((await chips.nth(i).innerText()).replace(/[^\d]/g,''));
  const totalAll=await chipNum(0),availableAll=await chipNum(1),usedAll=await chipNum(2);
  assert(availableAll>0&&usedAll>=1&&availableAll+usedAll<=totalAll,'wallet spans usable and consumed coupons');
  await chips.nth(1).click();await ready();
  assert.equal(await p.locator('#commerce-content article.commerce-card').count(),availableAll);
  assert((await p.locator('#commerce-content').innerText()).includes('可使用'));
  await p.screenshot({path:path.join(out,'coupons-filter-available-390.png')});
  await chips.nth(2).click();await ready();
  assert.equal(await p.locator('#commerce-content article.commerce-card').count(),usedAll);
  assert((await p.locator('#commerce-content').innerText()).includes('已核销'));
  const expiredAll=await chipNum(3);
  await chips.nth(3).click();await ready();
  if(expiredAll===0)assert((await p.locator('#commerce-content').innerText()).includes('该状态下暂无卡券'),'empty filtered state stays usable');
  else assert.equal(await p.locator('#commerce-content article.commerce-card').count(),expiredAll);
  await p.screenshot({path:path.join(out,'coupons-filter-empty-390.png')});
  await p.locator('[data-coupon-filter=all]').click();await ready();
  assert.equal(await p.locator('#commerce-content article.commerce-card').count(),totalAll);
 });
 await check('Browser merchant redemption preview explains denial without any side effect',async()=>{
  const couponId=await p.evaluate(async()=>(await COMMERCE.api('/my')).coupons.find(c=>c.status==='available').id);
  const merchant=await browser.newContext();await merchant.addInitScript(t=>localStorage.setItem('BZF_SESSION_TOKEN',t),actors.merchant.token);const m=await merchant.newPage();let mError=null;m.on('pageerror',e=>{mError=e.message;});
  await m.goto(origin+'/screens/commerce-merchant-redemptions.html');await m.waitForFunction(()=>!document.querySelector('#commerce-content')?.hasAttribute('aria-busy')&&document.querySelector('#commerce-content .commerce-card'));
  await m.locator('[data-action=redeem]').click();
  await m.locator('[name=coupon_id]').fill(couponId);await m.locator('[name=token]').fill('0'.repeat(32));
  await m.locator('[data-preview]').click();
  await m.waitForSelector('.redeem-preview');assert((await m.locator('.redeem-preview').innerText()).includes('无法核销：不允许访问其他商户的数据'),'explicit cross-merchant denial');
  assert.equal(await m.locator('.redeem-preview .detail-row').count(),0,'preview denied before showing any service');
  await m.screenshot({path:path.join(out,'merchant-redeem-preview-1440.png')});await merchant.close();assert.equal(mError,null);
 });
 await check('Browser exchange-code console batch issues, disables and queries redemption records',async()=>{
  await a.goto(origin+'/screens/commerce-admin-exchanges.html');await readyAdmin();
  await a.getByRole('button',{name:'批量发码',exact:true}).click();await a.waitForSelector('#commerce-dialog [name=product]');
  const productName=await a.locator('[name=product]').evaluate(e=>e.selectedOptions[0].textContent.split('（')[0]);
  await a.locator('[name=quantity]').fill('3');await a.locator('#commerce-dialog [type=submit]').click();
  await a.waitForSelector('#commerce-dialog textarea[readonly]');
  const codes=(await a.locator('#commerce-dialog textarea').inputValue()).trim().split('\n');assert.equal(codes.length,3);assert.deepEqual([...new Set(codes)].length,3);
  await a.screenshot({path:path.join(out,'exchange-batch-issued.png')});
  await a.getByRole('button',{name:'关闭',exact:true}).last().click();await readyAdmin();
  const stoppable=a.locator('tr').filter({hasText:productName}).filter({has:a.getByRole('button',{name:'停用'})}).first();
  await stoppable.getByRole('button',{name:'停用',exact:true}).click();await a.getByRole('button',{name:'确认保存',exact:true}).click();await a.waitForSelector('#commerce-dialog',{state:'detached'});await readyAdmin();
  assert(await a.locator('tr').filter({hasText:productName}).filter({hasText:'已停用'}).count()>=1,'disabled state shows in console');
  await a.screenshot({path:path.join(out,'exchange-console-disable.png')});
  await a.locator('[name=state]').selectOption('redeemed');await a.getByRole('button',{name:'查询',exact:true}).click();await readyAdmin();
  const recordText=await a.locator('#commerce-content').innerText();assert(recordText.includes('兑换账号'));assert(recordText.includes('到账订单'),'redemption records are queryable');
  await a.goto(origin+'/screens/commerce-admin-stats.html');await readyAdmin();
  const statsText=await a.locator('#commerce-content').innerText();assert(statsText.includes('发放')&&statsText.includes('兑换码')&&statsText.includes('近期失败记录'));assert.equal(await a.locator('.commerce-kpi').count(),6);
  await a.screenshot({path:path.join(out,'exchange-console-stats.png')});
 });
 await check('Browser QR round-trip, copy coupon ID, expiry, refresh and merchant scan import',async()=>{
  await p.goto(origin+'/juzhu-commerce.html?city=guiyang&view=memberships');await ready();await p.locator('.member-wallet[data-tab=coupons]').click();await ready();await p.clock.install();await p.locator('[data-action=code]').first().click();await p.waitForSelector('.voucher-qr svg');await p.screenshot({path:path.join(out,'voucher-qr-390.png')});
  const svg=await p.locator('.voucher-qr svg').evaluate(e=>e.outerHTML);const sharp=require('sharp'),jsQR=require('/tmp/commerce-qr-test/node_modules/jsqr');const {data,info}=await sharp(Buffer.from(svg)).resize(600,600).ensureAlpha().raw().toBuffer({resolveWithObject:true});const decoded=jsQR(new Uint8ClampedArray(data),info.width,info.height);assert(decoded&&/^NLV1:[a-f0-9-]{36}:[a-f0-9]{32}$/.test(decoded.data));const [,id,token]=decoded.data.split(':');
  await p.locator('.copy-coupon').click();assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),id);
  const merchant=await browser.newContext();await merchant.addInitScript(t=>localStorage.setItem('BZF_SESSION_TOKEN',t),actors.merchant.token);const m=await merchant.newPage();await m.goto(origin+'/screens/commerce-merchant-redemptions.html');await m.locator('[data-action=redeem]').click();await m.locator('[name=scan]').fill(decoded.data);assert.equal(await m.locator('[name=coupon_id]').inputValue(),id);assert.equal(await m.locator('[name=token]').inputValue(),token);await merchant.close();
  await p.clock.fastForward(121000);assert((await p.locator('.code-expiry').innerText()).includes('已失效'));assert.equal(await p.locator('.voucher-qr svg').count(),0);await p.locator('.refresh-code').click();await p.waitForSelector('.voucher-qr svg');await p.getByRole('button',{name:'关闭',exact:true}).last().click();await p.clock.resume();
 });
 await check('Member and standalone shop layout fits mobile widths; no logout, no duplicate wallet tab',async()=>{
  for(const width of [320,390,430,1440]){await p.setViewportSize({width,height:844});await p.goto(origin+'/juzhu-commerce.html?view=memberships&city=guiyang');await ready();assert(await p.evaluate(()=>document.querySelector('.scr').scrollWidth<=document.querySelector('.scr').clientWidth));assert.equal(await p.locator('#commerce-tabs [data-tab=coupons]').count(),0);assert.equal(await p.locator('#account-logout').isVisible(),false);await p.screenshot({path:path.join(out,'membership-'+width+'.png')});}
  await p.setViewportSize({width:390,height:844});await p.locator('#commerce-tabs [data-tab=shop]').click();await p.waitForURL('**/juzhu-vouchers.html**');await ready();assert.equal(await p.locator('.product-card').count(),38);await p.screenshot({path:path.join(out,'shop-390.png')});await p.locator('[name=q]').fill('不存在的服务');await p.locator('#consumer-search button').click();assert.equal(await p.locator('.product-card').count(),0);await p.locator('[data-action=clear-search]').click();assert.equal(await p.locator('.product-card').count(),38);assert.deepEqual(errors,[]);
 });
 }finally{await admin.close();await user.close();}
}
module.exports={run};
