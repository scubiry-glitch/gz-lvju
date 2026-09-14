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

// 在线预订能力开关（口径 2026-09-05）：默认一律仅 400 电话咨询；项目开通
// （projects.ext.stay_bookable === true，B 端房态页「按晚预订」开关）后才支持
// 日历选房 + 在线下单。tag 不参与判断；「无行=默认可订」仅在已开通项目上生效。
const STAY_BOOKABLE_KEY = 'stay_bookable';

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

/** 项目是否已开通在线预订（唯一判断点，booking / 页面 CTA 均以此为准） */
function bookableOf(proj) {
  return parseExtObj(proj && proj.ext)[STAY_BOOKABLE_KEY] === true;
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

/** 某晚剩余可订间数：关房 / legacy booked 行（迁移前的整行占用）→ 0；否则 max(0, 放出 − 已订) */
function remainingOf(row, unit) {
  if (!row) return totalQtyOf(unit);
  if (row.status === 'blocked' || row.status === 'booked') return 0;
  const booked = parseInt(row.booked_qty, 10) || 0;
  return Math.max(0, effectiveQtyOf(row, unit) - booked);
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

/** 项目房态配置（随 catalog / 项目详情 / 房态日历下发，含 bookable 能力位） */
function stayConfigOf(proj) {
  const ins = insuranceOf(proj);
  return {
    bookable: bookableOf(proj),
    min_stay_nights: minStayNightsOf(proj),
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
    `SELECT unit_id, stay_date, status, price_night, source, booking_id, qty, booked_qty FROM stay_calendar
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
    let bookedQty = 0;      // 已订间数
    for (const r of scRows) {
      if (r.stay_date !== ds) continue;
      // legacy 防御：迁移前的 booked 行无 booked_qty，视为占满
      const rBooked = Math.max(parseInt(r.booked_qty, 10) || 0, r.status === 'booked' ? 1 : 0);
      if (Number(r.unit_id) === Number(unitId)) {
        if (r.qty != null) qty = Math.max(0, parseInt(r.qty, 10) || 0);
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
    const remaining = status === 'blocked' ? 0 : Math.max(0, qty - bookedQty);
    if (status !== 'blocked' && remaining <= 0) status = 'booked';
    days.push({
      date: ds,
      status: k < todayKey ? 'past' : status,
      price: price || null,
      source: k < todayKey ? null : source,
      booking_id: bookingId,
      qty: qty != null ? qty : null,
      booked_qty: bookedQty,
      remaining,
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
       AND booked_qty=0 AND status='open' AND source='booking' AND price_night IS NULL AND qty IS NULL`,
    [o.project_id, unitId, o.checkin, o.checkout]
  );
  return (delRes && delRes.affectedRows) || 0;
}

module.exports = {
  INSURANCE_TYPES,
  INSURANCE_KEYS,
  STAY_MIN_NIGHTS_DEFAULT,
  STAY_BOOKABLE_KEY,
  STAY_STATUS,
  HOUSING_CHANNELS,
  CANCEL_POLICY_DEFAULT,
  parseExtObj,
  insuranceOf,
  minStayNightsOf,
  bookableOf,
  totalQtyOf,
  effectiveQtyOf,
  remainingOf,
  unitNightPrice,
  stayNightPrices,
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
