const http = require('http');
const dns = require('dns');
const net = require('net');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
//这样 JUZHU_ENV=test 时就会自动读 根/.env.test 补变量（
const modeEnv = process.env.JUZHU_ENV || process.env.NODE_ENV;
if (modeEnv) loadDotEnv(path.join(ROOT, `.env.${modeEnv}`));
loadDotEnv();
loadDotEnv(path.join(ROOT, 'runtime.env'));

// 业务模块可能在加载期读取环境变量，必须统一放在运行时配置加载之后。
const bcrypt = require('bcryptjs'); // 规则14：仅 Node；vendor 登录口令散列
const authCenter = require('./auth_center.cjs'); // 账号与权限中心（阶段1，见 docs/account-and-auth-design.md）
const permRegistry = require('./perm_registry.cjs'); // 权限点注册表（admin 域路由闸与细粒度审计的唯一依据）
const idpOidc = require('./idp_oidc.cjs'); // OIDC Relying Party（阶段3 联邦登录）
const imgThumbs = require('./img_thumbs.cjs'); // 图片缩略图自维护（性能：列表/卡片提速）
const beikeAuth = require('./beike_auth.cjs'); // C 端 App：lianjia_token → ucid → accounts
const { payCenter } = require('./server/thirdApi/payCenter.cjs');
const { createPaymentService } = require('./payment_service.cjs');
const db = require('./server/db.cjs');
const { getDbConfig, getPool, queryRows, withDbRetry, getMysql } = db;
const mysql2 = getMysql();
const { jsonReply, createReadBody } = require('./server/http_util.cjs');
const { createBookingRouter } = require('./server/routes/booking.cjs');
const { createJiazhengRouter } = require('./server/routes/jiazheng.cjs');
const { createAdminRouter } = require('./server/routes/admin.cjs');
const { createApiDirectRouter } = require('./server/routes/api_direct.cjs');
const { createSchema } = require('./server/schema.cjs');
authCenter.init({
  query: (sql, params) => queryRows(sql, params),
  exec: (sql, params) => withDbRetry(async () => { const [r] = await getPool().execute(sql, params || []); return r; }),
  jsonReply,
  expectedApiKey,
  expectedAdminPassword,
  isProduction,
  // C 端 H5：Cookie lianjia_token → 验票 → accounts（不读 X-Lianjia-Token；其它端走 Bearer）
  resolveLianjiaToken: (lj, req) => {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    const referer = (process.env.SESSION_REFERER || '').trim() || ('http://' + host + '/');
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || '';
    return beikeAuth.resolveLianjiaPrincipal(lj, { queryRows, authCenter }, { referer, ip, ua });
  },
});

const PORT = process.env.PORT || 9000;

const ADMIN_PREFIX = '/api/juzhu/admin';
const API_KEY_ENV = 'JUZHU_API_KEY';
/** 历史开发默认值：任何环境均不得再当作有效密钥（文档泄露即等于未授权） */
const DEV_EXAMPLE_API_KEY = 'dev-juzhu-key';
const FORBIDDEN_API_KEY = DEV_EXAMPLE_API_KEY;
/** 非生产可用的后台登录默认口令（仅开发环境兜底） */
const DEV_DEFAULT_ADMIN_PASSWORD = 'dev-admin-default';

// MySQL：连接配置与连接池见 server/db.cjs
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
let resetVendorConfigCache = null;
try {
  const vendorConfig = require('./vendor_config.cjs');
  loadVendorConfigFromDb = vendorConfig.loadVendorConfigFromDb;
  resetVendorConfigCache = vendorConfig.resetVendorConfigCache;
} catch (_) {}
let juzhuImportAll = null;
try { juzhuImportAll = require('./juzhu_import.cjs').importAll; } catch (_) {}

const { ensureSchema } = createSchema({
  authCenter,
  channelBrand,
  housingSeedAll,
  housingBackfillPhotos,
  juzhuImportAll,
  jzSeedAll,
  staffSeedAll,
});
module.exports.ensureSchema = ensureSchema;

let vendorApi = null;
try { vendorApi = require('./vendor_api.cjs'); } catch (_) {}
let s3Client = null;
try { s3Client = require('./s3_client.cjs'); } catch (_) {}
let imgStorage = null;
try { imgStorage = require('./img_storage.cjs'); } catch (_) {}
// 商家 HMAC-SHA256 签名（平台 → 商家方向的 urllink / order_detail 用）
let hmacAuth = null;
try { hmacAuth = require('./hmac_auth.cjs'); } catch (_) {}

// 商家配置统一从 jz_vendors 表读取（懒加载缓存；对齐 Python jiazheng_api._load_vendor_config）
async function getVendorConfig() {
  if (!loadVendorConfigFromDb) throw new Error('vendor_config module missing');
  if (!mysql2) throw new Error('mysql2 module missing');
  return loadVendorConfigFromDb(() => mysql2.createConnection(getDbConfig()));
}

let paymentService = null;
function getPaymentService() {
  if (!paymentService) {
    paymentService = createPaymentService({
      createConnection: () => mysql2.createConnection({ ...getDbConfig(), timezone: 'Z' }),
      payCenter,
      jobHandlers: { booking_webhook: deliverPaymentWebhook },
    });
  }
  return paymentService;
}

function getPaymentCore() { return getPaymentService().core; }
let settlementRuntimePromise;
async function getSettlementRuntime() {
  if (!settlementRuntimePromise) settlementRuntimePromise = (async () => {
    await ensureSchema();
    const pool = mysql2.createPool({ ...getDbConfig(), timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 8 });
    try {
      const module = require('./server/settlement/index.cjs');
      await module.migrate(pool);
      const service = module.createSettlement({ pool, auth: authCenter, paymentCore: getPaymentCore(), payCenter, config: process.env });
      return { service, handler: require('./server/settlement/http.cjs').createHandler({ service, auth: authCenter }) };
    } catch (e) { await pool.end(); throw e; }
  })().catch(e => { settlementRuntimePromise = null; throw e; });
  return settlementRuntimePromise;
}
function getBookingPaymentAdapter() { return getPaymentService().bookingAdapter; }
let jiazhengPaymentAdapter;
function getJiazhengAdapter() {
  if (!jiazhengPaymentAdapter) jiazhengPaymentAdapter = require('./server/payment/jiazheng-adapter.cjs').createJiazhengAdapter({
    createConnection: () => mysql2.createConnection({ ...getDbConfig(), timezone: 'Z' }), paymentCore: getPaymentCore(), config: process.env,
  });
  return jiazhengPaymentAdapter;
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
  if (parts[0] === 'node_modules' || parts[0] === 'scripts' || parts[0] === '.git' || parts[0] === 'commerce') return false;
  // React C 端源码/依赖不走通用静态根；成品由 serveH5Spa 从 h5/dist 挂 /h5/*
  if (parts[0] === 'h5' && (parts[1] === 'src' || parts[1] === 'node_modules' || parts[1] === 'public')) return false;
  return true;
}

