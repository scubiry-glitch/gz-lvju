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

test('refundOrder defaults profitSharingType to 2 when the caller omits it', async () => {
  const sent = [];
  const pay = new PayCenter({
    client: {
      json: async (_path, options) => {
        sent.push(options.body);
        return { errno: 0, data: { accepted: true } };
      },
    },
  });
  const base = {
    appCode: 'lvju', projectCode: 'proj', appOrderId: 'RF-1', refundAmount: '1.00',
    callbackUrl: 'https://example.test/notify', ucid: 'u1', userType: 1,
    shareOrderInfos: [{ merchantNo: 'm1', shareBizCode: 'b1', amount: '1.00' }],
    businessOrderNo: 'PAY-1',
  };

  await pay.refundOrder(base);
  await pay.refundOrder({ ...base, profitSharingType: null });
  await pay.refundOrder({ ...base, profitSharingType: '' });
  await pay.refundOrder({ ...base, profitSharingType: 0 });
  await pay.refundOrder({ ...base, profitSharingType: 1 });

  assert.deepEqual(sent.map((body) => body.profitSharingType), [2, 2, 2, 0, 1]);
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
