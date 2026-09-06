const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs'); // 规则14：仅 Node；vendor 登录口令散列
const authCenter = require('./auth_center.cjs'); // 账号与权限中心（阶段1，见 docs/account-and-auth-design.md）
const permRegistry = require('./perm_registry.cjs'); // 权限点注册表（admin 域路由闸与细粒度审计的唯一依据）
const idpOidc = require('./idp_oidc.cjs'); // OIDC Relying Party（阶段3 联邦登录）
const imgThumbs = require('./img_thumbs.cjs'); // 图片缩略图自维护（性能：列表/卡片提速）
authCenter.init({
  query: (sql, params) => queryRows(sql, params),
  exec: (sql, params) => withDbRetry(async () => { const [r] = await getPool().execute(sql, params || []); return r; }),
  jsonReply,
  expectedApiKey,
  expectedAdminPassword,
  isProduction,
});

// 用 __dirname，避免被测试 require 时 require.main 指向测试文件
const ROOT = path.resolve(__dirname);

/** 加载运行时 env（平台直启 app.js 时 scf_bootstrap 不会 source）。不覆盖已有环境变量；禁止经 HTTP 暴露。
 *  SCF 解包常丢弃隐藏文件 `.env`，故同时读非隐藏 `runtime.env`。 */
function loadDotEnv(filePath) {
  const p = filePath || path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return false;
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return false; }
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (Object.prototype.hasOwnProperty.call(process.env, key) && process.env[key] !== '') continue;
    process.env[key] = val;
  }
  return true;
}
loadDotEnv();
loadDotEnv(path.join(ROOT, 'runtime.env'));

const PORT = process.env.PORT || 9000;

const ADMIN_PREFIX = '/api/juzhu/admin';
const API_KEY_ENV = 'JUZHU_API_KEY';
/** 历史开发默认值：任何环境均不得再当作有效密钥（文档泄露即等于未授权） */
const DEV_EXAMPLE_API_KEY = 'dev-juzhu-key';
const FORBIDDEN_API_KEY = DEV_EXAMPLE_API_KEY;
/** 非生产可用的后台登录默认口令（仅开发环境兜底） */
const DEV_DEFAULT_ADMIN_PASSWORD = 'dev-admin-default';

// MySQL 连接配置（fallback 直连，仅当 Python 服务不可用时使用）
// 禁止在源码中写死账号密码；必须由运行时环境 / .env（仅进程内，不对外 HTTP）注入。
let mysql2 = null;
try { mysql2 = require('mysql2/promise'); } catch (_) {}
let jzSeedAll = null;
try { jzSeedAll = require('./jz_seed.cjs').seedAll; } catch (_) {}
let staffSeedAll = null;
try { staffSeedAll = require('./staff_seed.cjs').seedAll; } catch (_) {}
let housingSeedAll = null;
let housingBackfillPhotos = null;
let housingParseJsonField = null;
let housingHydrateCoverFields = null;
let housingTagsToDb = null;
try {
  const housingSeed = require('./housing_seed.cjs');
  housingSeedAll = housingSeed.seedAll;
  housingBackfillPhotos = housingSeed.backfillPhotos;
  housingParseJsonField = housingSeed.parseJsonField;
  housingHydrateCoverFields = housingSeed.hydrateCoverFields;
  housingTagsToDb = housingSeed.tagsToDb;
} catch (_) {}
let housingCities = null;
try { housingCities = require('./housing_cities.cjs'); } catch (_) {}
let channelBrand = null;
try { channelBrand = require('./channel_brand.cjs'); } catch (_) {}
let grOrders = null;
try { grOrders = require('./gr_orders.cjs'); } catch (_) {}
let loadVendorConfigFromDb = null;
try { loadVendorConfigFromDb = require('./vendor_config.cjs').loadVendorConfigFromDb; } catch (_) {}
let juzhuImportAll = null;
try { juzhuImportAll = require('./juzhu_import.cjs').importAll; } catch (_) {}
let vendorApi = null;
try { vendorApi = require('./vendor_api.cjs'); } catch (_) {}
// 商家 HMAC-SHA256 签名（平台 → 商家方向的 urllink / order_detail 用）
let hmacAuth = null;
try { hmacAuth = require('./hmac_auth.cjs'); } catch (_) {}

// 商家配置统一从 jz_vendors 表读取（懒加载缓存；对齐 Python jiazheng_api._load_vendor_config）
async function getVendorConfig() {
  if (!loadVendorConfigFromDb) throw new Error('vendor_config module missing');
  if (!mysql2) throw new Error('mysql2 module missing');
  return loadVendorConfigFromDb(() => mysql2.createConnection(getDbConfig()));
}

function getDbConfig() {
  // Node 优先 MYSQL_*；兼容 Python 侧 JUZHU_DB_*（同一 .env 可双端共用）
  const host = (process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '').trim();
  const database = (process.env.MYSQL_DB || process.env.JUZHU_DB_NAME || '').trim();
  const user = (process.env.MYSQL_USER || process.env.JUZHU_DB_USER || '').trim();
  const password = process.env.MYSQL_PASSWORD != null && process.env.MYSQL_PASSWORD !== ''
    ? process.env.MYSQL_PASSWORD
    : process.env.JUZHU_DB_PASSWORD;
  const port = parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10);
  if (!host || !database || !user || password == null || password === '') {
    throw new Error('MySQL env incomplete: set MYSQL_HOST/MYSQL_PORT/MYSQL_DB/MYSQL_USER/MYSQL_PASSWORD (or JUZHU_DB_*)');
  }
  return {
    host,
    port,
    database,
    user,
    password,
    charset: 'utf8mb4',
    collation: 'utf8mb4_general_ci',
    connectTimeout: 8000,
    decimalNumbers: true,
  };
}

// 与 juzhu/server.py is_public_static 对齐：整仓静态根不得暴露密钥/源码/部署产物。
const SENSITIVE_NAMES = new Set([
  '.env', '.env.local', '.env.example', '.env.prod', '.env.test',
  'runtime.env',
  '.git', '.gitignore', '.ds_store', '__pycache__',
  'config.ini', 'server.log', 'api_doc.md', 'api-document.html',
  'hmac_secret.key', 'package.json', 'package-lock.json', 'yarn.lock',
  'pnpm-lock.yaml', 'scf_bootstrap', 'moma_build.sh', 'moma_deploy.js',
  'claude.md', 'readme.md', 'verification.md',
]);
const SENSITIVE_SUFFIXES = [
  '.py', '.pyc', '.pyo', '.db', '.sqlite', '.sqlite3', '.sql',
  '.ini', '.log', '.key', '.pem', '.crt', '.p12', '.pfx',
  '.env', '.sh', '.md', '.cjs',
];
const ROOT_BLOCKED_FILES = new Set([
  'app.js', 'server.js', 'package.json', 'package-lock.json',
  'scf_bootstrap', 'moma_build.sh', 'moma_deploy.js', 'api_doc.md',
  'readme.md', 'claude.md',
]);
const JUZHU_PUBLIC_FILES = new Set(['app.js', 'cities.json', 'data.json']);
const API_DOC_BASENAMES = new Set([
  'api-document.html', 'xjz-api.html', 'prd-document.html', 'xjz-prd.html',
]);

function isProduction() {
  const env = (process.env.JUZHU_ENV || '').trim().toLowerCase();
  return env === 'prod' || env === 'production';
}

function urlParts(urlPath) {
  const clean = decodeURIComponent(String(urlPath || '').split('?')[0].split('#')[0]);
  return path.posix.normalize(clean).split('/').filter((p) => p && p !== '.' && p !== '..');
}

function isSensitivePart(name) {
  const lower = String(name || '').toLowerCase();
  if (SENSITIVE_NAMES.has(lower) || SENSITIVE_NAMES.has(name)) return true;
  if (API_DOC_BASENAMES.has(lower)) return true;
  if (lower.startsWith('.env')) return true;
  if (lower.startsWith('.') && lower !== '.') return true; // 隐藏文件一律不对外
  if (SENSITIVE_SUFFIXES.some((suf) => lower.endsWith(suf))) return true;
  return false;
}

function isPublicStatic(urlPath) {
  const parts = urlParts(urlPath);
  if (!parts.length) return true;
  // 生产禁用 /docs/ 整目录（含历史 API 文档入口）
  if (isProduction() && parts[0] === 'docs') return false;
  if (parts[0] === 'juzhu') {
    if (parts.length !== 2) return false;
    const name = parts[1];
    if (JUZHU_PUBLIC_FILES.has(name)) return true;
    if (name.startsWith('data-') && name.endsWith('.json')) return true;
    return false;
  }
  if (parts.some(isSensitivePart)) return false;
  if (parts.length === 1 && ROOT_BLOCKED_FILES.has(parts[0].toLowerCase())) return false;
  if (parts[0] === 'node_modules' || parts[0] === 'scripts' || parts[0] === '.git') return false;
  return true;
}

function expectedApiKey() {
  const key = (process.env[API_KEY_ENV] || '').trim();
  if (!key || key === FORBIDDEN_API_KEY || key === DEV_EXAMPLE_API_KEY) return '';
  return key;
}

function expectedAdminPassword() {
  const pwd = (process.env.JUZHU_ADMIN_PASSWORD || '').trim();
  if (isProduction()) {
    if (!pwd || pwd === DEV_DEFAULT_ADMIN_PASSWORD) return '';
    return pwd;
  }
  return pwd || DEV_DEFAULT_ADMIN_PASSWORD;
}

function providedApiKey(req) {
  const auth = String((req && req.headers && req.headers.authorization) || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String((req && req.headers && (req.headers['x-api-key'] || req.headers['X-API-Key'])) || '').trim();
}

function apiKeyMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function extractBearerToken(req) {
  const auth = String((req && req.headers && req.headers.authorization) || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

function verifyAdminLoginToken(token) {
  const expected = expectedAdminPassword();
  if (!token || !expected || token.indexOf('.') < 0) return false;
  const [expStr, sig] = token.split('.');
  const exp = parseInt(expStr, 10);
  if (!exp || Date.now() / 1000 > exp) return false;
  const expectedSig = crypto.createHmac('sha256', expected).update(String(exp)).digest('hex');
  const sigBuf = Buffer.from(sig || '', 'hex');
  const expBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

async function isAdminSessionAuthorized(req) {
  // 凭据解析统一走账号中心（X-API-Key 或「Bearer <非会话串>」都认，见 auth_center.apiKeyOf）
  const key = authCenter.apiKeyOf(req);
  if (key && apiKeyMatches(key, expectedApiKey())) return true;
  const bearer = extractBearerToken(req);
  if (verifyAdminLoginToken(bearer)) return true; // 旧 admin token（过渡兼容）
  const sess = await authCenter.verifySessionToken(bearer).catch(() => null);
  return !!(sess && sess.account);
}

// ===== vendor（商家）会话：role=vendor，token 形如 exp.vendorId.sig =====
function vendorTokenSecret() {
  return (process.env.JUZHU_VENDOR_SECRET || '').trim() || expectedAdminPassword() || 'jz-vendor-dev-secret';
}

function verifyVendorLoginToken(token) {
  const secret = vendorTokenSecret();
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const exp = parseInt(parts[0], 10);
  const vid = parseInt(parts[1], 10);
  if (!exp || !vid || Date.now() / 1000 > exp) return null;
  const expectedSig = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('hex');
  const sigBuf = Buffer.from(parts[2] || '', 'hex');
  const expBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  return { role: 'vendor', vendorId: vid };
}

// 统一会话：vendor token 最先判定（token 自证，纯函数无共享状态，杜绝被误判为 platform），
// 其次账号中心主体，再次 admin 会话/全局 Key（过渡）
async function requestSession(req) {
  const vtok = verifyVendorLoginToken(extractBearerToken(req));
  if (vtok) return vtok;
  try {
    const principal = await authCenter.principalOf(req);
    if (principal && principal.type === 'account') {
      const perms = authCenter.permissionsOf(principal);
      // 真平台主体：'*' 全权，或（无商家/机构绑定的）平台管理读账号。
      // 有 vendor_id 的账号即使带 admin.read（如 operator_admin）也按 vendor 归属隔离，
      // 防止运营商账号借管理读权限看到全部项目。
      const isTruePlatform = perms.has('*') ||
        (perms.has(authCenter.P.ADMIN_READ) && !principal.account.vendor_id && !principal.account.org_id);
      if (isTruePlatform) {
        return { role: 'platform', account: principal.account, roles: principal.roles, principal };
      }
      if (principal.account.vendor_id) {
        return { role: 'vendor', vendorId: principal.account.vendor_id, account: principal.account, roles: principal.roles, principal };
      }
      // 其余账号角色（user 租客等）→ 登录用户
      return { role: 'user', account: principal.account, roles: principal.roles, principal };
      if (perms.has(authCenter.P.ADMIN_READ)) {
        // 有机构绑定的管理读账号（gov/bank/holding 等）：读按平台，写仍由权限闸收紧
        return { role: 'platform', account: principal.account, roles: principal.roles, principal };
      }
    }
  } catch (_) { /* 账号库暂不可用时退回旧通道 */ }
  // 兜底仅限旧式 admin token（账号中心之前的会话）。
  // 不能用 isAdminSessionAuthorized：它接受一切合法账号会话，会把 gov_viewer 等
  // 非平台账号在这里升格成 platform（越权看全量）——账号主体已在上方按角色判定。
  if (verifyAdminLoginToken(extractBearerToken(req))) return { role: 'platform' };
  return null;
}

// 评级口径（维度键 + 评级编号前缀）按 channel 定义
const RATING_DIMS = {
  rental: ['comfort', 'green', 'tech', 'safety'], // 好房子 4 维
  minsu: ['scenery', 'facilities', 'service', 'location', 'culture'], // 彩贝 5 维
};
const RATING_CODE_PREFIX = { rental: 'SY-RENT', minsu: 'MZ' };

// C 端涉写三路径（下单/支付/评价）——旧全局 key 的最后一处过渡放行，
// 收紧由 settings.require_c_login 开关控制（requireCEndWrite）
const C_WRITE_PATH_RE = /^\/api\/juzhu\/jiazheng\/orders(\/[^/]+\/(pay|rate))?$/;

async function requireApiKey(req, res, urlPath) {
  // 通道1（唯一）：账号中心（Bearer 会话 或 机器账号 API Key）。
  // 旧全局 JUZHU_API_KEY 已全面停用——管理面一律拒绝；仅 C 端涉写三路径过渡期保留。
  const principal = await authCenter.principalOf(req).catch(() => null);
  if (principal && principal.type === 'account') {
    req.principal = principal;
    return true;
  }
  const provided = providedApiKey(req);
  if (provided && apiKeyMatches(provided, expectedApiKey())
      && req.method === 'POST' && urlPath && C_WRITE_PATH_RE.test(urlPath.replace(/\/+$/, ''))) {
    req.principal = { type: 'legacy' };
    return true;
  }
  jsonReply(res, {
    error: 'unauthorized',
    message: '请先用账号登录（POST /api/auth/login → Authorization: Bearer <token>）；机器对接用机器账号 API Key',
  }, 401);
  return false;
}

async function settingValue(key) {
  try {
    const rows = await queryRows('SELECT value FROM settings WHERE `key`=? LIMIT 1', [key]);
    return rows.length ? String(rows[0].value == null ? '' : rows[0].value) : '';
  } catch (_) { return ''; }
}

/**
 * C 端涉写闸（下单/支付/评价）：
 * - 账号主体且具备 perm（或 '*'）→ 通过
 * - settings.require_c_login=1（试点收紧开关）→ 其余凭据（匿名/旧 key）一律 401
 * - 默认 off → 保持既有演示行为不破坏
 */
async function requireCEndWrite(req, res, perm) {
  const principal = await authCenter.principalOf(req).catch(() => null);
  if (principal && principal.type === 'account' && authCenter.hasPermission(principal, perm)) {
    req.principal = principal;
    return true;
  }
  if ((await settingValue('require_c_login')) === '1') {
    jsonReply(res, { error: 'unauthorized', message: '涉写操作须登录本人账号（POST /api/auth/login）' }, 401);
    return false;
  }
  req.principal = principal; // off：保持现状（可能为 legacy/匿名）
  return true;
}

/** 运营动作闸（派单/推进）：平台主体或具备 order.dispatch 的账号；worker 等其他账号 403 */
async function requireDispatchPerm(req, res) {
  const principal = (req.principal && req.principal.type === 'account')
    ? req.principal
    : await authCenter.principalOf(req).catch(() => null);
  if (principal && principal.type === 'account') {
    if (authCenter.hasPermission(principal, 'order.dispatch') || authCenter.hasPermission(principal, '*')) {
      req.principal = principal;
      return true;
    }
    jsonReply(res, { error: 'forbidden', message: '当前账号无派单/推进权限（order.dispatch）' }, 403);
    return false;
  }
  if (principal && principal.type === 'legacy') {
    jsonReply(res, { error: 'forbidden', message: '旧 API Key 已停用：派单请用运营账号登录（POST /api/auth/login）' }, 403);
    return false;
  }
  jsonReply(res, { error: 'unauthorized', message: '须管理凭证（运营账号会话或机器账号 Key）' }, 401);
  return false;
}

/** 工单读取闸：非管理账号（如 worker）只见本人；无 worker 绑定即 403 */
async function restrictOrdersRead(req, res) {
  const principal = req.principal;
  if (principal && principal.type === 'account' &&
      !authCenter.hasPermission(principal, '*') && !authCenter.hasPermission(principal, authCenter.P.ADMIN_READ)) {
    if (!principal.account.worker_id) {
      jsonReply(res, { error: 'forbidden', message: '当前账号无工单列表读取权限' }, 403);
      return null;
    }
    return String(principal.account.worker_id); // worker 只见派给自己的
  }
  return undefined; // 平台/legacy → 不限
}

/** 账号主体的运营写动作 → audit_log（legacy/匿名不记） */
async function auditIfAccount(req, action, resource, resourceId, after) {
  const p = req.principal;
  if (p && p.type === 'account') {
    await authCenter.audit({
      accountId: p.account.id, principalType: 'account', roles: p.roles,
      action, resource, resourceId, scopeLevel: authCenter.bestScopeLevel(p),
      after, ip: p.ip, ua: p.ua,
    });
  }
}

/** 通用权限闸：账号 + 指定权限（admin 域入口闸与运营写面统一走这里；legacy key 一律 403）
 *  过渡开关 settings.perm_strict != '1' 时，持有旧 admin.write 的账号仍放行（不断崖）；
 *  B7 翻 '1' 后按 perm_registry 权限点严格收口。 */
let _permStrictCache = { v: '0', at: 0 };
async function permStrictMode() {
  if (Date.now() - _permStrictCache.at > 10000) {
    _permStrictCache = { v: (await settingValue('perm_strict')) || '0', at: Date.now() };
  }
  return _permStrictCache.v;
}

async function requireAnyPerm(req, res, perms, label) {
  const principal = (req.principal && req.principal.type === 'account')
    ? req.principal
    : await authCenter.principalOf(req).catch(() => null);
  if (principal && principal.type === 'account') {
    let ok = (perms || []).some((p) => authCenter.hasPermission(principal, p)) || authCenter.hasPermission(principal, '*');
    if (!ok && (await permStrictMode()) !== '1' && authCenter.hasPermission(principal, authCenter.P.ADMIN_WRITE)) ok = true;
    if (ok) {
      req.principal = principal;
      return true;
    }
    jsonReply(res, { error: 'forbidden', message: '当前账号无' + label + '权限（' + (perms || []).join('/') + '）' }, 403);
    return false;
  }
  if (principal && principal.type === 'legacy') {
    jsonReply(res, { error: 'forbidden', message: '旧 API Key 已停用：请用运营账号登录（POST /api/auth/login）' }, 403);
    return false;
  }
  jsonReply(res, { error: 'unauthorized', message: '须运营凭证（账号会话或机器账号 Key）' }, 401);
  return false;
}

/** 通用权限闸：账号 + 指定权限（admin 域入口闸与运营写面统一走这里；legacy key 一律 403）
 *  过渡开关 settings.perm_strict != '1' 时，持有旧 admin.write 的账号仍放行（不断崖）；
 *  B7 翻 '1' 后按 perm_registry 权限点严格收口。 */
async function requirePerm(req, res, perm, label) {
  return requireAnyPerm(req, res, [perm], label);
}

/**
 * 评级提交闸（POST /admin/projects/:id/rating/submit，原 isAdminAuthExempt 裸豁免收口）：
 * - 账号中心主体：须 rating.write（商家自报）/ house.write（运营商录入）/ rating.review / '*'；
 *   vendor 绑定账号的归属（owner_vendor_id）由处理器内既有校验兜底。
 * - 旧 vendor 会话 / 旧平台凭据：维持处理器内 requestSession + requireApiKey 双通道把关（行为不变）。
 */
async function guardRatingSubmit(req, res) {
  const principal = await authCenter.principalOf(req).catch(() => null);
  if (principal && principal.type === 'account') {
    const perms = authCenter.permissionsOf(principal);
    const ok = perms.has('*') || perms.has('rating.write') || perms.has('house.write') || perms.has('rating.review') ||
      ((await permStrictMode()) !== '1' && perms.has(authCenter.P.ADMIN_WRITE));
    if (!ok) {
      jsonReply(res, { error: 'forbidden', message: '当前账号无评级提交权限（rating.write / house.write）' }, 403);
      return false;
    }
    req.principal = principal;
    return true;
  }
  // 旧通道凭据（vendor token / 旧 admin token / 全局 Key）→ 放行到处理器内 owner_vendor_id 归属把关；
  // 真匿名在此 401，避免泄漏「项目是否存在」
  const bearer = extractBearerToken(req);
  const legacyCred = verifyVendorLoginToken(bearer) || verifyAdminLoginToken(bearer) ||
    apiKeyMatches(providedApiKey(req), expectedApiKey());
  if (!legacyCred) {
    jsonReply(res, { error: 'unauthorized', message: '评级提交须登录（POST /api/auth/login）' }, 401);
    return false;
  }
  return true;
}

// ===== 运营商员工花名册（operator_staff）字段校验与工号生成 =====
const STAFF_LEVELS = ['L1', 'L2', 'L3', 'L4'];
const STAFF_STATUS = ['active', 'observe', 'train', 'leave', 'off'];

/** 校验花名册字段；partial=true 时只取 body 里出现的键（PUT 部分更新） */
function validateStaff(body, opts) {
  const partial = !!(opts && opts.partial);
  const b = body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const out = {};
  if (has('name') || !partial) {
    const name = String(b.name || '').trim();
    if (!name) return { error: '姓名必填' };
    if (name.length > 100) return { error: '姓名过长（≤100 字）' };
    out.name = name;
  }
  if (has('emp_no')) {
    const v = String(b.emp_no || '').trim();
    if (v.length > 30) return { error: '工号过长（≤30 字符）' };
    out.emp_no = v || null;
  }
  if (has('phone') || !partial) {
    const v = String(b.phone || '').trim();
    if (v && !/^\d{11}$/.test(v)) return { error: '手机号须为 11 位数字' };
    out.phone = v || null;
  }
  if (has('level') || !partial) {
    const v = String(b.level || 'L2');
    if (!STAFF_LEVELS.includes(v)) return { error: '等级仅支持 L1-L4' };
    out.level = v;
  }
  if (has('role') || !partial) out.role = String(b.role || '').trim() || null;
  if (has('station') || !partial) out.station = String(b.station || '').trim() || null;
  if (has('month_orders') || !partial) {
    const raw = b.month_orders;
    const n = (raw === undefined || raw === null || raw === '') ? 0 : parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0 || n > 9999) return { error: '本月单量须为 0-9999 整数' };
    out.month_orders = n;
  }
  if (has('rating') || !partial) {
    const raw = b.rating;
    const r = (raw === undefined || raw === null || raw === '') ? 0 : Number(raw);
    if (!Number.isFinite(r) || r < 0 || r > 5) return { error: '客评须为 0-5' };
    out.rating = r;
  }
  if (has('contract_type') || !partial) {
    const v = String(b.contract_type || '正式');
    if (!['正式', '试用'].includes(v)) return { error: '合同类型仅支持 正式/试用' };
    out.contract_type = v;
  }
  if (has('contract_end') || !partial) {
    const v = b.contract_end ? String(b.contract_end).trim() : '';
    if (v && !/^\d{4}-\d{2}$/.test(v)) return { error: '合同到期格式须为 YYYY-MM' };
    out.contract_end = v || null;
  }
  if (has('status') || !partial) {
    const v = String(b.status || 'active');
    if (!STAFF_STATUS.includes(v)) return { error: '状态枚举非法' };
    out.status = v;
  }
  if (has('can_extra') || !partial) out.can_extra = b.can_extra ? 1 : 0;
  if (has('note') || !partial) out.note = String(b.note || '').trim() || null;
  return { row: out };
}

/** 按当前年段生成 EMP-YYYY-NNNN（取该年段最大序号 +1；撞号由调用方重试） */
async function nextEmpNo(conn) {
  const prefix = 'EMP-' + new Date().getFullYear() + '-';
  const [rows] = await conn.execute(
    'SELECT COALESCE(MAX(CAST(RIGHT(emp_no, 4) AS UNSIGNED)), 0) AS m FROM operator_staff WHERE emp_no LIKE ?',
    [prefix + '%']
  );
  const base = (rows[0] && rows[0].m) || 0;
  return prefix + String(base + 1).padStart(4, '0');
}

const VENDOR_SECRET_FIELDS = ['hmac_key', 'url_link', 'order_detail_url'];

function stripVendorSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    obj.forEach(stripVendorSecrets);
    return obj;
  }
  for (const f of VENDOR_SECRET_FIELDS) delete obj[f];
  return obj;
}

function isVendorHmacPath(urlPath, method) {
  const p = String(urlPath || '').replace(/\/+$/, '') || '/';
  const m = String(method || '').toUpperCase();
  return m === 'POST' && (p === '/api/juzhu/callback' || p.startsWith('/api/juzhu/jiazheng/vendor/') || p.startsWith('/api/juzhu/housing/vendor/'));
}

/**
 * C 端公开接口白名单（无 PII 的目录/房源展示 + 来来预约跳转 + 我的订单）。
 * 其余 /api/juzhu/* 一律要求 JUZHU_API_KEY（admin 走会话/Key，商家开放接口走 HMAC）。
 */
function isCEndPublicApi(urlPath, method) {
  const p = String(urlPath || '').replace(/\/+$/, '') || '/';
  const m = String(method || 'GET').toUpperCase();
  if (m === 'POST' && (p === '/api/juzhu/booking' || p === '/api/juzhu/booking/lookup' || p === '/api/juzhu/booking/cancel' || p === '/api/juzhu/booking/pay')) return true;
  if (m === 'POST' && (p === '/api/juzhu/auth/tenant' || p === '/api/juzhu/auth/beike')) return true;
  if (m === 'POST' && p === '/api/juzhu/jiazheng/wechat-link') return true;
  if (m !== 'GET') return false;
  const exact = new Set([
    '/api/juzhu/catalog',
    '/api/juzhu/cities',
    '/api/juzhu/districts',
    '/api/juzhu/settings',
    '/api/juzhu/stats',
    '/api/juzhu/ratings',
    '/api/juzhu/trade',
    '/api/juzhu/jiazheng/categories',
    '/api/juzhu/jiazheng/skus',
    '/api/juzhu/jiazheng/workers',
    '/api/juzhu/gr/orders',
  ]);
  if (exact.has(p)) return true;
  if (/^\/api\/juzhu\/districts\/\d+$/.test(p)) return true;
  if (/^\/api\/juzhu\/projects\/\d+$/.test(p)) return true;
  if (/^\/api\/juzhu\/projects\/\d+\/stay-calendar$/.test(p)) return true;
  if (/^\/api\/juzhu\/projects\/[^/]+\/units$/.test(p)) return true;
  if (/^\/api\/juzhu\/projects\/\d+\/virtual-phone$/.test(p)) return true;
  if (/^\/api\/juzhu\/units\/\d+$/.test(p)) return true;
  if (/^\/api\/juzhu\/units\/\d+\/photos$/.test(p)) return true;
  if (/^\/api\/juzhu\/ratings\/[^/]+$/.test(p)) return true;
  if (/^\/api\/juzhu\/jiazheng\/skus\/[^/]+$/.test(p)) return true;
  if (/^\/api\/juzhu\/jiazheng\/skus\/[^/]+\/(slots|detail|vendors)$/.test(p)) return true;
  if (/^\/api\/juzhu\/gr\/orders\/[^/]+$/.test(p)) return true;
  if (/^\/api\/juzhu\/gr\/orders\/[^/]+\/vendor-detail$/.test(p)) return true;
  return false;
}

async function assertApiAuthorized(urlPath, req, res) {
  if (isAdminAuthExempt(urlPath, req.method)) return true;
  const p = String(urlPath || '').replace(/\/+$/, '') || '/';
  if (p.startsWith(ADMIN_PREFIX)) return true;
  if (p.startsWith('/api/juzhu/vendor')) {
    if (p === '/api/juzhu/vendor/login' && req.method === 'POST') return true;
    // 无任何凭据 → 直接 401（不进会话判定链，杜绝匿名被兜底成主体）
    const hasCred = String((req.headers && req.headers.authorization) || '').trim()
      || String((req.headers && (req.headers['x-api-key'] || req.headers['X-API-Key'])) || '').trim();
    if (!hasCred) {
      jsonReply(res, { error: 'unauthorized', message: '商家请先 POST /api/juzhu/vendor/login 或 /api/auth/login 获取 token' }, 401);
      return false;
    }
    if (await requestSession(req)) return true;
    jsonReply(res, { error: 'unauthorized', message: '商家凭据无效或已过期，请重新 POST /api/juzhu/vendor/login' }, 401);
    return false;
  }
  if (isVendorHmacPath(urlPath, req.method)) return true;
  if (isCEndPublicApi(urlPath, req.method)) return true;
  return requireApiKey(req, res, urlPath);
}

function isAdminAuthExempt(urlPath, method) {
  const p = String(urlPath || '').replace(/\/+$/, '') || '/';
  if (p === `${ADMIN_PREFIX}/auth/login` && method === 'POST') return true;
  if (p === `${ADMIN_PREFIX}/auth/check` && method === 'GET') return true;
  // 商家提交自己项目评级：认证层放行旧 vendor 会话（vendor token 不在 isAdminSessionAuthorized 内），
  // 权限层由 perm_registry 路由的 guard:'ratingSubmit'（guardRatingSubmit）+ 处理器内 owner_vendor_id 把关
  if (method === 'POST' && /^\/api\/juzhu\/admin\/projects\/\d+\/rating\/submit$/.test(p)) return true;
  return false;
}

async function assertAdminAuthorized(urlPath, req, res) {
  const p = String(urlPath || '').replace(/\/+$/, '') || '/';
  if (!p.startsWith(ADMIN_PREFIX)) return true;
  if (isAdminAuthExempt(p, req.method)) return true;
  if (await isAdminSessionAuthorized(req)) return true;
  jsonReply(res, {
    error: 'unauthorized',
    message: '请先登录，或通过 X-API-Key / Authorization Bearer 传入有效 API Key',
  }, 401);
  return false;
}

/** 空 → null；非法抛 Error。返回纯数字真实号。对齐 juzhu/tp_client.py validate_real_phone */
function validateRealPhone(phone) {
  if (phone == null) return null;
  const raw = String(phone).trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!/^\d+$/.test(digits) || digits.length < 11 || digits.length > 13) {
    throw new Error('联系电话须为 11–13 位数字');
  }
  if (digits.startsWith('400')) {
    throw new Error('请填写真实号码，勿填 400 虚拟号');
  }
  return digits;
}

