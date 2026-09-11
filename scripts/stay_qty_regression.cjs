#!/usr/bin/env node
/**
 * scripts/stay_qty_regression.cjs —— 多间库存回归（口径 2026-09-10，docs/stay-multi-qty-design.md）
 *
 * 自建演示项目（RUN 前缀 + 「演示」tag，结束清理）直连库造数、走公开 HTTP 下单/取消：
 *   房型 total_qty=3：订1→剩2 → 订2→满(booked 派生) → 再订→400 → 逐笔取消回补 → 行清理；
 *   qty 放出间数覆盖 → 超出剩余拒；夜价覆盖在订+取消后保留（旧副作用回归）；
 *   整栋单(unit_id 空) ↔ 房型单互斥；单间房型(total_qty=1) 与旧行为逐字节一致。
 *
 * 用法：node scripts/stay_qty_regression.cjs [base_url]   # 默认 http://127.0.0.1:8766
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
const mysql = require('mysql2/promise');

const BASE = (process.argv[2] || process.env.JUZHU_REG_BASE || 'http://127.0.0.1:8766').replace(/\/+$/, '');
const RUN = 'QTYREG' + process.pid;
const PHONE = '137000' + String(10000 + (process.pid % 89999)).slice(0, 5);

let failed = 0, passed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  cond ? passed++ : failed++;
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

async function api(p, body, method) {
  const r = await fetch(BASE + p, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  let j = null;
  try { j = await r.json(); } catch (_) { /* ignore */ }
  return { status: r.status, j };
}
const book = (b) => api('/api/juzhu/booking', b);
const cancel = (orderNo) => api('/api/juzhu/booking/cancel', { order_no: orderNo, contact_phone: PHONE });
const calendar = async (month, unitId) => {
  const r = await fetch(`${BASE}/api/juzhu/projects/${seed.pid}/stay-calendar?month=${month}${unitId ? '&unit_id=' + unitId : ''}`);
  return r.json();
};

const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const dayN = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const NOW = new Date().toISOString().slice(0, 19).replace('T', ' ');

let seed = {};

async function seedProject(conn) {
  const [[city]] = await conn.execute('SELECT id FROM cities ORDER BY id LIMIT 1');
  const [[district]] = await conn.execute('SELECT id FROM districts WHERE city_id=? ORDER BY id LIMIT 1', [city.id]);
  const [ins] = await conn.execute(
    `INSERT INTO projects(city_id, district_id, channel, name, slug, address, tags, sort_order, unit_count,
       price_from, rating_status, status, owner_vendor_id, ext)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'passed', 'online', 153, ?)`,
    [city.id, district.id, 'rental', RUN + '·多间回归房', 'qty-reg-' + process.pid, '回归测试地址',
      JSON.stringify(['演示']), 99, 2, 3000,
      JSON.stringify({ stay_bookable: true, min_stay_nights: 1, insurance: ['property'] })]);
  const pid = ins.insertId;
  const mkUnit = async (name, slug, qty) => {
    const [u] = await conn.execute(
      `INSERT INTO units(project_id, name, slug, rent_monthly, total_qty, sort_order, ext)
       VALUES (?,?,?,?,?,?,?)`,
      // cancel_policy 必配：缺省从严 = 不可取消（规则 16），回归要验证取消回补须开窗
      [pid, name, slug, 3000, qty, slug === 'ua' ? 1 : 2,
        JSON.stringify({ cancel_policy: { enabled: true, days_before: 1, cutoff_time: '00:00' } })]);
    return u.insertId;
  };
  const ua = await mkUnit('山景套房', 'ua', 3);   // 多间：3 间
  const ub = await mkUnit('单间标房', 'ub', 1);   // 单间：旧行为兼容
  seed = { pid, ua, ub };
  return seed;
}

