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

// 最短连住晚数（详情日历与下单共同校验）：rental 旅居/长租、minsu 惠民民宿均默认 15 晚起住；
// 商家可在 projects.ext.min_stay_nights 覆盖（rental 1–365；minsu 15–365）
const STAY_MIN_NIGHTS_DEFAULT = { rental: 15, minsu: 15 };
// 民宿不允许用房源级覆盖降到 15 晚以下；rental 保留既有 1–365 晚覆盖能力。
const STAY_MIN_NIGHTS_MIN = { rental: 1, minsu: 15 };

// 房源交易能力（口径 2026-09-16）：online_booking=在线预订、商家确认后线下收款；
// online_payment=在线支付、支付后商家确认。两项独立配置且至少开一项，不再按频道分流。
// stay_bookable 仅保留为旧数据/旧客户端兼容键，新写入会归一化为上面两个键。
const STAY_BOOKABLE_KEY = 'stay_bookable';
const ONLINE_BOOKING_KEY = 'online_booking';
const ONLINE_PAYMENT_KEY = 'online_payment';

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

/**
 * 最短连住生效值（2026-09 下放户型）：户型 ext > 房源 ext > 频道默认，
 * 再按频道下限 clamp（rental 1 晚、minsu 15 晚）。unit 省略 = 房源级口径（列表摘要用）。
 * 整栋单（不指定户型）由调用方传入「排序最前的户型」，与取消政策同一套回退。
 */
function minStayNightsOf(proj, unit) {
  const channel = proj && proj.channel;
  const floor = STAY_MIN_NIGHTS_MIN[channel] || 1;
  const pick = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const fromUnit = unit ? pick(parseExtObj(unit.ext).min_stay_nights) : null;
  const fromProj = pick(parseExtObj(proj && proj.ext).min_stay_nights);
  let v = fromUnit != null ? fromUnit : (fromProj != null ? fromProj : (STAY_MIN_NIGHTS_DEFAULT[channel] || 1));
  if (!(v >= floor)) v = floor;
  return Math.min(v, 365);
}

/**
 * 最短连住的取值来源：'unit'（户型级显式配置）/ 'project'（房源级）/ 'default'（频道默认）。
 * 供后台表单区分「显式配置」与「继承来的生效值」——回显时只有 unit 档才预填输入框，
 * 否则保存会把继承值静默固化成户型级配置。
 */
function minStayNightsSourceOf(proj, unit) {
  const pick = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  if (unit && pick(parseExtObj(unit.ext).min_stay_nights) != null) return 'unit';
  if (pick(parseExtObj(proj && proj.ext).min_stay_nights) != null) return 'project';
  return 'default';
}

/** 写入口校验：default_closed 只接受布尔；非法抛 Error（写入口据此 400） */
function normalizeDefaultClosedInput(v) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  throw new Error('default_closed 须为布尔值（true = 未推送放出的日期默认不可订）');
}

/** 写入口校验：minsu 最低 15 晚，其他频道沿用 1 晚下限。 */
function normalizeMinStayNightsInput(value, channel) {
  const floor = STAY_MIN_NIGHTS_MIN[channel] || 1;
  const v = parseInt(value, 10);
  if (!(v >= floor && v <= 365)) throw new Error(`min_stay_nights 须为 ${floor}-365 的整数`);
  return v;
}

/**
 * 项目/户型默认夜价（规则15；2026-09 调整）：户型夜价 > 月租折算 > 房源起价折算。
 * 两频道都优先认 units.ext.price_night——rental 此前忽略它，短租房源只能拿月租表达，
 * 改后「传了不生效」变为生效；存量 rental 户型未配 price_night 者行为逐字不变。
 * 日历逐晚覆盖价仍高于本层（见 stayNightPrices / buildStayMonth）。
 */
function unitNightPrice(proj, unit) {
  const p = proj || {};
  if (unit) {
    const ux = parseExtObj(unit.ext);
    if (ux.price_night) return Math.round(ux.price_night);
    if (p.channel !== 'minsu' && unit.rent_monthly) {
      return Math.max(1, Math.round(unit.rent_monthly / 30));
    }
  }
  const base = p.price_from || 0;
  if (!base) return 0;
  return p.channel === 'minsu' ? base : Math.max(1, Math.round(base / 30));
}

