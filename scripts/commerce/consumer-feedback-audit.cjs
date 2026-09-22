'use strict';
// Read-only browser checks. The only POST endpoint used here is fulfilled in
// Playwright, and every other mutation request is blocked before reaching a server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function run({browser, origin, check}) {
  const errors = [], unexpectedMutations = [];
  const helper = fs.readFileSync(path.resolve(__dirname, '../../screens/_commerce-official.js'), 'utf8');
  const consumerCss = fs.readFileSync(path.resolve(__dirname, '../../screens/_commerce-consumer.css'), 'utf8');
  async function open(file, width = 390) {
    const context = await browser.newContext({viewport:{width, height:844}});
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
        unexpectedMutations.push(route.request().method()+' '+new URL(route.request().url()).pathname);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await page.route('**/screens/_commerce-official.js*', route => route.fulfill({contentType:'application/javascript', body:helper}));
    await page.route('**/screens/_commerce-consumer.css*', route => route.fulfill({contentType:'text/css', body:consumerCss}));
    await page.goto(origin+'/'+file);
    await page.waitForFunction(() => window.COMMERCE && document.querySelector('#commerce-content .commerce-card') && !document.querySelector('#commerce-content').hasAttribute('aria-busy'));
    return {context, page};
  }

  await check('Consumer submit is single-flight, exposes busy state, and recovers locally after failure', async () => {
    const {context, page} = await open('juzhu-commerce.html?city=%E8%B4%B5%E9%98%B3');
    try {
      let requests = 0, receive;
      const nextRequest = () => new Promise(resolve => {receive = resolve;});
      await page.route('**/api/commerce/v1/visual-feedback-audit', route => {requests++; receive(route);});
      await page.evaluate(() => {
        const scroll = document.querySelector('.scr');scroll.scrollTop = scroll.scrollHeight;
        const d = COMMERCE.dialog('兑换反馈验收', '<label class="field">兑换码<input name="code" value="LOCAL-ONLY" required></label>', async data => {
          const result = await COMMERCE.api('/visual-feedback-audit', 'POST', Object.fromEntries(data));
          return {successMessage:result.message};
        });
        d.querySelector('[type=submit]').textContent = '确认兑换';
      });
      const first = nextRequest();
      await page.locator('#commerce-dialog form').evaluate(form => {form.requestSubmit();form.requestSubmit();});
      const failedRoute = await first;
      assert.equal(requests, 1);
      assert.equal(await page.locator('#commerce-dialog [type=submit]').isDisabled(), true);
      assert.equal(await page.locator('#commerce-dialog [type=submit]').textContent(), '提交中…');
      assert.equal(await page.locator('#commerce-dialog form').getAttribute('aria-busy'), 'true');
      await failedRoute.fulfill({status:409, contentType:'application/json', body:JSON.stringify({error:'兑换码已失效，请核对后重试'})});
      await page.waitForFunction(() => document.querySelector('.dialog-error')?.textContent === '兑换码已失效，请核对后重试' && !document.querySelector('#commerce-dialog form').hasAttribute('aria-busy'));
      assert.equal(await page.locator('#commerce-dialog [type=submit]').isDisabled(), false);
      assert.equal(await page.locator('#commerce-dialog [type=submit]').textContent(), '确认兑换');
      assert.equal(await page.locator('#commerce-dialog input').inputValue(), 'LOCAL-ONLY');
      assert.equal(await page.locator('.dialog-error').evaluate(el => document.activeElement === el), true);

      const second = nextRequest();
      await page.locator('#commerce-dialog [type=submit]').click();
      const succeededRoute = await second;
      assert.equal(requests, 2);
      assert.equal(await page.locator('.dialog-error').textContent(), '');
      await succeededRoute.fulfill({status:200, contentType:'application/json', body:JSON.stringify({data:{message:'兑换成功：贵阳生活会员，到账 5 张卡券。'}})});
      await page.waitForFunction(() => !document.querySelector('#commerce-dialog') && document.querySelector('#commerce-toast')?.textContent === '兑换成功：贵阳生活会员，到账 5 张卡券。');
      assert.equal(await page.locator('#commerce-status').textContent(), '兑换成功：贵阳生活会员，到账 5 张卡券。');
      const bounds = await page.locator('#commerce-toast').boundingBox();
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x+bounds.width <= 391 && bounds.y+bounds.height <= 844, 'Success feedback must stay within the current viewport');
      assert.equal(await page.locator('#commerce-toast').evaluate(el => getComputedStyle(el).position), 'fixed');
      assert.equal(await page.locator('#commerce-toast').getAttribute('aria-hidden'), 'true', 'The existing live region announces the message once');
    } finally {await context.close();}
  });

  await check('Consumer callback confirmation survives generic completion and reduced motion suppresses toast animation', async () => {
    const {context, page} = await open('juzhu-commerce.html?view=account', 320);
    try {
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.evaluate(() => {
        const d = COMMERCE.dialog('业务确认', '<p>浏览器内反馈验收</p>', async () => {COMMERCE.status('预约成功，请按时到店');});
        d.querySelector('form').requestSubmit();
      });
      await page.waitForFunction(() => !document.querySelector('#commerce-dialog') && document.querySelector('#commerce-toast')?.textContent === '预约成功，请按时到店');
      assert.equal(await page.locator('#commerce-toast').evaluate(el => getComputedStyle(el).animationName), 'none');
      const bounds = await page.locator('#commerce-toast').boundingBox();
      assert(bounds.x >= 0 && bounds.x+bounds.width <= 321);
      await page.evaluate(() => COMMERCE.status(''));
      assert.equal(await page.locator('#commerce-toast').count(), 0);
      assert.equal(await page.locator('#commerce-status').textContent(), '');
    } finally {await context.close();}
  });

  await check('Shared feedback retains management and promoter status regions without consumer toast side effects', async () => {
    for (const file of ['screens/commerce-admin.html', 'juzhu-promoter.html']) {
      const {context, page} = await open(file, 1440);
      try {
        await page.evaluate(() => {
          const d = COMMERCE.dialog('管理反馈验收', '<p>浏览器内反馈验收</p>', async () => {});
          d.querySelector('form').requestSubmit();
        });
        await page.waitForFunction(() => !document.querySelector('#commerce-dialog') && document.querySelector('#commerce-status')?.textContent === '操作成功');
        assert.equal(await page.locator('#commerce-toast').count(), 0, file);
        await page.evaluate(() => COMMERCE.status('请核对填写内容', true));
        assert.equal(await page.locator('#commerce-status').evaluate(el => el.classList.contains('error')), true);
        assert.equal(await page.locator('#commerce-toast').count(), 0, file);
      } finally {await context.close();}
    }
  });
  await check('Feedback browser audit has no uncaught errors or server mutations', async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedMutations, []);
  });
}

module.exports = {run};
if (require.main === module) {
  (async () => {
    const {chromium} = require(process.env.COMMERCE_PLAYWRIGHT_MODULE || '/tmp/e2e/node_modules/playwright-core');
    const browser = await chromium.launch({executablePath:process.env.COMMERCE_CHROME || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless:true, args:['--no-sandbox']});
    try {await run({browser, origin:process.env.COMMERCE_ORIGIN || 'https://sytest.meizu.life', check:async (name, fn) => {await fn();console.log('PASS '+name);}});}
    finally {await browser.close();}
  })().catch(error => {console.error(error.stack);process.exitCode = 1;});
}
