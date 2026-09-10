#!/usr/bin/env node
/**
 * scripts/vendor_commission_regression.cjs —— 商家佣金费率（规则 20，按业务线分档）回归
 *
 * 覆盖：两档费率 admin 读写（含非法值/清除）→ 全局基准 KV → 入驻审批按 phone 回填 →
 *       下单锁定快照（差异化与基准商家各一单）→ HMAC / B 端订单透出 → /vendor/me 商家可见 →
 *       audit before/after → 无权限 403 → 清理
 *
 * 用法：node scripts/vendor_commission_regression.cjs [base_url]   # 默认 http://127.0.0.1:8766
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
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const BASE = (process.argv[2] || process.env.JUZHU_REG_BASE || 'http://127.0.0.1:8766').replace(/\/+$/, '');
const RUN = 'vcr' + process.pid;

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  if (!cond) failed++;
}

async function connectDb() {
  const g = (ks, dflt) => {
    for (const k of ks) { const v = (process.env[k] || '').trim(); if (v) return v; }
    return dflt;
  };
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

const pad2 = (n) => String(n).padStart(2, '0');
function dateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

(async () => {
  const conn = await connectDb();
  if (!conn.config.database) throw new Error('MYSQL_*/JUZHU_DB_* env 不完整');

  // ── 准备：管理员（operator_admin，含 vendor.fund.write）+ 无权限对照 + 商家 ──
  const adminLogin = await api('/api/auth/login', { method: 'POST', body: { login_name: 'staff_admin', password: 'staff-admin-2026' } });
  const adminTok = adminLogin.j && adminLogin.j.token;
  check('staff_admin 登录', adminLogin.status === 200 && !!adminTok, JSON.stringify(adminLogin.j).slice(0, 100));
  const dispLogin = await api('/api/auth/login', { method: 'POST', body: { login_name: 'staff_disp', password: 'staff-disp-2026' } });
  const dispTok = dispLogin.j && dispLogin.j.token;
  const AH = { Authorization: 'Bearer ' + adminTok };
  const DH = dispTok ? { Authorization: 'Bearer ' + dispTok } : {};

  const [vrows] = await conn.execute(
    "SELECT id, name, phone, hmac_key, type, password_hash FROM jz_vendors WHERE hmac_key IS NOT NULL AND hmac_key <> '' AND status='active' ORDER BY id");
  const vendor = vrows.find((r) => r.type === 'housing_operator') || vrows[0];
  if (!vendor) throw new Error('库中无可用 vendor');
  console.log(`vendor: #${vendor.id} ${vendor.name}\n`);
  const oldVendorHash = vendor.password_hash;
  let accBefore = [];   // accounts 原哈希（finally 还原；登录并入账号中心后统一链认 accounts）
  const savedCols = [null, null];   // 还原商家两档原值
  let savedPhone = vendor.phone;    // 还原商家电话（回归会临时改写以保证审批回填单命中）

  // 测试房源（rental + stay_bookable，下单用）
  const [cities] = await conn.execute('SELECT id FROM cities ORDER BY id LIMIT 1');
  const [pins] = await conn.execute(
    `INSERT INTO projects(city_id, channel, name, slug, tags, status, rating_status, owner_vendor_id, ext, unit_count)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [cities[0].id, 'rental', '佣金回归-' + RUN, RUN, JSON.stringify(['演示']), 'online', 'passed', vendor.id, JSON.stringify({ stay_bookable: true }), 1]
  );
  const pid = pins.insertId;
  const [uins] = await conn.execute(
    `INSERT INTO units(project_id, name, slug, rent_monthly, tags) VALUES (?,?,?,?,?)`,
    [pid, '佣金回归房', 'a', 3000, JSON.stringify(['演示'])]
  );
  const unitId = uins.insertId;
  const checkin = dateStr(3), checkout = dateStr(18);
  const phone = '136' + String(10000000 + (process.pid % 89999999)).slice(0, 8);
  const book = () => api('/api/juzhu/booking', {
    method: 'POST',
    body: { project_id: pid, unit_id: unitId, checkin, checkout, contact_name: '回归', contact_phone: phone, idempotency_key: RUN + '-' + Math.random().toString(36).slice(2, 8) },
  });

  try {
    // ── 1. rates 读接口：defaults + 商家清单 ──
    let r = await api('/api/juzhu/admin/vendors/rates', { headers: AH });
    check('GET /admin/vendors/rates 200', r.status === 200 && Array.isArray(r.j.vendors) && r.j.defaults, JSON.stringify(r.j).slice(0, 120));
    const defaults0 = r.j.defaults;

    // ── 2. 两档写入 + 回读 ──
    r = await api('/api/juzhu/admin/vendors/' + vendor.id + '/commission', { method: 'PUT', headers: AH, body: { commission_housing: 8.5, commission_jiazheng: 3 } });
    check('PUT 两档 → 200', r.status === 200 && r.j.vendor.commission_housing === 8.5 && r.j.vendor.commission_jiazheng === 3, JSON.stringify(r.j));
    r = await api('/api/juzhu/admin/vendors/rates', { headers: AH });
    const me0 = r.j.vendors.filter((v) => v.id === vendor.id)[0];
    check('回读差异化 + 生效费率', me0 && me0.commission_housing === 8.5 && me0.commission_housing_effective === 8.5 && me0.commission_jiazheng_effective === 3, JSON.stringify(me0));

    // ── 3. 非法值 / 缺字段 ──
    r = await api('/api/juzhu/admin/vendors/' + vendor.id + '/commission', { method: 'PUT', headers: AH, body: { commission_housing: 101 } });
    check('超范围 400', r.status === 400 && /0-100/.test(r.j.error || ''), JSON.stringify(r.j));
    r = await api('/api/juzhu/admin/vendors/' + vendor.id + '/commission', { method: 'PUT', headers: AH, body: { commission_jiazheng: 'abc' } });
    check('非数字 400', r.status === 400, JSON.stringify(r.j));
    r = await api('/api/juzhu/admin/vendors/' + vendor.id + '/commission', { method: 'PUT', headers: AH, body: {} });
    check('无可更新字段 400', r.status === 400, JSON.stringify(r.j));

    // ── 4. 全局基准（commission-defaults，vendor.fund.write 同权限）+ 清除回落 ──
    r = await api('/api/juzhu/admin/vendors/commission-defaults', { method: 'PUT', headers: AH, body: { housing: 8 } });
    check('PUT 基准 → 200 且回显', r.status === 200 && r.j.defaults.housing === 8, JSON.stringify(r.j));
    r = await api('/api/juzhu/admin/vendors/' + vendor.id + '/commission', { method: 'PUT', headers: AH, body: { commission_housing: null } });
    check('null 清除房源档', r.status === 200 && r.j.vendor.commission_housing === null);
    r = await api('/api/juzhu/admin/vendors/rates', { headers: AH });
    const me1 = r.j.vendors.filter((v) => v.id === vendor.id)[0];
    check('清除后生效费率回落基准 8', me1 && me1.commission_housing === null && me1.commission_housing_effective === 8, JSON.stringify(me1));
    r = await api('/api/juzhu/admin/vendors/commission-defaults', { method: 'PUT', headers: AH, body: { housing: null } });
    check('基准删除（回落内置 10）→ 200', r.status === 200 && r.j.defaults.housing === 10, JSON.stringify(r.j));
    r = await api('/api/juzhu/admin/vendors/commission-defaults', { method: 'PUT', headers: AH, body: { housing: 'x!' } });
    check('非法基准 400', r.status === 400, JSON.stringify(r.j));
    r = await api('/api/juzhu/admin/vendors/commission-defaults', { method: 'PUT', headers: AH, body: {} });
    check('无可更新字段 400', r.status === 400, JSON.stringify(r.j));

    // ── 5. 无权限对照（operator_dispatcher 无 vendor.fund.write/admin.write）──
    if (dispTok) {
      r = await api('/api/juzhu/admin/vendors/' + vendor.id + '/commission', { method: 'PUT', headers: DH, body: { commission_housing: 1 } });
      check('无权限 403', r.status === 403, JSON.stringify(r.j));
    } else {
      console.log('— staff_disp 不可用，跳过权限负例');
    }

    // ── 6. 入驻审批按 phone 单命中回填（channels=rental,jiazheng → 两档；10−3=7）──
    const testPhone = '135' + String(10000000 + (process.pid % 89999999)).slice(0, 8);
    await conn.execute('UPDATE jz_vendors SET phone=? WHERE id=?', [testPhone, vendor.id]);   // 保证 phone 单命中
    const [ois] = await conn.execute(
      `INSERT INTO vendor_onboarding(apply_no, company, contact, phone, channels, status, rate_base, created_at)
       VALUES (?,?,?,?,?,'pending',10.00,NOW())`,
      ['VO-' + RUN, '佣金回归公司', '回归', testPhone, 'rental,jiazheng']
    );
    const oid = ois.insertId;
    r = await api('/api/juzhu/admin/vendor-onboarding/' + oid + '/review', { method: 'POST', headers: AH, body: { action: 'approve', rate_discount: 3 } });
    check('审批通过 → 200', r.status === 200, JSON.stringify(r.j).slice(0, 140));
    check('回填文案带商家', r.j.message.indexOf('费率已回填商家') >= 0, r.j.message);
    const [vnow] = await conn.execute('SELECT commission_housing, commission_jiazheng FROM jz_vendors WHERE id=?', [vendor.id]);
    check('两档按基准−折扣回填 7.00', Number(vnow[0].commission_housing) === 7 && Number(vnow[0].commission_jiazheng) === 7, JSON.stringify(vnow[0]));

    // ── 7. 下单锁定快照（差异化 7%）──
    let bk = await book();
    check('下单 200 且回显佣金', bk.status === 200 && bk.j.commission_rate === 7 && bk.j.commission_amount === Math.round(bk.j.price_total * 7) / 100,
      JSON.stringify(bk.j).slice(0, 200));
    const [o1] = await conn.execute('SELECT commission_rate, commission_fee, price_total FROM booking_orders WHERE order_no=?', [bk.j.order_no]);
    check('订单快照 rate=7.00 fee=总额×7%', Number(o1[0].commission_rate) === 7 && Math.abs(Number(o1[0].commission_fee) - o1[0].price_total * 0.07) < 0.01, JSON.stringify(o1[0]));
    await conn.execute("UPDATE booking_orders SET status='cancelled' WHERE order_no=?", [bk.j.order_no]);
    await conn.execute("DELETE FROM stay_calendar WHERE project_id=?", [pid]);   // 释放整项目，便于下一单

    // 基准单：清除差异化 → 生效费率回落基准
    await api('/api/juzhu/admin/vendors/' + vendor.id + '/commission', { method: 'PUT', headers: AH, body: { commission_housing: null, commission_jiazheng: null } });
    bk = await book();
    check('基准单快照 rate=10（内置兜底）', bk.status === 200 && bk.j.commission_rate === 10, JSON.stringify(bk.j).slice(0, 160));

    // ── 8. B 端订单 + HMAC 透出 ──
    r = await api('/api/juzhu/vendor/booking/orders', { headers: AH });
    const bitem = (r.j.items || []).filter((x) => x.order_no === bk.j.order_no)[0];
    check('B 端订单随发佣金快照', !!bitem && Number(bitem.commission_rate) === 10 && bitem.commission_fee != null, JSON.stringify(bitem || {}).slice(0, 160));
    const sign = (payload) => {
      const hmac = require('../hmac_auth.cjs');
      return hmac.generateSignature(vendor.hmac_key, Object.assign({ vendor_id: vendor.id }, payload));
    };
    let hs = sign({});
    let hr = await fetch(BASE + '/api/juzhu/housing/vendor/bookings/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, hs)) });
    let hj = await hr.json();
    const hitem = (hj.list || []).filter((x) => x.order_no === bk.j.order_no)[0];
    check('HMAC bookings/list 透出佣金', !!hitem && Number(hitem.commission_rate) === 10 && Number(hitem.commission_fee) === Number(bitem.commission_fee), JSON.stringify(hitem || {}).slice(0, 160));

    // ── 9. /vendor/me 商家可见 ──
    // 登录已并入账号中心：accounts 与 jz_vendors 两边都要写临时口令（统一链认 accounts）
    const authCenter = require('../auth_center.cjs');
    [accBefore] = await conn.execute('SELECT id, password_hash FROM accounts WHERE vendor_id=? AND principal_type="user"', [vendor.id]);
    await conn.execute('UPDATE jz_vendors SET password_hash=? WHERE id=?', [bcrypt.hashSync('Vcr-temp-2026!', 8), vendor.id]);
    if (accBefore.length) {
      await conn.execute('UPDATE accounts SET password_hash=? WHERE id=?', [await authCenter.hashPassword('Vcr-temp-2026!'), accBefore[0].id]);
    }
    const [vrow] = await conn.execute('SELECT login_name FROM jz_vendors WHERE id=?', [vendor.id]);
    const vlogin = await api('/api/juzhu/vendor/login', { method: 'POST', body: { login_name: vrow[0].login_name, password: 'Vcr-temp-2026!' } });
    check('vendor 登录', vlogin.status === 200 && !!vlogin.j.token, JSON.stringify(vlogin.j).slice(0, 100));
    r = await api('/api/juzhu/vendor/me', { headers: { Authorization: 'Bearer ' + vlogin.j.token } });
    check('/vendor/me 随发两档生效费率', r.status === 200 && r.j.vendor.commission
      && r.j.vendor.commission.housing.rate === 10 && r.j.vendor.commission.housing.is_default === true
      && r.j.vendor.commission.jiazheng.rate === 10, JSON.stringify(r.j.vendor && r.j.vendor.commission));

    // ── 10. 审计 before/after（DB 直查 + 专用历史接口）──
    const [arows] = await conn.execute(
      "SELECT before_json, after_json FROM audit_log WHERE action='vendor.commission.update' AND resource_id=? AND before_json IS NOT NULL ORDER BY id DESC LIMIT 1",
      [String(vendor.id)]);
    check('审计含 before/after 费率', arows.length > 0 && JSON.parse(arows[0].before_json).commission_housing !== undefined
      && JSON.parse(arows[0].after_json).commission_housing !== undefined, JSON.stringify(arows[0] || {}));
    r = await api('/api/juzhu/admin/vendors/commission-history', { headers: AH });
    const hitem2 = (r.j.items || []).filter((x) => x.vendor_id === String(vendor.id))[0];
    check('历史接口随发详单', r.status === 200 && !!hitem2 && hitem2.before.commission_housing !== undefined, JSON.stringify(hitem2 || {}).slice(0, 140));
  } finally {
    // ── 清理 ──
    await conn.execute('UPDATE jz_vendors SET password_hash=?, commission_housing=?, commission_jiazheng=?, phone=? WHERE id=?',
      [oldVendorHash, savedCols[0], savedCols[1], savedPhone, vendor.id]);
    if (accBefore.length) {
      await conn.execute('UPDATE accounts SET password_hash=? WHERE id=?', [accBefore[0].password_hash, accBefore[0].id]);
    }
    await conn.execute('DELETE FROM booking_orders WHERE project_id=?', [pid]);
    await conn.execute('DELETE FROM stay_calendar WHERE project_id=?', [pid]);
    await conn.execute('DELETE FROM units WHERE project_id=?', [pid]);
    await conn.execute('DELETE FROM projects WHERE id=?', [pid]);
    await conn.execute("DELETE FROM vendor_onboarding WHERE apply_no='VO-" + RUN + "'");
    await conn.execute("DELETE FROM settings WHERE `key` IN ('commission_housing_default','commission_jiazheng_default')");
    await conn.end();
    console.log('\ncleanup done（商家口令/两档原值还原，基准 KV 清除，回归数据已清）');
  }

  console.log(failed ? `\n${failed} 项 FAIL` : '\n全部 PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL:', e.message, '\n', (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
