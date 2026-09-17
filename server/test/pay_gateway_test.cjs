#!/usr/bin/env node
/**
 * server/test/pay_gateway_test.cjs
 * ---------------------------------------------------------------------------
 * 支付中台「支付订单查询」接口联调脚本（落兵台 id 1493269），改用 thirdApi/payCenter.cjs。
 *
 * 环境：命令行第 1 参数优先；否则取环境变量 JUZHU_ENV / NODE_ENV（默认 test）。
 *   凭证可被 OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET 覆盖（生产建议仅用环境变量）。
 *
 * 用法：
 *   node server/test/pay_gateway_test.cjs [env] [appCode] [appOrderId]
 *   例如：node server/test/pay_gateway_test.cjs test bkjingjixueyuan 260423160401000203
 *         JUZHU_ENV=prod node server/test/pay_gateway_test.cjs '' bkxxx 2604...
 *   或作为模块：const { test } = require('./server/test/pay_gateway_test.cjs'); await test('prod', { appOrderId:'xxx' });
 * ---------------------------------------------------------------------------
 */
'use strict';

const path = require('path');
const { payCenter, createPayCenter } = require(path.join(__dirname, '..', 'thirdApi', 'payCenter.cjs'));

/**
 * 测试入口：调用支付订单查询接口（底层走 payCenter.queryOrder）。
 * @param {string} [env]    环境 'test' | 'prod'；缺省则读 JUZHU_ENV/NODE_ENV（默认 test）
 * @param {object} [params] 查询参数（至少 appOrderId / orderId 之一）
 *   - appOrderId   业务订单标识
 *   - orderId      支付中台订单流水号（Long）
 *   - appCode      业务方标识（中台申请）
 *   - projectCode  接入方资金项目编码
 * @returns {Promise<object>} 接口返回的 JSON（含 errno/error/data）
 */
async function test(env, params = {}) {
  const pay = env ? createPayCenter(env) : payCenter;
  const envName = env || process.env.JUZHU_ENV || process.env.NODE_ENV || 'test';
  console.log(`[pay_gateway_test] env=${envName} → GET /pay/order/v2/query`, params);
  const json = await pay.queryOrder(params);
  console.log(JSON.stringify(json, null, 2));
  return json;
}

// 命令行直接运行：node server/test/pay_gateway_test.cjs [env] [appCode] [appOrderId]
if (require.main === module) {
  (async () => {
    const [env, appCode, appOrderId] = process.argv.slice(2);
    try {
      await test(env || undefined, { appCode, appOrderId });
    } catch (e) {
      console.error('[pay_gateway_test] 失败:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = { test };
