#!/usr/bin/env node
// stay-bookable-init.cjs — 「按晚预订」能力开关一次性迁移（口径 2026-09-05，幂等可重跑）
//
//   1) 备份 stay_calendar → stay_calendar_bak_20260905（存在则跳过）
//   2) 种开关：channel=minsu 全部 + channel=rental 且 tags 含「旅居」→ ext.stay_bookable=true
//      其余项目不写（缺省 = 仅 400 电话咨询；tag 不参与运行时判断，这里只决定初始态）
//   3) 清除 rental 频道房态差异行（长租/保租房不开通预订，房态不对外）
//   4) 重建 booked 行：只从「存在且已开通」项目的 pending/confirmed 订单重建
//      （DELETE source='booking' 全量 + JOIN projects，顺带清理已删项目孤儿行）
//   5) 报告：未开通项目上的残留有效订单（其房态占用已释放，订单数据不动）
//
// 用法：node scripts/stay-bookable-init.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// env 加载（与 stay-calendar-init.cjs 同一份，first-wins：juzhu/.env.local > .env > runtime.env）
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

function parseExt(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try {
    const o = JSON.parse(v);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (_) { return {}; }
}

const BAK_TABLE = 'stay_calendar_bak_20260905';
const pad2 = (n) => String(n).padStart(2, '0');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10),
    user: process.env.MYSQL_USER || process.env.JUZHU_DB_USER || 'juzhu',
    password: process.env.MYSQL_PASSWORD || process.env.JUZHU_DB_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || process.env.JUZHU_DB_NAME || 'juzhu',
  });

  try {
    // ── 1. 备份（快照表 + 存在即跳过，与 migrate-housing-channels.cjs 同模式）──
    const [ex] = await conn.query('SHOW TABLES LIKE ?', [BAK_TABLE]);
    if (!ex.length) {
      await conn.query(`CREATE TABLE \`${BAK_TABLE}\` AS SELECT * FROM stay_calendar`);
      console.log(`backup: stay_calendar → ${BAK_TABLE}`);
    } else {
      console.log(`backup: ${BAK_TABLE} 已存在，跳过`);
    }

    // ── 2. 种开关（skip-if-set = 幂等）──
    const [projs] = await conn.execute(
      "SELECT id, name, channel, tags, ext FROM projects WHERE channel IN ('rental','minsu')"
    );
    let seeded = 0, skipped = 0;
    for (const p of projs) {
      let tags = [];
      try { tags = JSON.parse(p.tags || '[]'); } catch (_) { tags = []; }
      const target = p.channel === 'minsu' || tags.includes('旅居');
      if (!target) continue;
      const ext = parseExt(p.ext);
      if (ext.stay_bookable === true) { skipped++; continue; }
      ext.stay_bookable = true;
      await conn.execute('UPDATE projects SET ext=? WHERE id=?', [JSON.stringify(ext), p.id]);
      seeded++;
      console.log(`  seeded #${p.id} ${p.name}（${p.channel}）`);
    }
    console.log(`stay_bookable seeded: ${seeded} 个项目（已开通跳过 ${skipped}）`);

    // ── 3. 清除 rental 频道房态差异行 ──
    const [del] = await conn.query(
      "DELETE sc FROM stay_calendar sc JOIN projects p ON p.id=sc.project_id WHERE p.channel='rental'"
    );
    console.log(`rental 房态清除: ${del.affectedRows} 行`);

    // ── 4. 重建 booked 行（只重建「存在且已开通」项目的有效订单）──
    const [brows] = await conn.query(
      "SELECT id FROM projects WHERE JSON_VALID(ext) AND JSON_EXTRACT(ext,'$.stay_bookable')=true"
    );
    const bookSet = new Set(brows.map((r) => r.id));
    await conn.query("DELETE FROM stay_calendar WHERE source='booking'");
    let nights = 0;
    if (bookSet.size) {
      const ph = Array.from(bookSet).map(() => '?').join(',');
      const [orders] = await conn.execute(
        `SELECT id, project_id, unit_id, checkin, checkout FROM booking_orders
         WHERE status IN ('pending','confirmed') AND project_id IN (${ph})`,
        Array.from(bookSet)
      );
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      for (const o of orders) {
        const start = new Date(o.checkin + 'T00:00:00');
        const end = new Date(o.checkout + 'T00:00:00');
        for (let d = new Date(start); d < end && nights < 36500; d.setDate(d.getDate() + 1)) {
          const ds = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
          await conn.execute(
            `INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, price_night, source, booking_id, updated_at)
             VALUES (?,?,?,'booked',NULL,'booking',?,?)
             ON DUPLICATE KEY UPDATE status='booked', source='booking', booking_id=VALUES(booking_id), updated_at=VALUES(updated_at)`,
            [o.project_id, o.unit_id || 0, ds, o.id, now]
          );
          nights++;
        }
      }
      console.log(`booked 重建: ${orders.length} 单 → ${nights} 晚`);
    }

    // ── 5. 报告：未开通项目上的残留有效订单（房态占用已释放，不改订单数据）──
    const [stale] = await conn.query(
      `SELECT bo.id, bo.order_no, bo.project_id, p.name, p.channel, bo.status
       FROM booking_orders bo JOIN projects p ON p.id=bo.project_id
       WHERE bo.status IN ('pending','confirmed')
         AND NOT (JSON_VALID(p.ext) AND JSON_EXTRACT(p.ext,'$.stay_bookable')=true)`
    );
    if (stale.length) {
      console.log(`⚠ 未开通项目上的残留有效订单 ${stale.length} 条（不再占房态，建议人工取消）：`);
      for (const s of stale) console.log(`  #${s.id} ${s.order_no} ${s.name}(${s.channel}) ${s.status}`);
    }

    // ── 迁移后快照 ──
    const [dist] = await conn.query(
      `SELECT p.channel, sc.status, COUNT(*) n FROM stay_calendar sc
       LEFT JOIN projects p ON p.id=sc.project_id GROUP BY p.channel, sc.status ORDER BY p.channel, sc.status`
    );
    console.log('迁移后 stay_calendar 分布:');
    for (const r of dist) console.log(`  ${r.channel || '(孤儿)'} / ${r.status}: ${r.n} 行`);
  } finally {
    await conn.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
