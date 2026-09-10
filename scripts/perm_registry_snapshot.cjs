#!/usr/bin/env node
/**
 * scripts/perm_registry_snapshot.cjs —— 内置角色权限快照（防漂移闸）
 *
 * 背景：账号中心内置角色的 permissions 正在从「auth_center.cjs 手写」迁移到
 * 「perm_registry.cjs 权限点注册表折叠」（单一数据源）。本脚本固化迁移前基线，
 * 之后每批改动后重跑，折叠结果必须与基线逐条一致——保证"权限点铺到路由"只是
 * 把纸面模型执行到底，不偷改任何角色的实际权限面。
 *
 * 行为：
 *  1. require auth_center.cjs 的 BUILTIN_ROLES，折叠 role_code → permissions（排序）
 *  2. 与 scripts/__fixtures__/perm_roles_baseline.json 比对：
 *     - 无基线文件或 --update → 写入
 *     - 有基线且不一致 → 打印 diff，退出码 1
 *  3. 环境有 MySQL 凭证时（JUZHU_DB_* / MYSQL_*），顺带比对库内 roles.builtin=1 行
 *     与常量是否一致（漂移只告警不失败——库内可能有历史自定义覆盖）
 *
 * 用法：node scripts/perm_registry_snapshot.cjs [--update]
 * 凭证只读环境变量（自动加载 juzhu/.env.local / .env / runtime.env），禁止写入仓库。
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
const FIXTURE = path.join(__dirname, '__fixtures__', 'perm_roles_baseline.json');
const update = process.argv.includes('--update');

/** role_code → 排序后的 permissions（'*' 原样保留） */
function fold(builtinRoles) {
  const out = {};
  for (const r of builtinRoles) {
    out[r.role_code] = {
      name: r.name,
      permissions: [...(r.permissions || [])].sort(),
    };
  }
  return out;
}

function diffKeys(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diffs = [];
  for (const k of keys) {
    if (!a[k]) diffs.push(`- ${k}: 基线有、当前无`);
    else if (!b[k]) diffs.push(`+ ${k}: 当前新增（若非预期，检查 PERMS[].roles 折叠）`);
    else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      const ap = new Set(a[k].permissions);
      const bp = new Set(b[k].permissions);
      const onlyA = a[k].permissions.filter((x) => !bp.has(x));
      const onlyB = b[k].permissions.filter((x) => !ap.has(x));
      diffs.push(`~ ${k}:${onlyA.length ? ' 基线多 ' + onlyA.join(',') : ''}${onlyB.length ? ' 当前多 ' + onlyB.join(',') : ''}`);
    }
  }
  return diffs;
}

const current = fold(authCenter.BUILTIN_ROLES);
let failed = 0;

if (update || !fs.existsSync(FIXTURE)) {
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, JSON.stringify(current, null, 2) + '\n');
  console.log(`OK    基线已${fs.existsSync(FIXTURE) && update ? '更新' : '生成'}: ${path.relative(process.cwd(), FIXTURE)}（${Object.keys(current).length} 个内置角色）`);
} else {
  const baseline = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const diffs = diffKeys(baseline, current);
  if (diffs.length) {
    console.error('FAIL  内置角色权限面相对基线漂移（若确需变更，核对后 node scripts/perm_registry_snapshot.cjs --update）:');
    for (const d of diffs) console.error('      ' + d);
    failed = 1;
  } else {
    console.log(`PASS  内置角色权限面与基线一致（${Object.keys(current).length} 个角色）`);
  }
}

// ── 可选：与库内 roles.builtin=1 比对（只告警）──
(async () => {
  const host = (process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '').trim();
  const db = (process.env.MYSQL_DB || process.env.JUZHU_DB_NAME || '').trim();
  const user = (process.env.MYSQL_USER || process.env.JUZHU_DB_USER || '').trim();
  const password = process.env.MYSQL_PASSWORD ?? process.env.JUZHU_DB_PASSWORD;
  if (host && db && user && password != null && password !== '') {
    try {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({ host, port: parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10), database: db, user, password, connectTimeout: 5000 });
      const [rows] = await conn.execute('SELECT role_code, name, permissions FROM roles WHERE builtin=1');
      await conn.end();
      const dbFold = {};
      for (const r of rows) {
        let perms = [];
        try { perms = JSON.parse(r.permissions) || []; } catch (_) {}
        dbFold[r.role_code] = { name: r.name, permissions: perms.sort() };
      }
      const dbDiffs = diffKeys(dbFold, current);
      if (dbDiffs.length) {
        console.warn('WARN  库内 builtin 角色与常量不一致（跑 scripts/perm_roles_resync.cjs 可对齐）:');
        for (const d of dbDiffs) console.warn('      ' + d);
      } else {
        console.log(`PASS  库内 builtin 角色与常量一致（${rows.length} 行）`);
      }
    } catch (e) {
      console.warn('WARN  跳过库内比对: ' + e.message);
    }
  }
  process.exit(failed);
})();
