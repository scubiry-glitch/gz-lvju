#!/usr/bin/env node
/**
 * scripts/housing_vendor_hmac_regression.cjs —— 房源开放接口 HMAC 全生命周期回归
 *
 * 走完整 HTTP 签名链路（vendor_id + timestamp + sign，密钥取库内 jz_vendors.hmac_key）：
 *   创建(草稿) → 补户型 → 上架前置拦截 → 设价后上架 → C 端 catalog 可见 →
 *   更新(保险/最短连住) → 房态关房/开房 → 下架 → catalog 不可见 → 越权负例 → 清理
 *
 * 用法：node scripts/housing_vendor_hmac_regression.cjs [base_url]   # 默认 http://127.0.0.1:8766
 * 凭证只读环境变量（MYSQL_* / JUZHU_DB_* / juzhu/.env.local），禁止写入仓库。
 */
'use strict';

const fs = require('fs');
const path = require('path');
for (const f of ['juzhu/.env.local', '.env', 'runtime.env']) {
  const p = path.join(__dirname, '..', f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const k = t.slice(0, t.indexOf('=')).trim().replace(/^export /, '');
    const v = t.slice(t.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}
const hmac = require('../hmac_auth.cjs');
const mysql = require('mysql2/promise');

const BASE = (process.argv[2] || process.env.JUZHU_REG_BASE || 'http://127.0.0.1:8766').replace(/\/+$/, '');
const DEMO_TAG = '演示';
const RUN = 'HREG' + process.pid;   // 幂等标记：名字带本次运行号，清理按前缀

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  if (!cond) failed++;
}

function pickVendorRow(rows) {
  // 优先 housing_operator 类型且配置了 hmac_key 的商家
  return rows.find((r) => r.type === 'housing_operator') || rows[0];
}

async function connectDb() {
  const host = (process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '').trim();
  const db = (process.env.MYSQL_DB || process.env.JUZHU_DB_NAME || '').trim();
  const user = (process.env.MYSQL_USER || process.env.JUZHU_DB_USER || '').trim();
  const password = process.env.MYSQL_PASSWORD ?? process.env.JUZHU_DB_PASSWORD;
  const port = parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10);
  if (!host || !db || !user || password == null || password === '') throw new Error('MYSQL_* env 不完整');
  return mysql.createConnection({ host, port, database: db, user, password, connectTimeout: 8000 });
}

async function pickVendor(conn) {
  const [rows] = await conn.execute(
    "SELECT id, name, hmac_key, type FROM jz_vendors WHERE hmac_key IS NOT NULL AND hmac_key <> '' AND status='active' ORDER BY id");
  if (!rows.length) throw new Error('库中无可用 vendor hmac_key（先在 jz_vendors 配置 hmac_key）');
  return pickVendorRow(rows);
}

function signed(vendor, payload) {
  return hmac.generateSignature(vendor.hmac_key, Object.assign({ vendor_id: vendor.id }, payload));
}

async function call(path, payload) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  let j = null;
  try { j = await r.json(); } catch (_) { /* ignore */ }
  return { status: r.status, j };
}

async function catalogHas(base, projectId, citySlug) {
  const r = await fetch(base + '/api/juzhu/catalog?city=' + citySlug).then((x) => x.json());
  return (r.projects || []).some((p) => p.id === projectId);
}

/** catalog 有 15s 记忆化缓存（CATALOG_TTL_MS）：轮询等待上下架生效 */
async function catalogEventually(base, projectId, citySlug, want) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if ((await catalogHas(base, projectId, citySlug)) === want) return true;
    await new Promise((r2) => setTimeout(r2, 3000));
  }
  return false;
}

