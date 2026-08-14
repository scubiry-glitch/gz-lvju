// 一次性把源 MySQL(juzhu) 快照灌入当前库。文件缺失或已导入则跳过。
'use strict';

const fs = require('fs');
const path = require('path');

const DUMP_FILE = path.join(__dirname, 'juzhu', '_mysql_dump.json');
/** 房源表由 housing_seed 从 data*.json 灌入；源库这些表是空的，且 city id 与 JSON 不一致 */
const SKIP_TABLES = new Set(['districts', 'projects', 'units', 'photos']);
const TABLE_ORDER = [
  'channels', 'settings', 'jz_categories', 'jz_skus',
  'jz_vendors', 'jz_products', 'jz_workers', 'jz_subcategories',
  'jz_sku_workers', 'jz_sku_slots', 'jz_orders', 'jz_activities',
  'gr_orders',
];

function encodeValue(v) {
  if (v == null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function dumpPath() {
  return DUMP_FILE;
}

function loadDump(filePath) {
  const p = filePath || DUMP_FILE;
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return raw && raw.tables ? raw : null;
}

async function tableColumns(conn, table) {
  const [rows] = await conn.execute(`SHOW COLUMNS FROM \`${table}\``);
  return new Set(rows.map((r) => r.Field));
}

async function tableExists(conn, table) {
  const [rows] = await conn.execute(
    'SELECT 1 AS x FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=? LIMIT 1',
    [table]
  );
  return rows.length > 0;
}

async function upsertRows(conn, table, rows) {
  if (!rows || !rows.length) return 0;
  const cols = await tableColumns(conn, table);
  let n = 0;
  for (const row of rows) {
    const keys = Object.keys(row).filter((k) => cols.has(k));
    if (!keys.length) continue;
    const placeholders = keys.map(() => '?').join(',');
    const updates = keys.filter((k) => k !== 'id').map((k) => `\`${k}\`=VALUES(\`${k}\`)`).join(',');
    const sql = updates
      ? `INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`
      : `INSERT IGNORE INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${placeholders})`;
    await conn.execute(sql, keys.map((k) => encodeValue(row[k])));
    n += 1;
  }
  return n;
}

/** 北京/上海等源库多出来的城市按 slug 追加，不覆盖 JSON 种子的 1沈阳/2南京/3贵阳 */
async function importExtraCities(conn, rows) {
  if (!rows || !rows.length) return 0;
  const [[m]] = await conn.execute('SELECT COALESCE(MAX(id),0) AS m FROM cities');
  let nextId = Number(m.m) + 1;
  let n = 0;
  for (const row of rows) {
    const slug = (row.slug || '').trim();
    const name = (row.name || '').trim();
    if (!slug || !name) continue;
    const [exist] = await conn.execute('SELECT id FROM cities WHERE slug=? OR name=? LIMIT 1', [slug, name]);
    if (exist.length) continue;
    await conn.execute(
      'INSERT INTO cities(id, name, slug, booking_phone, hero_bg_image) VALUES (?,?,?,?,?)',
      [nextId, name, slug, row.booking_phone || null, row.hero_bg_image || null]
    );
    nextId += 1;
    n += 1;
  }
  return n;
}

async function importAll(conn, filePath) {
  const dump = loadDump(filePath);
  if (!dump) return { skipped: true, reason: 'no-dump' };

  const inserted = {};
  inserted.cities = await importExtraCities(conn, dump.tables.cities || []);

  const names = TABLE_ORDER.filter((t) => !SKIP_TABLES.has(t) && Array.isArray(dump.tables[t]));
  for (const extra of Object.keys(dump.tables)) {
    if (!names.includes(extra) && extra !== 'cities' && !SKIP_TABLES.has(extra)) names.push(extra);
  }

  for (const table of names) {
    if (!(await tableExists(conn, table))) continue;
    const rows = dump.tables[table] || [];
    if (!rows.length) continue;
    inserted[table] = await upsertRows(conn, table, rows);
  }
  return { skipped: false, inserted };
}

module.exports = {
  DUMP_FILE,
  SKIP_TABLES,
  TABLE_ORDER,
  encodeValue,
  dumpPath,
  loadDump,
  importAll,
};
