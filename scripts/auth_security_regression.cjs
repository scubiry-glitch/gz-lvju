#!/usr/bin/env node
/**
 * scripts/auth_security_regression.cjs —— 登录防爆破 / 审计 result / 枚举修复回归
 *
 * 覆盖（B2）：
 *  1. 连错 5 次 → 429 + accounts 置 locked/locked_until + audit_log 出现 auth.login.lock
 *  2. 锁定期内正确密码仍 429；admin PUT status=active 解锁后立即恢复登录
 *  3. 不存在的账号连打 → ident 节流 429，且 audit_log 落 result='fail'（账号不存在也留痕）
 *  4. audit() 的 result 列真实落库（ok/fail）
 *  5. admin 登录只传 password → 400（枚举面移除）
 *  6. tenant 注册后立即发会话；错误密码只计一次失败（双调用修复）
 *  7. scrypt 迁移：新号 password_hash 前缀 scrypt$；存量 sha256 行登录成功并懒升级（B3 后生效）
 *
 * 用法：node scripts/auth_security_regression.cjs [base_url]
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
const RUN = 'IAMSEC' + process.pid;
const START_ISO = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  if (!cond) failed++;
}

function connectDb() {
  const host = (process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '').trim();
  const db = (process.env.MYSQL_DB || process.env.JUZHU_DB_NAME || '').trim();
  const user = (process.env.MYSQL_USER || process.env.JUZHU_DB_USER || '').trim();
  const password = process.env.MYSQL_PASSWORD ?? process.env.JUZHU_DB_PASSWORD;
  if (!host || !db || !user || password == null || password === '') throw new Error('MYSQL_* env 不完整');
  return mysql.createConnection({ host, port: parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10), database: db, user, password, connectTimeout: 8000 });
}

async function call(pathname, method, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (_) { /* ignore */ }
  return { status: r.status, body: j };
}

