/**
 * idp_oidc.cjs —— 最小 OIDC Relying Party（阶段3 联邦登录，设计文档 §4.6）
 *
 * 纯 node:crypto 实现，零新依赖：discovery/JWKS 拉取与缓存、authorize URL
 * （state + nonce + PKCE S256）、code 换 token、id_token RS256 验签
 * （iss/aud/exp/iat/nonce 校验）。
 *
 * 安全约定：
 *  - client_secret 只在服务端内存/DB 中流转，任何响应不下发；
 *  - state/nonce/code_verifier 由调用方（app.js /api/auth/idp/*）生成并单次消费；
 *  - 验签失败/claim 不符一律 throw，由路由层转 401，绝不降级放行。
 */
'use strict';

const crypto = require('crypto');

const DISCOVERY_TTL_MS = 10 * 60 * 1000;   // issuer 元数据缓存 10 分钟
const JWKS_TTL_MS = 60 * 60 * 1000;        // JWKS 缓存 1 小时
const discoveryCache = new Map();          // issuer → {data, exp}
const jwksCache = new Map();               // jwks_uri → {keys, exp}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function fetchJson(url, opts) {
  const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(8000) }, opts || {}));
  if (!r.ok) throw new Error('OIDC 请求失败 ' + url + ' → HTTP ' + r.status);
  return r.json();
}

/** issuer 元数据（.well-known/openid-configuration），带 TTL 缓存 */
async function discovery(issuer) {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() < hit.exp) return hit.data;
  const url = issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration';
  const data = await fetchJson(url);
  if (!data.authorization_endpoint || !data.token_endpoint || !data.jwks_uri) {
    throw new Error('OIDC discovery 缺少必要端点（authorization/token/jwks）');
  }
  discoveryCache.set(issuer, { data, exp: Date.now() + DISCOVERY_TTL_MS });
  return data;
}

async function jwks(jwksUri) {
  const hit = jwksCache.get(jwksUri);
  if (hit && Date.now() < hit.exp) return hit.keys;
  const data = await fetchJson(jwksUri);
  if (!Array.isArray(data.keys)) throw new Error('JWKS 格式错误');
  jwksCache.set(jwksUri, { keys: data.keys, exp: Date.now() + JWKS_TTL_MS });
  return data.keys;
}

// ── PKCE ──
function makePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * 构造 authorize 跳转 URL
 * @returns {{url, state, nonce, verifier}}
 */
async function buildAuthUrl(config, redirectUri) {
  const disc = await discovery(config.issuer);
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const pkce = makePkce();
  const u = new URL(disc.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', config.client_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', config.scope || 'openid profile');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', pkce.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return { url: u.toString(), state, nonce, verifier: pkce.verifier };
}

/** RS256 验签（JWK → KeyObject）。政务/银行 IdP 主流签名；ES256 暂不支持 */
function verifyJwtSignature(jwt, keys) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new Error('id_token 格式错误');
  let header;
  try { header = JSON.parse(b64urlDecode(parts[0]).toString('utf8')); } catch (_) { throw new Error('id_token header 解析失败'); }
  if (header.alg !== 'RS256') throw new Error('仅支持 RS256 id_token（收到 ' + header.alg + '）');
  const jwk = keys.find((k) => k.kid === header.kid) || (keys.length === 1 ? keys[0] : null);
  if (!jwk) throw new Error('JWKS 中无匹配 kid: ' + (header.kid || '(空)'));
  const keyObj = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), keyObj, Buffer.from(parts[2], 'base64'));
  if (!ok) throw new Error('id_token 签名验证失败');
  let claims;
  try { claims = JSON.parse(b64urlDecode(parts[1]).toString('utf8')); } catch (_) { throw new Error('id_token payload 解析失败'); }
  return { header, claims };
}

/**
 * code 换 token 并验 id_token → claims
 * @param opts {{code, state, nonce, verifier, redirectUri, nowSec?}}
 */
async function exchangeAndVerify(config, opts) {
  const disc = await discovery(config.issuer);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(opts.code || ''),
    redirect_uri: opts.redirectUri,
    client_id: config.client_id,
    code_verifier: opts.verifier || '',
  });
  if (config.client_secret) body.set('client_secret', config.client_secret);
  const r = await fetch(disc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(8000),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.id_token) throw new Error('token 端点失败 HTTP ' + r.status + (tok.error ? ' ' + tok.error : ''));
  return verifyIdToken(config, tok.id_token, opts);
}

/** 验 id_token 签名与 claims；任何不符都 throw */
async function verifyIdToken(config, idToken, opts) {
  const keys = await jwks((await discovery(config.issuer)).jwks_uri);
  const { claims } = verifyJwtSignature(idToken, keys);
  const now = Math.floor((opts.nowSec || Date.now() / 1000));
  if (!claims.sub) throw new Error('id_token 缺 sub');
  if (claims.iss !== config.issuer) throw new Error('iss 不符: ' + claims.iss);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.client_id)) throw new Error('aud 不符');
  if (claims.exp && now > claims.exp + 60) throw new Error('id_token 已过期');
  if (opts.nonce && claims.nonce !== opts.nonce) throw new Error('nonce 不符');
  return claims;
}

module.exports = { buildAuthUrl, exchangeAndVerify, verifyIdToken, discovery, jwks, b64url, timingSafeEq };
