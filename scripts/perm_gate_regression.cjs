#!/usr/bin/env node
/**
 * scripts/perm_gate_regression.cjs —— admin 域权限闸回归（perm_registry 路由细粒度化）
 *
 * 覆盖：
 *  1. 写路由权限矩阵：platform_admin 全通；operator_admin 仅 house.write 组（其余 403）；
 *     gov_viewer 全 403；匿名 401；旧全局 Key（如环境配置了）一律 403。
 *     探测全部用不存在的 id / 空 body——鉴权通过表现为 400/404/2xx，绝不产生脏数据。
 *  2. GET 收口：admin GET 不再对旧全局 Key 畅通（403）；admin.read/audit.read 按点校验。
 *  3. 评级提交 guard：账号主体须 rating.write/house.write/rating.review；gov 403。
 *  4. 细粒度审计：允许的写落 audit_log.action = registry 细粒度值（不再是 'admin.write'）。
 *  5. 清理：测试账号/会话/审计行按 RUN 前缀删除。
 *
 * 用法：node scripts/perm_gate_regression.cjs [base_url]   # 默认 http://127.0.0.1:8766
 * 凭证只读环境变量（自动加载 juzhu/.env.local / .env / runtime.env）。
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
const RUN = 'IAMREG' + process.pid;
const PID = 99999999; // 不存在的资源 id：鉴权通过 → 404，被拦 → 403

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

/** 鉴权通过后允许出现的业务状态（404=资源不存在、400=校验拒绝、2xx=成功、503=stub） */
const PASS_CODES = [200, 201, 202, 204, 400, 404, 405, 409, 503];

// [说明, method, path, body, permGroup]
const WRITE_PROBES = [
  ['PUT settings', 'PUT', `/api/juzhu/admin/settings`, {}, 'settings.write'],
  ['PUT cities/:id', 'PUT', `/api/juzhu/admin/cities/${PID}`, {}, 'dict.write'],
  ['POST districts', 'POST', `/api/juzhu/admin/districts`, {}, 'dict.write'],
  ['PUT projects/:id', 'PUT', `/api/juzhu/admin/projects/${PID}`, {}, 'house.write'],
  ['DELETE projects/:id', 'DELETE', `/api/juzhu/admin/projects/${PID}`, null, 'house.write'],
  ['PUT units/:id', 'PUT', `/api/juzhu/admin/units/${PID}`, {}, 'house.write'],
  ['POST accounts', 'POST', `/api/juzhu/admin/accounts`, {}, 'iam.write'],
  ['PUT accounts/:id', 'PUT', `/api/juzhu/admin/accounts/${PID}`, {}, 'iam.write'],
  ['POST accounts/:id/api-key', 'POST', `/api/juzhu/admin/accounts/${PID}/api-key`, {}, 'iam.key.write'],
  ['PUT idp-configs', 'PUT', `/api/juzhu/admin/idp-configs`, {}, 'iam.write'],
  ['POST ratings/:code/review', 'POST', `/api/juzhu/admin/ratings/NO-SUCH/review`, { decision: 'pass' }, 'rating.review'],
  ['POST export', 'POST', `/api/juzhu/admin/export`, {}, 'report.export'],
];
const RATING_SUBMIT = ['POST projects/:id/rating/submit', 'POST', `/api/juzhu/admin/projects/${PID}/rating/submit`, {}, 'rating.submit(guard)'];
const GET_PROBES = [
  ['GET projects', '/api/juzhu/admin/projects', 'admin.read'],
  ['GET accounts', '/api/juzhu/admin/accounts', 'admin.read'],
  ['GET dictionary', '/api/juzhu/admin/dictionary', 'admin.read'],
  ['GET audit', '/api/juzhu/admin/audit', 'audit.read'],
];

