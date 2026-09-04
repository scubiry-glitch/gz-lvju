/**
 * auth_center.cjs —— 账号与权限中心（设计文档 docs/account-and-auth-design.md 阶段 1）
 *
 * 四层模型：orgs（主体）→ accounts（登录身份，人/机器）→ roles（角色）→ scope（数据范围）
 * 四通道认证：会话 token（人）/ per-account API Key（机器）/ vendor HMAC（商家机器，不走本模块）/ 匿名白名单
 *
 * 依赖注入（app.js 启动时 init）：query（读）/ exec（写）/ jsonReply / expectedApiKey /
 * expectedAdminPassword / isProduction —— 避免与 app.js 循环 require。
 * 一切 SQL 为 MySQL 5.7 兼容写法；JSON 类字段按仓库惯例存 TEXT。
 */
'use strict';

const crypto = require('crypto');

// ── 内置角色（首版 12 个，宁少勿多；permissions 为 JSON 数组，'*' = 全权）──
const BUILTIN_ROLES = [
  { role_code: 'platform_admin', name: '平台管理员', permissions: ['*'] },
  { role_code: 'platform_op', name: '平台运营', permissions: ['admin.read', 'admin.write', 'audit.read', 'rating.review'] },
  { role_code: 'holding_viewer', name: '国企持有方（只读）', permissions: ['report.read', 'org.read', 'sla.read'] },
  { role_code: 'operator_admin', name: '白名单运营商管理员', permissions: ['admin.read', 'org.read', 'org.write', 'house.write', 'order.dispatch', 'worker.manage'] },
  { role_code: 'operator_dispatcher', name: '运营商调度员', permissions: ['admin.read', 'org.read', 'order.dispatch'] },
  { role_code: 'operator_housekeeper', name: '管家', permissions: ['org.read', 'order.self'] },
  { role_code: 'gov_viewer', name: '政府监管（只读）', permissions: ['report.read', 'complaint.read', 'compliance.read'] },
  { role_code: 'bank_viewer', name: '金融方（只读）', permissions: ['report.read', 'fund.read'] },
  { role_code: 'vendor_owner', name: '商家管理员', permissions: ['vendor.summary.read', 'vendor.order.read', 'vendor.order.write', 'vendor.product.read', 'vendor.product.write', 'vendor.worker.read', 'vendor.fund.read'] },
  { role_code: 'vendor_operator', name: '商家客服/运营', permissions: ['vendor.summary.read', 'vendor.order.read', 'vendor.order.write'] },
  { role_code: 'worker', name: '服务者', permissions: ['order.self', 'income.self'] },
  { role_code: 'user', name: '租客', permissions: ['order.create', 'rating.write'] },
];

// 内部权限点（与上述角色 permissions 配合使用）
const P = {
  ADMIN_READ: 'admin.read',
  ADMIN_WRITE: 'admin.write',
  AUDIT_READ: 'audit.read',
  VENDOR_SUMMARY: 'vendor.summary.read',
  VENDOR_ORDER_READ: 'vendor.order.read',
  VENDOR_ORDER_WRITE: 'vendor.order.write',
  VENDOR_PRODUCT_READ: 'vendor.product.read',
  VENDOR_PRODUCT_WRITE: 'vendor.product.write',
};

const SESSION_TTL_SECONDS = 30 * 86400;

// ── 依赖注入 ──
let DI = null;
function init(deps) {
  DI = deps; // { query, exec, jsonReply, expectedApiKey, expectedAdminPassword, isProduction }
}

function di() {
  if (!DI) throw new Error('auth_center not initialized');
  return DI;
}

// ── 基础工具 ──
function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hashPassword(pwd, salt) {
  const s = salt || crypto.randomBytes(8).toString('hex');
  return s + ':' + sha256Hex(s + ':' + String(pwd));
}

function verifyPassword(pwd, stored) {
  if (!pwd || !stored || stored.indexOf(':') < 0) return false;
  const [salt, hash] = stored.split(':');
  return timingSafeEq(sha256Hex(salt + ':' + String(pwd)), hash);
}

/** 服务端签名根：优先全局 API Key env，退化 admin 密码 env；都没有时仅 dev 允许固定值 */
function rootSecret() {
  const d = di();
  const k = (d.expectedApiKey() || '').trim();
  if (k) return k;
  const p = (d.expectedAdminPassword() || '').trim();
  if (p) return p;
  if (d.isProduction()) throw new Error('auth secret missing: set JUZHU_API_KEY / JUZHU_ADMIN_PASSWORD');
  return 'dev-auth-secret-do-not-use-in-prod';
}

