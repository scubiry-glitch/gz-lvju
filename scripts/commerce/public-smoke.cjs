'use strict';
const { chromium } = require(process.env.COMMERCE_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = 'https://sytest.meizu.life';
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.COMMERCE_CHROME || undefined, args: ['--no-sandbox'] });
  const errors = [], pages = [];
  try {
    const context = await browser.newContext({ viewport: { width:390, height:844 } }); context.setDefaultTimeout(15000);
    for (const file of ['juzhu-commerce.html','juzhu-promoter.html','screens/commerce-merchant.html','screens/commerce-admin.html']) {
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      const response = await page.goto(base + '/' + file); assert.equal(response.status(),200);
      await page.waitForFunction(() => document.querySelector('#identity')?.options.length > 0 && !document.querySelector('#commerce-content').textContent.includes('正在加载'));
      assert.equal(await page.locator('#commerce-status.error').count(),0, file);
      assert.equal(await page.getByText('权益联调暂不可用').count(),0,file);
      pages.push({file,loaded:true});
      if (file === 'juzhu-commerce.html') {
        const transaction = await page.evaluate(async () => {
          await COMMERCE.login('user-b');
          const catalog = await COMMERCE.request('/catalog');
          const order = await COMMERCE.request('/orders',{product_id:catalog[0].id,version:catalog[0].version});
          const paid = await COMMERCE.request('/orders/'+order.id+'/test-pay',{});
          const state = await COMMERCE.request('/state');
          const coupons = state.coupons.filter(c=>c.order===order.id);
          return {test_only:paid.test_only,payment:paid.status,grant:paid.grant_status,count:coupons.length};
        });
        assert.deepEqual(transaction,{test_only:true,payment:'PAID',grant:'COMPLETED',count:5});
        pages[0].test_transaction=transaction;
        await page.reload(); await page.locator('[data-tab="coupons"]').click();
        await page.locator('[data-action="coupon"]').first().waitFor();
        await page.screenshot({path:path.resolve(__dirname,'../../docs/verification/newliving-commerce/15-sytest-live.png')});
      }
    }
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.resolve(__dirname,'../../docs/verification/newliving-commerce/public-smoke.json'),JSON.stringify({base,checked_at:new Date().toISOString(),pages,page_errors:errors,passed:true},null,2));
    console.log('PASS HTTPS: four workbenches load; test purchase grants five coupons; zero page errors');
  } finally { await browser.close(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
