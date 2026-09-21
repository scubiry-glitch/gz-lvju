/**
 * img_storage.cjs —— 房源图片存储层（贝壳 ODS/S3 优先，本地 assets 兜底）
 *
 * 与现有系统的集成约定（零 schema 变更）：
 *   - `photos.file_path` / `projects.cover_image` / `units.cover_image` / `spots.cover_image`
 *     继续存「可直接放进 <img src> 的字符串」，因此：
 *        本地图片  → `/assets/...`（完全保持原状，历史数据零迁移）
 *        S3 图片   → `https://file.ljcdn.com/<key>`（由 S3_FILE_ENDPOINT 拼装）
 *     也接受 `s3://<key>` 与裸 key 写法（读取时自动解析），方便脚本/商家接口直传。
 *
 *   - 缩略图沿用 img_thumbs.cjs 的命名约定 `foo.jpg → foo.t240.webp / foo.t640.webp`，
 *     上传时**同时写入 S3**（本地图片仍由 img_thumbs 懒生成）。C 端改写走
 *     `thumbCandidate()`：先 HEAD 校验存在（结果进程内缓存），命中才改写，绝不产生 404。
 *
 *   - S3 不可用（未配置/网络失败）→ 自动回落写本地 `assets/uploads/...`，不阻断业务。
 *
 * 依赖：s3_client.cjs（无新依赖）、可选 sharp（图片归一化 + 缩略图）。
 * 规则：只用 Node；凭证只从环境变量/运行时 env 读取，禁止写进源码或前端。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S3 = require('./s3_client.cjs');

const ROOT = __dirname;
const LOCAL_UPLOAD_DIR = path.join(ROOT, 'assets', 'uploads');
const LOCAL_URL_PREFIX = '/assets/uploads/';

const THUMB_SIZES = [240, 640];
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;   // 单图 12MB
const DEFAULT_MAX_WIDTH = 2560;               // 归一化最大宽度

let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* 未安装则原样上传，不做归一化/缩略图 */ }

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);

/** 存储模式：s3 = 已配置可用；local = 回落本地磁盘 */
function storageMode() {
  return S3.isConfigured() ? 's3' : 'local';
}

