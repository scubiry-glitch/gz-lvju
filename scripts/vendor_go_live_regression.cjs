#!/usr/bin/env node
/**
 * scripts/vendor_go_live_regression.cjs —— 商家上线完整性自查（/api/juzhu/vendor/go-live-check）回归
 *
 * 造一个"全通过"商家（资质/在营/结算账户/房源评级+上架/户型/按晚预订/取消政策/实拍图）→
 * 逐项破坏断言 fail 与 ready 翻转 → 视角隔离（vendor 只看自己 / platform 代查 / 401）→ 清理
 *
 * 用法：node scripts/vendor_go_live_regression.cjs [base_url]   # 默认 http://127.0.0.1:8766
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
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const BASE = (process.argv[2] || process.env.JUZHU_REG_BASE || 'http://127.0.0.1:8766').replace(/\/+$/, '');
const RUN = 'glc' + process.pid;
const TP = '134' + String(10000000 + (process.pid % 89999999)).slice(0, 8);
const TEMP_PWD = 'Glc-temp-2026!';

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  if (!cond) failed++;
}

async function connectDb() {
  const g = (ks, dflt) => { for (const k of ks) { const v = (process.env[k] || '').trim(); if (v) return v; } return dflt; };
  return mysql.createConnection({
    host: g(['MYSQL_HOST', 'JUZHU_DB_HOST'], '127.0.0.1'),
    port: parseInt(g(['MYSQL_PORT', 'JUZHU_DB_PORT'], '3306'), 10),
    user: g(['MYSQL_USER', 'JUZHU_DB_USER'], ''),
    password: process.env.MYSQL_PASSWORD ?? process.env.JUZHU_DB_PASSWORD ?? '',
    database: g(['MYSQL_DB', 'JUZHU_DB_NAME'], ''),
    connectTimeout: 8000,
  });
}

async function api(path, opts) {
  opts = opts || {};
  const r = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch (_) { /* ignore */ }
  return { status: r.status, j };
}

function checkState(j, key, state) {
  const c = (j.checks || []).filter((x) => x.key === key)[0];
  return !!c && c.state === state;
}

