'use strict';
// Read-only public UI checks. Error/race responses are intercepted in this browser only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
async function run({browser, origin, check}) {
  const out = path.resolve(__dirname, '../../docs/verification/newliving-commerce-consumer');
  fs.mkdirSync(out, {recursive:true});
  const errors = [];
  async function open(width = 390) {
    const context = await browser.newContext({viewport:{width,height:844}});
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    return {context,page};
  }
  async function ready(page) {
    await page.waitForFunction(() => document.querySelector('#commerce-content .commerce-card') && !document.querySelector('#commerce-content').hasAttribute('aria-busy'));
  }
  await check('Consumer homepage: 320/390/430/1440 layouts, image and four reachable navigation items', async () => {
    for (const width of [320,390,430,1440]) {
      const {context,page} = await open(width);
      try {
        await page.goto(origin+'/juzhu-commerce.html');
        await ready(page);
        assert.equal(await page.locator('#commerce-tabs button').count(), 4);
        assert.equal(await page.locator('#account-login').isVisible(), true);
        assert.equal(await page.locator('#account-logout').isVisible(), false);
        assert.equal(await page.locator('.consumer-topic').count(), 5);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.scr').scrollWidth <= document.querySelector('.scr').clientWidth));
        const nav = await page.locator('#commerce-tabs').boundingBox();
        assert(nav.y+nav.height <= 845, 'Navigation must remain inside the viewport');
        await page.screenshot({path:path.join(out, 'home-'+width+'.png')});
        await page.locator('.consumer-footer').scrollIntoViewIfNeeded();
        assert(await page.locator('.consumer-preparing, .consumer-products').isVisible());
        if(width===390) await page.screenshot({path:path.join(out, 'home-bottom-390.png')});
        const photo = await page.request.get(origin+'/assets/commerce/living.webp');
        assert.equal(photo.status(), 200);
        assert(photo.headers()['content-type'].includes('image/webp'));
        assert((await photo.body()).length < 100000, 'Cover should not ship the multi-megabyte source photo');
      } finally { await context.close(); }
    }
  });
  await check('Consumer anonymous cards, membership, account, appointment, order and support navigation', async () => {
    const {context,page} = await open();
    try {
      await page.goto(origin+'/juzhu-commerce.html'); await ready(page);
      for (const tab of ['coupons','memberships','account']) {
        if(tab==='coupons')await page.locator('#commerce-content [data-tab=coupons]').first().click();else await page.locator('#commerce-tabs [data-tab='+tab+']').click(); await ready(page);
        assert(await page.locator('#commerce-content [data-action=login]').isVisible());
        await page.screenshot({path:path.join(out, tab+'-390.png')});
      }
      for (const tab of ['appointments','cases']) {
        await page.locator('#commerce-tabs [data-tab=account]').click(); await ready(page);
        await page.locator('#commerce-content [data-tab='+tab+']').click(); await ready(page);
        assert(await page.locator('#commerce-content [data-action=login]').isVisible());
        assert.equal(await page.locator('#commerce-tabs [aria-current=page]').getAttribute('data-tab'), 'account');
      }
      await page.locator('#commerce-content [data-action=login]').click();
      await page.waitForSelector('#bzfcl-user');
      assert.equal(await page.locator('#bzfcl-pwd').getAttribute('type'), 'password');
    } finally { await context.close(); }
  });
  await check('Consumer catalogue failure offers a working retry', async () => {
    const {context,page} = await open();
    try {
      await page.route('**/api/commerce/v1/catalog', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'暂时无法加载'})}));
      await page.goto(origin+'/juzhu-commerce.html'); await ready(page);
      assert(await page.getByRole('button', {name:'重新加载'}).isVisible());
      await page.screenshot({path:path.join(out,'error-390.png')});
      await page.unroute('**/api/commerce/v1/catalog');
      await page.getByRole('button', {name:'重新加载'}).click(); await ready(page);
      assert(await page.locator('.consumer-cover').isVisible());
      assert.equal(await page.locator('#commerce-status').textContent(), '');
    } finally { await context.close(); }
  });
  await check('Consumer rapid navigation ignores an older catalogue response', async () => {
    const {context,page} = await open();
    try {
      let captured;
      const pending = new Promise(resolve => { captured = resolve; });
      await page.route('**/api/commerce/v1/catalog', route => captured(route));
      await page.goto(origin+'/juzhu-commerce.html', {waitUntil:'domcontentloaded'});
      const route = await pending;
      await page.locator('#commerce-tabs [data-tab=account]').click(); await ready(page);
      const response = page.waitForResponse('**/api/commerce/v1/catalog');
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[]})});
      await response;
      // Flush fetch/DOM tasks without a fixed time delay.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('.consumer-profile h1').textContent(), '欢迎来到新居住');
      assert.equal(await page.locator('.consumer-cover').count(), 0);
      assert.equal(await page.locator('#commerce-content').evaluate(el => el.inert), false);
    } finally { await context.close(); }
  });
  await check('Consumer redesigned pages have no uncaught JavaScript errors', async () => assert.deepEqual(errors, []));
}
module.exports = {run};
