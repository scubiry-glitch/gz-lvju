#!/usr/bin/env node
/**
 * SQLite → MySQL 一次性迁移（Node 版，对齐 juzhu/migrate_to_mysql.py）
 *
 * 用法:
 *   node migrate_to_mysql.cjs [sqlite.db 路径]
 *
 * 默认源: /tmp/test_juzhu.db
 * 目标: MYSQL_* 或 JUZHU_DB_*（与 app.js 同一套环境变量）
 *
 * 流程:
 *   1. 只读打开 SQLite，统计各表行数
 *   2. 先跑 ensureSchema 建表（幂等）
 *   3. SET FOREIGN_KEY_CHECKS=0 → 逐表 DELETE → 按依赖顺序导入
 *      （只写入目标库已有的列，兼容 Node / Python 两套 DDL 差异）
 *   4. ISO 时间归一化为 "YYYY-MM-DD HH:MM:SS"
 *   5. 行数校验，不一致退出码 1
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname);
const TABLES = [
  'cities', 'districts', 'projects', 'units', 'photos',
  'channels', 'settings',
  'jz_categories', 'jz_skus', 'jz_orders',
  'jz_vendors', 'jz_products', 'jz_workers', 'jz_subcategories', 'jz_activities',
  'jz_sku_workers', 'jz_sku_slots',
  'gr_orders',
];
const TS_COLUMNS = {
  jz_orders: new Set(['created_at', 'updated_at', 'pay_at']),
  gr_orders: new Set(['created_at', 'updated_at', 'paid_at', 'completed_at']),
  projects: new Set(['rating_submitted_at', 'rating_reviewed_at']),
  jz_activities: new Set(['fetched_at']),
  jz_vendors: new Set(['created_at', 'updated_at']),
};
const ISO_TS_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;
const BATCH = 200;

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let text = '';
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (_) { return false; }
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

loadDotEnv(path.join(ROOT, '.env'));
loadDotEnv(path.join(ROOT, 'juzhu', '.env.local'));
loadDotEnv(path.join(ROOT, 'juzhu', '.env'));

function normalizeTs(table, column, value) {
  if (!TS_COLUMNS[table] || !TS_COLUMNS[table].has(column) || typeof value !== 'string') return value;
  const m = value.match(ISO_TS_RE);
  return m ? m[1] + ' ' + m[2] : value;
}

function sqliteViaNodeSqlite(src, table) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    const cols = info.map((r) => r.name);
    if (!cols.length) return { cols: [], rows: [] };
    const raw = db.prepare(`SELECT * FROM ${table}`).all();
    const rows = raw.map((row) => cols.map((c) => normalizeTs(table, c, row[c])));
    return { cols, rows };
  } finally {
    db.close();
  }
}

function sqliteViaCli(src, table) {
  const infoRaw = execFileSync('sqlite3', ['-json', src, `PRAGMA table_info(${table})`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
  const info = infoRaw ? JSON.parse(infoRaw) : [];
  const cols = (info || []).map((r) => r.name);
  if (!cols.length) return { cols: [], rows: [] };
  const dataRaw = execFileSync('sqlite3', ['-json', src, `SELECT * FROM ${table}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
  const raw = dataRaw ? JSON.parse(dataRaw) : [];
  const rows = (raw || []).map((row) => cols.map((c) => normalizeTs(table, c, row[c])));
  return { cols, rows };
}

function readSqliteTable(src, table) {
  try {
    return sqliteViaNodeSqlite(src, table);
  } catch (_) {
    try {
      return sqliteViaCli(src, table);
    } catch (e) {
      console.warn('  skip ' + table + ' (' + (e.message || e) + ')');
      return { cols: [], rows: [] };
    }
  }
}

async function mysqlColumns(conn, table) {
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

async function migrate(conn, data) {
  await conn.query('SET FOREIGN_KEY_CHECKS=0');
  try {
    for (const table of TABLES) {
      if (!(await tableExists(conn, table))) continue;
      await conn.query('DELETE FROM `' + table + '`');
    }
    for (const table of TABLES) {
      const pack = data[table];
      if (!pack || !pack.rows.length) continue;
      if (!(await tableExists(conn, table))) {
        console.warn('  ! ' + table + ' 目标表不存在，跳过');
        continue;
      }
      const destCols = await mysqlColumns(conn, table);
      const idx = pack.cols.map((c, i) => destCols.has(c) ? i : -1).filter((i) => i >= 0);
      const cols = idx.map((i) => pack.cols[i]);
      if (!cols.length) continue;
      const colSql = cols.map((c) => '`' + c + '`').join(',');
      const ph = '(' + cols.map(() => '?').join(',') + ')';
      for (let i = 0; i < pack.rows.length; i += BATCH) {
        const batch = pack.rows.slice(i, i + BATCH);
        const sql = `INSERT INTO \`${table}\` (${colSql}) VALUES ${batch.map(() => ph).join(',')}`;
        const flat = [];
        for (const row of batch) {
          for (const j of idx) flat.push(row[j]);
        }
        await conn.query(sql, flat);
      }
    }
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS=1');
  }
}

async function main() {
  const src = path.resolve(process.argv[2] || '/tmp/test_juzhu.db');
  if (!fs.existsSync(src)) {
    console.error('源库不存在: ' + src);
    process.exit(2);
  }

  const data = {};
  console.log('源库: ' + src);
  for (const t of TABLES) {
    data[t] = readSqliteTable(src, t);
    if (data[t].rows.length) console.log('  ' + t + '  ' + data[t].rows.length + ' 行');
  }

  const app = require('./app.js');
  if (!app.ensureSchema || !app.getDbConfig) {
    console.error('app.js 未导出 ensureSchema / getDbConfig');
    process.exit(2);
  }
  await app.ensureSchema();
  const mysql2 = require('mysql2/promise');
  const cfg = app.getDbConfig();
  console.log('目标: mysql://%s@%s:%s/%s', cfg.user, cfg.host, cfg.port, cfg.database);
  const conn = await mysql2.createConnection(cfg);
  try {
    await migrate(conn, data);
    let ok = true;
    for (const t of TABLES) {
      if (!(await tableExists(conn, t))) continue;
      const [rows] = await conn.execute('SELECT COUNT(*) AS c FROM `' + t + '`');
      const dst = Number(rows[0].c);
      const srcCount = data[t].rows.length;
      if (dst !== srcCount) {
        console.log('  ! ' + t + ' 源 ' + srcCount + ' ≠ 目标 ' + dst);
        ok = false;
      }
    }
    console.log(ok ? '迁移完成，行数校验一致' : '迁移完成：行数不一致，见上');
    process.exit(ok ? 0 : 1);
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { normalizeTs, TABLES };