async function cleanup(conn) {
  await conn.execute("DELETE FROM stay_calendar WHERE project_id IN (SELECT id FROM (SELECT id FROM projects WHERE name LIKE ?) t)", [RUN + '%']);
  await conn.execute('DELETE FROM booking_orders WHERE project_id IN (SELECT id FROM (SELECT id FROM projects WHERE name LIKE ?) t)', [RUN + '%']);
  await conn.execute('DELETE FROM units WHERE project_id IN (SELECT id FROM (SELECT id FROM projects WHERE name LIKE ?) t)', [RUN + '%']);
  await conn.execute('DELETE FROM projects WHERE name LIKE ?', [RUN + '%']);
}

(async () => {
  const conn = await connectDb();
  await cleanup(conn);
  await seedProject(conn);
  const pid = seed.pid;
  console.log(`seed: project #${pid} · unit A(3间) #${seed.ua} · unit B(1间) #${seed.ub}\n`);

  const ci1 = iso(dayN(10)), ci2 = iso(dayN(12));           // 窗口1：+10 → +12（2 晚）
  const mk1 = ci1.slice(0, 7);
  const calA = () => calendar(mk1, seed.ua);

  // ── 1) 多间顺序订满 ──
  let r = await book({ project_id: pid, unit_id: seed.ua, rooms: 1, checkin: ci1, checkout: ci2, contact_name: '多间回归', contact_phone: PHONE });
  check('订 1 间 → 200 且回显 rooms=1', r.status === 200 && r.j.rooms === 1, JSON.stringify(r.j));
  const ord1 = r.j.order_no;
  let cal = await calA();
  let d1 = (cal.days || []).find((x) => x.date === ci1);
  check('订 1 后 remaining=2 / booked_qty=1 / 仍 open', d1 && d1.remaining === 2 && Number(d1.booked_qty) === 1 && d1.status === 'open', JSON.stringify(d1));

  r = await book({ project_id: pid, unit_id: seed.ua, rooms: 2, checkin: ci1, checkout: ci2, contact_name: '多间回归', contact_phone: PHONE });
  check('再订 2 间 → 200（rooms=2，价 ×2）', r.status === 200 && r.j.rooms === 2, JSON.stringify(r.j));
  const ord2 = r.j.order_no;
  cal = await calA();
  d1 = (cal.days || []).find((x) => x.date === ci1);
  check('订满后派生 booked（remaining=0）', d1 && d1.status === 'booked' && d1.remaining === 0 && Number(d1.booked_qty) === 3, JSON.stringify(d1));

  r = await book({ project_id: pid, unit_id: seed.ua, rooms: 1, checkin: ci1, checkout: ci2, contact_name: '多间回归', contact_phone: PHONE });
  check('满房后再订 → 400 + conflict_date', r.status === 400 && r.j.conflict_date === ci1, JSON.stringify(r.j));

  // ── 2) 逐笔取消回补 ──
  r = await cancel(ord1);
  check('取消第 1 单 → 200', r.status === 200, JSON.stringify(r.j));
  cal = await calA();
  d1 = (cal.days || []).find((x) => x.date === ci1);
  check('取消后 remaining 回补 = 1（3 − 已订 2）', d1 && d1.remaining === 1 && d1.status === 'open', JSON.stringify(d1));
  r = await cancel(ord2);
  check('取消第 2 单 → 200', r.status === 200, JSON.stringify(r.j));
  const [left] = await conn.execute('SELECT COUNT(*) c FROM stay_calendar WHERE project_id=? AND unit_id=?', [pid, seed.ua]);
  check('全取消后纯占用行清空（0 行）', left[0].c === 0, 'rows=' + left[0].c);

  // ── 3) qty 放出间数覆盖 + 夜价保留 ──
  await conn.execute(
    "INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, qty, price_night, source, updated_at) VALUES (?,?,?,'open',1,777,'vendor',?)",
    [pid, seed.ua, ci1, NOW]);
  r = await book({ project_id: pid, unit_id: seed.ua, rooms: 2, checkin: ci1, checkout: iso(dayN(11)), contact_name: '多间回归', contact_phone: PHONE });
  check('qty=1 时订 2 间 → 400（超出剩余）', r.status === 400, JSON.stringify(r.j));
  r = await book({ project_id: pid, unit_id: seed.ua, rooms: 1, checkin: ci1, checkout: iso(dayN(11)), contact_name: '多间回归', contact_phone: PHONE });
  check('qty=1 时订 1 间 → 200 且按覆盖价 777 计价', r.status === 200 && r.j.price_total === 777, JSON.stringify(r.j));
  const ord3 = r.j.order_no;
  await cancel(ord3);
  const [keep] = await conn.execute('SELECT qty, price_night, status, booked_qty FROM stay_calendar WHERE project_id=? AND unit_id=? AND stay_date=?', [pid, seed.ua, ci1]);
  check('取消后商家 qty/夜价差异行保留（price_night=777）', keep.length === 1 && Number(keep[0].price_night) === 777 && Number(keep[0].qty) === 1 && Number(keep[0].booked_qty) === 0,
    JSON.stringify(keep));

  // ── 4) 整栋 ↔ 房型互斥 ──
  const wi1 = iso(dayN(20)), wi2 = iso(dayN(21));
  r = await book({ project_id: pid, unit_id: seed.ua, rooms: 1, checkin: wi1, checkout: wi2, contact_name: '多间回归', contact_phone: PHONE });
  check('窗口2 房型单订 1 间 → 200', r.status === 200, JSON.stringify(r.j));
  const ordW = r.j.order_no;
  r = await book({ project_id: pid, unit_id: null, checkin: wi1, checkout: wi2, contact_name: '多间回归', contact_phone: PHONE });
  check('整栋单遇任一房型被占 → 400', r.status === 400, JSON.stringify(r.j));
  await cancel(ordW);
  r = await book({ project_id: pid, unit_id: null, checkin: wi1, checkout: wi2, contact_name: '多间回归', contact_phone: PHONE });
  check('清空后整栋单 → 200（占 unit_id=0 行）', r.status === 200, JSON.stringify(r.j));
  const ordWH = r.j.order_no;
  r = await book({ project_id: pid, unit_id: seed.ua, checkin: wi1, checkout: wi2, contact_name: '多间回归', contact_phone: PHONE });
  check('整栋被订后房型单 → 400', r.status === 400, JSON.stringify(r.j));
  await cancel(ordWH);

  // ── 5) 单间房型 = 旧行为（total_qty=1 全兼容）──
  r = await book({ project_id: pid, unit_id: seed.ub, rooms: 2, checkin: ci1, checkout: ci2, contact_name: '多间回归', contact_phone: PHONE });
  check('单间房型订 2 间 → 400（超总间数）', r.status === 400, JSON.stringify(r.j));
  r = await book({ project_id: pid, unit_id: seed.ub, checkin: ci1, checkout: ci2, contact_name: '多间回归', contact_phone: PHONE });
  check('单间房型订 1 间 → 200', r.status === 200, JSON.stringify(r.j));
  const ordB = r.j.order_no;
  r = await book({ project_id: pid, unit_id: seed.ub, checkin: ci1, checkout: ci2, contact_name: '多间回归', contact_phone: PHONE });
  check('单间订满再订 → 400（同旧「已被预订」语义）', r.status === 400, JSON.stringify(r.j));
  cal = await calendar(mk1, seed.ub);
  d1 = (cal.days || []).find((x) => x.date === ci1);
  check('单间订满日历 = booked / remaining=0', d1 && d1.status === 'booked' && d1.remaining === 0, JSON.stringify(d1));
  await cancel(ordB);

  // ── 清理 ──
  await cleanup(conn);
  await conn.end();
  console.log(`\n${passed}/${passed + failed} 通过`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