function perAccountSecret(accountId) {
  return crypto.createHmac('sha256', rootSecret()).update('auth-center:v1:' + accountId).digest('hex');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

// ── 建表 + 种子 + 引导（ensureSchema 末尾调用，连接由调用方传入）──
async function ensureAuthSchema(conn) {
  const ddls = [
    `CREATE TABLE IF NOT EXISTS orgs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      org_no VARCHAR(32) NOT NULL UNIQUE,
      org_type VARCHAR(16) NOT NULL,
      name VARCHAR(128) NOT NULL,
      city_ids TEXT,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      whitelist_id INT NULL,
      idp_issuer VARCHAR(255) NULL,
      created_at VARCHAR(32), updated_at VARCHAR(32),
      KEY idx_org_type (org_type)
    ) CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      org_id INT NULL,
      vendor_id INT NULL,
      principal_type VARCHAR(8) NOT NULL DEFAULT 'user',
      login_name VARCHAR(64) NULL,
      phone VARCHAR(32) NULL,
      password_hash VARCHAR(128) NULL,
      api_key_hash VARCHAR(128) NULL,
      idp_type VARCHAR(16) NULL,
      idp_subject VARCHAR(128) NULL,
      display_name VARCHAR(64),
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      last_login_at VARCHAR(32),
      created_at VARCHAR(32), updated_at VARCHAR(32),
      UNIQUE KEY uk_login_name (login_name),
      UNIQUE KEY uk_idp (idp_type, idp_subject),
      KEY idx_acc_vendor (vendor_id), KEY idx_acc_org (org_id), KEY idx_acc_phone (phone)
    ) CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS roles (
      role_code VARCHAR(32) PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      permissions TEXT NOT NULL,
      builtin TINYINT NOT NULL DEFAULT 1
    ) CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS account_roles (
      account_id INT NOT NULL,
      role_code VARCHAR(32) NOT NULL,
      scope TEXT NULL,                              -- JSON：{"level":"vendor|org|city|self|all"}（5.7 TEXT 不能带 DEFAULT）
      PRIMARY KEY (account_id, role_code)
    ) CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      jti VARCHAR(64) NOT NULL UNIQUE,
      token_hash VARCHAR(128) NOT NULL,
      account_id INT NOT NULL,
      expires_at BIGINT NOT NULL,
      revoked_at BIGINT NULL,
      ua VARCHAR(255), ip VARCHAR(64), created_at VARCHAR(32),
      KEY idx_sess_account (account_id)
    ) CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NULL,
      principal_type VARCHAR(16),
      role_code VARCHAR(32),
      action VARCHAR(64) NOT NULL,
      resource VARCHAR(128),
      resource_id VARCHAR(64),
      scope_level VARCHAR(16),
      before_json LONGTEXT, after_json LONGTEXT,
      ip VARCHAR(64), ua VARCHAR(255),
      created_at VARCHAR(32),
      KEY idx_audit_time (id), KEY idx_audit_account (account_id, id)
    ) CHARSET=utf8mb4`,
  ];
  for (const sql of ddls) {
    try { await conn.execute(sql); } catch (e) { throw new Error('ensureAuthSchema: ' + e.message + ' :: ' + sql.slice(0, 60)); }
  }
  // jz_vendors 回填 org_id（可空，渐进迁移；列已存在则忽略）
  try { await conn.execute('ALTER TABLE jz_vendors ADD COLUMN org_id INT NULL'); } catch (_) {}
  try { await conn.execute('ALTER TABLE accounts ADD KEY idx_acc_apikey (api_key_hash(64))'); } catch (_) {}

  // 内置角色种子（IGNORE：不覆盖已有）
  for (const r of BUILTIN_ROLES) {
    await conn.execute(
      'INSERT IGNORE INTO roles(role_code, name, permissions, builtin) VALUES (?,?,?,1)',
      [r.role_code, r.name, JSON.stringify(r.permissions)]
    );
  }
  await bootstrapPlatformAdmin(conn);
}

/** 用 JUZHU_ADMIN_PASSWORD 引导首个 platform_admin 账号（仅当不存在任何 platform_admin 时） */
async function bootstrapPlatformAdmin(conn) {
  const d = di();
  const [[row]] = await conn.execute(
    "SELECT COUNT(*) n FROM accounts a JOIN account_roles ar ON ar.account_id=a.id WHERE ar.role_code='platform_admin'"
  );
  if (row && row.n > 0) return;
  const pwd = d.expectedAdminPassword();
  if (!pwd) { console.warn('authCenter: 无 platform_admin 账号且未配置 JUZHU_ADMIN_PASSWORD，跳过引导'); return; }
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const [ins] = await conn.execute(
    `INSERT INTO accounts(org_id, vendor_id, principal_type, login_name, password_hash, display_name, status, created_at, updated_at)
     VALUES (NULL, NULL, 'user', 'admin', ?, '平台管理员', 'active', ?, ?)`,
    [hashPassword(pwd), now, now]
  );
  await conn.execute(
    "INSERT INTO account_roles(account_id, role_code, scope) VALUES (?, 'platform_admin', ?)",
    [ins.insertId, JSON.stringify({ level: 'all' })]
  );
  console.log('authCenter: 已引导 platform_admin 账号 admin（密码来自 JUZHU_ADMIN_PASSWORD）');
}

// ── 角色 / 权限 ──
async function getAccountWithRoles(accountId) {
  const d = di();
  const accounts = await d.query('SELECT * FROM accounts WHERE id=? LIMIT 1', [accountId]);
  if (!accounts.length) return null;
  const roleRows = await d.query(
    `SELECT ar.role_code, ar.scope, r.permissions FROM account_roles ar
     LEFT JOIN roles r ON r.role_code = ar.role_code WHERE ar.account_id=?`,
    [accountId]
  );
  const roles = roleRows.map((r) => ({
    role_code: r.role_code,
    scope: safeJson(r.scope, {}),
    permissions: safeJson(r.permissions, []),
  }));
  return { account: stripSecrets(accounts[0]), roles };
}

function safeJson(v, fallback) {
  try { const o = JSON.parse(v); return o == null ? fallback : o; } catch (_) { return fallback; }
}

/** 账号对外不可见字段 */
function stripSecrets(acc) {
  if (!acc) return acc;
  const out = Object.assign({}, acc);
  delete out.password_hash;
  delete out.api_key_hash;
  return out;
}

function permissionsOf(principal) {
  const set = new Set();
  for (const r of principal.roles || []) for (const p of r.permissions || []) set.add(p);
  return set;
}

function hasPermission(principal, perm) {
  if (!principal || principal.type !== 'account') return false;
  const set = permissionsOf(principal);
  return set.has('*') || set.has(perm);
}

/** scope 判定：资源声明的范围必须被账号范围覆盖。level: self < vendor < org < city < all */
const SCOPE_RANK = { self: 1, vendor: 2, org: 3, city: 4, all: 5 };
function scopeCovers(accountScope, needLevel) {
  const have = SCOPE_RANK[(accountScope && accountScope.level) || 'self'] || 1;
  const need = SCOPE_RANK[needLevel] || 1;
  return have >= need;
}

function bestScopeLevel(principal) {
  let best = 'self';
  for (const r of principal.roles || []) {
    const lv = (r.scope && r.scope.level) || 'self';
    if (SCOPE_RANK[lv] > SCOPE_RANK[best]) best = lv;
  }
  return best;
}

// ── 会话：签发 / 校验 / 吊销 ──
async function createSession(accountId, ip, ua) {
  const d = di();
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = b64url(JSON.stringify({ aid: accountId, jti, exp }));
  const sig = crypto.createHmac('sha256', perAccountSecret(accountId)).update(payload).digest('base64url');
  const token = payload + '.' + sig;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await d.exec(
    'INSERT INTO sessions(jti, token_hash, account_id, expires_at, ua, ip, created_at) VALUES (?,?,?,?,?,?,?)',
    [jti, sha256Hex(token), accountId, exp, String(ua || '').slice(0, 250), String(ip || '').slice(0, 60), now]
  );
  return { token, expires_at: new Date(exp * 1000).toISOString() };
}

/** 校验 Bearer 会话 token；有效返回 {account, roles}，否则 null */
async function verifySessionToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  let parsed;
  try { parsed = JSON.parse(b64urlDecode(payload)); } catch (_) { return null; }
  if (!parsed || !parsed.aid || !parsed.jti || !parsed.exp) return null;
  if (Math.floor(Date.now() / 1000) > parsed.exp) return null;
  const expectedSig = crypto.createHmac('sha256', perAccountSecret(parsed.aid)).update(payload).digest('base64url');
  if (!timingSafeEq(sig, expectedSig)) return null;
  const d = di();
  const rows = await d.query(
    'SELECT id FROM sessions WHERE jti=? AND token_hash=? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
    [parsed.jti, sha256Hex(token), Math.floor(Date.now() / 1000)]
  );
  if (!rows.length) return null;
  return getAccountWithRoles(parsed.aid);
}

