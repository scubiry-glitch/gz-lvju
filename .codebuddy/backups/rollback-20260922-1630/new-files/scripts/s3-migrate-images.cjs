#!/usr/bin/env node
/**
 * scripts/s3-migrate-images.cjs —— 存量房源图片迁移到对象存储（S2-1）
 *
 * 设计要点（对齐 docs/s3-migration-plan.md §3）：
 *   - **幂等**：已迁移（目标列已是 http 且 legacy_* 已填）的行跳过；上传进度落盘可断点续跑
 *   - **key 与读侧改写一致**：使用 img_storage.legacyKeyOf(path) 生成确定性 key，
 *     与 IMG_URL_MODE=s3 的读侧改写（legacyUrlOf）完全一致 —— 否则切读会 404
 *   - **先传后改**：文件上传成功才改库；找不到本地文件的引用只记 report，不动库
 *   - **回滚列**：改库前把原值写入 legacy_*（S2-4），便于一键回退
 *   - **不生成缩略图**（决策 5）：存量图只传原图；新上传仍由 img_storage 生成两档 webp
 *   - 缺省 **--dry-run**，必须显式 `--apply` 才写库/上传
 *
 * 用法：
 *   node scripts/s3-migrate-images.cjs                          # 预演（默认，不写任何东西）
 *   node scripts/s3-migrate-images.cjs --apply --limit=50       # 首批 50 条
 *   node scripts/s3-migrate-images.cjs --apply --only=photos,projects
 *   node scripts/s3-migrate-images.cjs --apply --skip-upload    # 对象已就绪，只改库
 *   node scripts/s3-migrate-images.cjs --apply --no-spot-gallery
 *
 * 凭证只从环境变量 / juzhu/.env.local / .env / runtime.env 读取，禁止写入仓库。
 * 退出码：0 成功 / 1 有失败项 / 2 环境或参数问题
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
const S3 = require('../s3_client.cjs');
const imgStorage = require('../img_storage.cjs');

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith('--' + n + '=')); return h ? h.split('=').slice(1).join('=') : d; };

const APPLY = has('apply');
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const ONLY = String(arg('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(1, parseInt(arg('concurrency', '4'), 10) || 4);
const NO_SPOT_GALLERY = has('no-spot-gallery');
const SKIP_UPLOAD = has('skip-upload');
const VERBOSE = has('verbose');
const PROGRESS_FILE = path.join(__dirname, '__fixtures__', 's3-migrate-progress.json');
const REPORT_FILE = path.join(__dirname, `s3-migrate-report-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}.json`);
const ROOT = path.join(__dirname, '..');

/** 目标清单：表 / 列 / 回滚列 / 主键 */
const TARGETS = [
  { name: 'photos', table: 'photos', col: 'file_path', legacy: 'legacy_file_path' },
  { name: 'projects', table: 'projects', col: 'cover_image', legacy: 'legacy_cover_image' },
  { name: 'units', table: 'units', col: 'cover_image', legacy: 'legacy_cover_image' },
  { name: 'districts', table: 'districts', col: 'cover_image', legacy: 'legacy_cover_image' },
  { name: 'cities', table: 'cities', col: 'hero_bg_image', legacy: 'legacy_hero_bg_image' },
  { name: 'spots', table: 'spots', col: 'cover_image', legacy: 'legacy_cover_image' },
  { name: 'routes', table: 'routes', col: 'cover_image', legacy: 'legacy_cover_image' },
];

function connect() {
  const cfg = {
    host: (process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '').trim(),
    port: parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10),
    database: (process.env.MYSQL_DB || process.env.JUZHU_DB_NAME || '').trim(),
    user: (process.env.MYSQL_USER || process.env.JUZHU_DB_USER || '').trim(),
    password: process.env.MYSQL_PASSWORD != null && process.env.MYSQL_PASSWORD !== ''
      ? process.env.MYSQL_PASSWORD : process.env.JUZHU_DB_PASSWORD,
    connectTimeout: 8000,
    decimalNumbers: true,
  };
  if (!cfg.host || !cfg.database || !cfg.user || cfg.password == null || cfg.password === '') {
    throw new Error('MySQL env 不完整（MYSQL_HOST/PORT/DB/USER/PASSWORD 或 JUZHU_DB_*）');
  }
  return mysql.createConnection(cfg);
}

