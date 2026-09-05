/**
 * img_thumbs.cjs —— 图片缩略图自维护模块（性能优化：列表/卡片加载提速）
 *
 * - 原图保留不动；同目录生成 WebP 缩略图：`foo.jpg` → `foo.t240.webp` / `foo.t640.webp`
 * - thumbOf(path, size)：C 端公开接口回传前把原图路径改写为缩略图路径（无缩略图回退原图）
 * - 启动时后台全量扫描补齐缺失缩略图（并发 4），每小时增量重扫（新上传自动生效）
 * - 原图 <60KB / 非 jpg·jpeg·png / 不在 assets/ 下 → 不生成，thumbOf 回退原图
 *
 * 依赖 sharp（规则14：仅 Node）；生成失败不影响接口（thumbOf 回退原图）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ASSETS_DIR = path.join(ROOT, 'assets');
const SIZES = { 240: 240, 640: 640 };
const SKIP_SMALL_BYTES = 60 * 1024;      // 小图不生成
const RESCAN_INTERVAL_MS = 60 * 60 * 1000;

let sharp = null;
try { sharp = require('sharp'); } catch (_) { console.warn('img_thumbs: sharp 未安装，缩略图功能关闭'); }

const IMG_RE = /\.(jpe?g|png)$/i;
const inflight = new Map();   // thumbPath → Promise<boolean>

function isAssetImagePath(p) {
  if (!p || typeof p !== 'string') return false;
  const norm = String(p).replace(/^\/+/, '');
  if (!norm.startsWith('assets/')) return false;
  return IMG_RE.test(norm);
}

function thumbPathOf(urlPath, size) {
  // URL 形态（assets/.. 或 /assets/..）→ 磁盘形态 → 加后缀 → 还原 URL 形态（带前导 /）
  const disk = path.join(ROOT, decodeURIComponent(String(urlPath).replace(/^\/+/, '')));
  const dir = path.dirname(disk);
  const ext = path.extname(disk);
  const base = path.basename(disk, ext);
  return path.join(dir, base + '.t' + size + '.webp');
}

/** 确保某原图的某档缩略图存在（并发去重）；返回缩略图 URL 或 null */
function ensureThumb(urlPath, size) {
  if (!sharp || !isAssetImagePath(urlPath)) return null;
  const disk = path.join(ROOT, decodeURIComponent(urlPath));
  const tPath = thumbPathOf(urlPath, size);
  let ok = false;
  try { ok = fs.existsSync(tPath); } catch (_) {}
  if (ok) return tPath;
  if (!fs.existsSync(disk)) return null;
  try { if (fs.statSync(disk).size < SKIP_SMALL_BYTES) return null; } catch (_) { return null; }
  if (inflight.has(tPath)) return inflight.get(tPath);
  const p = sharp(disk).resize({ width: SIZES[size] || 640, withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(tPath)
    .then(() => true)
    .catch((e) => { try { fs.unlinkSync(tPath); } catch (_) {} console.warn('thumb fail:', path.basename(disk), e.message); return false; })
    .then((done) => { inflight.delete(tPath); return done ? tPath : null; });
  inflight.set(tPath, p);
  return p;
}

/**
 * 同步改写：缩略图已存在 → 返回缩略图 URL；未生成 → 返回原图并触发后台生成（下次生效）。
 * size: 240（卡片/列表）| 640（详情/横幅）
 */
function thumbOf(urlPath, size) {
  if (!sharp || !isAssetImagePath(urlPath)) return urlPath;
  const tUrl = decodeURIComponent(urlPath).replace(/(\.[^.]+)$/, '.t' + size + '.webp');
  try { if (fs.existsSync(path.join(ROOT, tUrl))) return tUrl; } catch (_) {}
  ensureThumb(urlPath, size);   // 后台补，立即返回原图（本次回退，下次命中）
  return urlPath;
}

/** 深度遍历响应对象，把所有 assets 图片字符串字段改写为缩略图路径（同步、已存在的才替换） */
function mapThumbsDeep(obj, size) {
  if (!sharp || obj == null) return obj;
  const walk = (v, depth) => {
    if (depth > 6) return v;
    if (typeof v === 'string') {
      if (!isAssetImagePath(v) || !IMG_RE.test(v)) return v;
      const tUrl = decodeURIComponent(v).replace(/(\.[^.]+)$/, '.t' + size + '.webp');
      try { if (fs.existsSync(path.join(ROOT, tUrl))) return tUrl; } catch (_) {}
      ensureThumb(v, size);
      return v;
    }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i], depth + 1); return v; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walk(v[k], depth + 1); return v; }
    return v;
  };
  return walk(obj, 0);
}

/** 全量扫描 assets/，补齐缺失缩略图（启动后台任务） */
async function scanAll() {
  if (!sharp) return;
  const t0 = Date.now();
  let made = 0, skipped = 0;
  const jobs = [];
  const walkDir = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) { if (!name.startsWith('.')) walkDir(full); continue; }
      if (!IMG_RE.test(name) || st.size < SKIP_SMALL_BYTES) { skipped++; continue; }
      for (const size of Object.keys(SIZES)) {
        const t = thumbPathOf('/assets/' + path.relative(ASSETS_DIR, full).split(path.sep).join('/'), size);
        if (!fs.existsSync(t)) jobs.push(() => ensureThumb('/assets/' + path.relative(ASSETS_DIR, full).split(path.sep).join('/'), size).then((r) => { if (r) made++; }));
      }
    }
  };
  walkDir(ASSETS_DIR);
  // 并发 4
  const queue = jobs.slice();
  const worker = async () => { while (queue.length) { const job = queue.shift(); await job(); } };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(`img_thumbs: 扫描完成 新增缩略图 ${made}（跳过小图/已有 ${skipped} 源文件）耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function initBackground() {
  if (!sharp) return;
  setTimeout(() => { scanAll().catch((e) => console.warn('img_thumbs scan warn:', e.message)); }, 3000);
  setInterval(() => { scanAll().catch(() => {}); }, RESCAN_INTERVAL_MS).unref();
}

module.exports = { thumbOf, mapThumbsDeep, ensureThumb, scanAll, initBackground, isAssetImagePath };
