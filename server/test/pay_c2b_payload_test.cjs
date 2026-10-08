'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSampleBody,
  generateAppOrderId,
} = require('./pay_c2b_create_test.cjs');

test('generateAppOrderId uses the agreed XD timestamp format', () => {
  const appOrderId = generateAppOrderId(new Date('2026-09-16T04:00:01.000Z'));
  assert.match(appOrderId, /^XD_20260916120001_\d{6}$/);
  assert.ok(appOrderId.length <= 28);
});

test('C2B payload keeps appCode and projectCode independent', () => {
  const body = buildSampleBody({
    appCode: 'test-app',
    projectCode: 'test-project',
    contractNo: 'BKG-MINSU-00001',
  });

  assert.equal(body.appCode, 'test-app');
  assert.equal(body.projectCode, 'test-project');
  assert.equal(body.contractInfo.contractNo, 'BKG-MINSU-00001');
  assert.match(body.appOrderId, /^XD_\d{14}_\d{6}$/);
});
