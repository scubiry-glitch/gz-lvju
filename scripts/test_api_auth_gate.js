#!/usr/bin/env node
/**
 * 对外 API 默认拒绝：C 端白名单可匿名，工单/管理台/商家密钥路径须 Key。
 */
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const app = require(path.join(ROOT, 'app.js'));

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

  // 旧全局 Key 已全面停用（规则 9）：C 端 GET 一律 401；仅涉写三路径过渡期放行
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
    true,
    'legacy key 过渡期仅 C 端涉写放行'
  );

  const leaked = app.stripVendorSecrets({
    id: 41,
    name: '来来',
    hmac_key: 'secret',
    url_link: 'https://x',
    order_detail_url: 'https://y',
  });
  assert.strictEqual(leaked.hmac_key, undefined);
  assert.strictEqual(leaked.url_link, undefined);
  assert.strictEqual(leaked.order_detail_url, undefined);
  assert.strictEqual(leaked.name, '来来');

  assert.strictEqual(app.isVendorHmacPath('/api/juzhu/callback', 'POST'), true);
  assert.strictEqual(app.isVendorHmacPath('/api/juzhu/jiazheng/vendor/products/list', 'POST'), true);
  assert.strictEqual(app.isVendorHmacPath('/api/juzhu/jiazheng/orders', 'POST'), false);

  if (prevKey === undefined) delete process.env.JUZHU_API_KEY;
  else process.env.JUZHU_API_KEY = prevKey;

  console.log('OK scripts/test_api_auth_gate.js');
}

run().catch((e) => { console.error(e); process.exit(1); });
