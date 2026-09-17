'use strict';

/**
 * gateway-client.cjs
 * ---------------------------------------------------------------------------
 * 网关 OAuth2 客户端（纯 Node CJS 实现，供 app.js 等 Node 接口服务调用网关接口）。
 * 设计参考根目录 oauth/（TS 版 gateway 客户端），此处改写为无 next/headers、无 TS
 * 别名依赖的 CommonJS 实现，可直接 require。
 *
 * 鉴权流程：client_credentials + HMAC-SHA256 签名换取 access_token（Bearer），
 * 后续请求在 Authorization 头携带；token 失效（401/403 且 X-Error-Code 为
 * 900001/900002）时自动刷新并重试一次。
 *
 * 环境配置：根据 JUZHU_ENV / NODE_ENV 选择「生产」或「测试」网关客户端
 * （client_id / client_secret / client_type）。密钥可被同名环境变量覆盖、
 * 生产建议仅用环境变量注入（不入库）。网关地址走 OAUTH_GATEWAY_URL。
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');

const ENV = (process.env.JUZHU_ENV || process.env.NODE_ENV || 'development').toLowerCase();
const IS_PROD = ENV === 'prod' || ENV === 'production';

/**
 * 各环境网关客户端配置。
 * 生产：gz_lvju / Web_Server_KeIDC
 * 测试：gz_lvju_test / Web_Server_ThirdParty
 * 密钥可被环境变量 OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET 覆盖（生产推荐仅用环境变量）。
 */
const CLIENT_CONFIG = {
  production: {
    clientId: process.env.OAUTH_CLIENT_ID || 'gz_lvjuBBu793Lfpvs6v20dPdoij1J',
    clientSecret:
      process.env.OAUTH_CLIENT_SECRET ||
      'KKw4uCY9hXLpMtosS3iKmmu9QZIq9lesBjCizGq_CAtC8EYGUx5erVvOlzntRv84',
    clientType: 'Web_Server_KeIDC',
  },
  test: {
    clientId: process.env.OAUTH_CLIENT_ID || 'gz_lvju_testDTYCRqK1XxcusagEYg',
    clientSecret:
      process.env.OAUTH_CLIENT_SECRET ||
      'H75GEA1nWgwgls8N4O_RAiqtp6lZG8Ci5XkN3nSGEtJP2NETEgGWYwhsRCOOsuYx',
    clientType: 'Web_Server_ThirdParty',
  },
};

function resolveClientConfig() {
  return IS_PROD ? CLIENT_CONFIG.production : CLIENT_CONFIG.test;
}

function resolveGatewayUrl() {
  if (process.env.OAUTH_GATEWAY_URL) return process.env.OAUTH_GATEWAY_URL;
  // 未显式设置时按环境取默认网关
  // 生产内网：http://i.aroute.ke.com；
  // 测试外网（限制了只能一个accessToken 多实例部署需要注意：https://aroute-test.ke.com
  return IS_PROD ? 'http://i.aroute.ke.com' : 'https://aroute-test.ke.com';
}

// ---- 签名（与 oauth/signature.ts 算法完全一致）----
function base64Url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function buildOAuthSignature(path, method, params, clientSecret) {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  const message = `${path}${method.toUpperCase()}${sorted}`;
  const digest = crypto.createHmac('sha256', clientSecret).update(message).digest();
  return base64Url(digest);
}

function createNonce() {
  return crypto.randomUUID();
}

async function fetchServerTimestamp(gatewayUrl, epochPath) {
  try {
    const res = await fetch(`${gatewayUrl}${epochPath}`, { cache: 'no-store' });
    if (!res.ok) return Date.now();
    const text = (await res.text()).trim();
    const ts = Number(text);
    return Number.isFinite(ts) ? ts : Date.now();
  } catch {
    return Date.now();
  }
}

function isTokenValid(token) {
  return !!token && Date.now() < token.expiresAt;
}

