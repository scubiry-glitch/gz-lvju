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
  // App C 端身份标准：X-Lianjia-Token → 验票 → accounts（不依赖 BJZ）
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
try { loadVendorConfigFromDb = require('./vendor_config.cjs').loadVendorConfigFromDb; } catch (_) {}
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
      createConnection: () => mysql2.createConnection(getDbConfig()),
      payCenter,
      notifyVendorBooking,
    });
  }
  return paymentService;
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
    const session=await authCenter.verifySessionToken(extractBearerToken(req)).catch(()=>null);
    if(!session||session.account.status!=='active'||session.account.principal_type!=='user')return {ok:false,status:401,error:'请使用新居住账号登录'};
    const userId=require('./commerce/main-system.cjs').accountUser(session.account.id);
    if(raw&&raw!==userId)return {ok:false,status:403,error:'不能查看其他账号的订单'};
    return {ok:true,userId};
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
  if (m === 'POST' && process.env.PAY_NOTIFY_TOKEN
    && p === `/api/juzhu/payment/notify/${process.env.PAY_NOTIFY_TOKEN}`) return true;
  if (m === 'POST' && p === '/api/juzhu/payment/query') return true;
  if (m === 'POST' && (p === '/api/juzhu/auth/tenant' || p === '/api/juzhu/auth/beike')) return true;
  if (m === 'GET' && p === '/api/juzhu/auth/beike-config') return true;
  if (m === 'POST' && p === '/api/juzhu/jiazheng/wechat-link') return true;
  // 商家入驻申请（公开提交：申请人尚无任何凭据；受理/核验走 admin 域会话 + 权限点）
  if (m === 'POST' && p === '/api/juzhu/onboarding/apply') return true;
  if (m === 'GET' && p === '/api/juzhu/onboarding/status') return true;
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
  if (!p.cover_image && !Number(ph[0].has_cover || 0)) return { ok: false, error: '上架前须设置房源封面图', status: 400 };
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

async function expireBooking(conn, row) {
  if (!bookingPaymentExpired(row)) return false;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const [updated] = await conn.execute("UPDATE booking_orders SET status='cancelled', pay_status='expired', updated_at=? WHERE id=? AND status='pending' AND pay_status='unpaid'", [now, row.id]);
  if (!updated.affectedRows) return false;
  // 多间库存释放（2026-09-10）：按订单区间递减 booked_qty，纯占用行删行（商家夜价/qty 差异行保留）
  await releaseStayQty(connExec(conn), { project_id: row.project_id, unit_id: row.unit_id, rooms: row.rooms, checkin: row.checkin, checkout: row.checkout, now });
  return true;
}

