#!/usr/bin/env node
/**
 * 房态日历 / 保险标识 初始化（一次性回填，可重复执行）
 * 用法：node scripts/stay-calendar-init.cjs
 * 规则14：只用 Node + mysql2；凭证只读环境变量（JUZHU_DB_* / MYSQL_* / juzhu/.env.local）
 *
 * 做两件事：
 *  1) 保险标识回填：rental/minsu 项目 ext.insurance 为空时按频道默认补齐
 *     （rental=换租保险+财产保险，minsu=酒店取消险+财产保险；已有配置不动）
 *  2) 房态回填：把存量 booking_orders（pending/confirmed）重建为 stay_calendar booked 行
 *     （source='booking'，取消/删除订单后由 app.js 自动释放；本脚本只重建映射）
 */
const path = require('path');
const fs = require('fs');
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

const DEFAULT_INSURANCE = { rental: ['switch_rental', 'property'], minsu: ['hotel_cancel', 'property'] };

function parseExt(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { const o = JSON.parse(v); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch (_) { return {}; }
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || 3306),
    user: process.env.MYSQL_USER || process.env.JUZHU_DB_USER,
    password: process.env.MYSQL_PASSWORD || process.env.JUZHU_DB_PASSWORD,
    database: process.env.MYSQL_DB || process.env.JUZHU_DB_NAME,
  });

  // 1) 保险标识回填（缺配置才补，不覆盖商家/平台已设置的组合）
  const [projs] = await conn.execute("SELECT id, channel, ext FROM projects WHERE channel IN ('rental','minsu')");
  let nIns = 0;
  for (const p of projs) {
    const ext = parseExt(p.ext);
    if (Array.isArray(ext.insurance) && ext.insurance.length) continue;
    ext.insurance = DEFAULT_INSURANCE[p.channel] || ['property'];
    await conn.execute('UPDATE projects SET ext=? WHERE id=?', [JSON.stringify(ext), p.id]);
    nIns += 1;
  }
  console.log(`insurance backfilled: ${nIns}/${projs.length} projects`);

  // 2) 存量订单 → 房态 booked 行（先清 booking 来源差异行，再按当前有效订单重建）
  await conn.execute("DELETE FROM stay_calendar WHERE source='booking'");
  const [orders] = await conn.execute(
    "SELECT id, project_id, unit_id, checkin, checkout FROM booking_orders WHERE status IN ('pending','confirmed')"
  );
  let nDays = 0;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  for (const o of orders) {
    const start = new Date(o.checkin + 'T00:00:00');
    const end = new Date(o.checkout + 'T00:00:00');
    if (isNaN(start) || isNaN(end) || !(end > start)) continue;
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      await conn.execute(
        `INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, price_night, source, booking_id, updated_at)
         VALUES (?,?,?,'booked',NULL,'booking',?,?)
         ON DUPLICATE KEY UPDATE status='booked', source='booking', booking_id=VALUES(booking_id), updated_at=VALUES(updated_at)`,
        [o.project_id, o.unit_id || 0, ds, o.id, now]
      );
      nDays += 1;
    }
  }
  console.log(`stay_calendar rebuilt: ${orders.length} orders -> ${nDays} booked nights`);

  await conn.end();
}

main().catch((e) => { console.error('stay-calendar-init failed:', e.message); process.exit(1); });