async function revokeSession(token) {
  if (!token) return false;
  const d = di();
  const r = await d.exec('UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL', [
    Math.floor(Date.now() / 1000), sha256Hex(token),
  ]);
  return r.affectedRows > 0;
}

// ── 登录 ──
/** identifier：login_name 或 phone；成功返回 {token, expires_at, account, roles} */
async function loginWithPassword(identifier, password, ip, ua) {
  const d = di();
  const id = String(identifier || '').trim();
  if (!id || !password) return { error: '请输入账号与密码' };
  const rows = await d.query(
    'SELECT * FROM accounts WHERE (login_name=? OR phone=?) AND principal_type=\'user\' LIMIT 1',
    [id, id]
  );
  if (!rows.length) return { error: '账号或密码错误' };
  const acc = rows[0];
  if (acc.status !== 'active') return { error: '账号已停用，请联系管理员' };
  if (!verifyPassword(password, acc.password_hash)) {
    await audit({ accountId: acc.id, principalType: 'user', action: 'auth.login', resource: 'account', resourceId: String(acc.id), result: 'fail', ip, ua });
    return { error: '账号或密码错误' };
  }
  const sess = await createSession(acc.id, ip, ua);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await d.exec('UPDATE accounts SET last_login_at=?, updated_at=? WHERE id=?', [now, now, acc.id]);
  const full = await getAccountWithRoles(acc.id);
  await audit({ accountId: acc.id, principalType: 'user', roles: full.roles, action: 'auth.login', resource: 'account', resourceId: String(acc.id), result: 'ok', ip, ua });
  return Object.assign({ token: sess.token, expires_at: sess.expires_at }, full);
}