/**
 * 整栋单（不指定户型）的默认夜价基准单位（2026-09）：有房源起价就用起价（C 端「不限房型（按起价）」
 * 的存量语义，价格逐字不变）；起价缺失时回落「排序最前户型」——price_from 改选填后必须补这层兜底，
 * 否则整栋单会算成 0 元（下单闸会直接拒单）。返回值直接作为 unit 形参传给计价/日历函数，null = 按起价。
 */
function wholeHousePriceUnit(proj, headUnit) {
  return (proj && proj.price_from > 0) ? null : (headUnit || null);
}

function boolCapability(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * 房源交易能力。新字段存在时完全按房源配置；旧数据仅在兼容分支按原频道还原旧行为：
 * minsu+stay_bookable → 在线支付，rental+stay_bookable → 在线预订；旧关闭/缺省 → 在线预订。
 * 存量迁移完成后运行态不再依赖频道。
 */
function transactionCapabilitiesOf(proj) {
  const p = proj || {};
  if (!['rental', 'minsu'].includes(p.channel)) return { online_booking: false, online_payment: false };
  const ext = parseExtObj(p.ext);
  const hasBooking = Object.prototype.hasOwnProperty.call(ext, ONLINE_BOOKING_KEY);
  const hasPayment = Object.prototype.hasOwnProperty.call(ext, ONLINE_PAYMENT_KEY);
  if (hasBooking || hasPayment) {
    return { online_booking: boolCapability(ext[ONLINE_BOOKING_KEY]), online_payment: boolCapability(ext[ONLINE_PAYMENT_KEY]) };
  }
  if (boolCapability(ext[STAY_BOOKABLE_KEY])) {
    return p.channel === 'minsu'
      ? { online_booking: false, online_payment: true }
      : { online_booking: true, online_payment: false };
  }
  return { online_booking: true, online_payment: false };
}

/** 将请求中的能力字段合并到 ext 并强制至少开启一项；同时移除旧 stay_bookable。 */
function applyTransactionCapabilities(extValue, input, channel) {
  const ext = Object.assign({}, parseExtObj(extValue));
  if (!['rental', 'minsu'].includes(channel)) return ext;
  const body = input || {};
  const current = transactionCapabilitiesOf({ channel, ext });
  let onlineBooking = current.online_booking;
  let onlinePayment = current.online_payment;
  if (Object.prototype.hasOwnProperty.call(body, ONLINE_BOOKING_KEY)) onlineBooking = boolCapability(body[ONLINE_BOOKING_KEY]);
  if (Object.prototype.hasOwnProperty.call(body, ONLINE_PAYMENT_KEY)) onlinePayment = boolCapability(body[ONLINE_PAYMENT_KEY]);
  // 旧客户端兼容：沿用旧频道含义还原（minsu=在线支付，rental=在线预订）。
  if (Object.prototype.hasOwnProperty.call(body, STAY_BOOKABLE_KEY)
    && !Object.prototype.hasOwnProperty.call(body, ONLINE_BOOKING_KEY)
    && !Object.prototype.hasOwnProperty.call(body, ONLINE_PAYMENT_KEY)) {
    if (boolCapability(body[STAY_BOOKABLE_KEY])) {
      onlineBooking = channel !== 'minsu';
      onlinePayment = channel === 'minsu';
    } else {
      onlineBooking = false;
      onlinePayment = false;
    }
  }
  if (!onlineBooking && !onlinePayment) throw new Error('在线预订与在线支付至少须开启一项');
  ext[ONLINE_BOOKING_KEY] = onlineBooking;
  ext[ONLINE_PAYMENT_KEY] = onlinePayment;
  delete ext[STAY_BOOKABLE_KEY];
  return ext;
}

/** 兼容能力位：任一交易方式开启即可展示日历并进入下单页。 */
function bookableOf(proj) {
  const caps = transactionCapabilitiesOf(proj);
  return caps.online_booking || caps.online_payment;
}

// ===== 多间库存口径（2026-09-10，docs/stay-multi-qty-design.md）=====
// unit = 同规格房型 × N 间（units.total_qty，缺省 1 = 旧行为）；stay_calendar.qty 为
// 商家按晚「放出间数」覆盖；booked_qty 为该晚已订间数。stored status 只写 open/blocked，
// booked 是 remaining<=0 的派生态（buildStayMonth 输出，不落库）。

/** 房型总间数：units.total_qty，缺省/非法回 1（存量全兼容），上限 999 */
function totalQtyOf(unit) {
  const v = parseInt(unit && unit.total_qty, 10);
  if (!(v >= 1)) return 1;
  return Math.min(v, 999);
}

/** 某晚「放出间数」：差异行 qty 覆盖 > units.total_qty；项目级行（unit_id=0，整栋）容量恒 1 */
function effectiveQtyOf(row, unit) {
  if (row && row.qty != null) {
    const q = parseInt(row.qty, 10);
    if (q >= 0) return Math.min(q, 999);
  }
  return row && Number(row.unit_id) === 0 ? 1 : totalQtyOf(unit);
}

/**
 * 「默认关房」（opt-in，2026-09 多渠道防超售）：开启后**只有商家显式设置过放出间数的晚**才可订，
 * 没推过的晚一律不可订——避免商家在别的渠道卖掉/临时不可售的晚被平台重新放开。
 * 判定用「该晚有没有 qty」而不是 source：下单占用会把 source 改写成 booking，但不会清 qty。
 * 缺省关闭（存量行为逐字不变）；只作用于指定户型的预订，整栋单语义不变。
 */
function defaultClosedOf(proj, unit) {
  const pick = (v) => v === true || v === 'true' || v === 1 || v === '1';
  if (unit && pick(parseExtObj(unit.ext).default_closed)) return true;
  return pick(parseExtObj(proj && proj.ext).default_closed);
}

/**
 * 某晚剩余可订间数（口径单一数据源）。两种放出语义：
 * - `qty_base IS NULL`（旧「放出总量」口径，2026-09-10 起）：remaining = max(0, 放出 − 已订)
 * - `qty_base` 非 NULL（净可售口径／方案 B，2026-09）：商家推的 `qty` 是**推送时点的净可售**，
 *   基线 = 推送时的已订数（可为 0），之后的平台占用才从它里面扣；
 *   remaining = clamp(放出 − (已订 − 基线), 0, 物理余量)——取消释放不会越过实际剩下的房间。
 * 关房 / legacy booked 行 → 0；无差异行 → 默认关房 ? 0 : total_qty。
 * proj 可选（省略 = 不看默认关房，存量调用方语义不变）。
 */
function remainingOf(row, unit, proj) {
  if (!row) return defaultClosedOf(proj, unit) ? 0 : totalQtyOf(unit);
  if (row.status === 'blocked' || row.status === 'booked') return 0;
  if (row.qty == null && defaultClosedOf(proj, unit)) return 0;   // 未显式放出 → 默认关房
  const booked = parseInt(row.booked_qty, 10) || 0;
  const qty = effectiveQtyOf(row, unit);
  // qty_base = NULL → 旧「放出总量」口径；非 NULL（含 0）→ 净可售口径，值为推送时点的已订数
  if (row.qty_base != null) {
    const base = parseInt(row.qty_base, 10) || 0;
    // 上限 = 物理余量（total_qty − 已订）：商家推的净数若超过实际剩下的房间数（对账漏了他渠道的销量），
    // 这里兜住，避免超售；正常对账下不会触顶
    const raw = qty - (booked - base);
    const physical = Math.max(0, totalQtyOf(unit) - booked);
    return Math.max(0, Math.min(raw, physical));
  }
  return Math.max(0, qty - booked);
}

/** 净可售口径的写入换算：available_qty（推送时点净可售）→ 存储的 qty / qty_base（基线 = 当前已订） */
function availableToQty(availableQty, bookedQty) {
  return { qty: Math.max(0, Math.min(999, parseInt(availableQty, 10) || 0)), qty_base: Math.max(0, parseInt(bookedQty, 10) || 0) };
}

/** 某晚是否为净可售口径（qty_base 非 NULL）；出参 available_qty 回显据此判定 */
function isNetAvailableRow(row) {
  return !!(row && row.qty_base != null && row.qty != null);
}

/**
 * 下单逐晚计价（2026-09-10）：每晚 = 日历覆盖价（户型级 > 项目级）否则默认夜价，
 * 与 buildStayMonth 的覆盖优先级同口径（C 端日历/下单页展示的就是这套价）。
 * fetchRows(sql, params) → Promise<rows>，由调用方注入连接池/连接。
 * 返回 { prices: [逐晚价], total: 合计, default_night: 默认夜价 }。
 */
async function stayNightPrices(fetchRows, proj, unit, unitId, checkin, checkout) {
  const dates = stayDateList(checkin, checkout);
  const def = unitNightPrice(proj, unit) || 0;
  const unitLevel = {};
  const projLevel = {};
  if (dates.length) {
    const rows = await fetchRows(
      `SELECT unit_id, stay_date, price_night FROM stay_calendar
       WHERE project_id=? AND stay_date BETWEEN ? AND ? AND price_night IS NOT NULL
         AND (unit_id=0 OR unit_id=?)`,
      [proj.id, dates[0], dates[dates.length - 1], unitId || 0]
    );
    for (const r of rows) {
      if (r.price_night == null) continue;
      if (!r.unit_id) { if (projLevel[r.stay_date] == null) projLevel[r.stay_date] = r.price_night; }
      else if (unitLevel[r.stay_date] == null) unitLevel[r.stay_date] = r.price_night;
    }
  }
  const prices = dates.map((d) => (unitLevel[d] != null ? unitLevel[d] : (projLevel[d] != null ? projLevel[d] : def)) || 0);
  return { prices, total: prices.reduce((a, b) => a + b, 0), default_night: def };
}

// ===== 房源卡片展示价（2026-09，规则16 延伸）=====
// C 端卡片价格只读服务端下发的 price_from_display / price_unit / price_note，
// 页面不得自行折算或拼口径（此前搜索页/首页各抄了一份 fallback，已收口到这里）。
// 单位口径（A″ 2026-09）：minsu 按晚；rental 带「旅居」tag 按晚；其余 rental 按月。
// 按晚的走「最低可售单夜价」扫描；按月的沿用 price_from 起价口径。
const PRICE_DISPLAY_SCAN_MONTHS = 12;   // 与 C 端房态日历可订窗口同一口径

const pad2 = (n) => String(n).padStart(2, '0');
const ymdOf = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

/** 展示单位：'night' | 'month' | null（null = 该频道不适用，C 端走 price_total） */
function priceDisplayUnitOf(proj) {
  const p = proj || {};
  if (p.channel === 'minsu') return 'night';
  if (p.channel !== 'rental') return null;
  let tags = p.tags;
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch (_) { tags = []; } }
  return (Array.isArray(tags) && tags.indexOf('旅居') >= 0) ? 'night' : 'month';
}

