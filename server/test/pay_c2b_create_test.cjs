#!/usr/bin/env node
/**
 * server/test/pay_c2b_create_test.cjs
 * ---------------------------------------------------------------------------
 * 支付中台「C2B 支付下单」接口联调脚本（落兵台 id 1000086），底层走 thirdApi/payCenter.cjs 的 createC2BOrder。
 *
 * 环境：命令行第 1 参数优先；否则取环境变量 JUZHU_ENV / NODE_ENV（默认 test）。
 *   凭证可被 OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET 覆盖（生产建议仅用环境变量）。
 *
 * 下单为同步幂等接口，成功返回收银台 URL / token / orderId（状态 10 已创建，终态 30 成功）。
 *
 * 用法：
 *   node server/test/pay_c2b_create_test.cjs [env] [appCode] [appOrderId] [amount]
 *   例如：node server/test/pay_c2b_create_test.cjs test lvju lvju_2026092110000010001 100.1
 *   或作为模块（传完整 body）：
 *     const { test } = require('./server/test/pay_c2b_create_test.cjs');
 *     await test('test', { /* 完整 createOrder body *\/ });
 *
 * 说明：CLI 模式会组装一个贴近真实契约的冒烟 body（含分账 / 商品 / 合同等字段，给默认值），
 *   真实联调请把 PAY_APP_CODE / PAY_SHARE_BIZ_CODE / PAY_MERCHANT_NO / PAY_CALLBACK_URL /
 *   PAY_WECHAT_OPENID 等用环境变量覆盖，或改为模块方式传完整 body。
 * ---------------------------------------------------------------------------
 */
'use strict';

const path = require('path');
const { payCenter, createPayCenter } = require(path.join(__dirname, '..', 'thirdApi', 'payCenter.cjs'));

// 组装贴近真实联调的冒烟 body（参考支付中台 C2B 下单契约；必要字段给默认值，
// 真实值请用环境变量 / 模块方式传完整 body 覆盖）。
function buildSampleBody(overrides = {}) {
  const now = Date.now();
  const appOrderId = overrides.appOrderId || `lvju_${now}`;
  const amount = overrides.amount != null ? Number(overrides.amount) : 100.1;
  const shareBizCode = overrides.shareBizCode || process.env.PAY_SHARE_BIZ_CODE || '02037200000000';
  const merchantNo = overrides.merchantNo || process.env.PAY_MERCHANT_NO || '20260917113504119043';
  const callbackUrl = overrides.callbackUrl || process.env.PAY_CALLBACK_URL || 'https://www.baidu.com/';
  const payChannel = {
    cashierType: overrides.cashierType || '1',
    shareBizCode,
    tradeInfo: {
      tradeName: overrides.tradeName || '交易名称',
      tradeDesc: overrides.tradeDesc || '交易描述',
    },
  };
  // 仅小程序收银台（或显式提供）时带 wechatOpenId
  const wechatOpenId = overrides.wechatOpenId || process.env.PAY_WECHAT_OPENID;
  if (wechatOpenId) payChannel.wechatOpenId = wechatOpenId;
  return {
    amount,
    appCode: overrides.appCode || process.env.PAY_APP_CODE || 'lvju',
    projectCode: overrides.appCode || process.env.PAY_APP_CODE || 'lvju',
    appOrderId,
    appOrderName: overrides.appOrderName || `业务订单名称${String(appOrderId).replace('lvju_', '')}`,
    payChannel,
    callBackInfo: { callbackUrl },
    recAndShareInfo: {
      shareOrderMode: overrides.shareOrderMode != null ? Number(overrides.shareOrderMode) : 0,
      merchantNo,
      shareOrderInfos: [{ merchantNo, amount, shareBizCode }],
    },
    payOrderInfo: {
      note: '付款单备注',
      expireTime: String( 30 * 60 ), // 30 分钟后过期
    },
    contractInfo: {
      contractNo: overrides.contractNo || `业务合同号${appOrderId}`,
      contractAmount: amount,
      startTime: overrides.startTime || '2026-09-21 00:00:00',
      endTime: overrides.endTime || '2026-12-21 00:00:00',
    },
    appClientInfo: {
      appType: overrides.appType != null ? Number(overrides.appType) : 1,
      appClientIp: overrides.appClientIp || '10.0.0.1',
    },
    userInfo: {
      userType: overrides.userType != null ? Number(overrides.userType) : 2,
      ucid: overrides.ucid || '2000000023474001',
    },
    orderVersion: 'V2',
  };
}
// 2000000144027200
/**
 * 测试入口：调用 C2B 支付下单接口（底层走 payCenter.createC2BOrder）。
 * @param {string} [env]  环境 'test' | 'prod'；缺省读 JUZHU_ENV/NODE_ENV（默认 test）
 * @param {object} [body] 完整 createOrder body；或仅传部分字段（走 buildSampleBody 补默认值）
 * @returns {Promise<object>} 接口返回的 JSON（含 errno/error/data）
 */
