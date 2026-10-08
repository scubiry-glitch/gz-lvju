'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PayCenter,
  assertPaySuccess,
} = require('../thirdApi/payCenter.cjs');

test('assertPaySuccess preserves a successful raw response', () => {
  const result = { errno: '0', error: '操作成功', data: { status: '10' } };
  assert.equal(assertPaySuccess(result, '测试调用'), result);
});

test('payment methods reject HTTP 200 business errors', async () => {
  const result = {
    errno: -20,
    error: '非法的接入应用，请先申请应用接入标识',
    data: null,
    traceId: 'trace-test',
  };
  const pay = new PayCenter({ client: { json: async () => result } });

  await assert.rejects(
    pay.queryOrder({ appCode: 'lvju', appOrderId: 'BKG-TEST-1' }),
    (error) => {
      assert.equal(error.name, 'PayCenterBusinessError');
      assert.equal(error.code, 'PAY_CENTER_BUSINESS_ERROR');
      assert.equal(error.errno, -20);
      assert.equal(error.traceId, 'trace-test');
      assert.equal(error.payResult, result);
      return true;
    },
  );
});

test('payment methods reject malformed success responses without data', async () => {
  const pay = new PayCenter({
    client: { json: async () => ({ errno: 0, error: '操作成功', data: null }) },
  });

  await assert.rejects(
    pay.queryRefundOrder({ appCode: 'lvju', businessOrderNo: 'BKG-TEST-1' }),
    { code: 'PAY_CENTER_BUSINESS_ERROR' },
  );
});
