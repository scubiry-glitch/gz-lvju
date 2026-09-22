'use strict';
// One-shot: signed-in screenshots of the live exchange-code console, stats and order tracking pages.
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),origin='https://sytest.meizu.life';
const out=path.join(root,'docs/verification/guiyang-closed-loop');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const page0=fs.readFileSync(path.join(root,'screens/demo-accounts.html'),'utf8');
 const pwd=page0.match(/user:\s*'admin'\s*,\s*pwd:\s*'([^']+)'/)[1];
 const login=JSON.parse(execFileSync('curl',['-fsS','-X','POST','http://127.0.0.1:8766/api/auth/login','-H','Content-Type: application/json','-d',JSON.stringify({login_name:'admin',password:pwd})],{encoding:'utf8'}));
 const token=login?.token||login?.data?.token;if(!token)throw Error('login failed');
 const {chromium}=require(process.env.COMMERCE_PLAYWRIGHT_MODULE||'/tmp/e2e/node_modules/playwright-core');
 const browser=await chromium.launch({executablePath:process.env.COMMERCE_CHROME||'/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
 const errors=[];
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(t=>localStorage.setItem('BZF_SESSION_TOKEN',t),token);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const ready=()=>page.waitForFunction(()=>!document.querySelector('#commerce-content')?.hasAttribute('aria-busy')&&document.querySelector('#commerce-content .commerce-card'));
  await page.goto(origin+'/screens/commerce-admin-exchanges.html');await ready();
  await page.screenshot({path:path.join(out,'live-exchange-console-1440.png'),fullPage:true});
  const consoleText=await page.locator('#commerce-content').innerText();
  if(!consoleText.includes('兑换码管理'))throw Error('exchange console did not render');
  await page.goto(origin+'/screens/commerce-admin-stats.html');await ready();
  await page.screenshot({path:path.join(out,'live-stats-1440.png'),fullPage:true});
  if(!(await page.locator('#commerce-content').innerText()).includes('运营统计'))throw Error('stats page did not render');
  await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/juzhu-commerce.html?city=贵阳&view=coupons');await ready();
  await page.screenshot({path:path.join(out,'live-coupons-filter-390.png'),fullPage:true});
  const filterText=await page.locator('#commerce-content').innerText();
  if(!filterText.includes('全部')||!/已使用/.test(filterText))throw Error('coupon filter chips missing');
  await context.close();
  console.log('Live console screenshots saved; page errors: '+errors.length);
  if(errors.length)process.exitCode=1;
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