function maxBytes() {
  const n = parseInt(process.env.S3_MAX_BYTES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

// ── 路径工具 ──────────────────────────────────────────────────
function isLocalPath(p) {
  return /^\/?assets\//i.test(String(p || ''));
}

function isS3Url(p) {
  const c = S3.config();
  const s = String(p || '');
  if (!/^https?:\/\//i.test(s)) return false;
  const hosts = [c.fileEndpoint, c.endpoint].filter(Boolean).map((h) => h.replace(/^https?:\/\//i, '').toLowerCase());
  const host = s.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  return hosts.some((h) => host === h || host.endsWith('.' + h));
}

/** 入参（本地路径 / s3://key / 裸 key / 绝对 URL）→ N 统一形态 { kind, key|path, url } */
function parse(p) {
  const s = String(p || '').trim();
  if (!s) return { kind: '', url: '' };
  if (isLocalPath(s)) return { kind: 'local', path: s.startsWith('/') ? s : '/' + s, url: s.startsWith('/') ? s : '/' + s };
  if (/^s3:\/\//i.test(s)) { const key = S3.normalizeKey(s); return { kind: 's3', key, url: S3.publicUrl(key) }; }
  if (S3.looksLikeUrl(s)) {
    const u = new URL(s);
    const c = S3.config();
    const host = u.host.toLowerCase();
    const endpointHost = String(c.endpoint || '').replace(/^https?:\/\//i, '').toLowerCase();
    const onEndpoint = !!endpointHost && (host === endpointHost || host.endsWith('.' + endpointHost));
    let key = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    // 反解 key：ODS 域（path 寻址）与 file 域（bucket 风格）的路径首段都是 bucket，需剥掉
    const hasBucketPrefix = c.bucket && (key === c.bucket || key.startsWith(c.bucket + '/'));
    if (hasBucketPrefix && ((onEndpoint && c.addressing === 'path') || c.fileStyle === 'bucket')) {
      key = key.slice(c.bucket.length).replace(/^\/+/, '');
    }
    return { kind: 's3', key, url: s };
  }
  // 裸 key
  return { kind: 's3', key: S3.normalizeKey(s), url: S3.publicUrl(s) };
}

/** 任意存量/新增路径 → 可直接使用的展示 URL（本地保持 /assets/...，S3 补全域名） */
function resolveUrl(p) {
  const r = parse(p);
  return r.url || '';
}

/** 生成对象 key：<prefix>/<entity>/<id>/<yyyy>/<MM>/<uuid>.<ext> */
function keyFor(opts) {
  const o = opts || {};
  const c = S3.config();
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const segs = [
    c.keyPrefix,
    o.prefix || 'housing',
    o.entityType || 'misc',
    o.entityId != null && o.entityId !== '' ? String(o.entityId) : '0',
    String(yyyy),
    mm,
    crypto.randomUUID().replace(/-/g, ''),
  ].filter(Boolean);
  return segs.join('/') + '.' + (o.ext || 'jpg');
}

/** 缩略图 key/URL（与原图同目录，沿用 .t<size>.webp 约定） */
function thumbKey(key, size) {
  const k = S3.normalizeKey(key);
  const i = k.lastIndexOf('.');
  return (i > 0 ? k.slice(0, i) : k) + '.t' + size + '.webp';
}

function thumbUrlOf(p, size) {
  const r = parse(p);
  if (r.kind !== 's3' || !r.key) return '';
  return S3.publicUrl(thumbKey(r.key, size));
}

// ── 缩略图存在性缓存（HEAD 校验，避免 404） ──────────────────
const thumbCache = new Map();          // url → { ok:boolean, at:number }
const THUMB_TTL_MS = 6 * 60 * 60 * 1000;
const thumbInflight = new Set();

function cacheGet(url) {
  const hit = thumbCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > THUMB_TTL_MS) { thumbCache.delete(url); return null; }
  return hit.ok;
}

/**
 * C 端改写入口（同步）：
 *   命中缓存且存在 → 返回缩略图 URL；否则触发后台 HEAD 校验并返回 ''（本次用原图）。
 * 与本地 img_thumbs.thumbOf「本次回退、下次命中」的行为保持一致。
 */
function thumbCandidate(p, size) {
  const url = thumbUrlOf(p, size);
  if (!url) return '';
  const cached = cacheGet(url);
  if (cached != null) return cached ? url : '';
  if (!thumbInflight.has(url)) {
    thumbInflight.add(url);
    const key = S3.normalizeKey(parse(p).key);
    S3.headObject(thumbKey(key, size))
      .then((r) => thumbCache.set(url, { ok: r.ok, at: Date.now() }))
      .catch(() => thumbCache.set(url, { ok: false, at: Date.now() }))
      .finally(() => thumbInflight.delete(url));
  }
  return '';
}

// ── 图片处理 ──────────────────────────────────────────────────
function extFrom(filename, contentType) {
  const byMime = MIME_EXT[String(contentType || '').toLowerCase().split(';')[0].trim()];
  if (byMime) return byMime;
  const ext = path.extname(String(filename || '')).replace(/^\./, '').toLowerCase();
  if (ALLOWED_EXT.has(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  return '';
}

/**
 * 归一化：自动纠正方向 + 限宽 + 去元数据，统一输出 JPEG（webp 保持原样）。
 * 返回体带上**实际输出的 mime**，避免「内容重编码了、Content-Type 还写原来的」这类不一致。
 * 失败则原样返回（不阻断上传）。
 */
async function normalize(buffer, maxWidth) {
  if (!sharp) return { buffer, changed: false, mime: '', width: null, height: null };
  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    if (meta.format === 'webp') return { buffer, changed: false, mime: 'image/webp', width: meta.width || null, height: meta.height || null };
    if (!MIME_EXT['image/' + meta.format]) return { buffer, changed: false, mime: '', width: meta.width || null, height: meta.height || null };
    const isJpeg = meta.format === 'jpeg';
    const needResize = !!(meta.width && meta.width > (maxWidth || DEFAULT_MAX_WIDTH));
    // 已是 JPEG 且无需缩宽 → 原样上传（避免无谓重编码掉画质）
    if (isJpeg && !needResize) return { buffer, changed: false, mime: 'image/jpeg', width: meta.width || null, height: meta.height || null };
    let pipe = sharp(buffer, { failOn: 'none' }).rotate();
    if (needResize) pipe = pipe.resize({ width: maxWidth || DEFAULT_MAX_WIDTH, withoutEnlargement: true });
    const out = await pipe.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    return { buffer: out, changed: true, mime: 'image/jpeg', width: meta.width || null, height: meta.height || null };
  } catch (_) {
    return { buffer, changed: false, mime: '', width: null, height: null };
  }
}

async function makeThumbs(buffer) {
  const out = {};
  if (!sharp) return out;
  for (const size of THUMB_SIZES) {
    try {
      out[size] = await sharp(buffer, { failOn: 'none' })
        .resize({ width: size, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();
    } catch (_) { /* 单档失败忽略 */ }
  }
  return out;
}

// ── 本地兜底 ──────────────────────────────────────────────────
function saveLocal(buffer, ext, subdir) {
  const dir = path.join(LOCAL_UPLOAD_DIR, subdir || '');
  fs.mkdirSync(dir, { recursive: true });
  const name = crypto.randomUUID().replace(/-/g, '') + '.' + ext;
  fs.writeFileSync(path.join(dir, name), buffer);
  const urlPath = LOCAL_URL_PREFIX + (subdir ? subdir + '/' : '') + name;
  return { urlPath, diskPath: path.join(dir, name) };
}

// ── 上传 ──────────────────────────────────────────────────────
/**
 * 上传房源图片（原图 + 两档缩略图）
 * @param {object} opts
 *   buffer       | sourceUrl   二选一：图片二进制，或远程 URL（服务端镜像拉取）
 *   filename / contentType    可选
 *   entityType / entityId     归属（project / unit / spot / district ...）
 *   prefix                    业务前缀，缺省 housing
 *   makeThumbs                true（缺省）= 同时生成 t240/t640
 *   isCover                   仅用于返回体提示，不落库
 * @returns {Promise<{ok:boolean, storage:'s3'|'local', url:string, key:string, thumb_240:string, thumb_640:string,
 *                    bytes:number, width:number|null, height:number|null, error?:string, warned?:string}>}
 */
async function uploadImage(opts) {
  const o = opts || {};
  let buffer = o.buffer;
  let contentType = o.contentType || '';

  // 远程镜像
  if (!buffer && o.sourceUrl) {
    if (!/^https?:\/\//i.test(o.sourceUrl)) return fail('sourceUrl 必须是 http(s) 地址');
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      const res = await fetch(o.sourceUrl, { signal: ac.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) return fail('拉取远程图片失败: HTTP ' + res.status);
      contentType = contentType || res.headers.get('content-type') || '';
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      return fail('拉取远程图片异常: ' + String(e && e.message || e));
    }
  }

  if (!buffer || !buffer.length) return fail('缺少图片内容（buffer 或 sourceUrl）');
  if (buffer.length > maxBytes()) return fail(`图片过大（${(buffer.length / 1048576).toFixed(1)}MB > ${(maxBytes() / 1048576).toFixed(0)}MB）`);

  const ext = extFrom(o.filename, contentType);
  if (!ext) return fail('不支持的图片格式（仅 jpg/jpeg/png/webp）');
  if (!contentType) contentType = Object.keys(MIME_EXT).find((k) => MIME_EXT[k] === ext) || 'image/jpeg';

  const norm = await normalize(buffer, o.maxWidth);
  const finalBuf = norm.buffer;
  // 归一化可能改变编码格式（PNG→JPEG）：Content-Type 与扩展名都必须跟着走
  if (norm.mime) contentType = norm.mime;
  const finalExt = MIME_EXT[String(contentType).toLowerCase()] || ext;
  const thumbs = o.makeThumbs === false ? {} : await makeThumbs(finalBuf);

  // ── S3 分支 ──
  if (storageMode() === 's3') {
    const key = keyFor({ prefix: o.prefix, entityType: o.entityType, entityId: o.entityId, ext: finalExt });
    const up = await S3.uploadLarge(key, finalBuf, { contentType });
    if (!up.ok) {
      // 上传失败 → 回落本地，业务不中断（同时把失败原因带回，便于排查）
      const local = saveLocal(finalBuf, finalExt, '');
      return {
        ok: true, storage: 'local', url: local.urlPath, key: local.urlPath,
        thumb_240: '', thumb_640: '', bytes: finalBuf.length,
        content_type: contentType, width: norm.width, height: norm.height,
        warned: `S3 上传失败（HTTP ${up.status}${up.error ? ' ' + up.error : ''}），已回落本地存储`,
      };
    }
    const thumbRes = { thumb_240: '', thumb_640: '' };
    let thumbWarn = '';
    for (const size of THUMB_SIZES) {
      if (!thumbs[size]) continue;
      // eslint-disable-next-line no-await-in-loop
      const t = await S3.putObject(thumbKey(key, size), thumbs[size], { contentType: 'image/webp' });
      if (t.ok) thumbRes['thumb_' + size] = S3.publicUrl(thumbKey(key, size));
      else thumbWarn = thumbWarn || `缩略图 t${size} 上传失败（HTTP ${t.status}）`;
    }
    const url = S3.publicUrl(key);
    thumbCache.set(thumbUrlOf(url, 240), { ok: !!thumbRes.thumb_240, at: Date.now() });
    thumbCache.set(thumbUrlOf(url, 640), { ok: !!thumbRes.thumb_640, at: Date.now() });
    return {
      ok: true, storage: 's3', url, key,
      thumb_240: thumbRes.thumb_240, thumb_640: thumbRes.thumb_640,
      bytes: finalBuf.length, content_type: contentType,
      width: norm.width, height: norm.height, recompressed: !!norm.changed,
      warned: thumbWarn || undefined,
    };
  }

  // ── 本地分支 ──
  const local = saveLocal(finalBuf, finalExt, '');
  return {
    ok: true, storage: 'local', url: local.urlPath, key: local.urlPath,
    thumb_240: '', thumb_640: '', bytes: finalBuf.length,
    content_type: contentType, width: norm.width, height: norm.height, recompressed: !!norm.changed,
    warned: 'S3 未配置，已写入本地 assets/uploads（配置 S3_* 后自动切换对象存储）',
  };

  function fail(msg) {
    return { ok: false, storage: storageMode(), url: '', key: '', thumb_240: '', thumb_640: '', bytes: 0, width: null, height: null, error: msg };
  }
}

// ── 读取 ──────────────────────────────────────────────────────
/** 读取图片二进制（本地读磁盘；S3 走 GET，用于代理接口/迁移/服务端二次处理） */
async function readImage(p) {
  const r = parse(p);
  if (!r.kind) return { ok: false, error: '空路径' };
  if (r.kind === 'local') {
    const disk = path.join(ROOT, decodeURIComponent(r.path.replace(/^\/+/, '')));
    try {
      const stat = fs.statSync(disk);
      return { ok: true, buffer: fs.readFileSync(disk), bytes: stat.size, contentType: mimeOfExt(path.extname(disk)) };
    } catch (e) {
      return { ok: false, error: '本地文件不存在: ' + r.path };
    }
  }
  const got = await S3.getObjectBuffer(r.key);
  if (!got.ok) return { ok: false, error: got.error || 'S3 读取失败', status: got.status };
  return { ok: true, buffer: got.buffer, bytes: got.buffer.length, contentType: got.contentType || mimeOfExt(path.extname(r.key)) };
}

function mimeOfExt(ext) {
  const e = String(ext || '').replace(/^\./, '').toLowerCase();
  return MIME_EXT['image/' + (e === 'jpg' ? 'jpeg' : e)] || 'application/octet-stream';
}

/** 把已有本地图片迁到 S3，返回新的可展示 URL（失败抛错，由调用方决定是否回退） */
async function migrateLocalToS3(localPath, opts) {
  const r = parse(localPath);
  if (r.kind !== 'local') return { ok: true, url: resolveUrl(localPath), skipped: true };
  const disk = path.join(ROOT, decodeURIComponent(r.path.replace(/^\/+/, '')));
  const buf = fs.readFileSync(disk);
  const res = await uploadImage(Object.assign({ buffer: buf, filename: path.basename(disk), makeThumbs: false }, opts || {}));
  if (!res.ok || res.storage !== 's3') throw new Error(res.error || 'S3 迁移失败（已回落本地）');
  return { ok: true, url: res.url, key: res.key };
}

module.exports = {
  storageMode,
  maxBytes,
  isLocalPath,
  isS3Url,
  parse,
  resolveUrl,
  keyFor,
  thumbKey,
  thumbUrlOf,
  thumbCandidate,
  uploadImage,
  readImage,
  migrateLocalToS3,
  normalize,
  makeThumbs,
  THUMB_SIZES,
  LOCAL_URL_PREFIX,
  _thumbCache: thumbCache,
};