/**
 * 单房源「最低可售单夜价」扫描：从 t0 起按自然月向后，取第一个存在可售间夜的月份，
 * 该月内最低单夜价即展示价；扫满 PRICE_DISPLAY_SCAN_MONTHS 个月仍无可售 → null。
 * 可售口径：项目级当晚未关房 + 该户型当晚未关房、未售罄；无差异行 = 默认可订（按默认夜价）。
 * units 须已按 unitNightPrice>0 过滤；dev = { proj: Map<date,row>, unit: Map<'uid|date',row> }。
 */
function lowestSellableNightPrice(proj, units, dev, t0) {
  const endKey = ymdOf(new Date(t0.getFullYear(), t0.getMonth() + PRICE_DISPLAY_SCAN_MONTHS, t0.getDate()));
  for (let k = 0; k < PRICE_DISPLAY_SCAN_MONTHS; k++) {
    const from = k === 0 ? t0 : new Date(t0.getFullYear(), t0.getMonth() + k, 1);
    const to = new Date(t0.getFullYear(), t0.getMonth() + k + 1, 0);   // 该月最后一天
    let best = null;
    for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const ds = ymdOf(d);
      if (ds >= endKey) break;                                        // 超出检索窗口
      const pr = dev.proj.get(ds);
      if (pr && pr.status === 'blocked') continue;                     // 项目级关房压制全天
      for (const u of units) {
        const ur = dev.unit.get(u.id + '|' + ds) || null;
        if (ur && (ur.status === 'blocked' || ur.status === 'booked')) continue;
        if (remainingOf(ur, u, proj) <= 0) continue;                   // 该户型当晚售罄 / 未放出
        const price = (ur && ur.price_night != null) ? Number(ur.price_night)
          : (pr && pr.price_night != null ? Number(pr.price_night) : unitNightPrice(proj, u));
        if (price > 0 && (best == null || price < best)) best = price;
      }
    }
    if (best != null) return best;
  }
  return null;
}

