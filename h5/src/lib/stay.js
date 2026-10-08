/** 房态日历日期 / 区间工具（对齐规则 16 口径，页面只读服务端 days） */

const WK = ['日', '一', '二', '三', '四', '五', '六'];

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function iso(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

export function parseIso(s) {
  if (!s) return null;
  const d = new Date(s + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

export function md(d) {
  return d.getMonth() + 1 + '月' + d.getDate() + '日';
}

export function mdWeek(d) {
  return md(d) + ' 周' + WK[d.getDay()];
}

export function mds(d) {
  return d.getMonth() + 1 + '/' + d.getDate();
}

export function monthKey(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

export function startOfToday() {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** 入住日 → 离店日（不含离店）的晚列表 */
export function nightsBetween(checkin, checkout) {
  const a = typeof checkin === 'string' ? parseIso(checkin) : checkin;
  const b = typeof checkout === 'string' ? parseIso(checkout) : checkout;
  if (!a || !b || b <= a) return [];
  const out = [];
  const cur = new Date(a);
  while (cur < b && out.length < 3650) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export function nightCount(checkin, checkout) {
  return nightsBetween(checkin, checkout).length;
}

export function dayBlocked(inf) {
  if (!inf) return false;
  return (
    inf.status === 'booked' ||
    inf.status === 'blocked' ||
    (inf.remaining != null && inf.remaining <= 0)
  );
}

/** 从 stay-calendar 响应建 date→day map；支持批量 {units:[]} 与单户型 {days:[]} */
export function daysMapFromResp(j, unitId) {
  if (!j) return {};
  if (Array.isArray(j.units) && j.units.length) {
    const uid = unitId != null ? Number(unitId) : null;
    let pick = uid != null ? j.units.find((u) => Number(u.unit_id) === uid) : null;
    if (!pick) pick = j.units[0];
    const map = {};
    (pick?.days || []).forEach((d) => {
      map[d.date] = d;
    });
    return map;
  }
  const map = {};
  (j.days || []).forEach((d) => {
    map[d.date] = d;
  });
  return map;
}

/** 批量响应 → unitId → date map */
export function batchMapsFromResp(j) {
  const out = {};
  if (j && Array.isArray(j.units)) {
    j.units.forEach((u) => {
      const map = {};
      (u.days || []).forEach((d) => {
        map[d.date] = d;
      });
      out[u.unit_id] = map;
      if (u.base_price_night != null) out._base = { ...(out._base || {}), [u.unit_id]: u.base_price_night };
    });
  } else if (j && j.days) {
    const map = {};
    j.days.forEach((d) => {
      map[d.date] = d;
    });
    out[0] = map;
  }
  return out;
}

export function rangeMonths(checkin, checkout) {
  const list = nightsBetween(checkin, checkout);
  const set = new Set();
  list.forEach((d) => set.add(monthKey(d)));
  return [...set];
}

/**
 * 区间总价（单间口径）：日历覆盖价 → basePerNight
 * @returns {{ total, blocked, est, minRemaining }}
 */
export function sumRange(nights, dayMap, basePerNight) {
  let total = 0;
  let blocked = false;
  let est = false;
  let minRemaining = null;
  nights.forEach((d) => {
    const key = iso(d);
    const inf = dayMap[key];
    if (dayBlocked(inf)) blocked = true;
    const p = inf && inf.price != null && Number(inf.price) > 0 ? Number(inf.price) : basePerNight;
    if (!(inf && inf.price != null && Number(inf.price) > 0)) est = true;
    total += p || 0;
    if (inf && inf.remaining != null) {
      minRemaining = minRemaining == null ? inf.remaining : Math.min(minRemaining, inf.remaining);
    }
  });
  return { total, blocked, est, minRemaining };
}

export function buildMonthGrid(year, month /* 0-based */) {
  const first = new Date(year, month, 1);
  const startPad = first.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function monthsFrom(start, count) {
  const out = [];
  const s = new Date(start.getFullYear(), start.getMonth(), 1);
  for (let i = 0; i < count; i++) {
    out.push(new Date(s.getFullYear(), s.getMonth() + i, 1));
  }
  return out;
}

export { WK };
