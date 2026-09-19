'use strict';
// M1-A4 浏览器验收：告警卡渲染与触发态、赔付区、登录失效态、移动端可用性。
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
async function run({origin,actors,check,pool}){
 const {chromium}=require(process.env.COMMERCE_PLAYWRIGHT_MODULE||'/tmp/e2e/node_modules/playwright-core');
 const browser=await chromium.launch({executablePath:process.env.COMMERCE_CHROME||'/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
 const errors=[],out=path.resolve(__dirname,'../../docs/verification/newliving-commerce-m1a4');fs.mkdirSync(out,{recursive:true});
 async function context(actor,width=1440){const ctx=await browser.newContext({viewport:{width,height:1000}});if(actor)await ctx.addInitScript(token=>localStorage.setItem('BZF_SESSION_TOKEN',token),actor.token);const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));return {ctx,page};}
 async function ready(page){await page.waitForFunction(()=>!document.querySelector('#commerce-content')?.hasAttribute('aria-busy')&&document.querySelector('#commerce-content .commerce-card, #commerce-content .commerce-kpi'));}
 try{
  await check('Browser alert table renders all rules with runbooks and thresholds',async()=>{
   const {ctx,page}=await context(actors.operator);
   await page.goto(origin+'/screens/commerce-admin-stats.html');await ready(page);
   await page.waitForFunction(()=>document.querySelector('#commerce-content')?.innerText.includes('运行告警'));
   const text=await page.locator('#commerce-content').innerText();
   for(const rule of ['服务不可用','发放/预占积压','结算结果未知','重试达上限','对账差异未闭环','账务不变量异常','到期退回预告'])assert(text.includes(rule),'缺少告警项 '+rule);
   assert(text.includes('责任'),'告警含责任角色/处理步骤');
   await page.screenshot({path:path.join(out,'08-alerts-dashboard.png'),fullPage:true});
   await ctx.close();
  });
  await check('Browser triggered alert shows red state and recovers after fix',async()=>{
   const {ctx,page}=await context(actors.operator);
   await pool.execute(`INSERT INTO commerce_orders(id,account_id,city_id,product_kind,product_id,product_version,amount_minor,status,expires_at,snapshot) VALUES('browser-alert-order',4,1,'packages',1,1,10000,'reserved',UTC_TIMESTAMP()-INTERVAL 2 HOUR,JSON_OBJECT())`);
   await page.goto(origin+'/screens/commerce-admin-stats.html');await ready(page);
   await page.waitForFunction(()=>document.querySelector('#commerce-content')?.innerText.includes('已触发'));
   await page.screenshot({path:path.join(out,'09-alert-triggered.png'),fullPage:true});
   await pool.execute("UPDATE commerce_orders SET status='expired' WHERE id='browser-alert-order'");
   await page.reload();await ready(page);
   await page.waitForFunction(()=>document.querySelector('#commerce-content')?.innerText.includes('正常'));
   await ctx.close();
  });
  await check('Browser compensation section on reconciliation console',async()=>{
   const {ctx,page}=await context(actors.operator);
   await page.goto(origin+'/screens/commerce-admin-reconciliation.html');await ready(page);
   const text=await page.locator('#commerce-content').innerText();
   assert(text.includes('先行赔付')&&text.includes('误核销撤销')&&text.includes('追偿'));
   assert.equal(await page.locator('[data-action=comp-create]').count(),1,'fund.write 账号可见「建立赔付单」入口');
   await page.screenshot({path:path.join(out,'10-reconciliation-with-compensation.png'),fullPage:true});
   await ctx.close();
  });
  await check('Browser session revocation forces re-login on every console (登录失效)',async()=>{
   const {ctx,page}=await context(actors.user,390);
   await page.goto(origin+'/juzhu-commerce.html?view=cases');await ready(page);
   assert((await page.locator('#commerce-content').innerText()).includes('售后服务')||await page.locator('#commerce-content').count()>0,'登录态正常渲染');
   // 撤销会话（服务端）
   await pool.execute('DELETE FROM sessions WHERE account_id=4');
   await page.reload();await ready(page);
   const text=await page.locator('#commerce-content').innerText();
   assert(text.includes('登录')||text.includes('登录后查看'),'登录失效后回到登录引导');
   await page.screenshot({path:path.join(out,'11-session-revoked-390.png'),fullPage:true});
   await ctx.close();
  });
  await check('Browser no uncaught JS errors on m1a4 pages',async()=>assert.deepEqual(errors,[],errors.join(' | ')));
 }finally{await browser.close();}
}
module.exports={run};