class GatewayClient {
  /**
   * @param {object} [options]
   * @param {string} [options.gatewayUrl] 覆盖网关地址（否则按环境解析）
   * @param {object} [options.clientConfig] 覆盖客户端配置 {clientId,clientSecret,clientType}
   * @param {string} [options.servicePrefix] 接口路径前缀（默认读 OAUTH_SERVICE_PREFIX 或空）
   * @param {string} [options.tokenPath]    token 端点，默认 /oauth2/token
   * @param {string} [options.epochPath]    时间戳端点，默认 /v1/time/epoch
   */
  constructor(options = {}) {
    this.gatewayUrl = options.gatewayUrl || resolveGatewayUrl();
    const cfg = options.clientConfig || resolveClientConfig();
    this.clientId = cfg.clientId;
    this.clientSecret = cfg.clientSecret;
    this.clientType = cfg.clientType;
    this.servicePrefix =
      options.servicePrefix != null
        ? options.servicePrefix
        : process.env.OAUTH_SERVICE_PREFIX || '';
    this.tokenPath = options.tokenPath || '/oauth2/token';
    this.epochPath = options.epochPath || '/v1/time/epoch';
    this._token = null;
  }

  /** 获取 access_token（带内存缓存，过期前 20% 时间窗口刷新） */
  async getToken(forceRefresh = false) {
    if (!forceRefresh && isTokenValid(this._token)) {
      return this._token.accessToken;
    }
    const timestamp = String(await fetchServerTimestamp(this.gatewayUrl, this.epochPath));
    const nonce = createNonce();
    const params = {
      client_id: this.clientId,
      grant_type: 'client_credentials',
      nonce,
      timestamp,
    };
    const signature = buildOAuthSignature(this.tokenPath, 'POST', params, this.clientSecret);
    const body = new URLSearchParams({ ...params, signature });

    const res = await fetch(`${this.gatewayUrl}${this.tokenPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(
        `[gateway-client] 获取 access_token 失败: ${data.message || res.status}`,
      );
    }
    this._token = {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000 * 0.8,
    };
    return this._token.accessToken;
  }

  /** 拼接 service 前缀与接口路径 */
  buildPath(apiPath) {
    const prefix = this.servicePrefix.replace(/\/$/, '');
    const path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    return `${prefix}${path}`;
  }

  _buildUrl(path, query) {
    const url = new URL(`${this.gatewayUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /**
   * 发起网关请求，自动附带 Bearer token；
   * 401/403 且 X-Error-Code 为 900001/900002 时刷新 token 重试一次。
   * @param {string} path 网关路径（已含 servicePrefix 或传全路径）
   * @param {object} [options]
   * @param {string} [options.method='GET']
   * @param {object|string|Buffer|null} [options.body] object 自动 JSON 序列化
   * @param {object} [options.headers]
   * @param {object} [options.query]
   * @param {string} [options.loginToken] 代用户调用时附带的 X-Login-Token
   * @returns {Promise<Response>}
   */
  async fetch(path, options = {}) {
    const { method = 'GET', body, headers, query, loginToken } = options;

    const accessToken = await this.getToken();
    const reqHeaders = new Headers(headers);
    reqHeaders.set('Authorization', `Bearer ${accessToken}`);
    if (loginToken) reqHeaders.set('X-Login-Token', loginToken);

    let payload = body;
    if (body != null && typeof body === 'object' && !(body instanceof Buffer)) {
      payload = JSON.stringify(body);
      if (!reqHeaders.has('Content-Type')) {
        reqHeaders.set('Content-Type', 'application/json');
      }
    }

    const doFetch = () =>
      fetch(this._buildUrl(path, query), {
        method,
        headers: reqHeaders,
        body: payload,
        cache: 'no-store',
      });

    let res = await doFetch();
    if (res.status === 401 || res.status === 403) {
      const errCode = res.headers.get('X-Error-Code');
      if (errCode === '900001' || errCode === '900002') {
        const refreshed = await this.getToken(true);
        reqHeaders.set('Authorization', `Bearer ${refreshed}`);
        res = await doFetch();
      }
    }
    return res;
  }

  /** 同 fetch，但解析 JSON；非 2xx 抛错 */
  async json(path, options = {}) {
    const res = await this.fetch(path, options);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`[gateway-client] 网关请求失败 (${res.status}): ${text}`);
    }
    return res.json();
  }
}

function createGatewayClient(options) {
  return new GatewayClient(options);
}

// 默认单例（按当前环境自动选择客户端）
const defaultClient = new GatewayClient();

// 兼容 oauth/client.ts 的扁平 API（基于 defaultClient，便于迁移）
async function gatewayFetch(path, options) {
  return defaultClient.fetch(path, options);
}
async function gatewayJson(path, options) {
  return defaultClient.json(path, options);
}

module.exports = {
  GatewayClient,
  createGatewayClient,
  defaultClient,
  gatewayFetch,
  gatewayJson,
  // 工具函数（便于单独复用 / 单测）
  buildOAuthSignature,
  createNonce,
};
