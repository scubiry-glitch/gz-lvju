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
    ];
    for (const ddl of ddls) {
      await conn.execute(ddl);
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
  });
}
