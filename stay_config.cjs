// stay_config.cjs — 房态 / 保险 / 最短连住（旅居短住口径）单一数据源
// app.js（会话态接口）与 vendor_api.cjs（商家 HMAC 开放接口）共用，勿在两侧各写一份。
'use strict';

// 保险标识：商家在 projects.ext.insurance（key 数组）配置，catalog / 项目详情按此下发
const INSURANCE_TYPES = [
  { key: 'switch_rental', label: '换租保险', short: '换租险', icon: '🔄' },
  { key: 'hotel_cancel', label: '酒店取消险', short: '取消险', icon: '🏨' },
  { key: 'property', label: '财产保险', short: '财险', icon: '🛡' },
];
const INSURANCE_KEYS = INSURANCE_TYPES.map((t) => t.key);

// 最短连住晚数（详情日历与下单共同校验）：rental 旅居/长租 15 晚起住，minsu 惠民短住 1 晚起；
// 商家可在 projects.ext.min_stay_nights 覆盖（1–365）
const STAY_MIN_NIGHTS_DEFAULT = { rental: 15, minsu: 1 };

// 房态：open 可订 / blocked 关房（商家手工） / booked 已订（下单占用）
const STAY_STATUS = { OPEN: 'open', BLOCKED: 'blocked', BOOKED: 'booked' };

// 房源频道（booking / 商家创建可用的取值）
const HOUSING_CHANNELS = ['rental', 'minsu', 'newhouse', 'resale', 'trade'];

function parseExtObj(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try {
    const o = JSON.parse(v);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (_) { return {}; }
}

function insuranceOf(proj) {
  const list = parseExtObj(proj && proj.ext).insurance;
  if (!Array.isArray(list)) return [];
  const seen = [];
  for (const k of list) {
    if (INSURANCE_KEYS.includes(k) && !seen.includes(k)) seen.push(k);
  }
  return seen;
}

function minStayNightsOf(proj) {
  const raw = parseInt(parseExtObj(proj && proj.ext).min_stay_nights, 10);
  let v = Number.isFinite(raw) ? raw : (STAY_MIN_NIGHTS_DEFAULT[(proj && proj.channel)] || 1);
  if (!(v >= 1)) v = 1;
  return Math.min(v, 365);
}

/** 项目/户型夜价默认口径（规则15）：minsu=units.ext.price_night / price_from；rental=月租/30 折算 */
function unitNightPrice(proj, unit) {
  const p = proj || {};
  if (unit) {
    if (p.channel === 'minsu') {
      const ux = parseExtObj(unit.ext);
      if (ux.price_night) return Math.round(ux.price_night);
    } else if (unit.rent_monthly) {
      return Math.max(1, Math.round(unit.rent_monthly / 30));
    }
  }
  const base = p.price_from || 0;
  if (!base) return 0;
  return p.channel === 'minsu' ? base : Math.max(1, Math.round(base / 30));
}

/** 项目房态配置（随 catalog / 项目详情 / 房态日历下发） */
function stayConfigOf(proj) {
  const ins = insuranceOf(proj);
  return {
    min_stay_nights: minStayNightsOf(proj),
    insurance: ins,
    insurance_types: INSURANCE_TYPES.filter((t) => ins.includes(t.key)),
  };
}

/** 闭区间 [checkin, checkout) 的日期串列表（YYYY-MM-DD） */
function stayDateList(checkin, checkout) {
  const out = [];
  const start = new Date(checkin + 'T00:00:00');
  const end = new Date(checkout + 'T00:00:00');
  for (let d = start; d < end && out.length < 3650; d.setDate(d.getDate() + 1)) {
    out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
  }
  return out;
}

/**
 * 组装某月房态日历：无差异行 = open；blocked/booked 压过同日项目级 open；
 * 夜价覆盖户型级 > 项目级 > 默认。fetchRows(sql, params) → Promise<rows>，
 * 由调用方注入（app.js 连接池 / vendor_api.cjs HMAC 连接）。
 */
async function buildStayMonth(fetchRows, proj, unit, unitId, y, mo) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const first = y + '-' + pad2(mo + 1) + '-01';
  const lastDay = new Date(y, mo + 1, 0).getDate();
  const last = y + '-' + pad2(mo + 1) + '-' + String(lastDay).padStart(2, '0');
  const scRows = await fetchRows(
    `SELECT unit_id, stay_date, status, price_night, source, booking_id FROM stay_calendar
     WHERE project_id=? AND stay_date BETWEEN ? AND ? AND (unit_id=0 OR unit_id=?) ORDER BY stay_date, unit_id`,
    [proj.id, first, last, unitId]
  );
  const today = new Date();
  const todayKey = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  const defPrice = unitNightPrice(proj, unit);
  const days = [];
  for (let dd = 1; dd <= lastDay; dd++) {
    const ds = y + '-' + pad2(mo + 1) + '-' + String(dd).padStart(2, '0');
    const k = y * 10000 + (mo + 1) * 100 + dd;
    let status = 'open';
    let price = defPrice;
    let source = null;
    let bookingId = null;
    for (const r of scRows) {
      if (r.stay_date !== ds) continue;
      if (r.status === 'booked') { status = 'booked'; source = r.source; bookingId = r.booking_id || null; }
      else if (r.status === 'blocked' && status !== 'booked') { status = 'blocked'; source = r.source; }
      if (r.price_night != null && (r.unit_id === unitId || price === defPrice)) price = r.price_night;
    }
    days.push({
      date: ds,
      status: k < todayKey ? 'past' : status,
      price: price || null,
      source: k < todayKey ? null : source,
      booking_id: bookingId,
    });
  }
  return { month: y + '-' + pad2(mo + 1), base_price_night: defPrice || null, days };
}

module.exports = {
  INSURANCE_TYPES,
  INSURANCE_KEYS,
  STAY_MIN_NIGHTS_DEFAULT,
  STAY_STATUS,
  HOUSING_CHANNELS,
  parseExtObj,
  insuranceOf,
  minStayNightsOf,
  unitNightPrice,
  stayConfigOf,
  stayDateList,
  buildStayMonth,
};
