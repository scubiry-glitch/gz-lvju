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

// ── 内置角色（首版 12 个，宁少勿多）──
// code/name 的权威清单在这里；permissions 由 perm_registry.cjs（权限点注册表）折叠，
// 不再手写两份——改角色权限面先改注册表，再跑 scripts/perm_registry_snapshot.cjs 对基线。
const permRegistry = require('./perm_registry.cjs');
const ROLE_DEFS = [
  { role_code: 'platform_admin', name: '平台管理员' },
  { role_code: 'platform_op', name: '平台运营' },
  { role_code: 'holding_viewer', name: '国企持有方（只读）' },
  { role_code: 'operator_admin', name: '白名单运营商管理员' },
  { role_code: 'operator_dispatcher', name: '运营商调度员' },
  { role_code: 'operator_housekeeper', name: '管家' },
  { role_code: 'gov_viewer', name: '政府监管（只读）' },
  { role_code: 'bank_viewer', name: '金融方（只读）' },
  { role_code: 'vendor_owner', name: '商家管理员' },
  { role_code: 'vendor_operator', name: '商家客服/运营' },
  { role_code: 'worker', name: '服务者' },
  { role_code: 'user', name: '租客' },
];
const BUILTIN_ROLES = ROLE_DEFS.map((r) => Object.assign({}, r, { permissions: permRegistry.roleDefaults(r.role_code) }));

// 内部权限点（与上述角色 permissions 配合使用）
const P = {
  ADMIN_READ: 'admin.read',
  ADMIN_WRITE: 'admin.write',
  AUDIT_READ: 'audit.read',
  ORDER_CREATE: 'order.create',
  RATING_WRITE: 'rating.write',
  DISPATCH: 'order.dispatch',
  REPORT_READ: 'report.read',
  VENDOR_SUMMARY: 'vendor.summary.read',
  VENDOR_ORDER_READ: 'vendor.order.read',
  VENDOR_ORDER_WRITE: 'vendor.order.write',
  VENDOR_PRODUCT_READ: 'vendor.product.read',
  VENDOR_PRODUCT_WRITE: 'vendor.product.write',
};

const SESSION_TTL_SECONDS = 30 * 86400;

// ── 登录防爆破（docs §4.1：连错 5 次锁 30 分钟；env 可调）──
const LOCK_THRESHOLD = parseInt(process.env.AUTH_LOCK_THRESHOLD || '5', 10) || 5;
const LOCK_WINDOW_SECONDS = parseInt(process.env.AUTH_LOCK_WINDOW || '900', 10) || 900;
const LOCK_BASE_SECONDS = parseInt(process.env.AUTH_LOCK_BASE || '900', 10) || 900;
const LOCK_STEP = parseInt(process.env.AUTH_LOCK_STEP || '3', 10) || 3;
const LOCK_MAX_SECONDS = parseInt(process.env.AUTH_LOCK_MAX || '86400', 10) || 86400;
const IP_THRESHOLD = parseInt(process.env.AUTH_IP_THRESHOLD || '30', 10) || 30;
const IP_WINDOW_SECONDS = parseInt(process.env.AUTH_IP_WINDOW || '600', 10) || 600;

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

// ── 密码哈希：scrypt（2026-09 起）；存量 sha256(salt:pwd) 行登录时校验通过后懒升级 ──
// 格式：scrypt$<salt 32hex>$<hash 128hex>（N/r/p/keylen 为模块常量不进串；将来调参用 scrypt$2$ 前缀）
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 };
const _scrypt = crypto.scrypt;

function hashPassword(pwd, salt) {
  const s = salt || crypto.randomBytes(SCRYPT.saltBytes).toString('hex');
  return new Promise((resolve, reject) => {
    _scrypt(String(pwd), s, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => {
      if (err) return reject(err);
      resolve('scrypt$' + s + '$' + key.toString('hex'));
    });
  });
}

