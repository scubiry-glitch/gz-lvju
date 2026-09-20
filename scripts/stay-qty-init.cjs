#!/usr/bin/env node
// stay-qty-init.cjs — 多间库存一次性迁移（口径 2026-09-10，幂等可重跑）
//
// stored status 收敛：stay_calendar 只写 open/blocked（商家闸门），booked 降级为
// remaining<=0 的派生态。本脚本把旧「整行 booked」占用行转为 booked_qty=1 计数：
//   1) 备份 stay_calendar → stay_calendar_bak_20260910（存在则跳过）
//   2) 补列（qty / booked_qty / units.total_qty / booking_orders.rooms；通常 ensureSchema 已加，防裸库直跑）
//   3) 旧 booked 行 → booked_qty=1 + status='open'
//   4) units.total_qty 空值/非法归一为 1（缺省 1 间 = 存量行为不变）
//   5) 报告：status / booked_qty / total_qty 分布
//
// 用法：node scripts/stay-qty-init.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// env 加载（与 stay-bookable-init.cjs 同一份，first-wins：juzhu/.env.local > .env > runtime.env）
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

const BAK_TABLE = 'stay_calendar_bak_20260910';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10),
    user: process.env.MYSQL_USER || process.env.JUZHU_DB_USER || 'juzhu',
    password: process.env.MYSQL_PASSWORD || process.env.JUZHU_DB_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || process.env.JUZHU_DB_NAME || 'juzhu',
  });

  try {
    // ── 1. 备份（存在即跳过，与 stay-bookable-init.cjs 同模式）──
    const [ex] = await conn.query('SHOW TABLES LIKE ?', [BAK_TABLE]);
    if (!ex.length) {
      await conn.query(`CREATE TABLE \`${BAK_TABLE}\` AS SELECT * FROM stay_calendar`);
      console.log(`backup: stay_calendar → ${BAK_TABLE}`);
    } else {
      console.log(`backup: ${BAK_TABLE} 已存在，跳过`);
    }

    // ── 2. 补列（try/catch 忽略已存在；app.js ensureSchema 的 extraCols/migrations 亦会补）──
    const cols = [
      'ALTER TABLE stay_calendar ADD COLUMN qty INT',
      'ALTER TABLE stay_calendar ADD COLUMN booked_qty INT NOT NULL DEFAULT 0',
      'ALTER TABLE units ADD COLUMN total_qty INT NOT NULL DEFAULT 1',
      'ALTER TABLE booking_orders ADD COLUMN rooms INT NOT NULL DEFAULT 1',
    ];
    for (const sql of cols) {
      try { await conn.execute(sql); } catch (_) { /* 列已存在 */ }
    }
    console.log('columns ensured: stay_calendar.qty/booked_qty, units.total_qty, booking_orders.rooms');

    // ── 3. 旧 booked 行 → booked_qty=1 + status='open'（多间口径；幂等：仅 booked 行受影响）──
    const [u1] = await conn.execute("UPDATE stay_calendar SET booked_qty=1 WHERE status='booked' AND booked_qty=0");
    const [u2] = await conn.execute("UPDATE stay_calendar SET status='open' WHERE status='booked'");
    console.log(`legacy booked rows: ${u1.affectedRows} 行转计数，${u2.affectedRows} 行转 open`);

    // ── 4. units.total_qty 归一（缺省 1 = 存量单间行为不变）──
    const [u3] = await conn.execute('UPDATE units SET total_qty=1 WHERE total_qty IS NULL OR total_qty<1');
    console.log(`units.total_qty normalized: ${u3.affectedRows} 行`);

    // ── 5. 迁移后分布快照 ──
    const [dist] = await conn.query(
      `SELECT status, COUNT(*) n, COALESCE(SUM(booked_qty),0) booked FROM stay_calendar GROUP BY status ORDER BY status`);
    console.log('stay_calendar status 分布:');
    for (const r of dist) console.log(`  ${r.status}: ${r.n} 行（占用计数合计 ${r.booked}）`);
    const [tq] = await conn.query(
      `SELECT total_qty, COUNT(*) n FROM units GROUP BY total_qty ORDER BY total_qty LIMIT 10`);
    console.log('units.total_qty 分布（前 10 档）:');
    for (const r of tq) console.log(`  ${r.total_qty} 间: ${r.n} 个房型`);
  } finally {
    await conn.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