/** 请求体未带 contact_phone → undefined（不更新）；带了则校验后返回纯数字或 null */
function contactPhoneFromBody(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'contact_phone')) return undefined;
  return validateRealPhone(body.contact_phone);
}

function stripContactPhone(row) {
  if (!row) return row;
  const out = Object.assign({}, row);
  delete out.contact_phone;
  return out;
}

// ===== 房态 / 保险 / 最短连住（旅居短住口径）单一数据源：stay_config.cjs =====
// 会话态接口（app.js）与商家 HMAC 开放接口（vendor_api.cjs）共用同一份口径
const stayCfg = require('./stay_config.cjs');
const INSURANCE_TYPES = stayCfg.INSURANCE_TYPES;
const INSURANCE_KEYS = stayCfg.INSURANCE_KEYS;
const STAY_MIN_NIGHTS_DEFAULT = stayCfg.STAY_MIN_NIGHTS_DEFAULT;
const STAY_STATUS = stayCfg.STAY_STATUS;
const parseExtObj = stayCfg.parseExtObj;
const insuranceOf = stayCfg.insuranceOf;
const minStayNightsOf = stayCfg.minStayNightsOf;
const bookableOf = stayCfg.bookableOf;
const unitNightPrice = stayCfg.unitNightPrice;
const stayConfigOf = stayCfg.stayConfigOf;
const stayDateList = stayCfg.stayDateList;

// ===== 商家 Webhook 推送（平台 → 商家，HMAC 签名与开放接口同算法）=====
// 事件：booking.created / booking.paid / booking.cancelled。只通知不担保必达：
// 重试 3 次（5s/30s/120s）仍失败即放弃，商家以 bookings/list 拉取对账兜底。
const WEBHOOK_RETRY_DELAYS = [5000, 30000, 120000];

function webhookSign(secretKey, payload, timestamp) {
  const hmacAuth = require('./hmac_auth.cjs');
  const flat = hmacAuth.flattenAndFilter(payload);
  flat.timestamp = String(timestamp);
  return require('crypto').createHmac('sha256', secretKey)
    .update(hmacAuth.buildStringToSign(flat), 'utf8').digest('hex');
}

async function deliverWebhook(vendor, event, data, attempt) {
  const n = attempt || 0;
  let res = null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    res = await fetch(vendor.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));
  } catch (_) { res = null; }
  if (res && res.ok) {
    console.log('[webhook] delivered', event, 'vendor#' + data.vendor_id, 'attempt', n + 1);
    return;
  }
  if (n < WEBHOOK_RETRY_DELAYS.length) {
    setTimeout(() => {
      deliverWebhook(vendor, event, data, n + 1).catch(() => {});
    }, WEBHOOK_RETRY_DELAYS[n]);
  } else {
    console.warn('[webhook] give up', event, 'vendor#' + data.vendor_id, 'after', n + 1, 'attempts');
  }
}

/** 下发商家 webhook：签名体 = 事件 + 订单数据（不含 sign），同开放接口算法 */
function notifyVendorBooking(vendorId, event, order) {
  (async () => {
    // 推送前直读商家行（不走 getVendorConfig 进程缓存）：webhook_url 配置即时生效
    const conn = await mysql2.createConnection(getDbConfig());
    let v = null;
    try {
      const [rows] = await conn.execute('SELECT id, hmac_key, webhook_url FROM jz_vendors WHERE id=?', [vendorId]);
      v = rows[0] || null;
    } finally { await conn.end(); }
    if (!v || !v.webhook_url || !v.hmac_key) return;   // 未配置 = 不推送
    const ts = Date.now();
    const payload = { event, vendor_id: vendorId, order };
    const body = {
      event,
      vendor_id: vendorId,
      order,
      timestamp: ts,
      sign: webhookSign(v.hmac_key, payload, ts),
    };
    deliverWebhook(v, event, body, 0).catch(() => {});
  })().catch((e) => console.warn('[webhook] notify error:', e.message));
}

/** 组装某月房态日历（规则见 stay_config.buildStayMonth；行读取走连接池） */
function buildStayMonth(proj, unit, unitId, y, mo) {
  return stayCfg.buildStayMonth(queryRows, proj, unit, unitId, y, mo);
}

module.exports.stayConfigOf = stayConfigOf;
module.exports.unitNightPrice = unitNightPrice;
module.exports.stayDateList = stayDateList;
module.exports.INSURANCE_TYPES = INSURANCE_TYPES;

module.exports.isPublicStatic = isPublicStatic;
module.exports.isProduction = isProduction;
module.exports.expectedApiKey = expectedApiKey;
module.exports.providedApiKey = providedApiKey;
module.exports.requireApiKey = requireApiKey;
module.exports.assertAdminAuthorized = assertAdminAuthorized;
module.exports.assertApiAuthorized = assertApiAuthorized;
module.exports.isCEndPublicApi = isCEndPublicApi;
module.exports.isVendorHmacPath = isVendorHmacPath;
module.exports.stripVendorSecrets = stripVendorSecrets;
module.exports.verifyAdminLoginToken = verifyAdminLoginToken;
module.exports.FORBIDDEN_API_KEY = FORBIDDEN_API_KEY;
module.exports.DEV_EXAMPLE_API_KEY = DEV_EXAMPLE_API_KEY;
module.exports.getDbConfig = getDbConfig;
module.exports.validateRealPhone = validateRealPhone;
module.exports.contactPhoneFromBody = contactPhoneFromBody;
module.exports.stripContactPhone = stripContactPhone;

let _pool = null;
function getPool() {
  if (!mysql2) throw new Error('mysql2 not available');
  if (!_pool) {
    _pool = mysql2.createPool(Object.assign({}, getDbConfig(), {
      waitForConnections: true,
      connectionLimit: 8,
      queueLimit: 0,
      enableKeepAlive: true,
    }));
  }
  return _pool;
}

/** 连接类错误（连接池半开/被远端关闭/短暂不可达）→ 换连接重试一次；业务错误不重试 */
const DB_RETRYABLE = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'];
async function withDbRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    const code = e && (e.code || e.errno);
    const fatal = e && e.fatal === true;
    if (!DB_RETRYABLE.includes(code) && !fatal) throw e;
    await new Promise((r) => setTimeout(r, 250));
    return fn();
  }
}

async function queryRows(sql, params) {
  return withDbRetry(async () => {
    const [rows] = await getPool().execute(sql, params || []);
    return rows;
  });
}

const CATALOG_TTL_MS = 15000;
const catalogMemo = new Map();
function catalogMemoGet(key) {
  const hit = catalogMemo.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    catalogMemo.delete(key);
    return null;
  }
  return hit.val;
}
function catalogMemoSet(key, val) {
  catalogMemo.set(key, { val, exp: Date.now() + CATALOG_TTL_MS });
}

/** city_ids 里可能是数字 id（1,2,3）或城市名；C 端常传「沈阳」 */
async function cityMatchTokens(cityKey) {
  const key = String(cityKey || '').trim();
  if (!key) return [];
  const rows = await queryRows(
    'SELECT id, name, slug FROM cities WHERE slug=? OR name=? OR CAST(id AS CHAR)=? LIMIT 1',
    [key, key, key]
  );
  const out = [key];
  if (rows.length) out.push(String(rows[0].id), rows[0].name, rows[0].slug);
  return [...new Set(out.filter(Boolean))];
}

function cityIdsClause(alias, tokens) {
  const col = `REPLACE(${alias}.city_ids, ' ', '')`;
  const finds = tokens.map(() => `FIND_IN_SET(?, ${col})`).join(' OR ');
  return `(${alias}.city_ids IS NULL OR ${alias}.city_ids='' OR ${finds})`;
}

async function execSql(conn, sql, params) {
  const [result] = await conn.execute(sql, params || []);
  return result;
}

async function ensureGrOrdersShape(conn) {
  let cols = [];
  try {
    const [rows] = await conn.execute('SHOW COLUMNS FROM gr_orders');
    cols = rows.map((r) => r.Field);
  } catch (_) {
    return;
  }
  if (!cols.includes('order_ref')) {
    await conn.execute('DROP TABLE gr_orders');
    await conn.execute(`CREATE TABLE gr_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_ref VARCHAR(64) NOT NULL,
      vendor_id INT,
      vendor_oid VARCHAR(64),
      user_id VARCHAR(64),
      sku VARCHAR(128),
      city VARCHAR(32) DEFAULT '沈阳',
      status VARCHAR(20) DEFAULT 'pending',
      fee INT,
      worker_name VARCHAR(128),
      worker_phone VARCHAR(32),
      eta VARCHAR(32),
      cancel_reason TEXT,
      paid_at VARCHAR(32),
      serving_at VARCHAR(32),
      completed_at VARCHAR(32),
      created_at VARCHAR(32) NOT NULL,
      updated_at VARCHAR(32),
      UNIQUE KEY uk_order_ref (order_ref),
      KEY idx_gr_orders_vendor (vendor_id),
      KEY idx_gr_orders_user (user_id)
    ) CHARSET=utf8mb4`);
    return;
  }
  const extra = [
    ['user_id', 'VARCHAR(64)'],
    ['vendor_id', 'INT'],
    ['vendor_oid', 'VARCHAR(64)'],
    ['sku', 'VARCHAR(128)'],
    ['city', "VARCHAR(32) DEFAULT '沈阳'"],
    ['fee', 'INT'],
    ['worker_name', 'VARCHAR(128)'],
    ['worker_phone', 'VARCHAR(32)'],
    ['eta', 'VARCHAR(32)'],
    ['cancel_reason', 'TEXT'],
    ['paid_at', 'VARCHAR(32)'],
    ['serving_at', 'VARCHAR(32)'],
    ['completed_at', 'VARCHAR(32)'],
  ];
  for (const [name, ddl] of extra) {
    if (!cols.includes(name)) {
      try { await conn.execute(`ALTER TABLE gr_orders ADD COLUMN ${name} ${ddl}`); } catch (_) { /* ignore */ }
    }
  }
}

function outboundJson(method, urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { reject(e); return; }
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = body != null ? JSON.stringify(body) : undefined;
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, json: JSON.parse(text), text }); }
        catch (_) { resolve({ status: res.statusCode, json: null, text }); }
      });
    });
    req.setTimeout(timeoutMs || 10000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function encodeTags(tags) {
  if (housingTagsToDb) return housingTagsToDb(tags);
  if (tags == null || tags === '') return null;
  return JSON.stringify(Array.isArray(tags) ? tags : String(tags).split(',').map((s) => s.trim()).filter(Boolean));
}

// 将行中指定字段从 JSON 字符串反序列化为数组/对象，缺失或无效时返回默认值
function parseJsonFields(row, fields, defaultVal) {
  if (!row) return row;
  const fallback = defaultVal !== undefined ? defaultVal : [];
  for (const f of fields) {
    if (row[f] == null) {
      row[f] = fallback;
      continue;
    }
    if (typeof row[f] !== 'string') continue;
    if (housingParseJsonField) {
      const v = housingParseJsonField(row[f]);
      row[f] = (typeof v === 'string') ? fallback : v;
      continue;
    }
    let v = row[f];
    for (let i = 0; i < 8 && typeof v === 'string'; i++) {
      try { v = JSON.parse(v); } catch (e) { break; }
    }
    row[f] = (typeof v === 'string') ? fallback : v;
  }
  return row;
}

// ==== 家政 SKU 详情契约 helper（对齐 Python 版 jiazheng_db.py）====
const VENDOR_BADGE_LABELS = {
  whitelist: '白名单商家',
  backcheck: '平台背调',
  insurance: '已投保',
  top10: '销量榜单',
  commitment: '不满意重做',
};
const WORKER_CERT_LABELS = {
  id_card: '实名认证',
  health: '健康证',
  skill: '技能证',
  insurance: '保险保障',
};
const CATEGORY_REVIEW_FALLBACKS = {
  cleaning: [
    { name: '张*华', score: 5, tags: ['准时', '干净', '细致'], text: '阿姨很专业，卫生间和厨房的死角都处理得很干净。', created_at: '近 30 天' },
    { name: '李*', score: 5, tags: ['专业', '周到'], text: '沟通顺畅，工具带得很全，整体体验很稳。', created_at: '近 60 天' },
    { name: '王*', score: 4, tags: ['态度好'], text: '服务过程细致，结束后还主动提醒后续保洁建议。', created_at: '近 90 天' },
  ],
  repair: [
    { name: '周*', score: 5, tags: ['上门快', '专业'], text: '师傅到得很快，问题定位清楚，维修过程也规范。', created_at: '近 30 天' },
    { name: '孙*', score: 5, tags: ['讲解清楚'], text: '处理完后把原因和后续注意事项都交代明白了。', created_at: '近 60 天' },
    { name: '赵*', score: 4, tags: ['态度好'], text: '响应速度不错，价格透明，适合家里突发维修。', created_at: '近 90 天' },
  ],
  moving: [
    { name: '陈*', score: 5, tags: ['守时', '稳妥'], text: '搬运师傅动作熟练，大件包裹保护做得很好。', created_at: '近 30 天' },
    { name: '钱*', score: 5, tags: ['效率高'], text: '装车和还原都很快，流程也很省心。', created_at: '近 60 天' },
    { name: '吴*', score: 4, tags: ['态度好'], text: '整体体验稳定，适合家庭同城搬家预约。', created_at: '近 90 天' },
  ],
  nanny: [
    { name: '刘*', score: 5, tags: ['耐心', '专业'], text: '阿姨沟通温和，照护和家务安排都比较有条理。', created_at: '近 30 天' },
    { name: '许*', score: 5, tags: ['准时', '放心'], text: '平台认证和背调信息完整，看起来更安心。', created_at: '近 60 天' },
    { name: '何*', score: 4, tags: ['细致'], text: '整体服务比较稳，适合长期预约。', created_at: '近 90 天' },
  ],
};

// 把 rank_type + rank_label 组合成 rank 嵌套对象（对齐 Python _row_to_dict）
function composeRank(row) {
  if (row.rank_type || row.rank_label) {
    row.rank = (row.rank_type && row.rank_label) ? { type: row.rank_type, label: row.rank_label } : null;
  }
  return row;
}

function vendorAuthBadges(vendor) {
  const badges = [];
  if (vendor.whitelist_id) badges.push('白名单商家');
  const rank = vendor.rank || {};
  if (rank.label && !badges.includes(rank.label)) badges.push(rank.label);
  for (const key of (vendor.badges || [])) {
    const label = VENDOR_BADGE_LABELS[key];
    if (label && !badges.includes(label)) badges.push(label);
  }
  if (vendor.live) badges.push('在线接单');
  return badges.slice(0, 5);
}

function workerAuthBadges(worker) {
  const badges = [];
  if (worker.is_whitelisted) badges.push('白名单服务者');
  for (const key of (worker.certs || [])) {
    const label = WORKER_CERT_LABELS[key];
    if (label && !badges.includes(label)) badges.push(label);
  }
  return badges.slice(0, 5);
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 4) return digits[0] + '**' + digits[digits.length - 1];
  return '匿名用户';
}

// 标准打码：138****1234（预订响应/列表一律用它，规则10：完整手机号只入库不回显）
function maskPhoneStd(phone) {
  const s = String(phone || '').trim();
  return /^\d{11}$/.test(s) ? s.slice(0, 3) + '****' + s.slice(7) : s.slice(0, 3) + '****';
}

function reviewReply(vendorName, score) {
  if (score >= 5) return (vendorName || '商家') + '：感谢认可，我们会继续按认证标准完成每次上门服务。';
  if (score >= 4) return (vendorName || '商家') + '：感谢反馈，我们会继续优化服务细节与响应体验。';
  return '';
}

function merchantIntroOf(vendor, product) {
  const intro = {
    summary: '',
    stats: [],
    service_flow: ['线上预约 + 确认时间', '平台派单 + 服务者确认', '按标准上门服务', '服务完成 + 记录回传', '客户评价 + 信用回流'],
    guarantees: ['服务前 2 小时可免费取消', '服务前 2 小时内取消扣 30%', '服务开始后不可取消', '认证商家按平台标准提供售后处理'],
  };
  if (!vendor) return intro;
  const vendorName = vendor.name || '认证商家';
  const category = (product && product.category) || vendor.type || '家政';
  const subtitle = (product && product.subtitle) || (product && product.title) || '';
  intro.summary = vendorName + ' 提供 ' + category + ' 服务，覆盖 '
    + (vendor.address || '本地核心区域') + '，营业时段 ' + (vendor.hours || '08:00-22:00') + '。'
    + (subtitle ? subtitle + '。' : '')
    + '平台展示的商家、服务者认证状态与评价会同步回流到详情页，便于下单前判断履约稳定性。';
  intro.stats = [
    { label: '服务评分', value: String(vendor.rating || '4.8') },
    { label: '累计评价', value: String(vendor.review_count || 0) },
    { label: '起订价格', value: '¥' + (vendor.start_price || 0) + '/' + (vendor.unit || '次') },
  ];
  return intro;
}

