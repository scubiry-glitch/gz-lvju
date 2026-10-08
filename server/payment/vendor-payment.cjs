'use strict';

const MODES = Object.freeze(['wechat_mini', 'pay_center']);
function fail(message, status = 409) { const error = new Error(message); error.status = status; return error; }
function parseObject(value) {
  if (!value) return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('支付配置格式无效', 400);
  return parsed;
}
function normalizeMode(value) {
  if (value === null || value === '') return null;
  if (!MODES.includes(value)) throw fail('支付方式须为 wechat_mini 或 pay_center', 400);
  return value;
}
function paymentConfig(value) {
  const input = parseObject(value), out = {};
  for (const key of Object.keys(input)) {
    if (!['appCode', 'projectCode', 'shareBizCode'].includes(key)) throw fail('不支持的支付配置字段：' + key, 400);
    const text = String(input[key] || '').trim();
    if (text && !/^[A-Za-z0-9_.:-]{1,64}$/.test(text)) throw fail('支付配置字段格式无效：' + key, 400);
    if (text) out[key] = text;
  }
  return out;
}
function validateVendorPayment(vendor) {
  const mode = normalizeMode(vendor.payment_mode);
  if (mode === 'wechat_mini' && (!String(vendor.url_link || '').trim() || !String(vendor.hmac_key || '').trim())) {
    throw fail('小程序支付需要 URL Link 接口与签名密钥', 400);
  }
  if (mode === 'pay_center' && !/^[A-Za-z0-9_.:-]{1,64}$/.test(String(vendor.pay_merchant_no || '').trim())) {
    throw fail('中台支付需要有效的收款商户号', 400);
  }
  paymentConfig(vendor.payment_config_json);
  return mode;
}
function isExternalOrder(order) {
  if (!order || (order.biz_type && order.biz_type !== 'jiazheng')) return false;
  if (order.payment_mode === 'wechat_mini') return true;
  // Pre-migration external orders were generated as GR + 14-digit time +
  // 4-digit random suffix and held a numeric product ID and vendor ownership.
  // They must remain callback-compatible even after that product is deleted.
  // Never infer a route from a vendor's *current* payment configuration.
  return order.payment_mode == null && /^GR\d{18}$/.test(String(order.order_ref || ''))
    && /^[1-9]\d*$/.test(String(order.sku || '')) && /^[1-9]\d*$/.test(String(order.vendor_id || ''));
}
function stripPaymentSecrets(vendor) {
  for (const key of ['hmac_key', 'url_link', 'order_detail_url', 'pay_merchant_no', 'payment_config_json']) delete vendor[key];
  return vendor;
}
module.exports = { MODES, fail, parseObject, normalizeMode, paymentConfig, validateVendorPayment, isExternalOrder, stripPaymentSecrets };
