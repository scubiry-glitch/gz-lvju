#!/usr/bin/env node
/**
 * 保租房种子 + 我的订单/wechat-link 纯函数单测（不连 MySQL）
 */
const assert = require('assert');
const path = require('path');

const housing = require('./housing_seed.cjs');
const gr = require('./gr_orders.cjs');
const vendor = require('./vendor_config.cjs');

function testLoadSnapshots() {
  const snap = housing.loadSnapshots(path.join(__dirname, 'juzhu'));
  assert.ok(snap.cities.length >= 3, '应包含沈阳/南京/贵阳');
  const slugs = snap.cities.map((c) => c.slug).sort();
  assert.deepStrictEqual(slugs.slice(0, 3), ['guiyang', 'nanjing', 'shenyang']);
  assert.ok(snap.districts.length >= 30, `districts=${snap.districts.length}`);
  assert.ok(snap.projects.length >= 40, `projects=${snap.projects.length}`);
  assert.ok(snap.units.length >= 100, `units=${snap.units.length}`);
  assert.ok(snap.photos.length >= 400, `photos=${snap.photos.length}`);
  const cityIds = new Set(snap.cities.map((c) => c.id));
  assert.ok(cityIds.has(1) && cityIds.has(2) && cityIds.has(3));
  console.log('[PASS] testLoadSnapshots', {
    cities: snap.cities.length,
    districts: snap.districts.length,
    projects: snap.projects.length,
    units: snap.units.length,
    photos: snap.photos.length,
  });
}

function testEncJsonFields() {
  assert.strictEqual(housing.enc(null), null);
  assert.strictEqual(housing.enc('foo'), 'foo');
  assert.strictEqual(housing.enc(['a', 'b']), JSON.stringify(['a', 'b']));
  assert.strictEqual(housing.enc({ stars: 4 }), JSON.stringify({ stars: 4 }));
  console.log('[PASS] testEncJsonFields');
}

function testParseJsonField() {
  assert.deepStrictEqual(housing.parseJsonField(null), null);
  assert.deepStrictEqual(housing.parseJsonField(['a']), ['a']);
  assert.deepStrictEqual(housing.parseJsonField('["a","b"]'), ['a', 'b']);
  assert.deepStrictEqual(housing.parseJsonField('{"stars":4}'), { stars: 4 });
  assert.strictEqual(housing.parseJsonField('not-json'), 'not-json');
  console.log('[PASS] testParseJsonField');
}

function testOrderRef() {
  const ref = gr.makeOrderRef(new Date('2026-08-14T04:26:00+08:00'), 42);
  assert.strictEqual(ref, 'GR202608140426000042');
  assert.match(gr.makeOrderRef(), /^GR\d{14}\d{4}$/);
  console.log('[PASS] testOrderRef');
}

function testWechatLinkValidate() {
  assert.deepStrictEqual(gr.validateWechatLinkBody({}), {
    ok: false, error: '缺少 product_id 参数', status: 400,
  });
  assert.deepStrictEqual(gr.validateWechatLinkBody({ product_id: 101, user_id: 'u1' }), {
    ok: true, productId: 101, userId: 'u1',
  });
  console.log('[PASS] testWechatLinkValidate');
}

function testGrOrdersValidate() {
  assert.deepStrictEqual(gr.validateUserIdQuery(''), {
    ok: false, error: '缺少 user_id 参数', status: 400,
  });
  assert.deepStrictEqual(gr.validateUserIdQuery('  abc '), { ok: true, userId: 'abc' });
  console.log('[PASS] testGrOrdersValidate');
}

function testNormEta() {
  assert.strictEqual(gr.normEtaPeking('2026-08-07 14:00:00'), '2026-08-07 14:00:00');
  assert.strictEqual(gr.normEtaPeking('2026-08-07T14:00:00+08:00'), '2026-08-07 14:00:00');
  assert.strictEqual(gr.normEtaPeking('2026-08-07T14:00:00Z'), '2026-08-07 22:00:00');
  assert.strictEqual(gr.normEtaPeking(''), '');
  console.log('[PASS] testNormEta');
}

function testVendorConfigParse() {
  const text = [
    '# comment',
    '1|hmac-aaa|https://vendor.example/link|https://vendor.example/detail',
    '2|hmac-bbb',
    '',
  ].join('\n');
  const map = vendor.parseVendorConfig(text);
  assert.strictEqual(map['1'].url_link, 'https://vendor.example/link');
  assert.strictEqual(map['1'].order_detail_url, 'https://vendor.example/detail');
  assert.strictEqual(map['2'].url_link, '');
  assert.strictEqual(map['2'].key, 'hmac-bbb');
  console.log('[PASS] testVendorConfigParse');
}

function testFilterPending() {
  const rows = [
    { status: 'pending', id: 1 },
    { status: 'paid', id: 2 },
    { status: 'assigned', id: 3 },
    { status: 'serving', id: 4 },
    { status: 'completed', id: 5 },
    { status: 'cancelled', id: 6 },
  ];
  const out = gr.summarizeUserOrders(rows);
  assert.strictEqual(out.list.length, 5);
  assert.deepStrictEqual(out.counts, { paid: 1, assigned: 1, serving: 1, completed: 1 });
  console.log('[PASS] testFilterPending');
}

function run() {
  testLoadSnapshots();
  testEncJsonFields();
  testParseJsonField();
  testOrderRef();
  testWechatLinkValidate();
  testGrOrdersValidate();
  testNormEta();
  testVendorConfigParse();
  testFilterPending();
  console.log('all passed');
}

run();
