'use strict';
// 酒店通兑三品类 · 线上闭环验收：HTTP 走通 买券→选店预约→线上直核，浏览器截名录/选店/详情。
// 线上仅零资金演示动作；商户侧酒店核销授权由隔离库 hotel-exchange 套件覆盖（线上无酒店商户员工账号）。
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const outDir=path.join(root,'docs/verification/hotel-exchange-closed-loop');fs.mkdirSync(outDir,{recursive:true});
const out={at:new Date().toISOString(),origin:'http://127.0.0.1:38780 (Host: sytest.meizu.life)',checks:[]};
const check=(name,ok,detail='')=>{out.checks.push({name,ok,detail});console.log((ok?'PASS ':'FAIL ')+name+(detail?' · '+detail:''));if(!ok)process.exitCode=1;};
const curl=(method,url,headers,body)=>{const args=['-sS','-X',method,url];for(const [k,v] of Object.entries(headers||{}))args.push('-H',k+': '+v);if(body!==undefined)args.push('-d',JSON.stringify(body));const raw=execFileSync('curl',args,{encoding:'utf8',maxBuffer:1<<24});try{return raw?JSON.parse(raw):null;}catch{return {error:raw};}};
const commerce=(route,token,method='GET',body)=>curl(method,'http://127.0.0.1:38780/api/commerce/v1'+route,{Host:'sytest.meizu.life',...(token?{Authorization:'Bearer '+token}:{}),...(method!=='GET'?{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}:{})},body);
const bjDate=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(v);
(async()=>{
 // ── HTTP：公开名录与目录 ──
 const hotels=commerce('/hotels');
 check('Public directory lists 48 sampled hotels across 6 tiers',hotels?.data?.total===48&&hotels.data.tiers.length===6&&hotels.data.tiers.every(t=>t.count===8),hotels?.data?.tiers?.map(t=>t.label+':'+t.count).join(' '));
 check('Directory exposes public fields only',hotels?.data?.hotels?.every(h=>h.name&&h.brand&&h.hotel_code&&h.tier&&!h.merchant_id&&!h.supply_minor),hotels?.data?.hotels?.[0]?.name);
 const catalog=commerce('/catalog?city=%E8%B4%B5%E9%98%B3');
 const exchangeSkus=(catalog?.data||[]).filter(p=>p.category_id==='hotel_exchange');
 const onlineSku=(catalog?.data||[]).find(p=>p.redeem_channel==='online');
 const t80=exchangeSkus.find(p=>p.exchange_tier==='t80');
 check('Catalog carries 6 exchange SKUs and online voucher with redeem channel',exchangeSkus.length===6&&!!onlineSku&&t80?.demo_purchase_enabled===true,exchangeSkus.map(p=>p.exchange_tier_label).join('/'));
 const pkg=(catalog?.data||[]).find(p=>p.kind==='packages'&&p.name.includes('酒店通兑体验包'));
 check('Cross-category package bundles exchange, ticket and dining vouchers',!!pkg,pkg?.name);
 // ── HTTP：消费者全流程（demo_lin，零资金演示） ──
 const pwdPage=fs.readFileSync(path.join(root,'screens/commerce-demo-accounts.html'),'utf8');
 const demoPwd=(pwdPage.match(/Demo#(\d{4})/)||[])[0]||'Demo#2026';
 const login=curl('POST','http://127.0.0.1:8766/api/auth/login',{'Content-Type':'application/json'},{login_name:'demo_lin',password:demoPwd});
 const userToken=login?.token||login?.data?.token;check('Consumer demo account signs in through the account centre',!!userToken,login?.data?.account?.display_name||'');
 if(userToken&&t80){
  const order=commerce('/demo-orders',userToken,'POST',{kind:'skus',product_id:t80.id,version:t80.version,demo_ack:true});
  const mine=commerce('/my',userToken);
  const coupon=(mine?.data?.coupons||[]).find(c=>c.order_id===order?.data?.id);
  check('Exchange coupon issued with tier metadata',coupon?.exchange_tier==='t80'&&coupon?.redeem_channel==='offline',coupon?.id);
  const tier80=commerce('/hotels?tier=t80').data.hotels;
  const hotel=tier80[Math.floor(tier80.length/2)];
  const booking=commerce('/appointments',userToken,'POST',{coupon_id:coupon.id,store_id:hotel.store_id,service_date:bjDate(Date.now()+5*86400000)});
  check('Coupon books a chosen same-tier hotel',booking?.data?.store_id===hotel.store_id,'hotel=' + hotel.name);
  const cancelled=commerce('/appointments',userToken,'POST',{coupon_id:coupon.id,action:'cancel'});
  check('Cancelling the booking frees the hotel slot',cancelled?.data?.cancelled===true,JSON.stringify(cancelled?.error||''));
  const swapped=commerce('/appointments',userToken,'POST',{coupon_id:coupon.id,store_id:tier80[0].store_id,service_date:bjDate(Date.now()+7*86400000)});
  check('Coupon re-books another same-tier hotel after cancel',swapped?.data?.store_id===tier80[0].store_id,'rebooked to '+tier80[0].name+' · '+(swapped?.error||''));
  const crossTier=commerce('/hotels?tier=t100').data.hotels[0];
  const rejected=commerce('/appointments',userToken,'POST',{coupon_id:coupon.id,store_id:crossTier.store_id,service_date:bjDate(Date.now()+8*86400000)});
  check('Cross-tier booking is rejected with tier_mismatch',!!rejected?.error&&rejected.error.includes('同档位'),rejected?.error||JSON.stringify(rejected));
  out.booking={coupon:coupon.id,hotel:tier80[0].name};
 }
 if(userToken&&onlineSku){
  const order=commerce('/demo-orders',userToken,'POST',{kind:'skus',product_id:onlineSku.id,version:onlineSku.version,demo_ack:true});
  const coupon=(commerce('/my',userToken).data?.coupons||[]).find(c=>c.order_id===order?.data?.id);
  const appt=commerce('/appointments',userToken,'POST',{coupon_id:coupon.id,service_date:bjDate(Date.now()+2*86400000)});
  check('Online coupon cannot book an appointment',!!appt?.error&&appt.error.includes('线上核销券无需预约'),appt?.error);
  const token=commerce('/coupons/'+coupon.id+'/token',userToken,'POST',{});
  check('Online coupon issues redemption code without appointment',!!token?.data?.token,'120s dynamic code');
 }
 // ── 浏览器：名录页 / 选券页 / 卡券详情 / 选店弹窗 / 管理台表单 ──
 const adminPage=fs.readFileSync(path.join(root,'screens/demo-accounts.html'),'utf8');
 const adminPwd=adminPage.match(/user:\s*'admin'\s*,\s*pwd:\s*'([^']+)'/)[1];
 const adminLogin=curl('POST','http://127.0.0.1:8766/api/auth/login',{'Content-Type':'application/json'},{login_name:'admin',password:adminPwd});
 const adminToken=adminLogin?.token||adminLogin?.data?.token;
 const {chromium}=require(process.env.COMMERCE_PLAYWRIGHT_MODULE||'/tmp/e2e/node_modules/playwright-core');
 const browser=await chromium.launch({executablePath:process.env.COMMERCE_CHROME||'/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
 const errors=[];
 try{
  const shot=(name,ok,detail='')=>check(name,ok,detail);
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  if(userToken)await context.addInitScript(t=>localStorage.setItem('BZF_SESSION_TOKEN',t),userToken);
  const page=await context.newPage();page.on('pageerror',e=>errors.push('consumer:'+e.message));
  const ready=()=>page.waitForFunction(()=>!document.querySelector('#commerce-content')?.hasAttribute('aria-busy')&&document.querySelector('#commerce-content .commerce-card'));
  await page.goto('https://sytest.meizu.life/juzhu-hotels.html?city=贵阳');await ready();
  const dirText=await page.locator('#commerce-content').innerText();
  shot('Hotel directory renders tier chips and roster cards',dirText.includes('酒店通兑名录')&&dirText.includes('80元档')&&dirText.includes(hotels.data.hotels[0].name),errors.length?errors[0]:'');
  await page.screenshot({path:path.join(outDir,'hotel-directory-1440.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.goto('https://sytest.meizu.life/juzhu-hotels.html?city=贵阳');await ready();
  await page.screenshot({path:path.join(outDir,'hotel-directory-390.png'),fullPage:true});
  await page.goto('https://sytest.meizu.life/juzhu-vouchers.html?city=贵阳&kind=skus&category=hotel_exchange');await ready();
  const shopText=await page.locator('#commerce-content').innerText();
  shot('Shop category filter surfaces exchange vouchers with tier tag',shopText.includes('酒店通兑')&&shopText.includes('任选'),shopText.slice(0,60));
  await page.screenshot({path:path.join(outDir,'hotel-shop-390.png'),fullPage:true});
  if(t80){
   await page.goto('https://sytest.meizu.life/juzhu-voucher.html?kind=skus&id='+t80.id+'&city='+encodeURIComponent('贵阳'));await ready();
   const productDetailText=await page.locator('#commerce-content').innerText();
   shot('Exchange product detail renders with roster entry and usage steps',productDetailText.includes('档内任选')&&productDetailText.includes('如何使用')&&!productDetailText.includes('正在为您准备'),'sku #'+t80.id);
   await page.screenshot({path:path.join(outDir,'hotel-product-detail-390.png'),fullPage:true});
  }
  if(userToken&&out.booking){
   await page.goto('https://sytest.meizu.life/juzhu-voucher.html?coupon='+encodeURIComponent(out.booking.coupon)+'&city=贵阳');await ready();
   const detailText=await page.locator('#commerce-content').innerText();
   shot('Coupon detail shows tier and hotel-booking entry',detailText.includes('通兑档位')&&detailText.includes('选酒店预约'), '');
   await page.screenshot({path:path.join(outDir,'hotel-coupon-detail-390.png'),fullPage:true});
   await page.locator('[data-action=book]').click();
   await page.waitForSelector('dialog[open] select[name=store_id]');
   const options=await page.locator('dialog[open] select[name=store_id] option').allInnerTexts();
   shot('Booking dialog lists same-tier hotels',options.length>=8,options.length+' hotels in picker');
   await page.screenshot({path:path.join(outDir,'hotel-pick-dialog-390.png'),fullPage:true});
   await page.keyboard.press('Escape');
  }
  await context.close();
  if(adminToken){
   const adminContext=await browser.newContext({viewport:{width:1440,height:1000}});
   await adminContext.addInitScript(t=>localStorage.setItem('BZF_SESSION_TOKEN',t),adminToken);
   const adminPageB=await adminContext.newPage();adminPageB.on('pageerror',e=>errors.push('admin:'+e.message));
   await adminPageB.goto('https://sytest.meizu.life/screens/commerce-admin-skus.html');
   await adminPageB.waitForFunction(()=>!document.querySelector('#commerce-content')?.hasAttribute('aria-busy'));
   await adminPageB.locator('[data-action=new]').first().click();
   await adminPageB.waitForSelector('dialog[open] select[name=redeem_channel]');
   await adminPageB.locator('dialog[open] select[name=redeem_channel]').selectOption('online');
   const storeLabel=await adminPageB.locator('dialog[open] label.field:has(select[name=store_id])').innerText().catch(()=>'');
   const hidden=await adminPageB.locator('dialog[open] label.field:has(select[name=exchange_tier])').evaluate(el=>getComputedStyle(el).display==='none');
   shot('Admin SKU form switches store picker to online counter for online channel',hidden&&/线上服务台/.test(storeLabel),storeLabel.replace(/\n/g,' ').slice(0,40));
   await adminPageB.screenshot({path:path.join(outDir,'admin-sku-form-online-1440.png'),fullPage:true});
   await adminPageB.locator('dialog[open] select[name=redeem_channel]').selectOption('offline');
   await adminPageB.locator('dialog[open] select[name=exchange_tier]').selectOption('t120');
   const options=await adminPageB.locator('dialog[open] select[name=store_id] option').allInnerTexts();
   shot('Admin SKU form filters stores to the tier anchor for exchange',options.some(o=>o.includes('t120 通兑锚点')),options.filter(o=>o.includes('锚点')).length+' anchor options');
   await adminPageB.screenshot({path:path.join(outDir,'admin-sku-form-exchange-1440.png'),fullPage:true});
   await adminContext.close();
  }
  check('No page script errors during browser walk',errors.length===0,errors.join(' | ').slice(0,200));
 }finally{await browser.close();}
 fs.writeFileSync(path.join(outDir,'live-check.json'),JSON.stringify(out,null,2));
 console.log('Hotel exchange live check: '+out.checks.filter(c=>c.ok).length+'/'+out.checks.length+' passed');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
