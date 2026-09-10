// vendor_rate.cjs — 商家佣金费率（按业务线分档）纯函数（不连库，规则 20 单一数据源）
// app.js（会话态接口）与 vendor_api.cjs（商家 HMAC 开放接口）共用，勿在两侧各写一份。
// 口径（2026-09-09）：生效费率 = jz_vendors.commission_<biz> ?? settings KV commission_<biz>_default ?? 10.00；
// 订单（booking_orders）在下单时锁定 commission_rate / commission_fee 快照，调价不追溯；
// 配置主体是平台（vendor.fund.write），商家只读；家政服务者分账走 L0-L7 矩阵，不归本模块。
'use strict';

const BIZLINES = ['housing', 'jiazheng'];
const BIZLINE_LABELS = { housing: '房源预订', jiazheng: '家政' };
const RATE_MIN = 0;
const RATE_MAX = 100;
const FALLBACK_DEFAULT = 10.00;   // KV 缺失/损坏时的最后兜底（0903 纪要基准）

/** 业务线的全局基准 settings KV key */
function defaultSettingKey(biz) {
  return 'commission_' + biz + '_default';
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 写入口校验：数字/字符串 → 0-100 两位小数；null/'' → null（清除 = 回落全局基准）；非法抛 Error */
function normalizeRate(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).trim());
  if (!Number.isFinite(n)) throw new Error('费率须为 0-100 的数字（%）');
  if (n < RATE_MIN || n > RATE_MAX) throw new Error('费率须在 0-100 之间（%）');
  return round2(n);
}

function validRate(n) {
  return Number.isFinite(n) && n >= RATE_MIN && n <= RATE_MAX;
}

/** 全局基准：settings KV 读值，非法/缺失回落 FALLBACK_DEFAULT */
function defaultRateOf(settingsMap, biz) {
  const n = parseFloat(settingsMap && settingsMap[defaultSettingKey(biz)]);
  return validRate(n) ? round2(n) : FALLBACK_DEFAULT;
}

/** 商家某业务线生效费率：差异化列 → 全局基准 → 10 兜底 */
function effectiveRateOf(vendorRow, biz, settingsMap) {
  const n = parseFloat(vendorRow ? vendorRow['commission_' + biz] : null);
  return validRate(n) ? round2(n) : defaultRateOf(settingsMap, biz);
}

/** 佣金金额（元，保留 2 位小数） */
function commissionAmountOf(priceTotal, rate) {
  const r = parseFloat(rate);
  if (!Number.isFinite(r)) return 0;
  return round2((parseFloat(priceTotal) || 0) * r / 100);
}

module.exports = {
  BIZLINES,
  BIZLINE_LABELS,
  RATE_MIN,
  RATE_MAX,
  FALLBACK_DEFAULT,
  defaultSettingKey,
  normalizeRate,
  defaultRateOf,
  effectiveRateOf,
  commissionAmountOf,
};
