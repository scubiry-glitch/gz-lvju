'use strict';

// Pin the pre-cashier contract so committing this change does not replace the legacy fixture.
const LEGACY_REF = process.env.PAYMENT_LEGACY_REF || 'f68bdb53f47f6e1e973b26d12e368f07c259f67a';

// Real current/HEAD HTML and JavaScript, isolated HTTP responses only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const modulePath = process.env.PAYMENT_BROWSER_MODULE, executablePath = process.env.PAYMENT_BROWSER_EXECUTABLE;
const root = path.resolve(__dirname, '../..');

test('life-service and membership clients retain legacy contracts without optimistic paid states', { skip: !modulePath || !executablePath, timeout: 150000 }, async t => {
  const puppeteer = (await import(pathToFileURL(modulePath).href)).default;
  const server = http.createServer(async (req, res) => {
    try {
      let pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/fake-cashier' || pathname === '/fake-mini') { res.end('<!doctype html><title>Isolated navigation</title>Isolated navigation'); return; }
      const legacy = pathname.startsWith('/legacy/'); if (legacy) pathname = pathname.slice(7);
      const filename = path.join(root, pathname);
      if (!filename.startsWith(root + path.sep)) throw new Error('outside fixture root');
      const body = legacy && (['/lvju-app-pay.html', '/juzhu-jiazheng-detail.html'].includes(pathname) || /_commerce-(?:official|customer|consumer)\.js$/.test(pathname))
        ? execFileSync('git', ['show', LEGACY_REF + ':' + pathname.slice(1)], { cwd: root }) : await fs.readFile(filename);
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(pathname)] || 'application/octet-stream');
      res.end(body);
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const oid = '00000000-0000-4000-8000-000000000001', couponId = '00000000-0000-4000-8000-000000000002';
  const account = { id: 'test-user', display_name: 'Isolated user', payment_identity_ready: true };
  const product = { id: 15, vendor_id: 2, title: '隔离清洁服务', vendor_name: '测试商家', price: 123.45, payment_mode: 'pay_center', category_id: 'cleaning' };
  const order = { id: 'WO-fixture', status: 'pending', pay_status: 'unpaid', payment_mode: 'pay_center', fee: 12345, amount_minor: 12345,
    product_name: '隔离清洁服务', house: 'Test address', expectTime: '2099-10-02 18:00', category: '保洁' };
  const memberProduct = { kind: 'plans', id: 1, version: 7, name: '隔离会员', description: 'isolated fixture', price_minor: 1000,
    valid_days: 30, city_name: '沈阳', items: [{ name: '测试券', quantity: 1, valid_days: 30, description: 'test', conditions: 'test' }],
    is_demo: true, demo_purchase_enabled: true, purchase_enabled: false };
  const coupon = { id: couponId, order_id: oid, name: '隔离会员券', status: 'available', expires_at: '2099-12-31', is_demo: true,
    description: 'test', conditions: 'test', redeem_channel: 'online' };
  async function fixture(options = {}) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    const state = { requests: [], errors: [], dialogs: [], products: [{ ...product }], order: { ...order },
      member: { ...memberProduct }, query: { pay_status: 'creating', order_pay_status: 'unpaid', next_action: 'poll' },
      payment: { pay_status: 'paying', order_pay_status: 'unpaid', cashier_type: options.app ? '1' : '2',
        cashier_url: options.app ? 'WalletSDK://isolated' : origin + '/fake-cashier', next_action: 'open_cashier' }, ...options };
    await page.setViewport({ width: 430, height: 930 });
    if (options.app) await page.setUserAgent('Mozilla/5.0 Lianjia/Beike lianjiabeike');
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('BJZ_TOKEN', 'isolated-token'); localStorage.setItem('BZF_SESSION_TOKEN', 'isolated-token');
      document.cookie = 'lianjia_token=isolated-token; path=/';
      const timeout = window.setTimeout.bind(window), interval = window.setInterval.bind(window);
      window.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 750 || ms === 1500 ? 10 : ms, ...args);
      window.setInterval = (fn, ms, ...args) => interval(fn, ms === 1500 ? 30 : ms, ...args);
    });
    page.on('pageerror', error => state.errors.push(error.message));
    page.on('dialog', async dialog => { state.dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const url = new URL(request.url()); if (url.origin !== origin) return request.abort();
      const pathname = url.pathname.replace(/^\/legacy/, '');
      const json = (body, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (pathname.startsWith('/api/')) {
        const body = request.postData() ? JSON.parse(request.postData()) : null;
        state.requests.push({ path: pathname, method: request.method(), body, headers: request.headers() });
        if (pathname === '/api/auth/me') return json({ account: { ...account, idp_type: 'beike', idp_subject: 'test-ucid' }, role: 'user' });
        if (pathname === '/api/juzhu/jiazheng/skus/cleaning') return json({ item: { id: 70, slug: 'cleaning', name: '日常保洁', category_id: 'cleaning' },
          products: state.products, product: state.products[0], related: [], vendors: [], workers: [], reviews: [] });
        if (pathname === '/api/juzhu/jiazheng/orders' && request.method() === 'POST') return json({ ok: true, order: state.createOrder ? state.createOrder(body) : state.order }, 201);
        if (/^\/api\/juzhu\/jiazheng\/orders\/WO-[^/]+$/.test(pathname)) return json({ order: state.order });
        if (/^\/api\/juzhu\/jiazheng\/orders\/WO-[^/]+\/pay$/.test(pathname)) return json({ ok: true, order: state.order, ...state.payment }, 202);
        if (/^\/api\/juzhu\/jiazheng\/orders\/WO-[^/]+\/payment$/.test(pathname)) return json(state.query);
        if (pathname === '/api/juzhu/jiazheng/wechat-link') return json(state.miniError ? { ok: false, error: 'isolated link failure' } : { ok: true, url_link: origin + '/fake-mini' }, state.miniError ? 503 : 200);
        if (pathname === '/api/commerce/v1/me') return json({ data: { account, permissions: [], scope: {} } });
        if (pathname === '/api/commerce/v1/catalog') return json({ data: [state.member] });
        if (pathname === '/api/commerce/v1/my') return json({ data: { coupons: [coupon], memberships: [], appointments: [], cases: [],
          orders: [{ id: oid, product_kind: 'plans', product_id: 1, product_version: state.member.version, name: '隔离会员', status: 'reserved', amount_minor: 1000 }] } });
        if (pathname === '/api/commerce/v1/demo-orders') return json({ data: { coupon_count: 1 } }, 201);
        if (pathname === '/api/commerce/v1/coupons/' + couponId + '/token') return json({ data: { coupon_id: couponId, token: 'isolated-dynamic-code', expires_in: 60 } });
        if (pathname === '/api/commerce/v1/orders') return json({ error: 'isolated request recorded' }, 409);
        if (pathname === '/api/commerce/v1/orders/' + oid + '/payment') return json({ data: state.query });
        if (pathname === '/api/commerce/v1/orders/' + oid + '/pay') return json({ data: state.payment }, 202);
        return json({});
      }
      if (pathname === '/jsbridgesdk.js' && options.app) {
        const code = await fs.readFile(path.join(root, 'jsbridgesdk.js'), 'utf8');
        return request.respond({ contentType: 'text/javascript', body: code + '\nwindow.JsBridgeV3.getSchemeLink=function(){return "lianjiabeike://bkjfwallet?url=";};window.JsBridgeV3.callAndBack=function(input){window.__cashierCall=input;};' });
      }
      return request.continue();
    });
    return { page, state, close: async () => { assert.deepEqual(state.errors, []); await context.close(); } };
  }

  await t.test('SKU-only booking selects the explicit product and reuses pending keys until a terminal order', async () => {
    const f = await fixture();
    async function submit() {
      await f.page.goto(origin + '/jiazheng-booking.html?sku=cleaning&time=2099-10-02%2018:00');
      await f.page.waitForFunction(() => document.querySelector('#productSummary').textContent.includes('隔离清洁服务'));
      await f.page.type('#houseInput', 'Test address'); await f.page.type('#phoneInput', '13000000000');
      await f.page.click('#submitBtn');
      await f.page.waitForFunction(() => location.pathname === '/lvju-app-pay.html');
      await f.page.waitForFunction(() => document.querySelector('#payAmt').textContent === '¥123.45');
    }
    await submit();
    const sent = f.state.requests.find(r => r.path === '/api/juzhu/jiazheng/orders' && r.method === 'POST');
    assert.equal(sent.body.product_id, 15); assert.equal(sent.body.sku_id, undefined); assert.equal(sent.body.price_minor, 12345);
    await submit();
    let creates = f.state.requests.filter(r => r.path === '/api/juzhu/jiazheng/orders' && r.method === 'POST');
    assert.equal(creates.length, 2); assert.equal(creates[0].body.idempotency_key, creates[1].body.idempotency_key);
    for (const terminal of ['cancelled', 'done']) {
      const oldKey = creates.at(-1).body.idempotency_key;
      f.state.createOrder = body => {
        if (body.idempotency_key === oldKey) return { ...f.state.order, status: terminal };
        f.state.order = { ...f.state.order, id: 'WO-' + terminal, status: 'pending' };
        return f.state.order;
      };
      await submit();
      creates = f.state.requests.filter(r => r.path === '/api/juzhu/jiazheng/orders' && r.method === 'POST');
      assert.equal(creates.at(-2).body.idempotency_key, oldKey);
      assert.notEqual(creates.at(-1).body.idempotency_key, oldKey);
      assert.ok(f.page.url().includes('order=WO-' + terminal));
    }
    await f.close();
  });
  await t.test('ambiguous products and mini-program products cannot silently enter the shared cashier', async () => {
    for (const products of [[product, { ...product, id: 16, vendor_id: 3 }], [{ ...product, payment_mode: 'wechat_mini' }]]) {
      const f = await fixture({ products }); await f.page.goto(origin + '/jiazheng-booking.html?sku=cleaning');
      await f.page.waitForFunction(() => document.querySelector('#submitBtn').getAttribute('aria-disabled') === 'true');
      assert.equal(f.state.requests.some(r => r.method === 'POST' && r.path.startsWith('/api/juzhu/jiazheng/orders')), false); await f.close();
    }
  });
  await t.test('cached legacy App pay page with refreshed API bus rejects unconfirmed callbacks', async () => {
    const f = await fixture({ app: true });
    await f.page.goto(origin + '/legacy/lvju-app-pay.html?channel=jiazheng&order=WO-fixture');
    await f.page.waitForFunction(() => document.querySelector('#payBtn').textContent.includes('确认支付'));
    await f.page.click('#payBtn'); await f.page.waitForFunction(() => Boolean(window.__cashierCall));
    await f.page.evaluate(() => window[window.__cashierCall.functionName]('{"code":0}'));
    await f.page.waitForFunction(() => location.pathname === '/legacy/lvju-app-pay.html');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(f.state.dialogs.join(' '), /尚未确认支付成功/);
    const sent = f.state.requests.find(r => r.path.endsWith('/WO-fixture/pay'));
    assert.equal(sent.body.pay_method, '贝壳支付'); assert.equal(sent.body.cashier_type, '1');
    await f.close();
  });
  await t.test('old mini-program request fields remain unchanged and failures never switch payment channels', async () => {
    for (const legacy of [true, false]) {
      const f = await fixture({ products: [{ ...product, payment_mode: 'wechat_mini' }], miniError: !legacy });
      await f.page.goto(origin + (legacy ? '/legacy' : '') + '/juzhu-jiazheng-detail.html?sku=cleaning');
      await f.page.waitForSelector('#hero h1');
      await f.page.evaluate(() => { window.BZF_JZ.ensureUserId = () => Promise.resolve('isolated-user-id'); });
      await f.page.click('#submitBtn');
      if (legacy) await f.page.waitForFunction(() => location.pathname === '/fake-mini');
      else await f.page.waitForFunction(() => document.body.textContent.includes('isolated link failure'));
      const sent = f.state.requests.find(r => r.path === '/api/juzhu/jiazheng/wechat-link');
      assert.deepEqual(sent.body, { product_id: 15, user_id: 'isolated-user-id' });
      assert.equal(Boolean(sent.headers['idempotency-key']), !legacy);
      assert.equal(f.state.requests.some(r => r.method === 'POST' && r.path.includes('/jiazheng/orders')), false);
      await f.close();
    }
  });
  for (const legacy of [false, true]) {
    await t.test((legacy ? 'HEAD' : 'current') + ' membership demo purchase and coupon token retain original envelopes', async () => {
      const f = await fixture(), prefix = origin + (legacy ? '/legacy' : '');
      await f.page.goto(prefix + '/juzhu-voucher.html?kind=plans&id=1');
      await f.page.waitForSelector('[data-action=checkout]'); await f.page.click('[data-action=checkout]');
      await f.page.waitForSelector('dialog[open] [name=demo_ack]'); await f.page.click('[name=demo_ack]');
      await f.page.click('dialog[open] [type=submit]');
      await f.page.waitForFunction(() => location.search.includes('view=coupons'));
      const sent = f.state.requests.find(r => r.path === '/api/commerce/v1/demo-orders');
      assert.deepEqual(sent.body, { kind: 'plans', product_id: 1, version: 7, demo_ack: true });
      assert.ok(sent.headers['idempotency-key']);
      assert.equal(f.state.requests.some(r => r.path === '/api/commerce/v1/orders'), false);
      await f.page.goto(prefix + '/juzhu-voucher.html?coupon=' + couponId);
      await f.page.waitForSelector('[data-action=code]'); await f.page.click('[data-action=code]');
      await f.page.waitForSelector('dialog[open] .voucher-qr svg');
      assert.equal(await f.page.$eval('.commerce-code', e => e.textContent), 'isolated-dynamic-code');
      const tokenRequest = f.state.requests.find(r => r.path.endsWith('/token'));
      assert.deepEqual(tokenRequest.body, {}); await f.close();
    });
  }
  await t.test('real membership App payment loads its bridge and keeps refunded status ahead of fulfilled', async () => {
    const f = await fixture({ app: true });
    await f.page.goto(origin + '/juzhu-commerce.html?view=orders&order=' + oid + '&pay=1');
    await f.page.waitForFunction(() => Boolean(window.__cashierCall));
    const sent = f.state.requests.find(r => r.path === '/api/commerce/v1/orders/' + oid + '/pay');
    assert.equal(sent.body.cashier_type, '1');
    f.state.query = { order_pay_status: 'refunded', pay_status: 'paid', fulfillment_status: 'fulfilled', commerce_status: 'refunded' };
    await f.page.evaluate(() => window[window.__cashierCall.functionName]('{"code":0}'));
    await f.page.waitForFunction(() => document.querySelector('#commerce-status').textContent === '退款已完成');
    await f.close();
  });
  await t.test('real membership order keys change with product version while preserving request fields', async () => {
    const f = await fixture({ member: { ...memberProduct, is_demo: false, demo_purchase_enabled: false, purchase_enabled: true } });
    for (const version of [7, 8]) {
      f.state.member.version = version;
      await f.page.goto(origin + '/juzhu-voucher.html?kind=plans&id=1');
      await f.page.waitForSelector('[data-action=checkout]'); await f.page.click('[data-action=checkout]');
      await f.page.waitForSelector('dialog[open] [type=submit]'); await f.page.click('dialog[open] [type=submit]');
      await f.page.waitForFunction(() => document.querySelector('.dialog-error')?.textContent === 'isolated request recorded');
    }
    const sent = f.state.requests.filter(r => r.path === '/api/commerce/v1/orders');
    assert.deepEqual(sent.map(r => r.body), [{ kind: 'plans', product_id: 1, version: 7 }, { kind: 'plans', product_id: 1, version: 8 }]);
    assert.notEqual(sent[0].headers['idempotency-key'], sent[1].headers['idempotency-key']); await f.close();
  });
});
