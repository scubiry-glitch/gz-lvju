/** 对齐 lvju-app-price.js：只读服务端 price_from_display / price_unit / price_note */
const UNIT_TEXT = { night: '/晚起', month: '/月起' };

export function priceParts(p = {}) {
  let v = p.price_from_display;
  v = v == null || !(Number(v) > 0) ? null : Number(v);
  return { value: v, unit: p.price_unit || null, note: p.price_note || '价格面议' };
}

export function priceUnitText(p) {
  const r = priceParts(p);
  return r.value == null ? null : UNIT_TEXT[r.unit] || '';
}

export function formatPrice(n) {
  if (n == null || Number.isNaN(n)) return '';
  return Number(n).toLocaleString('zh-CN');
}

export function formatMoney(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function priceLabel(p) {
  const pd = priceParts(p);
  if (pd.value != null) return { kind: 'value', text: `¥${formatPrice(pd.value)}`, unit: priceUnitText(p) || '' };
  return { kind: 'note', text: pd.note };
}

/** 户型默认单夜价：读服务端 default_night_price，缺字段回落月租/30 */
export function unitNight(u = {}) {
  if (u.default_night_price != null) return Number(u.default_night_price) || 0;
  return u.rent_monthly ? Math.max(1, Math.round(u.rent_monthly / 30)) : 0;
}