(async () => {
  const conn = await connectDb();

  // ── 平台管理员登录（login_name 从库内取，密码走 env）──
  const [paRows] = await conn.execute(
    "SELECT a.login_name FROM accounts a JOIN account_roles ar ON ar.account_id=a.id WHERE ar.role_code='platform_admin' AND a.status='active' AND a.principal_type='user' LIMIT 1");
  const adminPwd = (process.env.JUZHU_ADMIN_PASSWORD || '').trim();
  if (!paRows.length || !adminPwd) { console.error('SKIP  缺 platform_admin 账号或 JUZHU_ADMIN_PASSWORD'); process.exit(1); }
  const login = await call('/api/juzhu/admin/auth/login', 'POST', null, { login_name: paRows[0].login_name, password: adminPwd });
  if (!login.body || !login.body.token) { console.error('SKIP  管理员登录失败: ' + JSON.stringify(login.body)); process.exit(1); }
  const paToken = login.body.token;

  // ── 造 3 个测试账号并登录 ──
  async function makeAccount(role) {
    const name = RUN.toLowerCase() + '_' + role.replace(/_/g, '');
    const created = await call('/api/juzhu/admin/accounts', 'POST', paToken, {
      login_name: name, password: 'Reg-Temp-2026!', roles: [role], display_name: '回归-' + role,
    });
    if (!created.body || !created.body.account) throw new Error('建号失败 ' + role + ': ' + JSON.stringify(created.body));
    const lg = await call('/api/auth/login', 'POST', null, { login_name: name, password: 'Reg-Temp-2026!' });
    if (!lg.body || !lg.body.token) throw new Error('测试账号登录失败 ' + role);
    return { id: created.body.account.id, token: lg.body.token };
  }
  const op = await makeAccount('operator_admin');
  const gov = await makeAccount('gov_viewer');

  // ── perm_strict 模式（决定 platform_op 类 admin.write 别名是否生效；operator_admin 无 admin.write，两模式断言相同）──
  const [[strictRow]] = await conn.execute("SELECT value FROM settings WHERE `key`='perm_strict' LIMIT 1");
  const strict = String((strictRow && strictRow.value) || '0') === '1';
  console.log(`# perm_strict=${strict ? '1（严格）' : '0（过渡：admin.write 别名生效）'}`);

  // ── 1. 写矩阵 ──
  for (const [label, method, p, body, group] of WRITE_PROBES) {
    const pa = await call(p, method, paToken, body);
    check(`platform_admin ${label} 放行`, PASS_CODES.includes(pa.status), `status=${pa.status}`);
    const g = await call(p, method, gov.token, body);
    check(`gov_viewer ${label} 403`, g.status === 403, `status=${g.status}`);
    const o = await call(p, method, op.token, body);
    if (group === 'house.write') check(`operator_admin ${label} 放行（house.write 首次接闸）`, PASS_CODES.includes(o.status), `status=${o.status}`);
    else check(`operator_admin ${label} 403`, o.status === 403, `status=${o.status}`);
    const anon = await call(p, method, null, body);
    check(`匿名 ${label} 401`, anon.status === 401, `status=${anon.status}`);
  }

  // 评级提交 guard
  {
    const [, method, p, body] = RATING_SUBMIT;
    const pa = await call(p, method, paToken, body);
    check(`platform_admin ${RATING_SUBMIT[0]} 放行`, pa.status === 404, `status=${pa.status}`);
    const g = await call(p, method, gov.token, body);
    check(`gov_viewer ${RATING_SUBMIT[0]} 403`, g.status === 403, `status=${g.status}`);
    const anon = await call(p, method, null, body);
    check(`匿名 ${RATING_SUBMIT[0]} 401`, anon.status === 401, `status=${anon.status}`);
  }

  // ── 2. GET 收口 ──
  for (const [label, p] of GET_PROBES) {
    const pa = await call(p, 'GET', paToken);
    check(`platform_admin ${label} 200`, pa.status === 200, `status=${pa.status}`);
    const g = await call(p, 'GET', gov.token);
    check(`gov_viewer ${label} 403`, g.status === 403, `status=${g.status}`);
    const anon = await call(p, 'GET', null);
    check(`匿名 ${label} 401`, anon.status === 401, `status=${anon.status}`);
  }

  // 旧全局 Key：写与读一律 403（若环境未配置则跳过）
  const legacyKey = (process.env.JUZHU_API_KEY || '').trim();
  if (legacyKey) {
    const w = await call(`/api/juzhu/admin/projects/${PID}`, 'PUT', legacyKey, {});
    check('旧全局 Key 写 403', w.status === 403, `status=${w.status}`);
    const r = await call('/api/juzhu/admin/projects', 'GET', legacyKey);
    check('旧全局 Key 管理读 403（GET 收口）', r.status === 403, `status=${r.status}`);
  } else {
    console.log('# 未配置 JUZHU_API_KEY，跳过 legacy Key 断言');
  }

  // ── 3. 细粒度审计 ──
  const [[accRow]] = await conn.execute('SELECT id FROM accounts WHERE login_name=? LIMIT 1', [paRows[0].login_name]);
  const [auditRows] = await conn.execute(
    "SELECT action, resource, resource_id FROM audit_log WHERE account_id=? AND resource_id=? ORDER BY id DESC LIMIT 5",
    [accRow.id, String(PID)]
  );
  check('细粒度审计 project.update 落表', auditRows.some((r) => r.action === 'project.update' && r.resource === 'projects'),
    JSON.stringify(auditRows));
  const [[legacyAudit]] = await conn.execute(
    "SELECT COUNT(*) n FROM audit_log WHERE account_id=? AND action='admin.write' AND resource_id=?", [accRow.id, String(PID)]);
  check('注册路由不再产生 admin.write 粗粒度审计', legacyAudit.n === 0, `count=${legacyAudit.n}`);

  // ── 4. 清理 ──
  for (const a of [op, gov]) {
    await conn.execute('DELETE FROM sessions WHERE account_id=?', [a.id]);
    await conn.execute('DELETE FROM account_roles WHERE account_id=?', [a.id]);
    await conn.execute('DELETE FROM audit_log WHERE account_id=?', [a.id]);
    await conn.execute('DELETE FROM accounts WHERE id=?', [a.id]);
  }
  await conn.end();
  console.log(`# 清理完成（测试账号 ${RUN}_*）`);
  console.log(failed ? `\nFAIL：${failed} 项未通过` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