(async () => {
  const conn = await connectDb();
  if (!conn.config.database) throw new Error('MYSQL_*/JUZHU_DB_* env 不完整');

  const [cities] = await conn.execute('SELECT id FROM cities ORDER BY id LIMIT 1');
  // 造"全通过"商家 A + 对照商家 B
  const [vins] = await conn.execute(
    `INSERT INTO jz_vendors(type, name, phone, login_name, status, review_status, created_at, updated_at)
     VALUES ('housing_operator', ?, ?, ?, 'active', 'approved', NOW(), NOW())`,
    ['自查回归商家-' + RUN, TP, 'glc_' + RUN]
  );
  const vidA = vins.insertId;
  const [vinsB] = await conn.execute(
    `INSERT INTO jz_vendors(type, name, phone, status, review_status, created_at, updated_at)
     VALUES ('housing_operator', ?, '13300000000', 'active', 'approved', NOW(), NOW())`,
    ['自查对照商家-' + RUN]
  );
  const vidB = vinsB.insertId;
  await conn.execute(
    `INSERT INTO vendor_onboarding(apply_no, company, contact, phone, channels, status, rate_base, settle_bank, settle_account, deposit_tier, created_at)
     VALUES (?,?,?,?, 'rental','approved',10.00,?,?, 'standard', NOW())`,
    ['VO-' + RUN, '自查回归公司', '回归', TP, '测试银行', TP.replace(/(.{4})(.*)(.{3})/, '$1****$3')]
  );
  const [pins] = await conn.execute(
    `INSERT INTO projects(city_id, channel, name, slug, tags, status, rating_status, owner_vendor_id, contact_phone, ext, unit_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [cities[0].id, 'rental', '自查回归房-' + RUN, RUN, JSON.stringify(['演示']), 'online', 'passed', vidA, TP, JSON.stringify({ stay_bookable: true }), 1]
  );
  const pid = pins.insertId;
  await conn.execute(
    `INSERT INTO units(project_id, name, slug, rent_monthly, tags, ext) VALUES (?,?,?,?,?,?)`,
    [pid, '自查回归户型', 'a', 3000, JSON.stringify(['演示']), JSON.stringify({ cancel_policy: { enabled: true, days_before: 1, cutoff_time: '18:00' } })]
  );
  for (let i = 0; i < 8; i++) {
    await conn.execute(
      `INSERT INTO photos(entity_type, entity_id, file_path, is_cover, sort_order) VALUES ('project', ?, ?, ?, ?)`,
      [pid, `https://cdn.example.test/${RUN}-${i}.jpg`, i === 0 ? 1 : 0, i]
    );
  }

  // 管理员（platform）+ 商家 A 会话
  const adminLogin = await api('/api/auth/login', { method: 'POST', body: { login_name: 'staff_admin', password: 'staff-admin-2026' } });
  const AH = { Authorization: 'Bearer ' + (adminLogin.j && adminLogin.j.token) };
  check('staff_admin 登录（platform）', adminLogin.status === 200 && !!adminLogin.j.token);
  // 登录已并入账号中心：测试商家走懒建档（accounts 无行 → /vendor/login 用 jz_vendors bcrypt 校验）
  await conn.execute('UPDATE jz_vendors SET password_hash=? WHERE id=?', [bcrypt.hashSync(TEMP_PWD, 8), vidA]);
  const vlogin = await api('/api/juzhu/vendor/login', { method: 'POST', body: { login_name: 'glc_' + RUN, password: TEMP_PWD } });
  const VH = { Authorization: 'Bearer ' + (vlogin.j && vlogin.j.token) };
  check('商家 A 登录', vlogin.status === 200 && !!vlogin.j.token, JSON.stringify(vlogin.j).slice(0, 100));

  try {
    // ── 1. 商家自查：全通过（费率/hmac 为 warn）──
    let r = await api('/api/juzhu/vendor/go-live-check', { headers: VH });
    let j = r.j;
    check('自查 200 且 role=vendor', r.status === 200 && j.role === 'vendor' && j.vendor.id === vidA, JSON.stringify(j).slice(0, 120));
    check('全通过 → ready=true', j.ready === true && j.failed_count === 0, 'failed=' + j.failed_count + ' warns=' + j.warn_count);
    ['qualification', 'active', 'settlement', 'housing_approved', 'housing_online', 'units_complete', 'contact', 'photos'].forEach((k) =>
      check('  必须项通过 ' + k, checkState(j, k, 'pass'), JSON.stringify((j.checks || []).filter((x) => x.key === k)[0] || {})));
    check('按晚预订通过（stay_bookable）', checkState(j, 'stay_bookable', 'pass'));
    check('取消政策通过（cancel_policy）', checkState(j, 'cancel_policy', 'pass'));
    check('费率未差异化 → warn（按基准）', checkState(j, 'commission', 'warn'));
    check('未接开放接口 → warn（hmac）', checkState(j, 'hmac', 'warn'));

    // ── 2. 视角隔离：vendor 会话带 ?vendor_id=B 仍只看自己 ──
    r = await api('/api/juzhu/vendor/go-live-check?vendor_id=' + vidB, { headers: VH });
    check('vendor 忽略 vendor_id（只看自己）', r.status === 200 && r.j.vendor.id === vidA, 'got #' + (r.j.vendor && r.j.vendor.id));

    // ── 3. platform 代查 / 缺参 / 不存在 ──
    r = await api('/api/juzhu/vendor/go-live-check?vendor_id=' + vidA, { headers: AH });
    check('platform 代查 200', r.status === 200 && r.j.role === 'platform' && r.j.vendor.id === vidA, JSON.stringify(r.j).slice(0, 100));
    r = await api('/api/juzhu/vendor/go-live-check', { headers: AH });
    check('platform 缺 vendor_id → 400', r.status === 400, JSON.stringify(r.j));
    r = await api('/api/juzhu/vendor/go-live-check?vendor_id=99999999', { headers: AH });
    check('不存在的商家 → 404', r.status === 404, JSON.stringify(r.j));
    r = await api('/api/juzhu/vendor/go-live-check');
    check('未登录 → 401', r.status === 401, JSON.stringify(r.j));

    // ── 4. 逐项破坏 → fail 与 ready 翻转（platform 代查观察）──
    const asPlatform = () => api('/api/juzhu/vendor/go-live-check?vendor_id=' + vidA, { headers: AH });
    await conn.execute("UPDATE jz_vendors SET review_status='reviewing' WHERE id=?", [vidA]);
    r = await asPlatform();
    check('资质未过 → qualification fail + ready=false', checkState(r.j, 'qualification', 'fail') && r.j.ready === false);
    await conn.execute("UPDATE jz_vendors SET review_status='approved' WHERE id=?", [vidA]);

    await conn.execute("UPDATE jz_vendors SET status='suspended' WHERE id=?", [vidA]);
    r = await asPlatform();
    check('商家停用 → active fail', checkState(r.j, 'active', 'fail') && r.j.ready === false);
    await conn.execute("UPDATE jz_vendors SET status='active' WHERE id=?", [vidA]);

    await conn.execute("DELETE FROM vendor_onboarding WHERE apply_no='VO-" + RUN + "'");
    r = await asPlatform();
    check('结算账户缺失 → settlement fail', checkState(r.j, 'settlement', 'fail') && r.j.ready === false);
    await conn.execute(
      `INSERT INTO vendor_onboarding(apply_no, company, contact, phone, channels, status, rate_base, settle_bank, settle_account, deposit_tier, created_at)
       VALUES ('VO-${RUN}','自查回归公司','回归',?, 'rental','approved',10.00,'测试银行',?,'standard',NOW())`, [TP, TP]);

    await conn.execute("UPDATE projects SET rating_status='draft' WHERE id=?", [pid]);
    r = await asPlatform();
    check('评级未过 → housing_approved fail', checkState(r.j, 'housing_approved', 'fail') && r.j.ready === false);
    await conn.execute("UPDATE projects SET rating_status='passed' WHERE id=?", [pid]);

    await conn.execute("UPDATE projects SET status='offline' WHERE id=?", [pid]);
    r = await asPlatform();
    check('下架 → housing_online + units_complete fail（无在售）',
      checkState(r.j, 'housing_online', 'fail') && checkState(r.j, 'units_complete', 'fail') && r.j.ready === false);
    await conn.execute("UPDATE projects SET status='online' WHERE id=?", [pid]);

    await conn.execute('UPDATE jz_vendors SET commission_housing=8 WHERE id=?', [vidA]);
    r = await asPlatform();
    check('差异化费率 → commission pass（不阻塞级）', checkState(r.j, 'commission', 'pass'));
    await conn.execute('UPDATE jz_vendors SET commission_housing=NULL WHERE id=?', [vidA]);

    // 恢复全通过
    r = await asPlatform();
    check('还原后 ready=true', r.status === 200 && r.j.ready === true, 'failed=' + r.j.failed_count);
  } finally {
    await conn.execute('DELETE FROM vendor_onboarding WHERE apply_no=?', ['VO-' + RUN]);
    await conn.execute('DELETE FROM photos WHERE entity_type=\'project\' AND entity_id=?', [pid]);
    await conn.execute('DELETE FROM units WHERE project_id=?', [pid]);
    await conn.execute('DELETE FROM stay_calendar WHERE project_id=?', [pid]);
    await conn.execute('DELETE FROM booking_orders WHERE project_id=?', [pid]);
    await conn.execute('DELETE FROM projects WHERE id=?', [pid]);
    await conn.execute('DELETE FROM jz_vendors WHERE id IN (?, ?)', [vidA, vidB]);
    await conn.end();
    console.log('\ncleanup done（回归商家/房源/申请单已清）');
  }

  console.log(failed ? `\n${failed} 项 FAIL` : '\n全部 PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL:', e.message, '\n', (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