/**
 * 批量展示价（catalog / 列表用，一次查库）：返回 Map<project_id, 最低可售单夜价 | null>。
 * 仅 rental/minsu 且至少一个户型有价的房源参与；其余记 null（C 端不展示按晚价）。
 * fetchRows(sql, params) → Promise<rows>，由调用方注入。
 */
async function priceDisplayScan(fetchRows, projects, units, now) {
  const out = new Map();
  const list = (projects || []).filter(Boolean);
  if (!list.length) return out;
  const today = now || new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startKey = ymdOf(t0);
  const endKey = ymdOf(new Date(t0.getFullYear(), t0.getMonth() + PRICE_DISPLAY_SCAN_MONTHS, t0.getDate()));
  const unitsByProj = new Map();
  for (const u of (units || [])) {
    if (!unitsByProj.has(u.project_id)) unitsByProj.set(u.project_id, []);
    unitsByProj.get(u.project_id).push(u);
  }
  const ids = list.map((p) => p.id);
  let rows = [];
  if (ids.length) {
    rows = await fetchRows(
      `SELECT project_id, unit_id, stay_date, status, price_night, qty, qty_base, booked_qty FROM stay_calendar
       WHERE project_id IN (${ids.map(() => '?').join(',')}) AND stay_date >= ? AND stay_date < ?`,
      [...ids, startKey, endKey]
    );
  }
  const devByProj = new Map();
  for (const r of rows) {
    let m = devByProj.get(r.project_id);
    if (!m) { m = { proj: new Map(), unit: new Map() }; devByProj.set(r.project_id, m); }
    if (!Number(r.unit_id)) m.proj.set(r.stay_date, r);
    else m.unit.set(Number(r.unit_id) + '|' + r.stay_date, r);
  }
  for (const p of list) {
    const priced = (unitsByProj.get(p.id) || []).filter((u) => unitNightPrice(p, u) > 0);
    if (!priced.length || !['rental', 'minsu'].includes(p.channel)) { out.set(p.id, null); continue; }
    const dev = devByProj.get(p.id);
    if (!dev) {   // 常见路径：无任何差异行 = 全窗口可订，最低价即户型默认夜价最小值
      out.set(p.id, Math.min(...priced.map((u) => unitNightPrice(p, u))));
      continue;
    }
    out.set(p.id, lowestSellableNightPrice(p, priced, dev, t0));
  }
  return out;
}

