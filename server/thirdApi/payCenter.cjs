#!/usr/bin/env node
/**
 * server/thirdApi/payCenter.cjs
 * ---------------------------------------------------------------------------
 * 支付中台（落兵台 paySDK）接口封装，供其他 .cjs 调用。
 * 鉴权复用 server/utils/gateway-client.cjs（OAuth2 client_credentials + HMAC-SHA256）。
 *
 * 覆盖接口（落兵台 project 15453）：
 *   1. C2B 支付下单      POST /pay/order/v2/createOrder      (api 1000086)
 *   2. 关闭订单          POST /pay/order/closeOrder          (api 9276)
 *   3. 支付订单查询      GET  /pay/order/v2/query            (api 1493269)
 *   4. 原路退款          POST /pay/order/refundOrder         (api 9297)
 *   5. 退款订单查询      GET  /pay/order/queryRefundOrder    (api 9264)
 *
 * 环境：new PayCenter({ env }) 或 createPayCenter(env) 直接指定 test | prod，
 *   据此选择网关地址与客户端凭证；凭证可被 OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET 覆盖。
 *
 * 约定：
 *   - 路径前缀 PAY_PREFIX 默认 '/pay'（与 /pay/order/v2/query 一致）；若网关改用
 *     servicePrefix 挂载，改 PAY_PREFIX 或构造时传 payPrefix 即可。
 *   - 各方法返回支付中台原始 JSON：{ errno, error, data }；HTTP 非 2xx 时抛错，
 *     业务级错误以 errno !== 0 体现在返回值中，由调用方自行判断。
 *
 * 用法（环境由 JUZHU_ENV / NODE_ENV 读取，默认 test；无需手动 createPayCenter）：
 *   const { payCenter } = require('./thirdApi/payCenter.cjs');
 *   const r = await payCenter.queryOrder({ appOrderId: 'B20260101001' });
 *   // 切环境：JUZHU_ENV=prod node xxx.js
 * ---------------------------------------------------------------------------
 */
'use strict';

const path = require('path');
const { GatewayClient } = require(path.join(__dirname, '..', 'utils', 'gateway-client.cjs'));

// 路径前缀：与落兵台 pay 服务挂载路径一致（用户指定 /pay/order/v2/query）。
const PAY_PREFIX = process.env.PAY_CENTER_PREFIX || '/pay';

// 各环境网关客户端配置（与 gateway-client.cjs / pay_mock.cjs 默认一致）。
const ENV_CONFIG = {
  test: {
    gatewayUrl: 'https://aroute-test.ke.com',
    clientConfig: {
      clientId: process.env.OAUTH_CLIENT_ID || 'gz_lvju_testDTYCRqK1XxcusagEYg',
      clientSecret:
        process.env.OAUTH_CLIENT_SECRET ||
        'H75GEA1nWgwgls8N4O_RAiqtp6lZG8Ci5XkN3nSGEtJP2NETEgGWYwhsRCOOsuYx',
      clientType: 'Web_Server_ThirdParty',
    },
  },
  prod: {
    gatewayUrl: 'http://i.aroute.ke.com',
    clientConfig: {
      clientId: process.env.OAUTH_CLIENT_ID || 'gz_lvjuBBu793Lfpvs6v20dPdoij1J',
      clientSecret:
        process.env.OAUTH_CLIENT_SECRET ||
        'KKw4uCY9hXLpMtosS3iKmmu9QZIq9lesBjCizGq_CAtC8EYGUx5erVvOlzntRv84',
      clientType: 'Web_Server_KeIDC',
    },
  },
};

function envOf() {
  return (process.env.JUZHU_ENV || process.env.NODE_ENV || 'development').toLowerCase();
}

// 剔除 undefined / null（保留空串、0、false，避免误删“传空即可”的字段）。
function clean(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

function assertOneOf(label, obj, keys) {
  const got = keys.filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '');
  if (!got.length) {
    throw new Error(`[payCenter] ${label} 至少需要其一：${keys.join(' / ')}`);
  }
}

class PayCenter {
  /**
   * @param {object} [options]
   * @param {string} [options.env='test'|'prod'] 环境（缺省按 JUZHU_ENV/NODE_ENV，否则 test）
   * @param {string} [options.payPrefix]         路径前缀，默认 PAY_PREFIX
   * @param {string} [options.gatewayUrl]        显式网关地址（与 clientConfig 同时传时优先）
   * @param {object} [options.clientConfig]      { clientId, clientSecret, clientType }
   * @param {GatewayClient} [options.client]     复用外部 GatewayClient 实例
   */
  constructor(options = {}) {
    this.payPrefix = options.payPrefix || PAY_PREFIX;
    if (options.client) {
      this.client = options.client;
    } else {
      const cfg =
        options.gatewayUrl && options.clientConfig
          ? { gatewayUrl: options.gatewayUrl, clientConfig: options.clientConfig }
          : ENV_CONFIG[options.env || envOf()] || ENV_CONFIG.test;
      this.client = new GatewayClient({
        gatewayUrl: cfg.gatewayUrl,
        clientConfig: cfg.clientConfig,
      });
    }
  }

