#!/usr/bin/env node
/**
 * scripts/s3-verify-images.cjs —— 存量迁移校验（S2-2，对齐 docs/s3-migration-plan.md §3.5）
 *
 * 五项校验：
 *   1) 抽样可访问性：随机 N 条引用 HEAD 公网 URL → 期望 200
 *   2) 内容有效性：HEAD 的 Content-Type 为图片类型、Content-Length > 0
 *   3) 引用完整性：所有图片引用要么是公网 URL，要么是白名单内的本地路径（--allow-local 时豁免 assets/）
 *   4) 封面归属：projects.cover_image 须命中该项目 photos 之一，或为独立 URL（信息级）
 *   5) 孤儿反查：用迁移报告里「已上传的 key 集合」减去「当前仍被引用的 key 集合」→ 孤儿清单
 *      （注：本环境业务账号无 ListBucket 权限，无法直接列桶，故用报告反查）
 *
 * 用法：
 *   node scripts/s3-verify-images.cjs                    # 默认抽样 100 条
 *   node scripts/s3-verify-images.cjs --sample=300
 *   node scripts/s3-verify-images.cjs --allow-local      # 允许仍有本地路径（迁移中）
 *   node scripts/s3-verify-images.cjs --report=scripts/s3-migrate-report-xxx.json
 * 退出码：0 全通过 / 1 有失败 / 2 环境问题
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
const imgStorage = require('../img_storage.cjs');
const S3 = require('../s3_client.cjs');

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith('--' + n + '=')); return h ? h.split('=').slice(1).join('=') : d; };
const SAMPLE = Math.max(1, parseInt(arg('sample', '100'), 10) || 100);
const ALLOW_LOCAL = has('allow-local');
const CONCURRENCY = Math.max(1, parseInt(arg('concurrency', '6'), 10) || 6);
const REPORT = arg('report', '');

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  if (!cond) failed++;
}

function connect() {
  const cfg = {
    host: (process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '').trim(),
    port: parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10),
    database: (process.env.MYSQL_DB || process.env.JUZHU_DB_NAME || '').trim(),
    user: (process.env.MYSQL_USER || process.env.JUZHU_DB_USER || '').trim(),
    password: process.env.MYSQL_PASSWORD != null && process.env.MYSQL_PASSWORD !== ''
      ? process.env.MYSQL_PASSWORD : process.env.JUZHU_DB_PASSWORD,
    connectTimeout: 8000,
  };
  if (!cfg.host || !cfg.database || !cfg.user || cfg.password == null || cfg.password === '') {
    throw new Error('MySQL env 不完整');
  }
  return mysql.createConnection(cfg);
}

function isHttp(v) { return /^https?:\/\//i.test(String(v || '').trim()); }
function isLocalRef(v) {
  const s = String(v || '').trim();
  return !!s && !isHttp(s) && !/^data:/i.test(s) && !/^s3:\/\//i.test(s);
}

async function pool(items, n, worker) {
  const queue = items.slice();
  const out = [];
  const run = async () => { while (queue.length) { const it = queue.shift(); out.push(await worker(it)); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, run));
  return out;
}

(async () => {
  console.log('=== 存量图片迁移校验（S2-2）===');
  console.log(`抽样 ${SAMPLE}    允许本地路径: ${ALLOW_LOCAL ? '是' : '否'}\n`);
  const conn = await connect();
  try {
    // ── 采集所有图片引用 ──
    const refs = [];                                        // {source, id, value}
    const push = (source) => (r) => { refs.push({ source, id: r.id, value: String(r.v || '').trim() }); };
    const targets = [
      ['photos.file_path', 'SELECT id, file_path AS v FROM photos WHERE file_path IS NOT NULL AND file_path<>\'\''],
      ['projects.cover_image', 'SELECT id, cover_image AS v FROM projects WHERE cover_image IS NOT NULL AND cover_image<>\'\''],
      ['units.cover_image', 'SELECT id, cover_image AS v FROM units WHERE cover_image IS NOT NULL AND cover_image<>\'\''],
      ['districts.cover_image', 'SELECT id, cover_image AS v FROM districts WHERE cover_image IS NOT NULL AND cover_image<>\'\''],
      ['cities.hero_bg_image', 'SELECT id, hero_bg_image AS v FROM cities WHERE hero_bg_image IS NOT NULL AND hero_bg_image<>\'\''],
      ['spots.cover_image', 'SELECT id, cover_image AS v FROM spots WHERE cover_image IS NOT NULL AND cover_image<>\'\''],
      ['routes.cover_image', 'SELECT id, cover_image AS v FROM routes WHERE cover_image IS NOT NULL AND cover_image<>\'\''],
    ];
    for (const [name, sql] of targets) {
      // eslint-disable-next-line no-await-in-loop
      const [rows] = await conn.execute(sql);
      rows.forEach(push(name));
    }
    { // spots.photos 图集
      const [rows] = await conn.execute("SELECT id, photos AS v FROM spots WHERE photos IS NOT NULL AND photos<>''");
      rows.forEach((r) => {
        let arr; try { arr = JSON.parse(r.v); } catch (_) { return; }
        if (Array.isArray(arr)) arr.forEach((u) => refs.push({ source: 'spots.photos', id: r.id, value: String(u || '').trim() }));
      });
    }
    { // settings 专题封面
      const [rows] = await conn.execute("SELECT `key` AS id, value AS v FROM settings WHERE `key` LIKE 'topic\\_%' AND `key` NOT LIKE '%\\_legacy'");
      rows.forEach((r) => {
        let crit; try { crit = JSON.parse(r.v || '{}'); } catch (_) { return; }
        if (crit && crit.cover_image) refs.push({ source: 'topics.cover_image', id: r.id, value: String(crit.cover_image).trim() });
      });
    }

    const httpRefs = refs.filter((r) => isHttp(r.value));
    const localRefs = refs.filter((r) => isLocalRef(r.value));
    const emptyRefs = refs.filter((r) => !r.value);
    console.log(`引用总数 ${refs.length}：公网 URL ${httpRefs.length} / 本地路径 ${localRefs.length} / 空值 ${emptyRefs.length}\n`);

    // ── 3) 引用完整性 ──
    if (ALLOW_LOCAL) {
      console.log('SKIP  引用完整性（--allow-local：迁移中，允许存量本地路径）');
    } else {
      check('引用完整性：无残留本地路径', localRefs.length === 0,
        localRefs.length ? `${localRefs.length} 条，例如 ${localRefs[0].source}#${localRefs[0].id}=${localRefs[0].value}` : '');
    }

    // ── 1)+2) 抽样可访问性 & 内容有效性 ──
    const pool_ = httpRefs.slice();
    // 打散取样（避免集中在同一目录）
    for (let i = pool_.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [pool_[i], pool_[j]] = [pool_[j], pool_[i]]; }
    const sample = pool_.slice(0, SAMPLE);
    if (!sample.length) {
      console.log('SKIP  抽样可访问性（无公网 URL 引用）');
    } else {
      console.log(`抽样 ${sample.length} 条探测中…`);
      const results = await pool(sample, CONCURRENCY, async (r) => {
        try {
          const res = await fetch(r.value, { method: 'HEAD' });
          return { ok: res.ok, status: res.status, ct: res.headers.get('content-type') || '', len: parseInt(res.headers.get('content-length') || '0', 10), r };
        } catch (e) {
          return { ok: false, status: 0, error: String(e && e.message || e), r };
        }
      });
      const bad = results.filter((x) => !x.ok);
      const badCt = results.filter((x) => x.ok && !/^image\//i.test(x.ct));
      const badLen = results.filter((x) => x.ok && x.len === 0);
      check(`可访问性：${results.length - bad.length}/${results.length} 返回 200`, bad.length === 0,
        bad.length ? `${bad.length} 条失败，例如 HTTP ${bad[0].status} ${bad[0].r.value}` : '');
      check('内容有效性：Content-Type 均为 image/*', badCt.length === 0,
        badCt.length ? `例如 ${badCt[0].ct} ${badCt[0].r.value}` : '');
      check('内容有效性：Content-Length > 0', badLen.length === 0,
        badLen.length ? `例如 ${badLen[0].r.value}` : '');
      if (bad.length) {
        console.log('  失败样例：');
        bad.slice(0, 5).forEach((x) => console.log(`    - HTTP ${x.status} ${x.error || ''} ${x.r.value}`));
      }
    }

    // ── 4) 封面归属（信息级） ──
    {
      const [rows] = await conn.execute(
        "SELECT p.id, p.cover_image FROM projects p WHERE p.cover_image IS NOT NULL AND p.cover_image<>''");
      const unmatched = [];
      for (const p of rows) {
        // eslint-disable-next-line no-await-in-loop
        const [ph] = await conn.execute("SELECT COUNT(*) AS c FROM photos WHERE entity_type='project' AND entity_id=? AND file_path=?", [p.id, p.cover_image]);
        if (!ph[0].c) unmatched.push(p.id);
      }
      check('封面归属：projects.cover_image 命中其 photos（或为独立 URL）',
        unmatched.length <= Math.ceil(rows.length * 0.1),
        `${unmatched.length}/${rows.length} 未命中（≤10% 视为可接受，常见于外部 CDN 封面）`);
    }

    // ── 5) 孤儿反查（基于迁移报告） ──
    const reportPath = REPORT || (() => {
      try {
        const files = fs.readdirSync(__dirname).filter((f) => /^s3-migrate-report-.*\.json$/.test(f)).sort();
        return files.length ? path.join(__dirname, files[files.length - 1]) : '';
      } catch (_) { return ''; }
    })();
    if (!reportPath || !fs.existsSync(reportPath)) {
      console.log('SKIP  孤儿反查（未找到迁移报告；可 --report=<file> 指定）');
    } else {
      let rep; try { rep = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (_) { rep = null; }
      if (!rep) {
        console.log('SKIP  孤儿反查（报告解析失败）');
      } else {
        const referencedKeys = new Set();
        refs.filter((r) => isHttp(r.value) && imgStorage.isS3Url(r.value)).forEach((r) => {
          const p = imgStorage.parse(r.value);
          if (p.kind === 's3' && p.key) referencedKeys.add(p.key);
        });
        // 迁移报告里成功上传的 key（从 progress 文件读取，报告只存计数）
        const progressFile = path.join(__dirname, '__fixtures__', 's3-migrate-progress.json');
        let uploadedKeys = [];
        try {
          const pr = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
          uploadedKeys = Object.values(pr).filter((x) => x && x.ok && x.key).map((x) => x.key);
        } catch (_) { /* 无进度文件 */ }
        if (!uploadedKeys.length) {
          console.log('SKIP  孤儿反查（无上传进度文件）');
        } else {
          const orphans = uploadedKeys.filter((k) => !referencedKeys.has(k));
          check(`孤儿反查：已上传 ${uploadedKeys.length} 个对象中无孤儿（仍被引用 ${referencedKeys.size} 个）`,
            orphans.length === 0,
            orphans.length ? `${orphans.length} 个孤儿，例如 ${orphans.slice(0, 3).join(' , ')}（回滚后未清理？）` : '');
        }
      }
    }

    console.log(`\n${failed === 0 ? '校验通过 ✅' : failed + ' 项失败 ❌'}`);
    process.exit(failed === 0 ? 0 : 1);
  } finally {
    await conn.end();
  }
})().catch((e) => {
  const msg = String(e && e.message || e);
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|MySQL env 不完整|getaddrinfo/.test(msg)) {
    console.error(`\nFATAL: 数据库不可达或配置不全 —— ${msg}`);
    console.error('请确认：① 已连内网（本仓库 MySQL 为内网地址 10.236.15.185）② 已配置 MYSQL_* / JUZHU_DB_*（juzhu/.env.local 或仓库根 .env）。');
    process.exit(2);
  }
  console.error('校验异常:', e && e.stack || e);
  process.exit(2);
});
