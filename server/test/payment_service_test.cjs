'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateAppOrderId,
  notificationKey,
} = require('../../payment_service.cjs');

test('payment service generates Shanghai XD order identifiers', () => {
  const id = generateAppOrderId('XD', new Date('2026-09-16T04:00:01.000Z'));
  assert.match(id, /^XD_20260916120001_\d{6}$/);
  assert.ok(id.length <= 28);
});

test('payment notification key is stable for a duplicate payload', () => {
  const payload = {
    appCode: 'lvju',
    projectCode: 'lvju',
    appOrderId: 'XD_20260916120001_123456',
    orderId: '9012345678901234567',
    orderStatus: '30',
    tradeTime: '2026-09-16 12:00:01',
  };
  assert.equal(notificationKey(payload), notificationKey(Object.assign({}, payload)));
  assert.notEqual(notificationKey(payload), notificationKey(Object.assign({}, payload, { orderStatus: '40' })));
});