(async () => {
  const conn = await connectDb();

  // 管理员登录（显式 login_name）
  const [paRows] = await conn.execute(
    "SELECT a.login_name FROM accounts a JOIN account_roles ar ON ar.account_id=a.id WHERE ar.role_code='platform_admin' AND a.status='active' AND a.principal_type='user' LIMIT 1");
  const adminPwd = (process.env.JUZHU_ADMIN_PASSWORD || '').trim();
  if (!paRows.length || !adminPwd) { console.error('SKIP  缺 platform_admin 或 JUZHU_ADMIN_PASSWORD'); process.exit(1); }
  const adminLoginName = paRows[0].login_name;

  // 5. 只传 password → 400
  const pwdOnly = await call('/api/juzhu/admin/auth/login', 'POST', null, { password: adminPwd });
  check('admin 登录只传 password → 400（枚举面移除）', pwdOnly.status === 400, `status=${pwdOnly.status}`);
  const paLogin = await call('/api/juzhu/admin/auth/login', 'POST', null, { login_name: adminLoginName, password: adminPwd });
  check('admin 显式账号登录 200', paLogin.status === 200 && paLogin.body.token, `status=${paLogin.status}`);
  const paToken = paLogin.body && paLogin.body.token;

  // 建测试账号
  const accName = RUN.toLowerCase();
  const created = await call('/api/juzhu/admin/accounts', 'POST', paToken, {
    login_name: accName, password: 'Sec-Reg-2026!', roles: ['operator_dispatcher'], display_name: '安全回归',
  });
  check('测试账号创建', (created.status === 200 || created.status === 201) && created.body.account, `status=${created.status} body=${JSON.stringify(created.body).slice(0, 200)}`);
  const accId = created.body.account.id;

  // 1. 连错 5 次 → 401×5 → 429
  let lastResp = null;
  for (let i = 0; i < 5; i++) {
    lastResp = await call('/api/auth/login', 'POST', null, { login_name: accName, password: 'wrong-' + i });
    check(`错误密码第 ${i + 1} 次 → 401`, lastResp.status === 401, `status=${lastResp.status}`);
  }
  const locked = await call('/api/auth/login', 'POST', null, { login_name: accName, password: 'wrong-again' });
  check('第 6 次 → 429 + retry_after', locked.status === 429 && locked.body.retry_after > 0, `status=${locked.status} body=${JSON.stringify(locked.body)}`);
  const [accRows] = await conn.execute('SELECT status, locked_until, failed_login_count FROM accounts WHERE id=?', [accId]);
  check('accounts 置 locked + 计数 5', accRows[0].status === 'locked' && accRows[0].failed_login_count >= 5 && !!accRows[0].locked_until,
    JSON.stringify(accRows[0]));
  const [lockAudit] = await conn.execute("SELECT COUNT(*) n FROM audit_log WHERE action='auth.login.lock' AND created_at >= ?", [START_ISO]);
  check('audit_log 出现 auth.login.lock', lockAudit[0].n > 0, `count=${lockAudit[0].n}`);

  // 2. 锁定期内正确密码 → 429
  const during = await call('/api/auth/login', 'POST', null, { login_name: accName, password: 'Sec-Reg-2026!' });
  check('锁定期内正确密码仍 429', during.status === 429, `status=${during.status}`);

  // admin 解锁（status 改回 active 清锁定态）
  const unlock = await call('/api/juzhu/admin/accounts/' + accId, 'PUT', paToken, { status: 'active' });
  check('admin 解锁 200', unlock.status === 200, `status=${unlock.status} body=${JSON.stringify(unlock.body && unlock.body.error)}`);
  const [afterUnlock] = await conn.execute('SELECT status, locked_until, failed_login_count FROM accounts WHERE id=?', [accId]);
  check('解锁后 locked_until 清空、计数清零', afterUnlock[0].status === 'active' && !afterUnlock[0].locked_until && afterUnlock[0].failed_login_count === 0,
    JSON.stringify(afterUnlock[0]));
  const relg = await call('/api/auth/login', 'POST', null, { login_name: accName, password: 'Sec-Reg-2026!' });
  check('解锁后正确密码登录恢复', relg.status === 200 && relg.body.token, `status=${relg.status} body=${JSON.stringify(relg.body).slice(0, 120)}`);

  // 4. audit result 列落库
  const [okRows] = await conn.execute("SELECT result, COUNT(*) n FROM audit_log WHERE action='auth.login' AND created_at >= ? GROUP BY result", [START_ISO]);
  const byResult = Object.fromEntries(okRows.map((r) => [r.result || '(null)', r.n]));
  check("审计 result='ok' 落库", (byResult.ok || 0) > 0, JSON.stringify(byResult));
  check("审计 result='fail' 落库", (byResult.fail || 0) > 0, JSON.stringify(byResult));

  // 3. 不存在账号连打 → ident 节流 + 审计留痕（resourceId=输入串、无 account_id）
  const ghost = RUN.toLowerCase() + '_ghost';
  let ghostStatus = 0;
  for (let i = 0; i < 6; i++) ghostStatus = (await call('/api/auth/login', 'POST', null, { login_name: ghost, password: 'x' })).status;
  check('不存在账号第 6 次 → 429（枚举被拦）', ghostStatus === 429, `status=${ghostStatus}`);
  const [ghostAudit] = await conn.execute(
    "SELECT COUNT(*) n FROM audit_log WHERE action='auth.login' AND result='fail' AND account_id IS NULL AND resource_id=? AND created_at >= ?",
    [ghost, START_ISO]);
  check('账号不存在也落 fail 审计', ghostAudit[0].n > 0, `count=${ghostAudit[0].n}`);

  // 6. tenant：注册即发会话；错误密码只计一次
  const phone = '138' + String(process.pid).padStart(8, '0').slice(-8);
  const t1 = await call('/api/juzhu/auth/tenant', 'POST', null, { phone, password: 'Tenant-2026!', name: '安全回归租客' });
  check('tenant 注册即返回 token', t1.status === 200 && t1.body.token, `status=${t1.status}`);
  const t2 = await call('/api/juzhu/auth/tenant', 'POST', null, { phone, password: 'Totally-Wrong!' });
  check('tenant 已注册+错误密码 → 401', t2.status === 401, `status=${t2.status}`);
  const [tAcc] = await conn.execute('SELECT id, failed_login_count FROM accounts WHERE login_name=?', ['u' + phone]);
  check('tenant 错误密码只计一次失败（双调用修复）', tAcc.length && tAcc[0].failed_login_count === 1, `count=${tAcc.length ? tAcc[0].failed_login_count : 'n/a'}`);

  // 7. scrypt：新号前缀 scrypt$；人为降级为存量 sha256 格式后登录应成功并懒升级
  const [hashRow] = await conn.execute('SELECT password_hash FROM accounts WHERE id=?', [accId]);
  check('新账号密码哈希为 scrypt 格式', String(hashRow[0].password_hash).startsWith('scrypt$'), String(hashRow[0].password_hash).slice(0, 20));
  {
    const crypto = require('crypto');
    const salt = crypto.randomBytes(8).toString('hex');
    const goodLegacy = salt + ':' + crypto.createHash('sha256').update(salt + ':' + 'Sec-Reg-2026!').digest('hex');
    await conn.execute('UPDATE accounts SET password_hash=?, failed_login_count=0, locked_until=NULL, status=\'active\' WHERE id=?', [goodLegacy, accId]);
    const relogin = await call('/api/auth/login', 'POST', null, { login_name: accName, password: 'Sec-Reg-2026!' });
    check('存量 sha256 行登录成功（格式兼容）', relogin.status === 200, `status=${relogin.status}`);
    const [upgraded] = await conn.execute('SELECT password_hash FROM accounts WHERE id=?', [accId]);
    check('登录后懒升级为 scrypt 格式', String(upgraded[0].password_hash).startsWith('scrypt$'), String(upgraded[0].password_hash).slice(0, 20));
  }

  // ── 清理 ──
  await conn.execute('DELETE FROM sessions WHERE account_id=?', [accId]);
  await conn.execute('DELETE FROM account_roles WHERE account_id=?', [accId]);
  await conn.execute('DELETE FROM accounts WHERE id=?', [accId]);
  await conn.execute('DELETE FROM accounts WHERE login_name=?', ['u' + phone]);
  await conn.execute("DELETE FROM audit_log WHERE (account_id IN (SELECT id FROM accounts WHERE login_name LIKE ?)) OR (action='auth.login' AND created_at >= ? AND (resource_id LIKE ? OR resource_id LIKE ? OR resource_id IN (?,?)))",
    [RUN.toLowerCase() + '%', START_ISO, accName, ghost, accName, ghost]);
  await conn.execute('DELETE FROM audit_log WHERE created_at >= ? AND action IN (?,?)', [START_ISO, 'auth.login.lock', 'account.create']);
  await conn.execute('DELETE FROM login_throttle WHERE updated_at >= ?', [START_ISO]);
  await conn.end();
  console.log('# 清理完成');
  console.log(failed ? `\nFAIL：${failed} 项未通过` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
