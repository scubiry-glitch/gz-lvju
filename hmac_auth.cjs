// hmac_auth.cjs — 商家 HMAC-SHA256（对齐 api_doc.md / juzhu/sign_util.py）
'use strict';

const crypto = require('crypto');

function pyStr(v) {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (Array.isArray(v)) {
    return '[' + v.map((x) => {
      if (typeof x === 'string') return "'" + x + "'";
      return pyStr(x);
    }).join(', ') + ']';
  }
  return String(v);
}

function flattenAndFilter(data, prefix) {
  const flat = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return flat;
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === '') continue;
    const keyName = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(flat, flattenAndFilter(v, keyName));
    } else {
      flat[keyName] = pyStr(v);
    }
  }
  return flat;
}

function buildStringToSign(flatParams) {
  return Object.keys(flatParams).sort().map((k) => k + '=' + flatParams[k]).join('&');
}

function hmacHex(secret, stringToSign) {
  return crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('hex');
}

function generateSignature(secretKey, requestBody, nowMs) {
  const payload = Object.assign({}, requestBody || {});
  delete payload.sign;
  const timestamp = nowMs != null ? nowMs : Date.now();
  const flat = flattenAndFilter(payload);
  flat.timestamp = String(timestamp);
  const stringToSign = buildStringToSign(flat);
  payload.timestamp = timestamp;
  payload.sign = hmacHex(secretKey, stringToSign);
  return payload;
}

function verifySignature(secretKey, requestBody, expireWindowMs) {
  const windowMs = expireWindowMs == null ? 300000 : expireWindowMs;
  const payload = Object.assign({}, requestBody || {});
  const clientSign = payload.sign;
  const timestampRaw = payload.timestamp;
  delete payload.sign;
  delete payload.timestamp;
  if (!clientSign || timestampRaw == null || timestampRaw === '') {
    return { ok: false, message: '缺失签名(sign)或时间戳(timestamp)参数' };
  }
  const timestamp = parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestamp)) return { ok: false, message: '时间戳格式错误' };
  if (Math.abs(Date.now() - timestamp) > windowMs) {
    return { ok: false, message: '请求已过期 (当前系统时间差异超出 ' + windowMs + 'ms)' };
  }
  const flat = flattenAndFilter(payload);
  flat.timestamp = String(timestamp);
  const expected = hmacHex(secretKey, buildStringToSign(flat));
  const a = Buffer.from(String(expected).toLowerCase());
  const b = Buffer.from(String(clientSign).toLowerCase());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, message: '签名校验失败' };
  }
  return { ok: true, message: '校验通过' };
}

module.exports = {
  pyStr,
  flattenAndFilter,
  buildStringToSign,
  generateSignature,
  verifySignature,
};
