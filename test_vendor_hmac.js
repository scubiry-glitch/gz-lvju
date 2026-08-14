#!/usr/bin/env node
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const hmac = require('./hmac_auth.cjs');
const vendorApi = require('./vendor_api.cjs');
const gr = require('./gr_orders.cjs');

function testFlatten() {
  const flat = hmac.flattenAndFilter({
    vendor_id: 41,
    status: 'on',
    worker: { name: '李师傅', phone: '139****5678', eta: '2026-08-07 14:00:00' },
    empty: '',
    nada: null,
  });
  assert.strictEqual(flat.vendor_id, '41');
  assert.strictEqual(flat.status, 'on');
  assert.strictEqual(flat['worker.name'], '李师傅');
  assert.strictEqual(flat['worker.phone'], '139****5678');
  assert.ok(!('empty' in flat));
  assert.ok(!('nada' in flat));
  console.log('[PASS] testFlatten');
}

function testKnownSign() {
  const secret = 'test-secret';
  const ts = 1785998316159;
  const signed = hmac.generateSignature(secret, { vendor_id: 41, status: 'on' }, ts);
  const stringToSign = 'status=on&timestamp=1785998316159&vendor_id=41';
  const expect = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('hex');
  assert.strictEqual(signed.sign, expect);
  assert.strictEqual(signed.timestamp, ts);
  console.log('[PASS] testKnownSign');
}

function testVerify() {
  const secret = 'test-secret';
  const signed = hmac.generateSignature(secret, { vendor_id: 41, status: 'on' });
  const ok = hmac.verifySignature(secret, signed);
  assert.strictEqual(ok.ok, true);
  const bad = hmac.verifySignature(secret, Object.assign({}, signed, { sign: 'deadbeef' }));
  assert.strictEqual(bad.ok, false);
  const noTs = hmac.verifySignature(secret, { vendor_id: 41, sign: 'abc' });
  assert.strictEqual(noTs.ok, false);
  console.log('[PASS] testVerify');
}

function testVerifyVendorAuth() {
  const secret = 'k1';
  const vendors = { '41': { key: secret } };
  const signed = hmac.generateSignature(secret, { vendor_id: 41, status: 'on' });
  const ok = vendorApi.verifyVendorAuth(signed, vendors);
  assert.strictEqual(ok.vendorId, 41);
  const miss = vendorApi.verifyVendorAuth({ vendor_id: 41, timestamp: Date.now(), sign: 'x' }, vendors);
  assert.ok(miss.error);
  const noVid = vendorApi.verifyVendorAuth({ timestamp: Date.now(), sign: 'x' }, vendors);
  assert.strictEqual(noVid.error, '缺少 vendor_id 参数');
  console.log('[PASS] testVerifyVendorAuth');
}

function testCallbackValidate() {
  assert.strictEqual(gr.validateCallbackBody({}).message, '缺少 order_ref 参数');
  assert.strictEqual(gr.validateCallbackBody({ order_ref: 'GR1' }).message, '缺少 vendor_oid 参数');
  assert.strictEqual(gr.validateCallbackBody({ order_ref: 'GR1', vendor_oid: 'V1' }).message, '缺少 status 参数');
  assert.ok(gr.validateCallbackBody({ order_ref: 'GR1', vendor_oid: 'V1', status: 'paid' }).message);
  const paid = gr.validateCallbackBody({ order_ref: 'GR1', vendor_oid: 'V1', status: 'paid', fee: 9900 });
  assert.strictEqual(paid.ok, true);
  const assigned = gr.validateCallbackBody({
    order_ref: 'GR1', vendor_oid: 'V1', status: 'assigned',
    worker: { name: '李', phone: '1', eta: '2026-08-07 14:00:00' },
  });
  assert.strictEqual(assigned.ok, true);
  console.log('[PASS] testCallbackValidate');
}

function testCityIds() {
  assert.deepStrictEqual(vendorApi.parseCityIds('1,2, 3'), [1, 2, 3]);
  assert.deepStrictEqual(vendorApi.parseCityIds(''), []);
  const bad = vendorApi.validateProductCitySync(null, [1]);
  assert.strictEqual(bad.err, '缺少 city_id');
  const miss = vendorApi.validateProductCitySync(9, [1, 2]);
  assert.strictEqual(miss.err, 'city_id 不属于该商家');
  const ok = vendorApi.validateProductCitySync('1', [1, 2]);
  assert.strictEqual(ok.ok, true);
  console.log('[PASS] testCityIds');
}

function testUnknownRoute() {
  const secret = 'k1';
  const vendors = { '41': { key: secret } };
  const signed = hmac.generateSignature(secret, { vendor_id: 41 });
  return vendorApi.handleRequest('/api/juzhu/jiazheng/vendor/nope', signed, {}, vendors).then((out) => {
    assert.strictEqual(out.status, 404);
    assert.strictEqual(out.data.code, 404);
    console.log('[PASS] testUnknownRoute');
  });
}

async function run() {
  testFlatten();
  testKnownSign();
  testVerify();
  testVerifyVendorAuth();
  testCallbackValidate();
  testCityIds();
  await testUnknownRoute();
  console.log('all passed');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
