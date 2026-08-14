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

function testSelectMissingUnits() {
  const snap = [
    { id: 1, project_id: 1, name: 'kept' },
    { id: 2, project_id: 1, name: 'missing unit' },
    { id: 3, project_id: 99, name: 'other city' },
  ];
  const missing = housing.selectMissingUnits(snap, new Set([1]), new Set([1]));
  assert.deepStrictEqual(missing.map((u) => u.id), [2]);
  console.log('[PASS] testSelectMissingUnits');
}

function testHydrateCoverFields() {
  const catalog = {
    projects: [
      { id: 1, name: 'CCB', cover_image: '' },
      { id: 2, cover_image: 'keep.jpg' },
    ],
    units: [{ id: 10, cover_image: null }],
    districts: [{ id: 3, cover_image: null }],
    photos: [
      { entity_type: 'project', entity_id: 1, file_path: 'p-second.jpg', is_cover: 0, sort_order: 1 },
      { entity_type: 'project', entity_id: 1, file_path: 'p-cover.jpg', is_cover: 1, sort_order: 0 },
      { entity_type: 'unit', entity_id: 10, file_path: 'u.jpg', is_cover: 0, sort_order: 0 },
      { entity_type: 'district', entity_id: 3, file_path: 'd.jpg', is_cover: 1, sort_order: 0 },
    ],
  };
  housing.hydrateCoverFields(catalog);
  assert.strictEqual(catalog.projects[0].cover_image, 'p-cover.jpg');
  assert.strictEqual(catalog.projects[1].cover_image, 'keep.jpg');
  assert.strictEqual(catalog.units[0].cover_image, 'u.jpg');
  assert.strictEqual(catalog.districts[0].cover_image, 'd.jpg');
  console.log('[PASS] testHydrateCoverFields');
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
  assert.deepStrictEqual(housing.parseJsonField('"[\\"建融家园\\"]"'), ['建融家园']);
  console.log('[PASS] testParseJsonField');
}

function testTagsToDb() {
  const enc = JSON.stringify(['建融家园']);
  assert.strictEqual(housing.tagsToDb(['建融家园']), enc);
  assert.strictEqual(housing.tagsToDb('建融家园'), enc);
  assert.strictEqual(housing.tagsToDb('["建融家园"]'), enc);
  assert.strictEqual(housing.tagsToDb('"[\\"建融家园\\"]"'), enc);
  assert.deepStrictEqual(JSON.parse(housing.tagsToDb('建融家园, 近地铁')), ['建融家园', '近地铁']);
  assert.strictEqual(housing.tagsToDb(null), null);
  assert.strictEqual(housing.tagsToDb(''), null);
  console.log('[PASS] testTagsToDb');
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

function testCallbackValidate() {
  assert.strictEqual(gr.validateCallbackBody({ order_ref: 'GR1', vendor_oid: 'V1', status: 'paid', fee: 1 }).ok, true);
  assert.strictEqual(gr.validateCallbackBody({ order_ref: 'GR1', vendor_oid: 'V1', status: 'paid' }).ok, false);
  console.log('[PASS] testCallbackValidate');
}

function testCityWriteValidate() {
  const cities = require('./housing_cities.cjs');
  assert.deepStrictEqual(cities.validateCityWrite({}), {
    ok: false, error: '城市名称不能为空', status: 400,
  });
  assert.deepStrictEqual(cities.validateCityWrite({ name: '  ' }), {
    ok: false, error: '城市名称不能为空', status: 400,
  });
  const created = cities.validateCityWrite({ name: '合肥（试点）' });
  assert.strictEqual(created.ok, true);
  assert.deepStrictEqual(created.fields, { name: '合肥（试点）', slug: '合肥' });
  const withSlug = cities.validateCityWrite({
    name: '合肥', slug: ' hefei ', booking_phone: ' 0551-1 ', hero_bg_image: ' a.jpg ',
  });
  assert.deepStrictEqual(withSlug.fields, {
    name: '合肥', slug: 'hefei', booking_phone: '0551-1', hero_bg_image: 'a.jpg',
  });
  assert.deepStrictEqual(cities.validateCityWrite({}, { partial: true }), {
    ok: false, error: '无更新字段', status: 400,
  });
  assert.deepStrictEqual(cities.validateCityWrite({ name: '' }, { partial: true }), {
    ok: false, error: '城市名称不能为空', status: 400,
  });
  console.log('[PASS] testCityWriteValidate');
}

function testCityDeleteGuard() {
  const cities = require('./housing_cities.cjs');
  assert.deepStrictEqual(cities.canDeleteCity({ cityCount: 1, districtCount: 0, projectCount: 0 }), {
    ok: false, error: '至少保留一座城市', status: 400,
  });
  assert.deepStrictEqual(cities.canDeleteCity({ cityCount: 2, districtCount: 3, projectCount: 0 }), {
    ok: false, error: '该城市仍有 3 个行政区，无法删除', status: 400,
  });
  assert.deepStrictEqual(cities.canDeleteCity({ cityCount: 2, districtCount: 0, projectCount: 5 }), {
    ok: false, error: '该城市仍有 5 个项目，无法删除', status: 400,
  });
  assert.deepStrictEqual(cities.canDeleteCity({ cityCount: 2, districtCount: 0, projectCount: 0 }), { ok: true });
  console.log('[PASS] testCityDeleteGuard');
}

function testPickCity() {
  const cities = require('./housing_cities.cjs');
  const list = [
    { id: 1, name: '沈阳', slug: 'shenyang' },
    { id: 2, name: '南京', slug: 'nanjing' },
  ];
  assert.strictEqual(cities.pickCity([], 'nanjing'), null);
  assert.strictEqual(cities.pickCity(list, '').id, 1);
  assert.strictEqual(cities.pickCity(list, 'nanjing').id, 2);
  assert.strictEqual(cities.pickCity(list, '南京').id, 2);
  assert.strictEqual(cities.pickCity(list, '2').id, 2);
  assert.strictEqual(cities.pickCity(list, 'missing'), null);
  console.log('[PASS] testPickCity');
}

function testDuplicateCityError() {
  const cities = require('./housing_cities.cjs');
  assert.deepStrictEqual(cities.duplicateCityError('name'), {
    ok: false, error: '城市名称已存在', status: 400,
  });
  assert.deepStrictEqual(cities.duplicateCityError('slug'), {
    ok: false, error: 'slug 已存在', status: 400,
  });
  assert.strictEqual(cities.classifyDupKey({ code: 'ER_DUP_ENTRY', message: "Duplicate entry 'hefei' for key 'cities.uk_slug'" }), 'slug');
  assert.strictEqual(cities.classifyDupKey({ code: 'ER_DUP_ENTRY', message: "Duplicate entry '合肥' for key 'cities.uk_name'" }), 'name');
  assert.strictEqual(cities.classifyDupKey(new Error('DB 查询失败')), null);
  console.log('[PASS] testDuplicateCityError');
}

function run() {
  testLoadSnapshots();
  testSelectMissingUnits();
  testHydrateCoverFields();
  testEncJsonFields();
  testParseJsonField();
  testTagsToDb();
  testOrderRef();
  testWechatLinkValidate();
  testGrOrdersValidate();
  testNormEta();
  testVendorConfigParse();
  testFilterPending();
  testCallbackValidate();
  testCityWriteValidate();
  testCityDeleteGuard();
  testPickCity();
  testDuplicateCityError();
  console.log('all passed');
}

run();