/**
 * 房源展示价三件套（随 catalog / 列表 / 详情下发，前端不自行折算）：
 *   price_from_display 数值 | null；price_unit 'night' | 'month' | null；
 *   price_note 空值文案（有值时为空串）：按晚无可售 = 「暂无可订」，按月无价 = 「价格面议」。
 * 按月口径维持 price_from 起价语义；按晚口径走最低可售单夜价（monthLow 由 priceDisplayScan 求得）。
 */
function priceDisplayOf(proj, monthLow) {
  const unit = priceDisplayUnitOf(proj);
  if (unit === null) return { price_from_display: null, price_unit: null, price_note: '' };
  if (unit === 'night') {
    // minsu 的 price_from 口径本来就是「元/晚」，沿用起价语义（存量展示价不变）；
    // rental（带旅居 tag）的 price_from 是「元/月」，不能当夜价用，一律走最低可售单夜价
    const fromPriceFrom = (proj && proj.channel === 'minsu' && proj.price_from > 0) ? Number(proj.price_from) : null;
    const v = fromPriceFrom != null ? fromPriceFrom : (monthLow != null && monthLow > 0 ? monthLow : null);
    return { price_from_display: v, price_unit: 'night', price_note: v ? '' : '暂无可订' };
  }
  const v = proj && proj.price_from > 0 ? Number(proj.price_from) : (monthLow != null && monthLow > 0 ? monthLow * 30 : null);
  return { price_from_display: v, price_unit: 'month', price_note: v ? '' : '价格面议' };
}

/**
 * 项目房态配置（随 catalog / 项目详情 / 房态日历下发，含 bookable 能力位）。
 * 传 unit 时 min_stay_nights 取该户型生效值——整栋单场景由调用方传「排序最前的户型」，
 * 与 POST /api/juzhu/booking 的下单闸同口径；不传 = 房源级默认值（列表摘要）。
 */
function stayConfigOf(proj, unit) {
  const ins = insuranceOf(proj);
  const caps = transactionCapabilitiesOf(proj);
  return {
    bookable: caps.online_booking || caps.online_payment,
    online_booking: caps.online_booking,
    online_payment: caps.online_payment,
    min_stay_nights: minStayNightsOf(proj, unit),
    insurance: ins,
    insurance_types: INSURANCE_TYPES.filter((t) => ins.includes(t.key)),
  };
}

