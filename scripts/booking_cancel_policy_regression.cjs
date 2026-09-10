#!/usr/bin/env node
/**
 * scripts/booking_cancel_policy_regression.cjs —— 房型级免费取消政策回归（口径 2026-09-09）
 *
 * 直播链路：units/stay-calendar 下发 cancel_policy* → 下单回显退改口径 →
 *   窗口内取消成功（释放房态）/ 窗口外与未开通取消被拒 →
 *   vendor 会话 PUT units/:id 与 HMAC units/update 两路写政策（含非法值负例与 ext 键保留）→
 *   booking/my、booking/lookup 随单下发 can_cancel → 清理
 *
 * 用法：node scripts/booking_cancel_policy_regression.cjs [base_url]   # 默认 http://127.0.0.1:8766
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
const hmac = require('../hmac_auth.cjs');
const mysql = require('mysql2/promise');

const BASE = (process.argv[2] || process.env.JUZHU_REG_BASE || 'http://127.0.0.1:8766').replace(/\/+$/, '');
const RUN = 'cprg' + process.pid;
const TEMP_PWD = 'Cprg-temp-2026!';

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  if (!cond) failed++;
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
    "SELECT id, name, hmac_key, type, password_hash FROM jz_vendors WHERE hmac_key IS NOT NULL AND hmac_key <> '' AND status='active' ORDER BY id");
  if (!rows.length) throw new Error('库中无可用 vendor hmac_key（先在 jz_vendors 配置 hmac_key）');
  return rows.find((r) => r.type === 'housing_operator') || rows[0];
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
  const vendor = await pickVendor(conn);
  const [cities] = await conn.execute('SELECT id FROM cities ORDER BY id LIMIT 1');
  const cityId = cities.length ? cities[0].id : 1;
  const phone = '138' + String(10000000 + (process.pid % 89999999)).slice(0, 8);
  const tenantPhone = '139' + String(10000000 + (process.pid % 89999999)).slice(0, 8);
  const checkin = dateStr(3);          // 免费窗口（前一天 18:00）必然在未来
  const checkout = dateStr(3 + 15);    // rental 频道默认连住 15 晚
  console.log(`vendor: #${vendor.id} ${vendor.name}（${vendor.type}）· 测试手机 ${phone} · 入住 ${checkin}\n`);

  // ── 造数：已开通按晚预订的 rental 项目 + 3 房型（A 默认窗口 / B 已过窗口 / C 未开通）──
  const projExt = JSON.stringify({ stay_bookable: true });
  const [pins] = await conn.execute(
    `INSERT INTO projects(city_id, channel, name, slug, address, tags, status, rating_status, owner_vendor_id, ext, unit_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [cityId, 'rental', '取消政策回归-' + RUN, RUN, '回归测试地址', JSON.stringify(['演示']), 'online', 'passed', vendor.id, projExt, 3]
  );
  const pid = pins.insertId;
  async function addUnit(slug, name, extObj) {
    const [u] = await conn.execute(
      `INSERT INTO units(project_id, name, slug, rent_monthly, tags, ext) VALUES (?,?,?,?,?,?)`,
      [pid, name, slug, 3000, JSON.stringify(['演示']), extObj ? JSON.stringify(extObj) : null]
    );
    return u.insertId;
  }
  const unitA = await addUnit('a', '窗口内·前一晚18点', { cancel_policy: { enabled: true, days_before: 1, cutoff_time: '18:00' } });
  const unitB = await addUnit('b', '窗口外·30天前已过', { cancel_policy: { enabled: true, days_before: 30, cutoff_time: '18:00' }, price_night: 123 });
  const unitC = await addUnit('c', '未开通免费取消', { price_night: 128 });
  const textA = '入住前一天 18:00 前可免费取消，之后不可取消';
  const textB = '入住日前 30 天 18:00 前可免费取消，之后不可取消';
  const textNone = '预订成功后不可取消';

  const oldVendorHash = vendor.password_hash;
  let accBefore = [];   // accounts 原哈希（finally 还原；登录并入账号中心后统一链认 accounts）
  try {
    // ── 1. units 接口逐房型下发政策与文案 ──
    const unitsRes = await api('/api/juzhu/projects/' + pid + '/units');
    const U = {};
    (unitsRes.j.units || []).forEach((u) => { U[u.id] = u; });
    check('units 接口 200 且 3 房型齐全', unitsRes.status === 200 && Object.keys(U).length === 3);
    check('A 下发默认窗口政策', U[unitA] && U[unitA].cancel_policy.enabled === true && U[unitA].cancel_policy.days_before === 1 && U[unitA].cancel_policy.cutoff_time === '18:00');
    check('A 文案（入住前一天 18:00）', U[unitA] && U[unitA].cancel_policy_text === textA, U[unitA] && U[unitA].cancel_policy_text);
    check('B 文案（入住日前 30 天）', U[unitB] && U[unitB].cancel_policy_text === textB, U[unitB] && U[unitB].cancel_policy_text);
    check('C 未开通 → 从严文案', U[unitC] && U[unitC].cancel_policy.enabled === false && U[unitC].cancel_policy_text === textNone, U[unitC] && U[unitC].cancel_policy_text);

    // ── 2. stay-calendar 批量形状逐房型带政策 ──
    const calRes = await api('/api/juzhu/projects/' + pid + '/stay-calendar?month=' + checkin.slice(0, 7) + '&units=' + [unitA, unitB, unitC].join(','));
    const calMap = {};
    ((calRes.j || {}).units || []).forEach((u) => { calMap[u.unit_id] = u; });
    check('stay-calendar 批量带 cancel_policy', calMap[unitA] && calMap[unitA].cancel_policy.enabled === true && calMap[unitC].cancel_policy.enabled === false);
    check('stay-calendar 单房型带政策', await (async () => {
      const one = await api('/api/juzhu/projects/' + pid + '/stay-calendar?month=' + checkin.slice(0, 7) + '&unit_id=' + unitA);
      return one.status === 200 && one.j.cancel_policy && one.j.cancel_policy.enabled === true && one.j.cancel_policy_text === textA;
    })());

    // ── 3. 整栋单（unit_id 空）：须全项目空闲，先订先取消；政策按项目首个房型（A，已开通）回退 ──
    const cancel = (orderNo, contactPhone) => api('/api/juzhu/booking/cancel', { method: 'POST', body: { order_no: orderNo, contact_phone: contactPhone } });
    const bookWhole = await api('/api/juzhu/booking', {
      method: 'POST',
      body: { project_id: pid, checkin, checkout, contact_name: '回归', contact_phone: phone, idempotency_key: RUN + '-whole' },
    });
    check('整栋单回退首个房型政策 can_cancel=true', bookWhole.status === 200 && bookWhole.j.can_cancel === true && bookWhole.j.cancel_policy_text === textA,
      JSON.stringify(bookWhole.j).slice(0, 160));
    const cancelWhole = await cancel(bookWhole.j.order_no, phone);
    check('整栋单窗口内取消成功（释放整项目房态）', cancelWhole.status === 200 && cancelWhole.j.ok === true);

    // ── 4. 下单回显退改口径 + can_cancel ──
    const book = async (unitId, contactPhone, headers) => api('/api/juzhu/booking', {
      method: 'POST', headers,
      body: { project_id: pid, unit_id: unitId, checkin, checkout, contact_name: '回归', contact_phone: contactPhone, idempotency_key: RUN + '-' + unitId + '-' + contactPhone },
    });
    const bookA = await book(unitA, phone);
    check('A 下单成功且 can_cancel=true', bookA.status === 200 && bookA.j.can_cancel === true && bookA.j.cancel_policy_text === textA, JSON.stringify(bookA.j).slice(0, 160));
    const bookB = await book(unitB, phone);
    check('B 下单成功且 can_cancel=false（窗口已过）', bookB.status === 200 && bookB.j.can_cancel === false);
    const bookC = await book(unitC, phone);
    check('C 下单成功且 can_cancel=false（未开通）', bookC.status === 200 && bookC.j.can_cancel === false && bookC.j.cancel_policy_text === textNone);

    // ── 4. 取消闸 ──
    const cancelA = await cancel(bookA.j.order_no, phone);
    const [scLeft] = await conn.execute('SELECT COUNT(*) n FROM stay_calendar WHERE booking_id IN (SELECT id FROM booking_orders WHERE order_no=?)', [bookA.j.order_no]);
    check('A 窗口内取消成功', cancelA.status === 200 && cancelA.j.ok === true);
    check('A 取消后房态释放（booked 行清空）', scLeft[0].n === 0, '残留 ' + scLeft[0].n + ' 行');
    const cancelB = await cancel(bookB.j.order_no, phone);
    check('B 窗口外取消被拒（硬截止）', cancelB.status === 400 && String(cancelB.j.error).includes('已超过免费取消截止时间'), JSON.stringify(cancelB.j));
    const cancelC = await cancel(bookC.j.order_no, phone);
    check('C 未开通取消被拒', cancelC.status === 400 && String(cancelC.j.error).includes('未开通免费取消'), JSON.stringify(cancelC.j));

    // ── 5. lookup / my 随单下发 can_cancel ──
    const look = await api('/api/juzhu/booking/lookup', { method: 'POST', body: { order_no: bookA.j.order_no, contact_phone: phone } });
    check('lookup 回显政策与已取消态', look.status === 200 && look.j.order.status === 'cancelled' && look.j.order.cancel_policy_text === textA && look.j.order.can_cancel === false);
    const tenantLogin = await api('/api/juzhu/auth/tenant', { method: 'POST', body: { phone: tenantPhone, password: 'cprg-pass-2026' } });
    const tok = tenantLogin.j && tenantLogin.j.token;
    check('租客 JIT 登录', tenantLogin.status === 200 && !!tok, JSON.stringify(tenantLogin.j).slice(0, 120));
    const bookA2 = await book(unitA, tenantPhone, { Authorization: 'Bearer ' + tok });
    const my = await api('/api/juzhu/booking/my', { headers: { Authorization: 'Bearer ' + tok } });
    const mine = (my.j.items || []).filter((x) => x.order_no === bookA2.j.order_no)[0];
    check('my 下单归属 + can_cancel=true + 政策文案', !!mine && mine.can_cancel === true && mine.cancel_policy_text === textA, JSON.stringify(mine || {}).slice(0, 160));

    // ── 6. vendor 会话写（read-modify-write 保留 price_night）──
    // 登录已并入账号中心：accounts 与 jz_vendors 两边都要写临时口令（统一链认 accounts）
    const authCenter = require('../auth_center.cjs');
    [accBefore] = await conn.execute('SELECT id, password_hash FROM accounts WHERE vendor_id=? AND principal_type="user"', [vendor.id]);
    await conn.execute('UPDATE jz_vendors SET password_hash=? WHERE id=?', [bcrypt.hashSync(TEMP_PWD, 8), vendor.id]);
    if (accBefore.length) {
      await conn.execute('UPDATE accounts SET password_hash=? WHERE id=?', [await authCenter.hashPassword(TEMP_PWD), accBefore[0].id]);
    }
    const vlogin = await api('/api/juzhu/vendor/login', { method: 'POST', body: { login_name: (await conn.execute('SELECT login_name FROM jz_vendors WHERE id=?', [vendor.id]))[0][0].login_name, password: TEMP_PWD } });
    const vtok = vlogin.j && vlogin.j.token;
    check('vendor 会话登录', vlogin.status === 200 && !!vtok, JSON.stringify(vlogin.j).slice(0, 120));
    const vput = await api('/api/juzhu/vendor/units/' + unitB, { method: 'PUT', headers: { Authorization: 'Bearer ' + vtok }, body: { cancel_policy: { enabled: true, days_before: 0, cutoff_time: '12:00' } } });
    const afterVput = await api('/api/juzhu/projects/' + pid + '/units');
    const uB = (afterVput.j.units || []).filter((u) => u.id === unitB)[0];
    check('vendor 会话 PUT 政策生效（入住当天 12:00）', vput.status === 200 && uB && uB.cancel_policy.days_before === 0 && uB.cancel_policy.cutoff_time === '12:00', JSON.stringify(uB && uB.cancel_policy));
    check('vendor 会话 PUT 保留 ext.price_night', uB && uB.ext && uB.ext.price_night === 123, JSON.stringify(uB && uB.ext));
    const vputBad = await api('/api/juzhu/vendor/units/' + unitB, { method: 'PUT', headers: { Authorization: 'Bearer ' + vtok }, body: { cancel_policy: { enabled: true, days_before: 31, cutoff_time: '18:00' } } });
    const vputBad2 = await api('/api/juzhu/vendor/units/' + unitB, { method: 'PUT', headers: { Authorization: 'Bearer ' + vtok }, body: { cancel_policy: { enabled: true, days_before: 1, cutoff_time: '25:00' } } });
    check('非法天数/时刻被 400', vputBad.status === 400 && vputBad2.status === 400, vputBad.status + '/' + vputBad2.status);
    const vputNull = await api('/api/juzhu/vendor/units/' + unitB, { method: 'PUT', headers: { Authorization: 'Bearer ' + vtok }, body: { cancel_policy: null } });
    const uBUnits = (await api('/api/juzhu/projects/' + pid + '/units')).j.units || [];
    const uB2 = uBUnits.filter((u) => u.id === unitB)[0];
    check('null 清除政策 → 回落不可取消', vputNull.status === 200 && uB2 && uB2.cancel_policy.enabled === false && uB2.cancel_policy_text === textNone, JSON.stringify(uB2 && uB2.cancel_policy));

    // ── 7. HMAC units/update 写（与 vendor 会话同口径，完整签名链路）──
    const signed = (payload) => hmac.generateSignature(vendor.hmac_key, Object.assign({ vendor_id: vendor.id }, payload));
    const hmacSet = async (payload) => {
      const sign = signed(payload);
      const r = await fetch(BASE + '/api/juzhu/housing/vendor/units/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, payload, sign)),
      });
      let j = null; try { j = await r.json(); } catch (_) {}
      return { status: r.status, j };
    };
    const hOk = await hmacSet({ id: unitC, cancel_policy: { enabled: true, days_before: 2, cutoff_time: '12:30' } });
    const uC = (await api('/api/juzhu/projects/' + pid + '/units')).j.units.filter((u) => u.id === unitC)[0];
    check('HMAC 写政策生效（2 天 12:30）', hOk.status === 200 && uC.cancel_policy.days_before === 2 && uC.cancel_policy.cutoff_time === '12:30'
      && uC.cancel_policy_text === '入住日前 2 天 12:30 前可免费取消，之后不可取消', JSON.stringify(uC.cancel_policy));
    check('HMAC 写保留 ext.price_night', uC.ext && uC.ext.price_night === 128, JSON.stringify(uC.ext));
    const hBad = await hmacSet({ id: unitC, cancel_policy: { enabled: true, cutoff_time: '6pm' } });
    check('HMAC 非法时刻 400', hBad.status === 400 && String(hBad.j.message || '').includes('cutoff_time'), JSON.stringify(hBad.j));
  } finally {
    // ── 清理：订单/房态/房型/项目/租客账号；商家口令还原 ──
    await conn.execute('UPDATE jz_vendors SET password_hash=? WHERE id=?', [oldVendorHash, vendor.id]);
    if (accBefore.length) {
      await conn.execute('UPDATE accounts SET password_hash=? WHERE id=?', [accBefore[0].password_hash, accBefore[0].id]);
    }
    await conn.execute('DELETE FROM booking_orders WHERE project_id=?', [pid]);
    await conn.execute('DELETE FROM stay_calendar WHERE project_id=?', [pid]);
    await conn.execute('DELETE FROM units WHERE project_id=?', [pid]);
    await conn.execute('DELETE FROM projects WHERE id=?', [pid]);
    try {
      await conn.execute('DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE login_name=?)', [tenantPhone]);
      await conn.execute('DELETE FROM accounts WHERE login_name=?', [tenantPhone]);
    } catch (_) { /* 租客账号清理失败不影响结论 */ }
    await conn.end();
    console.log('\ncleanup done（vendor 口令已还原，回归数据已清）');
  }

  console.log(failed ? `\n${failed} 项 FAIL` : '\n全部 PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
