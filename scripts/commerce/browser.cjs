'use strict';
// Run with COMMERCE_PLAYWRIGHT_MODULE pointing to an installed Playwright module if needed.
const { chromium } = require(process.env.COMMERCE_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('../../commerce/server.cjs');
const OUT = path.resolve(__dirname, '../../docs/verification/newliving-commerce');
async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  const errors = [], checks = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.COMMERCE_CHROME || undefined, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    context.setDefaultTimeout(10000);
    async function page(url) {
      const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message));
      await p.goto(base + url); await p.locator('#identity').waitFor();
      await p.waitForFunction(() => document.querySelector('#identity')?.options.length > 0 && !document.querySelector('#commerce-content')?.textContent.includes('正在加载'));
      return p;
    }
    async function act(p, action, index = 0) {
      const button = p.locator('[data-action="' + action + '"]').nth(index);
      const changed = p.waitForResponse(r => r.url().includes('/api/commerce/v1/state') && r.request().method() === 'GET');
      await button.click(); await changed; await p.waitForFunction(() => document.body.dataset.commerceBusy === 'false');
      const error = await p.locator('#commerce-status.error').count();
      assert.equal(error, 0, await p.locator('#commerce-status').textContent());
    }
    async function tab(p, name) {
      const response = p.waitForResponse(r => r.url().endsWith('/state')); await p.locator('[data-tab="'+name+'"]').click(); await response; await p.waitForTimeout(50);
    }
    async function shot(p, name) { await p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !name.includes('mobile') }); }
    async function noOverflow(p, label) { assert(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), label); checks.push(label); }
    const q = await page('/juzhu-promoter.html'); await act(q, 'share');
    const link = await q.locator('#share-link').getAttribute('href'); assert(link.includes('ref='));
    await shot(q, '01-promoter-share');
    const c = await page(link); await c.locator('[data-action="checkout"]').waitFor();
    await shot(c, '02-product-mobile');
    await act(c, 'checkout'); await c.locator('#terms').check(); await act(c, 'place-order'); await act(c, 'test-pay');
    assert.equal(server.commerce.orders.length, 1); assert.equal(server.commerce.coupons.length, 5); assert.equal(server.commerce.redemptions.length, 0);
    checks.push('purchase grants five coupons and no earned commission');
    await act(c, 'go-coupons'); await shot(c, '03-coupons-mobile'); await act(c, 'coupon');
    await act(c, 'book'); await act(c, 'token');
    const token = await c.locator('#redemption-code').textContent(); await shot(c, '04-appointment-mobile');
    const m = await page('/screens/commerce-merchant.html'); await m.setViewportSize({ width: 1440, height: 1000 });
    await m.locator('#redeem-token').fill(token); await act(m, 'preview'); assert.equal(server.commerce.redemptions.length, 0);
    await m.locator('#service-confirmed').check(); await act(m, 'redeem'); assert.equal(server.commerce.redemptions.length, 1);
    await shot(m, '05-merchant-desktop'); checks.push('appointment, preview, redemption and merchant settlement');
    const a = await page('/screens/commerce-admin.html'); await a.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(server.commerce.summary().unredeemed, 79920); await act(a, 'release');
    await q.reload(); await q.locator('#withdraw-amount').waitFor(); await q.locator('#withdraw-amount').fill('19.98'); await act(q, 'withdraw');
    await a.reload(); await a.locator('[data-action="payout-unknown"]').waitFor(); await act(a, 'payout-unknown');
    assert.equal(server.commerce.payouts[0].status, 'UNKNOWN'); await shot(a, '06-admin-unknown-desktop');
    await act(a, 'payout-query'); assert.equal(server.commerce.payouts[0].status, 'PAID');
    checks.push('provider reservation, UNKNOWN and original-request query');
    await q.reload(); await q.locator('#withdraw-amount').waitFor(); await shot(q, '07-promoter-paid-mobile');
    await c.reload(); await tab(c, 'coupons'); await act(c, 'coupon', 1);
    await c.locator('#refund-reason').fill('测试用户不再需要这项服务'); await act(c, 'refund');
    await a.reload(); await a.locator('[data-action="approve-refund"]').waitFor(); await act(a, 'approve-refund');
    assert.equal(server.commerce.summary().refunded, 13320); assert.equal(server.commerce.compensations.length, 0);
    await c.reload(); await tab(c, 'coupons'); await act(c, 'coupon', 0); await c.locator('#refund-reason').fill('已核销服务未履约'); await act(c, 'refund');
    await a.reload(); await a.locator('[data-action="approve-refund"]:not(:disabled)').click();
    await a.waitForFunction(() => document.querySelector('[data-action="recover"]'));
    assert.equal(server.commerce.compensations.length, 1); await act(a, 'recover');
    assert.equal(server.commerce.summary().recovery, 19980); checks.push('unused refund distinct from own-funds compensation and recovery');
    const remainingCoupon = server.commerce.coupons.find(x => x.status === 'ISSUED');
    await Promise.all([a.waitForResponse(r => r.url().endsWith('/state')), a.locator('[data-action="expire"][data-id="' + remainingCoupon.id + '"]').click()]);
    await a.waitForFunction(() => document.body.dataset.commerceBusy === 'false'); assert.equal(server.commerce.coupons.find(x => x.id === remainingCoupon.id).status, 'REFUNDED');
    checks.push('test expiry triggers original-source refund');
    await c.goto(base + '/juzhu-commerce.html'); await c.locator('[data-action="product"]').first().waitFor();
    await c.locator('#city').selectOption('其他城市'); await c.getByText('当前城市暂无可售权益').waitFor(); await shot(c, '08-city-empty');
    await c.locator('#city').selectOption('沈阳'); await c.locator('[data-action="product"]').first().waitFor();
    await tab(c, 'member'); await act(c, 'product'); await act(c, 'checkout'); await c.locator('#terms').check(); await act(c, 'place-order');
    await c.locator('#fail-grant').check(); await act(c, 'test-pay'); assert.equal(server.commerce.orders[1].grant_status, 'RETRY_PENDING');
    await a.reload(); await a.locator('[data-action="retry"]').first().waitFor(); await act(a, 'retry', 0); assert.equal(server.commerce.memberships.length, 1);
    await act(a, 'membership-expire');
    assert.equal(server.commerce.coupons.filter(x => x.order === server.commerce.orders[1].id).every(x => x.status === 'ISSUED'), true);
    await c.reload(); await tab(c, 'member'); await shot(c, '09-membership-expired');
    checks.push('membership grant retry and independent membership expiry');
    await tab(c, 'orders'); await act(c, 'help', 0); assert.equal(server.commerce.help.length, 1);
    await a.reload(); await a.locator('[data-action="help-resolve"]').waitFor(); await act(a, 'help-resolve');
    checks.push('invoice/help case acceptance and response');
    await c.locator('#identity').selectOption('merchant-A'); await c.getByText('当前身份无权访问此工作台').waitFor(); await shot(c, '10-permission-denied');
    await c.locator('#identity').selectOption('user-b'); await tab(c, 'coupons'); await c.getByText('暂无该状态的卡券').waitFor();
    checks.push('role switching and other-user empty holdings');
    for (const [p, name] of [[c,'consumer'],[q,'promoter'],[m,'merchant'],[a,'admin']]) {
      await p.setViewportSize({ width: 390, height: 844 }); await noOverflow(p, name + ' 390px no horizontal overflow');
      if (name === 'merchant' || name === 'admin') {
        assert.equal(await p.locator('.nv-side').isVisible(), false, 'mobile sidebar hidden');
        await p.evaluate(() => window.scrollTo(0,0));
        assert((await p.locator('.appbar').boundingBox()).y < 5, 'mobile content begins at top, no empty sidebar row');
        checks.push(name + ' mobile sidebar hidden and header at top');
      }
    }
    await shot(a, '11-admin-mobile');
    await a.setViewportSize({width:1440,height:1000}); await shot(a,'12-admin-final-desktop');
    // Failure state must not fabricate success.
    const f = await context.newPage(); f.on('pageerror', e => errors.push(e.message));
    await f.route('**/api/commerce/v1/meta', r => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({error:'测试依赖不可用'}) }));
    await f.goto(base + '/juzhu-commerce.html'); await f.getByText('权益联调暂不可用').waitFor(); await shot(f,'13-service-unavailable');
    checks.push('service unavailable blocks transaction UI');
    const home = await context.newPage(); home.on('pageerror', e => errors.push(e.message)); await home.goto(base + '/index.html?tab=jiazheng');
    await home.locator('#jzCoupon a[href*="juzhu-commerce"]').first().waitFor(); await home.locator('#jzCoupon').scrollIntoViewIfNeeded(); await shot(home, '14-home-entry');
    assert.equal(await home.locator('.jz-cat-grid a').count(), 12); checks.push('homepage links commerce while preserving 12 service categories');
    await home.locator('#jzCoupon a').first().click(); await home.locator('#identity').waitFor();
    // Verify all new shared-nav destinations resolve locally.
    const navLinks = await a.locator('.nv-side a').evaluateAll(els => els.map(e => e.getAttribute('href')));
    assert(navLinks.length >= 5, 'shared nav must contain four workbenches and overview');
    for (const href of navLinks) {
      const response = await context.request.get(new URL(href, a.url()).href); assert.equal(response.status(), 200, href);
    }
    checks.push('shared navigation contains five valid destinations');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(OUT, 'browser-results.json'), JSON.stringify({ passed: true, adapter: 'isolated-memory-test', checks, page_errors: errors, captured_at: new Date().toISOString() }, null, 2));
    console.log('PASS browser: ' + checks.length + ' checks; zero page errors');
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
