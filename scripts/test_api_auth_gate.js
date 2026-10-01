#!/usr/bin/env node
/**
 * 对外 API 默认拒绝：C 端白名单可匿名，工单/管理台/商家密钥路径须 Key。
 */
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const app = require(path.join(ROOT, 'app.js'));
// Authentication gate tests use no host database or external identity provider.
require('../auth_center.cjs').init({
  query: async () => [], exec: async () => ({}),
  expectedApiKey: app.expectedApiKey, expectedAdminPassword: () => '', isProduction: () => false,
  jsonReply: (res, body, status = 200) => { res.writeHead(status); res.end(JSON.stringify(body)); },
});

function mockRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code; },
    end(buf) { this.body = buf ? String(buf) : ''; },
  };
}

async function run() {
  const prevKey = process.env.JUZHU_API_KEY;
  process.env.JUZHU_API_KEY = 'local-only-change-me';

  const publicGets = [
    '/api/juzhu/catalog',
    '/api/juzhu/cities',
    '/api/juzhu/settings',
    '/api/juzhu/jiazheng/categories',
    '/api/juzhu/jiazheng/skus/deep-clean-4h',
    '/api/juzhu/jiazheng/skus/deep-clean-4h/vendors',
    '/api/juzhu/projects/1',
    '/api/juzhu/projects/1/virtual-phone',
    '/api/juzhu/gr/orders',
    '/api/juzhu/gr/orders/GR-1',
    '/api/juzhu/gr/orders/GR-1/vendor-detail',
  ];
  for (const p of publicGets) {
    assert.strictEqual(app.isCEndPublicApi(p, 'GET'), true, 'public GET ' + p);
  }
  assert.strictEqual(app.isCEndPublicApi('/api/juzhu/jiazheng/wechat-link', 'POST'), true);

  const keyed = [
    ['GET', '/api/juzhu/jiazheng/orders'],
    ['GET', '/api/juzhu/jiazheng/orders?phone=13800000000'],
    ['GET', '/api/juzhu/jiazheng/orders/WO-1'],
    ['GET', '/api/juzhu/jiazheng/orders/stats'],
    ['POST', '/api/juzhu/jiazheng/orders'],
    ['POST', '/api/juzhu/jiazheng/orders/WO-1/pay'],
    ['POST', '/api/juzhu/jiazheng/orders/WO-1/rate'],
    ['GET', '/api/juzhu/jz/vendors'],
    ['GET', '/api/juzhu/jz/orders'],
    ['GET', '/api/juzhu/jz/orders/overview'],
    ['GET', '/api/juzhu/jz/workers'],
  ];
  for (const [m, p] of keyed) {
    const pathOnly = p.split('?')[0];
    assert.strictEqual(app.isCEndPublicApi(pathOnly, m), false, 'keyed ' + m + ' ' + p);
    const res = mockRes();
    assert.strictEqual(
      await app.assertApiAuthorized(pathOnly, { method: m, headers: {} }, res),
      false,
      '401 ' + m + ' ' + p
    );
    assert.strictEqual(res.statusCode, 401);
  }

  // 支付订单须本人账号；旧全局 Key 不能创建真实支付订单。
  const resLegacyGet = mockRes();
  assert.strictEqual(
    await app.assertApiAuthorized(
      '/api/juzhu/jiazheng/orders',
      { method: 'GET', headers: { 'x-api-key': 'local-only-change-me' } },
      resLegacyGet
    ),
    false,
    'legacy key C 端 GET 应 401'
  );
  assert.strictEqual(resLegacyGet.statusCode, 401);
  const resOk = mockRes();
  assert.strictEqual(
    await app.assertApiAuthorized(
      '/api/juzhu/jiazheng/orders',
      { method: 'POST', headers: { 'x-api-key': 'local-only-change-me' } },
      resOk
    ),
    false,
    'legacy key 不允许创建真实支付订单'
  );

  assert.strictEqual(resOk.statusCode, 401);
  const principal = { type: 'account', account: { id: 'account-test', principal_type: 'user', status: 'active', idp_type: 'beike', idp_subject: 'ucid-test' }, roles: [] };
  for (const [method, route] of [['GET','/api/juzhu/jiazheng/orders'], ['POST','/api/juzhu/jz/orders'], ['GET','/api/juzhu/jz/orders/WO-1'], ['POST','/api/juzhu/jiazheng/orders/WO-1/pay'], ['POST','/api/juzhu/jiazheng/orders/WO-1/payment'], ['GET','/api/juzhu/jiazheng/orders/WO-1/payment'], ['POST','/api/juzhu/jiazheng/orders/WO-1/cancel'], ['GET','/api/juzhu/booking/my']]) {
    assert.strictEqual(app.isPaymentCustomerApi(route, method), true);
    assert.strictEqual(await app.assertApiAuthorized(route, { method, headers: {}, principal }, mockRes()), true);
  }
  assert.strictEqual(app.isPaymentCustomerApi('/api/juzhu/jiazheng/orders/stats', 'GET'), false);
  assert.strictEqual(app.isPaymentCustomerApi('/api/juzhu/jz/orders/overview', 'GET'), false);
  assert.strictEqual(app.isPaymentCustomerApi('/api/juzhu/jz/orders', 'GET'), false);
  for(const [method,route] of [['POST','/api/juzhu/jz/orders'],['GET','/api/juzhu/jz/orders/WO-1'],['GET','/api/juzhu/jiazheng/orders/WO-1/payment']]){
    assert.strictEqual(app.isCEndPublicApi(route,method),false);
    assert.strictEqual(await app.assertApiAuthorized(route,{method,headers:{}},mockRes()),false);
    assert.strictEqual(await app.assertApiAuthorized(route,{method,headers:{'x-api-key':'local-only-change-me'}},mockRes()),false);
  }
  const mine = await app.grUserQuery({ headers: {}, principal }, new URLSearchParams('source=account'));
  assert.deepStrictEqual(mine.userIds, ['commerce-account-account-test', 'ucid-test']);
  const forged = await app.grUserQuery({ headers: {}, principal }, new URLSearchParams('source=account&user_id=commerce-account-other'));
  assert.strictEqual(forged.status, 403);

  const leaked = app.stripVendorSecrets({
    id: 41,
    name: '来来',
    hmac_key: 'secret',
    url_link: 'https://x',
    order_detail_url: 'https://y',
    pay_merchant_no: 'test-merchant',
    payment_config_json: '{}',
  });
  assert.strictEqual(leaked.hmac_key, undefined);
  assert.strictEqual(leaked.url_link, undefined);
  assert.strictEqual(leaked.order_detail_url, undefined);
  assert.strictEqual(leaked.name, '来来');
  assert.strictEqual(leaked.pay_merchant_no, undefined);
  assert.strictEqual(leaked.payment_config_json, undefined);

  assert.strictEqual(app.isVendorHmacPath('/api/juzhu/callback', 'POST'), true);
  assert.strictEqual(app.isVendorHmacPath('/api/juzhu/jiazheng/vendor/products/list', 'POST'), true);
  assert.strictEqual(app.isVendorHmacPath('/api/juzhu/jiazheng/orders', 'POST'), false);

  if (prevKey === undefined) delete process.env.JUZHU_API_KEY;
  else process.env.JUZHU_API_KEY = prevKey;

  console.log('OK scripts/test_api_auth_gate.js');
}

run().catch((e) => { console.error(e); process.exit(1); });