// 确保 MySQL 中存在必要的表（MySQL 语法，CREATE TABLE IF NOT EXISTS）
let schemaEnsured = false;
let schemaPromise = null;
async function ensureSchema() {
  if (schemaEnsured || !mysql2) return;
  if (schemaPromise) return schemaPromise;
  schemaPromise = ensureSchemaRun().catch(function (err) {
    schemaPromise = null;
    throw err;
  });
  return schemaPromise;
}
async function ensureSchemaRun() {
  const conn = await mysql2.createConnection(getDbConfig());
  try {
    const ddls = [
      `CREATE TABLE IF NOT EXISTS cities (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) NOT NULL,
        booking_phone VARCHAR(50),
        hero_bg_image VARCHAR(500),
        UNIQUE KEY uk_name (name),
        UNIQUE KEY uk_slug (slug)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS channels (
        id VARCHAR(50) PRIMARY KEY,
        label VARCHAR(100) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        enabled TINYINT NOT NULL DEFAULT 1,
        note TEXT
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS settings (
        \`key\` VARCHAR(100) PRIMARY KEY,
        value TEXT
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS districts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        city_id INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) NOT NULL,
        note TEXT,
        has_projects TINYINT NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        cover_image VARCHAR(500),
        project_count INT NOT NULL DEFAULT 0,
        unit_count INT NOT NULL DEFAULT 0,
        vacant_count INT,
        managed_unit_count INT,
        avg_price INT,
        is_hot TINYINT NOT NULL DEFAULT 0,
        layout_tall TINYINT NOT NULL DEFAULT 0,
        layout_wide TINYINT NOT NULL DEFAULT 0,
        bg_class VARCHAR(50),
        UNIQUE KEY uk_city_slug (city_id, slug)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS projects (
        id INT AUTO_INCREMENT PRIMARY KEY,
        city_id INT NOT NULL,
        district_id INT,
        channel VARCHAR(20) NOT NULL,
        name VARCHAR(200) NOT NULL,
        slug VARCHAR(200) NOT NULL,
        cover_image VARCHAR(500),
        address VARCHAR(300),
        tags TEXT,
        sort_order INT NOT NULL DEFAULT 0,
        unit_count INT NOT NULL DEFAULT 0,
        managed_unit_count INT,
        price_from INT,
        is_featured TINYINT NOT NULL DEFAULT 0,
        featured_rank INT,
        old_house_hint TEXT,
        rating_status VARCHAR(20) NOT NULL DEFAULT 'draft',
        rating TEXT,
        rating_submitted_at VARCHAR(30),
        rating_reviewed_at VARCHAR(30),
        rating_note TEXT,
        UNIQUE KEY uk_channel_slug (channel, slug)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS units (
        id INT AUTO_INCREMENT PRIMARY KEY,
        project_id INT NOT NULL,
        name VARCHAR(200) NOT NULL,
        slug VARCHAR(200) NOT NULL,
        area_sqm DECIMAL(8,2),
        layout_label VARCHAR(50),
        rent_monthly INT,
        price_total INT,
        tags TEXT,
        unit_spec VARCHAR(200),
        promo_price INT,
        amenities TEXT,
        keeper TEXT,
        rent_detail TEXT,
        sort_order INT NOT NULL DEFAULT 0,
        cover_image VARCHAR(500),
        UNIQUE KEY uk_project_slug (project_id, slug)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS booking_contacts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        name VARCHAR(64) NOT NULL,
        phone VARCHAR(32) NOT NULL,
        created_at VARCHAR(32) NOT NULL,
        KEY idx_bc_user (user_id),
        UNIQUE KEY uk_bc_user_phone (user_id, phone)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS booking_orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_no VARCHAR(32) NOT NULL,
        project_id INT NOT NULL,
        unit_id INT,
        channel VARCHAR(16) NOT NULL,
        city_id INT,
        owner_vendor_id INT NOT NULL,
        user_id VARCHAR(64),
        contact_name VARCHAR(64) NOT NULL,
        contact_phone VARCHAR(32) NOT NULL,
        checkin VARCHAR(10) NOT NULL,
        checkout VARCHAR(10) NOT NULL,
        nights INT NOT NULL,
        price_total INT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL,
        UNIQUE KEY uk_order_no (order_no),
        KEY idx_bo_vendor (owner_vendor_id, status),
        KEY idx_bo_project (project_id),
        KEY idx_bo_user (user_id)
      ) CHARSET=utf8mb4`,
      // 房态日历：只存差异行（关房/已订/夜价覆盖），无行 = 可订；unit_id=0 为项目级（整栋/不限房型）
      `CREATE TABLE IF NOT EXISTS stay_calendar (
        id INT AUTO_INCREMENT PRIMARY KEY,
        project_id INT NOT NULL,
        unit_id INT NOT NULL DEFAULT 0,
        stay_date VARCHAR(10) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'open',
        price_night INT,
        source VARCHAR(16) NOT NULL DEFAULT 'vendor',
        booking_id INT,
        updated_at VARCHAR(32),
        UNIQUE KEY uk_sc (project_id, unit_id, stay_date),
        KEY idx_sc_range (project_id, stay_date)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS photos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entity_type VARCHAR(20) NOT NULL,
        entity_id INT NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        source_path VARCHAR(500),
        is_cover TINYINT NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        KEY idx_entity (entity_type, entity_id)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS jz_categories (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        icon VARCHAR(500),
        sort_order INT NOT NULL DEFAULT 0,
        enabled TINYINT NOT NULL DEFAULT 1,
        note TEXT
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS jz_skus (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category_id VARCHAR(50) NOT NULL,
        name VARCHAR(200) NOT NULL,
        slug VARCHAR(200) NOT NULL UNIQUE,
        spec TEXT,
        price_from INT,
        price_unit VARCHAR(50),
        duration_min INT,
        tags TEXT,
        badges TEXT,
        sales_text VARCHAR(200),
        rating_score DECIMAL(3,2),
        worker_min_level VARCHAR(20),
        cover_image VARCHAR(500),
        gallery TEXT,
        includes TEXT,
        service_flow TEXT,
        service_notice TEXT,
        sort_order INT NOT NULL DEFAULT 0,
        enabled TINYINT NOT NULL DEFAULT 1
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS jz_vendors (
        id INT AUTO_INCREMENT PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        name VARCHAR(200) NOT NULL,
        logo VARCHAR(500),
        address TEXT,
        district_id INT,
        city_ids TEXT,
        phone VARCHAR(50),
        rating DECIMAL(3,2) DEFAULT 0,
        review_count INT DEFAULT 0,
        rank_type VARCHAR(50),
        rank_label VARCHAR(100),
        badges TEXT,
        live TINYINT DEFAULT 0,
        start_price DECIMAL(10,2),
        unit VARCHAR(50),
        fulfillment VARCHAR(50) DEFAULT 'to_home',
        hours VARCHAR(200),
        vendor_no VARCHAR(100),
        whitelist_id INT,
        status VARCHAR(20) DEFAULT 'active',
        sort_order INT DEFAULT 0,
        created_at VARCHAR(30),
        updated_at VARCHAR(30)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS jz_products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        title VARCHAR(200) NOT NULL,
        subtitle VARCHAR(200),
        category VARCHAR(50),
        duration_hours DECIMAL(4,1),
        area_range VARCHAR(100),
        unit VARCHAR(50),
        price DECIMAL(10,2) NOT NULL,
        original_price DECIMAL(10,2),
        discount_label VARCHAR(100),
        earliest_time VARCHAR(100),
        advance_booking_hours INT DEFAULT 0,
        sales_count INT DEFAULT 0,
        rating DECIMAL(3,2) DEFAULT 0,
        service_tags TEXT,
        channel_sku_id INT,
        city_id INT,
        path VARCHAR(500),
        query VARCHAR(500),
        status VARCHAR(20) DEFAULT 'on',
        sort_order INT DEFAULT 0
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS jz_workers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        avatar VARCHAR(500),
        level VARCHAR(20) DEFAULT 'L3',
        credit_score INT DEFAULT 70,
        tags TEXT,
        certs TEXT,
        is_whitelisted TINYINT DEFAULT 0,
        rating DECIMAL(3,2) DEFAULT 0,
        completed_orders INT DEFAULT 0,
        years_experience INT DEFAULT 0,
        online TINYINT DEFAULT 0,
        distance_km DECIMAL(6,2),
        vendor_id INT,
        whitelist_id INT,
        status VARCHAR(20) DEFAULT 'active'
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS jz_orders (
        id VARCHAR(50) PRIMARY KEY,
        sku_id INT,
        category_id VARCHAR(50) NOT NULL,
        type VARCHAR(50) NOT NULL,
        house TEXT NOT NULL,
        phone VARCHAR(50) NOT NULL,
        expect_time VARCHAR(100) NOT NULL,
        \`desc\` TEXT,
        fee INT NOT NULL,
        pay_status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
        pay_method VARCHAR(50),
        pay_at VARCHAR(30),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        slot_id INT,
        worker_json TEXT,
        rating_json TEXT,
        source VARCHAR(100),
        created_at VARCHAR(30) NOT NULL,
        updated_at VARCHAR(30) NOT NULL,
        log_json TEXT
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS jz_sku_slots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        slot_date VARCHAR(20) NOT NULL,
        start_time VARCHAR(20) NOT NULL,
        end_time VARCHAR(20),
        capacity INT NOT NULL DEFAULT 1,
        booked INT NOT NULL DEFAULT 0,
        worker_id INT,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        note TEXT,
        KEY idx_product_date (product_id, slot_date, status)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS jz_subcategories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        parent_type VARCHAR(50) NOT NULL,
        name VARCHAR(100) NOT NULL,
        icon VARCHAR(500),
        sort_order INT NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'on',
        KEY idx_parent (parent_type, sort_order)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS jz_sku_workers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        worker_id INT NOT NULL,
        UNIQUE KEY uk_prod_worker (product_id, worker_id)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS jz_activities (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        type VARCHAR(50) NOT NULL DEFAULT 'coupon',
        category_id VARCHAR(50),
        sku_ids TEXT,
        discount_type VARCHAR(50) DEFAULT 'percent',
        discount_value DECIMAL(10,2),
        threshold DECIMAL(10,2) DEFAULT 0,
        start_at VARCHAR(30),
        end_at VARCHAR(30),
        enabled TINYINT NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_at VARCHAR(30),
        updated_at VARCHAR(30)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS gr_orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_ref VARCHAR(64) NOT NULL,
        vendor_id INT,
        vendor_oid VARCHAR(64),
        user_id VARCHAR(64),
        sku VARCHAR(128),
        city VARCHAR(32) DEFAULT '沈阳',
        status VARCHAR(20) DEFAULT 'pending',
        fee INT,
        worker_name VARCHAR(128),
        worker_phone VARCHAR(32),
        eta VARCHAR(32),
        cancel_reason TEXT,
        paid_at VARCHAR(32),
        serving_at VARCHAR(32),
        completed_at VARCHAR(32),
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32),
        UNIQUE KEY uk_order_ref (order_ref),
        KEY idx_gr_orders_vendor (vendor_id),
        KEY idx_gr_orders_user (user_id)
      ) CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS operator_staff (
        id INT AUTO_INCREMENT PRIMARY KEY,
        emp_no VARCHAR(30) NULL,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20) NULL,
        level VARCHAR(10) DEFAULT 'L2',
        \`role\` VARCHAR(50) NULL,
        station VARCHAR(100) NULL,
        month_orders INT DEFAULT 0,
        rating DECIMAL(3,2) DEFAULT 0,
        contract_type VARCHAR(10) DEFAULT '正式',
        contract_end VARCHAR(10) NULL,
        status VARCHAR(20) DEFAULT 'active',
        can_extra TINYINT DEFAULT 0,
        note VARCHAR(200) NULL,
        org_id INT NULL,                       -- 归属机构（scope 行级过滤用；NULL=平台级，全员可见）
        vendor_id INT NULL,                    -- 归属运营商（同上）
        created_at VARCHAR(30),
        updated_at VARCHAR(30),
        UNIQUE KEY uk_staff_emp_no (emp_no)
      ) CHARSET=utf8mb4`,
    ];
    for (const ddl of ddls) {
      await conn.execute(ddl);
    }
    // 初始化 jz_categories 种子数据（到家 4 类 + 本地生活 7 频道，同 Tab 并列）
    const jzCatSeeds = [
      ['cleaning', '保洁', '🧹', 1],
      ['repair',   '维修', '🔧', 2],
      ['moving',   '搬家', '📦', 3],
      ['nanny',    '保姆', '👶', 4],
      ['telecom', '电讯服务', '📱', 5],
      ['insurance', '财险服务', '🛡', 6],
      ['consumer_finance', '消费金融', '💳', 7],
      ['health_care', '健康养老', '🏥', 8],
      ['home_maintain', '居家维护', '🏠', 9],
      ['asset', '资产服务', '🏦', 10],
      ['recycle', '二手回收', '♻️', 11],
      ['community', '社区服务', '🏘', 12],
    ];
    for (const [catId, catName, catIcon, catOrder] of jzCatSeeds) {
      await conn.execute(
        'INSERT IGNORE INTO jz_categories(id, name, icon, sort_order, enabled) VALUES (?, ?, ?, ?, 1)',
        [catId, catName, catIcon, catOrder]
      );
    }
    // 本地生活频道演示 SKU / 商家 / 商品（INSERT IGNORE，存量库可增量补齐）
    const lifeSkuSeeds = [
      [25,'telecom','宽带新装 · 千兆','telecom-broadband','装维上门 · 当周开通',99,'起',120,1],
      [26,'telecom','号码携转 · 套餐','telecom-portability','携号转网 · 套餐对比',0,'咨询',30,2],
      [27,'insurance','家财险 · 基础版','insurance-home-basic','漏水/火灾/盗抢',128,'/年',0,1],
      [28,'insurance','租客责任险','insurance-tenant','第三者责任 · 押金替代',68,'/年',0,2],
      [29,'consumer_finance','分期免息 · 租住','finance-rent-installment','首付灵活 · 信用评估',0,'咨询',0,1],
      [30,'consumer_finance','消费贷 · 额度查询','finance-credit-limit','额度秒批 · 随借随还',0,'咨询',0,2],
      [31,'health_care','养老陪护 · 日间','health-elder-day','持证护理 · 日间到岗',280,'/天',480,1],
      [32,'health_care','体检套餐 · 基础','health-checkup-basic','三甲对接 · 报告解读',299,'起',0,2],
      [33,'home_maintain','管道养护 · 季度','maintain-pipe-quarter','疏通+防堵养护',198,'/季',90,1],
      [34,'home_maintain','家电保养 · 套餐','maintain-appliance','空调/冰箱/洗衣机',159,'起',120,2],
      [35,'asset','资产评估 · 房产','asset-appraisal','持证评估师上门',500,'起',0,1],
      [36,'asset','托管运营 · 咨询','asset-custody','租金托管 · 报表透明',0,'咨询',0,2],
      [37,'recycle','旧家电回收','recycle-appliance','上门估价 · 当日清运',0,'估价',60,1],
      [38,'recycle','家具回收 · 套装','recycle-furniture','大件拆装 · 环保处置',0,'估价',90,2],
      [39,'community','社区团购 · 日配','community-groupbuy','生鲜果蔬 · 次日达',0,'咨询',0,1],
      [40,'community','便民代办 · 跑腿','community-errand','取送件 · 代缴代办',29,'起',60,2],
    ];
    for (const [id, cat, name, slug, spec, price, unit, dur, ord] of lifeSkuSeeds) {
      await conn.execute(
        `INSERT IGNORE INTO jz_skus(id,category_id,name,slug,spec,price_from,price_unit,duration_min,
          tags,badges,sales_text,rating_score,worker_min_level,includes,service_flow,service_notice,sort_order,enabled)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        [id, cat, name, slug, spec, price, unit, dur,
          JSON.stringify(['本地生活']), JSON.stringify(['精选']), '试点开放', 4.7, 'L2',
          JSON.stringify(['在线预约', '认证服务商', '进度可查']),
          JSON.stringify(['选择服务', '提交需求', '服务商确认', '履约完成']),
          JSON.stringify(['价格以实际报价为准', '部分服务需资质核验']), ord]
      );
    }
    // 本地生活商家用 141+，避免撞本地已有 cleaning/moving 演示商家 41/42
    const lifeVendors = [
      [141,'telecom','联通装维优选','📶','全市覆盖',4.6,1200],
      [142,'insurance','安居财险专区','🛡','全国',4.8,5600],
      [143,'consumer_finance','江苏银行消费金融','💳','本地',4.7,3200],
      [144,'health_care','康养到家','🏥','全市',4.8,2100],
      [145,'home_maintain','安居养护','🔧','全市',4.6,1800],
      [146,'asset','贝壳资产顾问','🏦','本地',4.7,900],
      [147,'recycle','绿色回收站','♻️','全市',4.5,4400],
      [148,'community','邻里便民站','🏘','全市',4.6,2600],
      [151,'moving','蓝犀牛搬家','🚚','全市覆盖',4.6,2400],
      [152,'nanny','阿姨来了','👶','全市覆盖',4.8,8800],
    ];
    const nowLife = new Date().toISOString().slice(0, 19);
    for (const [id, type, name, logo, address, rating, reviews] of lifeVendors) {
      await conn.execute(
        `INSERT IGNORE INTO jz_vendors(id,type,name,logo,address,rating,review_count,badges,live,start_price,unit,hours,status,sort_order,created_at,updated_at,city_ids)
         VALUES(?,?,?,?,?,?,?,?,0,0,'起','09:00-21:00','active',?,?,?,NULL)`,
        [id, type, name, logo, address, rating, reviews, JSON.stringify(['whitelist']), id, nowLife, nowLife]
      );
    }
    const lifeProducts = [
      [5101,141,25,'宽带新装 · 千兆','装维上门',99],
      [5102,141,26,'号码携转 · 套餐','携号转网',0],
      [5103,142,27,'家财险 · 基础版','漏水火灾盗抢',128],
      [5104,142,28,'租客责任险','押金替代方案',68],
      [5105,143,29,'分期免息 · 租住','信用评估',0],
      [5106,143,30,'消费贷 · 额度查询','随借随还',0],
      [5107,144,31,'养老陪护 · 日间','持证护理',280],
      [5108,144,32,'体检套餐 · 基础','三甲对接',299],
      [5109,145,33,'管道养护 · 季度','疏通养护',198],
      [5110,145,34,'家电保养 · 套餐','多品类保养',159],
      [5111,146,35,'资产评估 · 房产','持证上门',500],
      [5112,146,36,'托管运营 · 咨询','租金托管',0],
      [5113,147,37,'旧家电回收','上门估价',0],
      [5114,147,38,'家具回收 · 套装','大件清运',0],
      [5115,148,39,'社区团购 · 日配','生鲜果蔬',0],
      [5116,148,40,'便民代办 · 跑腿','取送代缴',29],
      // 搬家 / 保姆：保证城市过滤后类目仍可见
      [5151,151,6,'居民搬家 · 同城','金杯车·2名师傅',398],
      [5152,151,7,'日式搬家 · 全包','打包收纳+还原',1680],
      [5153,151,17,'长途搬家 · 跨城','厢式货车',1200],
      [5154,151,18,'钢琴搬运 · 专业','立式/三角可接',800],
      [5251,152,8,'钟点工 · 3小时','做饭保洁',128],
      [5252,152,9,'育儿嫂 · 住家','持证育儿',8800],
      [5253,152,21,'住家保姆 · 全职','做饭保洁照护',6800],
      [5254,152,23,'月嫂 · 26天','三甲护理',12800],
    ];
    for (const [pid, vid, skuId, title, sub, price] of lifeProducts) {
      await conn.execute(
        `INSERT IGNORE INTO jz_products(id,vendor_id,title,subtitle,category,duration_hours,area_range,unit,
          price,original_price,discount_label,earliest_time,advance_booking_hours,sales_count,rating,
          service_tags,channel_sku_id,status,sort_order)
         VALUES(?,?,?,?,?,1,'','起',?,?,NULL,'今天 18:00',2,100,4.7,?,?,'on',?)`,
        [pid, vid, title, sub, title.split('·')[0].trim(), price, price ? Math.round(price * 1.5) : null,
          JSON.stringify(['本地生活', '可预约']), skuId, pid]
      );
    }
    // 初始化 channels 种子数据（bzf 已转为 topic，不再作为 channel —— 见 CLAUDE.md 房源库通用化）
    const channelSeeds = [
      ['rental', '长租', 0],
      ['trade', '卖旧买新专区', 2],
      ['jiazheng', '生活服务专区', 3],
      ['minsu', '民宿', 4],
      ['newhouse', '新房', 5],
      ['resale', '二手', 6],
    ];
    for (const [id, label, order] of channelSeeds) {
      await conn.execute(
        'INSERT IGNORE INTO channels(id, label, sort_order, enabled) VALUES (?, ?, ?, 1)',
        [id, label, order]
      );
    }
    // 初始化 settings 种子数据
    const settingSeeds = [
      ['show_city_switcher', '1'],
      ['show_life_service', '1'],
      ['channel_name', (channelBrand && channelBrand.DEFAULT_CHANNEL_NAME) || '新居住频道'],
    ];
    for (const [k, v] of settingSeeds) {
      await conn.execute(
        'INSERT IGNORE INTO settings(`key`, value) VALUES (?, ?)',
        [k, v]
      );
    }
    // 旧库 CREATE TABLE IF NOT EXISTS 不会补列；导入/查询前先对齐
    const extraCols = [
      ['jz_vendors', 'city_ids TEXT'],
      ['jz_vendors', 'district_id INT'],
      ['jz_vendors', 'phone VARCHAR(50)'],
      ['jz_vendors', 'fulfillment VARCHAR(50) DEFAULT \'to_home\''],
      ['jz_vendors', 'vendor_no VARCHAR(100)'],
      ['jz_vendors', 'whitelist_id INT'],
      ['jz_vendors', 'platform_certs TEXT'],
      ['jz_vendors', 'webhook_url VARCHAR(500)'],
      ['jz_vendors', "consult_mode VARCHAR(20) DEFAULT 'consultant'"],   // 商家维度咨询优先展示：consultant=咨询顾问(400) / ai=AI 咨询（未上线）
      ['jz_products', 'city_id INT'],
      ['jz_products', 'channel_sku_id INT'],
      ['jz_products', 'path VARCHAR(500)'],
      ['jz_products', 'query VARCHAR(500)'],
    ];
    for (const [table, ddl] of extraCols) {
      try { await conn.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`); } catch (_) { /* 列已存在 */ }
    }
    // 保租房/卖旧买新种子（projects 为空时从 juzhu/data*.json 灌入）
    if (housingSeedAll) {
      try {
        const hs = await housingSeedAll(conn);
        if (hs && !hs.skipped) console.log('housingSeedAll', JSON.stringify(hs.inserted || {}));
      } catch (e) { console.warn('housingSeedAll warn:', e.message); }
    }
    if (housingBackfillPhotos) {
      try {
        const bf = await housingBackfillPhotos(conn);
        if (bf && (bf.inserted || bf.covers || bf.units)) console.log('housingBackfillPhotos', JSON.stringify(bf));
      } catch (e) { console.warn('housingBackfillPhotos warn:', e.message); }
    }
    // 源 MySQL juzhu 快照（商家/SKU/订单）；文件缺失则跳过
    if (juzhuImportAll) {
      try {
        const imp = await juzhuImportAll(conn);
        if (imp && !imp.skipped) console.log('juzhuImportAll', JSON.stringify(imp.inserted || {}));
      } catch (e) { console.warn('juzhuImportAll warn:', e.message); }
    }
    // 家政全量种子数据（对应表仍为空时补 demo）
    if (jzSeedAll) {
      try { await jzSeedAll(conn); } catch (e) { console.warn('jzSeedAll warn:', e.message); }
    }
    // 运营商员工花名册种子（INSERT IGNORE + uk_staff_emp_no 幂等，多实例并发安全）
    if (staffSeedAll) {
      try { await staffSeedAll(conn); } catch (e) { console.warn('staffSeedAll warn:', e.message); }
    }
    await ensureGrOrdersShape(conn);
    try {
      await conn.execute('ALTER TABLE gr_orders CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    } catch (_) { /* 5.7 无 0900 或已是该 collation */ }
    // 迁移：补充可能缺失的列（ALTER TABLE ... ADD COLUMN IF NOT EXISTS 在 MySQL 8.0 不支持，用 try/catch 忽略重复列错误）
    const migrations = [
      "ALTER TABLE projects ADD COLUMN contact_phone VARCHAR(50)",
      // 预订订单归属（登录用户；老订单 user_id 为空，可按登录账号手机号认领）
      "ALTER TABLE booking_orders ADD COLUMN user_id VARCHAR(64)",
      "ALTER TABLE booking_orders ADD KEY idx_bo_user (user_id)",
      // 支付（阶段3 旅居收银台）：minsu=unpaid/paid/refunded；rental 预订单 NULL（不涉及）
      "ALTER TABLE booking_orders ADD COLUMN pay_status VARCHAR(20)",
      "ALTER TABLE booking_orders ADD COLUMN pay_method VARCHAR(50)",
      "ALTER TABLE booking_orders ADD COLUMN pay_at VARCHAR(30)",
      "ALTER TABLE booking_orders ADD KEY idx_bo_pay (pay_status)",
      // 区级「房源量」= 下属租赁住宿项目 managed_unit_count 加总（勿用户型×40 覆盖真实在管套数）
      `UPDATE districts d
         SET managed_unit_count = (
           SELECT COALESCE(SUM(COALESCE(p.managed_unit_count, p.unit_count)), 0)
           FROM projects p WHERE p.district_id = d.id AND p.channel = 'rental'
         ),
         unit_count = (
           SELECT COALESCE(SUM(p.unit_count), 0)
           FROM projects p WHERE p.district_id = d.id AND p.channel = 'rental'
         ),
         project_count = (
           SELECT COUNT(*) FROM projects p WHERE p.district_id = d.id AND p.channel = 'rental'
         ),
         has_projects = CASE WHEN (
           SELECT COUNT(*) FROM projects p WHERE p.district_id = d.id AND p.channel = 'rental'
         ) > 0 THEN 1 ELSE 0 END`,
    ];
    for (const sql of migrations) {
      try { await conn.execute(sql); } catch (_) { /* 列已存在，忽略 */ }
    }
    // 花名册归属列（scope 行级过滤；NULL=平台级）——存量表渐进补列
    try { await conn.execute('ALTER TABLE operator_staff ADD COLUMN org_id INT NULL'); } catch (_) {}
    try { await conn.execute('ALTER TABLE operator_staff ADD COLUMN vendor_id INT NULL'); } catch (_) {}
    // 账号与权限中心：orgs/accounts/roles/account_roles/sessions/audit_log + 角色种子 + platform_admin 引导
    await authCenter.ensureAuthSchema(conn);
    // 审计留存（默认 180 天，AUDIT_RETENTION_DAYS 可调）
    await authCenter.cleanupAudit().catch((e) => console.warn('cleanupAudit warn:', e.message));
    schemaEnsured = true;
  } finally {
    await conn.end();
  }
}

module.exports.ensureSchema = ensureSchema;

function jsonReply(res, data, code) {
  const body = JSON.stringify(data);
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 读取请求体 JSON（支持从已缓冲的 rawBody 读取）
function readBody(req) {
  if (req._rawBody !== undefined) {
    try { return Promise.resolve(req._rawBody ? JSON.parse(req._rawBody) : {}); }
    catch (e) { return Promise.resolve({}); }
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      req._rawBody = data;
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// 将已缓冲的 body 作为可读流重新注入（供代理时使用）
function injectBodyToRequest(proxyReq, rawBody) {
  if (rawBody) {
    proxyReq.write(rawBody);
  }
  proxyReq.end();
}

// slugify：去除括号内容，空格转连字符
function slugify(name) {
  name = (name || '').replace(/[（(].*?[）)]/g, '').trim();
  return name.replace(/\s+/g, '-') || 'item';
}

function cityDupReply(res, err) {
  const kind = housingCities ? housingCities.classifyDupKey(err) : null;
  if (!kind) return jsonReply(res, { error: 'DB 查询失败: ' + (err && err.message ? err.message : err) }, 500);
  const d = housingCities.duplicateCityError(kind);
  return jsonReply(res, { error: d.error }, d.status);
}

async function resolveBodyCityId(conn, body, emptyMsg) {
  const raw = body && body.city_id;
  if (raw != null && String(raw).trim() !== '') {
    const cid = parseInt(raw, 10);
    if (!cid) return { error: '城市不存在', status: 400 };
    const [rows] = await conn.execute('SELECT id FROM cities WHERE id=?', [cid]);
    if (!rows.length) return { error: '城市不存在', status: 400 };
    return { cityId: rows[0].id };
  }
  const [rows] = await conn.execute('SELECT id FROM cities ORDER BY id LIMIT 1');
  if (!rows.length) return { error: emptyMsg || '请先配置城市', status: 400 };
  return { cityId: rows[0].id };
}

async function insertCityRow(conn, fields) {
  const cols = Object.keys(fields);
  await conn.execute(
    `INSERT INTO cities(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    cols.map((k) => fields[k])
  );
  const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
  const [rows] = await conn.execute('SELECT * FROM cities WHERE id=?', [r[0].id]);
  return rows[0];
}

async function updateCityRow(conn, cid, fields) {
  const cols = Object.keys(fields);
  await conn.execute(
    `UPDATE cities SET ${cols.map((k) => `${k}=?`).join(', ')} WHERE id=?`,
    cols.map((k) => fields[k]).concat(cid)
  );
  const [rows] = await conn.execute('SELECT * FROM cities WHERE id=?', [cid]);
  return rows[0];
}

// 确保项目 slug 唯一
async function uniqueProjectSlug(conn, channel, name, slug) {
  let base = slug || slugify(name);
  let candidate = base;
  let n = 1;
  while (true) {
    const [rows] = await conn.execute(
      'SELECT id FROM projects WHERE channel=? AND slug=?', [channel, candidate]
    );
    if (!rows.length) break;
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

// 确保单元 slug 唯一（同项目内）
async function uniqueUnitSlug(conn, projectId, name, slug, excludeId) {
  let base = slug || slugify(name) || 'unit';
  let candidate = base;
  let n = 1;
  while (true) {
    const sql = excludeId
      ? 'SELECT id FROM units WHERE project_id=? AND slug=? AND id!=?'
      : 'SELECT id FROM units WHERE project_id=? AND slug=?';
    const params = excludeId ? [projectId, candidate, excludeId] : [projectId, candidate];
    const [rows] = await conn.execute(sql, params);
    if (!rows.length) break;
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

// 同步行政区统计
async function syncDistrictStats(conn, districtId) {
  if (!districtId) return;
  const [[stat]] = await conn.execute(
    `SELECT COUNT(DISTINCT p.id) AS pc,
            COALESCE(SUM(p.unit_count),0) AS uc,
            COALESCE(SUM(p.managed_unit_count),0) AS mc
     FROM projects p WHERE p.district_id=?`, [districtId]
  );
  await conn.execute(
    'UPDATE districts SET project_count=?, unit_count=?, managed_unit_count=? WHERE id=?',
    [stat.pc, stat.uc, stat.mc, districtId]
  );
}

// 同步项目 unit_count
async function syncProjectUnitCount(conn, projectId) {
  const [[r]] = await conn.execute(
    'SELECT COUNT(*) AS c FROM units WHERE project_id=?', [projectId]
  );
  await conn.execute('UPDATE projects SET unit_count=? WHERE id=?', [r.c, projectId]);
}

// 同步 unit cover_image（取第一张 is_cover=1 的图，无则取第一张）
async function syncUnitCover(conn, unitId) {
  const [covers] = await conn.execute(
    "SELECT file_path FROM photos WHERE entity_type='unit' AND entity_id=? AND is_cover=1 ORDER BY sort_order LIMIT 1",
    [unitId]
  );
  if (covers.length) {
    await conn.execute('UPDATE units SET cover_image=? WHERE id=?', [covers[0].file_path, unitId]);
    return;
  }
  const [firsts] = await conn.execute(
    "SELECT file_path FROM photos WHERE entity_type='unit' AND entity_id=? ORDER BY sort_order LIMIT 1",
    [unitId]
  );
  if (firsts.length) {
    await conn.execute('UPDATE units SET cover_image=? WHERE id=?', [firsts[0].file_path, unitId]);
  }
}

// Node.js 直连 MySQL 实现全部管理接口（Python 不可用时 fallback）
async function handleApiDirect(urlPath, qs, req, res) {
  try {
    // /api/juzhu/admin/* 全方法强制 API Key（与 juzhu/server.py 对齐；auth/login|check 除外）
    if (!(await assertAdminAuthorized(urlPath, req, res))) return;
    if (!(await assertApiAuthorized(urlPath, req, res))) return;

    // ── 账号中心权限闸（perm_registry.cjs 单一数据源）：admin 域按路由细粒度校验 + 细粒度审计 ──
    // 写操作不再一刀切 admin.write（project.update / account.create / settings.update ...），
    // GET 亦收口（dictionary/cities/projects 等此前对旧全局 key 无任何权限要求）。
    if (urlPath.startsWith(ADMIN_PREFIX)) {
      const rule = permRegistry.match(urlPath, req.method);
      if (rule && rule.guard === 'ratingSubmit') {
        // 评级提交双通道：账号主体按权限点，旧 vendor 会话由处理器内 owner_vendor_id 把关
        if (!(await guardRatingSubmit(req, res))) return;
      } else if (rule && !rule.exempt) {
        if (!(await requirePerm(req, res, rule.perm, permRegistry.labelOf(rule.perm)))) return;
        if (req.method !== 'GET') {
          const p = req.principal;
          if (p && p.type === 'account') {
            const m = urlPath.match(new RegExp(rule.re));
            await authCenter.audit({
              accountId: p.account.id, principalType: 'account', roles: p.roles,
              action: rule.act || rule.perm, resource: rule.res || 'admin',
              resourceId: rule.idGroup != null && m ? m[rule.idGroup] : null,
              scopeLevel: authCenter.bestScopeLevel(p), ip: p.ip, ua: p.ua,
            });
          }
        }
      } else if (!rule && req.method !== 'GET') {
        // 未注册写路由回退旧行为：账号主体 + admin.write（新路由必须先进 perm_registry.ROUTES）
        const wp = await authCenter.principalOf(req).catch(() => null);
        if (!wp || wp.type === 'legacy') {
          return jsonReply(res, {
            error: 'forbidden',
            message: '旧全局 API Key 对管理域只读；请用管理员账号登录（POST /api/auth/login → Authorization: Bearer <token>）',
          }, 403);
        }
        if (!authCenter.hasPermission(wp, authCenter.P.ADMIN_WRITE)) {
          return jsonReply(res, { error: 'forbidden', message: '当前账号无管理写权限（admin.write）' }, 403);
        }
        req.principal = wp;
        await authCenter.audit({
          accountId: wp.account.id, principalType: 'account', roles: wp.roles,
          action: 'admin.write', resource: urlPath, scopeLevel: authCenter.bestScopeLevel(wp),
          ip: wp.ip, ua: wp.ua,
        });
      }
    }

    await ensureSchema();

    // ===== 商家 HMAC 开放接口（api_doc.md：家政 /api/juzhu/jiazheng/vendor/*；房源 /api/juzhu/housing/vendor/*）=====
    if (req.method === 'POST' && (urlPath === '/api/juzhu/callback' || urlPath.startsWith('/api/juzhu/jiazheng/vendor/') || urlPath.startsWith('/api/juzhu/housing/vendor/'))) {
      if (!vendorApi) return jsonReply(res, { code: 500, message: 'vendor_api module missing' }, 500);
      const body = await readBody(req);
      const vendors = await getVendorConfig();
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const out = await vendorApi.handleRequest(urlPath, body, conn, vendors);
        return jsonReply(res, out.data, out.status);
      } catch (e) {
        return jsonReply(res, { code: 500, message: String(e.message || e) }, 500);
      } finally {
        await conn.end();
      }
    }

    // ===== GET 只读接口 =====

    if (urlPath === '/api/juzhu/admin/dictionary' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const allCities = await queryRows('SELECT * FROM cities ORDER BY id');
      const city = housingCities
        ? housingCities.pickCity(allCities, qp.get('city'))
        : (allCities[0] || null);
      const districts = city
        ? await queryRows('SELECT * FROM districts WHERE city_id=? ORDER BY sort_order, id', [city.id])
        : [];
      const channels = await queryRows('SELECT * FROM channels ORDER BY sort_order, id');
      return jsonReply(res, { city, cities: allCities, districts, channels });
    }

    if (urlPath === '/api/juzhu/admin/cities' && req.method === 'GET') {
      const rows = await queryRows('SELECT * FROM cities ORDER BY id');
      return jsonReply(res, rows);
    }

    if ((urlPath === '/api/juzhu/admin/settings' || urlPath === '/api/juzhu/settings') && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const allCities = await queryRows('SELECT id, booking_phone, slug, name FROM cities ORDER BY id');
      const city = housingCities
        ? housingCities.pickCity(allCities, qp.get('city') || qp.get('city_id'))
        : (allCities[0] || null);
      const settings = await queryRows('SELECT `key`, value FROM settings');
      const settingsMap = {};
      for (const r of settings) settingsMap[r.key] = r.value;
      const brand = channelBrand
        ? channelBrand.fromSettingsMap(settingsMap)
        : { name: (settingsMap.channel_name || '新居住频道').trim() || '新居住频道' };
      return jsonReply(res, {
        booking_phone: city ? city.booking_phone : null,
        show_city_switcher: settingsMap.show_city_switcher !== '0',
        show_life_service: settingsMap.show_life_service !== '0',
        channel_name: brand.name,
      });
    }

    if (urlPath === '/api/juzhu/admin/projects' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = 'SELECT p.*, d.name AS district_name, v.name AS vendor_name FROM projects p'
        + ' LEFT JOIN districts d ON d.id=p.district_id'
        + ' LEFT JOIN jz_vendors v ON v.id=p.owner_vendor_id WHERE 1=1';
      const params = [];
      // scope 行级过滤（不可被 query 参数绕过；QS 显式条件与 scope 取交集，窄者胜）：
      // city → city_id IN；org → 本机构下商家；vendor → 本商家；self 档不放行管理列表
      const principal = await authCenter.principalOf(req).catch(() => null);
      if (principal && principal.type === 'account') {
        const scope = authCenter.scopeOf(principal);
        if (scope.level === 'city') {
          const cs = authCenter.scopeCitySql(scope, 'p.city_id');
          sql += cs.sql; params.push(...cs.params);
        } else if (scope.level === 'org' && scope.orgId != null) {
          sql += ' AND p.owner_vendor_id IN (SELECT id FROM jz_vendors WHERE org_id=?)'; params.push(scope.orgId);
        } else if (scope.level === 'vendor' && scope.vendorId != null) {
          sql += ' AND p.owner_vendor_id=?'; params.push(scope.vendorId);
        } else if (scope.level !== 'all') {
          return jsonReply(res, { error: 'forbidden', message: '当前账号数据范围不足（' + scope.level + ' 档）' }, 403);
        }
      }
      if (qp.get('city_id')) { sql += ' AND p.city_id=?'; params.push(parseInt(qp.get('city_id'))); }
      if (qp.get('channel')) { sql += ' AND p.channel=?'; params.push(qp.get('channel')); }
      if (qp.get('district_id')) { sql += ' AND p.district_id=?'; params.push(parseInt(qp.get('district_id'))); }
      if (qp.get('vendor_id')) { sql += ' AND p.owner_vendor_id=?'; params.push(parseInt(qp.get('vendor_id'))); }
      if (qp.get('q')) { sql += ' AND p.name LIKE ?'; params.push('%' + qp.get('q') + '%'); }
      sql += ' ORDER BY p.channel, p.sort_order, p.id';
      const rows = await queryRows(sql, params);
      rows.forEach((r) => parseJsonFields(r, ['tags', 'rating']));
      return jsonReply(res, rows);
    }

    // GET /admin/projects/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/projects\/(\d+)$/);
      if (m && req.method === 'GET') {
        const pid = parseInt(m[1]);
        const projs = await queryRows(
          'SELECT p.*, d.name AS district_name FROM projects p LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?',
          [pid]
        );
        if (!projs.length) return jsonReply(res, { error: 'not found' }, 404);
        parseJsonFields(projs[0], ['tags', 'rating']);
        const units = await queryRows('SELECT * FROM units WHERE project_id=? ORDER BY sort_order', [pid]);
        units.forEach((u) => parseJsonFields(u, ['tags', 'amenities', 'keeper', 'rent_detail', 'ext']));
        const photos = await queryRows(
          "SELECT * FROM photos WHERE entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id=?) ORDER BY entity_id, sort_order, id",
          [pid]
        );
        return jsonReply(res, { project: projs[0], units, photos });
      }
    }

    if (urlPath === '/api/juzhu/districts' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const cityKey = (qp.get('city') || '').trim();
      let sql = 'SELECT d.* FROM districts d';
      const params = [];
      if (cityKey) {
        sql += ' INNER JOIN cities c ON c.id=d.city_id WHERE (c.slug=? OR c.name=?)';
        params.push(cityKey, cityKey);
      }
      sql += ' ORDER BY d.sort_order, d.id';
      const rows = await queryRows(sql, params);
      return jsonReply(res, rows);
    }

    if (urlPath === '/api/juzhu/stats' && req.method === 'GET') {
      const [d] = await queryRows("SELECT COUNT(*) AS c FROM districts");
      const [pb] = await queryRows("SELECT COUNT(*) AS c FROM projects WHERE channel IN ('rental','minsu')");
      const [pt] = await queryRows("SELECT COUNT(*) AS c FROM projects WHERE channel='trade'");
      const [u] = await queryRows("SELECT COALESCE(SUM(managed_unit_count), 0) AS c FROM projects WHERE channel IN ('rental','minsu')");
      // 运营商维度（持有方资管大盘用）：仅持有 report.read 的账号会话可见——
      // 匿名/旧 Key 消费方（C 端/B 端演示页）拿降级响应，不再泄漏商家明细
      const principal = await authCenter.principalOf(req).catch(() => null);
      const isAccount = principal && principal.type === 'account';
      const canSeeOperators = isAccount &&
        (authCenter.hasPermission(principal, 'report.read') || authCenter.hasPermission(principal, '*'));
      let operators = [];
      let degraded = true;
      if (canSeeOperators) {
        const scope = authCenter.scopeOf(principal);
        const cityJoin = authCenter.scopeCitySql(scope, 'p.city_id');
        operators = await queryRows(
          `SELECT v.id, v.name, v.type, COUNT(p.id) AS project_count,
                  COALESCE(SUM(COALESCE(p.managed_unit_count, p.unit_count)), 0) AS unit_count
           FROM jz_vendors v
           LEFT JOIN projects p ON p.owner_vendor_id = v.id AND p.channel IN ('rental','minsu')${cityJoin.sql}
           WHERE v.type IN ('platform','housing_operator','lvju_host')
           GROUP BY v.id, v.name, v.type ORDER BY project_count DESC, v.id`,
          cityJoin.params
        );
        degraded = false;
      }
      return jsonReply(res, {
        districts: d.c,
        projects_rental: pb.c,
        projects_bzf: pb.c, // 旧字段别名（历史消费方兼容）
        projects_trade: pt.c,
        units: u.c,
        operators,
        degraded, // true = 匿名/无 report.read，operators 已剥离
      });
    }

    // ===== 写操作接口 =====

    // GET /admin/vendors/consult —— 商家维度咨询方式（C 端详情页左下角咨询入口优先级）
    if (urlPath === '/api/juzhu/admin/vendors/consult' && req.method === 'GET') {
      const rows = await queryRows(
        `SELECT v.id, v.name, v.type, v.consult_mode, COUNT(p.id) AS project_count
         FROM jz_vendors v LEFT JOIN projects p ON p.owner_vendor_id = v.id
         WHERE v.status='active'
         GROUP BY v.id, v.name, v.type, v.consult_mode
         ORDER BY project_count DESC, v.id`);
      return jsonReply(res, rows.map((v) => Object.assign(v, { consult_mode: v.consult_mode || 'consultant' })));
    }

    // PUT /admin/vendors/:id/consult-mode —— 切换商家咨询方式（consultant=咨询顾问/400 虚拟号；ai=AI 咨询，上线前勿切）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/vendors\/(\d+)\/consult-mode$/);
      if (m && req.method === 'PUT') {
        const body = await readBody(req);
        const mode = String(body.consult_mode || '').trim();
        if (!['consultant', 'ai'].includes(mode)) return jsonReply(res, { error: 'consult_mode 仅支持 consultant / ai' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [r] = await conn.execute(
            'UPDATE jz_vendors SET consult_mode=?, updated_at=? WHERE id=?',
            [mode, new Date().toISOString().slice(0, 19).replace('T', ' '), parseInt(m[1], 10)]
          );
          if (!r.affectedRows) return jsonReply(res, { error: 'not found' }, 404);
          return jsonReply(res, { ok: true, id: parseInt(m[1], 10), consult_mode: mode });
        } finally { await conn.end(); }
      }
    }

    // PUT /admin/settings
    if (urlPath === '/api/juzhu/admin/settings' && req.method === 'PUT') {
      const body = await readBody(req);
      let parsedChannel = null;
      if (body.channel_name !== undefined) {
        parsedChannel = channelBrand
          ? channelBrand.parseChannelName(body.channel_name)
          : { ok: !!(body.channel_name || '').trim(), name: String(body.channel_name || '').trim(), error: '频道名称不能为空', status: 400 };
        if (!parsedChannel.ok) return jsonReply(res, { error: parsedChannel.error }, parsedChannel.status);
      }
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        if (body.booking_phone !== undefined) {
          const phone = (body.booking_phone || '').trim() || null;
          const resolved = await resolveBodyCityId(conn, body);
          if (resolved.error) { conn.end(); return jsonReply(res, { error: resolved.error }, resolved.status); }
          await conn.execute('UPDATE cities SET booking_phone=? WHERE id=?', [phone, resolved.cityId]);
        }
        for (const k of ['show_city_switcher', 'show_life_service']) {
          if (k in body) {
            const v = body[k] ? '1' : '0';
            await conn.execute(
              'INSERT INTO settings(`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
              [k, v]
            );
          }
        }
        let channelOut;
        if (parsedChannel) {
          await conn.execute(
            'INSERT INTO settings(`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
            ['channel_name', parsedChannel.name]
          );
          channelOut = parsedChannel.name;
        }
        await conn.commit();
        const phoneOut = body.booking_phone !== undefined
          ? ((body.booking_phone || '').trim() || null)
          : undefined;
        const out = { ok: true, booking_phone: phoneOut };
        if (channelOut !== undefined) out.channel_name = channelOut;
        return jsonReply(res, out);
      } finally {
        await conn.end();
      }
    }

    // GET 已在上方；POST /admin/cities
    if (urlPath === '/api/juzhu/admin/cities' && req.method === 'POST') {
      const body = await readBody(req);
      const parsed = housingCities
        ? housingCities.validateCityWrite(body)
        : { ok: !!(body.name || '').trim(), error: '城市名称不能为空', status: 400, fields: { name: (body.name || '').trim(), slug: (body.slug || '').trim() || slugify(body.name) } };
      if (!parsed.ok) return jsonReply(res, { error: parsed.error }, parsed.status);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const city = await insertCityRow(conn, parsed.fields);
        await conn.commit();
        return jsonReply(res, { ok: true, city }, 201);
      } catch (e) {
        return cityDupReply(res, e);
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/cities/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/cities\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const cid = parseInt(m[1], 10);
        const body = await readBody(req);
        const parsed = housingCities
          ? housingCities.validateCityWrite(body, { partial: true })
          : { ok: false, error: '无更新字段', status: 400 };
        if (!parsed.ok) return jsonReply(res, { error: parsed.error }, parsed.status);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [existing] = await conn.execute('SELECT id FROM cities WHERE id=?', [cid]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '城市不存在' }, 404); }
          const city = await updateCityRow(conn, cid, parsed.fields);
          await conn.commit();
          return jsonReply(res, { ok: true, city });
        } catch (e) {
          return cityDupReply(res, e);
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/cities/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/cities\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const cid = parseInt(m[1], 10);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [existing] = await conn.execute('SELECT id FROM cities WHERE id=?', [cid]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '城市不存在' }, 404); }
          const [[cityCnt]] = await conn.execute('SELECT COUNT(*) AS c FROM cities');
          const [[distCnt]] = await conn.execute('SELECT COUNT(*) AS c FROM districts WHERE city_id=?', [cid]);
          const [[projCnt]] = await conn.execute('SELECT COUNT(*) AS c FROM projects WHERE city_id=?', [cid]);
          const guard = housingCities
            ? housingCities.canDeleteCity({
              cityCount: cityCnt.c, districtCount: distCnt.c, projectCount: projCnt.c,
            })
            : { ok: true };
          if (!guard.ok) { conn.end(); return jsonReply(res, { error: guard.error }, guard.status); }
          await conn.execute('DELETE FROM cities WHERE id=?', [cid]);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // PUT /admin/city（兼容旧前端：按 city_id 更新，缺省第一座；无城市则创建）
    if (urlPath === '/api/juzhu/admin/city' && req.method === 'PUT') {
      const body = await readBody(req);
      const parsed = housingCities
        ? housingCities.validateCityWrite(body)
        : { ok: !!(body.name || '').trim(), error: '城市名称不能为空', status: 400, fields: { name: (body.name || '').trim(), slug: (body.slug || '').trim() || slugify(body.name) } };
      if (!parsed.ok) return jsonReply(res, { error: parsed.error }, parsed.status);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        let cid = null;
        if (body.city_id != null && String(body.city_id).trim() !== '') {
          cid = parseInt(body.city_id, 10);
          const [existing] = await conn.execute('SELECT id FROM cities WHERE id=?', [cid]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '城市不存在' }, 404); }
        } else {
          const [rows] = await conn.execute('SELECT id FROM cities ORDER BY id LIMIT 1');
          cid = rows.length ? rows[0].id : null;
        }
        let city;
        if (!cid) city = await insertCityRow(conn, parsed.fields);
        else city = await updateCityRow(conn, cid, parsed.fields);
        await conn.commit();
        return jsonReply(res, { ok: true, city });
      } catch (e) {
        return cityDupReply(res, e);
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/channels/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/channels\/([^/]+)$/);
      if (m && req.method === 'PUT') {
        const channelId = m[1];
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [existing] = await conn.execute('SELECT id FROM channels WHERE id=?', [channelId]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '频道不存在' }, 404); }
          const fields = [], params = [];
          if ('label' in body) {
            const label = (body.label || '').trim();
            if (!label) { conn.end(); return jsonReply(res, { error: '频道名称不能为空' }, 400); }
            fields.push('label=?'); params.push(label);
          }
          if ('sort_order' in body) { fields.push('sort_order=?'); params.push(parseInt(body.sort_order) || 0); }
          if ('enabled' in body) { fields.push('enabled=?'); params.push(body.enabled ? 1 : 0); }
          if ('note' in body) { fields.push('note=?'); params.push((body.note || '').trim() || null); }
          if (!fields.length) { conn.end(); return jsonReply(res, { error: '无更新字段' }, 400); }
          params.push(channelId);
          await conn.execute(`UPDATE channels SET ${fields.join(', ')} WHERE id=?`, params);
          await conn.commit();
          const [ch] = await conn.execute('SELECT * FROM channels WHERE id=?', [channelId]);
          return jsonReply(res, { ok: true, channel: ch[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // POST /admin/districts
    if (urlPath === '/api/juzhu/admin/districts' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return jsonReply(res, { error: '行政区名称不能为空' }, 400);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const resolved = await resolveBodyCityId(conn, body);
        if (resolved.error) { conn.end(); return jsonReply(res, { error: resolved.error }, resolved.status); }
        const cityId = resolved.cityId;
        const slug = (body.slug || name).trim() || name;
        const [existing] = await conn.execute('SELECT id FROM districts WHERE city_id=? AND slug=?', [cityId, slug]);
        if (existing.length) { conn.end(); return jsonReply(res, { error: 'slug 已存在' }, 400); }
        await conn.execute(
          'INSERT INTO districts(city_id, name, slug, note, sort_order, cover_image, has_projects) VALUES (?,?,?,?,?,?,?)',
          [cityId, name, slug, (body.note || '').trim() || null, parseInt(body.sort_order) || 999,
           (body.cover_image || '').trim() || null, parseInt(body.has_projects) || 0]
        );
        const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
        const did = r[0].id;
        await syncDistrictStats(conn, did);
        await conn.commit();
        const [districts] = await conn.execute('SELECT * FROM districts WHERE id=?', [did]);
        return jsonReply(res, { ok: true, district: districts[0] }, 201);
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/districts/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/districts\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const did = parseInt(m[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [existing] = await conn.execute('SELECT id FROM districts WHERE id=?', [did]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '行政区不存在' }, 404); }
          const mapping = { name: 'name', slug: 'slug', note: 'note', sort_order: 'sort_order',
            cover_image: 'cover_image', is_hot: 'is_hot', layout_tall: 'layout_tall',
            layout_wide: 'layout_wide', bg_class: 'bg_class', has_projects: 'has_projects' };
          const fields = [], params = [];
          for (const [key, col] of Object.entries(mapping)) {
            if (key in body) {
              let val = body[key];
              if (['sort_order','is_hot','layout_tall','layout_wide','has_projects'].includes(key)) {
                val = (val !== null && val !== '') ? parseInt(val) : 0;
              } else if (typeof val === 'string') {
                val = val.trim() || null;
              }
              fields.push(`${col}=?`); params.push(val);
            }
          }
          if (!fields.length) { conn.end(); return jsonReply(res, { error: '无更新字段' }, 400); }
          params.push(did);
          await conn.execute(`UPDATE districts SET ${fields.join(', ')} WHERE id=?`, params);
          await syncDistrictStats(conn, did);
          await conn.commit();
          const [districts] = await conn.execute('SELECT * FROM districts WHERE id=?', [did]);
          return jsonReply(res, { ok: true, district: districts[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/districts/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/districts\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const did = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [cnt] = await conn.execute('SELECT COUNT(*) AS c FROM projects WHERE district_id=?', [did]);
          if (cnt[0].c > 0) { conn.end(); return jsonReply(res, { error: `该区仍有 ${cnt[0].c} 个项目，无法删除` }, 400); }
          const [existing] = await conn.execute('SELECT id FROM districts WHERE id=?', [did]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '行政区不存在' }, 404); }
          await conn.execute('DELETE FROM districts WHERE id=?', [did]);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // POST /admin/projects
    if (urlPath === '/api/juzhu/admin/projects' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      const channel = body.channel || 'rental';
      const HOUSING_CHANNELS = ['rental', 'minsu', 'newhouse', 'resale'];
      if (!name) return jsonReply(res, { error: '项目名称不能为空' }, 400);
      if (!HOUSING_CHANNELS.includes(channel) && channel !== 'trade') {
        return jsonReply(res, { error: 'channel 须为 rental/minsu/newhouse/resale/trade' }, 400);
      }
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const resolved = await resolveBodyCityId(conn, body, '未配置城市');
        if (resolved.error) { conn.end(); return jsonReply(res, { error: resolved.error }, resolved.status); }
        const cityId = resolved.cityId;
        let districtId = body.district_id || null;
        if (HOUSING_CHANNELS.includes(channel)) {
          if (!districtId) { conn.end(); return jsonReply(res, { error: '房源项目须选择行政区' }, 400); }
          const [d] = await conn.execute('SELECT id FROM districts WHERE id=? AND city_id=?', [districtId, cityId]);
          if (!d.length) { conn.end(); return jsonReply(res, { error: '行政区不存在或不属于当前城市' }, 400); }
        } else {
          districtId = null;
        }
        const slug = await uniqueProjectSlug(conn, channel, name, body.slug);
        const [cityRows] = await conn.execute('SELECT name FROM cities WHERE id=?', [cityId]);
        const cityName = cityRows.length ? cityRows[0].name : '';
        let address = body.address;
        if (!address) {
          if (districtId) {
            const [d] = await conn.execute('SELECT name FROM districts WHERE id=?', [districtId]);
            address = d.length ? `${d[0].name} · ${name}` : `${cityName} · ${name}`;
          } else {
            address = `${cityName} · ${name}`;
          }
        }
        let contactPhone = null;
        try {
          contactPhone = 'contact_phone' in body ? validateRealPhone(body.contact_phone) : null;
        } catch (e) {
          conn.end();
          return jsonReply(res, { error: e.message }, 400);
        }
        let ownerVendorId = null;
        if (body.owner_vendor_id != null && body.owner_vendor_id !== '') {
          const [v] = await conn.execute('SELECT id FROM jz_vendors WHERE id=?', [parseInt(body.owner_vendor_id, 10)]);
          if (!v.length) { conn.end(); return jsonReply(res, { error: '商家不存在' }, 400); }
          ownerVendorId = parseInt(body.owner_vendor_id, 10);
        }
        await conn.execute(
          `INSERT INTO projects(city_id,district_id,channel,name,slug,cover_image,address,tags,
            sort_order,unit_count,price_from,is_featured,featured_rank,old_house_hint,contact_phone)
           VALUES (?,?,?,?,?,?,?,?,?,0,?,COALESCE(?,0),?,?,?)`,
          [cityId, districtId, channel, name, slug, body.cover_image || null, address,
           encodeTags(body.tags),
           body.sort_order || 999, body.price_from || null,
           body.is_featured ? 1 : 0, body.featured_rank || null, body.old_house_hint || null,
           contactPhone]
        );
        const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
        const pid = r[0].id;
        if (ownerVendorId != null || body.status != null || body.ext != null) {
          await conn.execute(
            'UPDATE projects SET owner_vendor_id=COALESCE(?, owner_vendor_id), status=COALESCE(?, status), ext=COALESCE(?, ext) WHERE id=?',
            [ownerVendorId,
             body.status != null ? String(body.status) : null,
             body.ext != null ? JSON.stringify(body.ext) : null,
             pid]
          );
        }
        if (districtId) await syncDistrictStats(conn, districtId);
        await conn.commit();
        const [projs] = await conn.execute(
          'SELECT p.*, d.name AS district_name FROM projects p LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?',
          [pid]
        );
        parseJsonFields(projs[0], ['tags', 'rating']);
        return jsonReply(res, { ok: true, project: projs[0] }, 201);
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/projects/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/projects\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const pid = parseInt(m[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [existing] = await conn.execute('SELECT id FROM projects WHERE id=?', [pid]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const sets = [], vals = [];
          const put = (col, val) => { sets.push(`${col}=?`); vals.push(val); };
          if ('name' in body) {
            put('name', body.name);
            put('slug', body.slug || slugify(body.name));
          } else if ('slug' in body) {
            put('slug', body.slug);
          }
          for (const col of ['address', 'cover_image', 'sort_order', 'price_from',
              'is_featured', 'featured_rank', 'old_house_hint', 'status']) {
            if (col in body) put(col, body[col]);
          }
          if ('ext' in body) put('ext', body.ext != null ? JSON.stringify(body.ext) : null);
          if ('owner_vendor_id' in body) {
            const val = body.owner_vendor_id;
            if (val === null || val === '') { conn.end(); return jsonReply(res, { error: 'owner_vendor_id 不可为空（商家维度必挂）' }, 400); }
            const [v] = await conn.execute('SELECT id FROM jz_vendors WHERE id=?', [parseInt(val, 10)]);
            if (!v.length) { conn.end(); return jsonReply(res, { error: '商家不存在' }, 400); }
            put('owner_vendor_id', parseInt(val, 10));
          }
          try {
            const contactPhone = contactPhoneFromBody(body);
            if (contactPhone !== undefined) put('contact_phone', contactPhone);
          } catch (e) {
            conn.end();
            return jsonReply(res, { error: e.message }, 400);
          }
          if ('tags' in body) put('tags', encodeTags(body.tags));
          if ('managed_unit_count' in body) {
            const val = body.managed_unit_count;
            put('managed_unit_count', (val !== null && val !== '') ? parseInt(val) : null);
          }
          if ('rating' in body) {
            const [statRow] = await conn.execute('SELECT rating_status FROM projects WHERE id=?', [pid]);
            if (statRow.length && ['draft', 'rejected', null].includes(statRow[0].rating_status)) {
              put('rating', body.rating ? JSON.stringify(body.rating) : null);
            }
          }
          if (sets.length) {
            vals.push(pid);
            await conn.execute(`UPDATE projects SET ${sets.join(', ')} WHERE id=?`, vals);
          }
          await syncProjectUnitCount(conn, pid);
          const [distRow] = await conn.execute('SELECT district_id FROM projects WHERE id=?', [pid]);
          if (distRow.length && distRow[0].district_id) {
            await syncDistrictStats(conn, distRow[0].district_id);
          }
          await conn.commit();
          const [projs] = await conn.execute(
            'SELECT p.*, d.name AS district_name FROM projects p LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?',
            [pid]
          );
          parseJsonFields(projs[0], ['tags', 'rating']);
          return jsonReply(res, { ok: true, project: projs[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/projects/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/projects\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const pid = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT district_id FROM projects WHERE id=?', [pid]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const did = rows[0].district_id;
          // 删除关联 photos、units
          const [units] = await conn.execute('SELECT id FROM units WHERE project_id=?', [pid]);
          for (const u of units) {
            await conn.execute("DELETE FROM photos WHERE entity_type='unit' AND entity_id=?", [u.id]);
          }
          await conn.execute('DELETE FROM units WHERE project_id=?', [pid]);
          await conn.execute('DELETE FROM projects WHERE id=?', [pid]);
          if (did) await syncDistrictStats(conn, did);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // POST /admin/projects/:id/units
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/projects\/(\d+)\/units$/);
      if (m && req.method === 'POST') {
        const pid = parseInt(m[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [projs] = await conn.execute('SELECT id FROM projects WHERE id=?', [pid]);
          if (!projs.length) { conn.end(); return jsonReply(res, { error: 'project not found' }, 404); }
          const name = body.name || '新户型';
          const slug = await uniqueUnitSlug(conn, pid, name, body.slug);
          await conn.execute(
            `INSERT INTO units(project_id,name,slug,area_sqm,layout_label,rent_monthly,price_total,
              tags,unit_spec,promo_price,amenities,keeper,rent_detail,sort_order,cover_image)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [pid, name, slug, body.area_sqm || null, body.layout_label || null,
             body.rent_monthly || null, body.price_total || null,
             encodeTags(body.tags),
             body.unit_spec || null, body.promo_price || null,
             body.amenities ? JSON.stringify(body.amenities) : null,
             body.keeper ? JSON.stringify(body.keeper) : null,
             body.rent_detail ? JSON.stringify(body.rent_detail) : null,
             body.sort_order || 999, body.cover_image || null]
          );
          const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
          const uid = r[0].id;
          await syncProjectUnitCount(conn, pid);
          await conn.commit();
          const [units] = await conn.execute('SELECT * FROM units WHERE id=?', [uid]);
          parseJsonFields(units[0], ['tags', 'amenities', 'keeper', 'rent_detail']);
          return jsonReply(res, { ok: true, unit: units[0] }, 201);
        } finally {
          await conn.end();
        }
      }
    }

    // GET /admin/units/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/units\/(\d+)$/);
      if (m && req.method === 'GET') {
        const uid = parseInt(m[1]);
        const units = await queryRows('SELECT * FROM units WHERE id=?', [uid]);
        if (!units.length) return jsonReply(res, { error: 'not found' }, 404);
        const photos = await queryRows(
          "SELECT * FROM photos WHERE entity_type='unit' AND entity_id=? ORDER BY sort_order",
          [uid]
        );
        return jsonReply(res, { unit: units[0], photos });
      }
    }

    // PUT /admin/units/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/units\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const uid = parseInt(m[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT project_id FROM units WHERE id=?', [uid]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const pid = rows[0].project_id;
          const sets = [], vals = [];
          const put = (col, val) => { sets.push(`${col}=?`); vals.push(val); };
          if ('name' in body) {
            put('name', body.name);
            put('slug', await uniqueUnitSlug(conn, pid, body.name, body.slug, uid));
          } else if ('slug' in body) {
            put('slug', await uniqueUnitSlug(conn, pid, null, body.slug, uid));
          }
          for (const col of ['area_sqm','layout_label','rent_monthly','price_total',
              'unit_spec','promo_price','sort_order','cover_image']) {
            if (col in body) put(col, body[col]);
          }
          if ('ext' in body) put('ext', body.ext != null ? JSON.stringify(body.ext) : null);
          if ('tags' in body) put('tags', encodeTags(body.tags));
          if ('amenities' in body) put('amenities', body.amenities ? JSON.stringify(body.amenities) : null);
          if ('keeper' in body) put('keeper', body.keeper ? JSON.stringify(body.keeper) : null);
          if ('rent_detail' in body) put('rent_detail', body.rent_detail ? JSON.stringify(body.rent_detail) : null);
          if (sets.length) {
            vals.push(uid);
            await conn.execute(`UPDATE units SET ${sets.join(', ')} WHERE id=?`, vals);
          }
          await syncProjectUnitCount(conn, pid);
          await conn.commit();
          const [units] = await conn.execute('SELECT * FROM units WHERE id=?', [uid]);
          parseJsonFields(units[0], ['tags', 'amenities', 'keeper', 'rent_detail']);
          return jsonReply(res, { ok: true, unit: units[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/units/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/units\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const uid = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT project_id FROM units WHERE id=?', [uid]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const pid = rows[0].project_id;
          await conn.execute("DELETE FROM photos WHERE entity_type='unit' AND entity_id=?", [uid]);
          await conn.execute('DELETE FROM units WHERE id=?', [uid]);
          await syncProjectUnitCount(conn, pid);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // GET /admin/units/:id/photos
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/units\/(\d+)\/photos$/);
      if (m && req.method === 'GET') {
        const uid = parseInt(m[1]);
        const units = await queryRows('SELECT id FROM units WHERE id=?', [uid]);
        if (!units.length) return jsonReply(res, { error: 'unit not found' }, 404);
        const photos = await queryRows(
          "SELECT * FROM photos WHERE entity_type='unit' AND entity_id=? ORDER BY sort_order, id",
          [uid]
        );
        return jsonReply(res, { photos });
      }
    }

    // POST /admin/units/:id/photos  （仅支持 JSON body，不支持文件上传）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/units\/(\d+)\/photos$/);
      if (m && req.method === 'POST') {
        const uid = parseInt(m[1]);
        const ct = req.headers['content-type'] || '';
        if (ct.includes('multipart/form-data')) {
          return jsonReply(res, { error: '文件上传请使用 /api/juzhu/admin/upload 接口，Serverless 环境不支持直接上传图片到本机文件系统' }, 503);
        }
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [units] = await conn.execute('SELECT id FROM units WHERE id=?', [uid]);
          if (!units.length) { conn.end(); return jsonReply(res, { error: 'unit not found' }, 404); }
          const filePath = (body.file_path || '').trim();
          if (!filePath) { conn.end(); return jsonReply(res, { error: 'file_path 不能为空' }, 400); }
          const isCover = body.is_cover ? 1 : 0;
          let sortOrder = body.sort_order;
          if (sortOrder == null) {
            const [r] = await conn.execute(
              "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM photos WHERE entity_type='unit' AND entity_id=?",
              [uid]
            );
            sortOrder = r[0].n;
          }
          if (isCover) {
            await conn.execute("UPDATE photos SET is_cover=0 WHERE entity_type='unit' AND entity_id=?", [uid]);
          }
          await conn.execute(
            "INSERT INTO photos(entity_type, entity_id, file_path, source_path, is_cover, sort_order) VALUES ('unit', ?, ?, ?, ?, ?)",
            [uid, filePath, body.source_path || null, isCover, sortOrder]
          );
          const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
          const photoId = r[0].id;
          await syncUnitCover(conn, uid);
          await conn.commit();
          const [photos] = await conn.execute('SELECT * FROM photos WHERE id=?', [photoId]);
          return jsonReply(res, { ok: true, photo: photos[0] }, 201);
        } finally {
          await conn.end();
        }
      }
    }

    // PUT /admin/photos/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/photos\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const photoId = parseInt(m[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute(
            "SELECT entity_id FROM photos WHERE id=? AND entity_type='unit'", [photoId]
          );
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const uid = rows[0].entity_id;
          if (body.is_cover) {
            await conn.execute("UPDATE photos SET is_cover=0 WHERE entity_type='unit' AND entity_id=?", [uid]);
          }
          let isCoverVal = null;
          if ('is_cover' in body) isCoverVal = body.is_cover ? 1 : 0;
          await conn.execute(
            `UPDATE photos SET
               file_path=COALESCE(?, file_path),
               sort_order=COALESCE(?, sort_order),
               is_cover=COALESCE(?, is_cover)
             WHERE id=?`,
            [body.file_path ? body.file_path.trim() : null,
             body.sort_order != null ? body.sort_order : null,
             isCoverVal, photoId]
          );
          await syncUnitCover(conn, uid);
          await conn.commit();
          const [photos] = await conn.execute('SELECT * FROM photos WHERE id=?', [photoId]);
          return jsonReply(res, { ok: true, photo: photos[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/photos/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/photos\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const photoId = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute(
            "SELECT entity_id FROM photos WHERE id=? AND entity_type='unit'", [photoId]
          );
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const uid = rows[0].entity_id;
          await conn.execute('DELETE FROM photos WHERE id=?', [photoId]);
          await syncUnitCover(conn, uid);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // POST /admin/export（Serverless 无持久文件系统，跳过写文件，返回 ok）
    if (urlPath === '/api/juzhu/admin/export' && req.method === 'POST') {
      return jsonReply(res, { ok: true, stats: { note: 'Serverless 环境跳过 JSON 导出' } });
    }

    // POST /admin/upload（图片上传需要对象存储，此处返回提示）
    if (urlPath === '/api/juzhu/admin/upload' && req.method === 'POST') {
      return jsonReply(res, { error: 'Serverless 环境不支持本地文件上传，请先在外部上传图片并使用图片 URL' }, 503);
    }

    // POST /admin/projects/:id/rating/submit
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/projects\/(\d+)\/rating\/submit$/);
      if (m && req.method === 'POST') {
        const pid = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM projects WHERE id=?', [pid]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const proj = rows[0];
          // 权限：房主 vendor 或 platform（admin 会话/API Key）
          const sess = await requestSession(req);
          const owns = sess && sess.role === 'vendor' && proj.owner_vendor_id === sess.vendorId;
          if (!owns && !(await requireApiKey(req, res))) return;
          const dimsReq = RATING_DIMS[proj.channel];
          if (!dimsReq) { conn.end(); return jsonReply(res, { error: '该频道暂不支持评级（支持 rental/minsu）' }, 400); }
          if (proj.rating_status === 'pending') { conn.end(); return jsonReply(res, { error: '已在复核队列中' }, 400); }
          let rating = {};
          if (proj.rating) {
            try { rating = JSON.parse(proj.rating); } catch (_) { rating = {}; }
          }
          const dims = rating.dims || {};
          if (!dimsReq.every(k => dims[k] != null)) {
            conn.end();
            return jsonReply(res, { error: `请先保存 ${dimsReq.length} 维自评分（${proj.channel} 口径）` }, 400);
          }
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          rating.code = `${RATING_CODE_PREFIX[proj.channel] || 'SY'}-${pid}`;
          await conn.execute(
            "UPDATE projects SET rating=?, rating_status='pending', rating_submitted_at=?, rating_note=NULL WHERE id=?",
            [JSON.stringify(rating), now, pid]
          );
          await conn.commit();
          const [updated] = await conn.execute(
            'SELECT p.*, d.name AS district_name FROM projects p LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?',
            [pid]
          );
          return jsonReply(res, { ok: true, project: updated[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // ===== 项目虚拟号接口 =====

    // GET /api/juzhu/projects/:id/virtual-phone
    {
      const m = urlPath.match(/^\/api\/juzhu\/projects\/(\d+)\/virtual-phone$/);
      if (m && req.method === 'GET') {
        const pid = parseInt(m[1]);
        const rows = await queryRows('SELECT id, contact_phone, name FROM projects WHERE id=?', [pid]);
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        const realPhone = (rows[0].contact_phone || '').trim();
        if (!realPhone) return jsonReply(res, { error: '未配置联系电话' }, 400);

        const tpBase = (process.env.TP_BASE || 'http://tp-test.lianjia.com').replace(/\/$/, '');
        const tpAppId = (process.env.TP_APP_ID || '').trim();
        const tpAppKey = (process.env.TP_APP_KEY || '').trim();
        if (!tpAppId || !tpAppKey) {
          return jsonReply(res, { error: 'TP_APP_ID/TP_APP_KEY 未配置' }, 400);
        }

        // MD5 签名（与 tp_client.py generate_sign 对齐）
        const params = {
          app_id: tpAppId,
          ts: String(Math.floor(Date.now() / 1000)),
          number: realPhone,
          app_call_id: `juzhu-project-${pid}`,
        };
        const signStr = Object.entries(params)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join('&') + `&app_key=${tpAppKey}`;
        const sign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex');
        params.sign = sign;

        const tpQs = new URLSearchParams(params).toString();
        const tpUrl = `${tpBase}/bundling/alloc?${tpQs}`;

        try {
          const tpRes = await new Promise((resolve, reject) => {
            const tpLib = tpUrl.startsWith('https') ? require('https') : require('http');
            const tpReq = tpLib.get(tpUrl, { headers: { 'Accept': 'application/json' } }, tpResp => {
              let body = '';
              tpResp.on('data', d => body += d);
              tpResp.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('TP invalid JSON')); }
              });
            });
            tpReq.on('error', reject);
            tpReq.setTimeout(20000, () => { tpReq.destroy(); reject(new Error('TP timeout')); });
          });

          if (tpRes.errno !== 0 && tpRes.errno !== '0' && tpRes.errno != null) {
            return jsonReply(res, { error: tpRes.errmsg || `话务错误 errno=${tpRes.errno}` }, 502);
          }
          const tpData = tpRes.data || [];
          const tpItem = Array.isArray(tpData) ? tpData[0] : tpData;
          const rawVirtual = (tpItem && (tpItem.virtual_phone_number || tpItem.virtual_phone)) || '';
          if (!rawVirtual) return jsonReply(res, { error: '话务未返回虚拟号' }, 502);

          // 格式化虚拟号（与 tp_client.py format_virtual_phone 对齐）
          const [vMain, vExt] = rawVirtual.split('-');
          const mainDigits = (vMain || '').replace(/\D/g, '');
          const extDigits = (vExt || '').replace(/\D/g, '');
          const displayMain = mainDigits.length >= 10
            ? `${mainDigits.slice(0,3)} ${mainDigits.slice(3,6)} ${mainDigits.slice(6)}`
            : (mainDigits || vMain);
          const display = displayMain + (extDigits ? ` 转 ${extDigits}` : '');
          const tel = 'tel:' + mainDigits + (extDigits ? `,${extDigits}` : '');
          return jsonReply(res, { virtual_phone: rawVirtual, display, tel });
        } catch (e) {
          return jsonReply(res, { error: '暂时无法接通，请稍后重试' }, 502);
        }
      }
    }

    // ===== jiazheng 公开 C 端接口（Node.js 直连 MySQL 实现）=====

    // GET /api/juzhu/jiazheng/categories
    if (urlPath === '/api/juzhu/jiazheng/categories' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const cityName = (qp.get('city') || '').trim();
      let rows;
      if (cityName) {
        const tokens = await cityMatchTokens(cityName);
        rows = await queryRows(
          `SELECT DISTINCT c.* FROM jz_categories c
           WHERE c.enabled=1
             AND EXISTS (
               SELECT 1 FROM jz_skus s
               JOIN jz_products p ON p.channel_sku_id=s.id AND p.status='on'
               JOIN jz_vendors v ON v.id=p.vendor_id AND v.status='active'
               WHERE s.category_id=c.id
                 AND ${cityIdsClause('v', tokens)}
             )
           ORDER BY c.sort_order, c.id`,
          tokens
        );
      } else {
        rows = await queryRows('SELECT * FROM jz_categories WHERE enabled=1 ORDER BY sort_order, id');
      }
      return jsonReply(res, { items: rows });
    }

    // GET /api/juzhu/jiazheng/skus
    if (urlPath === '/api/juzhu/jiazheng/skus' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const cityName = (qp.get('city') || '').trim();
      const categoryId = (qp.get('category') || '').trim();
      const q = (qp.get('q') || '').trim();
      let sql = `SELECT s.*, c.name AS category_name, c.icon AS category_icon,
                   (SELECT MIN(p.price) FROM jz_products p
                    WHERE p.channel_sku_id=s.id AND p.status='on') AS product_min_price
                 FROM jz_skus s JOIN jz_categories c ON c.id=s.category_id
                 WHERE s.enabled=1 AND c.enabled=1
                   AND EXISTS (SELECT 1 FROM jz_products p WHERE p.channel_sku_id=s.id AND p.status='on')`;
      const params = [];
      if (cityName) {
        const tokens = await cityMatchTokens(cityName);
        sql += ` AND EXISTS (
                  SELECT 1 FROM jz_products p2
                  JOIN jz_vendors v2 ON v2.id=p2.vendor_id
                  WHERE p2.channel_sku_id=s.id AND p2.status='on'
                    AND v2.status='active'
                    AND ${cityIdsClause('v2', tokens)}
                )`;
        params.push(...tokens);
      }
      if (categoryId) { sql += ' AND s.category_id=?'; params.push(categoryId); }
      if (q) {
        sql += ' AND (s.name LIKE ? OR s.spec LIKE ?)';
        params.push('%' + q + '%', '%' + q + '%');
      }
      sql += ' ORDER BY s.category_id, s.sort_order, s.id';
      const rows = await queryRows(sql, params);
      const SKU_JSON_FIELDS = ['tags', 'badges', 'gallery', 'includes', 'service_flow', 'service_notice'];
      rows.forEach(r => parseJsonFields(r, SKU_JSON_FIELDS));
      return jsonReply(res, { items: rows });
    }

    // GET /api/juzhu/jiazheng/skus/:slug（C 端详情：对齐 Python 版字段契约）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/skus\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        const skus = await queryRows(
          `SELECT s.*, c.name AS category_name, c.icon AS category_icon,
                  (SELECT MIN(p.price) FROM jz_products p
                   WHERE p.channel_sku_id=s.id AND p.status='on') AS product_min_price
           FROM jz_skus s JOIN jz_categories c ON c.id=s.category_id
           WHERE s.slug=? AND s.enabled=1 AND c.enabled=1`,
          [slug]
        );
        if (!skus.length) return jsonReply(res, { error: 'not found' }, 404);
        const item = skus[0];
        parseJsonFields(item, ['tags', 'badges', 'gallery', 'includes', 'service_flow', 'service_notice']);

        const qp = new URLSearchParams(qs);
        const vendorId = qp.get('vendor') ? parseInt(qp.get('vendor')) : null;
        const cityName = (qp.get('city') || '').trim();
        let cityId = null;
        if (cityName) {
          const cityRows = await queryRows('SELECT id FROM cities WHERE name=? OR slug=? LIMIT 1', [cityName, cityName]);
          if (cityRows.length) cityId = cityRows[0].id;
        }

        // products：同 SPU 全部上架商品（双维度城市过滤，对齐 Python list_channel_sku_products）
        let prodSql = `SELECT p.*, v.name AS vendor_name, v.logo AS vendor_logo,
                         v.rating AS vendor_rating, v.review_count AS vendor_review_count,
                         v.type AS vendor_type
                       FROM jz_products p JOIN jz_vendors v ON v.id=p.vendor_id
                       WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'`;
        const prodParams = [item.id];
        if (vendorId) { prodSql += ' AND p.vendor_id=?'; prodParams.push(vendorId); }
        if (cityId !== null) {
          prodSql += ` AND p.city_id=? AND (v.city_ids IS NULL OR TRIM(v.city_ids)='' OR CONCAT(',', v.city_ids, ',') LIKE CONCAT('%,', ?, ',%'))`;
          prodParams.push(cityId, String(cityId));
        }
        prodSql += ' ORDER BY p.rating DESC, p.sales_count DESC, p.id';
        const products = await queryRows(prodSql, prodParams);
        products.forEach(p => parseJsonFields(p, ['service_tags']));

        // vendor：默认商品对应的商家（剥离密钥 + auth_badges）
        let product = null;
        let vendor = null;
        let workers = [];
        let reviews = [];
        if (products.length) {
          product = products[0];
          const vrows = await queryRows('SELECT * FROM jz_vendors WHERE id=?', [product.vendor_id]);
          if (vrows.length) {
            vendor = vrows[0];
            for (const f of ['hmac_key', 'url_link', 'order_detail_url']) delete vendor[f];
            parseJsonFields(vendor, ['badges']);
            composeRank(vendor);
            vendor.auth_badges = vendorAuthBadges(vendor);
            // workers：默认商品绑定的服务者优先，无绑定回退商家全员，取前 4
            workers = await queryRows(
              `SELECT w.* FROM jz_sku_workers sw JOIN jz_workers w ON w.id=sw.worker_id
               WHERE sw.product_id=? ORDER BY w.level DESC, w.rating DESC`, [product.id]
            );
            if (!workers.length) {
              workers = await queryRows(
                `SELECT * FROM jz_workers WHERE vendor_id=? AND status='active' ORDER BY level DESC, rating DESC LIMIT 4`, [vendor.id]
              );
            }
            workers = workers.slice(0, 4);
            workers.forEach(w => { parseJsonFields(w, ['certs', 'tags']); w.auth_badges = workerAuthBadges(w); });
          }
        }

        // vendors：多商家同款（比价/切换，对齐 Python list_channel_sku_vendors）
        let vendorSql = `SELECT p.id AS product_id, p.price, p.original_price, p.discount_label,
                           p.rating AS product_rating, p.sales_count,
                           v.id AS vendor_id, v.name AS vendor_name, v.logo AS vendor_logo,
                           v.rating AS vendor_rating, v.review_count, v.rank_label, v.badges
                         FROM jz_products p JOIN jz_vendors v ON v.id=p.vendor_id
                         WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'`;
        const vParams = [item.id];
        if (cityId !== null) {
          vendorSql += ` AND p.city_id=? AND (v.city_ids IS NULL OR TRIM(v.city_ids)='' OR CONCAT(',', v.city_ids, ',') LIKE CONCAT('%,', ?, ',%'))`;
          vParams.push(cityId, String(cityId));
        }
        vendorSql += ' ORDER BY p.rating DESC, p.sales_count DESC, p.id';
        const vendorRows = await queryRows(vendorSql, vParams);
        const vendors = [];
        const seenVendor = new Set();
        for (const row of vendorRows) {
          if (seenVendor.has(row.vendor_id)) continue;  // 一商家一行：同 vendor 多 product 取评分最高的
          seenVendor.add(row.vendor_id);
          parseJsonFields(row, ['badges']);
          row.auth_badges = vendorAuthBadges(row);
          vendors.push(row);
        }

        // related：同 category 的 4 个 SPU
        const related = await queryRows(
          `SELECT id, name, slug, cover_image, price_from, price_unit, rating_score, category_id
           FROM jz_skus WHERE enabled=1 AND category_id=? AND slug<>? ORDER BY sort_order, id LIMIT 4`,
          [item.category_id, item.slug]
        );
        related.forEach(r => parseJsonFields(r, ['gallery', 'tags', 'badges', 'includes', 'service_flow', 'service_notice']));

        // reviews：真实评价优先，不足 3 条补类目 fallback（对齐 Python _review_rows/_fallback_reviews）
        if (products.length) {
          const ids = products.slice(0, 8).map(p => p.id);
          const ph = ids.map(() => '?').join(',');
          const orderRows = await queryRows(
            `SELECT o.*, s.name AS sku_name FROM jz_orders o
             LEFT JOIN jz_products p ON p.id=o.sku_id
             LEFT JOIN jz_skus s ON s.id=p.channel_sku_id
             WHERE o.rating_json IS NOT NULL AND o.rating_json<>'' AND o.sku_id IN (${ph})
             ORDER BY COALESCE(o.updated_at, o.created_at) DESC LIMIT 6`,
            ids
          );
          for (const row of orderRows) {
            let rating = null;
            try { rating = JSON.parse(row.rating_json); } catch (e) { /* 非法 JSON 跳过 */ }
            if (!rating || !rating.score) continue;
            const score = parseFloat(rating.score) || 0;
            reviews.push({
              name: maskPhone(row.phone),
              score,
              tags: rating.tags || [],
              text: rating.text || ((row.sku_name || '本次服务') + '整体完成较稳定。'),
              created_at: (rating.created_at || row.updated_at || row.created_at || '').replace('T', ' ').replace('Z', '').slice(0, 16),
              reply: reviewReply(vendor && vendor.name, score),
            });
          }
          if (reviews.length < 3 && vendor) {
            const fallback = CATEGORY_REVIEW_FALLBACKS[item.category_id] || CATEGORY_REVIEW_FALLBACKS[vendor.type] || CATEGORY_REVIEW_FALLBACKS.cleaning;
            for (const f of fallback) {
              if (reviews.length >= 4) break;
              reviews.push(Object.assign({}, f, { reply: reviewReply(vendor.name, f.score || 0) }));
            }
          }
        }

        // merchant_intro（对齐 Python _merchant_intro）
        const merchant_intro = merchantIntroOf(vendor, product);

        return jsonReply(res, { item, related, product, products, vendor, vendors, workers, reviews, merchant_intro });
      }
    }

    // GET /api/juzhu/jiazheng/workers
    if (urlPath === '/api/juzhu/jiazheng/workers' && req.method === 'GET') {
      const rows = await queryRows(
        'SELECT * FROM jz_workers WHERE status=? ORDER BY credit_score DESC, completed_orders DESC LIMIT 20',
        ['active']
      );
      rows.forEach(r => parseJsonFields(r, ['tags']));
      return jsonReply(res, { items: rows });
    }

    // GET /api/juzhu/jiazheng/orders （须 API Key；phone 仅作过滤）
    if (urlPath === '/api/juzhu/jiazheng/orders' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const workerFilter = await restrictOrdersRead(req, res);
      if (workerFilter === null) return;
      const phone = (qp.get('phone') || '').trim();
      let sql = `SELECT o.*, s.name AS sku_name FROM jz_orders o
                 LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE 1=1`;
      const params = [];
      if (workerFilter) { sql += " AND o.worker_json IS NOT NULL AND JSON_VALID(o.worker_json) AND JSON_UNQUOTE(JSON_EXTRACT(o.worker_json, '$.id'))=?"; params.push(workerFilter); }
      if (phone) { sql += ' AND o.phone=?'; params.push(phone); }
      if (qp.get('status')) {
        const statuses = qp.get('status').split(',').filter(Boolean);
        if (statuses.length) {
          sql += ' AND o.status IN (' + statuses.map(() => '?').join(',') + ')';
          params.push(...statuses);
        }
      }
      if (qp.get('pay_status')) { sql += ' AND o.pay_status=?'; params.push(qp.get('pay_status')); }
      const limit = Math.min(parseInt(qp.get('limit') || '100'), 200);
      sql += ' ORDER BY o.created_at DESC LIMIT ' + limit; // limit 已 parseInt+封顶，内联（mysql2 预处理不接受 LIMIT 绑定）
      const rows = await queryRows(sql, params);
      return jsonReply(res, { items: rows });
    }

    // GET /api/juzhu/jiazheng/orders/stats （需 API Key，必须在 orders/:id 之前）
    if (urlPath === '/api/juzhu/jiazheng/orders/stats' && req.method === 'GET') {
      if (!(await requireApiKey(req, res))) return;
      const wf = await restrictOrdersRead(req, res);
      if (wf !== undefined) return jsonReply(res, { error: 'forbidden', message: '统计仅管理账号可见' }, 403);
      const [pendingR] = await queryRows("SELECT COUNT(*) AS c FROM jz_orders WHERE status='pending'");
      const [dispatchedR] = await queryRows("SELECT COUNT(*) AS c FROM jz_orders WHERE status='dispatched'");
      const [doneR] = await queryRows("SELECT COUNT(*) AS c FROM jz_orders WHERE status='done' OR status='rated'");
      const [unpaidR] = await queryRows("SELECT COUNT(*) AS c FROM jz_orders WHERE pay_status='unpaid'");
      return jsonReply(res, {
        pending: pendingR.c, dispatched: dispatchedR.c, done: doneR.c, unpaid: unpaidR.c,
      });
    }

    // GET /api/juzhu/jiazheng/orders/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/orders\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const workerFilter = await restrictOrdersRead(req, res);
        if (workerFilter === null) return;
        const orderId = m[1];
        const rows = await queryRows(
          `SELECT o.*, s.name AS sku_name FROM jz_orders o
           LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE o.id=?`,
          [orderId]
        );
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        if (workerFilter) {
          let mine = false;
          try { mine = rows[0].worker_json && String(JSON.parse(rows[0].worker_json).id) === workerFilter; } catch (_) {}
          if (!mine) return jsonReply(res, { error: 'forbidden', message: '非派给你的工单' }, 403);
        }
        return jsonReply(res, rows[0]);
      }
    }

    // ===== 公开 C 端读接口 =====

    // GET /api/juzhu/cities
    if (urlPath === '/api/juzhu/cities' && req.method === 'GET') {
      const rows = await queryRows('SELECT * FROM cities ORDER BY id');
      return jsonReply(res, rows);
    }

    // GET /api/juzhu/catalog?city=shenyang —— C 端保租房整包（替代 data.json）
    // lite=1：首页首屏只要城市/区/项目封面与统计，不下发户型与全量 photos
    if (urlPath === '/api/juzhu/catalog' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const cityKey = (qp.get('city') || '').trim();
      const lite = qp.get('lite') === '1' || qp.get('lite') === 'true';
      const qpChannel = (qp.get('channel') || '').trim();
      const qpTopic = (qp.get('topic') || '').trim();
      const memoKey = (lite ? 'L:' : 'F:') + (cityKey || '_')
        + (qpChannel ? `|c=${qpChannel}` : '') + (qpTopic ? `|t=${qpTopic}` : '');
      const cached = catalogMemoGet(memoKey);
      if (cached) return jsonReply(res, cached);
      let cities = [];
      if (cityKey) {
        cities = await queryRows('SELECT * FROM cities WHERE slug=? OR name=? ORDER BY id LIMIT 1', [cityKey, cityKey]);
      }
      if (!cities.length) {
        cities = await queryRows("SELECT * FROM cities WHERE slug='shenyang' ORDER BY id LIMIT 1");
      }
      if (!cities.length) {
        cities = await queryRows('SELECT * FROM cities ORDER BY id LIMIT 1');
      }
      if (!cities.length) return jsonReply(res, { error: 'no city' }, 404);
      const city = cities[0];
      // channel / topic 过滤（topic 定义存 settings KV：topic_<slug>；qpChannel/qpTopic 已在上方解析）
      let projSql = 'SELECT * FROM projects WHERE city_id=? AND (status=\'online\' OR status IS NULL)';
      const projParams = [city.id];
      let topicMeta = null;
      if (qpTopic) {
        const kvRows = await queryRows('SELECT value FROM settings WHERE `key`=?', [`topic_${qpTopic}`]);
        if (!kvRows.length) return jsonReply(res, { error: `unknown topic: ${qpTopic}` }, 404);
        let crit = {};
        try { crit = JSON.parse(kvRows[0].value || '{}'); } catch (_) { crit = {}; }
        topicMeta = { topic: qpTopic, label: crit.label || qpTopic };
        if (crit.channel) { projSql += ' AND channel=?'; projParams.push(String(crit.channel)); }
        for (const t of (crit.tags || [])) {
          projSql += ' AND JSON_CONTAINS(tags, ?)';
          projParams.push(JSON.stringify(t));
        }
      } else if (qpChannel) {
        projSql += ' AND channel=?';
        projParams.push(qpChannel);
      }
      projSql += ' ORDER BY channel, sort_order, id';
      const [channels, districts, projects] = await Promise.all([
        queryRows('SELECT * FROM channels WHERE enabled=1 ORDER BY sort_order, id'),
        queryRows('SELECT * FROM districts WHERE city_id=? ORDER BY sort_order, id', [city.id]),
        queryRows(projSql, projParams),
      ]);
      const projectIds = projects.map((p) => p.id);
      let units = [];
      if (!lite && projectIds.length) {
        units = await queryRows(
          `SELECT * FROM units WHERE project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY sort_order, id`,
          projectIds
        );
      }
      const unitIds = units.map((u) => u.id);
      const districtIds = districts.map((d) => d.id);
      const photoClauses = [];
      const photoParams = [];
      if (!lite) {
        if (districtIds.length) {
          photoClauses.push(`(entity_type='district' AND entity_id IN (${districtIds.map(() => '?').join(',')}))`);
          photoParams.push(...districtIds);
        }
        if (projectIds.length) {
          photoClauses.push(`(entity_type='project' AND entity_id IN (${projectIds.map(() => '?').join(',')}))`);
          photoParams.push(...projectIds);
        }
        if (unitIds.length) {
          photoClauses.push(`(entity_type='unit' AND entity_id IN (${unitIds.map(() => '?').join(',')}))`);
          photoParams.push(...unitIds);
        }
      }
      let photos = [];
      if (photoClauses.length) {
        photos = await queryRows(
          `SELECT id, entity_type, entity_id, file_path, is_cover, sort_order FROM photos WHERE ${photoClauses.join(' OR ')} ORDER BY entity_type, entity_id, sort_order, id`,
          photoParams
        );
      }
      const parse = housingParseJsonField || ((v) => v);
      const mapRows = (rows, keys) => rows.map((r) => {
        const o = Object.assign({}, r);
        keys.forEach((k) => { o[k] = parse(o[k]); });
        return o;
      });
      const catalog = {
        city,
        channels,
        districts: mapRows(districts, ['tags']),
        projects: mapRows(projects, ['tags', 'rating', 'ext']).map((p) =>
          Object.assign(stripContactPhone(p), stayConfigOf(p))),
        units: mapRows(units, ['tags', 'amenities', 'keeper', 'rent_detail', 'ext']),
        photos,
        topic: topicMeta,
        stats: {
          district_count: districts.length,
          project_count_rental: projects.filter((p) => p.channel === 'rental').length,
          project_count_bzf: projects.filter((p) => p.channel === 'rental').length, // 旧字段别名
          project_count_trade: projects.filter((p) => p.channel === 'trade').length,
          // 房源量 = 租赁住宿项目在管套数合计（不是户型条数）
          unit_count: projects
            .filter((p) => p.channel === 'rental' || p.channel === 'minsu')
            .reduce((sum, p) => sum + (Number(p.managed_unit_count != null ? p.managed_unit_count : p.unit_count) || 0), 0),
        },
      };
      if (housingHydrateCoverFields) housingHydrateCoverFields(catalog);
      imgThumbs.mapThumbsDeep(catalog, 640);   // C 端图片缩略图（原图保留，admin 端不受影响）
      catalogMemoSet(memoKey, catalog);
      return jsonReply(res, catalog);
    }

    // GET /api/juzhu/ratings（按 rating_status 列出评级；口径含 rental=好房子 / minsu=彩贝）
    if (urlPath === '/api/juzhu/ratings' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = `SELECT p.*, d.name AS district_name FROM projects p
                 LEFT JOIN districts d ON d.id=p.district_id
                 WHERE p.channel IN ('rental','minsu') AND p.rating_status IN ('pending','passed','rejected')`;
      const params = [];
      if (qp.get('status')) { sql += ' AND p.rating_status=?'; params.push(qp.get('status')); }
      if (qp.get('channel')) { sql += ' AND p.channel=?'; params.push(qp.get('channel')); }
      sql += " ORDER BY COALESCE(p.rating_submitted_at,'') DESC, p.id";
      const rows = await queryRows(sql, params);
      return jsonReply(res, rows.map(stripContactPhone));
    }

    // GET /api/juzhu/ratings/:code
    {
      const m = urlPath.match(/^\/api\/juzhu\/ratings\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const code = decodeURIComponent(m[1]);
        // code 格式 <前缀>-{id}（SY-BZF-/SY-RENT-/MZ-），直接按 id 查
        const idMatch = code.match(/-(\d+)$/);
        let proj = null;
        if (idMatch) {
          const rows = await queryRows(
            `SELECT p.*, d.name AS district_name FROM projects p
             LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?`,
            [parseInt(idMatch[1])]
          );
          if (rows.length) proj = rows[0];
        }
        if (!proj) return jsonReply(res, { error: 'not found' }, 404);
        return jsonReply(res, { project: stripContactPhone(proj) });
      }
    }

    // GET /api/juzhu/trade
    if (urlPath === '/api/juzhu/trade' && req.method === 'GET') {
      const rows = await queryRows(
        "SELECT id,name,slug,cover_image,address,tags,sort_order,unit_count,price_from,is_featured,featured_rank,old_house_hint FROM projects WHERE channel='trade' ORDER BY is_featured DESC, featured_rank, sort_order"
      );
      rows.forEach(r => parseJsonFields(r, ['tags']));
      return jsonReply(res, { listings: rows });
    }

    // GET /api/juzhu/districts/:slug/projects
    {
      const m = urlPath.match(/^\/api\/juzhu\/districts\/([^/]+)\/projects$/);
      if (m && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        const dists = await queryRows('SELECT * FROM districts WHERE slug=?', [slug]);
        if (!dists.length) return jsonReply(res, { error: 'not found' }, 404);
        const dist = dists[0];
        const projects = await queryRows(
          "SELECT id,name,slug,cover_image,address,tags,sort_order,unit_count,managed_unit_count,price_from,is_featured FROM projects WHERE district_id=? AND channel='rental' ORDER BY sort_order",
          [dist.id]
        );
        projects.forEach(r => parseJsonFields(r, ['tags']));
        return jsonReply(res, { district: dist, projects });
      }
    }

    // GET /api/juzhu/projects/:slug  （C端项目详情，slug 匹配）
    {
      const m = urlPath.match(/^\/api\/juzhu\/projects\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        // slug 可能是纯数字（id），兼容两种查询
        const isId = /^\d+$/.test(slug);
        const sql = isId
          ? 'SELECT id,name,slug,cover_image,address,tags,sort_order,unit_count,managed_unit_count,price_from,is_featured,channel,district_id,rating_status,rating,ext,status,owner_vendor_id FROM projects WHERE id=?'
          : 'SELECT id,name,slug,cover_image,address,tags,sort_order,unit_count,managed_unit_count,price_from,is_featured,channel,district_id,rating_status,rating,ext,status,owner_vendor_id FROM projects WHERE slug=?';
        const rows = await queryRows(sql, [isId ? parseInt(slug) : slug]);
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        parseJsonFields(rows[0], ['tags', 'rating']);
        // 商家维度咨询优先展示模式（jz_vendors.consult_mode，缺省 consultant）
        const vrows = rows[0].owner_vendor_id
          ? await queryRows('SELECT consult_mode FROM jz_vendors WHERE id=?', [rows[0].owner_vendor_id])
          : [];
        return jsonReply(res, imgThumbs.mapThumbsDeep(
          Object.assign(rows[0], stayConfigOf(rows[0]), { consult_mode: (vrows[0] && vrows[0].consult_mode) || 'consultant' }), 640));
      }
    }

    // GET /api/juzhu/projects/:slug/units
    {
      const m = urlPath.match(/^\/api\/juzhu\/projects\/([^/]+)\/units$/);
      if (m && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        const isId = /^\d+$/.test(slug);
        const projSql = isId ? 'SELECT * FROM projects WHERE id=?' : 'SELECT * FROM projects WHERE slug=?';
        const projs = await queryRows(projSql, [isId ? parseInt(slug) : slug]);
        if (!projs.length) return jsonReply(res, { error: 'not found' }, 404);
        const proj = projs[0];
        const units = await queryRows('SELECT * FROM units WHERE project_id=? ORDER BY sort_order', [proj.id]);
        const photos = await queryRows(
          "SELECT * FROM photos WHERE entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id=?) ORDER BY entity_id, sort_order",
          [proj.id]
        );
        parseJsonFields(proj, ['tags', 'rating']);
        units.forEach((u) => parseJsonFields(u, ['tags', 'amenities', 'keeper', 'rent_detail', 'ext']));
        return jsonReply(res, imgThumbs.mapThumbsDeep({ project: Object.assign(stripContactPhone(proj), stayConfigOf(proj)), units, photos }, 640));
      }
    }

    // GET /api/juzhu/projects/:id/stay-calendar?month=YYYY-MM&unit_id= —— 房态日历（公开，无 PII）
    {
      const m = urlPath.match(/^\/api\/juzhu\/projects\/(\d+)\/stay-calendar$/);
      if (m && req.method === 'GET') {
        const pid = parseInt(m[1], 10);
        const qp = new URLSearchParams(qs);
        const unitId = qp.get('unit_id') ? parseInt(qp.get('unit_id'), 10) || 0 : 0;
        const mth = /^(\d{4})-(\d{2})$/.exec((qp.get('month') || '').trim());
        const today = new Date();
        const y = mth ? parseInt(mth[1], 10) : today.getFullYear();
        const mo = mth ? (parseInt(mth[2], 10) - 1) : today.getMonth();
        const prows = await queryRows('SELECT * FROM projects WHERE id=?', [pid]);
        if (!prows.length) return jsonReply(res, { error: 'not found' }, 404);
        let unit = null;
        if (unitId) {
          const us = await queryRows('SELECT * FROM units WHERE id=? AND project_id=?', [unitId, pid]);
          if (!us.length) return jsonReply(res, { error: 'unit not found' }, 404);
          unit = us[0];
        }
        const cal = await buildStayMonth(prows[0], unit, unitId, y, mo);
        return jsonReply(res, Object.assign({
          project_id: pid,
          unit_id: unitId,
        }, cal, stayConfigOf(prows[0])));
      }
    }

    // ===== admin auth 接口 =====

    // POST /api/juzhu/admin/auth/login —— 走账号中心（accounts 表）
    // 必须显式 login_name（旧「只传 password 默认唯一 platform_admin」已移除：可被探测账号存在性）
    if (urlPath === '/api/juzhu/admin/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const idName = String(body.login_name || body.username || '').trim();
      const pwd = String(body.password || '');
      if (!idName) return jsonReply(res, { error: '请输入账号' }, 400);
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
      const out = await authCenter.loginWithPassword(idName, pwd, ip, req.headers['user-agent'] || '', { ttlSeconds: authCenter.SESSION_TTL.human_admin });
      if (out.error) return jsonReply(res, { error: out.error, retry_after: out.retry_after }, out.throttled ? 429 : 401);
      return jsonReply(res, {
        token: out.token,
        expires_at: out.expires_at,
        account: out.account,
        roles: out.roles.map((r) => r.role_code),
      });
    }

    // GET /api/juzhu/admin/auth/check
    if (urlPath === '/api/juzhu/admin/auth/check' && req.method === 'GET') {
      const token = extractBearerToken(req);
      const sess = await authCenter.verifySessionToken(token).catch(() => null);
      if (sess) {
        return jsonReply(res, {
          ok: true,
          account: sess.account,
          roles: sess.roles.map((r) => r.role_code),
          permissions: [...authCenter.permissionsOf({ roles: sess.roles })],
        });
      }
      if (verifyAdminLoginToken(token)) {
        const exp = parseInt(token.split('.')[0], 10);
        return jsonReply(res, { ok: true, legacy: true, expires_at: new Date(exp * 1000).toISOString() });
      }
      return jsonReply(res, { ok: false }, 401);
    }

    // ===== 账号中心管理（platform_admin；原生多账号：任何主体直接挂 N 个 account）=====

    // ===== IdP 联邦配置（platform_admin；secret 只写不读）=====
    // GET /api/juzhu/admin/idp-configs（权限已由入口闸按 perm_registry 校验：admin.read）
    if (urlPath === '/api/juzhu/admin/idp-configs' && req.method === 'GET') {
      return jsonReply(res, await authCenter.listIdpConfigs());
    }
    // PUT /api/juzhu/admin/idp-configs —— 新建/更新（body.org_no 为主键维度；client_secret 缺省=不改）
    if (urlPath === '/api/juzhu/admin/idp-configs' && req.method === 'PUT') {
      const body = await readBody(req);
      const wp = req.principal;
      const out = await authCenter.upsertIdpConfig(body, {
        accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
        ip: wp && wp.ip, ua: wp && wp.ua,
      });
      if (out.error) return jsonReply(res, { error: out.error }, 400);
      return jsonReply(res, out);
    }

    // GET /api/juzhu/admin/accounts?vendor_id=&org_id=&principal_type=
    // （权限已由入口闸按 perm_registry 校验：admin.read；旧全局 Key 在闸上已 403）
    if (urlPath === '/api/juzhu/admin/accounts' && req.method === 'GET') {
      return jsonReply(res, await authCenter.listAccounts(Object.fromEntries(new URLSearchParams(qs))));
    }

    // POST /api/juzhu/admin/accounts —— 创建账号（写操作已由入口闸要求 admin.write）
    if (urlPath === '/api/juzhu/admin/accounts' && req.method === 'POST') {
      const body = await readBody(req);
      const wp = req.principal;
      const out = await authCenter.createAccount(body, {
        accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
        ip: wp && wp.ip, ua: wp && wp.ua,
      });
      if (out.error) return jsonReply(res, { error: out.error }, 400);
      return jsonReply(res, out, 201);
    }

    // PUT /api/juzhu/admin/accounts/:id —— 改资料/状态/角色/密码（密码或停用会吊销全部会话）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/accounts\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const body = await readBody(req);
        const wp = req.principal;
        const out = await authCenter.updateAccount(parseInt(m[1], 10), body, {
          accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
          ip: wp && wp.ip, ua: wp && wp.ua,
        });
        if (out.error) return jsonReply(res, { error: out.error }, out.error === '账号不存在' ? 404 : 400);
        return jsonReply(res, out);
      }
    }
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/accounts\/(\d+)\/api-key$/);
      if (m && req.method === 'POST') {
        const wp = req.principal;
        const out = await authCenter.issueApiKey(parseInt(m[1], 10), {
          accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
          ip: wp && wp.ip, ua: wp && wp.ua,
        });
        if (out.error) return jsonReply(res, { error: out.error }, 404);
        return jsonReply(res, out);
      }
    }

    // GET /api/juzhu/admin/audit?limit=&action=&account_id=
    // （权限已由入口闸按 perm_registry 校验：audit.read）
    if (urlPath === '/api/juzhu/admin/audit' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const limit = Math.min(parseInt(qp.get('limit') || '100', 10) || 100, 500);
      const where = [];
      const params = [];
      if (qp.get('action')) { where.push('action=?'); params.push(qp.get('action')); }
      if (qp.get('account_id')) { where.push('account_id=?'); params.push(parseInt(qp.get('account_id'), 10)); }
      const rows = await queryRows(
        `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`,
        params
      );
      return jsonReply(res, rows);
    }

    // ===== C 端登录（租客）：贝壳 SDK 默认 + 密码兜底（JIT 建档，role=user）=====

    // POST /api/juzhu/auth/tenant —— 手机号+密码；首登自动建档（真实凭证，生产可用）
    if (urlPath === '/api/juzhu/auth/tenant' && req.method === 'POST') {
      const body = await readBody(req);
      const phone = String(body.phone || '').trim();
      const password = String(body.password || '');
      const name = String(body.name || '').trim();
      if (!/^1\d{10}$/.test(phone)) return jsonReply(res, { error: '手机号格式不对' }, 400);
      if (password.length < 8) return jsonReply(res, { error: '密码至少 8 位' }, 400);
      const loginName = 'u' + phone;
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const ua2 = req.headers['user-agent'] || '';
      const dup = await queryRows('SELECT id FROM accounts WHERE login_name=? LIMIT 1', [loginName]);
      if (!dup.length) {
        const created = await authCenter.createAccount({
          login_name: loginName, password, roles: ['user'], principal_type: 'user',
          phone, display_name: name || ('租客' + phone.slice(-4)),
        }, { ip, ua: ua2 });
        if (created.error) return jsonReply(res, { error: created.error }, 400);
        // 新建档即已持有本人密码，直接发会话（避免再走一次登录把一次请求计成两次失败）
        const sess = await authCenter.createSession(created.account.id, ip, ua2);
        return jsonReply(res, { ok: true, token: sess.token, role: 'user', phone_masked: maskPhoneStd(phone), display_name: created.account.display_name });
      }
      // 已有账号：校验密码（防他人抢注覆盖）；只调一次，带真实 ip/ua 保证审计与节流计数准确
      const login = await authCenter.loginWithPassword(phone, password, ip, ua2);
      if (login.error) {
        if (login.throttled) return jsonReply(res, { error: login.error, retry_after: login.retry_after }, 429);
        return jsonReply(res, { error: '该手机号已注册，密码不对' }, 401);
      }
      return jsonReply(res, { ok: true, token: login.token, role: 'user', phone_masked: maskPhoneStd(phone), display_name: login.account ? login.account.display_name : name });
    }

    // POST /api/juzhu/auth/beike —— 贝壳 SDK 登录换会话（App 内 jsbridge getUserInfo 回传）
    // ⚠ 生产环境必须接入真实 SDK 验签（app_id/secret 或 OIDC），当前仅非生产开放（出边界）
    if (urlPath === '/api/juzhu/auth/beike' && req.method === 'POST') {
      if (isProduction()) return jsonReply(res, { error: '生产环境暂未接入贝壳 SDK 验签，请用密码登录' }, 501);
      const body = await readBody(req);
      const uid = String(body.uid || '').trim();
      const phone = String(body.phone || '').trim();
      const name = String(body.name || '').trim();
      if (!uid || !/^1\d{10}$/.test(phone)) return jsonReply(res, { error: 'uid 与手机号必填' }, 400);
      const loginName = 'bk' + uid;
      let accRows = await queryRows('SELECT id FROM accounts WHERE login_name=? LIMIT 1', [loginName]);
      if (!accRows.length) {
        const created = await authCenter.createAccount({
          login_name: loginName, password: 'bk-' + crypto.randomBytes(12).toString('hex'),
          roles: ['user'], principal_type: 'user', phone,
          display_name: name || ('贝壳用户' + uid.slice(-4)),
        }, { ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim(), ua: req.headers['user-agent'] || '' });
        if (created.error) return jsonReply(res, { error: created.error }, 400);
      } else {
        await queryRows('UPDATE accounts SET phone=COALESCE(NULLIF(?,""),phone) WHERE id=?', [phone, accRows[0].id]).catch(() => {});
      }
      accRows = await queryRows('SELECT id FROM accounts WHERE login_name=? LIMIT 1', [loginName]);
      const sess = await authCenter.createSession(accRows[0].id, (req.headers['x-forwarded-for'] || '').split(',')[0].trim(), req.headers['user-agent'] || '');
      return jsonReply(res, { ok: true, token: sess.token, role: 'user', expires_at: sess.expires_at });
    }

    // GET /api/juzhu/booking/my —— 我的预订（登录会话；按 user_id + 账号手机号认领）
    if (urlPath === '/api/juzhu/booking/my' && req.method === 'GET') {
      const sess = await requestSession(req);
      if (!sess || !sess.account) return jsonReply(res, { error: 'unauthorized', message: '请先登录（贝壳 SDK 或手机号密码）' }, 401);
      const accPhone = sess.account.phone || '';
      const rows = await queryRows(
        `SELECT b.id, b.order_no, b.project_id, b.channel, p.name AS project_name,
                b.checkin, b.checkout, b.nights, b.price_total, b.status, b.created_at,
                b.pay_status, b.pay_method,
                b.contact_name, b.contact_phone
         FROM booking_orders b LEFT JOIN projects p ON p.id=b.project_id
         WHERE b.user_id=? ${accPhone ? 'OR b.contact_phone=?' : ''}
         ORDER BY b.id DESC LIMIT 100`,
        accPhone ? [String(sess.account.id), accPhone] : [String(sess.account.id)]
      );
      return jsonReply(res, {
        role: sess.role,
        items: rows.map((o) => Object.assign({}, o, {
          contact_phone: maskPhoneStd(o.contact_phone),
          contact_phone_masked: maskPhoneStd(o.contact_phone), // 别名：与 /booking/lookup 出参字段对齐
          contact_phone_raw: o.contact_phone, // 本人订单，取消/支付接口需要原号
        })),
      });
    }

    // ===== 联系人簿（booking_contacts，登录用户自己的常用联系人）=====

    // GET /api/juzhu/booking/contacts —— 我的联系人（本人视角，手机号不脱敏）
    if (urlPath === '/api/juzhu/booking/contacts' && req.method === 'GET') {
      const sess = await requestSession(req);
      if (!sess || !sess.account) return jsonReply(res, { error: 'unauthorized' }, 401);
      const rows = await queryRows(
        'SELECT id, name, phone FROM booking_contacts WHERE user_id=? ORDER BY id DESC LIMIT 20',
        [String(sess.account.id)]
      );
      return jsonReply(res, { items: rows });
    }

    // POST /api/juzhu/booking/contacts —— 新增联系人（本人，上限 20）
    if (urlPath === '/api/juzhu/booking/contacts' && req.method === 'POST') {
      const sess = await requestSession(req);
      if (!sess || !sess.account) return jsonReply(res, { error: 'unauthorized' }, 401);
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const phone = String(body.phone || '').trim();
      if (!name || !/^1\d{10}$/.test(phone)) return jsonReply(res, { error: '姓名与 11 位手机号为必填' }, 400);
      const cntRows = await queryRows('SELECT COUNT(*) AS n FROM booking_contacts WHERE user_id=?', [String(sess.account.id)]);
      if (cntRows[0].n >= 20) return jsonReply(res, { error: '联系人最多 20 个' }, 400);
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [r] = await conn.execute(
          'INSERT INTO booking_contacts(user_id,name,phone,created_at) VALUES (?,?,?,?)',
          [String(sess.account.id), name, phone, now]
        );
        await conn.commit();
        return jsonReply(res, { ok: true, id: r.insertId, name, phone });
      } finally { await conn.end(); }
    }

    // DELETE /api/juzhu/booking/contacts/:id —— 删除本人联系人
    {
      const m = urlPath.match(/^\/api\/juzhu\/booking\/contacts\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const sess = await requestSession(req);
        if (!sess || !sess.account) return jsonReply(res, { error: 'unauthorized' }, 401);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [r] = await conn.execute(
            'DELETE FROM booking_contacts WHERE id=? AND user_id=?',
            [parseInt(m[1], 10), String(sess.account.id)]
          );
          await conn.commit();
          return jsonReply(res, { ok: r.affectedRows > 0 });
        } finally { await conn.end(); }
      }
    }

    // ===== 旅居预订（booking_orders）：C 端公开下单/查单/取消 + 商家确认 =====

    // POST /api/juzhu/booking —— 公开下单（规则10：手机号只入库，响应不回显）
    if (urlPath === '/api/juzhu/booking' && req.method === 'POST') {
      const body = await readBody(req);
      const projectId = parseInt(body.project_id, 10);
      const unitId = body.unit_id ? parseInt(body.unit_id, 10) : null;
      const name = String(body.contact_name || '').trim();
      const phone = String(body.contact_phone || '').trim();
      const checkin = String(body.checkin || '').trim();
      const checkout = String(body.checkout || '').trim();
      if (!projectId || !name || !/^1\d{10}$/.test(phone)) return jsonReply(res, { error: '项目、联系人、11 位手机号为必填' }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout)) return jsonReply(res, { error: '日期格式须为 YYYY-MM-DD' }, 400);
      const nights = Math.round((new Date(checkout) - new Date(checkin)) / 864e5);
      if (!(nights >= 1)) return jsonReply(res, { error: '离店须晚于入住至少 1 晚' }, 400);
      if (new Date(checkin) < new Date(new Date().toDateString())) return jsonReply(res, { error: '入住日期不能早于今天' }, 400);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [projs] = await conn.execute('SELECT id, name, channel, status, price_from, owner_vendor_id, city_id, ext, tags FROM projects WHERE id=?', [projectId]);
        const proj = projs[0];
        if (!proj) { conn.end(); return jsonReply(res, { error: '项目不存在' }, 404); }
        if (!['rental', 'minsu'].includes(proj.channel)) { conn.end(); return jsonReply(res, { error: '该频道不支持预订（仅 rental/minsu）' }, 400); }
        if (proj.status && proj.status !== 'online') { conn.end(); return jsonReply(res, { error: '房源已下架，暂不可预订' }, 400); }
        // 在线预订 = 项目已开通（projects.ext.stay_bookable，B 端房态页「按晚预订」开关）；
        // 口径（2026-09-05）：默认一律仅 400 电话咨询，开通后 minsu 走预付收银台、
        // rental 走预订单；tag 不参与判断，购房类频道（newhouse/resale/trade）不可订
        if (!bookableOf(proj)) { conn.end(); return jsonReply(res, { error: '该项目未开通在线预订，请拨打页面咨询电话' }, 400); }
        // 最短连住（旅居口径，商家可在 ext.min_stay_nights 覆盖）
        const minNights = minStayNightsOf(proj);
        if (nights < minNights) {
          conn.end();
          return jsonReply(res, { error: `该房源须连住至少 ${minNights} 晚（当前 ${nights} 晚）`, min_stay_nights: minNights }, 400);
        }
        // 房态冲突校验：unit 未指定 = 整栋/不限房型 → 全项目任一晚被占即拒；指定户型 → 项目级 + 该户型
        const [conflicts] = await conn.execute(
          `SELECT stay_date, unit_id, status FROM stay_calendar
           WHERE project_id=? AND status IN ('blocked','booked') AND stay_date >= ? AND stay_date < ?
           ${unitId ? 'AND unit_id IN (0, ?)' : ''} ORDER BY stay_date LIMIT 1`,
          unitId ? [projectId, checkin, checkout, unitId] : [projectId, checkin, checkout]
        );
        if (conflicts.length) {
          conn.end();
          return jsonReply(res, { error: `所选日期 ${conflicts[0].stay_date} 已被预订或已关房，请换时段`, conflict_date: conflicts[0].stay_date }, 400);
        }
      // 登录用户下单 → 订单归属（未登录则 user_id 为空，可后续按手机号认领）
      let bookingUserId = null;
      try {
        const bsess = await requestSession(req);
        if (bsess && bsess.account) bookingUserId = String(bsess.account.id);
      } catch (_) {}
        let perNight = 0;
        if (unitId) {
          const [us] = await conn.execute('SELECT id, project_id, rent_monthly, ext FROM units WHERE id=?', [unitId]);
          if (!us.length || us[0].project_id !== projectId) { conn.end(); return jsonReply(res, { error: '户型不存在或不属于该项目' }, 400); }
          perNight = unitNightPrice(proj, us[0]);   // 夜价口径（规则15/16）单一数据源 stay_config.cjs
        }
        if (!perNight) perNight = unitNightPrice(proj, null);
        const priceTotal = perNight * nights;
        const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z').slice(0, 19).replace('T', ' ');
        const [ins] = await conn.execute(
          `INSERT INTO booking_orders(order_no,project_id,unit_id,channel,city_id,owner_vendor_id,user_id,contact_name,contact_phone,checkin,checkout,nights,price_total,status,pay_status,created_at,updated_at)
           VALUES ('',?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?, ?,?)`,
          [projectId, unitId, proj.channel, proj.city_id, proj.owner_vendor_id, bookingUserId, name, phone, checkin, checkout, nights, priceTotal,
           proj.channel === 'minsu' ? 'unpaid' : null, now, now]
        );
        const orderNo = `BKG-${proj.channel.toUpperCase()}-${String(ins.insertId).padStart(5, '0')}`;
        await conn.execute('UPDATE booking_orders SET order_no=? WHERE id=?', [orderNo, ins.insertId]);
        // 下单即占房态（stay_calendar booked 行，取消时释放）
        const stayDates = stayDateList(checkin, checkout);
        if (stayDates.length) {
          const nowSc = now;
          const scVals = stayDates.map((d) => [projectId, unitId || 0, d, 'booked', 'booking', ins.insertId, nowSc]);
          await conn.query(
            `INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, source, booking_id, updated_at)
             VALUES ${scVals.map(() => '(?,?,?,?,?,?,?)').join(',')}
             ON DUPLICATE KEY UPDATE status='booked', source='booking', booking_id=VALUES(booking_id), updated_at=VALUES(updated_at)`,
            scVals.flat()
          );
        }
        await conn.commit();
        notifyVendorBooking(proj.owner_vendor_id, 'booking.created', {
          order_no: orderNo, project_id: projectId, unit_id: unitId || null,
          channel: proj.channel, checkin: checkin, checkout: checkout,
          nights: nights, price_total: priceTotal, status: 'pending', pay_status: proj.channel === 'minsu' ? 'unpaid' : null,
        });
        return jsonReply(res, { ok: true, order_no: orderNo, nights, price_total: priceTotal, min_stay_nights: minNights });
      } finally { await conn.end(); }
    }

    // POST /api/juzhu/booking/lookup —— order_no + 手机号 双因子查单（规则9：禁止 ?phone= 匿名旁路）
    if (urlPath === '/api/juzhu/booking/lookup' && req.method === 'POST') {
      const body = await readBody(req);
      const orderNo = String(body.order_no || '').trim();
      const phone = String(body.contact_phone || '').trim();
      if (!orderNo || !phone) return jsonReply(res, { error: 'order_no 与手机号必填' }, 400);
      const rows = await queryRows(
        `SELECT b.*, p.name AS project_name FROM booking_orders b
         LEFT JOIN projects p ON p.id=b.project_id
         WHERE b.order_no=? AND b.contact_phone=? LIMIT 1`, [orderNo, phone]);
      if (!rows.length) return jsonReply(res, { error: '订单不存在或手机号不匹配' }, 404);
      const o = rows[0];
      return jsonReply(res, {
        order: {
          id: o.id, order_no: o.order_no, project_id: o.project_id, unit_id: o.unit_id, channel: o.channel,
          project_name: o.project_name,
          contact_name: o.contact_name, contact_phone_masked: maskPhoneStd(o.contact_phone),
          checkin: o.checkin, checkout: o.checkout, nights: o.nights, price_total: o.price_total,
          status: o.status, pay_status: o.pay_status, pay_method: o.pay_method, created_at: o.created_at,
        },
      });
    }

    // POST /api/juzhu/booking/cancel —— 用户取消自己的 pending
    if (urlPath === '/api/juzhu/booking/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      const orderNo = String(body.order_no || '').trim();
      const phone = String(body.contact_phone || '').trim();
      if (!orderNo || !phone) return jsonReply(res, { error: 'order_no 与手机号必填' }, 400);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [rows] = await conn.execute('SELECT * FROM booking_orders WHERE order_no=? AND contact_phone=? LIMIT 1', [orderNo, phone]);
        if (!rows.length) { conn.end(); return jsonReply(res, { error: '订单不存在或手机号不匹配' }, 404); }
        if (rows[0].status !== 'pending') { conn.end(); return jsonReply(res, { error: '仅待确认订单可取消' }, 400); }
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        // 已支付订单取消 → 标记退款（模拟退款通道；真实网关接入后走原路退回）
        const newPay = rows[0].pay_status === 'paid' ? 'refunded' : rows[0].pay_status;
        await conn.execute("UPDATE booking_orders SET status='cancelled', pay_status=?, updated_at=? WHERE id=?", [newPay, now, rows[0].id]);
        // 释放房态
        await conn.execute("DELETE FROM stay_calendar WHERE booking_id=? AND source='booking'", [rows[0].id]);
        await conn.commit();
        notifyVendorBooking(rows[0].owner_vendor_id, 'booking.cancelled', {
          order_no: orderNo, project_id: rows[0].project_id, unit_id: rows[0].unit_id || null,
          channel: rows[0].channel, checkin: rows[0].checkin, checkout: rows[0].checkout,
          nights: rows[0].nights, price_total: rows[0].price_total,
          status: 'cancelled', pay_status: newPay || null, cancel_by: 'customer',
        });
        return jsonReply(res, { ok: true, order_no: orderNo, status: 'cancelled' });
      } finally { await conn.end(); }
    }

    // POST /api/juzhu/booking/pay —— 收银台支付（双因子：order_no + contact_phone；模拟通道，网关接入后替换）
    if (urlPath === '/api/juzhu/booking/pay' && req.method === 'POST') {
      const body = await readBody(req);
      const orderNo = String(body.order_no || '').trim();
      const phone = String(body.contact_phone || '').trim();
      const payMethod = String(body.pay_method || 'online').slice(0, 50);
      if (!orderNo || !phone) return jsonReply(res, { error: 'order_no 与手机号必填' }, 400);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [rows] = await conn.execute('SELECT * FROM booking_orders WHERE order_no=? AND contact_phone=? LIMIT 1', [orderNo, phone]);
        if (!rows.length) { conn.end(); return jsonReply(res, { error: '订单不存在或手机号不匹配' }, 404); }
        if (rows[0].status !== 'pending') { conn.end(); return jsonReply(res, { error: '订单已取消或已完结，无法支付' }, 400); }
        if (rows[0].pay_status !== 'unpaid') { conn.end(); return jsonReply(res, { error: '该订单不在待支付状态（当前：' + (rows[0].pay_status || '无需支付）') }, 400); }
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        await conn.execute("UPDATE booking_orders SET pay_status='paid', pay_method=?, pay_at=?, updated_at=? WHERE id=?", [payMethod, now, now, rows[0].id]);
        await conn.commit();
        notifyVendorBooking(rows[0].owner_vendor_id, 'booking.paid', {
          order_no: orderNo, project_id: rows[0].project_id, unit_id: rows[0].unit_id || null,
          channel: rows[0].channel, checkin: rows[0].checkin, checkout: rows[0].checkout,
          nights: rows[0].nights, price_total: rows[0].price_total,
          status: rows[0].status, pay_status: 'paid', pay_method: payMethod, pay_at: now,
        });
        return jsonReply(res, { ok: true, order_no: orderNo, pay_status: 'paid', status: rows[0].status });
      } finally { await conn.end(); }
    }

    // GET /api/juzhu/vendor/booking/orders —— vendor 只见自己；platform 全量（可 ?status=）
    if (urlPath === '/api/juzhu/vendor/booking/orders' && req.method === 'GET') {
      const sess = await requestSession(req);
      if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
      let sql = `SELECT b.id, b.order_no, b.project_id, b.unit_id, b.channel, b.checkin, b.checkout,
                        b.nights, b.price_total, b.status, b.created_at,
                        b.contact_name, b.contact_phone, p.name AS project_name, p.cover_image AS project_cover
                 FROM booking_orders b LEFT JOIN projects p ON p.id=b.project_id WHERE 1=1`;
      const params = [];
      if (sess.role === 'vendor') { sql += ' AND b.owner_vendor_id=?'; params.push(sess.vendorId); }
      const bqp = new URLSearchParams(qs);
      if (bqp.get('status')) { sql += ' AND b.status=?'; params.push(bqp.get('status')); }
      sql += ' ORDER BY b.id DESC LIMIT 200';
      const rows = await queryRows(sql, params);
      return jsonReply(res, {
        role: sess.role,
        items: rows.map((o) => Object.assign({}, o, { contact_phone: maskPhoneStd(o.contact_phone) })),
      });
    }

    // POST /api/juzhu/vendor/booking/:id/status —— 商家确认/取消（owner 校验）
    {
      const m = urlPath.match(/^\/api\/juzhu\/vendor\/booking\/(\d+)\/status$/);
      if (m && req.method === 'POST') {
        const sess = await requestSession(req);
        if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
        const body = await readBody(req);
        const status = String(body.status || '');
        if (!['confirmed', 'cancelled'].includes(status)) return jsonReply(res, { error: 'status 须为 confirmed/cancelled' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM booking_orders WHERE id=?', [parseInt(m[1], 10)]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          if (sess.role === 'vendor' && rows[0].owner_vendor_id !== sess.vendorId) {
            conn.end();
            return jsonReply(res, { error: 'forbidden：非本商家订单' }, 403);
          }
          if (rows[0].status === 'cancelled') { conn.end(); return jsonReply(res, { error: '订单已取消，不可再变更' }, 400); }
          // 预付口径：minsu 单 pay_status='unpaid' 时租客未支付，不可确认生效
          if (status === 'confirmed' && rows[0].pay_status === 'unpaid') {
            conn.end();
            return jsonReply(res, { error: '租客尚未支付（收银台待付），支付完成后可确认生效' }, 400);
          }
          const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
          await conn.execute('UPDATE booking_orders SET status=?, updated_at=? WHERE id=?', [status, now, rows[0].id]);
          // 商家拒单 → 释放房态；确认则保留 booked 行
          if (status === 'cancelled') {
            await conn.execute("DELETE FROM stay_calendar WHERE booking_id=? AND source='booking'", [rows[0].id]);
          }
          await conn.commit();
          return jsonReply(res, { ok: true, order_no: rows[0].order_no, status });
        } finally { await conn.end(); }
      }
    }

    // ===== 商家后台（vendor-admin，账号中心会话，scope=vendor；与 /api/juzhu/vendor/* 并存）=====
    if (urlPath.startsWith('/api/juzhu/vendor-admin/')) {
      const principal = await authCenter.principalOf(req).catch(() => null);
      if (!principal || principal.type !== 'account') {
        return jsonReply(res, { error: 'unauthorized', message: '请用商家账号登录（POST /api/auth/login）' }, 401);
      }
      const sub = urlPath.slice('/api/juzhu/'.length).replace(/\/+$/, '');
      const need = {
        'vendor-admin/summary': authCenter.P.VENDOR_SUMMARY,
        'vendor-admin/orders': authCenter.P.VENDOR_ORDER_READ,
        'vendor-admin/products': authCenter.P.VENDOR_PRODUCT_READ,
      }[sub];
      if (!need || !authCenter.hasPermission(principal, need)) {
        return jsonReply(res, { error: 'forbidden', message: '当前账号无该权限' }, 403);
      }
      const vid = principal.account.vendor_id;
      if (!vid) return jsonReply(res, { error: 'forbidden', message: '当前账号未绑定商家' }, 403);
      if (sub === 'vendor-admin/summary') {
        const vs = await queryRows('SELECT id, type, name, logo, rating, review_count, status, vendor_no FROM jz_vendors WHERE id=?', [vid]);
        const byStatus = await queryRows('SELECT status, COUNT(*) n FROM gr_orders WHERE vendor_id=? GROUP BY status', [vid]);
        const [pc] = await queryRows('SELECT COUNT(*) n FROM jz_products WHERE vendor_id=?', [vid]);
        const [wc] = await queryRows('SELECT COUNT(*) n FROM jz_workers WHERE vendor_id=?', [vid]);
        return jsonReply(res, {
          vendor: stripVendorSecrets(vs[0] || null),
          stats: { orders_by_status: byStatus, products: pc.n, workers: wc.n },
          permissions: [...authCenter.permissionsOf(principal)],
          scope: authCenter.bestScopeLevel(principal),
        });
      }
      if (sub === 'vendor-admin/orders') {
        const qp = new URLSearchParams(qs);
        const status = (qp.get('status') || '').trim();
        const rows = status
          ? await queryRows('SELECT * FROM gr_orders WHERE vendor_id=? AND status=? ORDER BY id DESC LIMIT 200', [vid, status])
          : await queryRows('SELECT * FROM gr_orders WHERE vendor_id=? ORDER BY id DESC LIMIT 200', [vid]);
        return jsonReply(res, rows);
      }
      if (sub === 'vendor-admin/products') {
        const rows = await queryRows('SELECT * FROM jz_products WHERE vendor_id=? ORDER BY sort_order, id LIMIT 200', [vid]);
        return jsonReply(res, rows);
      }
    }

    // ===== 服务者（S 端）接口：worker 会话，scope=self 只碰本人名下工单 =====

    // GET /api/juzhu/s/orders —— 派给我的工单（worker_json.id = 绑定 worker_id）
    if (urlPath === '/api/juzhu/s/orders' && req.method === 'GET') {
      const principal = await authCenter.principalOf(req).catch(() => null);
      if (!principal || principal.type !== 'account') {
        return jsonReply(res, { error: 'unauthorized', message: '请用服务者账号登录（POST /api/auth/login）' }, 401);
      }
      const wid = principal.account.worker_id;
      if (!wid) return jsonReply(res, { error: 'forbidden', message: '当前账号未绑定服务者（worker_id）' }, 403);
      const rows = await queryRows(
        `SELECT o.id, o.sku_id, o.type, o.house, o.expect_time, o.status, o.pay_status, o.worker_json,
                o.created_at, o.updated_at, o.log_json, s.name AS sku_name
         FROM jz_orders o LEFT JOIN jz_skus s ON s.id = o.sku_id
         WHERE o.worker_json IS NOT NULL AND JSON_VALID(o.worker_json)
           AND JSON_UNQUOTE(JSON_EXTRACT(o.worker_json, '$.id')) = ?
         ORDER BY o.created_at DESC LIMIT 200`,
        [String(wid)]
      );
      return jsonReply(res, { items: rows, worker_id: wid });
    }

    // POST /api/juzhu/s/orders/:id/advance —— 本人名下工单推进（accepted→serving→done 封顶；评价归客户）
    {
      const m = urlPath.match(/^\/api\/juzhu\/s\/orders\/([^/]+)\/advance$/);
      if (m && req.method === 'POST') {
        const principal = await authCenter.principalOf(req).catch(() => null);
        if (!principal || principal.type !== 'account') {
          return jsonReply(res, { error: 'unauthorized', message: '请用服务者账号登录' }, 401);
        }
        const wid = principal.account.worker_id;
        if (!wid) return jsonReply(res, { error: 'forbidden', message: '当前账号未绑定服务者' }, 403);
        const orderId = m[1];
        const STATUS_ORDER = ['pending', 'dispatched', 'accepted', 'serving', 'done'];
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const order = rows[0];
          // scope=self：只能推进派给自己的工单
          let mine = false;
          try { mine = order.worker_json && JSON.parse(order.worker_json) && String(JSON.parse(order.worker_json).id) === String(wid); } catch (_) {}
          if (!mine) { conn.end(); return jsonReply(res, { error: 'forbidden', message: '非派给你的工单' }, 403); }
          const curIdx = STATUS_ORDER.indexOf(order.status);
          if (curIdx === -1 || order.status === 'pending') { conn.end(); return jsonReply(res, { error: '当前状态不可推进' }, 400); }
          if (curIdx >= STATUS_ORDER.length - 1) { conn.end(); return jsonReply(res, { error: '已是最终状态' }, 400); }
          const nextStatus = STATUS_ORDER[curIdx + 1];
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          let log = [];
          try { log = JSON.parse(order.log_json || '[]'); } catch (_) {}
          log.push({ at: now, action: 'advance', by: 'worker:' + wid, from: order.status, to: nextStatus });
          await conn.execute(
            'UPDATE jz_orders SET status=?, updated_at=?, log_json=? WHERE id=?',
            [nextStatus, now, JSON.stringify(log), orderId]
          );
          const [updated] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          await authCenter.audit({
            accountId: principal.account.id, principalType: 'account', roles: principal.roles,
            action: 's.order.advance', resource: 'jz_orders', resourceId: String(orderId), scopeLevel: 'self',
            after: { status: nextStatus }, ip: principal.ip, ua: principal.ua,
          });
          return jsonReply(res, { ok: true, order: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // ===== 持有方/机构只读视角（B 端资管；holding_viewer 只读，无任何运营动作）=====
    // GET /api/juzhu/org/report —— 资管大盘聚合（只读；按账号 scope 过滤：city 档只见授权城市，all 全量）
    if (urlPath === '/api/juzhu/org/report' && req.method === 'GET') {
      const principal = await authCenter.principalOf(req).catch(() => null);
      if (!principal || principal.type !== 'account' ||
          !(authCenter.hasPermission(principal, 'report.read') || authCenter.hasPermission(principal, '*'))) {
        return jsonReply(res, { error: 'forbidden', message: '需持有方/平台只读账号（report.read）' }, 403);
      }
      // scope 收口（规则 4）：持有方/监管按授权城市看数，不得因 report.read 看全平台
      const scope = authCenter.scopeOf(principal);
      if (scope.level !== 'all' && scope.level !== 'city') {
        return jsonReply(res, { error: 'forbidden', message: '报表按 city/all 数据范围开放（当前 ' + scope.level + ' 档）' }, 403);
      }
      const citySql = authCenter.scopeCitySql(scope, 'p.city_id');
      const citySqlPlain = authCenter.scopeCitySql(scope, 'city_id');
      const byChannel = await queryRows(
        `SELECT channel, COUNT(*) projects, COALESCE(SUM(COALESCE(managed_unit_count, unit_count)),0) units
         FROM projects WHERE 1=1${citySqlPlain.sql} GROUP BY channel ORDER BY channel`,
        citySqlPlain.params
      );
      // city 档口径：只统计在该市有项目的机构类型
      const vendorsByType = await queryRows(
        `SELECT v.type, COUNT(DISTINCT v.id) n FROM jz_vendors v
         JOIN projects p ON p.owner_vendor_id = v.id WHERE v.status='active'${citySql.sql}
         GROUP BY v.type ORDER BY n DESC`,
        citySql.params
      );
      // jz_orders 与城市/项目无直接外键（经 sku 间接归属），city 档诚实降级为空集（试点口径）
      const ordersByStatus = scope.level === 'all'
        ? await queryRows('SELECT status, COUNT(*) n FROM jz_orders GROUP BY status ORDER BY n DESC')
        : [];
      const operators = await queryRows(
        `SELECT v.id, v.name, v.type, COUNT(p.id) project_count
         FROM jz_vendors v LEFT JOIN projects p ON p.owner_vendor_id = v.id${citySql.sql}
         WHERE v.type IN ('platform','housing_operator','lvju_host')
         GROUP BY v.id, v.name, v.type ORDER BY project_count DESC LIMIT 20`,
        citySql.params
      );
      return jsonReply(res, {
        view: 'holding', readonly: true,
        scope: { level: scope.level, city_ids: scope.cityIds || null },
        generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        housing: { by_channel: byChannel },
        vendors: { by_type: vendorsByType },
        orders: scope.level === 'all' ? { by_status: ordersByStatus } : { by_status: [], note: 'city 口径暂不提供工单聚合（试点范围）' },
        operators,
      });
    }

    // ===== 商家（vendor）接口：role=vendor 会话，一律按 owner_vendor_id 隔离 =====

    // POST /api/juzhu/vendor/login
    if (urlPath === '/api/juzhu/vendor/login' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.login_name || '').trim();
      const pwd = String(body.password || '');
      if (!name || !pwd) return jsonReply(res, { error: 'login_name/password 必填' }, 400);
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      // 商家登录同走登录节流（ident 维度带 v: 前缀与账号中心隔离）
      const vHit = await authCenter.throttleCheck('ident', 'v:' + name);
      if (vHit.locked) return jsonReply(res, { error: '密码错误次数过多，账号已临时锁定', retry_after: vHit.retry_after }, 429);
      const vrows = await queryRows(
        'SELECT id, name, type, status, password_hash FROM jz_vendors WHERE login_name=? LIMIT 1',
        [name]
      );
      const v = vrows[0];
      if (!v || !v.password_hash) {
        await authCenter.throttleFail('ident', 'v:' + name);
        return jsonReply(res, { error: '账号或密码错误' }, 401);
      }
      if (v.status !== 'active') return jsonReply(res, { error: '商家已停用' }, 403);
      if (!bcrypt.compareSync(pwd, v.password_hash)) {
        const hit = await authCenter.throttleFail('ident', 'v:' + name);
        if (hit.locked) return jsonReply(res, { error: '密码错误次数过多，账号已临时锁定', retry_after: undefined }, 429);
        return jsonReply(res, { error: '账号或密码错误' }, 401);
      }
      await authCenter.throttleClear('ident', 'v:' + name);
      const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
      const sig = crypto.createHmac('sha256', vendorTokenSecret()).update(`${exp}.${v.id}`).digest('hex');
      await authCenter.audit({ action: 'auth.vendor.login', resource: 'vendor', resourceId: String(v.id), result: 'ok', ip, ua: req.headers['user-agent'] || '' });
      return jsonReply(res, {
        token: `${exp}.${v.id}.${sig}`,
        role: 'vendor',
        expires_at: new Date(exp * 1000).toISOString(),
        vendor: { id: v.id, name: v.name, type: v.type },
      });
    }

    // GET /api/juzhu/vendor/me（vendor 或 platform）
    if (urlPath === '/api/juzhu/vendor/me' && req.method === 'GET') {
      const sess = await requestSession(req);
      if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
      if (sess.role === 'platform') return jsonReply(res, { role: 'platform' });
      const vrows = await queryRows('SELECT id, name, type, city_ids FROM jz_vendors WHERE id=?', [sess.vendorId]);
      if (!vrows.length) return jsonReply(res, { error: 'vendor not found' }, 404);
      return jsonReply(res, { role: 'vendor', vendor: vrows[0] });
    }

    // GET /api/juzhu/vendor/projects（vendor 只见自己；platform 可 ?vendor_id= 过滤或全量）
    if (urlPath === '/api/juzhu/vendor/projects' && req.method === 'GET') {
      const sess = await requestSession(req);
      if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
      let sql = `SELECT p.*, d.name AS district_name, v.name AS vendor_name
                 FROM projects p
                 LEFT JOIN districts d ON d.id=p.district_id
                 LEFT JOIN jz_vendors v ON v.id=p.owner_vendor_id
                 WHERE 1=1`;
      const params = [];
      if (sess.role === 'vendor') { sql += ' AND p.owner_vendor_id=?'; params.push(sess.vendorId); }
      const vqp = new URLSearchParams(qs);
      if (vqp.get('vendor_id')) { sql += ' AND p.owner_vendor_id=?'; params.push(parseInt(vqp.get('vendor_id'), 10)); }
      if (vqp.get('channel')) { sql += ' AND p.channel=?'; params.push(vqp.get('channel')); }
      if (vqp.get('city_id')) { sql += ' AND p.city_id=?'; params.push(parseInt(vqp.get('city_id'), 10)); }
      sql += ' ORDER BY p.channel, p.sort_order, p.id';
      const projects = await queryRows(sql, params);
      const projectIds = projects.map((p) => p.id);
      let units = [];
      if (projectIds.length) {
        units = await queryRows(
          `SELECT * FROM units WHERE project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY sort_order, id`,
          projectIds
        );
      }
      units.forEach((u) => parseJsonFields(u, ['tags', 'amenities', 'keeper', 'rent_detail', 'ext']));
      return jsonReply(res, {
        role: sess.role,
        projects: projects.map((p) => Object.assign(stripContactPhone(parseJsonFields(p, ['ext'])), stayConfigOf(p))),
        units,
      });
    }

    // POST /api/juzhu/vendor/projects/:id/status（下架/上架：status online|offline|draft）
    {
      const m = urlPath.match(/^\/api\/juzhu\/vendor\/projects\/(\d+)\/status$/);
      if (m && req.method === 'POST') {
        const sess = await requestSession(req);
        if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
        const pid = parseInt(m[1], 10);
        const body = await readBody(req);
        const status = String(body.status || '');
        if (!['online', 'offline', 'draft'].includes(status)) {
          return jsonReply(res, { error: 'status 须为 online/offline/draft' }, 400);
        }
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM projects WHERE id=?', [pid]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          if (sess.role === 'vendor' && rows[0].owner_vendor_id !== sess.vendorId) {
            conn.end();
            return jsonReply(res, { error: 'forbidden：非本商家房源' }, 403);
          }
          await conn.execute('UPDATE projects SET status=? WHERE id=?', [status, pid]);
          await conn.commit();
          const [updated] = await conn.execute('SELECT id, name, status FROM projects WHERE id=?', [pid]);
          return jsonReply(res, { ok: true, project: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // PUT /api/juzhu/vendor/units/:id（商家调价/改户型：限自己项目下的户型，且仅价格展示字段）
    {
      const m = urlPath.match(/^\/api\/juzhu\/vendor\/units\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const sess = await requestSession(req);
        if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
        const uid = parseInt(m[1], 10);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute(
            'SELECT u.id, p.owner_vendor_id FROM units u JOIN projects p ON p.id=u.project_id WHERE u.id=?',
            [uid]
          );
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          if (sess.role === 'vendor' && rows[0].owner_vendor_id !== sess.vendorId) {
            conn.end();
            return jsonReply(res, { error: 'forbidden：非本商家房源' }, 403);
          }
          const sets = [], vals = [];
          const put = (col, val) => { sets.push(`${col}=?`); vals.push(val); };
          for (const col of ['rent_monthly', 'promo_price', 'layout_label', 'unit_spec', 'sort_order']) {
            if (col in body) put(col, body[col]);
          }
          if ('ext' in body) put('ext', body.ext != null ? JSON.stringify(body.ext) : null);
          if (!sets.length) { conn.end(); return jsonReply(res, { error: '无可更新字段' }, 400); }
          vals.push(uid);
          await conn.execute(`UPDATE units SET ${sets.join(', ')} WHERE id=?`, vals);
          await conn.commit();
          const [updated] = await conn.execute('SELECT * FROM units WHERE id=?', [uid]);
          return jsonReply(res, { ok: true, unit: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // GET /api/juzhu/vendor/stay-calendar?project_id=&unit_id=&month= —— 商家房态日历（owner 校验）
    {
      const m = urlPath.match(/^\/api\/juzhu\/vendor\/stay-calendar$/);
      if (m && req.method === 'GET') {
        const sess = await requestSession(req);
        if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
        const vqp = new URLSearchParams(qs);
        const pid = parseInt(vqp.get('project_id') || '', 10);
        if (!pid) return jsonReply(res, { error: 'project_id 必填' }, 400);
        const prows = await queryRows('SELECT * FROM projects WHERE id=?', [pid]);
        if (!prows.length) return jsonReply(res, { error: 'not found' }, 404);
        if (sess.role === 'vendor' && prows[0].owner_vendor_id !== sess.vendorId) {
          return jsonReply(res, { error: 'forbidden：非本商家房源' }, 403);
        }
        const unitId = vqp.get('unit_id') ? (parseInt(vqp.get('unit_id'), 10) || 0) : 0;
        const mth = /^(\d{4})-(\d{2})$/.exec((vqp.get('month') || '').trim());
        const today = new Date();
        const y = mth ? parseInt(mth[1], 10) : today.getFullYear();
        const mo = mth ? (parseInt(mth[2], 10) - 1) : today.getMonth();
        let unit = null;
        if (unitId) {
          const us = await queryRows('SELECT * FROM units WHERE id=? AND project_id=?', [unitId, pid]);
          if (!us.length) return jsonReply(res, { error: 'unit not found' }, 404);
          unit = us[0];
        }
        const cal = await buildStayMonth(prows[0], unit, unitId, y, mo);
        return jsonReply(res, Object.assign({
          role: sess.role,
          project_id: pid,
          project_name: prows[0].name,
          unit_id: unitId,
          writable: true,
        }, cal, stayConfigOf(prows[0])));
      }
    }

    // POST /api/juzhu/vendor/stay-calendar —— 批量设置房态/夜价
    // body: { project_id, unit_id?, dates: ['YYYY-MM-DD'...], status: 'open'|'blocked', price_night?: number|null }
    //   blocked=关房；open + price_night=开房并设夜价；open 无 price_night=恢复默认（删差异行）
    {
      const m = urlPath.match(/^\/api\/juzhu\/vendor\/stay-calendar$/);
      if (m && req.method === 'POST') {
        const sess = await requestSession(req);
        if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
        const body = await readBody(req);
        const pid = parseInt(body.project_id, 10);
        const unitId = body.unit_id ? (parseInt(body.unit_id, 10) || 0) : 0;
        const status = String(body.status || '');
        const dates = Array.isArray(body.dates) ? body.dates.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
        const priceRaw = body.price_night;
        const price = (priceRaw === null || priceRaw === undefined || priceRaw === '') ? null : parseInt(priceRaw, 10);
        if (!pid) return jsonReply(res, { error: 'project_id 必填' }, 400);
        if (!['open', 'blocked'].includes(status)) return jsonReply(res, { error: 'status 须为 open/blocked（booked 由下单占用）' }, 400);
        if (price != null && !(price >= 0)) return jsonReply(res, { error: 'price_night 须为非负整数或空' }, 400);
        if (!dates.length) return jsonReply(res, { error: 'dates 必填（YYYY-MM-DD 数组，单次 ≤ 400 天）' }, 400);
        if (dates.length > 400) return jsonReply(res, { error: '单次最多 400 天' }, 400);
        const prows = await queryRows('SELECT * FROM projects WHERE id=?', [pid]);
        if (!prows.length) return jsonReply(res, { error: 'not found' }, 404);
        if (sess.role === 'vendor' && prows[0].owner_vendor_id !== sess.vendorId) {
          return jsonReply(res, { error: 'forbidden：非本商家房源' }, 403);
        }
        if (unitId) {
          const us = await queryRows('SELECT id FROM units WHERE id=? AND project_id=?', [unitId, pid]);
          if (!us.length) return jsonReply(res, { error: 'unit not found' }, 404);
        }
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          // 已被订单占用的晚不可改（须先取消订单）
          const [booked] = await conn.execute(
            `SELECT stay_date FROM stay_calendar WHERE project_id=? AND unit_id IN (0, ?)
             AND status='booked' AND stay_date IN (${dates.map(() => '?').join(',')})`,
            [pid, unitId, ...dates]
          );
          if (booked.length) {
            return jsonReply(res, { error: `以下日期已有预订占用，须先取消订单：${booked.map((r) => r.stay_date).join('、')}` }, 400);
          }
          let affected = 0;
          if (status === 'blocked') {
            const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
            for (const d of dates) {
              const [r] = await conn.execute(
                `INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, price_night, source, updated_at)
                 VALUES (?,?,?,'blocked',?,'vendor',?)
                 ON DUPLICATE KEY UPDATE status='blocked', source='vendor', booking_id=NULL, updated_at=VALUES(updated_at)`,
                [pid, unitId, d, price, now]
              );
              affected += r.affectedRows || 0;
            }
          } else if (price != null) {
            const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
            for (const d of dates) {
              const [r] = await conn.execute(
                `INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, price_night, source, updated_at)
                 VALUES (?,?,?,'open',?,'vendor',?)
                 ON DUPLICATE KEY UPDATE status='open', price_night=VALUES(price_night), updated_at=VALUES(updated_at)`,
                [pid, unitId, d, price, now]
              );
              affected += r.affectedRows || 0;
            }
          } else {
            // 恢复默认：删差异行
            const [r] = await conn.execute(
              `DELETE FROM stay_calendar WHERE project_id=? AND unit_id=? AND status IN ('open','blocked')
               AND stay_date IN (${dates.map(() => '?').join(',')})`,
              [pid, unitId, ...dates]
            );
            affected = r.affectedRows || 0;
          }
          await conn.commit();
          return jsonReply(res, { ok: true, project_id: pid, unit_id: unitId, status, price_night: price, dates: dates.length, affected });
        } finally { await conn.end(); }
      }
    }

    // PUT /api/juzhu/vendor/projects/:id —— 商家配置房源保障/连住规则/按晚预订开关（写 projects.ext，规则15 不加列）
    // body: { insurance?: ['switch_rental'|'hotel_cancel'|'property'], min_stay_nights?: 1-365, stay_bookable?: bool }
    {
      const m = urlPath.match(/^\/api\/juzhu\/vendor\/projects\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const sess = await requestSession(req);
        if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
        const pid = parseInt(m[1], 10);
        const body = await readBody(req);
        const prows = await queryRows('SELECT * FROM projects WHERE id=?', [pid]);
        if (!prows.length) return jsonReply(res, { error: 'not found' }, 404);
        if (sess.role === 'vendor' && prows[0].owner_vendor_id !== sess.vendorId) {
          return jsonReply(res, { error: 'forbidden：非本商家房源' }, 403);
        }
        const ext = parseExtObj(prows[0].ext);
        if ('insurance' in body) {
          if (body.insurance === null || body.insurance === '') { ext.insurance = []; }
          else if (Array.isArray(body.insurance)) {
            ext.insurance = body.insurance.map(String).filter((k) => INSURANCE_KEYS.includes(k));
          } else return jsonReply(res, { error: 'insurance 须为标识数组：' + INSURANCE_KEYS.join('/') }, 400);
        }
        if ('min_stay_nights' in body) {
          if (body.min_stay_nights === null || body.min_stay_nights === '') { delete ext.min_stay_nights; }
          else {
            const v = parseInt(body.min_stay_nights, 10);
            if (!(v >= 1 && v <= 365)) return jsonReply(res, { error: 'min_stay_nights 须为 1-365 的整数' }, 400);
            ext.min_stay_nights = v;
          }
        }
        if ('stay_bookable' in body) {
          // 「按晚预订」开关（口径 2026-09-05）：开通 = C 端日历选房 + 在线下单；关闭 = 仅 400 电话咨询
          ext.stay_bookable = body.stay_bookable === true || body.stay_bookable === 'true' || body.stay_bookable === 1;
        }
        if (!('insurance' in body) && !('min_stay_nights' in body) && !('stay_bookable' in body)) {
          return jsonReply(res, { error: '无可更新字段（insurance / min_stay_nights / stay_bookable）' }, 400);
        }
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          await conn.execute('UPDATE projects SET ext=? WHERE id=?', [JSON.stringify(ext), pid]);
          await conn.commit();
          const [updated] = await conn.execute('SELECT * FROM projects WHERE id=?', [pid]);
          return jsonReply(res, { ok: true, project: Object.assign(stripContactPhone(updated[0]), stayConfigOf(updated[0])) });
        } finally { await conn.end(); }
      }
    }

    // GET /api/juzhu/admin/districts（admin 前缀，需鉴权）
    if (urlPath === '/api/juzhu/admin/districts' && req.method === 'GET') {
      if (!(await requireApiKey(req, res))) return;
      const rows = await queryRows('SELECT * FROM districts ORDER BY sort_order');
      return jsonReply(res, rows);
    }

    // POST /api/juzhu/admin/ratings/:code/review
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/ratings\/([^/]+)\/review$/);
      if (m && req.method === 'POST') {
        if (!(await requireApiKey(req, res))) return;
        const code = decodeURIComponent(m[1]);
        const idMatch = code.match(/-(\d+)$/);
        if (!idMatch) return jsonReply(res, { error: 'invalid code' }, 400);
        const pid = parseInt(idMatch[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM projects WHERE id=? AND rating_status=?', [pid, 'pending']);
          if (!rows.length) return jsonReply(res, { error: 'not found or not pending' }, 404);
          const action = body.action === 'pass' ? 'passed' : 'rejected';
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          let rating = {};
          try { rating = JSON.parse(rows[0].rating || '{}'); } catch (_) {}
          if (body.dims) rating.dims = body.dims;
          if (body.total != null) rating.total = body.total;
          await conn.execute(
            'UPDATE projects SET rating=?, rating_status=?, rating_reviewed_at=?, rating_note=? WHERE id=?',
            [JSON.stringify(rating), action, now, body.note || null, pid]
          );
          await conn.commit();
          const [updated] = await conn.execute('SELECT * FROM projects WHERE id=?', [pid]);
          return jsonReply(res, { ok: true, project: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // ===== 家政 C 端写接口 =====

    // POST /api/juzhu/jiazheng/orders（下单）
    if (urlPath === '/api/juzhu/jiazheng/orders' && req.method === 'POST') {
      if (!(await requireCEndWrite(req, res, authCenter.P.ORDER_CREATE))) return;
      const body = await readBody(req);
      const productId = body.product_id || body.sku_id;
      if (!productId) return jsonReply(res, { error: 'product_id 必填' }, 400);
      if (!body.house) return jsonReply(res, { error: 'house 必填' }, 400);
      if (!body.phone) return jsonReply(res, { error: 'phone 必填' }, 400);
      if (!body.expectTime) return jsonReply(res, { error: 'expectTime 必填' }, 400);

      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [prods] = await conn.execute(
          `SELECT p.*, s.category_id, s.name AS sku_name, c.name AS category_name
           FROM jz_products p
           JOIN jz_skus s ON s.id=p.channel_sku_id
           JOIN jz_categories c ON c.id=s.category_id
           WHERE p.id=? AND p.status='on' AND s.enabled=1 AND c.enabled=1`,
          [productId]
        );
        if (!prods.length) { conn.end(); return jsonReply(res, { error: '商品不存在或已下架' }, 400); }
        const prod = prods[0];

        const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        const orderId = 'WO-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
        const fee = body.fee != null ? parseInt(body.fee) : Math.round((prod.price || 0) * 100);
        const log = [{ at: now, action: 'created', note: `来源: ${body.source || 'c_web'}` }];

        await conn.execute(
          `INSERT INTO jz_orders(id,sku_id,category_id,type,house,phone,expect_time,\`desc\`,fee,pay_status,status,slot_id,source,created_at,updated_at,log_json)
           VALUES (?,?,?,?,?,?,?,?,?,'unpaid','pending',?,?,?,?,?)`,
          [orderId, prod.channel_sku_id || null, prod.category_id, prod.category_id,
           body.house, body.phone, body.expectTime, body.desc || null,
           fee, body.slot_id || null, body.source || 'c_web', now, now, JSON.stringify(log)]
        );
        await conn.commit();
        const [orders] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
        return jsonReply(res, { ok: true, order: orders[0] }, 201);
      } finally { await conn.end(); }
    }

    // POST /api/juzhu/jiazheng/orders/:id/pay
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/orders\/([^/]+)\/pay$/);
      if (m && req.method === 'POST') {
        if (!(await requireCEndWrite(req, res, authCenter.P.ORDER_CREATE))) return;
        const orderId = m[1];
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const order = rows[0];
          if (order.pay_status === 'paid') { conn.end(); return jsonReply(res, { ok: true, order }); }
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          if (order.slot_id) {
            const [slotRes] = await conn.execute(
              'UPDATE jz_sku_slots SET booked=booked+1 WHERE id=? AND status=? AND booked<capacity',
              [order.slot_id, 'open']
            );
            if (slotRes.affectedRows === 0) { conn.end(); return jsonReply(res, { error: '档期已满，请重新选择' }, 400); }
          }
          let log = [];
          try { log = JSON.parse(order.log_json || '[]'); } catch (_) {}
          log.push({ at: now, action: 'paid', pay_method: body.pay_method || 'online' });
          await conn.execute(
            "UPDATE jz_orders SET pay_status='paid', pay_method=?, pay_at=?, updated_at=?, log_json=? WHERE id=?",
            [body.pay_method || 'online', now, now, JSON.stringify(log), orderId]
          );
          await conn.commit();
          const [updated] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          return jsonReply(res, { ok: true, order: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // POST /api/juzhu/jiazheng/orders/:id/dispatch（派单）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/orders\/([^/]+)\/dispatch$/);
      if (m && req.method === 'POST') {
        if (!(await requireDispatchPerm(req, res))) return;
        const orderId = m[1];
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const order = rows[0];
          if (order.pay_status !== 'paid' || order.status !== 'pending') {
            conn.end(); return jsonReply(res, { error: '订单须已支付且为待派单状态' }, 400);
          }
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          const worker = body.worker || null;
          let log = [];
          try { log = JSON.parse(order.log_json || '[]'); } catch (_) {}
          log.push({ at: now, action: 'dispatched', worker });
          await conn.execute(
            "UPDATE jz_orders SET status='dispatched', worker_json=?, updated_at=?, log_json=? WHERE id=?",
            [worker ? JSON.stringify(worker) : null, now, JSON.stringify(log), orderId]
          );
          await conn.commit();
          await auditIfAccount(req, 'order.dispatch', 'jz_orders', String(orderId), { worker });
          const [updated] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          return jsonReply(res, { ok: true, order: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // POST /api/juzhu/jiazheng/orders/:id/advance（推进状态）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/orders\/([^/]+)\/advance$/);
      if (m && req.method === 'POST') {
        if (!(await requireDispatchPerm(req, res))) return;
        const orderId = m[1];
        const STATUS_ORDER = ['pending', 'dispatched', 'accepted', 'serving', 'done'];
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const order = rows[0];
          const curIdx = STATUS_ORDER.indexOf(order.status);
          if (curIdx === -1) { conn.end(); return jsonReply(res, { error: `当前状态 ${order.status} 不可推进` }, 400); }
          if (order.status === 'pending') { conn.end(); return jsonReply(res, { error: '请先派单再推进状态' }, 400); }
          if (curIdx >= STATUS_ORDER.length - 1) { conn.end(); return jsonReply(res, { error: '已是最终状态' }, 400); }
          const nextStatus = STATUS_ORDER[curIdx + 1];
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          let log = [];
          try { log = JSON.parse(order.log_json || '[]'); } catch (_) {}
          log.push({ at: now, action: 'advance', from: order.status, to: nextStatus });
          await conn.execute(
            'UPDATE jz_orders SET status=?, updated_at=?, log_json=? WHERE id=?',
            [nextStatus, now, JSON.stringify(log), orderId]
          );
          await conn.commit();
          await auditIfAccount(req, 'order.advance', 'jz_orders', String(orderId), { from: order.status, to: nextStatus });
          const [updated] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          return jsonReply(res, { ok: true, order: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // POST /api/juzhu/jiazheng/orders/:id/rate（须 API Key）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/orders\/([^/]+)\/rate$/);
      if (m && req.method === 'POST') {
        if (!(await requireCEndWrite(req, res, authCenter.P.RATING_WRITE))) return;
        const orderId = m[1];
        const body = await readBody(req);
        const score = parseInt(body.score);
        if (!score || score < 1 || score > 5) return jsonReply(res, { error: 'score 须为 1-5' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const order = rows[0];
          if (order.status !== 'done') { conn.end(); return jsonReply(res, { error: '仅已完成订单可评价' }, 400); }
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          const rating = { score, tags: body.tags || [], text: body.text || '' };
          let log = [];
          try { log = JSON.parse(order.log_json || '[]'); } catch (_) {}
          log.push({ at: now, action: 'rated', score });
          await conn.execute(
            "UPDATE jz_orders SET status='rated', rating_json=?, updated_at=?, log_json=? WHERE id=?",
            [JSON.stringify(rating), now, JSON.stringify(log), orderId]
          );
          await conn.commit();
          const [updated] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          return jsonReply(res, { ok: true, order: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // GET /api/juzhu/jiazheng/skus/:slug/slots（可约档期）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/skus\/([^/]+)\/slots$/);
      if (m && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        const qp = new URLSearchParams(qs);
        const vendorId = qp.get('vendor') ? parseInt(qp.get('vendor')) : null;
        const skus = await queryRows('SELECT id FROM jz_skus WHERE slug=? AND enabled=1', [slug]);
        if (!skus.length) return jsonReply(res, { error: 'not found' }, 404);
        const skuId = skus[0].id;
        let prodSql = `SELECT p.id FROM jz_products p JOIN jz_vendors v ON v.id=p.vendor_id
                       WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'`;
        const prodParams = [skuId];
        if (vendorId) { prodSql += ' AND p.vendor_id=?'; prodParams.push(vendorId); }
        prodSql += ' ORDER BY p.rating DESC, p.sales_count DESC, p.id LIMIT 1';
        const prods = await queryRows(prodSql, prodParams);
        if (!prods.length) return jsonReply(res, { slots: [] });
        const productId = prods[0].id;
        const today = new Date().toISOString().slice(0, 10);
        const slots = await queryRows(
          `SELECT s.*, w.name AS worker_name, w.level AS worker_level, w.avatar AS worker_avatar
           FROM jz_sku_slots s LEFT JOIN jz_workers w ON w.id=s.worker_id
           WHERE s.product_id=? AND s.status='open' AND s.booked<s.capacity AND s.slot_date>=?
           ORDER BY s.slot_date, s.start_time, s.id`,
          [productId, today]
        );
        const result = slots.map(s => ({ ...s, remaining: (s.capacity || 1) - (s.booked || 0) }));
        return jsonReply(res, { slots: result });
      }
    }

    // POST /api/juzhu/jiazheng/wechat-link（C 端匿名预约）
    if (urlPath === '/api/juzhu/jiazheng/wechat-link' && req.method === 'POST') {
      if (!grOrders) return jsonReply(res, { ok: false, error: 'gr_orders module missing' }, 500);
      const body = await readBody(req);
      const parsed = grOrders.validateWechatLinkBody(body);
      if (!parsed.ok) return jsonReply(res, { ok: false, error: parsed.error }, parsed.status);
      const products = await queryRows(
        `SELECT p.*, s.slug AS sku_slug FROM jz_products p
         LEFT JOIN jz_skus s ON s.id=p.channel_sku_id
         WHERE p.id=? AND p.status='on'`,
        [parsed.productId]
      );
      if (!products.length) return jsonReply(res, { ok: false, error: '产品未找到' }, 404);
      const product = products[0];
      const pagePath = product.path || 'pages-sub/goods/goods';
      const productQuery = product.query || '';
      const vendorId = String(product.vendor_id || '');
      const vendors = await getVendorConfig();
      const vendor = vendors[vendorId];
      if (!vendor || !vendor.url_link) {
        return jsonReply(res, {
          ok: false,
          error: `vendor_id=${vendorId} 未配置 url_link，请检查 jz_vendors 表配置`,
        }, 500);
      }
      if (!hmacAuth || !vendor.key) {
        return jsonReply(res, {
          ok: false,
          error: `vendor_id=${vendorId} 未配置 hmac_key，无法按文档带签名调用 url_link`,
        }, 500);
      }
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const orderRef = await grOrders.generateOrderRef(conn);
        // 平台 → 商家 urllink：按 api_doc.md 加 HMAC-SHA256 签名（vendor_id 必带）
        const linkBody = hmacAuth.generateSignature(vendor.key, {
          vendor_id: Number(vendorId),
          path: pagePath,
          query: productQuery,
          order_ref: orderRef,
        });
        const outbound = await outboundJson('POST', vendor.url_link, linkBody, 10000);
        if (!outbound.json || outbound.json.code !== 200) {
          return jsonReply(res, { ok: false, error: (outbound.json && outbound.json.msg) || 'URL Link 生成失败' }, 502);
        }
        await grOrders.createOrder(conn, orderRef, String(parsed.productId), {
          vendor_id: product.vendor_id,
          user_id: parsed.userId,
        });
        return jsonReply(res, {
          ok: true,
          url_link: outbound.json.data || '',
          order_ref: orderRef,
        });
      } finally {
        await conn.end();
      }
    }

    // GET /api/juzhu/gr/orders?user_id=
    if (urlPath === '/api/juzhu/gr/orders' && req.method === 'GET') {
      if (!grOrders) return jsonReply(res, { ok: false, error: 'gr_orders module missing' }, 500);
      const qp = new URLSearchParams(qs);
      const parsed = grOrders.validateUserIdQuery(qp.get('user_id'));
      if (!parsed.ok) return jsonReply(res, { ok: false, error: parsed.error }, parsed.status);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const data = await grOrders.listUserOrders(conn, parsed.userId, qp.get('limit'));
        return jsonReply(res, { ok: true, ...data });
      } finally {
        await conn.end();
      }
    }

    // GET /api/juzhu/gr/orders/:ref/vendor-detail
    {
      const m = urlPath.match(/^\/api\/juzhu\/gr\/orders\/([^/]+)\/vendor-detail$/);
      if (m && req.method === 'GET') {
        if (!grOrders) return jsonReply(res, { ok: false, error: 'gr_orders module missing' }, 500);
        const orderRef = decodeURIComponent(m[1]);
        const qp = new URLSearchParams(qs);
        const parsed = grOrders.validateUserIdQuery(qp.get('user_id'));
        if (!parsed.ok) return jsonReply(res, { ok: false, error: parsed.error }, parsed.status);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const order = await grOrders.getUserOrder(conn, orderRef, parsed.userId);
          if (!order) return jsonReply(res, { ok: false, error: '订单不存在' }, 404);
          if (!order.vendor_id) return jsonReply(res, { ok: false, error: '订单未关联商家' });
          const vendors = await getVendorConfig();
          const vendor = vendors[String(order.vendor_id)] || {};
          const detailUrl = vendor.order_detail_url || '';
          if (!detailUrl) return jsonReply(res, { ok: false, error: '商家未配置订单详情接口' });
          if (!hmacAuth || !vendor.key) {
            return jsonReply(res, { ok: false, error: `vendor_id=${order.vendor_id} 未配置 hmac_key，无法按文档带签名调用订单详情` });
          }
          // 平台 → 商家 order_detail（GET）：按 api_doc.md 把 vendor_id / timestamp / sign 一并放在 query string
          // 商家侧按相同规则（递归展平→去空→字典序→HMAC-SHA256）验签
          const signed = hmacAuth.generateSignature(vendor.key, {
            vendor_id: Number(order.vendor_id),
            order_ref: orderRef,
          });
          const qsParts = Object.entries(signed).map(([k, v]) =>
            encodeURIComponent(k) + '=' + encodeURIComponent(v)
          ).join('&');
          const sep = detailUrl.includes('?') ? '&' : '?';
          const url = detailUrl + sep + qsParts;
          const outbound = await outboundJson('GET', url, null, 5000);
          if (!outbound.json || outbound.json.code !== 200 || !outbound.json.data) {
            return jsonReply(res, { ok: false, error: '商家未返回订单详情' });
          }
          const data = outbound.json.data;
          const worker = data.worker || null;
          if (worker && worker.eta) worker.eta = grOrders.normEtaPeking(worker.eta);
          return jsonReply(res, {
            ok: true,
            detail: {
              vendor_oid: data.lailai_oid,
              status: data.status,
              fee: data.fee,
              worker,
              cancel_reason: data.cancel_reason,
            },
          });
        } finally {
          await conn.end();
        }
      }
    }

    // GET /api/juzhu/gr/orders/:ref
    {
      const m = urlPath.match(/^\/api\/juzhu\/gr\/orders\/([^/]+)$/);
      if (m && req.method === 'GET') {
        if (!grOrders) return jsonReply(res, { ok: false, error: 'gr_orders module missing' }, 500);
        const orderRef = decodeURIComponent(m[1]);
        const qp = new URLSearchParams(qs);
        const parsed = grOrders.validateUserIdQuery(qp.get('user_id'));
        if (!parsed.ok) return jsonReply(res, { ok: false, error: parsed.error }, parsed.status);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const order = await grOrders.getUserOrder(conn, orderRef, parsed.userId);
          if (!order) return jsonReply(res, { ok: false, error: '订单不存在' }, 404);
          return jsonReply(res, { ok: true, order });
        } finally {
          await conn.end();
        }
      }
    }

    // ===== /api/juzhu/jz/* 管理台接口 =====

    // GET /api/juzhu/jz/categories
    if (urlPath === '/api/juzhu/jz/categories' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const all = qp.get('all') === '1';
      let sql = all
        ? 'SELECT * FROM jz_categories ORDER BY sort_order, id'
        : "SELECT * FROM jz_categories WHERE enabled=1 ORDER BY sort_order, id";
      const rows = await queryRows(sql);
      return jsonReply(res, { list: rows });
    }

    // GET /api/juzhu/jz/spu
    if (urlPath === '/api/juzhu/jz/spu' && req.method === 'GET') {
      const rows = await queryRows(
        `SELECT s.*, c.name AS category_name, c.icon AS category_icon,
           (SELECT COUNT(*) FROM jz_products p WHERE p.channel_sku_id=s.id) AS sku_count
         FROM jz_skus s LEFT JOIN jz_categories c ON c.id=s.category_id
         ORDER BY s.category_id, s.sort_order, s.id`
      );
      rows.forEach(r => parseJsonFields(r, ['tags', 'badges', 'includes', 'service_flow', 'service_notice']));
      return jsonReply(res, { list: rows });
    }

    // GET /api/juzhu/jz/vendors
    if (urlPath === '/api/juzhu/jz/vendors' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = "SELECT * FROM jz_vendors WHERE status='active' ORDER BY type, sort_order, id";
      const params = [];
      if (qp.get('type')) { sql = "SELECT * FROM jz_vendors WHERE type=? AND status='active' ORDER BY sort_order, id"; params.push(qp.get('type')); }
      const vendors = await queryRows(sql, params);
      // 每个商家附带前2个上架产品
      for (const v of vendors) {
        stripVendorSecrets(v);
        v.products = await queryRows(
          "SELECT * FROM jz_products WHERE vendor_id=? AND status='on' ORDER BY sort_order, id LIMIT 2",
          [v.id]
        );
        v.products.forEach(p => parseJsonFields(p, ['service_tags']));
      }
      return jsonReply(res, { list: vendors });
    }

    // GET /api/juzhu/jz/vendors/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/jz\/vendors\/(\d+)$/);
      if (m && req.method === 'GET') {
        const rows = await queryRows('SELECT * FROM jz_vendors WHERE id=?', [parseInt(m[1])]);
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        const v = stripVendorSecrets(rows[0]);
        v.products = await queryRows("SELECT * FROM jz_products WHERE vendor_id=? AND status='on' ORDER BY sort_order", [v.id]);
        v.products.forEach(p => parseJsonFields(p, ['service_tags']));
        return jsonReply(res, v);
      }
    }

    // GET /api/juzhu/jz/products（B 端产品管理：对齐 Python 版 list_products 字段契约）
    if (urlPath === '/api/juzhu/jz/products' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = `SELECT p.*, v.name AS vendor_name, v.type AS vendor_type,
                   COALESCE(s.category_id, v.type) AS product_category,
                   c.name AS city_name
                 FROM jz_products p
                 LEFT JOIN jz_vendors v ON v.id=p.vendor_id
                 LEFT JOIN jz_skus s ON s.id=p.channel_sku_id
                 LEFT JOIN cities c ON c.id=p.city_id
                 WHERE 1=1`;
      const params = [];
      if (qp.get('vendor_id')) { sql += ' AND p.vendor_id=?'; params.push(parseInt(qp.get('vendor_id'))); }
      if (qp.get('type')) { sql += ' AND COALESCE(s.category_id, v.type)=?'; params.push(qp.get('type')); }
      if (qp.get('status')) { sql += ' AND p.status=?'; params.push(qp.get('status')); }
      sql += ' ORDER BY p.vendor_id, p.sort_order, p.id LIMIT 200';
      const rows = await queryRows(sql, params);
      rows.forEach(r => parseJsonFields(r, ['service_tags']));
      // 附加：引用的 SPU 名 + 绑定服务者 id 列表（对齐 Python 版 list_products）
      for (const row of rows) {
        const workerRows = await queryRows('SELECT worker_id FROM jz_sku_workers WHERE product_id=?', [row.id]);
        row.worker_ids = workerRows.map(w => w.worker_id);
        if (row.channel_sku_id) {
          const spuRows = await queryRows('SELECT name FROM jz_skus WHERE id=?', [row.channel_sku_id]);
          row.spu_name = spuRows.length ? spuRows[0].name : null;
        } else {
          row.spu_name = null;
        }
      }
      return jsonReply(res, { list: rows });
    }

    // GET /api/juzhu/jz/products/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/jz\/products\/(\d+)$/);
      if (m && req.method === 'GET') {
        const rows = await queryRows('SELECT p.*, v.name AS vendor_name FROM jz_products p LEFT JOIN jz_vendors v ON v.id=p.vendor_id WHERE p.id=?', [parseInt(m[1])]);
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        parseJsonFields(rows[0], ['service_tags']);
        return jsonReply(res, rows[0]);
      }
    }

    // GET /api/juzhu/jz/workers
    if (urlPath === '/api/juzhu/jz/workers' && req.method === 'GET') {
      const rows = await queryRows("SELECT * FROM jz_workers WHERE status='active' ORDER BY credit_score DESC, completed_orders DESC");
      rows.forEach(r => parseJsonFields(r, ['tags']));
      return jsonReply(res, { list: rows });
    }

    // GET /api/juzhu/jz/workers/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/jz\/workers\/(\d+)$/);
      if (m && req.method === 'GET') {
        const rows = await queryRows('SELECT * FROM jz_workers WHERE id=?', [parseInt(m[1])]);
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        parseJsonFields(rows[0], ['tags']);
        return jsonReply(res, rows[0]);
      }
    }

    // GET /api/juzhu/jz/orders
    if (urlPath === '/api/juzhu/jz/orders' && req.method === 'GET') {
      if (!(await requireApiKey(req, res))) return;
      const qp = new URLSearchParams(qs);
      let sql = 'SELECT o.*, s.name AS sku_name FROM jz_orders o LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE 1=1';
      const params = [];
      if (qp.get('status')) { sql += ' AND o.status=?'; params.push(qp.get('status')); }
      const limit = Math.min(parseInt(qp.get('limit') || '50'), 200);
      sql += ' ORDER BY o.created_at DESC LIMIT ' + limit; // limit 已 parseInt+封顶，内联（mysql2 预处理不接受 LIMIT 绑定）
      const rows = await queryRows(sql, params);
      return jsonReply(res, { list: rows });
    }

    // GET /api/juzhu/jz/orders/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/jz\/orders\/([^/]+)$/);
      if (m && req.method === 'GET') {
        if (!(await requireApiKey(req, res))) return;
        const rows = await queryRows(
          'SELECT o.*, s.name AS sku_name FROM jz_orders o LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE o.id=?',
          [m[1]]
        );
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        return jsonReply(res, rows[0]);
      }
    }

    // GET /api/juzhu/jz/subcategories
    if (urlPath === '/api/juzhu/jz/subcategories' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = "SELECT * FROM jz_subcategories WHERE status='on'";
      const params = [];
      if (qp.get('type')) { sql += ' AND parent_type=?'; params.push(qp.get('type')); }
      sql += ' ORDER BY sort_order, id';
      const rows = await queryRows(sql, params);
      return jsonReply(res, { list: rows });
    }

    // GET /api/juzhu/jiazheng/skus/:slug/detail
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/skus\/([^/]+)\/detail$/);
      if (m && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        const skus = await queryRows(
          `SELECT s.*, c.name AS category_name FROM jz_skus s
           JOIN jz_categories c ON c.id=s.category_id
           WHERE s.slug=? AND s.enabled=1`,
          [slug]
        );
        if (!skus.length) return jsonReply(res, { error: 'not found' }, 404);
        return jsonReply(res, skus[0]);
      }
    }

    // GET /api/juzhu/jiazheng/skus/:slug/vendors
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/skus\/([^/]+)\/vendors$/);
      if (m && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        const skus = await queryRows('SELECT id FROM jz_skus WHERE slug=? AND enabled=1', [slug]);
        if (!skus.length) return jsonReply(res, { error: 'not found' }, 404);
        const skuId = skus[0].id;
        const qp = new URLSearchParams(qs);
        const cityName = (qp.get('city') || '').trim();
        let sql = `SELECT v.*, p.id AS product_id, p.price, p.original_price,
                     p.title, p.subtitle, p.sales_count, p.rating AS product_rating,
                     p.service_tags, p.advance_booking_hours
                   FROM jz_vendors v
                   JOIN jz_products p ON p.vendor_id=v.id
                   WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'`;
        const params = [skuId];
        if (cityName) {
          const tokens = await cityMatchTokens(cityName);
          sql += ` AND ${cityIdsClause('v', tokens)}`;
          params.push(...tokens);
        }
        sql += ' ORDER BY v.sort_order, v.id LIMIT 20';
        const vendors = await queryRows(sql, params);
        vendors.forEach(stripVendorSecrets);
        return jsonReply(res, { vendors });
      }
    }

    // ===== 运营商员工花名册（operator_staff）=====
    // 读：org.read（持有方/机构只读）或 worker.manage（运营商管理）；写：worker.manage + audit_log
    // 行级（scope）：org 档只见自家 + 平台级（org_id IS NULL）；vendor 档同理按 vendor_id；
    // city 档无城市映射，只见平台级行；all 档全量
    if (urlPath === '/api/juzhu/staff' && req.method === 'GET') {
      if (!(await requireAnyPerm(req, res, ['org.read', 'worker.manage'], '花名册'))) return;
      const principal = req.principal;
      const scope = authCenter.scopeOf(principal);
      let where = '';
      const params = [];
      if (scope.level === 'org' && scope.orgId != null) { where = ' WHERE (org_id=? OR org_id IS NULL)'; params.push(scope.orgId); }
      else if (scope.level === 'vendor' && scope.vendorId != null) { where = ' WHERE (vendor_id=? OR vendor_id IS NULL)'; params.push(scope.vendorId); }
      else if (scope.level === 'self') { where = ' WHERE phone=? AND phone IS NOT NULL'; params.push(String((principal.account || {}).phone || '')); }
      else if (scope.level !== 'all') { where = ' WHERE org_id IS NULL AND vendor_id IS NULL'; }
      const rows = await queryRows(`SELECT * FROM operator_staff${where} ORDER BY level DESC, month_orders DESC, id ASC`, params);
      return jsonReply(res, { list: rows, scope: scope.level });
    }

    if (urlPath === '/api/juzhu/staff' && req.method === 'POST') {
      if (!(await requirePerm(req, res, 'worker.manage', '花名册维护'))) return;
      const body = await readBody(req);
      const v = validateStaff(body, { partial: false });
      if (v.error) return jsonReply(res, { error: v.error }, 400);
      const clientEmpNo = (body.emp_no || '').trim() || null;
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const now = new Date().toISOString().slice(0, 19);
        const ins = 'INSERT INTO operator_staff (emp_no,name,phone,level,`role`,station,month_orders,rating,contract_type,contract_end,status,can_extra,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
        let row = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          const empNo = clientEmpNo || (await nextEmpNo(conn));
          row = { ...v.row, emp_no: empNo, created_at: now, updated_at: now };
          try {
            const [ret] = await conn.execute(ins, [
              row.emp_no, row.name, row.phone, row.level, row.role, row.station, row.month_orders, row.rating,
              row.contract_type, row.contract_end, row.status, row.can_extra, row.note, row.created_at, row.updated_at,
            ]);
            row.id = ret.insertId;
            break;
          } catch (e) {
            if (e && e.code === 'ER_DUP_ENTRY') {
              if (clientEmpNo) return jsonReply(res, { error: '工号已存在：' + clientEmpNo }, 400);
              if (attempt === 3) return jsonReply(res, { error: '工号生成冲突，请重试' }, 500);
              continue;
            }
            throw e;
          }
        }
        await conn.commit();
        await auditIfAccount(req, 'staff.create', 'operator_staff', String(row.id), row);
        return jsonReply(res, { ok: true, staff: row }, 201);
      } finally {
        await conn.end();
      }
    }

    {
      const m = urlPath.match(/^\/api\/juzhu\/staff\/(\d+)$/);
      if (m && req.method === 'GET') {
        if (!(await requireAnyPerm(req, res, ['org.read', 'worker.manage'], '花名册'))) return;
        const rows = await queryRows('SELECT * FROM operator_staff WHERE id=?', [parseInt(m[1], 10)]);
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        // 行级 scope：同列表口径（org/vendor 只见自家 + 平台级）
        const scope = authCenter.scopeOf(req.principal);
        const r = rows[0];
        if (scope.level === 'org' && scope.orgId != null && r.org_id != null && Number(r.org_id) !== scope.orgId) {
          return jsonReply(res, { error: 'forbidden', message: '超出当前账号数据范围' }, 403);
        }
        if (scope.level === 'vendor' && scope.vendorId != null && r.vendor_id != null && Number(r.vendor_id) !== scope.vendorId) {
          return jsonReply(res, { error: 'forbidden', message: '超出当前账号数据范围' }, 403);
        }
        return jsonReply(res, r);
      }
      if (m && req.method === 'PUT') {
        if (!(await requirePerm(req, res, 'worker.manage', '花名册维护'))) return;
        const id = parseInt(m[1], 10);
        const body = await readBody(req);
        const v = validateStaff(body, { partial: true });
        if (v.error) return jsonReply(res, { error: v.error }, 400);
        if (!Object.keys(v.row).length) return jsonReply(res, { error: '无可更新字段' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [cur] = await conn.execute('SELECT * FROM operator_staff WHERE id=?', [id]);
          if (!cur.length) return jsonReply(res, { error: 'not found' }, 404);
          const sets = [];
          const params = [];
          for (const k of Object.keys(v.row)) {
            sets.push((k === 'role' ? '`role`' : k) + '=?');
            params.push(v.row[k]);
          }
          sets.push('updated_at=?');
          params.push(new Date().toISOString().slice(0, 19));
          params.push(id);
          try {
            await conn.execute('UPDATE operator_staff SET ' + sets.join(', ') + ' WHERE id=?', params);
          } catch (e) {
            if (e && e.code === 'ER_DUP_ENTRY') return jsonReply(res, { error: '工号已存在' }, 400);
            throw e;
          }
          await conn.commit();
          const after = await queryRows('SELECT * FROM operator_staff WHERE id=?', [id]);
          await auditIfAccount(req, 'staff.update', 'operator_staff', String(id), after[0]);
          return jsonReply(res, { ok: true, staff: after[0] });
        } finally {
          await conn.end();
        }
      }
      if (m && req.method === 'DELETE') {
        if (!(await requirePerm(req, res, 'worker.manage', '花名册维护'))) return;
        const id = parseInt(m[1], 10);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [cur] = await conn.execute('SELECT * FROM operator_staff WHERE id=?', [id]);
          if (!cur.length) return jsonReply(res, { error: 'not found' }, 404);
          await conn.execute('DELETE FROM operator_staff WHERE id=?', [id]);
          await conn.commit();
          await auditIfAccount(req, 'staff.delete', 'operator_staff', String(id), cur[0]);
          return jsonReply(res, { ok: true, id });
        } finally {
          await conn.end();
        }
      }
    }

    // 未匹配：返回 404
    return jsonReply(res, { error: '接口不存在', path: urlPath, method: req.method }, 404);
  } catch (e) {
    return jsonReply(res, { error: 'DB 查询失败: ' + e.message }, 500);
  }
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

// ===== /api/auth/* —— 账号中心轻路由（登录 / 登出 / 身份 / IdP 联邦），不属于 juzhu 域 =====

// OIDC authorize 流程的 state → {nonce, verifier, exp}（单进程内存态，10 分钟单次消费）
const idpStates = new Map();
function idpStatePut(state, val) {
  idpStates.set(state, Object.assign({ exp: Date.now() + 10 * 60 * 1000 }, val));
  if (idpStates.size > 500) for (const [k, v] of idpStates) if (Date.now() > v.exp) idpStates.delete(k);
}
function idpStateTake(state) {
  const v = idpStates.get(state);
  if (!v || Date.now() > v.exp) { idpStates.delete(state); return null; }
  idpStates.delete(state);
  return v;
}

async function handleAuthRoutes(rawPath, qs, req, res) {
  const p = rawPath.replace(/\/+$/, '') || '/';
  try {
    // ── IdP 联邦（阶段3 §4.6）：GET /api/auth/idp/login?org=<org_no>[&redirect_uri=] ──
    if (p === '/api/auth/idp/login' && req.method === 'GET') {
      await ensureSchema();
      const qp = new URLSearchParams(qs);
      const orgNo = (qp.get('org') || '').trim();
      const cfg = await authCenter.getIdpConfig(orgNo);
      if (!cfg) return jsonReply(res, { error: 'not found', message: '组织未配置或未启用 IdP: ' + orgNo }, 404);
      const base = 'http' + (req.headers['x-forwarded-proto'] === 'https' ? 's' : '') + '://' + (req.headers['x-forwarded-host'] || req.headers.host);
      const redirectUri = base + '/api/auth/idp/callback';
      const built = await idpOidc.buildAuthUrl(cfg, redirectUri);
      idpStatePut(built.state, { nonce: built.nonce, verifier: built.verifier, org_no: orgNo, redirect_uri: redirectUri, next: (qp.get('next') || '').slice(0, 200) });
      res.writeHead(302, { Location: built.url });
      res.end();
      return;
    }
    // ── GET /api/auth/idp/callback?code&state → 验签 → 匹配/JIT → 会话 ──
    if (p === '/api/auth/idp/callback' && req.method === 'GET') {
      await ensureSchema();
      const qp = new URLSearchParams(qs);
      const st = idpStateTake(qp.get('state') || '');
      if (!st) return jsonReply(res, { error: 'invalid_state', message: 'state 无效或已过期' }, 400);
      if (qp.get('error')) return jsonReply(res, { error: qp.get('error'), message: qp.get('error_description') || '' }, 401);
      const cfg = await authCenter.getIdpConfig(st.org_no);
      if (!cfg) return jsonReply(res, { error: 'not found', message: 'IdP 配置已停用' }, 404);
      let claims;
      try {
        claims = await idpOidc.exchangeAndVerify(cfg, {
          code: qp.get('code'), nonce: st.nonce, verifier: st.verifier, redirectUri: st.redirect_uri,
        });
      } catch (e) {
        return jsonReply(res, { error: 'idp_verify_failed', message: String(e.message || e) }, 401);
      }
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
      const ua = req.headers['user-agent'] || '';
      const full = await authCenter.resolveIdpAccount(cfg, claims, {
        accountId: null, principalType: 'idp', ip, ua,
      });
      if (!full) return jsonReply(res, { error: 'forbidden', message: 'JIT 建档未开启且无匹配账号' }, 403);
      const sess = await authCenter.createSession(full.account.id, ip, ua, { ttlSeconds: authCenter.SESSION_TTL.idp });
      await authCenter.audit({
        accountId: full.account.id, principalType: 'idp', roles: full.roles,
        action: 'auth.idp.login', resource: 'idp_configs', resourceId: st.org_no,
        scopeLevel: authCenter.bestScopeLevel(full), ip, ua,
      });
      if (st.next && /^\/[^/]/.test(st.next)) {
        res.writeHead(302, { Location: st.next + (st.next.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(sess.token) });
        res.end();
        return;
      }
      return jsonReply(res, {
        token: sess.token,
        expires_at: sess.expires_at,
        account: full.account,
        roles: full.roles.map((r) => r.role_code),
        permissions: [...authCenter.permissionsOf(full)],
        idp: { org_no: st.org_no, sub: claims.sub },
      });
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      await ensureSchema();
      const body = await readBody(req);
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
      const out = await authCenter.loginWithPassword(
        body.login_name || body.username || body.phone,
        body.password,
        ip,
        req.headers['user-agent'] || ''
      );
      if (out.error) return jsonReply(res, { error: out.error, retry_after: out.retry_after }, out.throttled ? 429 : 401);
      return jsonReply(res, {
        token: out.token,
        expires_at: out.expires_at,
        account: out.account,
        roles: out.roles.map((r) => r.role_code),
        permissions: [...authCenter.permissionsOf({ roles: out.roles })],
      });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const ok = await authCenter.revokeSession(authCenter.bearerToken(req));
      return jsonReply(res, { ok });
    }
    if (p === '/api/auth/me' && req.method === 'GET') {
      await ensureSchema();
      const principal = await authCenter.principalOf(req).catch(() => null);
      if (!principal || principal.type !== 'account') return jsonReply(res, { error: 'unauthorized' }, 401);
      return jsonReply(res, {
        account: principal.account,
        roles: principal.roles.map((r) => ({ role_code: r.role_code, scope: r.scope })),
        permissions: [...authCenter.permissionsOf(principal)],
        scope: authCenter.bestScopeLevel(principal),
      });
    }
    return jsonReply(res, { error: 'not found' }, 404);
  } catch (e) {
    return jsonReply(res, { error: String(e.message || e) }, 500);
  }
}

const server = http.createServer((req, res) => {
  const rawPath = req.url.split('?')[0];
  const qs = req.url.includes('?') ? req.url.split('?')[1] : '';

  // CORS preflight
  if (req.method === 'OPTIONS' && (rawPath.startsWith('/api/juzhu') || rawPath.startsWith('/api/auth'))) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Session-Token',
    });
    res.end();
    return;
  }

  // /api/juzhu/* 直接走 Node.js MySQL 实现
  if (rawPath.startsWith('/api/juzhu')) {
    return handleApiDirect(rawPath, qs, req, res);
  }

  // /api/auth/* —— 账号中心登录/登出/身份（handleApiDirect 之外的独立轻路由）
  if (rawPath.startsWith('/api/auth')) {
    return handleAuthRoutes(rawPath, qs, req, res);
  }

  if (!isPublicStatic(rawPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  let filePath_decoded = decodeURIComponent(rawPath);
  if (filePath_decoded === '/') filePath_decoded = '/index.html';
  // 常见拼写：juzhu-amdin → juzhu-admin，避免 404 回落到首页
  if (filePath_decoded === '/juzhu-amdin.html') filePath_decoded = '/juzhu-admin.html';

  const filePath = path.resolve(ROOT, '.' + path.posix.normalize('/' + filePath_decoded.replace(/^\/+/, '/')));

  // Security: prevent directory traversal
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      const indexPath = path.join(ROOT, 'index.html');
      fs.readFile(indexPath, (err2, data) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data);
        }
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err2, data) => {
      if (err2) {
        res.writeHead(500);
        res.end('Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });
});

if (require.main === module) {
  const envName = (process.env.JUZHU_ENV || 'dev').trim().toLowerCase();
  const apiKey = (process.env[API_KEY_ENV] || '').trim();
  if (envName === 'prod' || envName === 'production') {
    if (!apiKey || apiKey === FORBIDDEN_API_KEY) {
      console.error(`FATAL: production requires ${API_KEY_ENV} (must not be empty or ${FORBIDDEN_API_KEY})`);
      process.exit(1);
    }
  } else if (!apiKey || apiKey === FORBIDDEN_API_KEY) {
    console.warn(`WARNING: ${API_KEY_ENV} unset or forbidden — /api/juzhu/admin/* will return 401 until a non-default key is configured`);
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`mode JUZHU_ENV=${envName} API_KEY=${apiKey && apiKey !== FORBIDDEN_API_KEY ? 'configured' : 'missing/invalid'}`);
    console.log('auth: /api/juzhu/* default-deny API Key; C-end catalog/wechat-link/gr-orders public; vendor HMAC; admin session');
    console.log('static: blocked .env / source / deploy artifacts / API docs');
    // 启动时主动执行一次 ensureSchema（建表 + 家政种子数据），不等待
    ensureSchema().then(() => console.log('ensureSchema done')).catch(e => console.warn('ensureSchema warn:', e.message));
    // 缩略图后台扫描（补齐缺失 + 每小时增量，新上传自动生效）
    imgThumbs.initBackground();
  });
}