async function cleanupExpiredBookingOrders() {
  let conn;
  try {
    conn = await getPool().getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT * FROM booking_orders
         WHERE status='pending' AND pay_status='unpaid'
           AND payment_expires_at IS NOT NULL AND payment_expires_at <= UTC_TIMESTAMP()
         ORDER BY id LIMIT 100 FOR UPDATE`);
    if (!rows.length) { await conn.commit(); return; }
    for (const row of rows) await expireBooking(conn, row);
    await conn.commit();
  } catch (e) {
    if (conn) { try { await conn.rollback(); } catch (_) {} }
    if (!['ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'].includes(e && e.code)) console.warn('cleanupExpiredBookingOrders:', e.message);
  } finally { if (conn) conn.release(); }
}

// 已创建收银台的订单必须先由中台确认关单，才可释放库存，避免晚到支付成功。
async function cleanupExpiredPaymentOrders() {
  let scanConn;
  try {
    scanConn = await getPool().getConnection();
    const [rows] = await scanConn.execute(
      `SELECT b.* FROM booking_orders b
       JOIN payment_orders p ON p.biz_order_no=b.order_no
       WHERE b.status='pending'
         AND b.payment_expires_at IS NOT NULL AND b.payment_expires_at <= UTC_TIMESTAMP()
         AND p.pay_status IN ('creating','create_unknown','paying','closing','close_unknown')
       ORDER BY p.id DESC LIMIT 100`,
    );
    for (const row of rows) {
      let closeResult;
      try {
        closeResult = await getPaymentService().closePaymentByOrder(row.order_no, 'booking_expired');
      } catch (error) {
        console.warn('cleanupExpiredPaymentOrders close:', row.order_no, error.message);
        continue;
      }
      if (closeResult.skipped) continue;
      const conn = await getPool().getConnection();
      try {
        await conn.beginTransaction();
        const [locked] = await conn.execute(`SELECT * FROM booking_orders WHERE id=? FOR UPDATE`, [row.id]);
        const booking = locked[0];
        if (booking && booking.status === 'pending' && !booking.paid_payment_order_id) {
          const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
          await conn.execute(
            `UPDATE booking_orders SET status='cancelled', pay_status='expired', updated_at=? WHERE id=?`,
            [now, booking.id],
          );
          await releaseStayQty(connExec(conn), {
            project_id: booking.project_id, unit_id: booking.unit_id, rooms: booking.rooms,
            checkin: booking.checkin, checkout: booking.checkout, now,
          });
        }
        await conn.commit();
      } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        console.warn('cleanupExpiredPaymentOrders expire:', row.order_no, error.message);
      } finally {
        conn.release();
      }
    }
  } catch (error) {
    if (!['ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'].includes(error && error.code)) {
      console.warn('cleanupExpiredPaymentOrders:', error.message);
    }
  } finally {
    if (scanConn) scanConn.release();
  }
}

// ===== 商家 Webhook 推送（平台 → 商家，HMAC 签名与开放接口同算法）=====
// 事件：booking.created / booking.paid / booking.cancelled。只通知不担保必达：
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
module.exports.isVendorHmacPath = isVendorHmacPath;
module.exports.stripVendorSecrets = stripVendorSecrets;
module.exports.verifyAdminLoginToken = verifyAdminLoginToken;
module.exports.FORBIDDEN_API_KEY = FORBIDDEN_API_KEY;
module.exports.DEV_EXAMPLE_API_KEY = DEV_EXAMPLE_API_KEY;
module.exports.getDbConfig = getDbConfig;
module.exports.validateRealPhone = validateRealPhone;
module.exports.contactPhoneFromBody = contactPhoneFromBody;
module.exports.stripContactPhone = stripContactPhone;

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

// Node.js 直连 MySQL 实现全部管理接口（Python 不可用时 fallback）

// C 端预订路由（server/routes/booking.cjs）
const handleBookingRoutes = createBookingRouter({
  queryRows, jsonReply, readBody, requestSession, maskPhoneStd,
  orderCancelInfoOf, mysql2, getDbConfig, crypto, stayCfg, connExec,
  stayNightPrices, releaseStayQty, stayDateList,
  transactionCapabilitiesOf, minStayNightsOf,
  cancelPolicyOf, cancelPolicyTextOf, wholeHousePriceUnit,
  fallbackUnitRowFor, settingValue, vendorRate,
  getPaymentService, notifyVendorBooking, bookingPaymentExpired,
  expireBooking,
});

const handleJiazhengRoutes = createJiazhengRouter({
  queryRows, jsonReply, readBody, mysql2, getDbConfig,
  cityMatchTokens, cityIdsClause,
  composeRank, merchantIntroOf, maskPhone, maskPhoneStd,
  parseSkuJsonFields, parseJsonFields, vendorAuthBadges, workerAuthBadges, reviewReply,
  requireCEndWrite, restrictOrdersRead, requireDispatchPerm, requireApiKey,
  authCenter, auditIfAccount,
  getVendorConfig, hmacAuth, grOrders, outboundJson, stripVendorSecrets,
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
  const uri = rawPath + (qs ? '?' + qs : '');
  if (!logDetailOn()) {
    console.log(`${logTs()} ${req.method} ${uri}`);
    return;
  }
  const lines = [LOG_SEP, `#${reqSeq} ${logTs()} [${reqLogCategory(rawPath)}] ${req.method} ${uri}`];
  if (qs) lines.push(`  >> 参数(query): ${qs}`);
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    lines.push(`  >> 参数(headers): content-type=${req.headers['content-type'] || '-'}, content-length=${req.headers['content-length'] || 0}`);
  }
  console.log(lines.join('\n'));
}

// 请求体（JSON）原文打印：与 Python _body() 一致，超长截断
function reqLogBody(rawBody) {
  if (!logDetailOn() || !rawBody) return;
  const text = String(rawBody);
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
      let text = body;
      if (bodyTruncated) text += `…[截断，共 ${size} 字节]`;
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
  reqLogBegin(req, rawPath, qs);
  if (apiReq) resLogWrap(req, res);

  // CORS preflight
  if (req.method === 'OPTIONS' && (rawPath.startsWith('/api/juzhu') || rawPath.startsWith('/api/auth'))) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Session-Token, X-Lianjia-Token',
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
  const bookingExpiryTimer = setInterval(() => cleanupExpiredBookingOrders().catch(() => {}), 60 * 1000);
  bookingExpiryTimer.unref();
  const paymentExpiryTimer = setInterval(() => cleanupExpiredPaymentOrders().catch(() => {}), 60 * 1000);
  paymentExpiryTimer.unref();
  const paymentCompensationTimer = setInterval(() => {
    getPaymentService().runPaymentCompensation().catch((e) => console.warn('payment compensation:', e.message));
  }, 60 * 1000);
  paymentCompensationTimer.unref();
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
