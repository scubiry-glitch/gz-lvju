#!/usr/bin/env node
/**
 * scripts/housing_vendor_hmac_regression.cjs —— 房源开放接口 HMAC 全生命周期回归
 *
 * 走完整 HTTP 签名链路（vendor_id + timestamp + sign，密钥取库内 jz_vendors.hmac_key）：
 *   创建(草稿) → 补户型 → 上架前置拦截 → 评级提审/状态开放端点 → 设价后上架 → C 端 catalog 可见 →
 *   更新(保险/最短连住) → 房态关房/开房/夜价 → 下单逐晚计价（覆盖价参与合计） → 下架 → 越权负例 → 清理
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
const http = require('http');

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

  // ── Webhook 接收器：记录收到的签名事件，可按脚本要求返回 500 触发重试 ──
  const hits = [];
  const failFirst = new Set();       // 事件名集合：首次投递故意 500，验证重试
  const hook = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw || '{}'); } catch (_) {}
      hits.push(body);
      const key = body && body.event;
      if (key && failFirst.has(key) && !failFirst[key + '_done']) {
        failFirst[key + '_done'] = true;
        res.writeHead(500); res.end('flaky'); return;
      }
      res.writeHead(200); res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  const [origHook] = await conn.execute('SELECT webhook_url FROM jz_vendors WHERE id=?', [vendor.id]);
  await conn.execute('UPDATE jz_vendors SET webhook_url=? WHERE id=?', ['http://127.0.0.1:' + hookPort + '/hook', vendor.id]);
  // 服务端推送前直读商家 webhook_url（不走进程缓存）：配置即时生效，无需重启
  const waitForWebhook = async (event, timeoutMs) => {
    const deadline = Date.now() + (timeoutMs || 30000);
    while (Date.now() < deadline) {
      const hit = hits.find((h) => h && h.event === event);
      if (hit) return hit;
      await new Promise((r2) => setTimeout(r2, 300));
    }
    return null;
  };

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

  // ── 0.5) 城市/行政区枚举（city_id / district_id 选值主数据）──
  let r;
  r = await call('/api/juzhu/housing/vendor/regions/list', signed(vendor, {}));
  const rg = (r.j.list || []).find((c) => c.id === city.id);
  check('regions/list → 200 + 含挂载城市', r.status === 200 && !!rg, JSON.stringify(r.j).slice(0, 160));
  check('regions/list 城市下含行政区（district_id 可选值）', rg && (rg.districts || []).some((d) => d.id === district.id),
    rg && JSON.stringify(rg.districts).slice(0, 160));

  // ── 1) 创建（缺省草稿，不上架）──
  r = await call('/api/juzhu/housing/vendor/projects/create', signed(vendor, {
    name: RUN + '·回归演示房源',
    channel: 'rental',
    city_id: city.id,
    district_id: district.id,
    address: '回归演示地址 · ' + RUN,
    tags: ['演示', '回归'],
    min_stay_nights: 15,
    insurance: ['switch_rental', 'property'],
    online_booking: true, online_payment: false,
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

  // ── 2.5) 评级提审 / 审核状态（开放端点闭环；平台复核本身在管理台，脚本以 DB 置 passed 模拟复核结果）──
  r = await call('/api/juzhu/housing/vendor/projects/rating/submit', signed(vendor, {
    id: pid, dims: { comfort: 4.5, green: 4, tech: 9, safety: 4.5 },
  }));
  check('评级提审：越界维度被拒 400', r.status === 400, JSON.stringify(r.j));
  r = await call('/api/juzhu/housing/vendor/projects/rating/submit', signed(vendor, {
    id: pid, dims: { comfort: 4.5, green: 4, tech: 4.6, safety: 4.4 },
  }));
  check('评级提审 → 200 + pending + 评级编号', r.status === 200 && r.j.rating_status === 'pending'
    && /^SY-RENT-\d+$/.test(r.j.rating_code || ''), JSON.stringify(r.j));
  r = await call('/api/juzhu/housing/vendor/projects/rating/submit', signed(vendor, {
    id: pid, dims: { comfort: 4.5, green: 4, tech: 4.6, safety: 4.4 },
  }));
  check('pending 中重复提审被拒 400', r.status === 400 && /复核队列/.test(r.j.message || ''), JSON.stringify(r.j));
  r = await call('/api/juzhu/housing/vendor/projects/rating/status', signed(vendor, { id: pid }));
  check('rating/status → pending + 自评分回读', r.status === 200 && r.j.rating_status === 'pending'
    && r.j.dims && r.j.dims.comfort === 4.5 && (r.j.dims_meta || []).length === 4, JSON.stringify(r.j).slice(0, 200));
  // 平台复核（管理台 POST /admin/ratings/:code/review）在本脚本里以 DB 置位模拟
  await conn.execute("UPDATE projects SET rating_status='passed' WHERE id=?", [pid]);
  for (let i = 0; i < 8; i++) {
    r = await call('/api/juzhu/housing/vendor/photos/add', signed(vendor, {
      project_id: pid, file_path: `https://cdn.example.test/${RUN}-${i}.jpg`, is_cover: i === 0,
    }));
    check(`登记房源图片 ${i + 1}/8`, r.status === 200, JSON.stringify(r.j));
  }

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
  // 逐晚计价：给前两晚（12-20/12-21）设项目级覆盖价 399，其余 18 晚回落默认 80（2400/30）
  r = await call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
    project_id: pid, dates: ['2026-12-20', '2026-12-21'], status: 'open', price_night: 399,
  }));
  check('下单前设夜价覆盖 2 晚 → 200', r.status === 200, JSON.stringify(r.j));
  let bk = await publicBooking(20, pid, 20);
  check('公开下单（20 晚）→ 200', bk.status === 200 && bk.j.order_no, JSON.stringify(bk.j));
  bkIds.push(bk.j.order_no);
  check('下单逐晚计价：2 晚覆盖 399 + 18 晚默认 80 = 2238', bk.status === 200 && bk.j.price_total === 2238,
    'price_total=' + (bk.j && bk.j.price_total) + '（旧口径应为 80×20=1600）');
  // 商家查单：可见、手机号掩码
  r = await call('/api/juzhu/housing/vendor/bookings/list', signed(vendor, {}));
  const found = (r.j.list || []).find((o) => o.order_no === bk.j.order_no);
  check('bookings/list 可见本商家订单', r.status === 200 && found && found.status === 'pending', JSON.stringify(r.j).slice(0, 120));
  check('手机号掩码（不回明文）', found && /^139\*\*\*\*\d{4}$/.test(found.contact_phone), found && found.contact_phone);
  check('商家查单价格快照 = 逐晚合计 2238', found && Number(found.price_total) === 2238, found && found.price_total);
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
    price_from: 980, tags: ['演示'], min_stay_nights: 15, online_booking: false, online_payment: true,
    units: [{ name: '庭院房', price_night: 980, total_qty: 2 }],   // 多间库存：2 间（2026-09-10）
  }));
  const mid = r.j.project && r.j.project.id;
  check('创建 minsu 演示房 → 200', r.status === 200 && !!mid, JSON.stringify(r.j).slice(0, 120));
  if (mid) {
    // 房源评级由平台审核接口维护（rental 演示房已在 §2.5 走过 rating/submit 端点闭环）；
    // 此处只把演示房置为已通过，不绕过上架接口。
    await conn.execute("UPDATE projects SET rating_status='passed' WHERE id=?", [mid]);
    for (let i = 0; i < 8; i++) {
      r = await call('/api/juzhu/housing/vendor/photos/add', signed(vendor, {
        project_id: mid, file_path: `https://cdn.example.test/${RUN}-minsu-${i}.jpg`, is_cover: i === 0,
      }));
      check(`登记民宿图片 ${i + 1}/8`, r.status === 200, JSON.stringify(r.j));
    }
    await call('/api/juzhu/housing/vendor/projects/status', signed(vendor, { id: mid, status: 'online' }));
    // 客户免费取消窗口（房型级，2026-09-09 口径）：给演示房型配「入住当天 23:59 前」，
    // 后续客户取消用例在任何时刻运行都落在窗口内；整栋单按项目首个房型政策回退。
    const [mu] = await conn.execute('SELECT id FROM units WHERE project_id=? ORDER BY sort_order, id LIMIT 1', [mid]);
    if (mu.length) {
      r = await call('/api/juzhu/housing/vendor/units/update', signed(vendor, {
        id: mu[0].id, cancel_policy: { enabled: true, days_before: 0, cutoff_time: '23:59' },
      }));
      check('units/update 配置免费取消窗口 → 200', r.status === 200, JSON.stringify(r.j));
    }
  }
  const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
  const mi1 = tmr.toISOString().slice(0, 10);
  const tmr2 = new Date(tmr); tmr2.setDate(tmr2.getDate() + 15);
  const bk3 = await call('/api/juzhu/booking', {
    project_id: mid, checkin: mi1, checkout: tmr2.toISOString().slice(0, 10),
    contact_name: '履约回归', contact_phone: bkPhone,
  });
  if (bk3.status !== 200) {
    check('在线支付闭环（下单）', false, JSON.stringify(bk3.j).slice(0, 160));
  } else {
    bkIds.push(bk3.j.order_no);
    r = await call('/api/juzhu/housing/vendor/bookings/list', signed(vendor, { project_id: mid }));
    const found3 = (r.j.list || []).find((o) => o.order_no === bk3.j.order_no);
    if (!found3) {
      check('minsu 订单可被商家查到', false, 'booking not found');
    } else {
      r = await call('/api/juzhu/housing/vendor/bookings/confirm', signed(vendor, { id: found3.id }));
      check('minsu 未支付确认被拒 400', r.status === 400 && /未支付/.test(r.j.message || ''), JSON.stringify(r.j));
      await call('/api/juzhu/booking/pay', { order_no: bk3.j.order_no, contact_phone: bkPhone, pay_method: 'online' });
      r = await call('/api/juzhu/housing/vendor/bookings/confirm', signed(vendor, { id: found3.id }));
      check('支付后确认 → confirmed', r.status === 200 && r.j.status === 'confirmed', JSON.stringify(r.j));
      r = await call('/api/juzhu/housing/vendor/bookings/cancel', signed(vendor, { id: found3.id }));
      check('已支付拒单 → refunded', r.status === 200 && r.j.pay_status === 'refunded', JSON.stringify(r.j));
    }
  }

  // ── 5.7) 多间库存（2026-09-10）：total_qty=2 房型 → 剩余下发 / qty 覆盖 / 满房派生 booked / 释放回补 ──
  // 注意查询口径：带 unit_id 才是房型视角（放出 = total_qty）；不带 = 整栋项目级（容量恒 1）
  const [mu5] = await conn.execute('SELECT id FROM units WHERE project_id=? ORDER BY sort_order, id LIMIT 1', [mid]);
  const muId5 = mu5.length ? mu5[0].id : null;
  const mkT = mi1.slice(0, 7);
  const qUnitDay = async () => {
    const res = await call('/api/juzhu/housing/vendor/stay-calendar/query', signed(vendor, { project_id: mid, unit_id: muId5, month: mkT }));
    return ((res.j || {}).days || []).find((d) => d.date === mi1) || null;
  };
  // 前序 bk3（整栋单）已被商家拒单释放：unit 视角放出间数 = 总间数 2
  const dAfterRel = await qUnitDay();
  check('拒单释放后 remaining 回补 = 2（总间数）', dAfterRel && dAfterRel.remaining === 2 && dAfterRel.qty === 2 && dAfterRel.status === 'open',
    JSON.stringify(dAfterRel));
  r = await call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
    project_id: mid, unit_id: muId5, dates: [mi1], status: 'open', qty: 1,
  }));
  check('设放出间数 qty=1 → 200', r.status === 200, JSON.stringify(r.j));
  const dQty = await qUnitDay();
  check('qty 覆盖生效：remaining=1 / qty=1', dQty && dQty.remaining === 1 && dQty.qty === 1, JSON.stringify(dQty));
  r = await call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
    project_id: mid, unit_id: muId5, dates: [mi1], status: 'open', qty: 0,
  }));
  check('qty=0 → 400（须为 1-999）', r.status === 400, JSON.stringify(r.j));
  r = await call('/api/juzhu/housing/vendor/units/update', signed(vendor, { id: muId5, total_qty: 0 }));
  check('units/update total_qty=0 → 400', r.status === 400, JSON.stringify(r.j));
  // qty=1 下：订 2 间被拒（超出剩余），订 1 间成功（价 = 夜价 980 × 15 晚 × 1 间）
  const bk5 = await call('/api/juzhu/booking', {
    project_id: mid, unit_id: muId5, rooms: 2, checkin: mi1, checkout: tmr2.toISOString().slice(0, 10),
    contact_name: '多间回归', contact_phone: bkPhone,
  });
  check('qty=1 时订 2 间 → 400（超出剩余）', bk5.status === 400 && bk5.j.remaining === 1, JSON.stringify(bk5.j));
  const bk5b = await call('/api/juzhu/booking', {
    project_id: mid, unit_id: muId5, rooms: 1, checkin: mi1, checkout: tmr2.toISOString().slice(0, 10),
    contact_name: '多间回归', contact_phone: bkPhone,
  });
  check('qty=1 下订 1 间 → 200（price=980×15 晚×1 间）', bk5b.status === 200 && bk5b.j.rooms === 1 && bk5b.j.price_total === 14700,
    JSON.stringify(bk5b.j));
  if (bk5b.status === 200) {
    bkIds.push(bk5b.j.order_no);
    const dFull = await qUnitDay();
    check('订满后派生 booked（remaining=0 / booked_qty=1）', dFull && dFull.status === 'booked' && dFull.remaining === 0 && Number(dFull.booked_qty) === 1,
      JSON.stringify(dFull));
    const bk6 = await call('/api/juzhu/booking', {
      project_id: mid, unit_id: muId5, checkin: mi1, checkout: tmr2.toISOString().slice(0, 10),
      contact_name: '多间回归', contact_phone: bkPhone,
    });
    check('满房后再订 1 间 → 400', bk6.status === 400, JSON.stringify(bk6.j));
    const lv = await call('/api/juzhu/housing/vendor/bookings/list', signed(vendor, { project_id: mid }));
    const found5 = (lv.j.list || []).find((o) => o.order_no === bk5b.j.order_no);
    r = await call('/api/juzhu/housing/vendor/bookings/cancel', signed(vendor, { id: found5.id }));
    check('商家取消多间单 → cancelled', r.status === 200, JSON.stringify(r.j));
    const dRel = await qUnitDay();
    check('取消后 booked_qty 归零回 open（qty=1 覆盖保留）', dRel && dRel.status === 'open' && Number(dRel.booked_qty) === 0 && dRel.remaining === 1 && dRel.qty === 1,
      JSON.stringify(dRel));
  }
  // 恢复默认（清 qty 覆盖）：纯差异行删行 → 回落总间数
  r = await call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
    project_id: mid, unit_id: muId5, dates: [mi1], status: 'open',
  }));
  check('恢复默认（清 qty 覆盖）→ 200', r.status === 200, JSON.stringify(r.j));
  const dClr = await qUnitDay();
  check('恢复默认后 remaining=2（总间数）', dClr && dClr.remaining === 2 && dClr.qty === 2, JSON.stringify(dClr));

  // 客户侧取消一笔（webhook 的 cancelled 由客户动作触发；商家自己拒单不推给自己）
  const bk4 = await call('/api/juzhu/booking', {
    project_id: mid, checkin: mi1, checkout: tmr2.toISOString().slice(0, 10),
    contact_name: '履约回归', contact_phone: bkPhone,
  });
  check('客户再下一单（用于取消事件）', bk4.status === 200, JSON.stringify(bk4.j));
  if (bk4.status === 200 && bk4.j && bk4.j.order_no) {
    bkIds.push(bk4.j.order_no);
    // 让本次取消事件首次投递返回 500，验证 webhook 重试链路。
    failFirst.add('booking.cancelled');
    await call('/api/juzhu/booking/cancel', { order_no: bk4.j.order_no, contact_phone: bkPhone });
  }

  // ── 5.9) 价格与连住口径（2026-09）：户型级夜价生效 / price_from 选填 / 最短连住下放户型 ──
  // 改动 1：rental 的 units.ext.price_night 从「收下不生效」变为最高优先（> 月租/30 > 起价/30）
  // 改动 2：price_from 改选填，上架闸换成「每个户型都能算出默认夜价 > 0」；展示价三件套随接口下发
  // 改动 3：最短连住下放户型（户型 > 房源 > 频道默认），整栋单按排序最前户型
  // 建一个「可直接上架」的房源（评级置 passed + 8 张图）：§5.9 / §5.10 共用
  const mkPublishable = async (name, units, tags, projExtra) => {
    const cr = await call('/api/juzhu/housing/vendor/projects/create', signed(vendor, {
      name, channel: 'rental', city_id: city.id, district_id: district.id,
      address: '回归演示地址 · ' + name, tags: tags || ['演示', '回归'], online_booking: true, units,
      ...(projExtra || {}),
    }));
    const id = cr.j.project && cr.j.project.id;
    if (!id) return { id: 0, cr };
    await conn.execute("UPDATE projects SET rating_status='passed' WHERE id=?", [id]);
    for (let i = 0; i < 8; i++) {
      await call('/api/juzhu/housing/vendor/photos/add', signed(vendor, {
        project_id: id, file_path: `https://cdn.example.test/${name}-${i}.jpg`, is_cover: i === 0,
      }));
    }
    return { id, cr };
  };

  let pid2 = 0;
  let pidNoPrice = 0;    // §9-1 的「无价房源」也要清（曾经漏删，攒了一堆残留）
  {
    // 9-1) 无 price_from 且户型无价 → 上架仍被拒（价格闸改为逐户型校验，不是放弃校验）
    const noPrice = await mkPublishable(RUN + '·无价房源', [{ name: '未定价户型', layout_label: '1室1厅', area_sqm: 40 }]);
    pidNoPrice = noPrice.id;
    r = await call('/api/juzhu/housing/vendor/projects/status', signed(vendor, { id: noPrice.id, status: 'online' }));
    check('9-1 户型无价且无起价 → 上架被拒 400', r.status === 400 && /价格/.test(r.j.message || ''), JSON.stringify(r.j));

    // 9-2) 不传 price_from、户型带 price_night → 可上架；展示价按晚下发（非起价折算）
    // 带「旅居」tag = C 端按晚展示口径（A″）；不带则按月，展示价会走起价/月度折算
    const okP = await mkPublishable(RUN + '·夜价房源', [
      { name: '庭院房', layout_label: '1室1卫', area_sqm: 30, price_night: 268, min_stay_nights: 3 },
    ], ['演示', '回归', '旅居']);
    pid2 = okP.id;
    check('9-2 price_from 选填：不传也能创建 + 回显展示价三件套',
      okP.cr.j.project.price_from == null && okP.cr.j.project.price_unit === 'night'
      && okP.cr.j.project.price_from_display === 268,
      JSON.stringify(okP.cr.j.project).slice(0, 200));
    r = await call('/api/juzhu/housing/vendor/projects/status', signed(vendor, { id: pid2, status: 'online' }));
    check('9-2b 每户型有价即可上架', r.status === 200 && r.j.status === 'online', JSON.stringify(r.j));
    r = await call('/api/juzhu/housing/vendor/projects/detail', signed(vendor, { id: pid2 }));
    check('9-2c 详情下发户型生效夜价 + 户型级最短连住',
      r.status === 200 && r.j.units[0].default_night_price === 268 && r.j.units[0].min_stay_nights === 3,
      JSON.stringify(r.j.units[0]).slice(0, 200));
    r = await call('/api/juzhu/housing/vendor/projects/list', signed(vendor, { channel: 'rental' }));
    const listed = (r.j.list || []).filter((x) => x.id === pid2)[0];
    check('9-2d 列表出参带展示价（C 端卡片同口径）',
      !!listed && listed.price_unit === 'night' && listed.price_from_display === 268,
      JSON.stringify(listed || {}).slice(0, 200));

    // 9-3) 户型级最短连住生效：1 晚被拒、3 晚放行；且计价用 price_night（改动 1）
    const p2a = '2027-01-10', p2b = '2027-01-11', p2c = '2027-01-12', p2d = '2027-01-13';
    const u2 = (await call('/api/juzhu/housing/vendor/projects/detail', signed(vendor, { id: pid2 }))).j.units[0].id;
    let b = await call('/api/juzhu/booking', {
      project_id: pid2, unit_id: u2, checkin: p2a, checkout: p2b,
      contact_name: '口径回归', contact_phone: bkPhone,
    });
    check('9-3 户型级最短连住 3 晚 → 1 晚被拒 400', b.status === 400 && b.j.min_stay_nights === 3, JSON.stringify(b.j));
    b = await call('/api/juzhu/booking', {
      project_id: pid2, unit_id: u2, checkin: p2a, checkout: p2d,
      contact_name: '口径回归', contact_phone: bkPhone,
    });
    check('9-3b 3 晚放行且按 ext.price_night 计价（268×3=804，旧口径会用 0）',
      b.status === 200 && b.j.price_total === 804, JSON.stringify(b.j));
    if (b.status === 200 && b.j.order_no) bkIds.push(b.j.order_no);

    // 9-4) 整栋单（不传 unit_id）：连住取排序最前户型、价格无起价时同样回落该户型
    const w1 = '2027-02-10', w2 = '2027-02-13';
    const bw = await call('/api/juzhu/booking', {
      project_id: pid2, checkin: w1, checkout: w2, contact_name: '口径回归', contact_phone: bkPhone,
    });
    check('9-4 整栋单回落首个户型：连住 3 晚放行 + 单价 268×3=804',
      bw.status === 200 && bw.j.price_total === 804, JSON.stringify(bw.j).slice(0, 200));
    const bwShort = await call('/api/juzhu/booking', {
      project_id: pid2, checkin: w1, checkout: '2027-02-11', contact_name: '口径回归', contact_phone: bkPhone,
    });
    check('9-4b 整栋单同样受「首个户型 3 晚」约束', bwShort.status === 400 && bwShort.j.min_stay_nights === 3, JSON.stringify(bwShort.j));
    if (bw.status === 200 && bw.j.order_no) bkIds.push(bw.j.order_no);

    // 9-5) 户型级最短连住可清除（回落房源级/频道默认），非法值被拒
    r = await call('/api/juzhu/housing/vendor/units/update', signed(vendor, { id: u2, min_stay_nights: 0 }));
    check('9-5 户型级最短连住越界被拒 400', r.status === 400, JSON.stringify(r.j));
    r = await call('/api/juzhu/housing/vendor/units/update', signed(vendor, { id: u2, min_stay_nights: null }));
    check('9-5b 清除户型级 → 回落频道默认 15 晚',
      r.status === 200 && r.j.unit.min_stay_nights === 15, JSON.stringify(r.j.unit).slice(0, 160));
  }

  // ── 5.10) 净可售与默认关房（2026-09 方案 B）：available_qty 基线口径 + 未推送晚默认关房 ──
  // 场景取自商家反馈：总量 6，平台已售 2、他渠道 1、不可售 1 → 商家推「可售 2」，
  // 平台侧应显示剩余 2（不再二次扣平台自己的 2），平台之后卖掉的才从这 2 里扣。
  let pid3 = 0;
  {
    const p = await mkPublishable(RUN + '·净可售房源', [
      // min_stay_nights=1：本段聚焦库存口径，先绕开连住闸
      { name: '六间房型', layout_label: '1室1卫', area_sqm: 30, price_night: 300, total_qty: 6, min_stay_nights: 1 },
    ], ['演示', '回归', '旅居']);
    pid3 = p.id;
    r = await call('/api/juzhu/housing/vendor/projects/status', signed(vendor, { id: pid3, status: 'online' }));
    check('10-0 净可售用例房源上架', r.status === 200, JSON.stringify(r.j));
    const u3 = (await call('/api/juzhu/housing/vendor/projects/detail', signed(vendor, { id: pid3 }))).j.units[0].id;
    // 开免费取消（本段要验「取消后释放回净可售」；默认未开通 = 客户不可取消）
    await call('/api/juzhu/housing/vendor/units/update', signed(vendor, {
      id: u3, cancel_policy: { enabled: true, days_before: 30, cutoff_time: '18:00' },
    }));
    const dA = '2027-03-10', dB = '2027-03-11', dC = '2027-03-12', dD = '2027-03-13';
    const dayOf = async (d) => {
      const q = await call('/api/juzhu/housing/vendor/stay-calendar/query', signed(vendor, { project_id: pid3, unit_id: u3, month: '2027-03' }));
      return (q.j.days || []).filter((x) => x.date === d)[0] || null;
    };
    const avail = (d, n) => call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
      project_id: pid3, unit_id: u3, dates: [d], status: 'open', available_qty: n,
    }));

    // 平台先卖 2 间（建立 booked_qty=2 的既成事实）
    const bookMulti = await call('/api/juzhu/booking', {
      project_id: pid3, unit_id: u3, rooms: 2, checkin: dA, checkout: dB,
      contact_name: '净可售回归', contact_phone: bkPhone,
    });
    check('10-1 平台先订 2 间', bookMulti.status === 200 && bookMulti.j.rooms === 2, JSON.stringify(bookMulti.j).slice(0, 160));
    if (bookMulti.status === 200 && bookMulti.j.order_no) bkIds.push(bookMulti.j.order_no);

    // 商家推「净可售 2」→ 基线 = 当前已订 2 → 平台剩余应为 2（旧口径会算成 0）
    r = await avail(dA, 2);
    check('10-2 available_qty 推送回显（基线=推送时已订）',
      r.status === 200 && r.j.days[0].qty === 2 && r.j.days[0].qty_base === 2 && r.j.days[0].remaining === 2,
      JSON.stringify(r.j.days && r.j.days[0]));
    let day = await dayOf(dA);
    check('10-2b 日历 remaining = 2（不再二次扣平台已订）', day && day.remaining === 2 && day.available_qty === 2,
      JSON.stringify(day));

    // 平台再卖 1 间 → 从这 2 里扣
    const book1 = await call('/api/juzhu/booking', {
      project_id: pid3, unit_id: u3, checkin: dA, checkout: dB, contact_name: '净可售回归', contact_phone: bkPhone,
    });
    check('10-3 平台再订 1 间', book1.status === 200, JSON.stringify(book1.j).slice(0, 160));
    if (book1.status === 200 && book1.j.order_no) bkIds.push(book1.j.order_no);
    day = await dayOf(dA);
    check('10-3b 剩余 2 → 1（平台占用从净可售里扣）', day && day.remaining === 1 && day.booked_qty === 3, JSON.stringify(day));

    // 客户取消该单 → 回到 2
    if (book1.status === 200 && book1.j.order_no) {
      const cx = await call('/api/juzhu/booking/cancel', { order_no: book1.j.order_no, contact_phone: bkPhone });
      day = await dayOf(dA);
      check('10-3c 取消后回到 2（不越过推送值）',
        cx.status === 200 && day && day.remaining === 2 && day.booked_qty === 2, 'cancel=' + cx.status + ' ' + JSON.stringify(day));
    }

    // 物理余量上限：已订 5 时推净可售 2 → 实际只剩 1 间，兜到 1（防对账漏项导致超售）
    const bookMore = await call('/api/juzhu/booking', {
      project_id: pid3, unit_id: u3, rooms: 3, checkin: dB, checkout: dC,
      contact_name: '净可售回归', contact_phone: bkPhone,
    });
    if (bookMore.status === 200 && bookMore.j.order_no) bkIds.push(bookMore.j.order_no);
    r = await avail(dB, 6);
    day = await dayOf(dB);
    check('10-4 净可售超过物理余量时兜到 total−已订（防超售）',
      r.status === 200 && day && day.remaining === Math.max(0, 6 - day.booked_qty),
      'booked=' + (day && day.booked_qty) + ' remaining=' + (day && day.remaining));

    // 旧口径写法（qty）必须把基线清回 0，不与净可售混用
    r = await call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
      project_id: pid3, unit_id: u3, dates: [dD], status: 'open', qty: 5,
    }));
    r = await avail(dD, 3);
    r = await call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
      project_id: pid3, unit_id: u3, dates: [dD], status: 'open', qty: 5,
    }));
    day = await dayOf(dD);
    // 基线清空的表现 = available_qty 回显为 null（该晚回到旧「放出总量」口径）
    check('10-5 旧口径 qty 写回时基线清空（不混口径）',
      r.status === 200 && day && day.available_qty === null && day.remaining === 5,
      JSON.stringify(day));
    r = await call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
      project_id: pid3, unit_id: u3, dates: [dD], status: 'open', qty: 3, available_qty: 3,
    }));
    check('10-5b qty 与 available_qty 同时传 → 400', r.status === 400 && /只能传一个/.test(r.j.message || ''), JSON.stringify(r.j));
    r = await call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
      project_id: pid3, unit_id: u3, dates: [dD], status: 'open', available_qty: 1000,
    }));
    check('10-5c available_qty 越界 → 400', r.status === 400, JSON.stringify(r.j));

    // 默认关房：开启后未推送放出的晚一律不可订（含只设过价的晚），推过的晚照常可订
    const dE = '2027-03-20', dF = '2027-03-21', dG = '2027-03-22', dH = '2027-03-23';
    await call('/api/juzhu/housing/vendor/stay-calendar/set', signed(vendor, {
      project_id: pid3, unit_id: u3, dates: [dF], status: 'open', price_night: 333,
    }));
    r = await call('/api/juzhu/housing/vendor/units/update', signed(vendor, { id: u3, default_closed: true }));
    check('10-6 房型开启默认关房', r.status === 200 && r.j.unit.ext && JSON.parse(r.j.unit.ext).default_closed === true,
      JSON.stringify(r.j.unit && r.j.unit.ext));
    day = await dayOf(dE);
    check('10-6b 未推送的晚剩余 0（默认关房生效）', day && day.remaining === 0, JSON.stringify(day));
    day = await dayOf(dF);
    check('10-6c 只设过价的晚也算未放出 → 剩余 0', day && day.remaining === 0, JSON.stringify(day));
    const blockedOrder = await call('/api/juzhu/booking', {
      project_id: pid3, unit_id: u3, checkin: dE, checkout: dF,
      contact_name: '净可售回归', contact_phone: bkPhone,
    });
    check('10-6d 未推送的晚下单被拒 400', blockedOrder.status === 400, JSON.stringify(blockedOrder.j).slice(0, 140));
    await avail(dG, 2);
    const okOrder = await call('/api/juzhu/booking', {
      project_id: pid3, unit_id: u3, checkin: dG, checkout: dH,
      contact_name: '净可售回归', contact_phone: bkPhone,
    });
    check('10-6e 推过放出的晚可订（默认关房不影响）', okOrder.status === 200, JSON.stringify(okOrder.j).slice(0, 160));
    if (okOrder.status === 200 && okOrder.j.order_no) bkIds.push(okOrder.j.order_no);
    r = await call('/api/juzhu/housing/vendor/units/update', signed(vendor, { id: u3, default_closed: null }));
    check('10-6f 关闭默认关房（ext 键清除）',
      r.status === 200 && !(r.j.unit.ext && JSON.parse(r.j.unit.ext).default_closed), JSON.stringify(r.j.unit && r.j.unit.ext));
    day = await dayOf(dE);
    check('10-6g 关闭后未推送的晚恢复可订（该户型 total_qty=6，无占用）', day && day.remaining === 6, JSON.stringify(day));
  }

  // ── 5.11) 图集全量覆盖（2026-09 商家反馈点 4）：photos/sync + 分类 + 排序 + 封面 + 抽检 ──
  const photoCfg = require('../photo_config.cjs');
  let pid4 = 0;
  {
    const p = await mkPublishable(RUN + '·图集房源', [
      { name: '图集户型', area_sqm: 30, price_night: 200, min_stay_nights: 1 },
    ], ['演示', '回归', '旅居']);
    pid4 = p.id;
    const u4 = (await call('/api/juzhu/housing/vendor/projects/detail', signed(vendor, { id: pid4 }))).j.units[0].id;
    const U = (n) => `https://cdn.example.test/${RUN}-g${n}.jpg`;
    const mk = (n, extra) => Object.assign({ url: U(n) }, extra || {});
    const cats = ['living', 'bedroom', 'bathroom', 'kitchen', 'nearby', 'other'];
    const gallery = (n) => Array.from({ length: n }, (_, i) => mk(i + 1, {
      category: cats[i % cats.length], sort: (n - i) * 10,      // sort 从大到小：验证按 sort 归一化
    }));

    // 11-1 全量覆盖：8 张（分类 + 乱序 sort + 封面不在第一位）
    const g1 = gallery(8);
    g1[3].is_cover = true;
    r = await call('/api/juzhu/housing/vendor/photos/sync', signed(vendor, { project_id: pid4, unit_id: u4, photos: g1 }));
    check('11-1 sync 全量覆盖 8 张（新增）',
      r.status === 200 && r.j.applied === 8 && r.j.added === 8 && r.j.removed === 0 && r.j.updated === 0,
      JSON.stringify(r.j).slice(0, 180));
    check('11-1b 排序按 sort 归一化为 0..7、分类落库、封面取传入的那张',
      r.status === 200 && r.j.photos.length === 8
      && r.j.photos.every((x, i) => x.sort_order === i)
      && r.j.photos[0].file_path === U(8)                     // sort 最小 = 原数组最后一支
      && r.j.photos[0].category_label === '卧室'                 // g8 → cats[7%6]=bedroom
      && r.j.cover === U(4) && r.j.photos.filter((x) => x.is_cover).length === 1,
      JSON.stringify((r.j.photos || []).map((x) => [x.file_path.slice(-6), x.sort_order, x.category])));

    // 11-2 再推一次：去掉 2 张、新增 1 张、改顺序与分类 → 图集应精确等于传入
    const g2 = gallery(6).concat([mk(99, { category: 'living' })]);
    g2.forEach((x, i) => { x.sort = i; });
    g2[0].is_cover = true;
    const beforeIds = (await call('/api/juzhu/housing/vendor/projects/detail', signed(vendor, { id: pid4 }))).j.units[0].id;
    r = await call('/api/juzhu/housing/vendor/photos/sync', signed(vendor, { project_id: pid4, unit_id: u4, photos: g2 }));
    // g1 = U1..U8；g2 = U1..U6 + U99 → 保留 6 + 新增 1、移除 U7/U8
    check('11-2 二次覆盖：保留 6 / 移除 2 / 新增 1',
      r.status === 200 && r.j.removed === 2 && r.j.added === 1 && r.j.updated === 6
      && r.j.photos.length === 7 && r.j.cover === U(1),
      JSON.stringify({ a: r.j.added, u: r.j.updated, d: r.j.removed, n: (r.j.photos || []).length, cover: r.j.cover }));
    check('11-2b 覆盖后图集 = 传入集合（无残留、无重复）',
      r.status === 200 && JSON.stringify(r.j.photos.map((x) => x.file_path).sort())
        === JSON.stringify(g2.map((x) => x.url).sort()),
      JSON.stringify((r.j.photos || []).map((x) => x.file_path.slice(-6))));

    // 11-3 external_id 匹配：URL 带签名会变，靠 external_id 认同一张图（行 id 不变）
    const idBefore = (await call('/api/juzhu/housing/vendor/projects/detail', signed(vendor, { id: pid4 }))).j.units[0].id;
    const snapBefore = await call('/api/juzhu/housing/vendor/photos/sync', signed(vendor, {
      project_id: pid4, unit_id: u4,
      photos: g2.map((x) => Object.assign({}, x, { external_id: 'E' + x.url.slice(-6) })),
    }));
    const idsBefore = snapBefore.j.photos.map((x) => x.id).join(',');
    const g3 = g2.map((x, i) => Object.assign({}, x, {
      external_id: 'E' + x.url.slice(-6),
      url: i === 0 ? `https://cdn.example.test/${RUN}-rotated.jpg` : x.url,   // 第一张换 URL（签名变了）
    }));
    r = await call('/api/juzhu/housing/vendor/photos/sync', signed(vendor, { project_id: pid4, unit_id: u4, photos: g3 }));
    check('11-3 URL 变、external_id 不变 → 原地更新（行 id 不变，不产生新增/删除）',
      r.status === 200 && r.j.added === 0 && r.j.removed === 0 && r.j.updated === 7
      && r.j.photos.map((x) => x.id).join(',') === idsBefore
      && r.j.photos[0].file_path.endsWith('-rotated.jpg'),
      JSON.stringify({ idsSame: r.j.photos.map((x) => x.id).join(',') === idsBefore, a: r.j.added, d: r.j.removed }));

    // 11-4 覆盖按实体：户型级覆盖不动房源级
    const gProj = Array.from({ length: 8 }, (_, i) => mk('p' + (i + 1), { category: 'nearby' }));
    await call('/api/juzhu/housing/vendor/photos/sync', signed(vendor, { project_id: pid4, photos: gProj }));
    const unitBefore = (await call('/api/juzhu/housing/vendor/projects/detail', signed(vendor, { id: pid4 }))).j.units[0].id;
    r = await call('/api/juzhu/housing/vendor/photos/sync', signed(vendor, { project_id: pid4, unit_id: u4, photos: g3.slice(0, 8) }));
    const [pcRows] = await conn.execute(`SELECT COUNT(*) c FROM photos WHERE entity_type='project' AND entity_id=?`, [pid4]);
    const [ucRows] = await conn.execute(`SELECT COUNT(*) c FROM photos WHERE entity_type='unit' AND entity_id=?`, [u4]);
    check('11-4 户型级覆盖不动房源级图集（各归各的 entity）',
      r.status === 200 && Number(pcRows[0].c) === 8 && Number(ucRows[0].c) === 7,
      'project=' + pcRows[0].c + ' unit=' + ucRows[0].c);

    // 11-5 超 100 张：按 sort 截取前 100 并告警（不静默丢图）
    const big = Array.from({ length: 120 }, (_, i) => mk('big' + i, { sort: i }));
    r = await call('/api/juzhu/housing/vendor/photos/sync', signed(vendor, { project_id: pid4, photos: big }));
    check('11-5 超 100 张 → 截取前 100 + truncated + 告警',
      r.status === 200 && r.j.photos.length === 100 && r.j.truncated === true
      && (r.j.warnings || []).some((w) => /超过 100 张/.test(w)),
      JSON.stringify({ n: (r.j.photos || []).length, t: r.j.truncated }));

    // 11-6 入参校验
    const bad = async (photos, label, re) => {
      const x = await call('/api/juzhu/housing/vendor/photos/sync', signed(vendor, { project_id: pid4, unit_id: u4, photos }));
      check(label, x.status === 400 && re.test(x.j.message || ''), JSON.stringify(x.j).slice(0, 140));
    };
    await bad([mk(1, { category: 'garage' })], '11-6 未知分类 → 400', /category/);
    await bad([mk(1), mk(1)], '11-6b 重复 url → 400', /重复/);
    await bad([mk(1, { width: 640, height: 480 })], '11-6c 声明分辨率低于 800×600 → 400', /低于下限/);
    await bad([mk(1, { size_bytes: 11 * 1024 * 1024 })], '11-6d 声明超过 10MB → 400', /10MB/);
    await bad([{ url: 'assets/local.jpg' }], '11-6e 非 http(s) 地址 → 400', /http/);
    await bad([], '11-6f 空数组 → 400', /不能为空/);

    // 11-7 photos/add 幂等 + sort_order 生效（旧接口不再堆重复行）
    const addUrl = `https://cdn.example.test/${RUN}-add-once.jpg`;
    await call('/api/juzhu/housing/vendor/photos/add', signed(vendor, { project_id: pid4, unit_id: u4, file_path: addUrl, category: 'kitchen' }));
    const add2 = await call('/api/juzhu/housing/vendor/photos/add', signed(vendor, {
      project_id: pid4, unit_id: u4, file_path: addUrl, category: 'living', sort_order: 2,
    }));
    const [dupRow] = await conn.execute('SELECT COUNT(*) c FROM photos WHERE entity_type=\'unit\' AND entity_id=? AND file_path=?', [u4, addUrl]);
    check('11-7 photos/add 同 URL 重推 = 原地更新（不堆重复行）+ sort_order 生效 + 分类可改',
      add2.status === 200 && add2.j.updated === true && Number(dupRow[0].c) === 1
      && add2.j.photo.sort_order === 2 && add2.j.photo.category === 'living',
      JSON.stringify({ n: dupRow[0].c, sort: add2.j.photo && add2.j.photo.sort_order, cat: add2.j.photo && add2.j.photo.category }));

    // 11-8 上架抽检：URL 不可达 → 放行但回 warning（确定性不合格才阻断，见 11-9 纯函数用例）
    await call('/api/juzhu/housing/vendor/photos/sync', signed(vendor, { project_id: pid4, photos: gProj }));
    r = await call('/api/juzhu/housing/vendor/projects/status', signed(vendor, { id: pid4, status: 'online' }));
    check('11-8 抽检不可达 → 上架放行 + warnings（CDN 抖动不卡上架）',
      r.status === 200 && Array.isArray(r.j.warnings) && r.j.warnings.length > 0,
      JSON.stringify(r.j).slice(0, 200));

    // 11-9 判定口径纯函数（与网络解耦，回归里守口径）
    check('11-9 超 10MB → rejected', photoCfg.judgeProbe({ bytes: 11 * 1024 * 1024 }).status === 'rejected');
    check('11-9b 640×480 → rejected', photoCfg.judgeProbe({ bytes: 1000, width: 640, height: 480 }).status === 'rejected');
    check('11-9c 800×600 边界 → ok', photoCfg.judgeProbe({ bytes: 1000, width: 800, height: 600 }).status === 'ok');
    check('11-9d 非图/损坏 → rejected', photoCfg.judgeProbe({ bytes: 10, parseFailed: true }).status === 'rejected');
    check('11-9e 超时/HTTP 非 200 → unreachable（不阻断）',
      photoCfg.judgeProbe({ error: 'timeout' }).status === 'unreachable'
      && photoCfg.judgeProbe({ statusCode: 404 }).status === 'unreachable');
    check('11-9f SSRF：内网/环回/元数据地址拦截，公网放行',
      photoCfg.ipIsBlocked('127.0.0.1') && photoCfg.ipIsBlocked('10.1.2.3')
      && photoCfg.ipIsBlocked('169.254.169.254') && photoCfg.ipIsBlocked('192.168.1.1')
      && photoCfg.ipIsBlocked('::1') && photoCfg.ipIsBlocked('fd00::1')
      && !photoCfg.ipIsBlocked('8.8.8.8') && !photoCfg.ipIsBlocked('2400:3200::1'));
  }

  // ── 5.12) 房间档案 room_profile（Excel 房源字段，2026-09 开放给商家接口）──
  {
    const u5 = (await call('/api/juzhu/housing/vendor/projects/detail', signed(vendor, { id: pid4 }))).j.units[0].id;
    r = await call('/api/juzhu/housing/vendor/units/update', signed(vendor, {
      id: u5,
      room_profile: {
        introduction: '  面朝庭院，独立入户  ',
        area_type: 'building', window_type: 'exterior', window_count: 2, window_openable: true,
        max_guests: 4, max_adults: 3, max_children: 1, smoking: 'no',
        beds: '卧室1：1.8×2.0m 大床', kitchen: '独立厨房 · 可做饭',
        feature_image: 'https://cdn.example.test/room.jpg', feature_image_caption: '庭院实拍',
        unknown_key_should_be_dropped: 'x',
      },
    }));
    check('12-1 room_profile 写入 → 回显已解析对象 + 白名单丢弃未知键 + 去首尾空格',
      r.status === 200 && r.j.unit.room_profile
      && r.j.unit.room_profile.introduction === '面朝庭院，独立入户'
      && r.j.unit.room_profile.max_guests === 4 && r.j.unit.room_profile.window_openable === true
      && r.j.unit.room_profile.unknown_key_should_be_dropped === undefined,
      JSON.stringify(r.j.unit.room_profile || {}).slice(0, 200));
    const [rpRow] = await conn.execute('SELECT ext FROM units WHERE id=?', [u5]);
    const rpExt = JSON.parse(rpRow[0].ext || '{}');
    check('12-1b 落库到 units.ext.room_profile，且不动其它 ext 键',
      rpExt.room_profile && rpExt.room_profile.beds === '卧室1：1.8×2.0m 大床' && rpExt.price_night === 200,
      JSON.stringify(rpExt).slice(0, 200));
    r = await call('/api/juzhu/housing/vendor/units/update', signed(vendor, { id: u5, room_profile: { smoking: 'sometimes' } }));
    check('12-2 非法枚举 → 400 且报出可选值', r.status === 400 && /吸烟属性/.test(r.j.message || ''), JSON.stringify(r.j).slice(0, 160));
    r = await call('/api/juzhu/housing/vendor/units/update', signed(vendor, { id: u5, room_profile: { max_guests: 200 } }));
    check('12-2b 数值越界 → 400', r.status === 400 && /最大入住人数/.test(r.j.message || ''), JSON.stringify(r.j).slice(0, 160));
    r = await call('/api/juzhu/housing/vendor/units/update', signed(vendor, { id: u5, room_profile: { feature_image: 'javascript:alert(1)' } }));
    check('12-2c 图片地址非法 → 400', r.status === 400 && /图片地址/.test(r.j.message || ''), JSON.stringify(r.j).slice(0, 160));
    r = await call('/api/juzhu/housing/vendor/units/update', signed(vendor, { id: u5, room_profile: null }));
    const [rpRow2] = await conn.execute('SELECT ext FROM units WHERE id=?', [u5]);
    check('12-3 传 null 清除 room_profile（其它 ext 键保留）',
      r.status === 200 && r.j.unit.room_profile === null
      && JSON.parse(rpRow2[0].ext || '{}').room_profile === undefined
      && JSON.parse(rpRow2[0].ext || '{}').price_night === 200,
      JSON.stringify(r.j.unit.room_profile));
  }

  // ── 5.13) 上架图集门槛（2026-09-18 按商家反馈由 8 下调为 7）──
  // 阈值单一数据源 photo_config.PHOTO_MIN_PUBLISH，两处上架闸同读一份；这里锁住边界行为。
  let pid6 = 0;
  {
    const photoCfg2 = require('../photo_config.cjs');
    check('13-0 阈值常量 = 7（单一数据源）', photoCfg2.PHOTO_MIN_PUBLISH === 7, 'PHOTO_MIN_PUBLISH=' + photoCfg2.PHOTO_MIN_PUBLISH);

    const mkWithPhotos = async (name, n) => {
      const pj = await mkPublishable(name, [
        { name: '门槛户型', area_sqm: 30, price_night: 200, min_stay_nights: 1 },
      ], ['演示', '回归', '旅居']);
      // mkPublishable 自己会先灌 8 张图；先清空再精确插入 n 张，否则卡不到边界
      await conn.execute("DELETE FROM photos WHERE entity_type='project' AND entity_id=?", [pj.id]);
      await conn.execute(
        "DELETE FROM photos WHERE entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id=?)", [pj.id]);
      for (let i = 0; i < n; i++) {
        await conn.execute(
          `INSERT INTO photos(entity_type, entity_id, file_path, category, is_cover, sort_order)
           VALUES ('project', ?, ?, 'other', ?, ?)`,
          [pj.id, `https://cdn.example.test/${name}-${i}.jpg`, i === 0 ? 1 : 0, i]);
      }
      return pj.id;
    };

    pid6 = await mkWithPhotos(RUN + '·7图房源', 7);
    r = await call('/api/juzhu/housing/vendor/projects/status', signed(vendor, { id: pid6, status: 'online' }));
    check('13-1 恰好 7 张（含封面）→ 可上架',
      r.status === 200 && r.j.status === 'online', JSON.stringify(r.j).slice(0, 160));

    const pid7 = await mkWithPhotos(RUN + '·6图房源', 6);
    r = await call('/api/juzhu/housing/vendor/projects/status', signed(vendor, { id: pid7, status: 'online' }));
    check('13-2 只有 6 张 → 上架被拒 400 且提示 7 张',
      r.status === 400 && /至少上传 7 张/.test(r.j.message || ''), JSON.stringify(r.j).slice(0, 160));
    await conn.execute('DELETE FROM units WHERE project_id=?', [pid7]);
    await conn.execute('DELETE FROM photos WHERE entity_type=\'project\' AND entity_id=?', [pid7]);
    await conn.execute('DELETE FROM projects WHERE id=?', [pid7]);
  }

  // ── Webhook 验收：booking.created / booking.paid / booking.cancelled（平台 → 商家，HMAC 验签）──
  if (hits.length === 0) {
    check('webhook 送达', false, '未收到任何事件（服务端未读取到 webhook_url）');
  } else {
    const evCreated = await waitForWebhook('booking.created', 20000);
    check('webhook booking.created 送达', !!evCreated, '未见事件');
    if (evCreated) {
      const v = hmac.verifySignature(vendor.hmac_key, evCreated);
      check('webhook 签名可被商家验签（同 HMAC 算法）', v.ok === true, JSON.stringify(v));
      check('webhook 载荷含订单号', evCreated.order && evCreated.order.order_no === bk.j.order_no,
        evCreated.order && evCreated.order.order_no);
      check('webhook 载荷不含明文手机号', !JSON.stringify(evCreated).includes(bkPhone), '');
    }
    // 首次 500 → 期待重试后仍送达（重试间隔 5s/30s/120s）：等到第 2 次投递落地再断言。
    // 按订单号过滤：前面的用例（§5.10 取消释放）也会向同一商家推 cancelled，不能只看全局条数。
    const isBk4Cancel = (h) => h && h.event === 'booking.cancelled' && h.order && h.order.order_no === bk4.j.order_no;
    let cancelHits = [];
    const dl2 = Date.now() + 45000;
    while (Date.now() < dl2) {
      cancelHits = hits.filter(isBk4Cancel);
      if (cancelHits.length >= 2) break;
      await new Promise((r2) => setTimeout(r2, 300));
    }
    check('webhook booking.cancelled 送达（含 500 后重试）', cancelHits.length >= 2, 'hits=' + cancelHits.length);
    const evCancelled = cancelHits[cancelHits.length - 1];
    if (evCancelled) {
      const v2 = hmac.verifySignature(vendor.hmac_key, evCancelled);
      check('cancelled 事件验签通过', v2.ok === true, JSON.stringify(v2));
      check('cancelled 事件订单号正确', evCancelled.order && evCancelled.order.order_no === bk4.j.order_no,
        evCancelled.order && evCancelled.order.order_no);
    }
    const evPaid = hits.find((h) => h && h.event === 'booking.paid');
    check('webhook booking.paid 送达（预付单）', !!evPaid, '');
  }

  // 负例：不存在/他人订单 404
  r = await call('/api/juzhu/housing/vendor/bookings/confirm', signed(vendor, { id: 999999 }));
  check('bookings/confirm 不存在 id → 404', r.status === 404, 'status=' + r.status);
  // 清理本节订单
  for (const id of bkIds) { /* 订单行随项目清理；9001 的单置 cancelled 释放房态 */ }
  if (bkIds.length) {
    const om = bkIds.map(() => '?').join(',');
    await conn.execute('DELETE FROM stay_calendar WHERE booking_id IN (SELECT id FROM (SELECT id FROM booking_orders WHERE order_no IN (' + om + ')) t)', bkIds);
    await conn.execute('DELETE FROM booking_orders WHERE order_no IN (' + om + ')', bkIds);
  }
  await conn.execute('DELETE FROM stay_calendar WHERE project_id=?', [mid]);
  await conn.execute('DELETE FROM units WHERE project_id=?', [mid]);
  await conn.execute('DELETE FROM projects WHERE id=?', [mid]);
  await conn.execute('UPDATE jz_vendors SET webhook_url=? WHERE id=?', [origHook[0] && origHook[0].webhook_url || null, vendor.id]);
  hook.close();
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

  // ── 8) 清理本次演示数据（含 §5.9 的价格口径房源；先删这两个项目的订单，避免残留占用）──
  const allPids = [pid, pid2, pid3, pid4, pidNoPrice, pid6].filter(Boolean);
  await conn.execute(`DELETE FROM booking_orders WHERE project_id IN (${allPids.map(() => '?').join(',')})`, allPids);
  for (const x of allPids) {
    await conn.execute('DELETE FROM stay_calendar WHERE project_id=?', [x]);
    await conn.execute('DELETE FROM units WHERE project_id=?', [x]);
    await conn.execute('DELETE FROM photos WHERE entity_type="project" AND entity_id=?', [x]);
    await conn.execute('DELETE FROM projects WHERE id=?', [x]);
  }
  check('清理演示数据', await catalogEventually(BASE, pid, city.slug, false));

  await conn.end();
  console.log(failed === 0 ? '\n房源 HMAC 回归全部通过' : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('回归脚本异常:', e.message);
  process.exit(2);
});