  _path(p) {
    return (this.payPrefix || '') + p;
  }

  /**
   * 1. C2B 支付下单（幂等；返回收银台 URL / token / 订单号）
   * @param {object} body 落兵台 createOrder 完整请求体，必填：
   *   amount, appCode, appOrderId, appOrderName, projectCode, shareBizCode,
   *   payChannel{cashierType, shareBizCode, tradeInfo{tradeName,tradeDesc}},
   *   callBackInfo{callbackUrl}, recAndShareInfo{shareOrderMode}, payOrderInfo{note},
   *   contractInfo{contractNo, contractAmount}, appClientInfo{appType},
   *   userInfo{userType, ucid}
   * @returns {Promise<{errno:number,error:string,data:object}>}
   */
  async createC2BOrder(body) {
    if (!body || !body.appCode || !body.appOrderId || body.amount == null) {
      throw new Error('[payCenter] createC2BOrder 至少需要 appCode / appOrderId / amount');
    }
    return this.client.json(this._path('/order/v2/createOrder'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: clean(body),
    });
  }

  /**
   * 2. 关闭订单（过期/用户取消场景；终态 40）
   * @param {object} params 必填：appCode, projectCode，且 orderId / businessOrderNo / cashierOrderNo 至少其一
   *   可选：ucid, userType
   * @returns {Promise<{errno:number,error:string,data:object}>}
   */
  async closeOrder(params = {}) {
    assertOneOf('closeOrder', params, ['orderId', 'businessOrderNo', 'cashierOrderNo']);
    if (!params.appCode || !params.projectCode) {
      throw new Error('[payCenter] closeOrder 必填 appCode / projectCode');
    }
    return this.client.json(this._path('/order/closeOrder'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: clean(params),
    });
  }

  /**
   * 3. 支付订单查询
   * @param {object} params 必填：appOrderId / orderId 至少其一；可选 appCode, projectCode
   * @returns {Promise<{errno:number,error:string,data:object}>}
   */
  async queryOrder(params = {}) {
    assertOneOf('queryOrder', params, ['appOrderId', 'orderId']);
    return this.client.json(this._path('/order/v2/query'), {
      method: 'GET',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      query: clean(params),
    });
  }

  /**
   * 4. 原路退款（异步；默认 refundType=01 原路）
   * @param {object} body 必填：appCode, projectCode, appOrderId, refundAmount, callbackUrl,
   *   ucid, userType, shareOrderInfos[{merchantNo, shareBizCode, amount}]，
   *   且 orderId / businessOrderNo / cashierOrderNo 至少其一（定位原单）
   * @returns {Promise<{errno:number,error:string,data:object}>}
   */
  async refundOrder(body = {}) {
    assertOneOf('refundOrder', body, ['orderId', 'businessOrderNo', 'cashierOrderNo']);
    const need = ['appCode', 'projectCode', 'appOrderId', 'refundAmount', 'callbackUrl', 'ucid', 'userType', 'shareOrderInfos'];
    const miss = need.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
    if (miss.length) throw new Error('[payCenter] refundOrder 缺少必填：' + miss.join(', '));
    const payload = Object.assign({ refundType: '01' }, body);
    return this.client.json(this._path('/order/refundOrder'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: clean(payload),
    });
  }

  /**
   * 5. 退款订单查询
   * @param {object} params 必填：appCode，且 orderId / businessOrderNo / cashierOrderNo 至少其一
   * @returns {Promise<{errno:number,error:string,data:object}>}
   */
  async queryRefundOrder(params = {}) {
    assertOneOf('queryRefundOrder', params, ['orderId', 'businessOrderNo', 'cashierOrderNo']);
    if (!params.appCode) throw new Error('[payCenter] queryRefundOrder 必填 appCode');
    return this.client.json(this._path('/order/queryRefundOrder'), {
      method: 'GET',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      query: clean(params),
    });
  }
}

// 按环境缓存单例：避免多个调用方各自 new GatewayClient 重复申请 token。
// 测试网关（aroute-test.ke.com）限制仅一个 accessToken，多实例会相互挤占（见 gateway-client.cjs 注释），
// 故同一环境进程内共享一个实例 / 一个 token 缓存。
const _instances = {};
/**
 * 便捷工厂：按环境构造 PayCenter（同环境返回缓存单例）。
 * @param {string} [env='test'|'prod'] 直接指定环境；缺省读 JUZHU_ENV/NODE_ENV，否则 test
 */
function createPayCenter(env) {
  const e = String(env || envOf()).toLowerCase();
  const key = ENV_CONFIG[e] ? e : 'test'; // 未知环境（如 development）回退 test，归并到同一实例
  if (!_instances[key]) _instances[key] = new PayCenter({ env: key });
  return _instances[key];
}

// 默认实例（按当前 JUZHU_ENV 自动选环境，复用缓存单例），便于无 env 上下文时直接 require 使用。
const defaultPayCenter = createPayCenter(envOf());

module.exports = {
  PayCenter,
  createPayCenter,
  ENV_CONFIG,
  PAY_PREFIX,
  payCenter: defaultPayCenter,
};