// ── 请求 → 主体（identify + authenticate）──
function bearerToken(req) {
  const auth = String((req && req.headers && req.headers.authorization) || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const xs = String((req && req.headers && (req.headers['x-session-token'] || req.headers['X-Session-Token'])) || '').trim();
  return xs || '';
}

function apiKeyOf(req) {
  const auth = String((req && req.headers && req.headers.authorization) || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return ''; // Bearer 保留给会话
  return String((req && req.headers && (req.headers['x-api-key'] || req.headers['X-API-Key'])) || '').trim();
}

function clientIp(req) {
  const xf = String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return xf || (req && req.socket && req.socket.remoteAddress) || '';
}

/**
 * 解析请求主体。返回：
 *   { type:'account', account, roles }   会话或机器账号（scope 见 roles[].scope）
 *   { type:'legacy' }                    旧全局 JUZHU_API_KEY（过渡期：admin 域只读）
 *   null                                 匿名/无效
 */
async function principalOf(req) {
  const d = di();
  const sess = await verifySessionToken(bearerToken(req));
  if (sess) return { type: 'account', ip: clientIp(req), ua: req.headers['user-agent'] || '', ...sess };
  const key = apiKeyOf(req);
  if (!key) return null;
  // 机器账号 key（只存哈希，timingSafe 比对）
  const hash = sha256Hex(key);
  const rows = await d.query(
    "SELECT id FROM accounts WHERE api_key_hash=? AND principal_type='machine' AND status='active' LIMIT 1",
    [hash]
  );
  if (rows.length) {
    const full = await getAccountWithRoles(rows[0].id);
    return { type: 'account', via: 'api-key', ip: clientIp(req), ua: req.headers['user-agent'] || '', ...full };
  }
  // 旧全局 key（过渡兼容）
  if (d.expectedApiKey() && timingSafeEq(sha256Hex(key), sha256Hex(d.expectedApiKey()))) {
    return { type: 'legacy', ip: clientIp(req) };
  }
  return null;
}

// ── 审计 ──
async function audit(entry) {
  const d = di();
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  try {
    await d.exec(
      `INSERT INTO audit_log(account_id, principal_type, role_code, action, resource, resource_id,
        scope_level, before_json, after_json, ip, ua, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        entry.accountId || null,
        entry.principalType || (entry.roles && entry.roles.length ? 'user' : entry.accountId ? 'user' : null) || null,
        entry.roles && entry.roles.length ? entry.roles.map((r) => r.role_code).join(',') : (entry.roleCode || null),
        String(entry.action || '').slice(0, 60),
        String(entry.resource || '').slice(0, 120),
        entry.resourceId != null ? String(entry.resourceId).slice(0, 60) : null,
        entry.scopeLevel || null,
        entry.before ? JSON.stringify(entry.before).slice(0, 60000) : null,
        entry.after ? JSON.stringify(entry.after).slice(0, 60000) : null,
        String(entry.ip || '').slice(0, 60) || null,
        String(entry.ua || '').slice(0, 250) || null,
        now,
      ]
    );
  } catch (e) {
    console.warn('audit_log warn:', e.message);
  }
}

// ── 账号管理（platform_admin 用；原生多账号：任何主体直接挂 N 个 account）──
function validateAccountInput(body, { partial } = {}) {
  const errors = [];
  const out = {};
  if (!partial || body.login_name !== undefined) {
    const ln = String(body.login_name || '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(ln)) errors.push('login_name 须为 3-64 位字母数字_.-');
    out.login_name = ln;
  }
  if (!partial || body.password !== undefined) {
    if (body.password !== undefined && body.password !== '') {
      if (String(body.password).length < 8) errors.push('密码至少 8 位');
      out.password = String(body.password);
    } else if (!partial) {
      errors.push('password 必填（至少 8 位）');
    }
  }
  if (!partial || body.roles !== undefined) {
    const roles = Array.isArray(body.roles) ? body.roles.map(String) : [];
    if (!roles.length) errors.push('roles 必填（数组）');
    const known = new Set(BUILTIN_ROLES.map((r) => r.role_code));
    for (const r of roles) if (!known.has(r)) errors.push('未知角色: ' + r);
    out.roles = roles;
  }
  if (body.vendor_id !== undefined) out.vendor_id = body.vendor_id == null || body.vendor_id === '' ? null : parseInt(body.vendor_id, 10) || null;
  if (body.org_id !== undefined) out.org_id = body.org_id == null || body.org_id === '' ? null : parseInt(body.org_id, 10) || null;
  if (body.phone !== undefined) out.phone = String(body.phone || '').trim() || null;
  if (body.display_name !== undefined) out.display_name = String(body.display_name || '').trim().slice(0, 64) || null;
  if (body.principal_type !== undefined) {
    if (!['user', 'machine'].includes(body.principal_type)) errors.push('principal_type 须为 user|machine');
    out.principal_type = body.principal_type;
  }
  if (body.status !== undefined) {
    if (!['active', 'locked', 'disabled'].includes(body.status)) errors.push('status 须为 active|locked|disabled');
    out.status = body.status;
  }
  return { errors, out };
}

async function createAccount(body, ctx) {
  const d = di();
  const { errors, out } = validateAccountInput(body);
  if (errors.length) return { error: errors.join('；') };
  const dup = await d.query('SELECT id FROM accounts WHERE login_name=? LIMIT 1', [out.login_name]);
  if (dup.length) return { error: 'login_name 已存在' };
  if (out.vendor_id) {
    const v = await d.query('SELECT id FROM jz_vendors WHERE id=? LIMIT 1', [out.vendor_id]);
    if (!v.length) return { error: 'vendor_id 不存在' };
  }
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const ins = await d.exec(
    `INSERT INTO accounts(org_id, vendor_id, principal_type, login_name, phone, password_hash, display_name, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      out.org_id || null, out.vendor_id || null, out.principal_type || 'user', out.login_name,
      out.phone || null, out.password ? hashPassword(out.password) : null, out.display_name || null,
      'active', now, now,
    ]
  );
  for (const rc of out.roles) {
    const scope = out.vendor_id ? { level: 'vendor', vendor_id: out.vendor_id } : { level: out.org_id ? 'org' : 'all', org_id: out.org_id || undefined };
    await d.exec('INSERT INTO account_roles(account_id, role_code, scope) VALUES (?,?,?)', [ins.insertId, rc, JSON.stringify(scope)]);
  }
  const full = await getAccountWithRoles(ins.insertId);
  await audit(Object.assign({ action: 'account.create', resource: 'account', resourceId: String(ins.insertId), after: full, result: 'ok' }, ctx));
  return { account: full.account, roles: full.roles };
}

async function updateAccount(id, body, ctx) {
  const d = di();
  const rows = await d.query('SELECT * FROM accounts WHERE id=? LIMIT 1', [id]);
  if (!rows.length) return { error: '账号不存在' };
  const before = await getAccountWithRoles(id);
  const { errors, out } = validateAccountInput(body, { partial: true });
  if (errors.length) return { error: errors.join('；') };
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const sets = [];
  const params = [];
  const map = { login_name: 'login_name', phone: 'phone', display_name: 'display_name', status: 'status', org_id: 'org_id', vendor_id: 'vendor_id' };
  for (const [k, col] of Object.entries(map)) {
    if (out[k] !== undefined) { sets.push(col + '=?'); params.push(out[k]); }
  }
  if (out.password) { sets.push('password_hash=?'); params.push(hashPassword(out.password)); }
  if (sets.length) {
    sets.push('updated_at=?'); params.push(now, id);
    await d.exec('UPDATE accounts SET ' + sets.join(',') + ' WHERE id=?', params);
    // 密码/停用变更 → 吊销全部会话
    if (out.password || out.status === 'disabled' || out.status === 'locked') {
      await d.exec('UPDATE sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL', [Math.floor(Date.now() / 1000), id]);
    }
  }
  if (out.roles) {
    await d.exec('DELETE FROM account_roles WHERE account_id=?', [id]);
    const base = before.account;
    for (const rc of out.roles) {
      const scope = base.vendor_id ? { level: 'vendor', vendor_id: base.vendor_id } : { level: base.org_id ? 'org' : 'all', org_id: base.org_id || undefined };
      await d.exec('INSERT INTO account_roles(account_id, role_code, scope) VALUES (?,?,?)', [id, rc, JSON.stringify(scope)]);
    }
  }
  const after = await getAccountWithRoles(id);
  await audit(Object.assign({ action: 'account.update', resource: 'account', resourceId: String(id), before, after, result: 'ok' }, ctx));
  return { account: after.account, roles: after.roles };
}

/** 签发机器 API Key（明文只在本次响应返回一次，库里只存哈希） */
async function issueApiKey(id, ctx) {
  const d = di();
  const rows = await d.query('SELECT * FROM accounts WHERE id=? LIMIT 1', [id]);
  if (!rows.length) return { error: '账号不存在' };
  const key = 'jzk_' + crypto.randomBytes(24).toString('hex');
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await d.exec("UPDATE accounts SET principal_type='machine', api_key_hash=?, updated_at=? WHERE id=?", [sha256Hex(key), now, id]);
  await d.exec('UPDATE sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL', [Math.floor(Date.now() / 1000), id]);
  await audit(Object.assign({ action: 'account.issue-api-key', resource: 'account', resourceId: String(id), result: 'ok' }, ctx));
  return { api_key: key, note: '明文仅此一次返回，请妥善保存；再次签发将覆盖旧 key' };
}

async function listAccounts(q) {
  const d = di();
  const where = [];
  const params = [];
  if (q.vendor_id) { where.push('a.vendor_id=?'); params.push(parseInt(q.vendor_id, 10)); }
  if (q.org_id) { where.push('a.org_id=?'); params.push(parseInt(q.org_id, 10)); }
  if (q.principal_type) { where.push('a.principal_type=?'); params.push(q.principal_type); }
  const rows = await d.query(
    `SELECT a.* FROM accounts a ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 500`,
    params
  );
  const out = [];
  for (const acc of rows) {
    const full = await getAccountWithRoles(acc.id);
    out.push({ account: full.account, roles: full.roles.map((r) => ({ role_code: r.role_code, scope: r.scope })) });
  }
  return out;
}

module.exports = {
  init,
  ensureAuthSchema,
  BUILTIN_ROLES,
  P,
  // 会话与登录
  loginWithPassword,
  createSession,
  verifySessionToken,
  revokeSession,
  bearerToken,
  // 主体与鉴权
  principalOf,
  hasPermission,
  bestScopeLevel,
  scopeCovers,
  getAccountWithRoles,
  permissionsOf,
  // 账号管理
  createAccount,
  updateAccount,
  issueApiKey,
  listAccounts,
  // 工具
  audit,
  sha256Hex,
  hashPassword,
  verifyPassword,
};
