'use strict';

// Read-only visual acceptance for the consumer-facing new-living pages.
// The audit deliberately uses anonymous GETs and a catalog response stub only
// for the loading-state check; it never creates an order, coupon or account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.COMMERCE_PLAYWRIGHT_MODULE || '/tmp/e2e/node_modules/playwright-core');

const origin = (process.env.COMMERCE_ORIGIN || 'https://sytest.meizu.life').replace(/\/$/, '');
const output = path.resolve(__dirname, '../../docs/verification/member-wallet');
const sourceRoot = path.resolve(__dirname, '../../screens');
const checks = [];
const errors = [];

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.COMMERCE_CHROME || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
    headless: true,
    args: ['--no-sandbox']
  });
  const check = async (name, fn) => {
    await fn();
    checks.push({ name, passed: true });
    console.log('PASS ' + name);
  };
  const open = async (url, width = 390, options = {}) => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, ...options });
    context.setDefaultTimeout(12000);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push({ url: page.url(), message: error.message }));
    await page.goto(origin + '/' + url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const content = document.querySelector('#commerce-content');
      return content && !content.hasAttribute('aria-busy') && content.querySelector('.commerce-card');
    });
    return { context, page };
  };
  const close = async ({ context }) => context.close();
  const noOverflow = async page => page.evaluate(() => {
    const root = document.documentElement;
    const scroll = document.querySelector('.scr');
    return root.scrollWidth <= window.innerWidth + 1 && (!scroll || scroll.scrollWidth <= scroll.clientWidth + 1);
  });
  const heights = async (page, selector) => page.locator(selector).evaluateAll(elements => elements
    .filter(element => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length;
    })
    .map(element => ({ text: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 40), height: element.getBoundingClientRect().height })));

  try {
    await check('Static visual contracts include QR expiry, status hierarchy and reduced motion', async () => {
      const customer = fs.readFileSync(path.join(sourceRoot, '_commerce-customer.js'), 'utf8');
      const consumer = fs.readFileSync(path.join(sourceRoot, '_commerce-consumer.js'), 'utf8');
      const css = fs.readFileSync(path.join(sourceRoot, '_commerce-consumer.css'), 'utf8');
      assert.match(customer, /class="code-toolbar"/);
      assert.match(customer, /class="qr-expired"/);
      assert.match(customer, /class="asset-status status-/);
      assert.match(consumer, /member-pass-highlights/);
      assert.match(consumer, /member-open-cta/);
      assert.match(css, /\.voucher-code-dialog \.code-toolbar/);
      assert.match(css, /\.voucher-code-dialog \.qr-expired/);
      assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
    });

    await check('Consumer pages stay within the viewport at 320/390/430/1440px', async () => {
      for (const width of [320, 390, 430, 1440]) {
        for (const route of ['juzhu-commerce.html?city=贵阳', 'juzhu-vouchers.html?city=贵阳']) {
          const opened = await open(route, width);
          try {
            assert.equal(await noOverflow(opened.page), true, route + ' overflow at ' + width + 'px');
            assert.equal(await opened.page.locator('#commerce-tabs button').count(), 4, route + ' bottom navigation');
            const login = await opened.page.locator('#account-login').boundingBox();
            assert(login && login.height >= 44 - 0.5, route + ' top login touch target');
          } finally {
            await close(opened);
          }
        }
      }
    });

    await check('Home and shop controls preserve 44px touch targets and concise cards', async () => {
      const opened = await open('juzhu-vouchers.html?city=贵阳', 390);
      try {
        const controls = await heights(opened.page, '.consumer-shop-tabs button, .consumer-search button, .consumer-category select, .product-card .btn');
        assert(controls.length >= 8, 'expected shop controls and product actions');
        assert(controls.every(control => control.height >= 44 - 0.5), JSON.stringify(controls));
        const summaries = await opened.page.locator('.product-card-summary').evaluateAll(elements => elements.map(element => ({
          text: element.textContent.trim(), lines: Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight))
        })));
        assert(summaries.length > 0, 'product cards need an explicit summary');
        assert(summaries.every(summary => summary.lines <= 2 && summary.text.length <= 90), JSON.stringify(summaries.slice(0, 3)));
      } finally {
        await close(opened);
      }
    });

    await check('Membership first screen exposes highlights, wallet and non-sticky CTA', async () => {
      const opened = await open('juzhu-commerce.html?view=memberships&city=贵阳', 390);
      try {
        assert.equal(await opened.page.locator('.member-pass-highlights').count(), 1);
        assert.equal(await opened.page.locator('.member-pass-highlights span').count(), 3);
        assert(await opened.page.locator('.member-pass-highlights').innerText().then(text => /赠券/.test(text) && /权益/.test(text)));
        assert.equal(await opened.page.locator('.member-wallet').count(), 1);
        const cta = opened.page.locator('.member-open-cta');
        if (await cta.count()) {
          assert.equal(await cta.evaluate(element => getComputedStyle(element).position), 'static');
          assert((await cta.locator('.btn').boundingBox()).height >= 44);
        }
        const firstBenefit = await opened.page.locator('.member-benefits').boundingBox();
        assert(firstBenefit && firstBenefit.y < 850, 'first benefit should follow the compact membership card');
        await opened.page.screenshot({ path: path.join(output, 'visual-polish-membership-390.png'), fullPage: false });
      } finally {
        await close(opened);
      }
    });

    await check('Account profile keeps name and login aligned without wrapping', async () => {
      const opened = await open('juzhu-commerce.html?view=account&city=贵阳', 390);
      try {
        const metrics = await opened.page.evaluate(() => {
          const profile = document.querySelector('.consumer-profile');
          const heading = profile?.querySelector('h1');
          const login = profile?.querySelector('[data-action="login"]');
          const box = element => element?.getBoundingClientRect().toJSON();
          return { profile: box(profile), heading: box(heading), login: box(login), headingOverflow: heading ? heading.scrollWidth > heading.clientWidth + 1 : true };
        });
        assert(metrics.profile && metrics.heading && metrics.login, 'profile/login structure missing');
        assert.equal(metrics.headingOverflow, false, JSON.stringify(metrics));
        assert(metrics.login.height >= 44, JSON.stringify(metrics));
        assert(metrics.login.left > metrics.heading.right - 1, JSON.stringify(metrics));
        assert.equal(await opened.page.locator('.consumer-menu button').count(), 3);
        assert(await opened.page.locator('.exchange-entry').isVisible());
        await opened.page.screenshot({ path: path.join(output, 'visual-polish-account-390.png'), fullPage: false });
      } finally {
        await close(opened);
      }
    });

    await check('Loading feedback keeps layout and announces an in-progress state', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      context.setDefaultTimeout(12000);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push({ url: page.url(), message: error.message }));
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      await page.route('**/api/commerce/v1/catalog*', async route => {
        await pending;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
      });
      await page.goto(origin + '/juzhu-commerce.html?city=贵阳', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#commerce-content[aria-busy="true"]');
      const pseudo = await page.locator('#commerce-content').evaluate(element => getComputedStyle(element, '::after').content);
      assert(pseudo.includes('正在更新权益'), pseudo);
      release();
      await page.waitForFunction(() => !document.querySelector('#commerce-content')?.hasAttribute('aria-busy'));
      await context.close();
    });

    await check('No uncaught JavaScript errors on the audited routes', async () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
  }

  const result = { passed: true, origin, checks, page_errors: errors, captured_at: new Date().toISOString(), data_mutations: 0 };
  fs.writeFileSync(path.join(output, 'consumer-visual-polish-audit.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('PASS consumer visual polish audit: ' + checks.length + ' checks; zero page errors');
}

main().catch(error => {
  const result = { passed: false, origin, checks, page_errors: errors, error: error.stack || String(error), captured_at: new Date().toISOString(), data_mutations: 0 };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'consumer-visual-polish-audit.json'), JSON.stringify(result, null, 2) + '\n');
  console.error(error.stack || error);
  process.exitCode = 1;
});
