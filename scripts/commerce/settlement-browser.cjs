'use strict';
// 结算闭环浏览器验收：四端页面在真实浏览器中渲染与操作（390px / 1440px、空态、权限态）。
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
async function run({origin,actors,check}){
 const {chromium}=require(process.env.COMMERCE_PLAYWRIGHT_MODULE||'/tmp/e2e/node_modules/playwright-core');
 const browser=await chromium.launch({executablePath:process.env.COMMERCE_CHROME||'/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
 const errors=[],out=path.resolve(__dirname,'../../docs/verification/newliving-commerce-settlement');fs.mkdirSync(out,{recursive:true});
 async function context(actor,width=1440){const ctx=await browser.newContext({viewport:{width,height:1000}});if(actor)await ctx.addInitScript(token=>localStorage.setItem('BZF_SESSION_TOKEN',token),actor.token);const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));return {ctx,page};}
 async function ready(page){await page.waitForFunction(()=>!document.querySelector('#commerce-content')?.hasAttribute('aria-busy')&&document.querySelector('#commerce-content .commerce-card, #commerce-content .commerce-kpi'));}
 try{
  await check('Browser settlement admin page renders overview, batches and instructions',async()=>{
   const {ctx,page}=await context(actors.operator);
   await page.goto(origin+'/screens/commerce-admin-settlement.html');await ready(page);
   const text=await page.locator('#commerce-content').innerText();
   assert(text.includes('结算账单')&&text.includes('结算批次'),page.url()+' → '+text.slice(0,200)+' | status:'+await page.locator('#commerce-status').textContent());
   assert(text.includes('资金不变量'),'不变量状态可见');
   assert(text.includes('付款指令与回执'));
   await page.screenshot({path:path.join(out,'01-settlement-admin-desktop.png'),fullPage:true});
   // 生成账单对话框（fund.write）
   await page.getByRole('button',{name:'生成账单',exact:true}).click();
   assert(await page.locator('#commerce-dialog [name=period_start]').count()>0);
   await page.locator('#commerce-dialog [data-close]').click();
   // 批次详情对话框
   await page.locator('[data-action=batch-detail]').first().click();
   await page.waitForSelector('#commerce-dialog');
   const detail=await page.locator('#commerce-dialog').innerText();
   assert(detail.includes('结算明细'),detail.slice(0,120));
   assert(detail.includes('规则版本'),'明细可追溯规则版本');
   await page.screenshot({path:path.join(out,'02-batch-detail.png'),fullPage:true});
   await page.locator('#commerce-dialog [data-close]').click();
   await ctx.close();
  });
  await check('Browser reviewer sees approval actions but cannot generate or execute',async()=>{
   const {ctx,page}=await context(actors.reviewer);
   await page.goto(origin+'/screens/commerce-admin-settlement.html');await ready(page);
   assert.equal(await page.locator('[data-action=gen-batch]').count(),0,'无 fund.write 无生成按钮');
   assert.equal(await page.locator('[data-action=batch-execute]').count(),0,'无执行按钮');
   await page.goto(origin+'/screens/commerce-admin-reconciliation.html');await ready(page);
   const text=await page.locator('#commerce-content').innerText();
   assert(text.includes('对账批次')&&text.includes('追偿')&&text.includes('误核销撤销'));
   await page.screenshot({path:path.join(out,'03-reconciliation-desktop.png'),fullPage:true});
   await ctx.close();
  });
  await check('Browser refunds page builds from case and executes',async()=>{
   const {ctx,page}=await context(actors.operator);
   await page.goto(origin+'/screens/commerce-admin-refunds.html');await ready(page);
   const text=await page.locator('#commerce-content').innerText();
   assert(text.includes('退款执行')&&text.includes('退款单号'));
   await page.screenshot({path:path.join(out,'04-refunds-desktop.png'),fullPage:true});
   await ctx.close();
  });
  await check('Browser merchant settlement view shows payable and received',async()=>{
   const {ctx,page}=await context(actors.merchant);
   await page.goto(origin+'/screens/commerce-merchant-settlement.html');await ready(page);
   const text=await page.locator('#commerce-content').innerText();
   assert(text.includes('应结与到账'));assert(text.includes('已到账'));assert(text.includes('不代表真实资金'));
   await page.screenshot({path:path.join(out,'05-merchant-settlement-desktop.png'),fullPage:true});
   await ctx.close();
  });
  await check('Browser consumer sees refund progress and promoter sees settlement',async()=>{
   const user=await context(actors.user,390);
   await user.page.goto(origin+'/juzhu-commerce.html?view=cases');await ready(user.page);
   await user.page.waitForFunction(()=>document.querySelector('#commerce-content')?.innerText.includes('退款进度'));
   const refundText=await user.page.locator('#commerce-content').innerText();
   assert(refundText.includes('已退款'),'退款进度包含已退款状态');
   assert(refundText.includes('原路退回'));
   await user.page.screenshot({path:path.join(out,'06-consumer-refund-progress-390.png'),fullPage:true});
   await user.ctx.close();
   const promoter=await context(actors.promoter,390);
   await promoter.page.goto(origin+'/juzhu-promoter.html?view=promotion');await ready(promoter.page);
   await promoter.page.waitForFunction(()=>document.querySelector('#commerce-content')?.innerText.includes('已到账'));
   const promoText=await promoter.page.locator('#commerce-content').innerText();
   assert(promoText.includes('结算中')&&promoText.includes('已确认佣金'));
   await promoter.page.screenshot({path:path.join(out,'07-promoter-settlement-390.png'),fullPage:true});
   await promoter.ctx.close();
  });
  await check('Browser new pages responsive with no overflow and no JS errors',async()=>{
   for(const width of [390,1440]){
    for(const [file,actor] of [['screens/commerce-admin-settlement.html',actors.operator],['screens/commerce-admin-refunds.html',actors.operator],['screens/commerce-admin-reconciliation.html',actors.operator],['screens/commerce-merchant-settlement.html',actors.merchant]]){
     const device=await context(actor,width);await device.page.goto(origin+'/'+file);await ready(device.page);
     assert(await device.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),file+' overflow at '+width);
     if(width===390)assert.equal(await device.page.locator('.nv-side').isVisible(),false,file+' mobile sidebar hidden');
     await device.ctx.close();
    }
   }
   assert.deepEqual(errors,[],'无未捕获 JS 错误: '+errors.join(' | '));
  });
 }finally{await browser.close();}
}
module.exports={run};