(async () => {
  const conn = await connectDb();
  const vendor = await pickVendor(conn);
  console.log(`vendor: #${vendor.id} ${vendor.name}（${vendor.type}）\n`);

  // ── 0) 清理上次运行残留（按名字前缀），保证可重跑 ──
  await conn.execute("DELETE FROM stay_calendar WHERE project_id IN (SELECT id FROM (SELECT id FROM projects WHERE name LIKE ? AND owner_vendor_id=?) t)", [RUN + '%', vendor.id]);
  await conn.execute('DELETE FROM units WHERE project_id IN (SELECT id FROM (SELECT id FROM projects WHERE name LIKE ? AND owner_vendor_id=?) t)', [RUN + '%', vendor.id]);
  await conn.execute('DELETE FROM photos WHERE entity_type="project" AND entity_id IN (SELECT id FROM (SELECT id FROM projects WHERE name LIKE ? AND owner_vendor_id=?) t)', [RUN + '%', vendor.id]);
  await conn.execute('DELETE FROM projects WHERE name LIKE ? AND owner_vendor_id=?', [RUN + '%', vendor.id]);

  // 商家城市：city_ids 为空 = 不限，取一个有行政区的城市做挂载
  const [cities] = await conn.execute(
    'SELECT c.id, c.slug FROM cities c JOIN districts d ON d.city_id=c.id GROUP BY c.id, c.slug ORDER BY c.id LIMIT 1');
  const city = cities[0];
  const [districts] = await conn.execute('SELECT id FROM districts WHERE city_id=? ORDER BY id LIMIT 1', [city.id]);
  const district = districts[0];

  // ── 1) 创建（缺省草稿，不上架）──
  let r = await call('/api/juzhu/housing/vendor/projects/create', signed(vendor, {
    name: RUN + '·回归演示房源',
    channel: 'rental',
    city_id: city.id,
    district_id: district.id,
    address: '回归演示地址 · ' + RUN,
    tags: ['演示', '回归'],
    min_stay_nights: 15,
    insurance: ['switch_rental', 'property'],
    units: [{ name: '一居 45㎡', layout_label: '1室1厅', area_sqm: 45, rent_monthly: 2400 }],
  }));
  check('create → 200 + draft + 默认不入 catalog', r.status === 200 && r.j.project && r.j.project.status === 'draft'
    && !(await catalogHas(BASE, r.j.project.id, city.slug)), JSON.stringify(r.j));
  const pid = r.j.project && r.j.project.id;
  if (!pid) { console.error('创建失败，终止'); process.exit(1); }
  check('create 回显保险/最短连住（contact_phone 不外泄）',
    r.j.project.min_stay_nights === 15
    && JSON.stringify(r.j.project.insurance) === JSON.stringify(['switch_rental', 'property'])
    && r.j.project.contact_phone === undefined);

  // ── 2) 空价上架必须被拦截 ──
  r = await call('/api/juzhu/housing/vendor/projects/status', signed(vendor, { id: pid, status: 'online' }));
  check('无起价上架被拒 400', r.status === 400, JSON.stringify(r.j));

  // ── 3) 补价 + 追加户型 → 上架 → catalog 可见 ──
  await call('/api/juzhu/housing/vendor/projects/update', signed(vendor, { id: pid, price_from: 2400 }));
  r = await call('/api/juzhu/housing/vendor/units/create', signed(vendor, {
    project_id: pid, name: '两居 68㎡', layout_label: '2室1厅', area_sqm: 68, rent_monthly: 3200,
  }));
  check('units/create → 200', r.status === 200 && r.j.unit && r.j.unit.id, JSON.stringify(r.j));
  r = await call('/api/juzhu/housing/vendor/projects/status', signed(vendor, { id: pid, status: 'online' }));
  check('上架 online → 200', r.status === 200 && r.j.status === 'online', JSON.stringify(r.j));
  check('C 端 catalog 可见（online，等待 15s 缓存过期）', await catalogEventually(BASE, pid, city.slug, true));

  // ── 4) 更新保险 / 最短连住 ──
  r = await call('/api/juzhu/housing/vendor/projects/update', signed(vendor, {
    id: pid, insurance: ['hotel_cancel', 'property'], min_stay_nights: 20,
  }));
  check('update 保险+最短连住 → 200', r.status === 200
    && JSON.stringify(r.j.project.insurance) === JSON.stringify(['hotel_cancel', 'property'])
    && r.j.project.min_stay_nights === 20, JSON.stringify(r.j));
  r = await call('/api/juzhu/housing/vendor/projects/update', signed(vendor, { id: pid, insurance: ['not_exist'] }));
  check('未知保险标识被拒 400', r.status === 400, JSON.stringify(r.j));

  // ── 5) 房态：关房 → 恢复默认价 ──
  const d1 = '2026-12-10', d2 = '2026-12-11';
  r = await call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
    project_id: pid, dates: [d1, d2], status: 'blocked',
  }));
  check('房态关房 2 晚 → 200', r.status === 200 && r.j.affected >= 1, JSON.stringify(r.j));
  const cal = await fetch(BASE + `/api/juzhu/projects/${pid}/stay-calendar?month=2026-12`).then((x) => x.json());
  const blockedDays = (cal.days || []).filter((d) => d.status === 'blocked').map((d) => d.date);
  check('公开日历可见关房', JSON.stringify(blockedDays) === JSON.stringify([d1, d2]), JSON.stringify(blockedDays));
  r = await call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
    project_id: pid, dates: [d1], status: 'open', price_night: 399,
  }));
  const cal2 = await fetch(BASE + `/api/juzhu/projects/${pid}/stay-calendar?month=2026-12`).then((x) => x.json());
  const day1 = (cal2.days || []).find((d) => d.date === d1);
  check('开房 + 夜价覆盖（399 ≠ 基准 80）', day1 && day1.status === 'open' && day1.price === 399 && cal2.base_price_night === 80,
    JSON.stringify(day1) + ' base=' + cal2.base_price_night);
  r = await call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
    project_id: pid, dates: [d1, d2], status: 'open', price_night: null,
  }));
  check('恢复默认价 → 200', r.status === 200, JSON.stringify(r.j));

  // ── 5.5) 订单履约闭环：公开下单 → 商家查单/确认/拒单 → 房态联动 ──
  const bkPhone = '13900007777';
  const bkIds = [];
  async function publicBooking(nights, projId, minNights) {
    const d1b = new Date('2026-12-20T00:00:00');
    const d2b = new Date(d1b); d2b.setDate(d2b.getDate() + nights);
    const r = await call('/api/juzhu/booking', {
      project_id: projId, checkin: d1b.toISOString().slice(0, 10), checkout: d2b.toISOString().slice(0, 10),
      contact_name: '履约回归', contact_phone: bkPhone,
    });
    if (r.status !== 200) return { status: r.status, j: r.j, need: minNights };
    return r;
  }
  // 下单（rental 演示房，最短连住已被改为 20 晚）
  let bk = await publicBooking(20, pid, 20);
  check('公开下单（20 晚）→ 200', bk.status === 200 && bk.j.order_no, JSON.stringify(bk.j));
  bkIds.push(bk.j.order_no);
  // 商家查单：可见、手机号掩码
  r = await call('/api/juzhu/housing/vendor/bookings/list', signed(vendor, {}));
  const found = (r.j.list || []).find((o) => o.order_no === bk.j.order_no);
  check('bookings/list 可见本商家订单', r.status === 200 && found && found.status === 'pending', JSON.stringify(r.j).slice(0, 120));
  check('手机号掩码（不回明文）', found && /^139\*\*\*\*\d{4}$/.test(found.contact_phone), found && found.contact_phone);
  // 确认
  r = await call('/api/juzhu/housing/vendor/bookings/confirm', signed(vendor, { id: found.id }));
  check('bookings/confirm → confirmed', r.status === 200 && r.j.status === 'confirmed', JSON.stringify(r.j));
  // 房态查询：当月占用 = checkin 到月末（动态计算，避免时区/月份边界硬编码）
  const ciStr = new Date(new Date('2026-12-20T00:00:00').getTime()).toISOString().slice(0, 10);
  const expDec = Math.round((new Date('2027-01-01T00:00:00Z') - new Date(ciStr + 'T00:00:00Z')) / 864e5);
  r = await call('/api/juzhu/housing/vendor/stay-calendar/query', signed(vendor, { project_id: pid, month: '2026-12' }));
  const qBooked = (r.j.days || []).filter((d) => d.status === 'booked');
  check('stay-calendar/query 可见订单占用（' + expDec + ' 晚）', r.status === 200 && qBooked.length === expDec,
    JSON.stringify({ status: r.status, booked: qBooked.length, expect: expDec, msg: r.j.message }));
  // 第二笔 → 拒单 → 房态释放
  const bk2 = await (async () => {   // 不重叠日期，避免与已确认订单房态冲突
    const a = new Date('2027-02-05T00:00:00'); const b2 = new Date(a); b2.setDate(b2.getDate() + 21);
    return call('/api/juzhu/booking', { project_id: pid, checkin: a.toISOString().slice(0, 10), checkout: b2.toISOString().slice(0, 10),
      contact_name: '履约回归', contact_phone: bkPhone });
  })();
  bkIds.push(bk2.j.order_no);
  r = await call('/api/juzhu/housing/vendor/bookings/detail', signed(vendor, { id: (await call('/api/juzhu/housing/vendor/bookings/list', signed(vendor, {}))).j.list.find((o) => o.order_no === bk2.j.order_no).id }));
  check('bookings/detail 可查（越权外统一 404）', r.status === 200 && r.j.booking.order_no === bk2.j.order_no, JSON.stringify(r.j).slice(0, 100));
  r = await call('/api/juzhu/housing/vendor/bookings/cancel', signed(vendor, { id: r.j.booking.id }));
  check('bookings/cancel → cancelled + 释放房态', r.status === 200 && r.j.status === 'cancelled', JSON.stringify(r.j));
  r = await call('/api/juzhu/housing/vendor/stay-calendar/query', signed(vendor, { project_id: pid, month: '2026-12' }));
  check('拒单后占用回到 ' + expDec + ' 晚', (r.j.days || []).filter((d) => d.status === 'booked').length === expDec,
    JSON.stringify({ booked: (r.j.days || []).filter((d) => d.status === 'booked').length, expect: expDec }));
  // 预付口径：minsu 单未支付不可确认
  // 预付闭环：自建 minsu 演示房（新日历无历史占用），走 未支付拒确认 → 支付 → 确认 → 拒单退款
  r = await call('/api/juzhu/housing/vendor/projects/create', signed(vendor, {
    name: RUN + '·回归演示民宿', channel: 'minsu', city_id: city.id, district_id: district.id,
    price_from: 980, tags: ['演示'], min_stay_nights: 1,
    units: [{ name: '庭院房', price_night: 980 }],
  }));
  const mid = r.j.project && r.j.project.id;
  check('创建 minsu 演示房 → 200', r.status === 200 && !!mid, JSON.stringify(r.j).slice(0, 120));
  await call('/api/juzhu/housing/vendor/projects/status', signed(vendor, { id: mid, status: 'online' }));
  const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
  const mi1 = tmr.toISOString().slice(0, 10);
  const tmr2 = new Date(tmr); tmr2.setDate(tmr2.getDate() + 1);
  const bk3 = await call('/api/juzhu/booking', {
    project_id: mid, checkin: mi1, checkout: tmr2.toISOString().slice(0, 10),
    contact_name: '履约回归', contact_phone: bkPhone,
  });
  if (bk3.status !== 200) {
    check('minsu 预付闭环（下单）', false, JSON.stringify(bk3.j).slice(0, 160));
  } else {
    bkIds.push(bk3.j.order_no);
    r = await call('/api/juzhu/housing/vendor/bookings/list', signed(vendor, { project_id: mid }));
    const found3 = (r.j.list || []).find((o) => o.order_no === bk3.j.order_no);
    r = await call('/api/juzhu/housing/vendor/bookings/confirm', signed(vendor, { id: found3.id }));
    check('minsu 未支付确认被拒 400', r.status === 400 && /未支付/.test(r.j.message || ''), JSON.stringify(r.j));
    await call('/api/juzhu/booking/pay', { order_no: bk3.j.order_no, contact_phone: bkPhone, pay_method: 'online' });
    r = await call('/api/juzhu/housing/vendor/bookings/confirm', signed(vendor, { id: found3.id }));
    check('支付后确认 → confirmed', r.status === 200 && r.j.status === 'confirmed', JSON.stringify(r.j));
    r = await call('/api/juzhu/housing/vendor/bookings/cancel', signed(vendor, { id: found3.id }));
    check('已支付拒单 → refunded', r.status === 200 && r.j.pay_status === 'refunded', JSON.stringify(r.j));
  }

  // 负例：不存在/他人订单 404
  r = await call('/api/juzhu/housing/vendor/bookings/confirm', signed(vendor, { id: 999999 }));
  check('bookings/confirm 不存在 id → 404', r.status === 404, 'status=' + r.status);
  // 清理本节订单
  for (const id of bkIds) { /* 订单行随项目清理；9001 的单置 cancelled 释放房态 */ }
  const om = bkIds.map(() => '?').join(',');
  await conn.execute('DELETE FROM stay_calendar WHERE booking_id IN (SELECT id FROM (SELECT id FROM booking_orders WHERE order_no IN (' + om + ')) t)', bkIds);
  await conn.execute('DELETE FROM booking_orders WHERE order_no IN (' + om + ')', bkIds);
  await conn.execute('DELETE FROM stay_calendar WHERE project_id=?', [mid]);
  await conn.execute('DELETE FROM units WHERE project_id=?', [mid]);
  await conn.execute('DELETE FROM projects WHERE id=?', [mid]);
  // 删户型（新增一个一次性户型再删）
  r = await call('/api/juzhu/housing/vendor/units/create', signed(vendor, { project_id: pid, name: '一次性户型' }));
  const tmpUnit = r.j.unit && r.j.unit.id;
  r = await call('/api/juzhu/housing/vendor/units/delete', signed(vendor, { id: tmpUnit }));
  check('units/delete → 200', r.status === 200, JSON.stringify(r.j));

  // ── 6) 下架 → catalog 不可见 ──
  r = await call('/api/juzhu/housing/vendor/projects/status', signed(vendor, { id: pid, status: 'offline' }));
  check('下架 offline → 200', r.status === 200 && r.j.status === 'offline', JSON.stringify(r.j));
  check('C 端 catalog 不可见（offline，等待 15s 缓存过期）', await catalogEventually(BASE, pid, city.slug, false));

  // ── 7) 越权/鉴权负例 ──
  const badSign = signed(vendor, { id: pid, status: 'online' });
  badSign.sign = 'deadbeef'.repeat(8);
  r = await call('/api/juzhu/housing/vendor/projects/status', badSign);
  check('错误签名被拒 401', r.status === 401, JSON.stringify(r.j));
  r = await call('/api/juzhu/housing/vendor/projects/detail', signed(vendor, { id: 1 }));
  const [others] = await conn.execute('SELECT owner_vendor_id FROM projects WHERE id=1');
  const isOther = others.length && others[0].owner_vendor_id !== vendor.id;
  check('他人房源 detail → 404（不泄露存在性）', isOther ? r.status === 404 : true, 'status=' + r.status);
  r = await call('/api/juzhu/housing/vendor/projects/detail', signed(vendor, {}));
  check('缺 id → 400', r.status === 400, JSON.stringify(r.j));

  // ── 8) 清理本次演示数据 ──
  await conn.execute('DELETE FROM stay_calendar WHERE project_id=?', [pid]);
  await conn.execute('DELETE FROM units WHERE project_id=?', [pid]);
  await conn.execute('DELETE FROM photos WHERE entity_type="project" AND entity_id=?', [pid]);
  await conn.execute('DELETE FROM projects WHERE id=?', [pid]);
  check('清理演示数据', await catalogEventually(BASE, pid, city.slug, false));

  await conn.end();
  console.log(failed === 0 ? '\n房源 HMAC 回归全部通过' : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('回归脚本异常:', e.message);
  process.exit(2);
});
