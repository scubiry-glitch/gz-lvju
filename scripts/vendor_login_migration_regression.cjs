#!/usr/bin/env node
/**
 * scripts/vendor_login_migration_regression.cjs —— 商家登录并入账号中心回归（2026-09-09）
 *
 * 覆盖：懒建档（accounts 无行、jz_vendors bcrypt 命中 → createAccount）→ 降级链 /vendor/me →
 *       统一链二次登录（scrypt$ 懒升级落地）→ /api/auth/login 直登 → 旧 HMAC token 宽限 →
 *       错密码 401+计数 / 非商家 403 / 停用商家 403 → 批量迁移脚本幂等 → 清理
 *
 * 用法：node scripts/vendor_login_migration_regression.cjs [base_url]   # 默认 http://127.0.0.1:8766
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
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { execFileSync } = require('child_process');

const BASE = (process.argv[2] || process.env.JUZHU_REG_BASE || 'http://127.0.0.1:8766').replace(/\/+$/, '');
const RUN = 'vlm' + process.pid;
const LOGIN_NAME = RUN + '_shop';
const PWD = 'vlm-legacy-pass-2026';

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

(async () => {
  const conn = await connectDb();
  if (!conn.config.database) throw new Error('MYSQL_*/JUZHU_DB_* env 不完整');

  // ── 造数：全新商家（bcrypt 遗留哈希，无 accounts 行）──
  const [vins] = await conn.execute(
    `INSERT INTO jz_vendors(type, name, login_name, phone, password_hash, status, review_status, created_at, updated_at)
     VALUES ('housing_operator', ?, ?, '13200000000', ?, 'active', 'approved', NOW(), NOW())`,
    ['登录迁移回归-' + RUN, LOGIN_NAME, bcrypt.hashSync(PWD, 8)]
  );
  const vid = vins.insertId;

  try {
    // ── 1. 懒建档：accounts 无行，/vendor/login 走 jz_vendors bcrypt 校验 → createAccount ──
    let r = await api('/api/juzhu/vendor/login', { method: 'POST', body: { login_name: LOGIN_NAME, password: PWD } });
    check('懒建档登录 200 且返回体形状不变', r.status === 200 && r.j.token && r.j.role === 'vendor'
      && r.j.vendor && r.j.vendor.id === vid && typeof r.j.expires_at === 'string', JSON.stringify(r.j).slice(0, 160));
    const [acc] = await conn.execute('SELECT id, vendor_id, password_hash FROM accounts WHERE login_name=?', [LOGIN_NAME]);
    check('accounts 建档（vendor_id 绑定）', acc.length === 1 && Number(acc[0].vendor_id) === vid, JSON.stringify(acc[0] || {}));
    check('建档即 scrypt（createAccount 重哈希）', String(acc[0].password_hash).startsWith('scrypt$'), acc[0].password_hash.slice(0, 20));
    const [roles] = await conn.execute('SELECT role_code, scope FROM account_roles WHERE account_id=?', [acc[0].id]);
    check('绑定 vendor_owner + vendor scope', roles.some((x) => x.role_code === 'vendor_owner')
      && roles.some((x) => String(x.scope || '').indexOf('"vendor"') >= 0), JSON.stringify(roles));
    const aid = acc[0].id;

    // ── 2. 降级链：会话 token → requestSession → {role:'vendor', vendorId} ──
    r = await api('/api/juzhu/vendor/me', { headers: { Authorization: 'Bearer ' + r.j.token } });
    check('/vendor/me 返回本商家（降级链）', r.status === 200 && r.j.role === 'vendor' && r.j.vendor.id === vid, JSON.stringify(r.j).slice(0, 120));

    // ── 3. 统一链二次登录（懒升级落地后仍成功，哈希保持 scrypt$）──
    r = await api('/api/juzhu/vendor/login', { method: 'POST', body: { login_name: LOGIN_NAME, password: PWD } });
    check('二次登录走统一链 → 200', r.status === 200 && !!r.j.token, JSON.stringify(r.j).slice(0, 100));
    const [acc2] = await conn.execute('SELECT password_hash, failed_login_count FROM accounts WHERE id=?', [aid]);
    check('哈希保持 scrypt$', String(acc2[0].password_hash).startsWith('scrypt$'));

    // ── 4. /api/auth/login 同一凭据直登（统一层天然放开）──
    r = await api('/api/auth/login', { method: 'POST', body: { login_name: LOGIN_NAME, password: PWD } });
    check('/api/auth/login 直登 → 200', r.status === 200 && !!r.j.token, JSON.stringify(r.j).slice(0, 100));
    const me2 = await api('/api/juzhu/vendor/me', { headers: { Authorization: 'Bearer ' + r.j.token } });
    check('统一会话同样是 vendor 视角', me2.status === 200 && me2.j.role === 'vendor' && me2.j.vendor.id === vid, JSON.stringify(me2.j).slice(0, 100));

    // ── 5. 旧 HMAC 自证 token 宽限期 ──
    const secret = (process.env.JUZHU_VENDOR_SECRET || '').trim() || (process.env.JUZHU_ADMIN_PASSWORD || '').trim() || 'jz-vendor-dev-secret';
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = crypto.createHmac('sha256', secret).update(`${exp}.${vid}`).digest('hex');
    const legacyToken = `${exp}.${vid}.${sig}`;
    r = await api('/api/juzhu/vendor/projects', { headers: { Authorization: 'Bearer ' + legacyToken } });
    check('旧 HMAC token 宽限仍可用（vendor projects）', r.status === 200 && r.j.role === 'vendor', JSON.stringify(r.j).slice(0, 100));

    // ── 6. 错密码 → 401 + failed_login_count 计数 ──
    r = await api('/api/juzhu/vendor/login', { method: 'POST', body: { login_name: LOGIN_NAME, password: 'wrong-pass-123' } });
    const [acc3] = await conn.execute('SELECT failed_login_count FROM accounts WHERE id=?', [aid]);
    check('错密码 401 + 失败计数', r.status === 401 && acc3[0].failed_login_count >= 1, JSON.stringify(r.j).slice(0, 80) + ' count=' + acc3[0].failed_login_count);

    // ── 7. 非商家账号走商家门 → 403 ──
    const staffLogin = await api('/api/auth/login', { method: 'POST', body: { login_name: 'staff_admin', password: 'staff-admin-2026' } });
    if (staffLogin.status === 200) {
      // staff_admin 的 login_name 在 accounts 存在且无 vendor_id → 统一链登录成功后被收口 403
      r = await api('/api/juzhu/vendor/login', { method: 'POST', body: { login_name: 'staff_admin', password: 'staff-admin-2026' } });
      check('非商家账号 403', r.status === 403 && /非商家/.test(r.j.error || ''), JSON.stringify(r.j));
    } else {
      console.log('— staff_admin 不可用，跳过非商家负例');
    }

    // ── 8. 停用商家 → 403 ──
    await conn.execute("UPDATE jz_vendors SET status='suspended' WHERE id=?", [vid]);
    r = await api('/api/juzhu/vendor/login', { method: 'POST', body: { login_name: LOGIN_NAME, password: PWD } });
    check('停用商家 403', r.status === 403 && /停用/.test(r.j.error || ''), JSON.stringify(r.j));
    await conn.execute("UPDATE jz_vendors SET status='active' WHERE id=?", [vid]);

    // ── 9. 批量迁移脚本幂等（懒建档后重跑 → 已存在，不重复建）──
    const out = execFileSync('node', [path.join(__dirname, 'vendor_accounts_migrate.cjs')], { encoding: 'utf8' });
    const tail = out.trim().split('\n').pop();
    check('迁移脚本幂等（新建 0 已存在 ≥1）', /新建 0/.test(tail) && /已存在 [1-9]/.test(tail), tail);

    // ── 10. 审计：auth.vendor.login 带 accountId ──
    const [arows] = await conn.execute(
      "SELECT account_id FROM audit_log WHERE action='auth.vendor.login' AND resource_id=? AND account_id IS NOT NULL ORDER BY id DESC LIMIT 1",
      [String(vid)]);
    check('auth.vendor.login 审计含 accountId', arows.length > 0 && arows[0].account_id === aid, JSON.stringify(arows[0] || {}));
  } finally {
    await conn.execute('DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE login_name=?)', [LOGIN_NAME]);
    await conn.execute('DELETE FROM account_roles WHERE account_id IN (SELECT id FROM accounts WHERE login_name=?)', [LOGIN_NAME]);
    await conn.execute('DELETE FROM accounts WHERE login_name=?', [LOGIN_NAME]);
    await conn.execute('DELETE FROM jz_vendors WHERE id=?', [vid]);
    await conn.end();
    console.log('\ncleanup done（回归商家/账号/会话已清）');
  }

  console.log(failed ? `\n${failed} 项 FAIL` : '\n全部 PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL:', e.message, '\n', (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