// 免费取消政策（2026-09-09，房型维度）：免费取消窗口 = 入住日往前推 days_before 天的
// cutoff_time 时刻；窗口外 / 未启用一律不可取消不可退（硬截止，无扣款分档）。配置存
// units.ext.cancel_policy（规则 15 差异属性放 ext 不加列），缺省从严 = 不可取消；
// 商家侧（B 端 / HMAC）取消不受此闸约束，仅客户取消接口校验。
const CANCEL_POLICY_DEFAULT = { days_before: 1, cutoff_time: '18:00' };
const CANCEL_POLICY_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 写入口校验：enabled 布尔、days_before 0-30 整数、cutoff_time 严格 HH:mm；非法抛 Error */
function normalizeCancelPolicyInput(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('cancel_policy 须为对象');
  const enabled = v.enabled === true || v.enabled === 'true';
  const rawDays = v.days_before == null || v.days_before === '' ? CANCEL_POLICY_DEFAULT.days_before : parseInt(v.days_before, 10);
  if (!Number.isInteger(rawDays) || rawDays < 0 || rawDays > 30) throw new Error('cancel_policy.days_before 须为 0-30 整数');
  const time = v.cutoff_time == null || v.cutoff_time === '' ? CANCEL_POLICY_DEFAULT.cutoff_time : String(v.cutoff_time).trim();
  if (!CANCEL_POLICY_TIME_RE.test(time)) throw new Error('cancel_policy.cutoff_time 须为 HH:mm（如 18:00）');
  return { enabled, days_before: rawDays, cutoff_time: time };
}

function disabledCancelPolicy() {
  return { enabled: false, days_before: CANCEL_POLICY_DEFAULT.days_before, cutoff_time: CANCEL_POLICY_DEFAULT.cutoff_time };
}

/** 房型的取消政策（唯一读取点）：缺省 / 配置损坏 → 未启用（从严） */
function cancelPolicyOf(unit) {
  const raw = parseExtObj(unit && unit.ext).cancel_policy;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return disabledCancelPolicy();
  try { return normalizeCancelPolicyInput(raw); } catch (_) { return disabledCancelPolicy(); }
}

/** 免费取消截止时刻（本地时区 Date）；未启用或日期非法返回 null */
function cancelDeadlineOf(policy, checkin) {
  const p = policy || disabledCancelPolicy();
  if (!p.enabled || !isValidDateString(checkin)) return null;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(p.cutoff_time);
  const d = new Date(checkin + 'T00:00:00');
  d.setDate(d.getDate() - p.days_before);
  d.setHours(parseInt(hm[1], 10), parseInt(hm[2], 10), 0, 0);
  return d;
}

