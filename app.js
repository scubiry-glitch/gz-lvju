const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 9000;
// Python server.py 由 scf_bootstrap 启动，监听 8765
const PYTHON_PORT = process.env.PYTHON_PORT || 8765;
// 用 __dirname，避免被测试 require 时 require.main 指向测试文件
const ROOT = path.resolve(__dirname);

const ADMIN_PREFIX = '/api/juzhu/admin';
const API_KEY_ENV = 'JUZHU_API_KEY';
/** 历史开发默认值：任何环境均不得再当作有效密钥（文档泄露即等于未授权） */
const DEV_EXAMPLE_API_KEY = 'dev-juzhu-key';
const FORBIDDEN_API_KEY = DEV_EXAMPLE_API_KEY;

// MySQL 连接配置（fallback 直连，仅当 Python 服务不可用时使用）
// 禁止在源码中写死账号密码；必须由运行时环境 / .env（仅进程内，不对外 HTTP）注入。
let mysql2 = null;
try { mysql2 = require('mysql2/promise'); } catch (_) {}
let jzSeedAll = null;
try { jzSeedAll = require('./jz_seed.cjs').seedAll; } catch (_) {}

function getDbConfig() {
  const host = (process.env.MYSQL_HOST || '').trim();
  const database = (process.env.MYSQL_DB || '').trim();
  const user = (process.env.MYSQL_USER || '').trim();
  const password = process.env.MYSQL_PASSWORD;
  if (!host || !database || !user || password == null || password === '') {
    throw new Error('MySQL env incomplete: set MYSQL_HOST/MYSQL_PORT/MYSQL_DB/MYSQL_USER/MYSQL_PASSWORD');
  }
  return {
    host,
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    database,
    user,
    password,
    charset: 'utf8mb4',
    connectTimeout: 8000,
  };
}

