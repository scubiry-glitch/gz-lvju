#!/usr/bin/env node
/**
 * scripts/scope_regression.cjs —— 数据权限（scope）行级过滤回归
 *
 * 覆盖（B4）：
 *  1. org/report：city 档只见授权城市的聚合（vendors/operators 口径随城市收窄；orders 诚实降级）；
 *     all 档全量；vendor 档 403；匿名 401（外层 requireApiKey）
 *  2. /api/juzhu/stats：匿名/旧 Key → operators 剥离 + degraded:true；report.read 会话 → 全量
 *  3. /api/juzhu/staff：匿名 401；org 档只见自家+平台级；无 org.read/worker.manage 403
 *  4. admin/projects 列表：city 档只见授权城市（dispatcher/admin.read）；vendor 档只见本商家；
 *     QS 条件与 scope 取交集
 *  5. 数据权限配置：PUT accounts/:id body.scope 显式覆盖生效 + 会话吊销（旧 token 立即失效）
 *
 * 用法：node scripts/scope_regression.cjs [base_url]
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
const RUN = 'IAMSCP' + process.pid;
const RUN_TAG = '演示';

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

/** 项目列表（非数组响应如 403/错误对象 → null，避免把 403 误当空列表） */
function rowsOf(resp) {
  return Array.isArray(resp.body) ? resp.body : null;
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

  const [cities] = await conn.execute('SELECT id, name FROM cities ORDER BY id LIMIT 2');
  if (cities.length < 2) { console.error('SKIP  库内不足两座城市'); process.exit(1); }
  const cityA = cities[0], cityB = cities[1];
  const created = await call('/api/juzhu/admin/projects', 'POST', paToken, {
    name: RUN + '- scope 回归项目', channel: 'trade', city_id: cityA.id, owner_vendor_id: 153, tags: [RUN_TAG],
  });
  check('测试项目创建（city A / trade）', created.status === 200 || created.status === 201, `status=${created.status} ${JSON.stringify(created.body && created.body.error)}`);
  const pid = created.body && created.body.project && created.body.project.id;

  await conn.execute(
    'INSERT INTO orgs(org_no, org_type, name, status, created_at, updated_at) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)',
    ['ORG-' + RUN, 'operator', 'scope回归机构', 'active', new Date().toISOString(), new Date().toISOString()]);
  const [[orgRow]] = await conn.execute('SELECT id FROM orgs WHERE org_no=?', ['ORG-' + RUN]);

  async function makeAccount(role, extra, scope, suffix) {
    const name = RUN.toLowerCase() + '_' + role.replace(/_/g, '') + (suffix ? '_' + suffix : '');
    const body = Object.assign({ login_name: name, password: 'Scp-Reg-2026!', roles: [role], display_name: 'scope回归' }, extra || {});
    if (scope) body.scope = scope;
    const r = await call('/api/juzhu/admin/accounts', 'POST', paToken, body);
    if (!(r.status === 200 || r.status === 201)) throw new Error('建号失败 ' + role + ': ' + JSON.stringify(r.body));
    const lg = await call('/api/auth/login', 'POST', null, { login_name: name, password: 'Scp-Reg-2026!' });
    if (!lg.body || !lg.body.token) throw new Error('登录失败 ' + role);
    return { id: r.body.account.id, name, token: lg.body.token, account: r.body.account };
  }
  const accCityA = await makeAccount('gov_viewer', {}, { level: 'city', city_ids: [cityA.id] }, 'a');
  const accCityB = await makeAccount('gov_viewer', {}, { level: 'city', city_ids: [cityB.id] }, 'b');
  const accAll = await makeAccount('holding_viewer');                                    // 无绑定 → all 档
  const accVendor = await makeAccount('vendor_owner', { vendor_id: 153 });               // vendor 档（无 admin.read → 管理列表 403）
  const accOrg = await makeAccount('operator_admin', { org_id: orgRow.id });             // org 档 + admin.read
  const accDispA = await makeAccount('operator_dispatcher', {}, { level: 'city', city_ids: [cityA.id] }, 'a'); // city 档 + admin.read
  const accVendorProj = await makeAccount('operator_admin', { vendor_id: 153 }, null, 'v'); // vendor 档 + admin.read

  // ── 1. org/report ──
  const repA = await call('/api/juzhu/org/report', 'GET', accCityA.token);
  check('city 档 org/report 200', repA.status === 200, `status=${repA.status}`);
  check('city 档响应带 scope 声明', repA.body && repA.body.scope && repA.body.scope.level === 'city', JSON.stringify(repA.body && repA.body.scope));
  check('city 档 orders 诚实降级（空集+note）', repA.body && repA.body.orders && repA.body.orders.by_status.length === 0 && !!repA.body.orders.note, '');
  const repAll = await call('/api/juzhu/org/report', 'GET', accAll.token);
  check('all 档 org/report 200 且 orders 全量', repAll.status === 200 && !repAll.body.orders.note, `status=${repAll.status}`);
  const repVendor = await call('/api/juzhu/org/report', 'GET', accVendor.token);
  check('vendor 档 org/report 403', repVendor.status === 403, `status=${repVendor.status}`);
  const repAnon = await call('/api/juzhu/org/report', 'GET', null);
  check('匿名 org/report 401（外层凭证闸）', repAnon.status === 401, `status=${repAnon.status}`);

  // ── 2. stats 降级 ──
  const statsAnon = await call('/api/juzhu/stats', 'GET', null);
  check('stats 匿名 → degraded + operators 剥离', statsAnon.status === 200 && statsAnon.body.degraded === true && (!statsAnon.body.operators || !statsAnon.body.operators.length), JSON.stringify(statsAnon.body && { degraded: statsAnon.body.degraded, n: (statsAnon.body.operators || []).length }));
  const statsGov = await call('/api/juzhu/stats', 'GET', accCityA.token);
  check('stats report.read 会话 → 全量 operators', statsGov.status === 200 && statsGov.body.degraded === false && Array.isArray(statsGov.body.operators) && statsGov.body.operators.length > 0, JSON.stringify({ degraded: statsGov.body && statsGov.body.degraded, n: statsGov.body && (statsGov.body.operators || []).length }));

  // ── 3. staff ──
  const staffAnon = await call('/api/juzhu/staff', 'GET', null);
  check('staff 匿名 401（此前完全无鉴权）', staffAnon.status === 401, `status=${staffAnon.status}`);
  const staffOrg = await call('/api/juzhu/staff', 'GET', accOrg.token);
  check('staff org 档 200（含平台级行）', staffOrg.status === 200 && staffOrg.body.scope === 'org', `status=${staffOrg.status}`);
  const staffVendor = await call('/api/juzhu/staff', 'GET', accVendor.token);
  check('staff 无 org.read/worker.manage 档 403', staffVendor.status === 403, `status=${staffVendor.status}`);

  // ── 4. admin/projects 行级（要求 admin.read：dispatcher/operator 组合）──
  if (pid) {
    const listA = await call('/api/juzhu/admin/projects', 'GET', accDispA.token);
    const rowsA = rowsOf(listA);
    check('city A 档项目列表含本项目', rowsA && rowsA.some((r) => r.id === pid) && rowsA.every((r) => Number(r.city_id) === cityA.id), `status=${listA.status} rows=${rowsA ? rowsA.length : 'non-array'}`);
    const listAViaQS = await call(`/api/juzhu/admin/projects?city_id=${cityB.id}`, 'GET', accDispA.token);
    const rowsAViaQS = rowsOf(listAViaQS);
    check('QS 与 scope 取交集（city A 档查 city B → 空）', rowsAViaQS && rowsAViaQS.length === 0, `rows=${rowsAViaQS ? rowsAViaQS.length : 'non-array'}`);
    const listVendor = await call('/api/juzhu/admin/projects', 'GET', accVendorProj.token);
    const rowsVendor = rowsOf(listVendor);
    check('vendor 档项目列表全部 owner_vendor_id=153', rowsVendor && rowsVendor.length > 0 && rowsVendor.every((r) => Number(r.owner_vendor_id) === 153), `rows=${rowsVendor ? rowsVendor.length : 'non-array'}`);
    const listGov = await call('/api/juzhu/admin/projects', 'GET', accCityA.token);
    check('gov（无 admin.read）管理项目列表 403', listGov.status === 403, `status=${listGov.status}`);
  }

  // ── 5. scope 显式覆盖 + 会话吊销 ──
  const me1 = await call('/api/auth/me', 'GET', accCityA.token);
  check('改 scope 前 me 可用', me1.status === 200, `status=${me1.status}`);
  const upd = await call('/api/juzhu/admin/accounts/' + accCityA.id, 'PUT', paToken, {
    roles: ['gov_viewer'], scope: { level: 'city', city_ids: [cityB.id] },
  });
  check('PUT accounts/:id 显式 scope 200', upd.status === 200, `status=${upd.status} ${JSON.stringify(upd.body && upd.body.error)}`);
  const me2 = await call('/api/auth/me', 'GET', accCityA.token);
  check('scope 变更后旧 token 失效（401）', me2.status === 401, `status=${me2.status}`);
  const relogin = await call('/api/auth/login', 'POST', null, { login_name: accCityA.name, password: 'Scp-Reg-2026!' });
  const me3 = await call('/api/auth/me', 'GET', relogin.body.token);
  const scopeNow = me3.body && me3.body.roles && me3.body.roles[0] && me3.body.roles[0].scope;
  check('重登后 scope 反映新授权城市', scopeNow && Array.isArray(scopeNow.city_ids) && scopeNow.city_ids[0] === cityB.id, JSON.stringify(scopeNow));

  // ── 清理 ──
  if (pid) await call('/api/juzhu/admin/projects/' + pid, 'DELETE', paToken);
  const accounts = [accCityA, accCityB, accAll, accVendor, accOrg, accDispA, accVendorProj];
  for (const a of accounts) {
    await conn.execute('DELETE FROM audit_log WHERE account_id=?', [a.id]);
    await conn.execute('DELETE FROM sessions WHERE account_id=?', [a.id]);
    await conn.execute('DELETE FROM account_roles WHERE account_id=?', [a.id]);
    await conn.execute('DELETE FROM accounts WHERE id=?', [a.id]);
  }
  await conn.execute('DELETE FROM orgs WHERE org_no=?', ['ORG-' + RUN]);
  await conn.end();
  console.log('# 清理完成');
  console.log(failed ? `\nFAIL：${failed} 项未通过` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