function fmtDeadline(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 客户是否仍在免费取消窗口内（now 缺省取当前时刻） */
function freeCancelOpenOf(policy, checkin, now) {
  const deadline = cancelDeadlineOf(policy, checkin);
  return !!deadline && (now || new Date()) <= deadline;
}

/** 政策中文文案（服务端算好下发，前端不得自行拼口径） */
function cancelPolicyTextOf(policy) {
  const p = policy || disabledCancelPolicy();
  if (!p.enabled) return '预订成功后不可取消';
  const dayTxt = p.days_before === 0 ? '入住当天' : (p.days_before === 1 ? '入住前一天' : '入住日前 ' + p.days_before + ' 天');
  return dayTxt + ' ' + p.cutoff_time + ' 前可免费取消，之后不可取消';
}

/** 给 unit 对象补 cancel_policy / cancel_policy_text（units 透出处统一走这里） */
function withCancelPolicy(unit) {
  const p = cancelPolicyOf(unit);
  unit.cancel_policy = p;
  unit.cancel_policy_text = cancelPolicyTextOf(p);
  return unit;
}

/**
 * 给 unit 补生效的住宿规则（最短连住 + 取消政策）：units 透出处统一走这里，
 * 前端只读 unit.min_stay_nights，不得回落到房源级或自设默认值（2026-09 下放户型）。
 */
function withStayRules(unit, proj) {
  withCancelPolicy(unit);
  unit.min_stay_nights = minStayNightsOf(proj, unit);
  unit.min_stay_nights_source = minStayNightsSourceOf(proj, unit);
  // 默认单夜价（含 2026-09 优先级：户型夜价 > 月租/30 > 房源起价/30）：随 unit 下发，
  // C 端下单页/详情页直接读它，不得再用 rent_monthly/30 自行折算（会与成交价脱节）
  unit.default_night_price = unitNightPrice(proj, unit) || null;
  return unit;
}

/** 订单的取消判定（lookup / my / cancel 三处同口径）：unit 为空（整栋单）从严视为未启用 */
function orderCancelInfoOf(unit, order, now) {
  const policy = unit ? cancelPolicyOf(unit) : disabledCancelPolicy();
  const deadline = cancelDeadlineOf(policy, order && order.checkin);
  const open = !!deadline && (now || new Date()) <= deadline;
  return {
    cancel_policy: policy,
    cancel_policy_text: cancelPolicyTextOf(policy),
    cancel_deadline: deadline ? fmtDeadline(deadline) : null,
    can_cancel: (order && order.status) === 'pending' && open,
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

/** 严格校验 YYYY-MM-DD，拒绝 JS Date 会自动归一化的非法日期。 */
function isValidDateString(value) {
  const s = String(value || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= last;
}

/**
 * 组装某月房态日历：无差异行 = open（放出间数 = units.total_qty）；
 * 本层差异行给出 qty 覆盖 / 已订间数，项目级行（unit_id=0，整栋）关房或被订时压制全天；
 * 夜价覆盖户型级 > 项目级 > 默认。status 为派生态：remaining<=0 → booked（多间库存，
 * 2026-09-10）；legacy 整行 booked（迁移前）按占满防御处理。
 * fetchRows(sql, params) → Promise<rows>，由调用方注入（app.js 连接池 / vendor_api.cjs HMAC 连接）。
 */
async function buildStayMonth(fetchRows, proj, unit, unitId, y, mo) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const first = y + '-' + pad2(mo + 1) + '-01';
  const lastDay = new Date(y, mo + 1, 0).getDate();
  const last = y + '-' + pad2(mo + 1) + '-' + String(lastDay).padStart(2, '0');
  const scRows = await fetchRows(
    `SELECT unit_id, stay_date, status, price_night, source, booking_id, qty, qty_base, booked_qty FROM stay_calendar
     WHERE project_id=? AND stay_date BETWEEN ? AND ? AND (unit_id=0 OR unit_id=?) ORDER BY stay_date, unit_id`,
    [proj.id, first, last, unitId]
  );
  const today = new Date();
  const todayKey = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  const defPrice = unitNightPrice(proj, unit);
  // 基准放出间数：unit 级 = units.total_qty；项目级日历（unitId=0，整栋）恒 1
  const baseQty = Number(unitId) > 0 ? totalQtyOf(unit) : 1;
  const days = [];
  for (let dd = 1; dd <= lastDay; dd++) {
    const ds = y + '-' + pad2(mo + 1) + '-' + String(dd).padStart(2, '0');
    const k = y * 10000 + (mo + 1) * 100 + dd;
    let status = 'open';
    let price = defPrice;
    let source = null;
    let bookingId = null;
    let qty = baseQty;      // 放出间数（差异行 qty 覆盖基准）
    let qtyOverride = null; // 差异行的 qty（null = 未显式放出，默认关房判定要用）
    let qtyBase = null;     // 净可售基线（非 NULL = 方案 B 口径，2026-09；NULL = 旧「放出总量」）
    let bookedQty = 0;      // 已订间数
    for (const r of scRows) {
      if (r.stay_date !== ds) continue;
      // legacy 防御：迁移前的 booked 行无 booked_qty，视为占满
      const rBooked = Math.max(parseInt(r.booked_qty, 10) || 0, r.status === 'booked' ? 1 : 0);
      if (Number(r.unit_id) === Number(unitId)) {
        if (r.qty != null) {
          qty = Math.max(0, parseInt(r.qty, 10) || 0);
          qtyOverride = r.qty;
          qtyBase = r.qty_base == null ? null : (parseInt(r.qty_base, 10) || 0);
        }
        bookedQty = Math.max(bookedQty, rBooked);
        if (r.status === 'blocked') { status = 'blocked'; source = r.source; }
        else if (r.status === 'booked') { status = 'booked'; source = r.source; }
        else if (r.source) source = r.source;
        if (r.booking_id) bookingId = bookingId || r.booking_id;   // 首个占用订单 id（仅展示线索）
      } else if (r.status === 'blocked' && status !== 'booked') {
        status = 'blocked'; source = r.source;               // 项目级关房压过本层 open
      } else if (rBooked > 0) {
        status = 'booked'; source = r.source;                // 整栋被订 → 该 unit 当晚不可订
        bookingId = bookingId || r.booking_id || null;
      }
      if (r.price_night != null && (r.unit_id === unitId || price === defPrice)) price = r.price_night;
    }
    // 剩余数走单一数据源 remainingOf（含净可售基线 / 默认关房两种新口径）
    const remaining = remainingOf({
      status, qty: qtyOverride, qty_base: qtyBase, booked_qty: bookedQty, unit_id: unitId,
    }, unit, proj);
    // 剩余 0 的两种成因分开报：有占用 = booked（已订）；默认关房没推过 = blocked（商家未开放），
    // 后者若报「已订」会误导 C 端（其实只是没放出）
    if (status !== 'blocked' && remaining <= 0) {
      status = (qtyOverride == null && defaultClosedOf(proj, unit)) ? 'blocked' : 'booked';
    }
    days.push({
      date: ds,
      status: k < todayKey ? 'past' : status,
      price: price || null,
      source: k < todayKey ? null : source,
      booking_id: bookingId,
      qty: qty != null ? qty : null,
      booked_qty: bookedQty,
      remaining,
      available_qty: qtyBase == null ? null : qty,   // 净可售口径回显（null = 该晚按旧「放出总量」口径）
    });
  }
  return { month: y + '-' + pad2(mo + 1), base_price_night: defPrice || null, days };
}

/**
 * 释放订单占用的逐晚库存（多间口径，2026-09-10）：按订单自身区间对 booked_qty 对称递减
 * （不依赖 booking_id——多间下一行可被多单占用），纯占用行删行；商家差异行
 * （price_night / qty / blocked）原地保留，修掉旧「DELETE WHERE booking_id」连带清夜价的副作用。
 * execute(sql, params) → ResultSetHeader，由调用方注入（事务内 conn.execute 取 [0]）。
 * opts: { project_id, unit_id, rooms, checkin, checkout, now? }；返回删除的纯占用行数。
 */
async function releaseStayQty(execute, opts) {
  const o = opts || {};
  if (!o.project_id || !isValidDateString(o.checkin) || !isValidDateString(o.checkout)) return 0;
  const unitId = parseInt(o.unit_id, 10) || 0;
  const rooms = Math.min(999, Math.max(1, parseInt(o.rooms, 10) || 1));
  const now = o.now || new Date().toISOString().slice(0, 19).replace('T', ' ');
  await execute(
    `UPDATE stay_calendar SET
       booked_qty = IF(status='booked', GREATEST(booked_qty, 1) - ?, GREATEST(booked_qty - ?, 0)),
       status = IF(status='booked', 'open', status),
       updated_at = ?
     WHERE project_id=? AND unit_id=? AND stay_date>=? AND stay_date<?`,
    [rooms, rooms, now, o.project_id, unitId, o.checkin, o.checkout]
  );
  const delRes = await execute(
    `DELETE FROM stay_calendar WHERE project_id=? AND unit_id=? AND stay_date>=? AND stay_date<?
       AND booked_qty=0 AND status='open' AND source='booking' AND price_night IS NULL AND qty IS NULL AND qty_base IS NULL`,
    [o.project_id, unitId, o.checkin, o.checkout]
  );
  return (delRes && delRes.affectedRows) || 0;
}

module.exports = {
  INSURANCE_TYPES,
  INSURANCE_KEYS,
  STAY_MIN_NIGHTS_DEFAULT,
  STAY_MIN_NIGHTS_MIN,
  STAY_BOOKABLE_KEY,
  ONLINE_BOOKING_KEY,
  ONLINE_PAYMENT_KEY,
  STAY_STATUS,
  HOUSING_CHANNELS,
  CANCEL_POLICY_DEFAULT,
  parseExtObj,
  insuranceOf,
  minStayNightsOf,
  minStayNightsSourceOf,
  normalizeMinStayNightsInput,
  transactionCapabilitiesOf,
  applyTransactionCapabilities,
  bookableOf,
  totalQtyOf,
  effectiveQtyOf,
  remainingOf,
  defaultClosedOf,
  normalizeDefaultClosedInput,
  availableToQty,
  isNetAvailableRow,
  unitNightPrice,
  wholeHousePriceUnit,
  stayNightPrices,
  PRICE_DISPLAY_SCAN_MONTHS,
  priceDisplayUnitOf,
  lowestSellableNightPrice,
  priceDisplayScan,
  priceDisplayOf,
  withStayRules,
  normalizeCancelPolicyInput,
  cancelPolicyOf,
  cancelDeadlineOf,
  freeCancelOpenOf,
  cancelPolicyTextOf,
  withCancelPolicy,
  orderCancelInfoOf,
  isValidDateString,
  stayConfigOf,
  stayDateList,
  buildStayMonth,
  releaseStayQty,
};
