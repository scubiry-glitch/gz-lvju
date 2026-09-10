#!/usr/bin/env node
/**
 * scripts/perm_roles_resync.cjs —— 内置角色权限面重同步（显式执行，不在启动路径）
 *
 * 把 perm_registry.cjs 折叠出的内置角色权限写回 roles 表 builtin=1 行：
 *   - 库内 builtin=1 行被覆盖为折叠值（对齐注册表单一数据源）
 *   - builtin=0（自定义角色）永不触碰
 * 幂等可重跑；多实例共用一库安全（按主键 upsert）。
 *
 * 用法：node scripts/perm_roles_resync.cjs [--dry]
 * 凭证只读环境变量（自动加载 juzhu/.env.local / .env / runtime.env）。
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

const authCenter = require('../auth_center.cjs');
const mysql = require('mysql2/promise');

(async () => {
  const host = (process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '').trim();
  const db = (process.env.MYSQL_DB || process.env.JUZHU_DB_NAME || '').trim();
  const user = (process.env.MYSQL_USER || process.env.JUZHU_DB_USER || '').trim();
  const password = process.env.MYSQL_PASSWORD ?? process.env.JUZHU_DB_PASSWORD;
  if (!host || !db || !user || password == null || password === '') {
    console.error('MYSQL_* env 不完整（参考 juzhu/.env.example）');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host, port: parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10),
    database: db, user, password, connectTimeout: 8000,
  });
  const [rows] = await conn.execute('SELECT role_code, builtin, permissions FROM roles');
  const dbByCode = new Map(rows.map((r) => [r.role_code, r]));
  let upserted = 0, skipped = 0, inserted = 0;
  for (const r of authCenter.BUILTIN_ROLES) {
    const perms = JSON.stringify(r.permissions);
    const exist = dbByCode.get(r.role_code);
    if (exist && exist.builtin === 0) {
      console.log(`SKIP  ${r.role_code}（库内已改为自定义角色 builtin=0，不覆盖）`);
      skipped++;
      continue;
    }
    if (exist && exist.permissions === perms) continue;
    if (!exist) {
      await conn.execute('INSERT INTO roles(role_code, name, permissions, builtin) VALUES (?,?,?,1)', [r.role_code, r.name, perms]);
      inserted++;
    } else {
      await conn.execute('UPDATE roles SET name=?, permissions=? WHERE role_code=? AND builtin=1', [r.name, perms, r.role_code]);
      upserted++;
    }
  }
  await conn.end();
  console.log(`OK    内置角色同步完成：新增 ${inserted}、更新 ${upserted}、跳过自定义 ${skipped}（共 ${authCenter.BUILTIN_ROLES.length} 个内置角色）`);
})().catch((e) => { console.error('FAIL  ' + e.message); process.exit(1); });
