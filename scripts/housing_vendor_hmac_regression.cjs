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