/** 返回 {ok, needRehash}：scrypt$ 前缀走 scrypt；存量 salt:sha256(salt:pwd) 走旧逻辑并标记需升级 */
function verifyPassword(pwd, stored) {
  if (!pwd || !stored) return Promise.resolve({ ok: false, needRehash: false });
  if (String(stored).startsWith('scrypt$')) {
    const parts = String(stored).split('$');
    if (parts.length !== 3) return Promise.resolve({ ok: false, needRehash: false });
    const [, salt, hex] = parts;
    return new Promise((resolve) => {
      _scrypt(String(pwd), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => {
        if (err) return resolve({ ok: false, needRehash: false });
        let b; try { b = Buffer.from(hex, 'hex'); } catch (_) { return resolve({ ok: false, needRehash: false }); }
        resolve({ ok: key.length === b.length && crypto.timingSafeEqual(key, b), needRehash: false });
      });
    });
  }
  if (String(stored).indexOf(':') < 0) return Promise.resolve({ ok: false, needRehash: false });
  const [salt, hash] = String(stored).split(':');
  const ok = timingSafeEq(sha256Hex(salt + ':' + String(pwd)), hash);
  return Promise.resolve({ ok, needRehash: ok });
}

/** 校验并在需要时懒升级哈希格式（幂等；升级失败不影响登录） */
async function verifyAndUpgrade(pwd, stored, accountId) {
  const v = await verifyPassword(pwd, stored);
  if (v.ok && v.needRehash && accountId) {
    try {
      const d = di();
      await d.exec('UPDATE accounts SET password_hash=?, updated_at=? WHERE id=?', [await hashPassword(pwd), isoNow(), accountId]);
    } catch (e) { console.warn('password rehash warn:', e.message); }
  }
  return v.ok;
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
    `CREATE TABLE IF NOT EXISTS idp_configs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      org_no VARCHAR(32) NOT NULL UNIQUE,
      idp_type VARCHAR(16) NOT NULL DEFAULT 'oidc',
      issuer VARCHAR(255) NOT NULL,
      client_id VARCHAR(128) NOT NULL,
      client_secret TEXT NULL,
      role_code VARCHAR(32) NOT NULL,
      scope VARCHAR(255) NOT NULL DEFAULT 'openid profile',
      jit_enabled TINYINT NOT NULL DEFAULT 1,
      enabled TINYINT NOT NULL DEFAULT 1,
      created_at VARCHAR(32), updated_at VARCHAR(32),
      KEY idx_idp_org (org_no)
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
  // worker（服务者）身份绑定：accounts.worker_id → jz_workers.id（阶段2）
  try { await conn.execute('ALTER TABLE accounts ADD COLUMN worker_id INT NULL'); } catch (_) {}
  try { await conn.execute('ALTER TABLE accounts ADD KEY idx_acc_apikey (api_key_hash(64))'); } catch (_) {}
  try { await conn.execute('ALTER TABLE accounts ADD KEY idx_acc_worker (worker_id)'); } catch (_) {}
  // 登录防爆破：失败计数 + 锁定（status='locked' 枚举复用；到期自动解锁见 isLocked）
  try { await conn.execute('ALTER TABLE accounts ADD COLUMN failed_login_count INT NOT NULL DEFAULT 0'); } catch (_) {}
  try { await conn.execute('ALTER TABLE accounts ADD COLUMN locked_until VARCHAR(32) NULL'); } catch (_) {}
  try { await conn.execute('ALTER TABLE accounts ADD COLUMN last_failed_at VARCHAR(32) NULL'); } catch (_) {}
  try {
    await conn.execute(`CREATE TABLE IF NOT EXISTS login_throttle (
      bucket VARCHAR(80) PRIMARY KEY,
      kind VARCHAR(8) NOT NULL,
      fail_count INT NOT NULL DEFAULT 0,
      window_start VARCHAR(32) NULL,
      locked_until VARCHAR(32) NULL,
      updated_at VARCHAR(32) NULL
    ) CHARSET=utf8mb4`);
  } catch (e) { throw new Error('ensureAuthSchema(login_throttle): ' + e.message); }
  // scrypt 串（scrypt$+32hex+128hex ≈168 字符）超旧 VARCHAR(128)，放宽
  try { await conn.execute('ALTER TABLE accounts MODIFY password_hash VARCHAR(200) NULL'); } catch (_) {}
  // 审计补 result 列（登录成功/失败、锁定事件靠它区分）+ 查询索引；role_code 放宽防多角色拼接静默写失败
  try { await conn.execute("ALTER TABLE audit_log ADD COLUMN result VARCHAR(8) NULL"); } catch (_) {}
  try { await conn.execute('ALTER TABLE audit_log MODIFY role_code VARCHAR(128)'); } catch (_) {}
  try { await conn.execute('ALTER TABLE audit_log ADD KEY idx_audit_action (action, id)'); } catch (_) {}
  try { await conn.execute('ALTER TABLE audit_log ADD KEY idx_audit_created (created_at, id)'); } catch (_) {}

  // 演示种子：国企持有方 + 平台主体（org_no 幂等，不覆盖已有）
  const now2 = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const orgSeeds = [
    ['ORG-PLATFORM-1', 'platform', '平台运营方（服务认证中台）'],
    ['ORG-HOLDING-1', 'holding', '国企持有方（安居集团）'],
    ['ORG-GOV-JS-1', 'gov', '省住建厅（监管）'],
  ];
  for (const [orgNo, orgType, name] of orgSeeds) {
    await conn.execute(
      'INSERT IGNORE INTO orgs(org_no, org_type, name, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      [orgNo, orgType, name, 'active', now2, now2]
    );
  }

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
    [await hashPassword(pwd), now, now]
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

// ── 会话分级 TTL：管理面 12h / C·S 端 30d / IdP 12h（docs §4.1 分级；机器账号走 API Key 不发会话）──
const SESSION_TTL = {
  human_admin: 12 * 3600,
  human_app: SESSION_TTL_SECONDS,   // 30d
  idp: 12 * 3600,
  machine: 365 * 86400,             // 预留：机器主体不发会话，仅 API Key
};
/** 按角色权限面取 TTL：持管理面权限点 → 12h，否则 30d */
function ttlForAccount(roles) {
  const ADMIN_PERMS = new Set(['iam.write', 'iam.key.write', 'role.write', 'settings.write', 'dict.write',
    'house.write', 'order.dispatch', 'worker.manage', 'rating.review', 'audit.read', 'admin.read', 'admin.write']);
  for (const r of roles || []) {
    for (const p of r.permissions || []) {
      if (p === '*' || ADMIN_PERMS.has(p)) return SESSION_TTL.human_admin;
    }
  }
  return SESSION_TTL.human_app;
}

// ── 会话：签发 / 校验 / 吊销 ──
async function createSession(accountId, ip, ua, opts) {
  const d = di();
  const ttl = Math.max(60, parseInt((opts && opts.ttlSeconds) || SESSION_TTL.human_app, 10) || SESSION_TTL.human_app);
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = Math.floor(Date.now() / 1000) + ttl;
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

// ── 登录防爆破：ident（login_name/phone，账号不存在也拦枚举）+ ip 两级节流 ──
function isoNow() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }
function throttleBucket(kind, identifier) {
  return sha256Hex(kind + ':' + String(identifier || '').toLowerCase());
}
function isoPlus(seconds) { return new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z'); }

/** 命中锁定 → { locked:true, retry_after }；否则 { locked:false }（表缺失等异常按未锁处理） */
async function throttleCheck(kind, identifier) {
  const d = di();
  if (!identifier) return { locked: false };
  try {
    const rows = await d.query('SELECT locked_until FROM login_throttle WHERE bucket=? LIMIT 1', [throttleBucket(kind, identifier)]);
    if (!rows.length || !rows[0].locked_until) return { locked: false };
    const until = Date.parse(rows[0].locked_until);
    if (until > Date.now()) return { locked: true, retry_after: Math.ceil((until - Date.now()) / 1000) };
    return { locked: false };
  } catch (_) { return { locked: false }; }
}

/** 记一次失败；ident 达阈值按连续触发次数递增锁定（3x 步进封顶 24h），ip 达阈值锁窗口 */
async function throttleFail(kind, identifier, ctx) {
  const d = di();
  if (!identifier) return { locked: false };
  try {
    const now = Date.now();
    const nowIso = isoNow();
    const windowSec = kind === 'ip' ? IP_WINDOW_SECONDS : LOCK_WINDOW_SECONDS;
    const threshold = kind === 'ip' ? IP_THRESHOLD : LOCK_THRESHOLD;
    const rows = await d.query('SELECT fail_count, window_start FROM login_throttle WHERE bucket=? LIMIT 1', [throttleBucket(kind, identifier)]);
    let failCount = 1;
    let windowStart = nowIso;
    if (rows.length && rows[0].window_start) {
      const ws = Date.parse(rows[0].window_start);
      if (now - ws < windowSec * 1000) { failCount = (rows[0].fail_count || 0) + 1; windowStart = rows[0].window_start; }
    }
    let lockedUntil = null;
    if (failCount >= threshold) {
      const sec = kind === 'ip'
        ? windowSec
        : Math.min(LOCK_BASE_SECONDS * Math.pow(LOCK_STEP, Math.min(4, failCount - threshold)), LOCK_MAX_SECONDS);
      lockedUntil = isoPlus(sec);
    }
    await d.exec(
      `INSERT INTO login_throttle(bucket, kind, fail_count, window_start, locked_until, updated_at) VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE fail_count=VALUES(fail_count), window_start=VALUES(window_start),
         locked_until=VALUES(locked_until), updated_at=VALUES(updated_at)`,
      [throttleBucket(kind, identifier), kind, failCount, windowStart, lockedUntil, nowIso]
    );
    if (lockedUntil && kind === 'ident') {
      await audit(Object.assign({
        action: 'auth.login.lock', resource: 'account', resourceId: String(identifier).slice(0, 60),
        result: 'fail', after: { locked_until: lockedUntil, fail_count: failCount },
      }, ctx || {}));
    }
    return { locked: !!lockedUntil, locked_until: lockedUntil, fail_count: failCount };
  } catch (e) {
    console.warn('throttleFail warn:', e.message);
    return { locked: false };
  }
}

async function throttleClear(kind, identifier) {
  const d = di();
  if (!identifier) return;
  try { await d.exec('DELETE FROM login_throttle WHERE bucket=?', [throttleBucket(kind, identifier)]); } catch (_) {}
}

/** 账号行锁定判定：locked 且未到期 → 锁定中；到期由调用方惰性解锁 */
function isLockedRow(acc) {
  if (!acc) return { locked: false };
  if (acc.status === 'disabled') return { locked: false, disabled: true };
  const until = acc.locked_until ? Date.parse(acc.locked_until) : 0;
  if (acc.status === 'locked' && until > Date.now()) {
    return { locked: true, retry_after: Math.ceil((until - Date.now()) / 1000) };
  }
  return { locked: false };
}

// ── 登录 ──
/** identifier：login_name 或 phone；opts.ttlSeconds 可覆盖会话时长（缺省按角色分级）；
 *  成功返回 {token, expires_at, account, roles}；节流命中返回 {error, retry_after, throttled} */
async function loginWithPassword(identifier, password, ip, ua, opts) {
  const d = di();
  const id = String(identifier || '').trim();
  if (!id || !password) return { error: '请输入账号与密码' };
  const ipHit = ip ? await throttleCheck('ip', ip) : { locked: false };
  if (ipHit.locked) return { error: '该来源尝试过于频繁，请稍后再试', retry_after: ipHit.retry_after, throttled: true };
  const idHit = await throttleCheck('ident', id);
  if (idHit.locked) return { error: '密码错误次数过多，账号已临时锁定', retry_after: idHit.retry_after, throttled: true };
  const rows = await d.query(
    'SELECT * FROM accounts WHERE (login_name=? OR phone=?) AND principal_type=\'user\' LIMIT 1',
    [id, id]
  );
  if (!rows.length) {
    // 账号不存在也计数并落审计：堵用户名枚举（此前不写审计）
    await throttleFail('ident', id);
    if (ip) await throttleFail('ip', ip);
    await audit({ action: 'auth.login', resource: 'account', resourceId: id.slice(0, 60), result: 'fail', ip, ua });
    return { error: '账号或密码错误' };
  }
  const acc = rows[0];
  const lock = isLockedRow(acc);
  if (lock.disabled) return { error: '账号已停用，请联系管理员' };
  if (lock.locked) return { error: '账号已临时锁定', retry_after: lock.retry_after, throttled: true };
  const v = await verifyPassword(password, acc.password_hash);
  if (!v.ok) {
    const now = isoNow();
    await d.exec('UPDATE accounts SET failed_login_count=failed_login_count+1, last_failed_at=?, updated_at=? WHERE id=?', [now, now, acc.id]);
    const ctx = { accountId: acc.id, principalType: 'user', ip, ua };
    await throttleFail('ident', id, ctx);
    if (ip) await throttleFail('ip', ip, ctx);
    await audit(Object.assign({ action: 'auth.login', resource: 'account', resourceId: String(acc.id), result: 'fail' }, ctx));
    const after = await throttleCheck('ident', id);
    if (after.locked) {
      // 本次尝试已真实校验并计失败 → 仍回 401（带锁定提示）；从下一次起 pre-check 直接 429
      await d.exec("UPDATE accounts SET status='locked', locked_until=?, updated_at=? WHERE id=?", [isoPlus(after.retry_after), now, acc.id]);
      return { error: '密码错误次数过多，账号已临时锁定', retry_after: after.retry_after, locked: true };
    }
    return { error: '账号或密码错误' };
  }
  // 成功：存量 sha256 行懒升级 scrypt；计数清零 + 惰性解锁 + 清 ident 节流
  if (v.needRehash) await verifyAndUpgrade(password, acc.password_hash, acc.id);
  const now = isoNow();
  await d.exec(
    "UPDATE accounts SET failed_login_count=0, locked_until=NULL, status=IF(status='locked','active',status), last_login_at=?, updated_at=? WHERE id=?",
    [now, now, acc.id]
  );
  await throttleClear('ident', id);
  const full = await getAccountWithRoles(acc.id);
  const ttlSeconds = (opts && opts.ttlSeconds) || ttlForAccount(full.roles);
  const sess = await createSession(acc.id, ip, ua, { ttlSeconds });
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
  const xkey = String((req && req.headers && (req.headers['x-api-key'] || req.headers['X-API-Key'])) || '').trim();
  if (xkey) return xkey;
  // Bearer 原则上保留给会话；但兼容「Bearer <全局/机器 Key>」传输（_jzapi.js fallback 等历史客户端）：
  // 仅当该串明显不是会话 token（不含 '.'）时才作为 key 候选，timingSafe 比对失败自然落到 legacy/拒绝
  if (auth.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim();
    return t.indexOf('.') < 0 ? t : '';
  }
  return '';
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
        scope_level, result, before_json, after_json, ip, ua, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        entry.accountId || null,
        entry.principalType || (entry.roles && entry.roles.length ? 'user' : entry.accountId ? 'user' : null) || null,
        entry.roles && entry.roles.length ? entry.roles.map((r) => r.role_code).join(',') : (entry.roleCode || null),
        String(entry.action || '').slice(0, 60),
        String(entry.resource || '').slice(0, 120),
        entry.resourceId != null ? String(entry.resourceId).slice(0, 60) : null,
        entry.scopeLevel || null,
        entry.result || null,
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
  if (body.worker_id !== undefined) out.worker_id = body.worker_id == null || body.worker_id === '' ? null : parseInt(body.worker_id, 10) || null;
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
  if (out.worker_id) {
    const w = await d.query('SELECT id FROM jz_workers WHERE id=? LIMIT 1', [out.worker_id]);
    if (!w.length) return { error: 'worker_id 不存在' };
  }
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const ins = await d.exec(
    `INSERT INTO accounts(org_id, vendor_id, worker_id, principal_type, login_name, phone, password_hash, display_name, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      out.org_id || null, out.vendor_id || null, out.worker_id || null, out.principal_type || 'user', out.login_name,
      out.phone || null, out.password ? await hashPassword(out.password) : null, out.display_name || null,
      'active', now, now,
    ]
  );
  for (const rc of out.roles) {
    const scope = out.worker_id
      ? { level: 'self', worker_id: out.worker_id }
      : out.vendor_id ? { level: 'vendor', vendor_id: out.vendor_id } : { level: out.org_id ? 'org' : 'all', org_id: out.org_id || undefined };
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
  const map = { login_name: 'login_name', phone: 'phone', display_name: 'display_name', status: 'status', org_id: 'org_id', vendor_id: 'vendor_id', worker_id: 'worker_id' };
  for (const [k, col] of Object.entries(map)) {
    if (out[k] !== undefined) { sets.push(col + '=?'); params.push(out[k]); }
  }
  if (out.password) { sets.push('password_hash=?'); params.push(await hashPassword(out.password)); }
  // 解锁（status 改回 active）必须同步清锁定与失败计数，并清 login_throttle 的 ident 桶，
  // 否则 isLockedRow / throttleCheck 仍按锁定拒绝
  if (out.status === 'active' && rows[0].status === 'locked') {
    sets.push('locked_until=NULL', 'failed_login_count=0');
    const buckets = [throttleBucket('ident', before.account.login_name)];
    if (before.account.phone) buckets.push(throttleBucket('ident', before.account.phone));
    try { await d.exec('DELETE FROM login_throttle WHERE bucket IN (' + buckets.map(() => '?').join(',') + ')', buckets); } catch (_) {}
  }
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
      const scope = base.worker_id
        ? { level: 'self', worker_id: base.worker_id }
        : base.vendor_id ? { level: 'vendor', vendor_id: base.vendor_id } : { level: base.org_id ? 'org' : 'all', org_id: base.org_id || undefined };
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

// ── 审计留存：默认 180 天，启动时清理一次 ──
async function cleanupAudit(retentionDays) {
  const days = parseInt(retentionDays || process.env.AUDIT_RETENTION_DAYS || '180', 10) || 180;
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const d = di();
  const r = await d.exec('DELETE FROM audit_log WHERE created_at < ?', [cutoff]);
  if (r.affectedRows > 0) console.log(`authCenter: 清理 ${days} 天前审计日志 ${r.affectedRows} 行`);
  return r.affectedRows;
}

// ── IdP 联邦登录（阶段3 §4.6）：OIDC 配置 + JIT 建档 ──

/** 按 org_no 取启用的 IdP 配置（含 client_secret，仅服务端内部使用） */
async function getIdpConfig(orgNo) {
  const d = di();
  const rows = await d.query('SELECT * FROM idp_configs WHERE org_no=? AND enabled=1 LIMIT 1', [orgNo]);
  return rows[0] || null;
}

/** 配置列表（secret 永不外发，只回是否已设置的布尔） */
async function listIdpConfigs() {
  const d = di();
  return d.query(
    `SELECT id, org_no, idp_type, issuer, client_id, role_code, scope, jit_enabled, enabled,
            (client_secret IS NOT NULL AND client_secret <> '') AS has_secret,
            created_at, updated_at
     FROM idp_configs ORDER BY id`);
}

async function upsertIdpConfig(body, ctx) {
  const d = di();
  const orgNo = String(body.org_no || '').trim();
  const issuer = String(body.issuer || '').trim().replace(/\/+$/, '');
  const clientId = String(body.client_id || '').trim();
  const roleCode = String(body.role_code || '').trim();
  if (!orgNo || !issuer || !clientId || !roleCode) return { error: 'org_no/issuer/client_id/role_code 必填' };
  if (!/^https?:\/\//.test(issuer)) return { error: 'issuer 须为 http(s) URL' };
  const org = await d.query('SELECT id, org_type FROM orgs WHERE org_no=? LIMIT 1', [orgNo]);
  if (!org.length) return { error: 'org_no 不存在于 orgs' };
  const known = new Set(BUILTIN_ROLES.map((r) => r.role_code));
  if (!known.has(roleCode)) return { error: '未知角色: ' + roleCode };
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const secret = body.client_secret != null ? String(body.client_secret) : null;
  await d.exec(
    `INSERT INTO idp_configs(org_no, idp_type, issuer, client_id, client_secret, role_code, scope, jit_enabled, enabled, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,?,?)
     ON DUPLICATE KEY UPDATE issuer=VALUES(issuer), client_id=VALUES(client_id),
       client_secret=IF(VALUES(client_secret) IS NULL, client_secret, VALUES(client_secret)),
       role_code=VALUES(role_code), scope=VALUES(scope), jit_enabled=VALUES(jit_enabled),
       enabled=VALUES(enabled), updated_at=VALUES(updated_at)`,
    [orgNo, 'oidc', issuer, clientId, secret && secret !== '' ? secret : null, roleCode,
     String(body.scope || 'openid profile'), body.jit_enabled === 0 ? 0 : 1, now, now]
  );
  const row = (await d.query('SELECT id FROM idp_configs WHERE org_no=? LIMIT 1', [orgNo]))[0];
  await audit(Object.assign({ action: 'idp_config.upsert', resource: 'idp_configs', resourceId: String(row.id), after: { org_no: orgNo, issuer, role_code: roleCode }, result: 'ok' }, ctx));
  return { ok: true, org_no: orgNo };
}

/**
 * IdP claims → 账号（匹配 (idp_type,idp_subject)；未命中且 JIT 开 → 建档）。
 * 返回 {account, roles}；JIT 关闭且未命中 → null。
 */
async function resolveIdpAccount(config, claims, ctx) {
  const d = di();
  const subject = String(claims.sub || '');
  const idpType = config.idp_type || 'oidc';
  const found = await d.query(
    "SELECT id FROM accounts WHERE idp_type=? AND idp_subject=? LIMIT 1", [idpType, subject]);
  if (found.length) return getAccountWithRoles(found[0].id);
  if (!config.jit_enabled) return null;
  const org = (await d.query('SELECT id, org_type, name FROM orgs WHERE org_no=? LIMIT 1', [config.org_no]))[0];
  if (!org) return null;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const displayName = String(claims.name || claims.preferred_username || claims.sub).slice(0, 64);
  const ins = await d.exec(
    `INSERT INTO accounts(org_id, vendor_id, worker_id, principal_type, login_name, phone, password_hash, idp_type, idp_subject, display_name, status, created_at, updated_at)
     VALUES (?,NULL,NULL,'user',NULL,NULL,NULL,?,?,?,'active',?,?)`,
    [org.id, idpType, subject, displayName, now, now]
  );
  await d.exec('INSERT INTO account_roles(account_id, role_code, scope) VALUES (?,?,?)',
    [ins.insertId, config.role_code, JSON.stringify({ level: 'org', org_id: org.id })]);
  const full = await getAccountWithRoles(ins.insertId);
  await audit(Object.assign({ action: 'idp.jit-create', resource: 'account', resourceId: String(ins.insertId), after: full, result: 'ok' }, ctx));
  return full;
}

module.exports = {
  init,
  ensureAuthSchema,
  BUILTIN_ROLES,
  P,
  SESSION_TTL,
  // 会话与登录
  loginWithPassword,
  createSession,
  verifySessionToken,
  revokeSession,
  bearerToken,
  apiKeyOf,
  // 登录防爆破
  throttleCheck,
  throttleFail,
  throttleClear,
  isLockedRow,
  ttlForAccount,
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
  // IdP 联邦（阶段3）
  getIdpConfig,
  listIdpConfigs,
  upsertIdpConfig,
  resolveIdpAccount,
  // 工具
  audit,
  cleanupAudit,
  sha256Hex,
  hashPassword,
  verifyPassword,
};
