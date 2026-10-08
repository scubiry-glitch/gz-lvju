#!/usr/bin/env node
/**
 * 将旧 projects.ext.stay_bookable 迁移为房源级交易能力：
 * - 旧 minsu 已开通 -> 仅 online_payment（保持原预付体验）
 * - 旧 rental 已开通 -> 仅 online_booking（保持原预订体验）
 * - 旧未开通/缺省 -> 仅 online_booking（满足至少一项）
 * 已存在 online_booking / online_payment 的项目只做合法性补齐，不按频道覆盖。
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
const stayCfg = require('../stay_config.cjs');

(async () => {
  const conn = await mysql.createConnection({
    host: (process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '').trim(),
    port: parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10),
    database: (process.env.MYSQL_DB || process.env.JUZHU_DB_NAME || '').trim(),
    user: (process.env.MYSQL_USER || process.env.JUZHU_DB_USER || '').trim(),
    password: process.env.MYSQL_PASSWORD ?? process.env.JUZHU_DB_PASSWORD,
    connectTimeout: 8000,
  });
  try {
    await conn.beginTransaction();
    await conn.execute(`CREATE TABLE IF NOT EXISTS projects_tx_caps_bak_20260916 (
      id INT PRIMARY KEY, channel VARCHAR(30), ext TEXT, backed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await conn.execute(`INSERT IGNORE INTO projects_tx_caps_bak_20260916(id, channel, ext)
      SELECT id, channel, ext FROM projects WHERE channel IN ('rental','minsu')`);
    const [rows] = await conn.execute("SELECT id, channel, ext FROM projects WHERE channel IN ('rental','minsu') FOR UPDATE");
    let changed = 0;
    for (const row of rows) {
      const before = stayCfg.parseExtObj(row.ext);
      const after = stayCfg.applyTransactionCapabilities(before, before, row.channel);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      await conn.execute('UPDATE projects SET ext=? WHERE id=?', [JSON.stringify(after), row.id]);
      changed++;
    }
    await conn.commit();
    console.log(`transaction capabilities migrated: ${changed}/${rows.length}`);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    await conn.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