/** 幂等补回滚列（不依赖 app.js ensureSchema，脚本自带） */
async function ensureLegacyCols(conn) {
  const cols = [
    ['photos', 'legacy_file_path TEXT'],
    ['projects', 'legacy_cover_image VARCHAR(500)'],
    ['units', 'legacy_cover_image VARCHAR(500)'],
    ['districts', 'legacy_cover_image VARCHAR(500)'],
    ['cities', 'legacy_hero_bg_image TEXT'],
    ['spots', 'legacy_cover_image VARCHAR(500)'],
    ['spots', 'legacy_photos TEXT'],
    ['routes', 'legacy_cover_image VARCHAR(500)'],
  ];
  for (const [t, ddl] of cols) {
    try { await conn.execute(`ALTER TABLE ${t} ADD COLUMN ${ddl}`); } catch (_) { /* 已存在 */ }
  }
}

function isLocalRef(v) {
  if (v == null) return false;
  const s = String(v).trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s) || /^data:/i.test(s)) return false;
  if (/^s3:\/\//i.test(s)) return false;
  return true; // 含 assets/... 与历史裸路径
}

function diskPathOf(ref) {
  return path.join(ROOT, String(ref).replace(/^\/+/, ''));
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch (_) { return {}; }
}
function saveProgress(p) {
  fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

async function pool(items, n, worker) {
  const queue = items.slice();
  const out = [];
  const run = async () => { while (queue.length) { const it = queue.shift(); out.push(await worker(it)); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, run));
  return out;
}

(async () => {
  console.log('=== 存量房源图片迁移到对象存储（S2-1）===');
  if (!S3.isConfigured()) {
    console.error('FATAL: S3 未配置（S3_ACCESS_KEY/S3_SECRET_KEY/S3_ENDPOINT/S3_BUCKET）');
    process.exit(2);
  }
  console.log(`模式        : ${APPLY ? '**APPLY（会写库 + 上传）**' : 'dry-run（只读，不改任何东西）'}`);
  console.log(`bucket      : ${S3.config().bucket}   endpoint: ${S3.config().endpoint}`);
  console.log(`迁移 key 前缀: ${imgStorage.migratePrefix()}`);
  console.log(`并发/限速    : ${CONCURRENCY}${LIMIT ? `   本次上限: ${LIMIT}` : ''}`);
  if (NO_SPOT_GALLERY) console.log('选项        : 跳过 spots.photos 图集（--no-spot-gallery）');
  if (SKIP_UPLOAD) console.log('选项        : 只改库不改对象（--skip-upload）');
  console.log('');

  // ── 0) 自检模式（无需数据库）：实证「迁移上传目标」与「切读改写」逐字一致 ──
  //    取若干真实 assets 图片 → 按 legacyKeyOf 上传 → 公网 HEAD → 与 legacyUrlOf/读侧比对 → 清理
  if (has('selftest') || argv.some((a) => a.startsWith('--selftest='))) {
    const n = Math.max(1, parseInt(arg('selftest', '3'), 10) || 3);
    const dir = path.join(ROOT, 'assets', 'lvju');
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && !/\.t\d+\.webp$/i.test(f)).slice(0, n)
      : [];
    if (!files.length) { console.error('自检失败：assets/lvju 下找不到原图'); process.exit(2); }
    console.log(`=== 自检模式（--selftest=${n}，不读写数据库）===`);
    let ok = 0, bad = 0;
    const cleanupKeys = [];
    for (const f of files) {
      const ref = 'assets/lvju/' + f;
      const key = imgStorage.legacyKeyOf(ref);
      const uploadUrl = S3.publicUrl(key);            // ← 迁移脚本实际写入库的 URL
      const readUrl = imgStorage.legacyUrlOf(ref);    // ← IMG_URL_MODE=s3 读侧改写的 URL
      // 安全性：实际 PUT 走 __selftest__/ 隔离前缀，绝不触碰（可能已存在的）生产对象
      const testKey = '__selftest__/' + key;
      let line = `  ${ref}\n    key   ${key}\n    upload ${uploadUrl}\n    read    ${readUrl}\n`;
      if (uploadUrl !== readUrl) { console.log(line + '    ✗ URL 不一致（切读会 404）'); bad += 1; continue; }
      let head = null;
      try {
        const raw = fs.readFileSync(path.join(ROOT, ref));
        const norm = await imgStorage.normalize(raw);
        const put = await S3.putObject(testKey, norm.buffer, { contentType: norm.mime || imgStorage.mimeOfExt(path.extname(ref)) });
        cleanupKeys.push(testKey);
        if (!put.ok) { console.log(line + `    ✗ PUT HTTP ${put.status}`); bad += 1; continue; }
        const res = await fetch(S3.publicUrl(testKey), { method: 'HEAD' });
        head = { ok: res.ok, status: res.status, ct: res.headers.get('content-type'), len: res.headers.get('content-length') };
      } catch (e) {
        console.log(line + '    ✗ ' + e.message); bad += 1; continue;
      }
      const pass = head && head.ok && /^image\//i.test(head.ct || '') && parseInt(head.len || '0', 10) > 0;
      console.log(line + `    ${pass ? '✓ 上传/公网读取通' : '✗ 上传或公网读取失败'} HTTP ${head && head.status} ${head && head.ct} ${head && head.len}B`);
      if (pass) ok += 1; else bad += 1;
    }
    console.log(`\n自检结果：${ok} 通过 / ${bad} 失败`);
    for (const k of cleanupKeys) {
      // eslint-disable-next-line no-await-in-loop
      await S3.deleteObject(k).catch(() => {});
    }
    console.log(`（已清理 ${cleanupKeys.length} 个自检对象）`);
    process.exit(bad === 0 ? 0 : 1);
  }

  const conn = await connect();
  const t0 = Date.now();
  try {
    if (APPLY) await ensureLegacyCols(conn);

    // ── 1) 采集引用 ──
    const refs = new Map();          // localRef → [ {target, id, kind:'col'} | {target, id, kind:'json', index} ]
    const stats = {};
    const addRef = (ref, meta) => {
      if (!isLocalRef(ref)) return;
      const key = String(ref).trim();
      if (!refs.has(key)) refs.set(key, []);
      refs.get(key).push(meta);
    };

    for (const t of TARGETS) {
      if (ONLY.length && !ONLY.includes(t.name)) continue;
      // 只取「尚未迁移」的行：目标列非空、不是 http(s)、legacy 未填
      const sql = `SELECT id, \`${t.col}\` AS v FROM ${t.table}
                   WHERE \`${t.col}\` IS NOT NULL AND \`${t.col}\` <> ''
                     AND \`${t.col}\` NOT LIKE 'http%'
                     AND (\`${t.legacy}\` IS NULL OR \`${t.legacy}\` = '')`
        + (LIMIT ? ` LIMIT ${LIMIT}` : '');
      const [rows] = await conn.execute(sql);
      stats[t.name] = rows.length;
      rows.forEach((r) => addRef(r.v, { target: t.name, table: t.table, col: t.col, legacy: t.legacy, id: r.id, kind: 'col' }));
    }

    // spots.photos 图集（JSON 数组）
    if (!NO_SPOT_GALLERY && (!ONLY.length || ONLY.includes('spots'))) {
      const [rows] = await conn.execute(
        "SELECT id, photos FROM spots WHERE photos IS NOT NULL AND photos <> '' AND (legacy_photos IS NULL OR legacy_photos='')"
        + (LIMIT ? ` LIMIT ${LIMIT}` : ''));
      let n = 0;
      rows.forEach((r) => {
        let arr; try { arr = JSON.parse(r.photos); } catch (_) { return; }
        if (!Array.isArray(arr)) return;
        arr.forEach((u, i) => { if (isLocalRef(u)) { addRef(u, { target: 'spots.photos', table: 'spots', col: 'photos', legacy: 'legacy_photos', id: r.id, kind: 'json', index: i }); n += 1; } });
      });
      stats['spots.photos'] = n;
    }

    // settings 里的专题封面（topic_* KV）
    if (!ONLY.length || ONLY.includes('topics')) {
      const [rows] = await conn.execute("SELECT `key`, value FROM settings WHERE `key` LIKE 'topic\\_%'");
      let n = 0;
      rows.forEach((r) => {
        let crit; try { crit = JSON.parse(r.value || '{}'); } catch (_) { return; }
        if (crit && isLocalRef(crit.cover_image)) {
          addRef(crit.cover_image, { target: 'topics', table: 'settings', col: 'value', legacy: null, id: r.key, kind: 'topic' });
          n += 1;
        }
      });
      stats.topics = n;
    }

    const uniqueRefs = Array.from(refs.keys());
    console.log('=== 采集结果（待迁移引用）===');
    Object.entries(stats).forEach(([k, v]) => console.log(`  ${k.padEnd(14)} ${v}`));
    console.log(`  ${'唯一本地文件'.padEnd(14)} ${uniqueRefs.length}`);
    console.log('');

    // ── 2) 本地文件体检 ──
    const missing = [];
    const present = [];
    for (const ref of uniqueRefs) {
      const d = diskPathOf(ref);
      if (fs.existsSync(d)) present.push(ref); else missing.push(ref);
    }
    console.log(`本地存在: ${present.length}    缺失: ${missing.length}`);
    if (missing.length) {
      console.log('  ⚠ 以下引用在磁盘上找不到（不会改库，将记入报告）：');
      missing.slice(0, 10).forEach((m) => console.log('    - ' + m));
      if (missing.length > 10) console.log(`    … 其余 ${missing.length - 10} 条见报告`);
    }
    const totalBytes = present.reduce((s, r) => { try { return s + fs.statSync(diskPathOf(r)).size; } catch (_) { return s; } }, 0);
    console.log(`总体积  : ${(totalBytes / 1048576).toFixed(1)} MB`);
    console.log(`预计对象数: ${present.length}（每个引用同一文件只传一次）`);
    console.log('');

    if (!APPLY) {
      console.log('dry-run 结束：未上传、未改库。确认无误后加 --apply 执行。');
      console.log('建议顺序：① 已跑过 npm run test:admin-upload / s3:smoke ② 本脚本先 --apply --limit=20 小批验证 ③ 再全量');
      await conn.end();
      process.exit(0);
    }

    // ── 3) 上传（确定性 key，与读侧改写一致） ──
    const progress = loadProgress();
    let upOk = 0, upSkip = 0, upFail = 0;
    const failures = [];
    if (!SKIP_UPLOAD) {
      console.log('=== 上传中（存量不生成缩略图：决策 5）===');
      await pool(present, CONCURRENCY, async (ref) => {
        const key = imgStorage.legacyKeyOf(ref);
        const url = S3.publicUrl(key);
        if (progress[ref] && progress[ref].ok) { upSkip += 1; return; }
        try {
          const raw = fs.readFileSync(diskPathOf(ref));
          const norm = await imgStorage.normalize(raw);     // 尊重 IMG_NORMALIZE（决策 4 允许重编码）
          const ct = norm.mime || imgStorage.mimeOfExt(path.extname(ref)) || 'application/octet-stream';
          const r = await S3.putObject(key, norm.buffer, { contentType: ct });
          if (r.ok) {
            upOk += 1;
            progress[ref] = { key, url, ok: true, bytes: norm.buffer.length, at: new Date().toISOString() };
            if (VERBOSE) console.log(`  ✓ ${ref} → ${key}`);
          } else {
            upFail += 1;
            failures.push({ ref, key, error: `HTTP ${r.status} ${String(r.text || r.error || '').slice(0, 200)}` });
            console.warn(`  ✗ ${ref} → HTTP ${r.status}`);
          }
        } catch (e) {
          upFail += 1;
          failures.push({ ref, key, error: String(e && e.message || e) });
          console.warn(`  ✗ ${ref} → ${e.message}`);
        }
        if ((upOk + upFail) % 50 === 0) saveProgress(progress);   // 增量落盘，可断点续跑
      });
      saveProgress(progress);
      console.log(`上传完成: 新增 ${upOk} / 已存在跳过 ${upSkip} / 失败 ${upFail}`);
      console.log(`进度文件: ${path.relative(ROOT, PROGRESS_FILE)}`);
      console.log('');
      if (upFail) {
        console.error(`FATAL: 有 ${upFail} 个对象上传失败，已中止，未改库（修好后重跑即可续传）`);
        fs.writeFileSync(REPORT_FILE, JSON.stringify({ mode: 'apply', aborted: true, failures }, null, 2));
        await conn.end();
        process.exit(1);
      }
    } else {
      console.log('（--skip-upload：跳过上传，直接改库）\n');
    }

    // ── 4) 改库（先写 legacy_*，再写新 URL） ──
    const urlOf = (ref) => S3.publicUrl(imgStorage.legacyKeyOf(ref));
    let rowsUpdated = 0, rowsSkipped = 0;
    const urlByRef = new Map(present.map((ref) => [ref, urlOf(ref)]));

    // 4.1 普通列
    for (const t of TARGETS) {
      if (ONLY.length && !ONLY.includes(t.name)) continue;
      const items = [];
      refs.forEach((metas, ref) => {
        metas.filter((m) => m.kind === 'col' && m.target === t.name).forEach((m) => items.push({ ref, m }));
      });
      for (const { ref, m } of items) {
        const url = urlByRef.get(ref);
        if (!url) { rowsSkipped += 1; continue; }   // 文件缺失/未上传 → 不改
        // eslint-disable-next-line no-await-in-loop
        const [r] = await conn.execute(
          `UPDATE ${m.table} SET \`${m.col}\`=?, \`${m.legacy}\`=\`${m.col}\` WHERE id=? AND \`${m.legacy}\` IS NULL`,
          [url, m.id]);
        rowsUpdated += r.affectedRows || 0;
      }
    }

    // 4.2 spots.photos 图集（逐行重建 JSON）
    if (!NO_SPOT_GALLERY && (!ONLY.length || ONLY.includes('spots'))) {
      const byId = new Map();
      refs.forEach((metas, ref) => metas.filter((m) => m.kind === 'json').forEach((m) => {
        if (!byId.has(m.id)) byId.set(m.id, []);
        byId.get(m.id).push({ ref, index: m.index });
      }));
      for (const [id, list] of byId) {
        // eslint-disable-next-line no-await-in-loop
        const [rows] = await conn.execute('SELECT photos, legacy_photos FROM spots WHERE id=?', [id]);
        if (!rows.length || (rows[0].legacy_photos != null && rows[0].legacy_photos !== '')) { rowsSkipped += 1; continue; }
        let arr; try { arr = JSON.parse(rows[0].photos); } catch (_) { continue; }
        if (!Array.isArray(arr)) continue;
        list.forEach(({ ref, index }) => { const u = urlByRef.get(ref); if (u) arr[index] = u; });
        // eslint-disable-next-line no-await-in-loop
        const [r] = await conn.execute(
          'UPDATE spots SET photos=?, legacy_photos=photos WHERE id=? AND (legacy_photos IS NULL OR legacy_photos=\'\')',
          [JSON.stringify(arr), id]);
        rowsUpdated += r.affectedRows || 0;
      }
    }

    // 4.3 settings 专题封面（备份到 topic_<slug>_legacy）
    if (!ONLY.length || ONLY.includes('topics')) {
      const byKey = new Map();
      refs.forEach((metas, ref) => metas.filter((m) => m.kind === 'topic').forEach((m) => byKey.set(m.id, { ref })));
      for (const [key, { ref }] of byKey) {
        const url = urlByRef.get(ref);
        if (!url) { rowsSkipped += 1; continue; }
        // eslint-disable-next-line no-await-in-loop
        const [rows] = await conn.execute('SELECT value FROM settings WHERE `key`=?', [key]);
        if (!rows.length) continue;
        const raw = rows[0].value;
        let crit; try { crit = JSON.parse(raw || '{}'); } catch (_) { continue; }
        crit.cover_image = url;
        // eslint-disable-next-line no-await-in-loop
        await conn.execute(
          'INSERT INTO settings(`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
          [key + '_legacy', raw]);
        // eslint-disable-next-line no-await-in-loop
        const [r] = await conn.execute('UPDATE settings SET value=? WHERE `key`=?', [JSON.stringify(crit), key]);
        rowsUpdated += r.affectedRows || 0;
      }
    }

    console.log('=== 改库结果 ===');
    console.log(`  更新行数: ${rowsUpdated}    跳过（文件缺失/未上传/已迁移）: ${rowsSkipped}`);
    console.log(`  未迁移对象: ${upSkip}（已存在，复用）`);

    const report = {
      mode: 'apply', at: new Date().toISOString(),
      prefix: imgStorage.migratePrefix(), bucket: S3.config().bucket,
      stats, uniqueFiles: uniqueRefs.length, uploaded: upOk, reused: upSkip,
      missing, failures, rowsUpdated, rowsSkipped, elapsedMs: Date.now() - t0,
    };
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(`\n报告: ${path.relative(ROOT, REPORT_FILE)}`);
    console.log(`耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('\n下一步：node scripts/s3-verify-images.cjs   # 抽样验证可访问性与引用完整性');
    console.log('切读  ：IMG_URL_MODE=s3（先小流量灰度 → 观察 → 全量）');
    console.log('回滚  ：见 docs/s3-migration-plan.md §6（legacy_* 列 + IMG_URL_MODE=local）');
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
  console.error('迁移异常:', e && e.stack || e);
  process.exit(2);
});
