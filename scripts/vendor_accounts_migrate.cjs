#!/usr/bin/env node
// vendor_accounts_migrate.cjs — 商家登录态批量并入账号中心（幂等可重跑，2026-09-09）
//
// 对每个「有 login_name」的 jz_vendors，若 accounts 无同名账号则建档：
//   accounts(principal_type='user', vendor_id, login_name, display_name, phone,
//            password_hash = 原样拷贝 jz_vendors.password_hash（bcrypt 遗留格式，
//            首次登录经 verifyPassword 懒升级 scrypt）)
//   account_roles(role_code='vendor_owner', scope='{"level":"vendor","vendor_id":id}')
// 之后商家用原 login_name/密码即可走 POST /vendor/login（别名）或 POST /api/auth/login 统一登录。
// 冲突处理：login_name 已存在但 vendor_id 不同 → 跳过并告警（不覆盖账号中心既有账号）。
// 无 login_name 的商家本来就不能登录，不迁移；jz_vendors.password_hash 列保留仅作回滚。
//
// 用法：node scripts/vendor_accounts_migrate.cjs [--dry]
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// env 加载（first-wins：juzhu/.env.local > .env > runtime.env）
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

const g = (ks, dflt) => {
  for (const k of ks) { const v = (process.env[k] || '').trim(); if (v) return v; }
  return dflt;
};

async function main() {
  const dry = process.argv.includes('--dry');
  const conn = await mysql.createConnection({
    host: g(['MYSQL_HOST', 'JUZHU_DB_HOST'], '127.0.0.1'),
    port: parseInt(g(['MYSQL_PORT', 'JUZHU_DB_PORT'], '3306'), 10),
    user: g(['MYSQL_USER', 'JUZHU_DB_USER'], ''),
    password: process.env.MYSQL_PASSWORD ?? process.env.JUZHU_DB_PASSWORD ?? '',
    database: g(['MYSQL_DB', 'JUZHU_DB_NAME'], ''),
  });

  try {
    const [vendors] = await conn.execute(
      "SELECT id, name, login_name, phone, password_hash, status FROM jz_vendors WHERE login_name IS NOT NULL AND login_name <> '' ORDER BY id"
    );
    console.log(`有登录名的商家: ${vendors.length} 个${dry ? '（dry run）' : ''}`);
    let migrated = 0, skipped = 0, conflicts = 0;
    for (const v of vendors) {
      const [acc] = await conn.execute(
        'SELECT id, vendor_id FROM accounts WHERE login_name=? LIMIT 1', [v.login_name]);
      if (acc.length) {
        if (acc[0].vendor_id && Number(acc[0].vendor_id) !== Number(v.id)) {
          conflicts++;
          console.warn(`  ⚠ 冲突跳过：login_name=${v.login_name} 已被账号 #${acc[0].id}（vendor_id=${acc[0].vendor_id}）占用，商家 #${v.id} 不迁移`);
        } else {
          skipped++;
        }
        continue;
      }
      if (!v.password_hash) {
        skipped++;
        console.warn(`  ⚠ 跳过：商家 #${v.id} ${v.name} 无 password_hash（无法校验旧密码，请重置后入账号中心）`);
        continue;
      }
      if (dry) {
        migrated++;
        console.log(`  [dry] 将建档 #${v.id} ${v.name}（login_name=${v.login_name}）`);
        continue;
      }
      const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      const [ins] = await conn.execute(
        `INSERT INTO accounts(vendor_id, principal_type, login_name, phone, password_hash, display_name, status, created_at, updated_at)
         VALUES (?, 'user', ?, ?, ?, ?, 'active', ?, ?)`,
        [v.id, v.login_name, v.phone || null, v.password_hash, v.name, now, now]
      );
      await conn.execute(
        'INSERT IGNORE INTO account_roles(account_id, role_code, scope) VALUES (?, ?, ?)',
        [ins.insertId, 'vendor_owner', JSON.stringify({ level: 'vendor', vendor_id: v.id })]
      );
      migrated++;
      console.log(`  建档 #${ins.insertId} ← 商家 #${v.id} ${v.name}（login_name=${v.login_name}，密码遗留格式首登懒升级）`);
    }
    console.log(`完成：新建 ${migrated}，已存在 ${skipped}，冲突 ${conflicts}${dry ? '（dry run 未写入）' : ''}`);
  } finally {
    await conn.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