async function test(env, body = {}) {
  const pay = env ? createPayCenter(env) : payCenter;
  const envName = env || process.env.JUZHU_ENV || process.env.NODE_ENV || 'test';
  // 传了 payChannel + callBackInfo + contractInfo 视为完整 body，否则按冒烟 body 组装
  const isFull = body && body.payChannel && body.callBackInfo && body.contractInfo;
  const finalBody = isFull ? body : buildSampleBody(body || {});
  console.log(`[pay_c2b_create_test] env=${envName} → POST /pay/order/v2/createOrder`);
  console.log(JSON.stringify(finalBody, null, 2));
  const json = await pay.createC2BOrder(finalBody);
  console.log(JSON.stringify(json, null, 2));
  return json;
}

// 命令行直接运行：node server/test/pay_c2b_create_test.cjs [env] [appCode] [appOrderId] [amount]
if (require.main === module) {
  (async () => {
    const [env, appCode, appOrderId, amount] = process.argv.slice(2);
    const overrides = {};
    if (appCode) overrides.appCode = appCode;
    if (appOrderId) overrides.appOrderId = appOrderId;
    if (amount != null && amount !== '') overrides.amount = amount;
    try {
      await test(env || undefined, overrides);
    } catch (e) {
      console.error('[pay_c2b_create_test] 失败:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = { test, buildSampleBody };


//{
//   "amount": 200.1,
//   "appCode": "lvju",
//   "projectCode": "lvju",
//   "appOrderId": "lvju202609210000003",
//   "appOrderName": "业务订单名称lvju202609210000003",
//   "payChannel": {
//     "cashierType": "1",
//     "shareBizCode": "02037200000000",
//     "tradeInfo": {
//       "tradeName": "交易名称",
//       "tradeDesc": "交易描述"
//     }
//   },
//   "callBackInfo": {
//     "callbackUrl": "https://www.baidu.com/"
//   },
//   "recAndShareInfo": {
//     "shareOrderMode": 0,
//     "merchantNo": "20260917113504119043",
//     "shareOrderInfos": [
//       {
//         "merchantNo": "20260917113504119043",
//         "amount": 200.1,
//         "shareBizCode": "02037200000000"
//       }
//     ]
//   },
//   "payOrderInfo": {
//     "note": "付款单备注",
//     "expireTime": "1800"
//   },
//   "contractInfo": {
//     "contractNo": "业务合同号lvju202609210000003",
//     "contractAmount": 200.1,
//     "startTime": "2026-09-21 00:00:00",
//     "endTime": "2026-12-21 00:00:00"
//   },
//   "appClientInfo": {
//     "appType": 1,
//     "appClientIp": "10.0.0.1"
//   },
//   "userInfo": {
//     "userType": 2,
//     "ucid": "2000000023474001"
//   },
//   "orderVersion": "V2"
// }
// {
//   "errno": 0,
//   "error": "操作成功",
//   "data": {
//     "cashierOrderNo": "113555722252538413413",
//     "orderId": 1789962274140730000,
//     "appOrderId": "lvju202609210000003",
//     "wxData": "",
//     "merchantId": "02037200000000",
//     "status": "10",
//     "accessToken": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsib2F1dGgyLXJlc291cmNlIl0sInVzZXJfaWQiOiIxNzYxMjE1IiwiYWRkaXRpb25hbF9pbmZvIjoicjVBdUFJemUxZ1A0cnlxNTNhbWZWQzh6UWZDRUJ2ckc4ZFYrU1JxMk4xU0ovenEyWmpzVllKVTJMblhDU3YvQTFORXZxQlNzcGdpS25BUTZ6N2sveFVnU2R3UzhPSGRXN0k2cEtMMmJHN29Hdk50NTI1a1A3aEp4Q2dzdTc5WnZYWTdOS1BDRHpBdEpkZ21xaEFEdEF5MGtZdWpoa3htY2EzajNPODZYbGV6dlpHUEdrc25ZS04wL0FPRG5qemhzNERHL2l5S0JRMTFWZFZ3NHluSEF3S3ZyNnBwSkROTzJPTjBucm5GbXNNaEVwK1ZLVHN2V0h2YWNXYytkSHJyUGRGcUthVmJoTXgvSGthTVBaK3VudytpQnFGd0ZjVG0wekJFa2N0Mm5hWXpCNUJOeUY5dXE0MFduTVJvcTRvb25rN2IwcmZmQUlOVXVuRjVCOHprQVJCemwwbHJwUnd2Mi82eStTUFlPT1NFPSIsInVzZXJfbmFtZSI6IjU2Nzg0IiwicGFydG5lcl9rZXkiOiJLRSIsInNjb3BlIjpbInNuc2FwaV91c2VyaW5mbyJdLCJleHAiOjE3ODk5ODk3NTEsImF1dGhvcml0aWVzIjpbIlJPTEVfVVNFUiJdLCJqdGkiOiI1NjlkZjcwNi05NjcxLTQ1MzktYTZjNy1jZDUzN2ViYjk3NGYiLCJjbGllbnRfaWQiOiJrZS1hcGx1cyJ9.LIF4ctM44cRIrF58v5LdVtH0K_Frtn3h-i3wNRCUWaNvp8t0LyKQebZ2mwvxYDAE3T4fiUqoDvf6w-x7EtMxXklivXMMdvRRi1QbvhFjFBRNqJvOF-ind562icJRNcL4kMJev28Efnif1vn0zEGR4kgRkSLbQ5XIQypJbdBg46JLF5RaqpkJ3pv8P8pqH8qLT-YClBW3XaYTzT-sppkdyWJpIOh_gs1TShpFRhz_O388OR1poXY5aYq57XhST5MyxdYM8fb-WvR-PComMw7h-r3PxEfh6v4o24ejSLEcscAG11bKSo8h82etk1BtTntgRMb_du-CxPjHNyoKIzxY2g",
//     "expiresIn": 20277,
//     "url": "",
//     "cashierUrl": "WalletSDK://bkjf?url=http%3A%2F%2Ftest1-bkcashier.ehomepay.com.cn%2F%3FrembId%3D113555722252538413413%26pageType%3D1%23%2Fhome&data=%7B%22isNewContainer%22%3Atrue%2C%22navSetting%22%3A%7B%22isWhiteContent%22%3Afalse%2C%22navBgColor%22%3A%22%23FFFFFF%22%2C%22navTitleColor%22%3A%22%23000000%22%7D%2C%22navType%22%3A%22WALLET%22%7D",
//     "coreNo": null,
//     "couponStatus": 0,
//     "identifyCode": null,
//     "authCode": null,
//     "cashierType": "1"
//   },
//   "cost": 473,
//   "traceId": "pay-web-10.238.193.137-230-1789962274797-3423"
// }