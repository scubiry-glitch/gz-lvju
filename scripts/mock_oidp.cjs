#!/usr/bin/env node
/**
 * scripts/mock_oidp.cjs —— 最小 mock OIDC Provider（阶段3 联邦登录联调/验收用）
 *
 * 端点：
 *   GET /.well-known/openid-configuration
 *   GET /jwks                                  → RS256 公钥
 *   GET /authorize?...&sub=<模拟工号>            → 免登录直接 302 回 redirect_uri?code&state
 *   POST /token (form: grant_type/code/...)     → {id_token, access_token}
 *
 * 仅限本机/内网联调，禁止公网暴露。用法：node scripts/mock_oidp.cjs [port=19020]
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2] || process.env.MOCK_IDP_PORT || '19020', 10);
const ISSUER = process.env.MOCK_IDP_ISSUER || ('http://127.0.0.1:' + PORT);
const CLIENT_ID = process.env.MOCK_IDP_CLIENT_ID || 'juzhu-demo';
const CLIENT_SECRET = process.env.MOCK_IDP_CLIENT_SECRET || 'demo-secret';
const KID = 'mock-key-1';

// RS256 密钥对（进程内存活期有效）
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = Object.assign({ kty: 'RSA', kid: KID, alg: 'RS256', use: 'sig' }, publicKey.export({ format: 'jwk' }));

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const codes = new Map(); // code → {sub, nonce, exp}

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function idToken(sub, nonce, aud) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const payload = b64u(JSON.stringify({
    iss: ISSUER, sub, aud, nonce,
    exp: now + 300, iat: now,
    name: '联邦用户·' + sub,
  }));
  const sig = b64u(crypto.sign('sha256', Buffer.from(header + '.' + payload), privateKey));
  return header + '.' + payload + '.' + sig;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, ISSUER);
  if (u.pathname === '/.well-known/openid-configuration') {
    return send(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: ISSUER + '/authorize',
      token_endpoint: ISSUER + '/token',
      jwks_uri: ISSUER + '/jwks',
      id_token_signing_alg_values_supported: ['RS256'],
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
    });
  }
  if (u.pathname === '/jwks') return send(res, 200, { keys: [publicJwk] });
  if (u.pathname === '/authorize') {
    // 免登录自动批准：sub 默认 mock-gov-001，可用 ?sub= 覆盖（模拟不同工号）
    const code = crypto.randomBytes(12).toString('hex');
    codes.set(code, { sub: u.searchParams.get('sub') || 'mock-gov-001', nonce: u.searchParams.get('nonce') || '', exp: Date.now() + 120000 });
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    if (u.searchParams.get('state')) back.searchParams.set('state', u.searchParams.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (u.pathname === '/token' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
        return send(res, 401, { error: 'invalid_client' });
      }
      const rec = codes.get(form.get('code') || '');
      codes.delete(form.get('code') || '');
      if (!rec || Date.now() > rec.exp) return send(res, 400, { error: 'invalid_grant' });
      return send(res, 200, {
        access_token: 'mock-access-' + crypto.randomBytes(6).toString('hex'),
        token_type: 'Bearer',
        id_token: idToken(rec.sub, rec.nonce, form.get('client_id')),
        expires_in: 300,
      });
    });
    return;
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock OIDP on ${ISSUER} (client_id=${CLIENT_ID})`);
});
