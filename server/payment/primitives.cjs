'use strict';

const crypto = require('node:crypto');
const { bjStamp, dbTimeMs } = require('../utils/bj-time.cjs');

class PaymentError extends Error {
  constructor(message, status = 409, code = 'payment_conflict') {
    super(message); this.name = 'PaymentError'; this.status = status; this.statusCode = status; this.code = code;
  }
}
function assert(ok, message, status, code) { if (!ok) throw new PaymentError(message, status, code); }
function parse(value, fallback = {}) { if (value == null) return fallback; return typeof value === 'string' ? JSON.parse(value) : value; }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function sqlDate(value = new Date()) {
  // 统一口径：数据库存北京时间 'YYYY-MM-DD HH:mm:ss'
  try { return bjStamp(value); }
  catch (_) { throw new PaymentError('支付时间格式无效', 422, 'invalid_date'); }
}
function expired(value, now = Date.now()) { return dbTimeMs(sqlDate(value)) <= now; }
function minor(value, allowZero = false) {
  const n = Number(value);
  assert(Number.isSafeInteger(n) && n >= (allowZero ? 0 : 1) && n <= 999999999999, '支付金额无效（单位分）', 422, 'invalid_amount');
  return n;
}
function toAmount(value) { const n = minor(value); return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`; }
function toMinor(value) {
  const s = String(value == null ? '' : value);
  assert(/^\d+(?:\.\d{1,2})?$/.test(s), '支付金额格式无效', 422, 'invalid_amount');
  const [whole, fraction = ''] = s.split('.');
  return minor(Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
}
function normalizeBizOrderNo(bizType, orderId) {
  assert(['booking', 'jiazheng', 'commerce'].includes(bizType), '业务类型无效', 422, 'invalid_business');
  const value = String(orderId || '');
  if (bizType === 'commerce') {
    assert(/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(value) || /^[a-fA-F0-9]{32}$/.test(value), '权益订单号格式无效', 422, 'invalid_order');
    return value.replace(/-/g, '').toLowerCase();
  }
  assert(/^[A-Za-z0-9_-]{1,32}$/.test(value), '业务订单号须为 1 至 32 位', 422, 'invalid_order');
  return value;
}
function restoreBizOrderNo(bizType, orderId) {
  const n = normalizeBizOrderNo(bizType, orderId);
  return bizType === 'commerce' ? n.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : n;
}
function generateAppOrderId(prefix = 'XD', now = new Date()) {
  const stamp = new Date(now.getTime() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 14);
  return `${prefix}_${stamp}_${String(crypto.randomInt(0, 1000000)).padStart(6, '0')}`;
}
function requestKey(value) { assert(typeof value === 'string' && /^[A-Za-z0-9:_-]{8,80}$/.test(value), '缺少有效的幂等请求标识', 422, 'idempotency_key_required'); return value; }
function notificationKey(body) { return digest(body); }
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /token|secret|password|authorization|ucid|phone|cashier.?url|callback.?url|hmac.?key/i.test(k) ? '[redacted]' : sanitize(v)]));
  return value;
}

module.exports = { PaymentError, assert, parse, digest, sqlDate, expired, minor, toAmount, toMinor, normalizeBizOrderNo, restoreBizOrderNo, generateAppOrderId, requestKey, notificationKey, sanitize };
