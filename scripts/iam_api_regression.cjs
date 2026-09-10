#!/usr/bin/env node
/**
 * scripts/iam_api_regression.cjs —— 账号中心管理面 API 回归（B5）
 *
 * 覆盖：permissions 矩阵 / iam overview / roles CRUD（含负例：builtin 拒改删、未知权限点、
 * '*' 红线、被引用拒删）/ orgs 列表与维护 / sessions 列表与吊销 / audit 增强过滤 /
 * accounts 过滤（q/status/role_code）
 *
 * 用法：node scripts/iam_api_regression.cjs [base_url]
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
const RUN = 'IAMAPI' + process.pid;

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
  const [paRows] = await conn.execute(
    "SELECT a.login_name FROM accounts a JOIN account_roles ar ON ar.account_id=a.id WHERE ar.role_code='platform_admin' AND a.status='active' AND a.principal_type='user' LIMIT 1");
  const adminPwd = (process.env.JUZHU_ADMIN_PASSWORD || '').trim();
  if (!paRows.length || !adminPwd) { console.error('SKIP  缺 platform_admin 或 JUZHU_ADMIN_PASSWORD'); process.exit(1); }
  const paLogin = await call('/api/juzhu/admin/auth/login', 'POST', null, { login_name: paRows[0].login_name, password: adminPwd });
  const paToken = paLogin.body && paLogin.body.token;
  if (!paToken) { console.error('SKIP  管理员登录失败'); process.exit(1); }

  // permissions 矩阵
  const perms = await call('/api/juzhu/admin/permissions', 'GET', paToken);
  check('GET permissions 200 且含目录+角色', perms.status === 200 && Array.isArray(perms.body.perms) && Array.isArray(perms.body.roles), `status=${perms.status}`);
  check('权限点目录含 account.manage（预留不接路由）', perms.body.perms.some((p) => p.code === 'account.manage'), '');
  check('角色矩阵含内置标记', perms.body.roles.some((r) => r.role_code === 'platform_admin' && r.builtin === true), '');

  // overview
  const ov = await call('/api/juzhu/admin/iam/overview', 'GET', paToken);
  check('GET iam/overview 200 且字段齐全', ov.status === 200 && typeof ov.body.accounts_total === 'number' && typeof ov.body.login_failed_24h === 'number', `status=${ov.status}`);

  // roles CRUD
  const code = RUN.toLowerCase() + '_tester';
  const created = await call('/api/juzhu/admin/roles', 'POST', paToken, { role_code: code, name: '回归自定义角色', permissions: ['admin.read', 'org.read'] });
  check('POST roles 200', created.status === 200 && created.body.role_code === code, `status=${created.status} ${JSON.stringify(created.body.error)}`);
  const negUnknown = await call('/api/juzhu/admin/roles', 'POST', paToken, { role_code: code + 'x', name: 'x', permissions: ['no.such.perm'] });
  check('未知权限点拒绝', negUnknown.status === 400, `status=${negUnknown.status}`);
  const negStar = await call('/api/juzhu/admin/roles', 'POST', paToken, { role_code: code + 'y', name: 'y', permissions: ['*'] });
  check("自定义角色含 '*' 拒绝", negStar.status === 400, `status=${negStar.status}`);
  const negBuiltinPut = await call('/api/juzhu/admin/roles/platform_op', 'PUT', paToken, { permissions: [] });
  check('内置角色拒改', negBuiltinPut.status === 400, `status=${negBuiltinPut.status}`);
  const negBuiltinDel = await call('/api/juzhu/admin/roles/platform_op', 'DELETE', paToken);
  check('内置角色拒删', negBuiltinDel.status === 400, `status=${negBuiltinDel.status}`);
  const upd = await call('/api/juzhu/admin/roles/' + code, 'PUT', paToken, { permissions: ['admin.read'] });
  check('PUT 自定义角色生效', upd.status === 200 && upd.body.permissions.length === 1, `status=${upd.status}`);

  // 自定义角色可用于建号 + 被引用拒删
  const accWithRole = await call('/api/juzhu/admin/accounts', 'POST', paToken, {
    login_name: RUN.toLowerCase() + '_user', password: 'Iam-Reg-2026!', roles: [code],
  });
  check('自定义角色可建号', accWithRole.status === 200 || accWithRole.status === 201, `status=${accWithRole.status}`);
  const delRefused = await call('/api/juzhu/admin/roles/' + code, 'DELETE', paToken);
  check('被引用角色拒删', delRefused.status === 400, `status=${delRefused.status}`);

  // accounts 过滤
  const byRole = await call('/api/juzhu/admin/accounts?role_code=' + code, 'GET', paToken);
  check('accounts?role_code 过滤', byRole.status === 200 && Array.isArray(byRole.body) && byRole.body.some((a) => a.account.login_name === RUN.toLowerCase() + '_user'), '');
  const byQ = await call('/api/juzhu/admin/accounts?q=' + RUN.toLowerCase() + '_user', 'GET', paToken);
  check('accounts?q= 模糊过滤', byQ.status === 200 && Array.isArray(byQ.body) && byQ.body.length >= 1, '');

  // orgs
  await conn.execute('INSERT INTO orgs(org_no, org_type, name, status, created_at, updated_at) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)',
    ['ORG-' + RUN, 'operator', 'iam回归机构', 'active', new Date().toISOString(), new Date().toISOString()]);
  const [[orgRow]] = await conn.execute('SELECT id FROM orgs WHERE org_no=?', ['ORG-' + RUN]);
  const orgs = await call('/api/juzhu/admin/orgs', 'GET', paToken);
  check('GET orgs 200 且 city_ids 解析为数组', orgs.status === 200 && Array.isArray(orgs.body) && orgs.body.every((o) => Array.isArray(o.city_ids)), '');
  const orgUpd = await call('/api/juzhu/admin/orgs/' + orgRow.id, 'PUT', paToken, { city_ids: [1, 2] });
  check('PUT orgs/:id 维护 city_ids', orgUpd.status === 200 && JSON.stringify(orgUpd.body.city_ids) === '[1,2]', `status=${orgUpd.status} ${JSON.stringify(orgUpd.body.error)}`);

  // sessions 列表/吊销
  const accId = accWithRole.body.account.id;
  await call('/api/auth/login', 'POST', null, { login_name: RUN.toLowerCase() + '_user', password: 'Iam-Reg-2026!' });
  const sessions = await call(`/api/juzhu/admin/accounts/${accId}/sessions`, 'GET', paToken);
  check('GET sessions 列表（不含 token 原文）', sessions.status === 200 && sessions.body.length >= 1 && !sessions.body[0].token_hash, `status=${sessions.status}`);
  const revoke = await call(`/api/juzhu/admin/accounts/${accId}/sessions`, 'DELETE', paToken);
  check('DELETE 全部下线', revoke.status === 200 && revoke.body.revoked >= 1, `status=${revoke.status}`);
  const meAfter = await call('/api/auth/me', 'GET', (await call('/api/auth/login', 'POST', null, { login_name: RUN.toLowerCase() + '_user', password: 'Iam-Reg-2026!' })).body.token);
  const jti = sessions.body[0].jti;

  // audit 增强
  const auditByResult = await call('/api/juzhu/admin/audit?result=fail&limit=5', 'GET', paToken);
  check('audit?result=fail 过滤', auditByResult.status === 200 && Array.isArray(auditByResult.body), '');
  const auditByAction = await call('/api/juzhu/admin/audit?action=account.&limit=5', 'GET', paToken);
  check('audit?action= 前缀过滤', auditByAction.status === 200 && auditByAction.body.every((r) => String(r.action).startsWith('account.')), auditByAction.status + '/' + auditByAction.body.length);

  // 解锁（unlock=1）
  await call('/api/auth/login', 'POST', null, { login_name: RUN.toLowerCase() + '_user', password: 'totally-wrong' });
  const unlock = await call('/api/juzhu/admin/accounts/' + accId, 'PUT', paToken, { unlock: 1 });
  check('PUT accounts/:id unlock=1', unlock.status === 200, `status=${unlock.status}`);

  // 角色删除（解除引用后）
  await call('/api/juzhu/admin/accounts/' + accId, 'PUT', paToken, { roles: ['user'] });
  const delOk = await call('/api/juzhu/admin/roles/' + code, 'DELETE', paToken);
  check('解除引用后可删角色', delOk.status === 200, `status=${delOk.status} ${JSON.stringify(delOk.body.error)}`);
  void meAfter; void jti;

  // ── 清理 ──
  await conn.execute('DELETE FROM audit_log WHERE account_id=?', [accId]);
  await conn.execute('DELETE FROM sessions WHERE account_id=?', [accId]);
  await conn.execute('DELETE FROM account_roles WHERE account_id=?', [accId]);
  await conn.execute('DELETE FROM accounts WHERE id=?', [accId]);
  await conn.execute('DELETE FROM roles WHERE role_code LIKE ? AND builtin=0', [RUN.toLowerCase() + '%']);
  await conn.execute('DELETE FROM orgs WHERE org_no=?', ['ORG-' + RUN]);
  await conn.end();
  console.log('# 清理完成');
  console.log(failed ? `\nFAIL：${failed} 项未通过` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