// 与 juzhu/server.py is_public_static 对齐：整仓静态根不得暴露密钥/源码/部署产物。
const SENSITIVE_NAMES = new Set([
  '.env', '.env.local', '.env.example', '.env.prod', '.env.test',
  '.git', '.gitignore', '.ds_store', '__pycache__',
  'config.ini', 'server.log', 'api_doc.md', 'api-document.html',
  'hmac_secret.key', 'package.json', 'package-lock.json', 'yarn.lock',
  'pnpm-lock.yaml', 'scf_bootstrap', 'moma_build.sh', 'moma_deploy.js',
  'claude.md', 'readme.md', 'verification.md',
]);
const SENSITIVE_SUFFIXES = [
  '.py', '.pyc', '.pyo', '.db', '.sqlite', '.sqlite3', '.sql',
  '.ini', '.log', '.key', '.pem', '.crt', '.p12', '.pfx',
  '.env', '.sh', '.md',
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

function requireApiKey(req, res) {
  const expected = expectedApiKey();
  const provided = providedApiKey(req);
  if (apiKeyMatches(provided, expected)) return true;
  jsonReply(res, {
    error: 'unauthorized',
    message: `请通过 Authorization: Bearer <${API_KEY_ENV}> 或 X-API-Key 传入有效 API Key`,
  }, 401);
  return false;
}

function isAdminAuthExempt(urlPath, method) {
  const p = String(urlPath || '').replace(/\/+$/, '') || '/';
  if (p === `${ADMIN_PREFIX}/auth/login` && method === 'POST') return true;
  if (p === `${ADMIN_PREFIX}/auth/check` && method === 'GET') return true;
  return false;
}

function assertAdminAuthorized(urlPath, req, res) {
  const p = String(urlPath || '').replace(/\/+$/, '') || '/';
  if (!p.startsWith(ADMIN_PREFIX)) return true;
  if (isAdminAuthExempt(p, req.method)) return true;
  return requireApiKey(req, res);
}

module.exports.isPublicStatic = isPublicStatic;
module.exports.isProduction = isProduction;
module.exports.expectedApiKey = expectedApiKey;
module.exports.providedApiKey = providedApiKey;
module.exports.requireApiKey = requireApiKey;
module.exports.assertAdminAuthorized = assertAdminAuthorized;
module.exports.FORBIDDEN_API_KEY = FORBIDDEN_API_KEY;
module.exports.DEV_EXAMPLE_API_KEY = DEV_EXAMPLE_API_KEY;

async function queryRows(sql, params) {
  if (!mysql2) throw new Error('mysql2 not available');
  const conn = await mysql2.createConnection(getDbConfig());
  try {
    const [rows] = await conn.execute(sql, params || []);
    return rows;
  } finally {
    await conn.end();
  }
}

async function execSql(conn, sql, params) {
  const [result] = await conn.execute(sql, params || []);
  return result;
}

// 确保 MySQL 中存在必要的表（MySQL 语法，CREATE TABLE IF NOT EXISTS）
let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured || !mysql2) return;
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
        id VARCHAR(50) PRIMARY KEY,
        type VARCHAR(50) NOT NULL DEFAULT 'trade',
        project_id INT,
        unit_id INT,
        user_phone VARCHAR(50) NOT NULL,
        user_name VARCHAR(100),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        amount INT DEFAULT 0,
        note TEXT,
        source VARCHAR(100),
        created_at VARCHAR(30) NOT NULL,
        updated_at VARCHAR(30) NOT NULL
      ) CHARSET=utf8mb4`,
    ];
    for (const ddl of ddls) {
      await conn.execute(ddl);
    }
    // 初始化 jz_categories 种子数据
    const jzCatSeeds = [
      ['cleaning', '保洁', null, 1],
      ['repair',   '维修', null, 2],
      ['moving',   '搬家', null, 3],
      ['nanny',    '保姆', null, 4],
    ];
    for (const [catId, catName, catIcon, catOrder] of jzCatSeeds) {
      await conn.execute(
        'INSERT IGNORE INTO jz_categories(id, name, icon, sort_order, enabled) VALUES (?, ?, ?, ?, 1)',
        [catId, catName, catIcon, catOrder]
      );
    }
    // 初始化 channels 种子数据
    const channelSeeds = [
      ['bzf', '保租房专区', 1],
      ['trade', '卖旧买新专区', 2],
      ['jiazheng', '生活服务专区', 3],
    ];
    for (const [id, label, order] of channelSeeds) {
      await conn.execute(
        'INSERT IGNORE INTO channels(id, label, sort_order, enabled) VALUES (?, ?, ?, 1)',
        [id, label, order]
      );
    }
    // 初始化 settings 种子数据
    const settingSeeds = [['show_city_switcher', '1'], ['show_life_service', '1']];
    for (const [k, v] of settingSeeds) {
      await conn.execute(
        'INSERT IGNORE INTO settings(`key`, value) VALUES (?, ?)',
        [k, v]
      );
    }
    // 家政全量种子数据（subcategories / skus / vendors / workers / products / sku_workers / sku_slots）
    if (jzSeedAll) {
      try { await jzSeedAll(conn); } catch (e) { console.warn('jzSeedAll warn:', e.message); }
    }
    // 迁移：补充可能缺失的列（ALTER TABLE ... ADD COLUMN IF NOT EXISTS 在 MySQL 8.0 不支持，用 try/catch 忽略重复列错误）
    const migrations = [
      "ALTER TABLE projects ADD COLUMN contact_phone VARCHAR(50)",
    ];
    for (const sql of migrations) {
      try { await conn.execute(sql); } catch (_) { /* 列已存在，忽略 */ }
    }
    schemaEnsured = true;
  } finally {
    await conn.end();
  }
}

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
    if (!assertAdminAuthorized(urlPath, req, res)) return;

    await ensureSchema();

    // ===== GET 只读接口 =====

    if (urlPath === '/api/juzhu/admin/dictionary' && req.method === 'GET') {
      const cities = await queryRows('SELECT * FROM cities ORDER BY id LIMIT 1');
      const districts = await queryRows('SELECT * FROM districts ORDER BY sort_order, id');
      const channels = await queryRows('SELECT * FROM channels ORDER BY sort_order, id');
      return jsonReply(res, { city: cities[0] || null, districts, channels });
    }

    if ((urlPath === '/api/juzhu/admin/settings' || urlPath === '/api/juzhu/settings') && req.method === 'GET') {
      const cities = await queryRows('SELECT booking_phone FROM cities ORDER BY id LIMIT 1');
      const settings = await queryRows('SELECT `key`, value FROM settings');
      const settingsMap = {};
      for (const r of settings) settingsMap[r.key] = r.value;
      return jsonReply(res, {
        booking_phone: cities[0] ? cities[0].booking_phone : null,
        show_city_switcher: settingsMap.show_city_switcher !== '0',
        show_life_service: settingsMap.show_life_service !== '0',
      });
    }

    if (urlPath === '/api/juzhu/admin/projects' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = 'SELECT p.*, d.name AS district_name FROM projects p LEFT JOIN districts d ON d.id=p.district_id WHERE 1=1';
      const params = [];
      if (qp.get('channel')) { sql += ' AND p.channel=?'; params.push(qp.get('channel')); }
      if (qp.get('district_id')) { sql += ' AND p.district_id=?'; params.push(parseInt(qp.get('district_id'))); }
      if (qp.get('q')) { sql += ' AND p.name LIKE ?'; params.push('%' + qp.get('q') + '%'); }
      sql += ' ORDER BY p.channel, p.sort_order, p.id';
      const rows = await queryRows(sql, params);
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
        const units = await queryRows('SELECT * FROM units WHERE project_id=? ORDER BY sort_order', [pid]);
        const photos = await queryRows(
          "SELECT * FROM photos WHERE entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id=?) ORDER BY entity_id, sort_order, id",
          [pid]
        );
        return jsonReply(res, { project: projs[0], units, photos });
      }
    }

    if (urlPath === '/api/juzhu/districts' && req.method === 'GET') {
      const rows = await queryRows('SELECT * FROM districts ORDER BY sort_order');
      return jsonReply(res, rows);
    }

    if (urlPath === '/api/juzhu/stats' && req.method === 'GET') {
      const [d] = await queryRows('SELECT COUNT(*) AS c FROM districts');
      const [pb] = await queryRows("SELECT COUNT(*) AS c FROM projects WHERE channel='bzf'");
      const [pt] = await queryRows("SELECT COUNT(*) AS c FROM projects WHERE channel='trade'");
      const [u] = await queryRows("SELECT COALESCE(SUM(managed_unit_count), 0) AS c FROM projects WHERE channel='bzf'");
      return jsonReply(res, { districts: d.c, projects_bzf: pb.c, projects_trade: pt.c, units: u.c });
    }

    // ===== 写操作接口 =====

    // PUT /admin/settings
    if (urlPath === '/api/juzhu/admin/settings' && req.method === 'PUT') {
      const body = await readBody(req);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        if (body.booking_phone !== undefined) {
          const phone = (body.booking_phone || '').trim() || null;
          await conn.execute(
            'UPDATE cities SET booking_phone=? WHERE id=(SELECT id FROM (SELECT id FROM cities ORDER BY id LIMIT 1) t)',
            [phone]
          );
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
        await conn.commit();
        return jsonReply(res, { ok: true });
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/city
    if (urlPath === '/api/juzhu/admin/city' && req.method === 'PUT') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return jsonReply(res, { error: '城市名称不能为空' }, 400);
      const slug = (body.slug || '').trim() || slugify(name);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [rows] = await conn.execute('SELECT id FROM cities ORDER BY id LIMIT 1');
        if (!rows.length) {
          // 无城市则创建
          await conn.execute(
            'INSERT INTO cities(name, slug) VALUES (?, ?)',
            [name, slug]
          );
        } else {
          const cid = rows[0].id;
          const fields = ['name=?', 'slug=?'];
          const params = [name, slug];
          if ('hero_bg_image' in body) {
            fields.push('hero_bg_image=?');
            params.push((body.hero_bg_image || '').trim() || null);
          }
          params.push(cid);
          await conn.execute(`UPDATE cities SET ${fields.join(', ')} WHERE id=?`, params);
        }
        await conn.commit();
        const [cities] = await conn.execute('SELECT * FROM cities ORDER BY id LIMIT 1');
        return jsonReply(res, { ok: true, city: cities[0] || null });
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
        const [cities] = await conn.execute('SELECT id FROM cities ORDER BY id LIMIT 1');
        if (!cities.length) { conn.end(); return jsonReply(res, { error: '请先配置城市' }, 400); }
        const cityId = cities[0].id;
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
      const channel = body.channel || 'bzf';
      if (!name) return jsonReply(res, { error: '项目名称不能为空' }, 400);
      if (!['bzf', 'trade'].includes(channel)) return jsonReply(res, { error: 'channel 须为 bzf 或 trade' }, 400);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [cities] = await conn.execute('SELECT id FROM cities ORDER BY id LIMIT 1');
        if (!cities.length) { conn.end(); return jsonReply(res, { error: '未配置城市' }, 500); }
        const cityId = cities[0].id;
        let districtId = body.district_id || null;
        if (channel === 'bzf') {
          if (!districtId) { conn.end(); return jsonReply(res, { error: '保租房项目须选择行政区' }, 400); }
          const [d] = await conn.execute('SELECT id FROM districts WHERE id=?', [districtId]);
          if (!d.length) { conn.end(); return jsonReply(res, { error: '行政区不存在' }, 400); }
        } else {
          districtId = null;
        }
        const slug = await uniqueProjectSlug(conn, channel, name, body.slug);
        let address = body.address;
        if (!address) {
          if (districtId) {
            const [d] = await conn.execute('SELECT name FROM districts WHERE id=?', [districtId]);
            address = d.length ? `${d[0].name} · ${name}` : `沈阳 · ${name}`;
          } else {
            address = `沈阳 · ${name}`;
          }
        }
        await conn.execute(
          `INSERT INTO projects(city_id,district_id,channel,name,slug,cover_image,address,tags,
            sort_order,unit_count,price_from,is_featured,featured_rank,old_house_hint)
           VALUES (?,?,?,?,?,?,?,?,?,0,?,COALESCE(?,0),?,?)`,
          [cityId, districtId, channel, name, slug, body.cover_image || null, address,
           body.tags ? JSON.stringify(body.tags) : null,
           body.sort_order || 999, body.price_from || null,
           body.is_featured ? 1 : 0, body.featured_rank || null, body.old_house_hint || null]
        );
        const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
        const pid = r[0].id;
        if (districtId) await syncDistrictStats(conn, districtId);
        await conn.commit();
        const [projs] = await conn.execute(
          'SELECT p.*, d.name AS district_name FROM projects p LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?',
          [pid]
        );
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
              'is_featured', 'featured_rank', 'old_house_hint']) {
            if (col in body) put(col, body[col]);
          }
          if ('tags' in body) put('tags', body.tags ? JSON.stringify(body.tags) : null);
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
             body.tags ? JSON.stringify(body.tags) : null,
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
          if ('tags' in body) put('tags', body.tags ? JSON.stringify(body.tags) : null);
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
          if (proj.channel !== 'bzf') { conn.end(); return jsonReply(res, { error: '仅保租房项目可提交好房子评级' }, 400); }
          if (proj.rating_status === 'pending') { conn.end(); return jsonReply(res, { error: '已在复核队列中' }, 400); }
          let rating = {};
          if (proj.rating) {
            try { rating = JSON.parse(proj.rating); } catch (_) { rating = {}; }
          }
          const dims = rating.dims || {};
          if (!['comfort','green','tech','safety'].every(k => dims[k] != null)) {
            conn.end();
            return jsonReply(res, { error: '请先保存四维度自评分' }, 400);
          }
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          rating.code = `SY-BZF-${pid}`;
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
        // 有城市：只返回在该城市有上架商家的类目
        rows = await queryRows(
          `SELECT DISTINCT c.* FROM jz_categories c
           WHERE c.enabled=1
             AND EXISTS (
               SELECT 1 FROM jz_skus s
               JOIN jz_products p ON p.channel_sku_id=s.id AND p.status='on'
               JOIN jz_vendors v ON v.id=p.vendor_id AND v.status='active'
               WHERE s.category_id=c.id
                 AND (v.city_ids IS NULL OR v.city_ids=''
                      OR FIND_IN_SET(?, REPLACE(v.city_ids, ' ', '')))
             )
           ORDER BY c.sort_order, c.id`,
          [cityName]
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
        sql += ` AND EXISTS (
                  SELECT 1 FROM jz_products p2
                  JOIN jz_vendors v2 ON v2.id=p2.vendor_id
                  WHERE p2.channel_sku_id=s.id AND p2.status='on'
                    AND v2.status='active'
                    AND (v2.city_ids IS NULL OR v2.city_ids=''
                         OR FIND_IN_SET(?, REPLACE(v2.city_ids, ' ', '')))
                )`;
        params.push(cityName);
      }
      if (categoryId) { sql += ' AND s.category_id=?'; params.push(categoryId); }
      if (q) {
        sql += ' AND (s.name LIKE ? OR s.spec LIKE ?)';
        params.push('%' + q + '%', '%' + q + '%');
      }
      sql += ' ORDER BY s.category_id, s.sort_order, s.id';
      const rows = await queryRows(sql, params);
      return jsonReply(res, { items: rows });
    }

    // GET /api/juzhu/jiazheng/skus/:slug
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/skus\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        const skus = await queryRows(
          `SELECT s.*, c.name AS category_name FROM jz_skus s
           JOIN jz_categories c ON c.id=s.category_id
           WHERE s.slug=? AND s.enabled=1`,
          [slug]
        );
        if (!skus.length) return jsonReply(res, { error: 'not found' }, 404);
        const sku = skus[0];
        const qp = new URLSearchParams(qs);
        const vendorId = qp.get('vendor') ? parseInt(qp.get('vendor')) : null;
        let vendorSql = `SELECT v.*, p.id AS product_id, p.price, p.original_price,
                           p.title, p.subtitle, p.sales_count, p.rating AS product_rating,
                           p.service_tags, p.advance_booking_hours
                         FROM jz_vendors v
                         JOIN jz_products p ON p.vendor_id=v.id
                         WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'`;
        const vParams = [sku.id];
        if (vendorId) { vendorSql += ' AND v.id=?'; vParams.push(vendorId); }
        vendorSql += ' ORDER BY v.sort_order, v.id LIMIT 10';
        const vendors = await queryRows(vendorSql, vParams);
        const related = await queryRows(
          `SELECT id, name, slug, cover_image, price_from, price_unit, rating_score, category_id
           FROM jz_skus WHERE enabled=1 AND id!=? ORDER BY sort_order LIMIT 4`,
          [sku.id]
        );
        return jsonReply(res, { sku, vendors, related });
      }
    }

    // GET /api/juzhu/jiazheng/workers
    if (urlPath === '/api/juzhu/jiazheng/workers' && req.method === 'GET') {
      const rows = await queryRows(
        'SELECT * FROM jz_workers WHERE status=? ORDER BY credit_score DESC, completed_orders DESC LIMIT 20',
        ['active']
      );
      return jsonReply(res, { items: rows });
    }

    // GET /api/juzhu/jiazheng/orders （需 API Key 或 phone 参数）
    if (urlPath === '/api/juzhu/jiazheng/orders' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const phone = (qp.get('phone') || '').trim();
      const expected = expectedApiKey();
      const provided = providedApiKey(req);
      if (!phone && !apiKeyMatches(provided, expected)) {
        return jsonReply(res, { error: 'unauthorized' }, 401);
      }
      let sql = `SELECT o.*, s.name AS sku_name FROM jz_orders o
                 LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE 1=1`;
      const params = [];
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
      sql += ' ORDER BY o.created_at DESC LIMIT ?';
      params.push(limit);
      const rows = await queryRows(sql, params);
      return jsonReply(res, { items: rows });
    }

    // GET /api/juzhu/jiazheng/orders/stats （需 API Key，必须在 orders/:id 之前）
    if (urlPath === '/api/juzhu/jiazheng/orders/stats' && req.method === 'GET') {
      if (!requireApiKey(req, res)) return;
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
        const orderId = m[1];
        const rows = await queryRows(
          `SELECT o.*, s.name AS sku_name FROM jz_orders o
           LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE o.id=?`,
          [orderId]
        );
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        return jsonReply(res, rows[0]);
      }
    }

    // ===== 公开 C 端读接口 =====

    // GET /api/juzhu/cities
    if (urlPath === '/api/juzhu/cities' && req.method === 'GET') {
      const rows = await queryRows('SELECT * FROM cities ORDER BY id');
      return jsonReply(res, rows);
    }

    // GET /api/juzhu/ratings（按 rating_status 列出保租房评级）
    if (urlPath === '/api/juzhu/ratings' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = `SELECT p.*, d.name AS district_name FROM projects p
                 LEFT JOIN districts d ON d.id=p.district_id
                 WHERE p.channel='bzf' AND p.rating_status IN ('pending','passed','rejected')`;
      const params = [];
      if (qp.get('status')) { sql += ' AND p.rating_status=?'; params.push(qp.get('status')); }
      sql += " ORDER BY COALESCE(p.rating_submitted_at,'') DESC, p.id";
      const rows = await queryRows(sql, params);
      return jsonReply(res, rows);
    }

    // GET /api/juzhu/ratings/:code
    {
      const m = urlPath.match(/^\/api\/juzhu\/ratings\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const code = decodeURIComponent(m[1]);
        // code 格式 SY-BZF-{id}，直接按 id 查
        const idMatch = code.match(/-(\d+)$/);
        let proj = null;
        if (idMatch) {
          const rows = await queryRows(
            `SELECT p.*, d.name AS district_name FROM projects p
             LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=? AND p.channel='bzf'`,
            [parseInt(idMatch[1])]
          );
          if (rows.length) proj = rows[0];
        }
        if (!proj) return jsonReply(res, { error: 'not found' }, 404);
        return jsonReply(res, { project: proj });
      }
    }

    // GET /api/juzhu/trade
    if (urlPath === '/api/juzhu/trade' && req.method === 'GET') {
      const rows = await queryRows(
        "SELECT id,name,slug,cover_image,address,tags,sort_order,unit_count,price_from,is_featured,featured_rank,old_house_hint FROM projects WHERE channel='trade' ORDER BY is_featured DESC, featured_rank, sort_order"
      );
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
          "SELECT id,name,slug,cover_image,address,tags,sort_order,unit_count,managed_unit_count,price_from,is_featured FROM projects WHERE district_id=? AND channel='bzf' ORDER BY sort_order",
          [dist.id]
        );
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
          ? 'SELECT id,name,slug,cover_image,address,tags,sort_order,unit_count,managed_unit_count,price_from,is_featured,channel,district_id,rating_status,rating FROM projects WHERE id=?'
          : 'SELECT id,name,slug,cover_image,address,tags,sort_order,unit_count,managed_unit_count,price_from,is_featured,channel,district_id,rating_status,rating FROM projects WHERE slug=?';
        const rows = await queryRows(sql, [isId ? parseInt(slug) : slug]);
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        return jsonReply(res, rows[0]);
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
        // 脱敏，不暴露 contact_phone
        delete proj.contact_phone;
        return jsonReply(res, { project: proj, units, photos });
      }
    }

    // ===== admin auth 接口 =====

    // POST /api/juzhu/admin/auth/login
    if (urlPath === '/api/juzhu/admin/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const pwd = (body.password || '').trim();
      const expected = (process.env.JUZHU_ADMIN_PASSWORD || '').trim();
      if (!pwd || !expected || !crypto.timingSafeEqual(
        crypto.createHash('sha256').update(pwd).digest(),
        crypto.createHash('sha256').update(expected).digest()
      )) {
        return jsonReply(res, { error: '密码错误' }, 401);
      }
      const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
      const sig = crypto.createHmac('sha256', expected).update(String(exp)).digest('hex');
      return jsonReply(res, { token: `${exp}.${sig}`, expires_at: new Date(exp * 1000).toISOString() });
    }

    // GET /api/juzhu/admin/auth/check
    if (urlPath === '/api/juzhu/admin/auth/check' && req.method === 'GET') {
      const authHeader = (req.headers.authorization || '').trim();
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const expected = (process.env.JUZHU_ADMIN_PASSWORD || '').trim();
      if (!token || !expected) return jsonReply(res, { ok: false }, 401);
      const [expStr, sig] = token.split('.');
      const exp = parseInt(expStr);
      if (!exp || Date.now() / 1000 > exp) return jsonReply(res, { ok: false, error: 'expired' }, 401);
      const expectedSig = crypto.createHmac('sha256', expected).update(String(exp)).digest('hex');
      const sigBuf = Buffer.from(sig || '', 'hex');
      const expBuf = Buffer.from(expectedSig, 'hex');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return jsonReply(res, { ok: false }, 401);
      }
      return jsonReply(res, { ok: true, expires_at: new Date(exp * 1000).toISOString() });
    }

    // GET /api/juzhu/admin/districts（admin 前缀，需鉴权）
    if (urlPath === '/api/juzhu/admin/districts' && req.method === 'GET') {
      if (!requireApiKey(req, res)) return;
      const rows = await queryRows('SELECT * FROM districts ORDER BY sort_order');
      return jsonReply(res, rows);
    }

    // POST /api/juzhu/admin/ratings/:code/review
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/ratings\/([^/]+)\/review$/);
      if (m && req.method === 'POST') {
        if (!requireApiKey(req, res)) return;
        const code = decodeURIComponent(m[1]);
        const idMatch = code.match(/-(\d+)$/);
        if (!idMatch) return jsonReply(res, { error: 'invalid code' }, 400);
        const pid = parseInt(idMatch[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM projects WHERE id=? AND channel=? AND rating_status=?', [pid, 'bzf', 'pending']);
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
        if (!requireApiKey(req, res)) return;
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
          const [updated] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          return jsonReply(res, { ok: true, order: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // POST /api/juzhu/jiazheng/orders/:id/advance（推进状态）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/orders\/([^/]+)\/advance$/);
      if (m && req.method === 'POST') {
        if (!requireApiKey(req, res)) return;
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
          const [updated] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          return jsonReply(res, { ok: true, order: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // POST /api/juzhu/jiazheng/orders/:id/rate（评价，C端无需鉴权）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/orders\/([^/]+)\/rate$/);
      if (m && req.method === 'POST') {
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
        v.products = await queryRows(
          "SELECT * FROM jz_products WHERE vendor_id=? AND status='on' ORDER BY sort_order, id LIMIT 2",
          [v.id]
        );
      }
      return jsonReply(res, { list: vendors });
    }

    // GET /api/juzhu/jz/vendors/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/jz\/vendors\/(\d+)$/);
      if (m && req.method === 'GET') {
        const rows = await queryRows('SELECT * FROM jz_vendors WHERE id=?', [parseInt(m[1])]);
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        const v = rows[0];
        v.products = await queryRows("SELECT * FROM jz_products WHERE vendor_id=? AND status='on' ORDER BY sort_order", [v.id]);
        return jsonReply(res, v);
      }
    }

    // GET /api/juzhu/jz/products
    if (urlPath === '/api/juzhu/jz/products' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = 'SELECT p.*, v.name AS vendor_name, v.type AS vendor_type FROM jz_products p LEFT JOIN jz_vendors v ON v.id=p.vendor_id WHERE 1=1';
      const params = [];
      if (qp.get('vendor_id')) { sql += ' AND p.vendor_id=?'; params.push(parseInt(qp.get('vendor_id'))); }
      if (qp.get('type')) { sql += ' AND v.type=?'; params.push(qp.get('type')); }
      if (qp.get('status')) { sql += ' AND p.status=?'; params.push(qp.get('status')); }
      sql += ' ORDER BY p.vendor_id, p.sort_order, p.id LIMIT 200';
      const rows = await queryRows(sql, params);
      return jsonReply(res, { list: rows });
    }

    // GET /api/juzhu/jz/products/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/jz\/products\/(\d+)$/);
      if (m && req.method === 'GET') {
        const rows = await queryRows('SELECT p.*, v.name AS vendor_name FROM jz_products p LEFT JOIN jz_vendors v ON v.id=p.vendor_id WHERE p.id=?', [parseInt(m[1])]);
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        return jsonReply(res, rows[0]);
      }
    }

    // GET /api/juzhu/jz/workers
    if (urlPath === '/api/juzhu/jz/workers' && req.method === 'GET') {
      const rows = await queryRows("SELECT * FROM jz_workers WHERE status='active' ORDER BY credit_score DESC, completed_orders DESC");
      return jsonReply(res, { list: rows });
    }

    // GET /api/juzhu/jz/workers/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/jz\/workers\/(\d+)$/);
      if (m && req.method === 'GET') {
        const rows = await queryRows('SELECT * FROM jz_workers WHERE id=?', [parseInt(m[1])]);
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        return jsonReply(res, rows[0]);
      }
    }

    // GET /api/juzhu/jz/orders
    if (urlPath === '/api/juzhu/jz/orders' && req.method === 'GET') {
      if (!requireApiKey(req, res)) return;
      const qp = new URLSearchParams(qs);
      let sql = 'SELECT o.*, s.name AS sku_name FROM jz_orders o LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE 1=1';
      const params = [];
      if (qp.get('status')) { sql += ' AND o.status=?'; params.push(qp.get('status')); }
      const limit = Math.min(parseInt(qp.get('limit') || '50'), 200);
      sql += ' ORDER BY o.created_at DESC LIMIT ?'; params.push(limit);
      const rows = await queryRows(sql, params);
      return jsonReply(res, { list: rows });
    }

    // GET /api/juzhu/jz/orders/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/jz\/orders\/([^/]+)$/);
      if (m && req.method === 'GET') {
        if (!requireApiKey(req, res)) return;
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
          sql += ` AND (v.city_ids IS NULL OR v.city_ids='' OR FIND_IN_SET(?, REPLACE(v.city_ids,' ','')))`;
          params.push(cityName);
        }
        sql += ' ORDER BY v.sort_order, v.id LIMIT 20';
        const vendors = await queryRows(sql, params);
        return jsonReply(res, { vendors });
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

// 反向代理：将请求转发到 Python 服务，失败则 fallback 到 Node.js 直连
// 先缓冲 body，确保 fallback 时 readBody() 仍可读取
function proxyToPythonWithFallback(urlPath, qs, req, res) {
  // 缓冲请求体，以便 fallback 时 handleApiDirect 可以重新解析
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    req._rawBody = rawBody;

    const options = {
      hostname: '127.0.0.1',
      port: PYTHON_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    };
    const proxyReq = http.request(options, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });
    proxyReq.on('error', () => {
      // Python 不可用，尝试 Node.js 直连 MySQL
      handleApiDirect(urlPath, qs, req, res);
    });
    // 将已缓冲的 body 写入代理请求
    if (rawBody) proxyReq.write(rawBody);
    proxyReq.end();
  });
}

const server = http.createServer((req, res) => {
  const rawPath = req.url.split('?')[0];
  const qs = req.url.includes('?') ? req.url.split('?')[1] : '';

  // CORS preflight
  if (req.method === 'OPTIONS' && rawPath.startsWith('/api/juzhu')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    });
    res.end();
    return;
  }

  // /api/juzhu/* 先代理到 Python，失败则 fallback 到 Node.js
  if (rawPath.startsWith('/api/juzhu')) {
    return proxyToPythonWithFallback(rawPath, qs, req, res);
  }

  if (!isPublicStatic(rawPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  let filePath_decoded = decodeURIComponent(rawPath);
  if (filePath_decoded === '/') filePath_decoded = '/index.html';

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
    console.log('auth: /api/juzhu/admin/* requires API Key (auth/login|check exempt); forbidden historical default');
    console.log('static: blocked .env / source / deploy artifacts / API docs');
    // 启动时主动执行一次 ensureSchema（建表 + 家政种子数据），不等待
    ensureSchema().then(() => console.log('ensureSchema done')).catch(e => console.warn('ensureSchema warn:', e.message));
  });
}
