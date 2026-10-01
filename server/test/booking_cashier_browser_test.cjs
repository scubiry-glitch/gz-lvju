'use strict';

// Pin the pre-cashier contract so committing this change does not replace the legacy fixture.
const LEGACY_REF = process.env.PAYMENT_LEGACY_REF || 'f68bdb53f47f6e1e973b26d12e368f07c259f67a';

// Run against local Chromium and built real pages. Every API response is
// intercepted; this suite never loads app.js, a database, or a real gateway.
// PAYMENT_BROWSER_MODULE=/path/to/puppeteer-core
// PAYMENT_BROWSER_EXECUTABLE=/path/to/chrome node --test server/test/booking_cashier_browser_test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const modulePath = process.env.PAYMENT_BROWSER_MODULE;
const executablePath = process.env.PAYMENT_BROWSER_EXECUTABLE;
const root = path.resolve(__dirname, '../..');

test('real accommodation pages retain old and new cashier compatibility', { skip: !modulePath || !executablePath, timeout: 120000 }, async t => {
  const puppeteer = (await import(pathToFileURL(modulePath).href)).default;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = url.pathname, body;
      if (pathname === '/fake-cashier') { res.end('<!doctype html><title>Isolated cashier</title>Isolated cashier'); return; }
      const legacy = pathname.startsWith('/legacy/');
      if (legacy) pathname = pathname.slice(7);
      if (legacy && ['/lvju-app-booking.html', '/lvju-app-paid.html'].includes(pathname)) {
        body = execFileSync('git', ['show', LEGACY_REF + ':' + pathname.slice(1)], { cwd: root });
      } else {
        let file = pathname.startsWith('/h5/')
          ? path.join(root, 'h5/dist', pathname.startsWith('/h5/assets/') ? pathname.slice(4) : 'index.html')
          : path.join(root, pathname);
        if (!file.startsWith(root + path.sep)) throw new Error('path outside fixture root');
        body = await fs.readFile(file);
      }
      const ext = path.extname(pathname);
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' })[ext] || (pathname.startsWith('/h5/') ? 'text/html' : 'application/octet-stream'));
      res.end(body);
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });

  const orderNo = 'BKG-MINSU-00001';
  const baseOrder = { order_no: orderNo, project_id: 1, project_name: '隔离测试民宿', channel: 'minsu',
    contact_phone: '130****0000', contact_phone_raw: '13000000000', status: 'pending', pay_status: 'unpaid',
    checkin: '2099-10-02', checkout: '2099-10-03', nights: 1, price_total: '123.45' };
  const ready = { ok: true, pay_status: 'paying', order_pay_status: 'unpaid', cashier_type: '2',
    cashier_url: origin + '/fake-cashier', app_order_id: 'XD_fixture', next_action: 'open_cashier' };
  async function fixture(options = {}) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const state = { order: { ...baseOrder, ...options.order }, payment: options.payment || ready,
      query: options.query || { ...ready, cashier_url: null, next_action: 'poll' }, queryStatus: options.queryStatus || 200,
      payments: [], queries: 0, bridgeLoads: 0, errors: [], dialogs: [] };
    await page.setViewport({ width: 420, height: 900 });
    if (options.app) await page.setUserAgent('Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Lianjia/Beike lianjiabeike');
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('BJZ_TOKEN', 'isolated-test-token');
      localStorage.setItem('bzf_lvju_privacy_v1:test-user', '1');
      document.cookie = 'lianjia_token=isolated-test-token; path=/';
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 750 || ms === 1500 ? 10 : ms, ...args);
    });
    page.on('pageerror', error => state.errors.push(error.message));
    page.on('dialog', async dialog => { state.dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const url = new URL(request.url());
      if (url.origin !== origin) return request.abort();
      const pathname = url.pathname.replace(/^\/legacy/, '');
      const json = (body, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/auth/me') return json({ account: { id: 'test-user', idp_type: 'beike', idp_subject: 'test-ucid', phone: '13000000000', display_name: '测试用户' }, role: 'user' });
        if (pathname === '/api/juzhu/booking/my') return json({ items: [state.order] });
        if (pathname === '/api/juzhu/booking/contacts') return json({ items: [] });
        if (pathname === '/api/juzhu/booking/lookup') return json({ ok: true, order: state.order });
        if (pathname === '/api/juzhu/booking/pay') {
          state.payments.push({ ...JSON.parse(request.postData()), headers: request.headers() });
          return json(state.payment, state.payment.next_action === 'poll' ? 202 : 200);
        }
        if (pathname === '/api/juzhu/payment/query') { state.queries++; return json(state.query, state.queryStatus); }
        return json({});
      }
      if (pathname === '/jsbridgesdk.js' && options.app) {
        state.bridgeLoads++;
        const code = await fs.readFile(path.join(root, 'jsbridgesdk.js'), 'utf8');
        return request.respond({ contentType: 'text/javascript', body: code + '\nwindow.JsBridgeV3.getSchemeLink=function(){return "lianjiabeike://bkjfwallet?url=";};window.JsBridgeV3.callAndBack=function(input){window.__cashierCall=input;};' });
      }
      return request.continue();
    });
    return { page, state, close: async () => { assert.deepEqual(state.errors, []); await context.close(); } };
  }
  const bookingUrl = (react = false) => origin + (react ? '/h5/booking' : '/lvju-app-booking.html') + '?order_no=' + orderNo + '&phone=13000000000';
  const paidUrl = (react = false) => origin + (react ? '/h5/paid' : '/lvju-app-paid.html') + '?channel=booking&order_no=' + orderNo + '&phone=13000000000';
  const paySelector = react => react ? 'button.btn.pay' : '#okPay';
  const titleSelector = react => react ? '.ok-t' : '#okTitle';

  for (const react of [false, true]) {
    await t.test((react ? 'React' : 'static') + ' H5 accepts the old flat response and opens an HTTP cashier', async () => {
      const old = { ok: true, pay_status: 'paying', cashier_type: '2', cashier_url: origin + '/fake-cashier', app_order_id: 'XD_old' };
      const f = await fixture({ payment: old });
      await f.page.goto(bookingUrl(react)); await f.page.waitForSelector(paySelector(react), { visible: true });
      await Promise.all([f.page.waitForNavigation(), f.page.click(paySelector(react))]);
      assert.equal(new URL(f.page.url()).pathname, '/fake-cashier');
      assert.equal(f.state.payments[0].cashier_type, '2');
      assert.match(f.state.payments[0].headers['idempotency-key'], /^[A-Za-z0-9:_-]{8,80}$/);
      f.state.order.pay_status = 'paid';
      f.state.query = { order_pay_status: 'paid', pay_status: 'paid', next_action: 'done' };
      await f.page.goBack({ waitUntil: 'domcontentloaded' });
      await f.page.waitForFunction(selector => document.querySelector(selector)?.textContent === '支付成功', {}, titleSelector(react));
      await f.close();
    });
    await t.test((react ? 'React' : 'static') + ' asynchronously polls the new intent until cashier is ready', async () => {
      const f = await fixture({ payment: { ok: true, pay_status: 'creating', order_pay_status: 'unpaid', next_action: 'poll' }, query: ready });
      await f.page.goto(bookingUrl(react)); await f.page.waitForSelector(paySelector(react), { visible: true });
      await Promise.all([f.page.waitForNavigation(), f.page.click(paySelector(react))]);
      assert.equal(new URL(f.page.url()).pathname, '/fake-cashier'); assert.ok(f.state.queries > 0);
      await f.close();
    });
    await t.test((react ? 'React' : 'static') + ' App bridge cancellation and payment return both remain usable', async () => {
      const f = await fixture({ app: true, payment: { payStatus: 'paying', cashierType: '1', cashierUrl: 'WalletSDK://isolated-cashier', appOrderId: 'XD_app' },
        query: { pay_status: 'creating', order_pay_status: 'unpaid', next_action: 'poll' } });
      await f.page.goto(bookingUrl(react)); await f.page.waitForSelector(paySelector(react), { visible: true });
      if (react) assert.equal(f.state.bridgeLoads, 0, 'React only loads SDK at App payment time');
      await f.page.click(paySelector(react)); await f.page.waitForFunction(() => Boolean(window.__cashierCall));
      assert.equal(f.state.payments[0].cashier_type, '1'); assert.equal(f.state.bridgeLoads, 1);
      await f.page.evaluate(() => window[window.__cashierCall.functionName]('{"code":-1}'));
      await f.page.waitForFunction(selector => { const b = document.querySelector(selector); return b && !b.disabled && b.dataset.submitting !== '1'; }, {}, paySelector(react));
      await f.page.evaluate(() => { window.__cashierCall = null; });
      await f.page.click(paySelector(react)); await f.page.waitForFunction(() => Boolean(window.__cashierCall));
      await Promise.all([f.page.waitForNavigation(), f.page.evaluate(() => window[window.__cashierCall.functionName]('{"code":0}'))]);
      await f.page.waitForSelector(titleSelector(react));
      assert.notEqual(await f.page.$eval(titleSelector(react), el => el.textContent), '支付成功', 'Native callback cannot prove a successful payment');
      assert.equal(f.state.payments[0].idempotency_key, f.state.payments[1].idempotency_key, 'Cancelled cashier reuses the same payment request');
      await f.close();
    });
    await t.test((react ? 'React' : 'static') + ' result page gives business closure and refunds precedence over paid attempts', async () => {
      for (const [query, order, expected] of [
        [{ order_pay_status: 'closed', pay_status: 'paid', next_action: 'closed' }, { pay_status: 'paid' }, '订单已关闭'],
        [{ order_pay_status: 'refunded', pay_status: 'paid', next_action: 'done' }, { pay_status: 'paid' }, '退款已完成'],
        [{ order_pay_status: 'paid', pay_status: 'paid', next_action: 'done' }, { status: 'cancelled', pay_status: 'refunding' }, '退款处理中'],
        [{ ok: true, result: { orderStatus: '30' } }, { pay_status: 'paid' }, '支付成功'],
        [{ ok: true, result: { orderStatus: '30' } }, { pay_status: 'unpaid' }, react ? '支付处理中' : '支付结果确认中'],
      ]) {
        const f = await fixture({ query, order });
        await f.page.goto(paidUrl(react));
        await f.page.waitForFunction((selector, text) => document.querySelector(selector)?.textContent === text, {}, titleSelector(react), expected);
        await f.close();
      }
    });
    await t.test((react ? 'React' : 'static') + ' result page retains lookup fallback when legacy query is unavailable', async () => {
      const f = await fixture({ queryStatus: 503, query: { error: 'isolated temporary query error' }, order: { pay_status: 'paid' } });
      await f.page.goto(paidUrl(react));
      await f.page.waitForFunction(selector => document.querySelector(selector)?.textContent === '支付成功', {}, titleSelector(react));
      await f.close();
    });
  }

  await t.test('cached HEAD static App page still opens compatible responses without new request fields', async () => {
    const f = await fixture({ app: true, payment: { ok: true, pay_status: 'paying', cashier_type: '1', cashier_url: 'WalletSDK://isolated-legacy', app_order_id: 'XD_legacy' } });
    await f.page.goto(bookingUrl(false).replace('/lvju-', '/legacy/lvju-'));
    await f.page.waitForSelector('#okPay', { visible: true }); await f.page.click('#okPay');
    await f.page.waitForFunction(() => Boolean(window.__cashierCall));
    assert.equal(f.state.payments[0].idempotency_key, undefined);
    assert.equal(f.state.payments[0].headers['idempotency-key'], undefined);
    assert.equal(await f.page.evaluate(() => window.__cashierCall.functionName), 'payAndBack');
    await f.close();
  });
});
