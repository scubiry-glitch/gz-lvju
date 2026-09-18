#!/usr/bin/env node
/**
 * server/thirdApi/payCenter.cjs
 * ---------------------------------------------------------------------------
 * 支付中台（落兵台 paySDK）接口封装，供其他 .cjs 调用。
 * 鉴权复用 server/utils/gateway-client.cjs（OAuth2 client_credentials + HMAC-SHA256）。
 *
 * 覆盖接口：
 * ── 支付类（落兵台 project 15453，前缀 PAY_PREFIX 默认 '/pay'）──
 *   1. C2B 支付下单      POST /pay/order/v2/createOrder      (api 1000086)
 *   2. 关闭订单          POST /pay/order/closeOrder          (api 9276)
 *   3. 支付订单查询      GET  /pay/order/v2/query            (api 1493269)
 *   4. 原路退款          POST /pay/order/refundOrder         (api 9297)
 *   5. 退款订单查询      GET  /pay/order/queryRefundOrder    (api 9264)
 *
 * ── 分账类（落兵台 project 15873，前缀 PROFIT_PREFIX 默认
 *       '/pay/open-pay-plat/pre/profits-share'，并非单纯 '/pay'）──
 *   6. 开通合同专户      POST /pay/open-pay-plat/pre/profits-share/share-profits/api/standard/account/openSpecialAccount      (api 1590841)
 *   7. ACN 分账申请      POST /pay/open-pay-plat/pre/profits-share/share-profits/api/standard/direct/split                    (api 1479542)
 *   8. 分账回退申请      POST /pay/open-pay-plat/pre/profits-share/share-profits/api/standard/direct/split/return            (api 1541838)
 *   9. 分账结果与回退查询 GET /pay/open-pay-plat/pre/profits-share/share-profits/api/standard/direct/split/query             (api 1479569)
 *
 * 环境：new PayCenter({ env }) 或 createPayCenter(env) 直接指定 test | prod，
 *   据此选择网关地址与客户端凭证；凭证可被 OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET 覆盖。
 *
 * 约定：
 *   - 支付类路径前缀 PAY_PREFIX 默认 '/pay'；分账类路径前缀 PROFIT_PREFIX 默认
 *     '/pay/open-pay-plat/pre/profits-share'（用户指定，区别于 '/pay'）。
 *     若网关改用 servicePrefix 挂载，改对应常量或构造时传 payPrefix / profitPrefix 即可。
 *   - 各方法返回落兵台原始 JSON；HTTP 非 2xx 时抛错，业务级错误体现在返回值
 *     （如 code 非 '200'）中，由调用方自行判断。
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

// 分账类路径前缀：落兵台 open-pay-plat 分账服务（project 15873），
// 用户明确要求以 /pay/open-pay-plat/pre/profits-share 开头，而非单纯的 /pay。
const PROFIT_PREFIX = process.env.PROFIT_SHARE_PREFIX || '/pay/open-pay-plat/pre/profits-share';

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
   * @param {string} [options.payPrefix]         支付类路径前缀，默认 PAY_PREFIX
   * @param {string} [options.profitPrefix]      分账类路径前缀，默认 PROFIT_PREFIX
   * @param {string} [options.gatewayUrl]        显式网关地址（与 clientConfig 同时传时优先）
   * @param {object} [options.clientConfig]      { clientId, clientSecret, clientType }
   * @param {GatewayClient} [options.client]     复用外部 GatewayClient 实例
   */
  constructor(options = {}) {
    this.payPrefix = options.payPrefix || PAY_PREFIX;
    this.profitPrefix = options.profitPrefix || PROFIT_PREFIX;
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

  // 分账类接口路径（前缀 PROFIT_PREFIX = /pay/open-pay-plat/pre/profits-share）
  _profitPath(p) {
    return (this.profitPrefix || '') + p;
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

  // ───────────────────────── 分账类（project 15873，前缀 PROFIT_PREFIX） ─────────────────────────

  /**
   * 6. 开通合同专户（落兵台 api 1590841）
   * 支持开通一个合同下多个分账参与方的合同专户；接口幂等，开户失败可重试。
   * 注意：code 非 '200' 视为失败；data[].accountOpenStatus === true 视为开户成功。
   * @param {object} body 必填：bizCode, contractNo, merchantNoList[]
   * @returns {Promise<{code:string,info:string,data:Array<{merchantNo:string,accountOpenStatus:boolean}>>}>}
   */
  async openSpecialAccount(body = {}) {
    const need = ['bizCode', 'contractNo', 'merchantNoList'];
    const miss = need.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
    if (miss.length) throw new Error('[payCenter] openSpecialAccount 缺少必填：' + miss.join(', '));
    if (!Array.isArray(body.merchantNoList) || !body.merchantNoList.length) {
      throw new Error('[payCenter] openSpecialAccount 的 merchantNoList 不能为空');
    }
    return this.client.json(
      this._profitPath('/share-profits/api/standard/account/openSpecialAccount'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: clean(body),
      },
    );
  }

  /**
   * 7. ACN 分账申请（落兵台 api 1479542）
   * @param {object} body 必填：bizOrderNo, bizCode, orderName, amount, contractInfo{contractNo},
   *   payInfos[{merchantNo,amount}], details[{bizDetailNo,splitLevel,payerMerchantNo,payAmount,payeeMerchantNo,leafFlag,summary}]
   * @returns {Promise<{code:string,info:string,data:object}>}
   */
  async splitApply(body = {}) {
    const need = ['bizOrderNo', 'bizCode', 'orderName', 'amount', 'contractInfo', 'payInfos', 'details'];
    const miss = need.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
    if (miss.length) throw new Error('[payCenter] splitApply 缺少必填：' + miss.join(', '));
    if (!body.contractInfo || !body.contractInfo.contractNo) {
      throw new Error('[payCenter] splitApply 的 contractInfo.contractNo 必填');
    }
    return this.client.json(this._profitPath('/share-profits/api/standard/direct/split'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: clean(body),
    });
  }

  /**
   * 8. 分账回退申请（落兵台 api 1541838）
   * @param {object} body 必填：bizOrderNo, bizCode, orderName, amount, contractInfo{contractNo},
   *   payInfos[{payNo,merchantNo,amount}], details[{bizDetailNo,splitLevel,payerMerchantNo,payAmount,
   *   payeeMerchantNo,leafFlag,summary,sources[]}]
   * @returns {Promise<{code:string,info:string,data:object}>}
   */
  async splitReturn(body = {}) {
    const need = ['bizOrderNo', 'bizCode', 'orderName', 'amount', 'contractInfo', 'payInfos', 'details'];
    const miss = need.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
    if (miss.length) throw new Error('[payCenter] splitReturn 缺少必填：' + miss.join(', '));
    if (!body.contractInfo || !body.contractInfo.contractNo) {
      throw new Error('[payCenter] splitReturn 的 contractInfo.contractNo 必填');
    }
    return this.client.json(this._profitPath('/share-profits/api/standard/direct/split/return'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: clean(body),
    });
  }

  /**
   * 9. 分账结果与分账回退结果查询（落兵台 api 1479569）
   * @param {object} params 必填：bizCode, orderType；bizOrderNo / orderNo 至少其一（与 bizCode 幂等）
   *   orderType 取值：DIRECT_SPLIT-分账；SPLIT_RETURN-分账追回
   * @returns {Promise<{code:string,info:string,data:object}>}
   */
  async querySplitResult(params = {}) {
    if (!params.bizCode || !params.orderType) {
      throw new Error('[payCenter] querySplitResult 必填 bizCode / orderType');
    }
    assertOneOf('querySplitResult', params, ['bizOrderNo', 'orderNo']);
    return this.client.json(this._profitPath('/share-profits/api/standard/direct/split/query'), {
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
  PROFIT_PREFIX,
  payCenter: defaultPayCenter,
};