/** C 端 React SPA：/h5 → h5/dist，未知路径回落 index.html（不删 lvju-app-*.html） */
function serveH5Spa(rawPath, res) {
  const dist = path.join(ROOT, 'h5', 'dist');
  const relRaw = String(rawPath || '').replace(/^\/h5\/?/, '') || 'index.html';
  const rel = path.posix.normalize('/' + relRaw).replace(/^\/+/, '') || 'index.html';
  if (rel.split('/').some((p) => p === '..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const candidate = path.resolve(dist, rel);
  if (candidate !== dist && !candidate.startsWith(dist + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const sendFile = (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Internal Server Error');
        return;
      }
      const headers = { 'Content-Type': contentType };
      if (ext === '.html') headers['Cache-Control'] = 'no-cache';
      else if (ext === '.js' || ext === '.css' || ext === '.woff2' || ext === '.webp' || ext === '.png' || ext === '.jpg' || ext === '.svg') {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  };
  fs.stat(candidate, (err, st) => {
    if (!err && st.isFile()) {
      sendFile(candidate);
      return;
    }
    const indexPath = path.join(dist, 'index.html');
    fs.stat(indexPath, (err2, st2) => {
      if (err2 || !st2.isFile()) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('H5 not built. Run: npm run h5:build');
        return;
      }
      sendFile(indexPath);
    });
  });
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

/** 账号主体 → 业务会话形态（platform / vendor / user）。入口闸已挂 req.principal 时可复用，避免再打 principalOf。 */
function sessionFromPrincipal(principal) {
  if (!principal || principal.type !== 'account') return null;
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
  // 有机构绑定的管理读账号（gov/bank/holding 等）此前有一段死代码「升格 platform」，已不可达；
  // 写权限仍由 requirePerm 收紧，读侧按 user 不放大数据面。
  return { role: 'user', account: principal.account, roles: principal.roles, principal };
}

// 统一会话：vendor token 最先判定（token 自证，纯函数无共享状态，杜绝被误判为 platform），
// 其次账号中心主体，再次 admin 会话/全局 Key（过渡）
async function requestSession(req) {
  const vtok = verifyVendorLoginToken(extractBearerToken(req));
  if (vtok) return vtok;
  // 入口闸（requireApiKey / requirePerm 等）已解析过则复用，少一次远程 sessions+账号查询
  if (req && req.principal && req.principal.type === 'account') {
    return sessionFromPrincipal(req.principal);
  }
  try {
    const principal = await authCenter.principalOf(req);
    const sess = sessionFromPrincipal(principal);
    if (sess) {
      if (req) req.principal = principal; // 后续同请求可再复用
      return sess;
    }
  } catch (_) { /* 账号库暂不可用时退回旧通道 */ }
  // 兜底仅限旧式 admin token（账号中心之前的会话）。
  // 不能用 isAdminSessionAuthorized：它接受一切合法账号会话，会把 gov_viewer 等
  // 非平台账号在这里升格成 platform（越权看全量）——账号主体已在上方按角色判定。
  if (verifyAdminLoginToken(extractBearerToken(req))) return { role: 'platform' };
  return null;
}

// 评级口径（维度键 + 评级编号前缀）单一数据源：rating_config.cjs
// （B 端自评 / 平台复核与商家开放提审 vendor_api.cjs 共用同一份）
const ratingCfg = require('./rating_config.cjs');
const RATING_DIMS = ratingCfg.RATING_DIMS;
const RATING_CODE_PREFIX = ratingCfg.RATING_CODE_PREFIX;

// C 端涉写三路径（下单/支付/评价）——旧全局 key 的最后一处过渡放行，
// 收紧由 settings.require_c_login 开关控制（requireCEndWrite）
const C_WRITE_PATH_RE = /^\/api\/juzhu\/jiazheng\/(orders(\/[^/]+\/(pay|rate))?|repairs)$/;
// 报修单（repairs）的 phone 限定读 / 取消：legacy key 演示通道同时放行 GET/DELETE（仍是凭据通道，匿名照旧 401）
const C_REPAIRS_READ_RE = /^\/api\/juzhu\/jiazheng\/repairs(\/[^/]+)?$/;

async function requireApiKey(req, res, urlPath) {
  // 通道1（唯一）：账号中心（Bearer 会话 或 机器账号 API Key）。
  // 旧全局 JUZHU_API_KEY 已全面停用——管理面一律拒绝；仅 C 端涉写路径 + 报修 phone 限定读过渡期保留。
  const principal = await authCenter.principalOf(req).catch(() => null);
  if (principal && principal.type === 'account') {
    req.principal = principal;
    return true;
  }
  const provided = providedApiKey(req);
  const p = (provided && urlPath) ? urlPath.replace(/\/+$/, '') : '';
  const legacyOk = !!p && (
    (req.method === 'POST' && C_WRITE_PATH_RE.test(p)) ||
    ((req.method === 'GET' || req.method === 'DELETE') && C_REPAIRS_READ_RE.test(p))
  );
  if (legacyOk && apiKeyMatches(provided, expectedApiKey())) {
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

// The main order centre reserves this namespace for server-verified account sessions.
// A caller-supplied user_id can never select somebody else's commerce orders.
async function grUserQuery(req,qp){
  const raw=String(qp.get('user_id')||'');
  if(qp.get('source')==='account'||raw.startsWith('commerce-account-')){
    const session=await requestSession(req);
    if(!session?.account||session.account.status!=='active'||session.account.principal_type!=='user')return {ok:false,status:401,error:'请使用新居住账号登录'};
    const userId=require('./commerce/main-system.cjs').accountUser(session.account.id);
    if(raw&&raw!==userId)return {ok:false,status:403,error:'不能查看其他账号的订单'};
    const userIds = [userId];
    if (session.account.idp_type === 'beike' && session.account.idp_subject) userIds.push(String(session.account.idp_subject));
    return {ok:true,userId,userIds};
  }
  return grOrders.validateUserIdQuery(raw);
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

const VENDOR_SECRET_FIELDS = ['hmac_key', 'url_link', 'order_detail_url', 'pay_merchant_no', 'payment_config_json'];

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
  if (m === 'POST' && process.env.PAY_NOTIFY_TOKEN
    && p === `/api/juzhu/payment/notify/${process.env.PAY_NOTIFY_TOKEN}`) return true;
  if (m === 'POST' && p === '/api/juzhu/payment/query') return true;
  if (m === 'POST' && (p === '/api/juzhu/auth/tenant' || p === '/api/juzhu/auth/beike')) return true;
  if (m === 'GET' && p === '/api/juzhu/auth/beike-config') return true;
  if (m === 'POST' && p === '/api/juzhu/jiazheng/wechat-link') return true;
  // 商家入驻申请（公开提交：申请人尚无任何凭据；受理/核验走 admin 域会话 + 权限点）
  if (m === 'POST' && p === '/api/juzhu/onboarding/apply') return true;
  if (m === 'GET' && p === '/api/juzhu/onboarding/status') return true;
  // 图片代理读取（对象存储/本地统一出口，公网可读，无 PII）
  if (m === 'GET' && (p === '/api/juzhu/img' || p === '/api/juzhu/image')) return true;
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
    '/api/juzhu/routes',
    '/api/juzhu/spots',
    '/api/juzhu/topics',
  ]);
  if (exact.has(p)) return true;
  if (/^\/api\/juzhu\/districts\/\d+$/.test(p)) return true;
  if (/^\/api\/juzhu\/projects\/\d+$/.test(p)) return true;
  if (/^\/api\/juzhu\/spots\/\d+$/.test(p)) return true;
  if (/^\/api\/juzhu\/routes\/\d+$/.test(p)) return true;
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

function isPaymentCustomerApi(p, method) {
  const m = String(method || 'GET').toUpperCase();
  return (m === 'POST' && (p === '/api/juzhu/jiazheng/orders' || p === '/api/juzhu/jz/orders' || /^\/api\/juzhu\/jiazheng\/orders\/[^/]+\/(pay|payment|cancel)$/.test(p)))
    || (m === 'GET' && (p === '/api/juzhu/jiazheng/orders' || /^\/api\/juzhu\/jiazheng\/orders\/(?!stats$)[^/]+$/.test(p) || /^\/api\/juzhu\/jiazheng\/orders\/[^/]+\/payment$/.test(p)))
    || (m === 'GET' && /^\/api\/juzhu\/jz\/orders\/(?!(?:overview|stats)$)[^/]+$/.test(p))
    || (['GET', 'POST'].includes(m) && p === '/api/juzhu/booking/contacts')
    || (m === 'DELETE' && /^\/api\/juzhu\/booking\/contacts\/\d+$/.test(p))
    || (m === 'GET' && p === '/api/juzhu/booking/my');
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
  if (isPaymentCustomerApi(p, req.method)) {
    const session = await requestSession(req);
    if (session?.account?.status === 'active') return true;
    // Management reads retain their existing role/permission gate.
    if (req.method === 'GET') return requireApiKey(req, res, urlPath);
    jsonReply(res, { error: 'unauthorized', message: '请先登录本人账号' }, 401);
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
const photoCfg = require('./photo_config.cjs');
const roomProfileCfg = require('./room_profile.cjs');
const vendorRate = require('./vendor_rate.cjs'); // 商家佣金费率（按业务线分档）单一数据源：vendor_rate.cjs
const INSURANCE_TYPES = stayCfg.INSURANCE_TYPES;
const INSURANCE_KEYS = stayCfg.INSURANCE_KEYS;
const STAY_MIN_NIGHTS_DEFAULT = stayCfg.STAY_MIN_NIGHTS_DEFAULT;
const STAY_STATUS = stayCfg.STAY_STATUS;
const parseExtObj = stayCfg.parseExtObj;
const insuranceOf = stayCfg.insuranceOf;
const minStayNightsOf = stayCfg.minStayNightsOf;
const transactionCapabilitiesOf = stayCfg.transactionCapabilitiesOf;
const bookableOf = stayCfg.bookableOf;
const unitNightPrice = stayCfg.unitNightPrice;
const wholeHousePriceUnit = stayCfg.wholeHousePriceUnit;   // 整栋单价格基准（2026-09：起价缺失回落首个户型）
const stayNightPrices = stayCfg.stayNightPrices;
const stayConfigOf = stayCfg.stayConfigOf;
const cancelPolicyOf = stayCfg.cancelPolicyOf;
const cancelPolicyTextOf = stayCfg.cancelPolicyTextOf;

/** 管理端项目 ext 写入兜底：校验最短连住，并归一化房源交易能力。 */
function normalizeProjectExtInput(value, channel) {
  if (value == null) return ['rental', 'minsu'].includes(channel)
    ? stayCfg.applyTransactionCapabilities({}, {}, channel)
    : null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('ext 须为对象');
  const ext = Object.assign({}, value);
  if (Object.prototype.hasOwnProperty.call(ext, 'min_stay_nights')) {
    if (ext.min_stay_nights === null || ext.min_stay_nights === '') delete ext.min_stay_nights;
    else ext.min_stay_nights = stayCfg.normalizeMinStayNightsInput(ext.min_stay_nights, channel);
  }
  if (Object.prototype.hasOwnProperty.call(ext, 'default_closed')) {
    if (ext.default_closed === null || ext.default_closed === '') delete ext.default_closed;
    else if (stayCfg.normalizeDefaultClosedInput(ext.default_closed)) ext.default_closed = true; else delete ext.default_closed;
  }
  return stayCfg.applyTransactionCapabilities(ext, ext, channel);
}
const withCancelPolicy = stayCfg.withCancelPolicy;
const withStayRules = stayCfg.withStayRules;   // unit 级生效住宿规则（最短连住 + 取消政策，2026-09）
const orderCancelInfoOf = stayCfg.orderCancelInfoOf;
const normalizeCancelPolicyInput = stayCfg.normalizeCancelPolicyInput;
const stayDateList = stayCfg.stayDateList;
const releaseStayQty = stayCfg.releaseStayQty;   // 多间库存释放（2026-09-10）：递减 booked_qty + 纯占用行清理
/** conn.execute 适配 releaseStayQty 的 execute(sql, params) → ResultSetHeader 形参 */
function connExec(conn) {
  return async (sql, params) => (await conn.execute(sql, params))[0];
}
/** 住宿规则取数（取消政策 / 最短连住共用）：有 unit 用该房型；整栋单（unit_id 空）按项目首个房型
 *  （sort_order 最小）执行，无房型从严（2026-09：最短连住沿用同一回退，两条规则同源同口径）。
 *  fetchRows(sql, params) → rows，由调用方注入（conn 事务内 / queryRows 连接池）。 */
async function fallbackUnitRowFor(fetchRows, unitId, projectId) {
  // 取价所需列（ext.price_night / rent_monthly）一并带出：整栋单的默认夜价也按首个户型算
  const cols = 'id, ext, rent_monthly';
  if (unitId) {
    const rows = await fetchRows(`SELECT ${cols} FROM units WHERE id=? AND project_id=?`, [unitId, projectId]);
    return rows[0] || null;
  }
  const rows = await fetchRows(`SELECT ${cols} FROM units WHERE project_id=? ORDER BY sort_order, id LIMIT 1`, [projectId]);
  return rows[0] || null;
}
const MIN_PUBLISH_PHOTOS = photoCfg.PHOTO_MIN_PUBLISH;   // 单一数据源 photo_config.cjs（改阈值只改那一处）

function parseExtSafe(value) {
  if (value == null || value === '') return {};
  if (typeof value === 'object') return value;
  try { const v = JSON.parse(value); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}

async function projectPublishEligibility(conn, projectId, vendorId) {
  const [rows] = await conn.execute(
    `SELECT p.*, v.status AS vendor_status, v.review_status AS vendor_review_status
       FROM projects p LEFT JOIN jz_vendors v ON v.id=p.owner_vendor_id WHERE p.id=?`, [projectId]);
  if (!rows.length) return { ok: false, error: '房源不存在', status: 404 };
  const p = rows[0];
  if (vendorId != null && Number(p.owner_vendor_id) !== Number(vendorId)) return { ok: false, error: '无权操作该房源', status: 403 };
  if (!p.owner_vendor_id || p.vendor_status !== 'active' || (p.vendor_review_status && p.vendor_review_status !== 'approved')) {
    return { ok: false, error: '商家尚未通过审核或已停用', status: 400 };
  }
  if (p.rating_status !== 'passed') return { ok: false, error: '房源审核/评级未通过，不能上架', status: 400 };
  // 价格闸（2026-09）：price_from 改为选填——改成逐个户型校验「默认夜价 > 0」
  // （户型 price_night > 月租/30 > 房源起价/30，见 stay_config.unitNightPrice）。
  // 传了起价的房源全部户型自动继承，行为与旧闸一致；不传起价则每个户型须自带价。
  const [units] = await conn.execute(
    'SELECT id, name, rent_monthly, ext FROM units WHERE project_id=? ORDER BY sort_order, id', [p.id]);
  if (!units.length) return { ok: false, error: '上架前须至少创建 1 个户型（units/create）', status: 400 };
  const unpriced = units.filter((u) => !(unitNightPrice(p, u) > 0));
  if (unpriced.length) {
    return { ok: false, status: 400, error: '上架前须设置价格：'
      + unpriced.map((u) => u.name || ('#' + u.id)).join('、')
      + ' 缺夜价（price_night）或月租（rent_monthly），且房源未设置 price_from' };
  }
  const [ph] = await conn.execute(
    `SELECT COUNT(*) AS c, MAX(is_cover) AS has_cover FROM photos
       WHERE (entity_type='project' AND entity_id=?)
          OR (entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id=?))`, [p.id, p.id]);
  if (!ph[0] || Number(ph[0].c) < MIN_PUBLISH_PHOTOS) {
    return { ok: false, error: `上架前须至少上传 ${MIN_PUBLISH_PHOTOS} 张房源照片`, status: 400 };
  }
  // cover_image 脏值（空 / '-' / 'todo'）不算封面（口径与 img_storage.isValidImageRef 一致）
  const coverOk = (imgStorage && typeof imgStorage.isValidImageRef === 'function')
    ? imgStorage.isValidImageRef(p.cover_image)
    : !!p.cover_image;
  if (!coverOk && !Number(ph[0].has_cover || 0)) return { ok: false, error: '上架前须设置房源封面图', status: 400 };
  // 图集抽检（2026-09）：真拉取前 N 张核对大小/分辨率——封面优先。
  // 确定性不合格阻断上架；仅网络不可达记 warning 放行（CDN 抖动不该卡住上架）
  const [spot] = await conn.execute(
    `SELECT file_path FROM photos
      WHERE (entity_type='project' AND entity_id=?)
         OR (entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id=?))
      ORDER BY is_cover DESC, entity_type, entity_id, sort_order, id LIMIT ${photoCfg.PHOTO_SPOT_CHECK}`,
    [p.id, p.id]);
  const check = await photoCfg.spotCheck(spot.map((r) => r.file_path));
  if (check.error) return { ok: false, error: check.error, status: 400 };
  return { ok: true, project: p, ext: parseExtSafe(p.ext), warnings: check.warnings };
}

function bookingPaymentExpired(row) {
  return row && row.status === 'pending' && row.pay_status === 'unpaid' && row.payment_expires_at
    && new Date(row.payment_expires_at.replace(' ', 'T') + 'Z').getTime() <= Date.now();
}

// Historical caller compatibility: expiry requests durable closure and never releases stock here.
async function expireBooking(conn, row) {
  if (!row || row.pay_status == null || !row.payment_expires_at || !require('./server/payment/primitives.cjs').expired(row.payment_expires_at)) return false;
  const guard = await getBookingPaymentAdapter().prepare(conn, row);
  if (guard.paid_payment_id) return false;
  await getPaymentCore().requestClose({ bizType: 'booking', orderId: row.order_no, reason: 'booking_expired' }, conn);
  return true;
}

let paymentMaintenanceRunning = false;
let lastPaymentExpiryScan = 0;
async function runUnifiedPaymentMaintenance() {
  if (paymentMaintenanceRunning) return;
  paymentMaintenanceRunning = true;
  try {
    await ensureSchema();
    const core = getPaymentCore(), booking = getBookingPaymentAdapter(), life = getJiazhengAdapter();
    await core.runJobs(50);
    await core.consumeEvents('booking', booking.handleEvent, 50);
    await core.consumeEvents('jiazheng', life.handleEvent, 50);
    if (process.env.SETTLEMENT_WORKER_ENABLED === '1' || process.env.SETTLEMENT_REPORTS_ENABLED === '1') {
      const result = await (await getSettlementRuntime()).service.maintenance();
      for (const error of result?.errors || []) console.warn('settlement maintenance:', error.operation, error.code);
    }
    if (Date.now() - lastPaymentExpiryScan >= 30000) {
      lastPaymentExpiryScan = Date.now();
      for (const [label, scan] of [['legacy recovery', () => booking.recoverLegacy(100)], ['booking expiry', () => booking.expire(100)], ['life expiry', () => life.expire(100)]]) {
        try {
          const result = await scan();
          for (const error of result?.errors || []) console.warn(label + ':', error.orderNo, error.code);
        } catch (error) { console.warn(label + ':', error.code || error.name); }
      }
    }
  } finally { paymentMaintenanceRunning = false; }
}

// ===== 商家 Webhook 推送（平台 → 商家，HMAC 签名与开放接口同算法）=====
// 普通事件 booking.created / booking.cancelled 使用有限重试；booking.paid 由持久任务投递。
// 以下普通事件只通知不担保必达：
// 重试 3 次（5s/30s/120s）仍失败即放弃，商家以 bookings/list 拉取对账兜底。
const WEBHOOK_RETRY_DELAYS = [5000, 30000, 120000];

/** 受防护的出网 POST（2026-09-22）：DNS 解析即校验（photo_config.ipIsBlocked 拦内网/环回/云元数据地址），
 *  不跟随重定向、响应限 64KB、限时。webhook 投递与连通性测试统一走这里
 *（规则 16：新增出网能力必须走这一层——webhook_url 开放商家自助配置后，投递侧是唯一拦截点）。 */
function guardedPostJson(rawUrl, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(rawUrl); } catch (_) { return resolve({ ok: false, error: 'URL 非法' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve({ ok: false, error: '仅支持 http/https' });
    // IP 字面量主机 Node 会跳过 lookup 钩子直连（实测调用次数为 0），入口先行拦截（IPv6 去方括号后判）
    const ipLiteral = u.hostname.replace(/^\[|\]$/g, '');
    if (process.env.WEBHOOK_PRIVATE_ALLOW !== '1' && net.isIP(ipLiteral) && photoCfg.ipIsBlocked(ipLiteral)) {
      return resolve({ ok: false, error: '目标地址为内网/环回/保留 IP，已拒绝' });
    }
    const data = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let req;
    try {
      req = (u.protocol === 'https:' ? https : http).request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: timeoutMs || 5000,
        // DNS 解析即校验：命中的地址在建连前拦掉，避免解析后重绑定（与 photo_config 探测同口径）
        // WEBHOOK_PRIVATE_ALLOW=1 仅供回归/联调实例放行内网目标（回归脚本用 127.0.0.1 收事件）；生产一律不开
        lookup: (hostname, options, cb) => {
          if (process.env.WEBHOOK_PRIVATE_ALLOW === '1') return dns.lookup(hostname, options, cb);
          dns.lookup(hostname, { all: true }, (err, addrs) => {
            if (err) return cb(err);
            const list = Array.isArray(addrs) ? addrs : [addrs];
            const bad = list.find((a) => photoCfg.ipIsBlocked(a.address));
            if (bad) return cb(new Error('目标地址解析到内网/环回/元数据地址，已拒绝'));
            const first = list[0];
            if (options && options.all) return cb(null, list);
            cb(null, first.address, first.family);
          });
        },
      }, (res) => {
        let n = 0;
        res.on('data', (c) => {
          n += c.length;
          if (n > 65536) { req.destroy(); done({ ok: false, status: res.statusCode, error: '响应超过 64KB' }); }
        });
        res.on('end', () => done({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
        res.on('error', () => done({ ok: false, error: '响应读取失败' }));
      });
    } catch (e) { return done({ ok: false, error: String(e.message || e) }); }
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: '连接/响应超时' }); });
    req.on('error', (e) => done({ ok: false, error: String(e.message || e) }));
    req.end(data);
  });
}

function webhookSign(secretKey, payload, timestamp) {
  const hmacAuth = require('./hmac_auth.cjs');
  const flat = hmacAuth.flattenAndFilter(payload);
  flat.timestamp = String(timestamp);
  return require('crypto').createHmac('sha256', secretKey)
    .update(hmacAuth.buildStringToSign(flat), 'utf8').digest('hex');
}

async function deliverWebhook(vendor, event, data, attempt) {
  const n = attempt || 0;
  const out = await guardedPostJson(vendor.webhook_url, data, 5000);   // 出网统一走 SSRF 防护层
  if (out.ok) {
    console.log('[webhook] delivered', event, 'vendor#' + data.vendor_id, 'attempt', n + 1);
    return;
  }
  console.warn('[webhook] attempt', n + 1, 'failed:', out.error || out.status);
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

// Payment fulfillment enqueues this delivery in the same transaction as the order update.
// A process restart cannot lose the delivery; the receiver deduplicates by event + payment_id.
async function deliverPaymentWebhook(job) {
  const { vendorId, event, order } = job.payload;
  const rows = await queryRows('SELECT hmac_key,webhook_url FROM jz_vendors WHERE id=?', [vendorId]);
  const vendor = rows[0];
  if (!vendor || !vendor.hmac_key || !vendor.webhook_url) return;
  const timestamp = Date.now();
  const payload = { event, vendor_id: vendorId, order };
  const result = await guardedPostJson(vendor.webhook_url, { ...payload, timestamp, sign: webhookSign(vendor.hmac_key, payload, timestamp) }, 5000);
  if (!result.ok) throw new Error('booking webhook delivery failed');
}

async function runVendorWebhookTest(vendorId) {
  const conn = await mysql2.createConnection(getDbConfig());
  let v = null;
  try {
    const [rows] = await conn.execute('SELECT webhook_url, hmac_key FROM jz_vendors WHERE id=? LIMIT 1', [vendorId]);
    v = rows[0] || null;
  } finally { await conn.end(); }
  if (!v || !v.webhook_url) return { ok: false, badRequest: true, error: '请先保存 webhook_url' };
  if (!v.hmac_key) return { ok: false, badRequest: true, error: '商家未配置 hmac_key，无法签名' };
  const ts = Date.now();
  const data = { note: '连通性测试', at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
  const payload = { event: 'webhook.test', vendor_id: vendorId, data };
  const out = await guardedPostJson(v.webhook_url, {
    event: payload.event, vendor_id: vendorId, data, timestamp: ts, sign: webhookSign(v.hmac_key, payload, ts),
  }, 5000);
  return out.ok ? { ok: true, status: out.status }
                : { ok: false, error: out.error || ('HTTP ' + out.status), status: out.status || null };
}

/** 下发商家 webhook（通用事件，2026-09-22 商家诉求 3.2）：签名体 = {event, vendor_id, data}，
 *  同开放接口算法；当前用于 rating.reviewed（评级复核结果）。未配 webhook_url = 不推送。 */
function notifyVendorEvent(vendorId, event, data) {
  (async () => {
    const conn = await mysql2.createConnection(getDbConfig());
    let v = null;
    try {
      const [rows] = await conn.execute('SELECT id, hmac_key, webhook_url FROM jz_vendors WHERE id=?', [vendorId]);
      v = rows[0] || null;
    } finally { await conn.end(); }
    if (!v || !v.webhook_url || !v.hmac_key) return;
    const ts = Date.now();
    const payload = { event, vendor_id: vendorId, data };
    const body = {
      event,
      vendor_id: vendorId,
      data,
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
module.exports.isPaymentCustomerApi = isPaymentCustomerApi;
module.exports.grUserQuery = grUserQuery;
module.exports.isVendorHmacPath = isVendorHmacPath;
module.exports.stripVendorSecrets = stripVendorSecrets;
module.exports.verifyAdminLoginToken = verifyAdminLoginToken;
module.exports.FORBIDDEN_API_KEY = FORBIDDEN_API_KEY;
module.exports.DEV_EXAMPLE_API_KEY = DEV_EXAMPLE_API_KEY;
module.exports.getDbConfig = getDbConfig;
module.exports.validateRealPhone = validateRealPhone;
module.exports.contactPhoneFromBody = contactPhoneFromBody;
module.exports.stripContactPhone = stripContactPhone;

// multipart 解析与 scope 归属（供回归脚本离线单测，见 scripts/admin_upload_multipart_regression.cjs）
module.exports.__multipart = {
  parseMultipart: (...a) => parseMultipart(...a),
  multipartFields: (...a) => multipartFields(...a),
  partDisposition: (...a) => partDisposition(...a),
  parsePartHeaders: (...a) => parsePartHeaders(...a),
  scopeEntity: (...a) => scopeEntity(...a),
};

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
// 专题（topic_*）上下架/删除后立即失效 topic 缓存，不让 C 端在 TTL 窗口内看到已下架专题
function catalogMemoInvalidateTopics() {
  for (const key of Array.from(catalogMemo.keys())) {
    if (key.includes('|t=')) catalogMemo.delete(key);
  }
}
function catalogMemoInvalidateAll() {
  catalogMemo.clear();
}
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


function outboundJson(method, urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { reject(e); return; }
    // 出站请求日志：对齐入站分段格式，类别 [平台→商家]，共用编号便于链路追踪
    const seq = ++reqSeq;
    const started = Date.now();
    if (logDetailOn()) {
      const lines = [LOG_SEP, `#${seq} ${logTs()} [平台→商家] ${method} ${urlStr}`];
      if (body != null) {
        const text = JSON.stringify(body);
        const shown = text.length > LOG_BODY_LIMIT ? `${text.slice(0, LOG_BODY_LIMIT)}…[截断，共 ${text.length} 字符]` : text;
        lines.push(`  >> 参数(body): ${shown.replace(/\n/g, '\n  | ')}`);
      }
      console.log(lines.join('\n'));
    } else {
      console.log(`${logTs()} [平台→商家] ${method} ${urlStr}`);
    }
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
        if (logDetailOn()) {
          const size = Buffer.byteLength(text);
          const shown = text.length > LOG_BODY_LIMIT ? `${text.slice(0, LOG_BODY_LIMIT)}…[截断，共 ${size} 字节]` : text;
          console.log(`  << 状态: ${res.statusCode} · ${size}B · ${Date.now() - started}ms\n  << 返回: ${shown.replace(/\n/g, '\n  | ')}`);
        }
        try { resolve({ status: res.statusCode, json: JSON.parse(text), text }); }
        catch (_) { resolve({ status: res.statusCode, json: null, text }); }
      });
    });
    req.setTimeout(timeoutMs || 10000, () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => {
      // 出站失败/超时也留痕：入站侧只能看到 502，原因链在这里
      if (logDetailOn()) console.log(`  << 状态: 出站失败 · ${Date.now() - started}ms · ${e.message}`);
      reject(e);
    });
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

/** jz_skus JSON 字段。列名永远是 includes（与 tags/badges/gallery 同口径）。
 *  链家库曾热修为 includes_json：启动时 rename，读路径这里再兜一层别名。 */
const SKU_JSON_FIELDS = ['tags', 'badges', 'gallery', 'includes', 'service_flow', 'service_notice'];
function parseSkuJsonFields(row, extraFields) {
  if (row && row.includes == null && row.includes_json != null) row.includes = row.includes_json;
  return parseJsonFields(row, extraFields ? SKU_JSON_FIELDS.concat(extraFields) : SKU_JSON_FIELDS);
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
  // 商家配置了品牌简介（jz_vendors.intro）就整段用它 —— 「商家介绍」按原型说明 D05 展示
  // Logo + 品牌名 + 副标题 + 完整简介；此时不再拼自动统计（起订价对搬家等业态无意义，
  // 且 start_price 未配时会渲染成「¥0/起」）。未配简介的存量商家回落旧拼接，避免整块空白。
  if (vendor.intro && String(vendor.intro).trim()) {
    intro.summary = String(vendor.intro).trim();
    return intro;
  }
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
module.exports.normalizeUnitRoomProfileInput = normalizeUnitRoomProfileInput;
module.exports.normalizeUnitExtInput = normalizeUnitExtInput;

// readBody 依赖下方 reqLogBody（函数声明提升）；JSON 响应用 server/http_util.cjs
const readBody = createReadBody(function (data) { reqLogBody(data); });

// ===== multipart/form-data 解析（图片上传用）=====
// 注意：readBody 是 utf8 拼串，**绝不能**用于二进制（会毁图片字节），上传必须走 readRawBody。
const MULTIPART_MAX_BYTES = 16 * 1024 * 1024;   // 单请求硬上限（12MB 图 + 表单开销）
const MULTIPART_MAX_PARTS = 32;

/** 读取原始请求体（二进制安全，带硬上限） */
function readRawBody(req, maxBytes) {
  const limit = maxBytes || MULTIPART_MAX_BYTES;
  return new Promise((resolve, reject) => {
    if (req._rawBuffer !== undefined) {
      return req._rawBuffer.length > limit ? reject(new Error('请求体过大')) : resolve(req._rawBuffer);
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new Error(`请求体超过上限 ${(limit / 1048576).toFixed(0)}MB`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      req._rawBuffer = Buffer.concat(chunks);
      resolve(req._rawBuffer);
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function parsePartHeaders(raw) {
  const out = {};
  String(raw || '').split(/\r\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i <= 0) return;
    const k = line.slice(0, i).trim().toLowerCase();
    if (k) out[k] = line.slice(i + 1).trim();
  });
  return out;
}

function partDisposition(cd) {
  const s = String(cd || '');
  return {
    name: String((/name="([^"]*)"/i.exec(s) || /name=([^;]+)/i.exec(s) || [])[1] || '').trim(),
    filename: String((/filename="([^"]*)"/i.exec(s) || [])[1] || '').trim(),
    hasFilename: /filename\*?=/i.test(s),
  };
}

/**
 * 极简 multipart 解析（无依赖）。
 * 关键：后续分隔符必须匹配 `\r\n--<boundary>`（带前导 CRLF）——否则图片字节里偶然出现的
 *       `--<boundary>` 会被误切；且全部按 Buffer 处理，禁止先转 utf8 字符串再切。
 */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  const boundary = String((m && (m[1] || m[2])) || '').trim();
  if (!boundary) return { error: '缺少 multipart boundary' };
  const first = Buffer.from('--' + boundary);
  const delim = Buffer.from('\r\n--' + boundary);
  let pos = buf.indexOf(first);
  if (pos < 0) return { error: 'multipart 结构非法（缺少起始边界）' };
  pos += first.length;
  const parts = [];
  for (;;) {
    const headerEnd = buf.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) return { error: 'multipart 分段头未结束' };
    const headers = parsePartHeaders(buf.slice(pos, headerEnd).toString('utf8'));
    const next = buf.indexOf(delim, headerEnd);
    if (next < 0) return { error: 'multipart 结构非法（缺少结束边界）' };
    parts.push({ headers, body: buf.slice(headerEnd + 4, next) });
    if (parts.length > MULTIPART_MAX_PARTS) return { error: 'multipart 分段数超限' };
    pos = next + delim.length;
    if (buf.slice(pos, pos + 2).toString('utf8') === '--') break;   // 结束边界
    if (buf.slice(pos, pos + 2).toString('utf8') === '\r\n') pos += 2;
  }
  return { parts };
}

function multipartFields(parts) {
  const fields = {};
  const files = [];
  for (const p of parts || []) {
    const d = partDisposition(p.headers['content-disposition']);
    if (!d.name) continue;
    if (d.filename || d.hasFilename) {
      files.push({ field: d.name, filename: d.filename, contentType: p.headers['content-type'] || '', buffer: p.body });
    } else if (fields[d.name] === undefined) {
      fields[d.name] = p.body.toString('utf8').trim();
    }
  }
  return { fields, files };
}

/** 读取并解析 multipart 上传请求 → { ok, fields, files } | { ok:false, error, status } */
async function readImageMultipart(req, opts) {
  const o = opts || {};
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('multipart/form-data')) return { ok: false, error: '需要 multipart/form-data 上传', status: 415 };
  let buf;
  try {
    buf = await readRawBody(req, o.maxBytes || MULTIPART_MAX_BYTES);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), status: 413 };
  }
  const parsed = parseMultipart(buf, ct);
  if (parsed.error) return { ok: false, error: parsed.error, status: 400 };
  const out = multipartFields(parsed.parts);
  return { ok: true, fields: out.fields, files: out.files };
}

/**
 * scope → 归属实体（对齐 juzhu/server.py:2424-2497 的 7 种 scope）
 * @returns {{entityType:string, entityId:number, needDb:boolean, photoId?:number}|null}
 */
function scopeEntity(scope, fields) {
  const f = fields || {};
  switch (String(scope || '')) {
    case 'project_cover': return { entityType: 'project', entityId: parseInt(f.project_id, 10) || 0, needDb: true };
    case 'project_cover_new': return { entityType: 'project_draft', entityId: 0, needDb: false };
    case 'unit_cover':
    case 'unit_gallery':
    case 'unit_keeper': return { entityType: 'unit', entityId: parseInt(f.unit_id, 10) || 0, needDb: true };
    case 'unit_photo': return { entityType: 'unit', entityId: 0, needDb: true, photoId: parseInt(f.photo_id, 10) || 0 };
    case 'city_hero': return { entityType: 'city', entityId: 0, needDb: false };
    default: return null;
  }
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

// 房间档案（Excel 房源字段）的字段清单/长度/枚举/中文名统一在 room_profile.cjs（单一数据源）；
// 管理端校验与商家开放接口（vendor_api units/create|update）共用同一份。
// 保持函数声明（不能改成 const 别名）：本文件上方有提前的 `module.exports.X = X`，
// 换成 const 会因 TDZ 在启动时报「Cannot access before initialization」。
function normalizeUnitRoomProfileInput(value) {
  return roomProfileCfg.normalizeRoomProfileInput(value);
}

function normalizeUnitExtInput(value, channel) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('ext 须为对象');
  const ext = Object.assign({}, value);
  if ('room_profile' in ext) {
    const profile = normalizeUnitRoomProfileInput(ext.room_profile);
    if (profile && Object.keys(profile).length) ext.room_profile = profile;
    else delete ext.room_profile;
  }
  // 最短连住（2026-09 下放户型）：按频道单一口径校验（rental 1-365 / minsu 15-365），
  // 传 channel 才用得上频道下限，缺省按 1-365 兜底；null/'' = 清除（回落房源级）
  if ('min_stay_nights' in ext) {
    if (ext.min_stay_nights === null || ext.min_stay_nights === '') delete ext.min_stay_nights;
    else ext.min_stay_nights = stayCfg.normalizeMinStayNightsInput(ext.min_stay_nights, channel);
  }
  // 默认关房（2026-09 方案 B 配套）：true = 未推送放出的日期默认不可订；null/'' = 清除
  if ('default_closed' in ext) {
    if (ext.default_closed === null || ext.default_closed === '') delete ext.default_closed;
    else if (stayCfg.normalizeDefaultClosedInput(ext.default_closed)) ext.default_closed = true; else delete ext.default_closed;
  }
  return ext;
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

// ===== 房源图片：上传载荷解析 + 落库（对象存储/本地统一，见 img_storage.cjs）=====
/** 解析上传载荷：data_url / base64 / source_url 三选一 */
function decodeImagePayload(body) {
  const b = body || {};
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(b.data_url || b.dataUrl || '').trim());
  if (m) return { contentType: m[1], buffer: Buffer.from(m[2], 'base64'), filename: b.filename || '' };
  const raw = b.base64 || b.image_base64
    || (typeof b.image === 'string' && b.image && !/^https?:\/\//i.test(b.image) ? b.image : null);
  if (raw) {
    const s = String(raw).trim().replace(/^data:[^,]+,/, '');
    return { contentType: b.content_type || b.contentType || '', buffer: Buffer.from(s, 'base64'), filename: b.filename || '' };
  }
  const src = b.source_url || b.sourceUrl || b.url;
  if (src) return { sourceUrl: String(src).trim(), filename: b.filename || '', contentType: b.content_type || '' };
  return { error: '缺少图片内容：请提供 base64 / data_url / source_url 之一' };
}

/** 解析图片归属实体（unit / project / spot / district） */
function photoEntityOf(body) {
  const b = body || {};
  const pick = (v) => (v != null && v !== '' ? parseInt(v, 10) : null);
  if (pick(b.unit_id)) return { entityType: 'unit', entityId: pick(b.unit_id) };
  if (pick(b.project_id)) return { entityType: 'project', entityId: pick(b.project_id) };
  if (pick(b.spot_id)) return { entityType: 'spot', entityId: pick(b.spot_id) };
  if (pick(b.district_id)) return { entityType: 'district', entityId: pick(b.district_id) };
  if (b.entity_type && pick(b.entity_id)) return { entityType: String(b.entity_type), entityId: pick(b.entity_id) };
  return null;
}

/** 校验实体存在（防脏绑定）；返回错误文案或 null */
async function assertPhotoEntity(conn, entityType, entityId) {
  const tableOf = { unit: 'units', project: 'projects', spot: 'spots', district: 'districts' };
  const table = tableOf[entityType];
  if (!table) return `不支持的 entity_type: ${entityType}（可用 unit/project/spot/district）`;
  const [rows] = await conn.execute(`SELECT id FROM ${table} WHERE id=?`, [entityId]);
  return rows.length ? null : `${entityType} ${entityId} 不存在`;
}

/** 落 photos 表：封面互斥 + 同步 cover_image（unit 走 syncUnitCover，project 直写）
 *  事务 + 归属行锁：并发「设为封面」/ 批量上传时保证 is_cover 唯一与 sort_order 不重复（计划书 R3/R4） */
async function insertPhotoRow(conn, entityType, entityId, upload, body) {
  const isCover = body && body.is_cover ? 1 : 0;
  const tableOf = { unit: 'units', project: 'projects', spot: 'spots', district: 'districts' };
  await conn.beginTransaction();
  try {
    // 串行化同一归属实体的写操作（取行锁；表不在白名单时退化为 photos 级排序，不阻断）
    if (tableOf[entityType]) {
      await conn.execute(`SELECT id FROM ${tableOf[entityType]} WHERE id=? FOR UPDATE`, [entityId]);
    }
    let sortOrder = body && body.sort_order;
    if (sortOrder == null) {
      const [r] = await conn.execute(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM photos WHERE entity_type=? AND entity_id=?',
        [entityType, entityId]
      );
      sortOrder = r[0].n;
    }
    if (isCover) {
      await conn.execute('UPDATE photos SET is_cover=0 WHERE entity_type=? AND entity_id=?', [entityType, entityId]);
    }
    await conn.execute(
      'INSERT INTO photos(entity_type, entity_id, file_path, source_path, is_cover, sort_order) VALUES (?,?,?,?,?,?)',
      [entityType, entityId, upload.url,
        (body && body.source_path) || upload.key || null, isCover, sortOrder]
    );
    const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
    const photoId = r[0].id;
    if (entityType === 'unit') await syncUnitCover(conn, entityId);
    if (entityType === 'project' && isCover) {
      await conn.execute('UPDATE projects SET cover_image=? WHERE id=?', [upload.url, entityId]);
    }
    const [rows] = await conn.execute('SELECT * FROM photos WHERE id=?', [photoId]);
    await conn.commit();
    return rows[0];
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  }
}

/** 写侧收口：任意图片引用 → 受管引用（形态归一化 + 可选镜像）；img_storage 缺失时原样返回 */
async function normImgRef(ref, opts) {
  if (!imgStorage || typeof imgStorage.ingestRef !== 'function') {
    return { ok: true, ref: ref == null ? '' : String(ref), changed: false, mirrored: false };
  }
  return imgStorage.ingestRef(ref, opts);
}

/** cover_image 收口：空值 → null（不改既有"封面可不填"语义）；非空 → 形态归一化（+可选镜像） */
async function normCoverRef(ref, opts) {
  const raw = String(ref == null ? '' : ref).trim();
  if (!raw) return { ok: true, ref: null };
  const r = await normImgRef(raw, opts);
  return r.ok ? { ok: true, ref: r.ref } : { ok: false, error: r.error };
}

/** 上传成功但落库失败时的补偿删除（避免孤儿对象） */
async function compensateUpload(upload) {
  if (!upload || !upload.storage || upload.storage !== 's3' || !upload.url) return;
  if (!imgStorage || typeof imgStorage.deleteObjectByRef !== 'function') return;
  try { await imgStorage.deleteObjectByRef(upload.url); } catch (_) { /* 补偿失败仅告警，不覆盖原始错误 */ }
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

    // ===== 商家入驻申请（服务认证中台受理）：公开提交 + 进度查询 + admin 受理（权限点 vendor.onboarding.review）=====

    // POST /api/juzhu/onboarding/apply —— 公开提交（申请人尚无凭据；白名单见 isCEndPublicApi）
    if (urlPath === '/api/juzhu/onboarding/apply' && req.method === 'POST') {
      await ensureSchema();
      const body = await readBody(req);
      const company = String(body.company || '').trim();
      const contact = String(body.contact || '').trim();
      const phone = String(body.phone || '').trim();
      if (!company || !contact || !phone) return jsonReply(res, { error: 'bad request', message: '企业名称 / 联系人 / 手机号 必填' }, 400);
      if (company.length > 160 || contact.length > 64 || phone.length > 32) return jsonReply(res, { error: 'bad request', message: '字段超长' }, 400);
      const channels = String(body.channels || 'rental').split(',').map(s => s.trim()).filter(s => ['rental', 'minsu'].includes(s)).join(',') || 'rental';
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [r] = await conn.execute(
          `INSERT INTO vendor_onboarding
             (apply_no, company, contact, phone, license_no, license_valid, permit_type,
              channels, category_scope, house_count, settle_bank, settle_account, deposit_tier, status, rate_base)
           VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 10.00)`,
          [company, contact, phone,
           String(body.license_no || '').slice(0, 64), String(body.license_valid || '').slice(0, 32),
           String(body.permit_type || '').slice(0, 32), channels,
           String(body.category_scope || '').slice(0, 255),
           Math.max(0, Math.min(9999, parseInt(body.house_count, 10) || 0)),
           String(body.settle_bank || '').slice(0, 120), String(body.settle_account || '').slice(0, 64),
           String(body.deposit_tier || '').slice(0, 32)]
        );
        const applyNo = 'GZ-RZ-' + new Date().getFullYear() + '-' + String(r.insertId).padStart(5, '0');
        await conn.execute('UPDATE vendor_onboarding SET apply_no=? WHERE id=?', [applyNo, r.insertId]);
        return jsonReply(res, { apply_no: applyNo, status: 'pending', message: '已受理登记，资料齐全后 T+2 出审核结果' }, 200);
      } catch (e) {
        return jsonReply(res, { error: 'server error', message: String(e.message || e) }, 500);
      } finally {
        await conn.end();
      }
    }

    // GET /api/juzhu/onboarding/status?no=&phone= —— 进度查询（须单号+手机号双匹配，防枚举）
    if (urlPath === '/api/juzhu/onboarding/status' && req.method === 'GET') {
      await ensureSchema();
      const qp = new URLSearchParams(qs);
      const no = (qp.get('no') || '').trim();
      const phone = (qp.get('phone') || '').trim();
      if (!no || !phone) return jsonReply(res, { error: 'bad request', message: '请提供申请单号与手机号' }, 400);
      const rows = await queryRows(
        'SELECT apply_no, company, status, channels, review_note, reviewer, reviewed_at, created_at FROM vendor_onboarding WHERE apply_no=? AND phone=? LIMIT 1',
        [no, phone]
      );
      if (!rows.length) return jsonReply(res, { error: 'not found', message: '未找到匹配的申请单（请核对单号与手机号）' }, 404);
      return jsonReply(res, rows[0]);
    }

    // GET /api/juzhu/admin/vendor-onboarding?status= —— 受理列表（服务认证中台；权限点 vendor.onboarding.review）
    if (urlPath === '/api/juzhu/admin/vendor-onboarding' && req.method === 'GET') {
      await ensureSchema();
      const qp = new URLSearchParams(qs);
      const st = (qp.get('status') || '').trim();
      const sql = 'SELECT * FROM vendor_onboarding' + (st ? ' WHERE status=?' : '') + ' ORDER BY created_at DESC LIMIT 200';
      const rows = await queryRows(sql, st ? [st] : []);
      const byStatus = await queryRows('SELECT status, COUNT(*) AS c FROM vendor_onboarding GROUP BY status');
      const counts = {}; byStatus.forEach(r => { counts[r.status] = r.c; });
      return jsonReply(res, { items: rows, counts: counts });
    }

    // POST /api/juzhu/admin/vendor-onboarding/:id/review —— 受理 / 通过 / 驳回（状态机 + 审计由权限闸记录）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/vendor-onboarding\/(\d+)\/review$/);
      if (m && req.method === 'POST') {
        await ensureSchema();
        const id = parseInt(m[1], 10);
        const body = await readBody(req);
        const action = String(body.action || '').trim();
        if (!['review', 'approve', 'reject'].includes(action)) return jsonReply(res, { error: 'bad request', message: 'action 须为 review / approve / reject' }, 400);
        const rows = await queryRows('SELECT * FROM vendor_onboarding WHERE id=?', [id]);
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        const cur = rows[0];
        if (cur.status === 'approved' || cur.status === 'rejected') return jsonReply(res, { error: 'conflict', message: '该申请单已终审（' + cur.status + '），不可再变更' }, 409);
        let next;
        if (action === 'review') {
          if (cur.status !== 'pending') return jsonReply(res, { error: 'conflict', message: '仅待受理单可转核验中' }, 409);
          next = 'reviewing';
        } else if (action === 'approve') {
          next = 'approved';
        } else {
          next = 'rejected';
          if (!String(body.note || '').trim()) return jsonReply(res, { error: 'bad request', message: '驳回必须填写理由（留痕）' }, 400);
        }
        const reviewer = (req.principal && req.principal.account && (req.principal.account.name || req.principal.account.login_name)) || '';
        let discount = null;
        if (action === 'approve' && body.rate_discount !== undefined && body.rate_discount !== null && body.rate_discount !== '') {
          discount = Math.max(0, Math.min(10, parseFloat(body.rate_discount) || 0));
        }
        const checklist = body.checklist ? String(JSON.stringify(body.checklist)).slice(0, 2000) : (cur.checklist_json || null);
        await queryRows(
          `UPDATE vendor_onboarding SET status=?, rate_discount=?, checklist_json=?, review_note=?, reviewer=?, reviewed_at=NOW() WHERE id=?`,
          [next, discount, checklist, String(body.note || '').slice(0, 500), String(reviewer).slice(0, 64), id]
        );
        // 规则 20：审批通过即把核定费率回填商家（接通「申请单核定 → 商家费率」断桥）。
        // 按 phone 单命中 active 商家才回填；未命中/多命中不阻塞，由「商家费率」台配置。
        let backfillNote = '';
        if (next === 'approved') {
          const rateVal = Math.round((Math.max(0, (parseFloat(cur.rate_base) || 10) - (discount != null ? discount : 0))) * 100) / 100;
          const vrows = await queryRows("SELECT id, name FROM jz_vendors WHERE phone=? AND status='active'", [cur.phone]);
          if (vrows.length === 1) {
            const chans = String(cur.channels || 'rental').split(',').map((c) => c.trim());
            const bizCols = [];
            if (chans.some((c) => c === 'rental' || c === 'minsu')) bizCols.push('commission_housing');
            if (chans.some((c) => c === 'jiazheng')) bizCols.push('commission_jiazheng');
            if (!bizCols.length) bizCols.push('commission_housing');   // 申请单频道缺省按房源档
            await queryRows(
              `UPDATE jz_vendors SET ${bizCols.map((c) => c + '=?').join(', ')} WHERE id=?`,
              [...bizCols.map(() => rateVal), vrows[0].id]
            );
            backfillNote = '；费率已回填商家 ' + vrows[0].name + '（' + rateVal + '%）';
            await authCenter.audit({
              action: 'vendor.commission.update', resource: 'vendors', resourceId: String(vrows[0].id),
              result: 'ok', after: Object.fromEntries(bizCols.map((c) => [c, rateVal])),
              before: Object.fromEntries(bizCols.map((c) => [c, null])),
            });
          } else if (vrows.length > 1) {
            backfillNote = '；按手机号命中多个商家，费率未自动回填（请在「商家费率」台配置）';
          } else {
            backfillNote = '；暂未找到匹配商家，费率请在「商家费率」台配置';
          }
        }
        const out = await queryRows('SELECT * FROM vendor_onboarding WHERE id=?', [id]);
        return jsonReply(res, Object.assign({}, out[0], {
          message: next === 'approved'
            ? '已通过。密钥（vendor_id + hmac_key）按线下流程发放；费率基准 10%' + (discount != null ? ' · 折扣 ' + discount : '') + backfillNote
            : (next === 'reviewing' ? '已转入核验中' : '已驳回（已留痕）'),
        }));
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
      // 周边玩法维度（规则 17）：不按城市过滤——绑定 picker 需要全省通用（city_id NULL）与跨市目的地
      const spots = await queryRows('SELECT * FROM spots ORDER BY type, sort_order, id');
      spots.forEach((r) => parseJsonFields(r, ['tags']));
      return jsonReply(res, { city, cities: allCities, districts, channels, spots });
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
        // 抽佣全局基准（规则 20）：商家未差异化时回落到这里
        commission_housing_default: String(vendorRate.defaultRateOf(settingsMap, 'housing')),
        commission_jiazheng_default: String(vendorRate.defaultRateOf(settingsMap, 'jiazheng')),
        // C 端模拟登录开关：仅非生产（JUZHU_ENV != prod/production）开启；生产恒 false，C 端走 jsbridge3 真实登录
        mock_login: !isProduction(),
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
    if (urlPath === '/api/juzhu/admin/vendors' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = 'SELECT id, type, name, phone, city_ids, status, review_status, review_note, reviewed_at, created_at, updated_at FROM jz_vendors WHERE 1=1';
      const params = [];
      if (qp.get('review_status')) { sql += ' AND review_status=?'; params.push(qp.get('review_status')); }
      if (qp.get('status')) { sql += ' AND status=?'; params.push(qp.get('status')); }
      sql += ' ORDER BY id DESC LIMIT 500';
      return jsonReply(res, await queryRows(sql, params));
    }
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/vendors\/(\d+)\/review$/);
      if (m && req.method === 'PUT') {
        const body = await readBody(req);
        const reviewStatus = String(body.review_status || '').trim();
        if (!['reviewing', 'approved', 'rejected'].includes(reviewStatus)) return jsonReply(res, { error: 'review_status 须为 reviewing/approved/rejected' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
          const nextStatus = reviewStatus === 'approved' ? 'active' : (reviewStatus === 'rejected' ? 'suspended' : 'active');
          const [r] = await conn.execute(
            'UPDATE jz_vendors SET review_status=?, review_note=?, reviewed_at=?, status=?, updated_at=? WHERE id=?',
            [reviewStatus, String(body.review_note || '').trim().slice(0, 1000) || null, now, nextStatus, now, parseInt(m[1], 10)]
          );
          if (!r.affectedRows) return jsonReply(res, { error: '商家不存在' }, 404);
          return jsonReply(res, { ok: true, id: parseInt(m[1], 10), review_status: reviewStatus, status: nextStatus });
        } finally { await conn.end(); }
      }
    }

    if (urlPath === '/api/juzhu/admin/vendors/consult' && req.method === 'GET') {
      const rows = await queryRows(
        `SELECT v.id, v.name, v.type, v.consult_mode, COUNT(p.id) AS project_count
         FROM jz_vendors v LEFT JOIN projects p ON p.owner_vendor_id = v.id
         WHERE v.status='active'
         GROUP BY v.id, v.name, v.type, v.consult_mode
         HAVING project_count > 0
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

    // GET /admin/vendors/rates —— 商家费率（两档）+ 全局基准（规则 20；权限点 admin.read）
    if (urlPath === '/api/juzhu/admin/vendors/rates' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = `SELECT v.id, v.name, v.type, v.phone, v.status, v.review_status,
                        v.commission_housing, v.commission_jiazheng, COUNT(p.id) AS project_count
                 FROM jz_vendors v LEFT JOIN projects p ON p.owner_vendor_id = v.id
                 WHERE 1=1`;
      const params = [];
      if (qp.get('status')) { sql += ' AND v.status=?'; params.push(qp.get('status')); }
      sql += ' GROUP BY v.id, v.name, v.type, v.phone, v.status, v.review_status, v.commission_housing, v.commission_jiazheng ORDER BY v.id DESC LIMIT 500';
      const rows = await queryRows(sql, params);
      const srows = await queryRows('SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
        [vendorRate.defaultSettingKey('housing'), vendorRate.defaultSettingKey('jiazheng')]);
      const settingsMap = {};
      for (const r of srows) settingsMap[r.key] = r.value;
      const vendors = rows.map((v) => Object.assign({}, v, {
        commission_housing: v.commission_housing == null ? null : Number(v.commission_housing),
        commission_jiazheng: v.commission_jiazheng == null ? null : Number(v.commission_jiazheng),
        commission_housing_effective: vendorRate.effectiveRateOf(v, 'housing', settingsMap),
        commission_jiazheng_effective: vendorRate.effectiveRateOf(v, 'jiazheng', settingsMap),
      }));
      return jsonReply(res, {
        defaults: {
          housing: vendorRate.defaultRateOf(settingsMap, 'housing'),
          jiazheng: vendorRate.defaultRateOf(settingsMap, 'jiazheng'),
        },
        vendors,
      });
    }

    // PUT /admin/vendors/commission-defaults —— 抽佣全局基准（两键 KV；规则 20；权限点 vendor.fund.write）
    // 与 PUT /admin/settings 并行写同一组 KV（那边挂 settings.write 给平台管理员）；null = 删除键回落内置 10。
    if (urlPath === '/api/juzhu/admin/vendors/commission-defaults' && req.method === 'PUT') {
      const body = await readBody(req);
      const out = {};
      for (const biz of vendorRate.BIZLINES) {
        const k = vendorRate.defaultSettingKey(biz);
        if (!(biz in body) && !('commission_' + biz + '_default' in body)) continue;
        const raw = (biz in body) ? body[biz] : body['commission_' + biz + '_default'];
        let v;
        try { v = vendorRate.normalizeRate(raw); } catch (e) { return jsonReply(res, { error: e.message }, 400); }
        if (v == null) await queryRows('DELETE FROM settings WHERE `key`=?', [k]);
        else await queryRows(
          'INSERT INTO settings(`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
          [k, String(v)]
        );
        out[biz] = v;
      }
      if (!Object.keys(out).length) return jsonReply(res, { error: '无可更新字段（housing / jiazheng）' }, 400);
      const srows = await queryRows('SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
        [vendorRate.defaultSettingKey('housing'), vendorRate.defaultSettingKey('jiazheng')]);
      const settingsMap = {};
      for (const rr of srows) settingsMap[rr.key] = rr.value;
      return jsonReply(res, {
        ok: true,
        defaults: {
          housing: vendorRate.defaultRateOf(settingsMap, 'housing'),
          jiazheng: vendorRate.defaultRateOf(settingsMap, 'jiazheng'),
        },
      });
    }

    // GET /admin/vendors/commission-history —— 费率变更详单（规则 20；挂 vendor.fund.write，
    // 不借道 /admin/audit 的 audit.read：看佣金历史不需要全站审计权限）
    if (urlPath === '/api/juzhu/admin/vendors/commission-history' && req.method === 'GET') {
      const rows = await queryRows(
        `SELECT id, resource_id, role_code, before_json, after_json, created_at
         FROM audit_log
         WHERE action='vendor.commission.update' AND before_json IS NOT NULL
         ORDER BY id DESC LIMIT 50`);
      return jsonReply(res, {
        items: rows.map((r0) => {
          let before = {}, after = {};
          try { before = JSON.parse(r0.before_json || '{}'); } catch (_) {}
          try { after = JSON.parse(r0.after_json || '{}'); } catch (_) {}
          return { id: r0.id, vendor_id: r0.resource_id, role_code: r0.role_code, created_at: r0.created_at, before, after };
        }),
      });
    }

    // PUT /admin/vendors/:id/commission —— 商家费率调整（两档；规则 20；权限点 vendor.fund.write）
    // 口径：0-100 两位小数，null = 清除（回落全局基准）；调价不追溯，仅新订单生效。
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/vendors\/(\d+)\/commission$/);
      if (m && req.method === 'PUT') {
        const body = await readBody(req);
        let nextHousing, nextJiazheng;
        try {
          if ('commission_housing' in body) nextHousing = vendorRate.normalizeRate(body.commission_housing);
          if ('commission_jiazheng' in body) nextJiazheng = vendorRate.normalizeRate(body.commission_jiazheng);
        } catch (e) { return jsonReply(res, { error: e.message }, 400); }
        if (nextHousing === undefined && nextJiazheng === undefined) {
          return jsonReply(res, { error: '无可更新字段（commission_housing / commission_jiazheng）' }, 400);
        }
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const vid = parseInt(m[1], 10);
          const [rows] = await conn.execute(
            'SELECT id, name, commission_housing, commission_jiazheng FROM jz_vendors WHERE id=?', [vid]);
          if (!rows.length) return jsonReply(res, { error: '商家不存在' }, 404);
          const cur = rows[0];
          const num = (x) => (x == null ? null : Number(x));
          const before = { commission_housing: num(cur.commission_housing), commission_jiazheng: num(cur.commission_jiazheng) };
          const sets = [], vals = [];
          if (nextHousing !== undefined) { sets.push('commission_housing=?'); vals.push(nextHousing); }
          if (nextJiazheng !== undefined) { sets.push('commission_jiazheng=?'); vals.push(nextJiazheng); }
          await conn.execute(
            `UPDATE jz_vendors SET ${sets.join(', ')}, updated_at=? WHERE id=?`,
            [...vals, new Date().toISOString().slice(0, 19).replace('T', ' '), vid]
          );
          // 敏感商业条款变更：处理器内记 before/after（role.update 金标准），不只依赖 ROUTES 自动审计
          const p = req.principal || {};
          await authCenter.audit({
            accountId: p.account && p.account.id,
            principalType: 'account',
            roles: p.roles,
            action: 'vendor.commission.update',
            resource: 'vendors',
            resourceId: String(vid),
            scopeLevel: authCenter.bestScopeLevel(p),
            result: 'ok',
            before,
            after: {
              commission_housing: nextHousing !== undefined ? nextHousing : before.commission_housing,
              commission_jiazheng: nextJiazheng !== undefined ? nextJiazheng : before.commission_jiazheng,
            },
            ip: p.ip, ua: p.ua,
          });
          return jsonReply(res, {
            ok: true,
            vendor: {
              id: vid, name: cur.name,
              commission_housing: nextHousing !== undefined ? nextHousing : before.commission_housing,
              commission_jiazheng: nextJiazheng !== undefined ? nextJiazheng : before.commission_jiazheng,
            },
          });
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
        // 抽佣全局基准（规则 20）：0-100 两位小数；传 null/'' = 删除键（回落内置 10.00 兜底）
        for (const biz of vendorRate.BIZLINES) {
          const k = vendorRate.defaultSettingKey(biz);
          if (k in body) {
            let v;
            try { v = vendorRate.normalizeRate(body[k]); } catch (e) { conn.end(); return jsonReply(res, { error: e.message }, 400); }
            if (v == null) await conn.execute('DELETE FROM settings WHERE `key`=?', [k]);
            else await conn.execute(
              'INSERT INTO settings(`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
              [k, String(v)]
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

    // ===== 周边玩法字典（spots / project_spots，规则 17）=====
    // SPOT_TYPES 单一数据源：scenic=景区 | biz=商圈（可扩展；改这里别在页面另造枚举）
    const SPOT_TYPES = ['scenic', 'biz', 'food', 'cafe'];
    const SPOT_TYPE_LABELS = { scenic: '景区', biz: '商圈', food: '美食', cafe: '咖啡' };
    const SPOT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}$/;

    // GET /admin/spots（字典全量；?type=&city_id= 可选过滤）
    if (urlPath === '/api/juzhu/admin/spots' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const conds = [], params = [];
      if (qp.get('type')) { conds.push('type=?'); params.push(qp.get('type')); }
      if (qp.get('city_id')) { conds.push('city_id=?'); params.push(parseInt(qp.get('city_id'))); }
      const rows = await queryRows(
        'SELECT * FROM spots' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '') + ' ORDER BY type, sort_order, id',
        params
      );
      rows.forEach((r) => parseJsonFields(r, ['tags']));
      return jsonReply(res, rows);
    }

    // POST /admin/spots
    if (urlPath === '/api/juzhu/admin/spots' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return jsonReply(res, { error: '名称不能为空' }, 400);
      const type = body.type || 'scenic';
      if (!SPOT_TYPES.includes(type)) return jsonReply(res, { error: 'type 须为 ' + SPOT_TYPES.join('/') }, 400);
      let slug = (body.slug || '').trim();
      if (!slug) slug = 'spot-' + Date.now().toString(36);
      if (!SPOT_SLUG_RE.test(slug)) return jsonReply(res, { error: 'slug 须为小写字母/数字/连字符（用作 C 端深链）' }, 400);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [dup] = await conn.execute('SELECT id FROM spots WHERE slug=?', [slug]);
        if (dup.length) { conn.end(); return jsonReply(res, { error: 'slug 已存在' }, 400); }
        await conn.execute(
          'INSERT INTO spots(city_id, type, name, slug, icon, cover_image, summary, body, photos, address, duration, ticket, tags, link, sort_order, enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [body.city_id ? parseInt(body.city_id) : null, type, name, slug,
           (body.icon || '').trim() || null, (body.cover_image || '').trim() || null,
           (body.summary || '').trim() || null,
           (body.body || '').trim() || null,
           Array.isArray(body.photos) ? JSON.stringify(body.photos) : null,
           (body.address || '').trim() || null, (body.duration || '').trim() || null,
           (body.ticket || '').trim() || null,
           Array.isArray(body.tags) ? JSON.stringify(body.tags) : null,
           (body.link || '').trim() || null, parseInt(body.sort_order) || 999,
           body.enabled === 0 || body.enabled === '0' ? 0 : 1]
        );
        const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
        const [rows] = await conn.execute('SELECT * FROM spots WHERE id=?', [r[0].id]);
        await conn.commit();
        return jsonReply(res, { ok: true, spot: rows[0] }, 201);
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/spots/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/spots\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const sid = parseInt(m[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [existing] = await conn.execute('SELECT id FROM spots WHERE id=?', [sid]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '地点不存在' }, 404); }
          if (body.type != null && !SPOT_TYPES.includes(body.type)) {
            conn.end(); return jsonReply(res, { error: 'type 须为 ' + SPOT_TYPES.join('/') }, 400);
          }
          const mapping = { name: 'name', slug: 'slug', type: 'type', city_id: 'city_id', icon: 'icon',
            cover_image: 'cover_image', summary: 'summary', body: 'body', photos: 'photos',
            address: 'address', duration: 'duration', ticket: 'ticket',
            tags: 'tags', link: 'link', sort_order: 'sort_order', enabled: 'enabled' };
          const fields = [], params = [];
          for (const [key, col] of Object.entries(mapping)) {
            if (!(key in body)) continue;
            let val = body[key];
            if (key === 'sort_order') val = parseInt(val) || 0;
            else if (key === 'enabled') val = (val === 0 || val === '0') ? 0 : 1;
            else if (key === 'city_id') val = val ? parseInt(val) : null;
            else if (key === 'tags' || key === 'photos') val = Array.isArray(val) ? JSON.stringify(val) : (val || null);
            else if (typeof val === 'string') val = val.trim() || null;
            if (key === 'slug' && val && !SPOT_SLUG_RE.test(val)) {
              conn.end(); return jsonReply(res, { error: 'slug 须为小写字母/数字/连字符（用作 C 端深链）' }, 400);
            }
            fields.push(`${col}=?`); params.push(val);
          }
          if (!fields.length) { conn.end(); return jsonReply(res, { error: '无更新字段' }, 400); }
          if (body.slug != null) {
            const [dup] = await conn.execute('SELECT id FROM spots WHERE slug=? AND id<>?', [body.slug, sid]);
            if (dup.length) { conn.end(); return jsonReply(res, { error: 'slug 已存在' }, 400); }
          }
          params.push(sid);
          await conn.execute(`UPDATE spots SET ${fields.join(', ')} WHERE id=?`, params);
          await conn.commit();
          const [rows] = await conn.execute('SELECT * FROM spots WHERE id=?', [sid]);
          return jsonReply(res, { ok: true, spot: rows[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/spots/:id（被项目绑定中则拒绝，先在项目里解除绑定）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/spots\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const sid = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [cnt] = await conn.execute('SELECT COUNT(*) AS c FROM project_spots WHERE spot_id=?', [sid]);
          if (cnt[0].c > 0) { conn.end(); return jsonReply(res, { error: `该地点仍被 ${cnt[0].c} 个项目绑定，请先在项目里解除绑定` }, 400); }
          const [existing] = await conn.execute('SELECT id FROM spots WHERE id=?', [sid]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '地点不存在' }, 404); }
          await conn.execute('DELETE FROM spots WHERE id=?', [sid]);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // GET /admin/projects/:id/spots（绑定列表） / PUT（整体替换绑定）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/projects\/(\d+)\/spots$/);
      if (m && (req.method === 'GET' || req.method === 'PUT')) {
        const pid = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          if (req.method === 'GET') {
            const [rows] = await conn.execute(
              'SELECT ps.spot_id, ps.note, ps.sort_order, s.name, s.type, s.icon, s.slug, s.cover_image ' +
              'FROM project_spots ps JOIN spots s ON s.id=ps.spot_id WHERE ps.project_id=? ORDER BY ps.sort_order, ps.id', [pid]);
            return jsonReply(res, { ok: true, bindings: rows });
          }
          // PUT：整体替换（草稿式编辑，一次保存全量提交；会覆盖同项目的并发编辑）
          const body = await readBody(req);
          const list = Array.isArray(body.bindings) ? body.bindings : [];
          if (list.length > 12) return jsonReply(res, { error: '最多绑定 12 处（保持 C 端区块克制）' }, 400);
          const seen = new Set();
          for (const b of list) {
            const sid = parseInt(b && b.spot_id, 10);
            if (!sid) return jsonReply(res, { error: 'bindings 里存在无效 spot_id' }, 400);
            if (seen.has(sid)) return jsonReply(res, { error: '同一地点重复绑定' }, 400);
            seen.add(sid);
          }
          for (const sid of seen) {
            const [ex] = await conn.execute('SELECT id FROM spots WHERE id=?', [sid]);
            if (!ex.length) return jsonReply(res, { error: `地点 #${sid} 不存在` }, 400);
          }
          await conn.beginTransaction();
          await conn.execute('DELETE FROM project_spots WHERE project_id=?', [pid]);
          for (const b of list) {
            await conn.execute(
              'INSERT INTO project_spots(project_id, spot_id, note, sort_order) VALUES (?,?,?,?)',
              [pid, parseInt(b.spot_id, 10), ((b.note || '') + '').trim().slice(0, 120) || null, parseInt(b.sort_order) || 0]);
          }
          await conn.commit();
          const [rows] = await conn.execute(
            'SELECT ps.spot_id, ps.note, ps.sort_order, s.name, s.type FROM project_spots ps JOIN spots s ON s.id=ps.spot_id WHERE ps.project_id=? ORDER BY ps.sort_order, ps.id', [pid]);
          return jsonReply(res, { ok: true, bindings: rows });
        } catch (e) {
          try { await conn.rollback(); } catch (_) {}
          throw e;
        } finally {
          await conn.end();
        }
      }
    }

    // ===== 内容域：旅游路线（routes）+ 房源专题（settings KV topic_*）=====
    // 与 spots 同属内容编辑口径（house.write，规则 17/18）；专题 = 房源筛选条件（规则 15），
    // 路线 = spots 的有序编排（站点内容仍在 spots 单一数据源，不复制正文）。
    const ROUTE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}$/;
    const TOPIC_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}$/;

    // GET /admin/routes（全量含未上架；?city_id= 可选过滤）
    if (urlPath === '/api/juzhu/admin/routes' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const rows = qp.get('city_id')
        ? await queryRows('SELECT * FROM routes WHERE city_id=? OR city_id IS NULL ORDER BY sort_order, id', [parseInt(qp.get('city_id'))])
        : await queryRows('SELECT * FROM routes ORDER BY sort_order, id');
      rows.forEach((r) => { try { r.stops = r.stops ? JSON.parse(r.stops) : []; } catch (_) { r.stops = []; } });
      return jsonReply(res, rows);
    }

    // POST /admin/routes
    if (urlPath === '/api/juzhu/admin/routes' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return jsonReply(res, { error: '路线名称不能为空' }, 400);
      let slug = (body.slug || '').trim();
      if (!slug) slug = 'route-' + Date.now().toString(36);
      if (!ROUTE_SLUG_RE.test(slug)) return jsonReply(res, { error: 'slug 须为小写字母/数字/连字符（用作 C 端深链）' }, 400);
      const stops = Array.isArray(body.stops) ? body.stops : [];
      if (stops.length > 12) return jsonReply(res, { error: '单条路线最多 12 个点位（保持行程克制）' }, 400);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [dup] = await conn.execute('SELECT id FROM routes WHERE slug=?', [slug]);
        if (dup.length) { conn.end(); return jsonReply(res, { error: 'slug 已存在' }, 400); }
        for (const s of stops) {
          const sid = parseInt(s && s.spot_id, 10);
          if (!sid) { conn.end(); return jsonReply(res, { error: 'stops 里存在无效 spot_id' }, 400); }
          const [ex] = await conn.execute('SELECT id FROM spots WHERE id=?', [sid]);
          if (!ex.length) { conn.end(); return jsonReply(res, { error: `点位 #${sid} 不存在` }, 400); }
        }
        await conn.execute(
          'INSERT INTO routes(city_id, slug, name, summary, cover_image, days, stops, sort_order, enabled) VALUES (?,?,?,?,?,?,?,?,?)',
          [body.city_id ? parseInt(body.city_id) : null, slug, name,
           (body.summary || '').trim() || null, (body.cover_image || '').trim() || null,
           Math.min(30, Math.max(1, parseInt(body.days) || 1)),
           JSON.stringify(stops.map((s) => ({ spot_id: parseInt(s.spot_id, 10), note: ((s.note || '') + '').trim().slice(0, 120) || '' }))),
           parseInt(body.sort_order) || 999,
           (body.enabled === false || body.enabled === 0 || body.enabled === '0') ? 0 : 1]
        );
        const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
        const [rows] = await conn.execute('SELECT * FROM routes WHERE id=?', [r[0].id]);
        await conn.commit();
        return jsonReply(res, { ok: true, route: rows[0] }, 201);
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/routes/:id（全量更新）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/routes\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const rid = parseInt(m[1]);
        const body = await readBody(req);
        const name = (body.name || '').trim();
        if (!name) return jsonReply(res, { error: '路线名称不能为空' }, 400);
        const stops = Array.isArray(body.stops) ? body.stops : [];
        if (stops.length > 12) return jsonReply(res, { error: '单条路线最多 12 个点位（保持行程克制）' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [ex] = await conn.execute('SELECT id FROM routes WHERE id=?', [rid]);
          if (!ex.length) { conn.end(); return jsonReply(res, { error: '路线不存在' }, 404); }
          for (const s of stops) {
            const sid = parseInt(s && s.spot_id, 10);
            if (!sid) { conn.end(); return jsonReply(res, { error: 'stops 里存在无效 spot_id' }, 400); }
            const [sp] = await conn.execute('SELECT id FROM spots WHERE id=?', [sid]);
            if (!sp.length) { conn.end(); return jsonReply(res, { error: `点位 #${sid} 不存在` }, 400); }
          }
          await conn.execute(
            'UPDATE routes SET city_id=?, name=?, summary=?, cover_image=?, days=?, stops=?, sort_order=?, enabled=? WHERE id=?',
            [body.city_id ? parseInt(body.city_id) : null, name,
             (body.summary || '').trim() || null, (body.cover_image || '').trim() || null,
             Math.min(30, Math.max(1, parseInt(body.days) || 1)),
             JSON.stringify(stops.map((s) => ({ spot_id: parseInt(s.spot_id, 10), note: ((s.note || '') + '').trim().slice(0, 120) || '' }))),
             parseInt(body.sort_order) || 999,
             (body.enabled === false || body.enabled === 0 || body.enabled === '0') ? 0 : 1,
             rid]
          );
          const [rows] = await conn.execute('SELECT * FROM routes WHERE id=?', [rid]);
          await conn.commit();
          return jsonReply(res, { ok: true, route: rows[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/routes/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/routes\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const rid = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [ex] = await conn.execute('SELECT id FROM routes WHERE id=?', [rid]);
          if (!ex.length) { conn.end(); return jsonReply(res, { error: '路线不存在' }, 404); }
          await conn.execute('DELETE FROM routes WHERE id=?', [rid]);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // GET /admin/topics —— settings KV topic_* 清单（slug/label/channel/tags/enabled）
    if (urlPath === '/api/juzhu/admin/topics' && req.method === 'GET') {
      const rows = await queryRows("SELECT `key`, value FROM settings WHERE `key` LIKE 'topic\\_%'");
      const topics = rows.map((r) => {
        const slug = String(r.key).replace(/^topic_/, '');
        let crit = {};
        try { crit = JSON.parse(r.value || '{}'); } catch (_) { crit = {}; }
        return { slug, label: crit.label || slug, channel: crit.channel || null, tags: Array.isArray(crit.tags) ? crit.tags : [], enabled: crit.enabled !== false, desc: crit.desc || '', cover_image: crit.cover_image || '' };
      }).sort((a, b) => a.slug.localeCompare(b.slug));
      return jsonReply(res, topics);
    }

    // PUT /admin/topics/:slug（upsert；专题 = 房源筛选条件，tags 至少 1 个）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/topics\/([a-z0-9][a-z0-9-]*)$/);
      if (m && req.method === 'PUT') {
        const slug = m[1];
        if (!TOPIC_SLUG_RE.test(slug)) return jsonReply(res, { error: 'slug 须为小写字母/数字/连字符' }, 400);
        const body = await readBody(req);
        const label = (body.label || '').trim();
        if (!label) return jsonReply(res, { error: '专题名称不能为空' }, 400);
        const tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t || '').trim()).filter(Boolean) : [];
        if (!tags.length) return jsonReply(res, { error: '专题至少需要 1 个 tag 条件（专题=筛选条件，规则 15）' }, 400);
        const crit = { label, tags };
        if (body.channel) crit.channel = String(body.channel);
        const desc = (body.desc || '').trim(); if (desc) crit.desc = desc;
        const cover = (body.cover_image || '').trim(); if (cover) crit.cover_image = cover;
        // enabled 接受布尔 false / 0 / '0'（admin UI 传布尔，脚本可能传 0）
        crit.enabled = !(body.enabled === false || body.enabled === 0 || body.enabled === '0');
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          await conn.execute(
            'INSERT INTO settings(`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
            ['topic_' + slug, JSON.stringify(crit)]
          );
          await conn.commit();
          catalogMemoInvalidateTopics();
          return jsonReply(res, { ok: true, topic: { slug, label, channel: crit.channel || null, tags, enabled: crit.enabled } });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/topics/:slug（bzf 保租房专区是规则 15 既有契约，禁止删除）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/topics\/([a-z0-9][a-z0-9-]*)$/);
      if (m && req.method === 'DELETE') {
        if (m[1] === 'bzf') return jsonReply(res, { error: 'topic_bzf 是保租房专区既有契约（规则 15），不可删除；可编辑或下架' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [r] = await conn.execute('DELETE FROM settings WHERE `key`=?', ['topic_' + m[1]]);
          if (!r.affectedRows) { conn.end(); return jsonReply(res, { error: '专题不存在' }, 404); }
          await conn.commit();
          catalogMemoInvalidateTopics();
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
      if (['rental', 'minsu'].includes(channel) && String(body.status || '').toLowerCase() === 'online') {
        return jsonReply(res, { error: '新建房源必须先保存为 draft，完成商家/房源审核后再上架' }, 400);
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
          if ('ext' in body) {
            // 服务端兜底：ext.cancel_policy 过单一数据源校验，防管理端拼错口径（规则15 差异属性放 ext）
            if (body.ext && typeof body.ext === 'object' && !Array.isArray(body.ext) && 'cancel_policy' in body.ext) {
              try { body.ext.cancel_policy = body.ext.cancel_policy === null ? undefined : normalizeCancelPolicyInput(body.ext.cancel_policy); }
              catch (e) { conn.end(); return jsonReply(res, { error: e.message }, 400); }
            }
            put('ext', body.ext != null ? JSON.stringify(body.ext) : null);
          }
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
      const SKU_JSON_FIELDS = ['tags', 'badges', 'gallery', 'includes_json', 'service_flow', 'service_notice'];
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
        parseJsonFields(item, ['tags', 'badges', 'gallery', 'includes_json', 'service_flow', 'service_notice']);

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
        related.forEach(r => parseJsonFields(r, ['gallery', 'tags', 'badges', 'includes_json', 'service_flow', 'service_notice']));

// C 端预订路由（server/routes/booking.cjs）
const handleBookingRoutes = createBookingRouter({
  queryRows, jsonReply, readBody, requestSession, maskPhoneStd,
  orderCancelInfoOf, mysql2, getDbConfig, crypto, stayCfg, connExec,
  stayNightPrices, releaseStayQty, stayDateList,
  transactionCapabilitiesOf, minStayNightsOf,
  cancelPolicyOf, cancelPolicyTextOf, wholeHousePriceUnit,
  fallbackUnitRowFor, settingValue, vendorRate,
  getPaymentService, getBookingPaymentAdapter, notifyVendorBooking, bookingPaymentExpired,
  expireBooking,
});

const handleJiazhengRoutes = createJiazhengRouter({
  queryRows, jsonReply, readBody, mysql2, getDbConfig,
  cityMatchTokens, cityIdsClause,
  composeRank, merchantIntroOf, maskPhone, maskPhoneStd,
  parseSkuJsonFields, parseJsonFields, vendorAuthBadges, workerAuthBadges, reviewReply,
  CATEGORY_REVIEW_FALLBACKS,
  requireCEndWrite, restrictOrdersRead, requireDispatchPerm, requireApiKey,
  authCenter, auditIfAccount,
  getVendorConfig, hmacAuth, grOrders, outboundJson, stripVendorSecrets,
  requestSession, getPaymentCore, getJiazhengAdapter,
});

const handleAdminRoutes = createAdminRouter({
  queryRows, jsonReply, readBody, mysql2, getDbConfig, crypto,
  housingCities, parseJsonFields, encodeTags, channelBrand, isProduction, ensureSchema,
  authCenter, requireApiKey, requirePerm, requireAnyPerm,
  guardRatingSubmit, requestSession, extractBearerToken,
  validateRealPhone, contactPhoneFromBody, stripContactPhone,
  slugify, cityDupReply, resolveBodyCityId, insertCityRow, updateCityRow,
  uniqueProjectSlug, uniqueUnitSlug, syncDistrictStats, syncProjectUnitCount,
  normalizeUnitExtInput, normalizeUnitRoomProfileInput, syncUnitCover,
  normalizeProjectExtInput, normalizeCancelPolicyInput, projectPublishEligibility,
  stayConfigOf, cancelPolicyOf, cancelPolicyTextOf, minStayNightsOf,
  transactionCapabilitiesOf, wholeHousePriceUnit, unitNightPrice,
  vendorRate, settingValue, vendorApi, notifyVendorEvent,
  resetVendorConfigCache, runVendorWebhookTest,
  imgThumbs, maskPhoneStd, stripVendorSecrets,
  idpOidc, permRegistry, ADMIN_PREFIX,
  catalogMemoInvalidateAll, catalogMemoInvalidateTopics,
  housingParseJsonField, housingHydrateCoverFields, housingTagsToDb,
  ratingCfg, RATING_DIMS, RATING_CODE_PREFIX,
  stayCfg, connExec, fallbackUnitRowFor,
  auditIfAccount, isAdminSessionAuthorized, verifyAdminLoginToken,
});



const handleApiDirect = createApiDirectRouter({
  ADMIN_PREFIX,
  INSURANCE_KEYS,
  assertAdminAuthorized,
  assertApiAuthorized,
  auditIfAccount,
  authCenter,
  bcrypt,
  beikeAuth,
  bookableOf,
  bookingPaymentExpired,
  buildStayMonth,
  cancelPolicyOf,
  cancelPolicyTextOf,
  catalogMemoGet,
  catalogMemoSet,
  connExec,
  crypto,
  ensureSchema,
  expireBooking,
  getDbConfig,
  getVendorConfig,
  getBookingPaymentAdapter,
  grOrders,
  grUserQuery,
  guardRatingSubmit,
  guardedPostJson,
  handleAdminRoutes,
  handleBookingRoutes,
  handleJiazhengRoutes,
  hmacAuth,
  housingCities,
  housingHydrateCoverFields,
  housingParseJsonField,
  imgThumbs,
  isCEndPublicApi,
  isProduction,
  jsonReply,
  maskPhoneStd,
  minStayNightsOf,
  mysql2,
  nextEmpNo,
  normalizeCancelPolicyInput,
  outboundJson,
  parseExtObj,
  parseJsonFields,
  parseSkuJsonFields,
  permRegistry,
  photoCfg,
  projectPublishEligibility,
  queryRows,
  readBody,
  releaseStayQty,
  requestSession,
  requireAnyPerm,
  requireApiKey,
  requirePerm,
  resetVendorConfigCache,
  stayCfg,
  stayConfigOf,
  stripContactPhone,
  stripVendorSecrets,
  validateStaff,
  vendorApi,
  vendorRate,
  verifyVendorLoginToken,
  webhookSign,
  wholeHousePriceUnit,
  withStayRules
});


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
// ================= 每请求日志（对齐 Python juzhu/server.py 分段格式） =================
// 详细模式（默认）：每请求打印 分隔线 + #编号 时间 [类别] 方法 URI + query/headers + 请求体 + 响应状态与返回体；
// 简洁模式（JUZHU_LOG_DETAIL=false/0/off）：每请求仅一行「时间 方法 URI」。
const LOG_SEP = '='.repeat(80);
const LOG_BODY_LIMIT = 2000;   // 请求体/返回体打印截断长度（字符）
let reqSeq = 0;

function logDetailOn() {
  const v = (process.env.JUZHU_LOG_DETAIL || 'true').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

function logTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 入站请求分类：商家回调/商家 vendor 接口调用我们 → [商家→平台]；其余 → [其它]
function reqLogCategory(path) {
  return (path === '/api/juzhu/callback' || path.startsWith('/api/juzhu/jiazheng/vendor/')) ? '商家→平台' : '其它';
}

// 请求开始：详细模式打印分段头；简洁模式只打印接口 URI
function reqLogBegin(req, rawPath, qs) {
  reqSeq += 1;
  const safePath = rawPath.replace(/(\/payment\/notify\/)[^/]+/, '$1[redacted]');
  const safeQuery = new URLSearchParams(qs);
  for (const key of safeQuery.keys()) if (/token|secret|key|phone|ucid/i.test(key)) safeQuery.set(key, '[redacted]');
  const query = safeQuery.toString();
  const uri = safePath + (query ? '?' + query : '');
  if (!logDetailOn()) {
    console.log(`${logTs()} ${req.method} ${uri}`);
    return;
  }
  const lines = [LOG_SEP, `#${reqSeq} ${logTs()} [${reqLogCategory(rawPath)}] ${req.method} ${uri}`];
  if (query) lines.push(`  >> 参数(query): ${query}`);
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    lines.push(`  >> 参数(headers): content-type=${req.headers['content-type'] || '-'}, content-length=${req.headers['content-length'] || 0}`);
  }
  console.log(lines.join('\n'));
}

// 请求体（JSON）原文打印：与 Python _body() 一致，超长截断
function reqLogBody(rawBody) {
  if (!logDetailOn() || !rawBody) return;
  let text;
  try { text = JSON.stringify(require('./server/payment/primitives.cjs').sanitize(JSON.parse(String(rawBody)))); }
  catch (_) { text = '[non-JSON body omitted]'; }
  const body = text.length > LOG_BODY_LIMIT ? `${text.slice(0, LOG_BODY_LIMIT)}…[截断，共 ${text.length} 字符]` : text;
  console.log(`  >> 参数(body): ${body.replace(/\n/g, '\n  | ')}`);
}

// 响应完成：包装 res 收集返回体（仅 /api/juzhu），finish 时打印状态码/大小/耗时/返回体
function resLogWrap(req, res) {
  const started = Date.now();
  let size = 0;
  let body = '';
  let bodyTruncated = false;
  let contentType = null;
  // finish 后 getHeader 已取不到，需在 writeHead/setHeader 时提前记录 content-type
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = (code, headers) => {
    if (Array.isArray(headers)) {
      for (let i = 0; i < headers.length; i += 2) {
        if (String(headers[i]).toLowerCase() === 'content-type') contentType = headers[i + 1];
      }
    } else if (headers) {
      contentType = headers['Content-Type'] || headers['content-type'] || contentType;
    }
    return origWriteHead(code, headers);
  };
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    if (String(name).toLowerCase() === 'content-type') contentType = value;
    return origSetHeader(name, value);
  };
  const collect = (chunk) => {
    if (chunk == null) return;
    size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (bodyTruncated || body.length >= LOG_BODY_LIMIT) return;
    const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    body += s;
    if (body.length > LOG_BODY_LIMIT) {
      body = body.slice(0, LOG_BODY_LIMIT);
      bodyTruncated = true;
    }
  };
  const origWrite = res.write.bind(res);
  res.write = (chunk, enc, cb) => { collect(chunk); return origWrite(chunk, enc, cb); };
  const origEnd = res.end.bind(res);
  res.end = (chunk, enc, cb) => { collect(chunk); return origEnd(chunk, enc, cb); };
  res.on('finish', () => {
    if (!logDetailOn()) return;
    const ct = contentType || res.getHeader('content-type') || '-';
    const lines = [`  << 状态: ${res.statusCode} · ${size}B · ${Date.now() - started}ms · ${ct}`];
    if (body.length || bodyTruncated) {
      let text = '[body omitted]';
      if (!bodyTruncated) {
        try { text = JSON.stringify(require('./server/payment/primitives.cjs').sanitize(JSON.parse(body))); } catch (_) {}
      } else text = `[body omitted: ${size} bytes]`;
      lines.push(`  << 返回: ${text.replace(/\n/g, '\n  | ')}`);
    }
    console.log(lines.join('\n'));
  });
  // 兜底：连接中断且未正常结束（无响应体/超时）时也留痕
  res.on('close', () => {
    if (!res.writableFinished && logDetailOn()) {
      console.log(`  << 状态: 连接中断（未完成响应）· ${Date.now() - started}ms`);
    }
  });
}

const server = http.createServer((req, res) => {
  const rawPath = req.url.split('?')[0];
  const qs = req.url.includes('?') ? req.url.split('?')[1] : '';

  // 每请求日志（响应体仅对 /api/juzhu 记录，静态文件只留请求行）
  const apiReq = rawPath.startsWith('/api/juzhu');
  if (rawPath.startsWith('/api/settlement/v1/')) {
    getSettlementRuntime().then(runtime => runtime.handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '结算服务暂时不可用', code: 'settlement_unavailable' }));
    });
    return;
  }
  reqLogBegin(req, rawPath, qs);
  if (apiReq) resLogWrap(req, res);

  // CORS preflight
  if (req.method === 'OPTIONS' && (rawPath.startsWith('/api/juzhu') || rawPath.startsWith('/api/auth'))) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Session-Token, X-Lianjia-Token, Idempotency-Key',
    });
    res.end();
    return;
  }

  // /api/juzhu/* 直接走 Node.js MySQL 实现
  if (apiReq) {
    return handleApiDirect(rawPath, qs, req, res);
  }

  // /api/auth/* —— 账号中心登录/登出/身份（handleApiDirect 之外的独立轻路由）
  if (rawPath.startsWith('/api/auth')) {
    return handleAuthRoutes(rawPath, qs, req, res);
  }

  // React C 端 SPA（与 lvju-app-*.html 并存；源码在 h5/，成品 h5/dist）
  if (rawPath === '/h5' || rawPath.startsWith('/h5/')) {
    return serveH5Spa(rawPath, res);
  }

  // 旧首页入口 → React /h5（保留 ?city= 等查询串）
  if (rawPath === '/lvju-app-home-demo.html') {
    res.writeHead(302, { Location: '/h5' + (qs ? '?' + qs : ''), 'Cache-Control': 'no-cache' });
    res.end();
    return;
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
  const paymentTimer = setInterval(() => runUnifiedPaymentMaintenance().catch((e) => console.warn('payment maintenance:', e.code || e.message)), 2000);
  paymentTimer.unref();
  const envName = (process.env.JUZHU_ENV || 'dev').trim().toLowerCase();
  const apiKey = (process.env[API_KEY_ENV] || '').trim();
  if (envName === 'prod' || envName === 'production') {
    if (!apiKey || apiKey === FORBIDDEN_API_KEY) {
      console.error(`FATAL: production requires ${API_KEY_ENV} (must not be empty or ${FORBIDDEN_API_KEY})`);
      process.exit(1);
    }
    const paymentRequired = [
      'OAUTH_GATEWAY_URL', 'OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET',
      'PAY_APP_CODE', 'PAY_PROJECT_CODE', 'PAY_SHARE_BIZ_CODE',
      'PAY_NOTIFY_URL', 'PAY_NOTIFY_TOKEN',
    ];
    const missingPayment = paymentRequired.filter((key) => !String(process.env[key] || '').trim());
    if (missingPayment.length) {
      console.error(`FATAL: production payment config missing: ${missingPayment.join(', ')}`);
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
