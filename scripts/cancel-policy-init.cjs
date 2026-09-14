#!/usr/bin/env node
// cancel-policy-init.cjs — 房型级「免费取消政策」预配（口径 2026-09-09，幂等可重跑）
//
// 给「已开通按晚预订」项目（projects.ext.stay_bookable=true，rental/minsu）下的全部房型
// 补默认政策：units.ext.cancel_policy = {enabled:true, days_before:1, cutoff_time:'18:00'}
//   = 「入住前一天 18:00 前可免费取消，之后不可取消」（stay_config.cjs CANCEL_POLICY_DEFAULT 同口径）。
// 缺省从严 = 未开通即不可取消；本脚本只为存量已开通项目兜底演示/续用体验，
// 业务侧后续在 B 端房态页「取消政策」卡 / admin 房型详情页 / HMAC units/update 按房型调整。
//
//   seed  只填缺失的 cancel_policy（已有配置——含 enabled:false——一律不动）
//   clean 移除「与默认政策完全一致」的 cancel_policy（业务自定义过的配置不动）
//
// 用法：node scripts/cancel-policy-init.cjs [seed|clean]
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

const DEFAULT_POLICY = { enabled: true, days_before: 1, cutoff_time: '18:00' };

function parseExt(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try {
    const o = JSON.parse(v);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (_) { return {}; }
}

function samePolicy(a, b) {
  return !!a && typeof a === 'object'
    && a.enabled === b.enabled && a.days_before === b.days_before && a.cutoff_time === b.cutoff_time;
}

async function main() {
  const mode = (process.argv[2] || 'seed').toLowerCase();
  if (!['seed', 'clean'].includes(mode)) {
    console.error('用法：node scripts/cancel-policy-init.cjs [seed|clean]');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10),
    user: process.env.MYSQL_USER || process.env.JUZHU_DB_USER || 'juzhu',
    password: process.env.MYSQL_PASSWORD || process.env.JUZHU_DB_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || process.env.JUZHU_DB_NAME || 'juzhu',
  });

  try {
    const [projs] = await conn.execute(
      "SELECT id, name FROM projects WHERE channel IN ('rental','minsu')" +
      ' AND JSON_VALID(ext) AND JSON_EXTRACT(ext,\'$.stay_bookable\')=true'
    );
    console.log(`已开通按晚预订项目: ${projs.length} 个（${mode}）`);
    let seeded = 0, cleaned = 0, kept = 0;
    for (const p of projs) {
      const [units] = await conn.execute('SELECT id, name, ext FROM units WHERE project_id=?', [p.id]);
      for (const u of units) {
        const ext = parseExt(u.ext);
        if (mode === 'clean') {
          if (samePolicy(ext.cancel_policy, DEFAULT_POLICY)) {
            delete ext.cancel_policy;
            await conn.execute('UPDATE units SET ext=? WHERE id=?', [Object.keys(ext).length ? JSON.stringify(ext) : null, u.id]);
            cleaned++;
            console.log(`  cleaned #${p.id}.${u.id} ${u.name}`);
          }
          continue;
        }
        if (ext.cancel_policy !== undefined) { kept++; continue; }
        ext.cancel_policy = { ...DEFAULT_POLICY };
        await conn.execute('UPDATE units SET ext=? WHERE id=?', [JSON.stringify(ext), u.id]);
        seeded++;
        console.log(`  seeded #${p.id}.${u.id} ${u.name}`);
      }
    }
    console.log(mode === 'clean'
      ? `clean 完成：移除 ${cleaned} 个房型的默认政策（业务自定义配置不动）`
      : `cancel_policy seeded: ${seeded} 个房型（已有配置保留 ${kept}，未动）`);
  } finally {
    await conn.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
