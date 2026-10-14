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

/** 非标准图片 MIME 别名归一（AWS 预签名 response-content-type 等会产出 application/jpg 这类值） */
const MIME_ALIAS = {
  'application/jpg': 'image/jpeg',
  'application/jpeg': 'image/jpeg',
  'application/png': 'image/png',
  'application/webp': 'image/webp',
  'application/x-jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-webp': 'image/webp',
  'image/vnd.mozilla.jpeg': 'image/jpeg',
};
function normalizeMime(ct) {
  const m = String(ct || '').toLowerCase().split(';')[0].trim();
  return MIME_ALIAS[m] || m;
}

/** 图片魔数嗅探（jpg/png/webp/gif；内容层判定，不依赖 URL/响应头——签名 URL 场景的最终兜底） */
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
      && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'webp';
  return '';
}

/** URL pathname 取扩展名（剥掉签名 query，如 .jpg?X-Amz-...） */
function extFromUrl(u) {
  const s = String(u || '');
  if (!s) return '';
  let p = s;
  try { p = new URL(s).pathname; } catch (_) { p = s.split('?')[0].split('#')[0]; }
  const ext = String(p).split('/').pop().split('.').pop();
  const e = (ext || '').toLowerCase();
  return ALLOWED_EXT.has(e) ? (e === 'jpeg' ? 'jpg' : e) : '';
}

/** 存储模式：s3 = 已配置可用；local = 回落本地磁盘 */
function storageMode() {
  return S3.isConfigured() ? 's3' : 'local';
}

function maxBytes() {
  const n = parseInt(process.env.S3_MAX_BYTES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

// ── 路径工具 ──────────────────────────────────────────────────
/** 本地静态路径判定：必须在 assets/ 下，且不含路径穿越/反斜杠/控制字符 */
function isLocalPath(p) {
  const s = String(p || '');
  if (!/^\/?assets\//i.test(s)) return false;
  if (s.split(/[\\/]/).includes('..')) return false;
  if (s.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(s)) return false;
  return true;
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

// ── 灰度 / 回滚开关（口径见 docs/s3-intake-api-plan.md §5） ─────
/**
 * 写侧 + 读侧主开关（改环境变量即回滚，不需要发版）：
 *   local —— 最强回滚：即使 S3 配齐也不写 S3，读侧不改写 → 等价改造前
 *   dual  —— 缺省：新上传走 S3；读侧不改写存量本地路径
 *   s3    —— 新上传走 S3 + 读侧把 assets/... 改写为迁移前缀下的公网 URL
 */
function urlMode() {
  const v = String(process.env.IMG_URL_MODE == null ? 'dual' : process.env.IMG_URL_MODE).trim().toLowerCase();
  return (v === 'local' || v === 's3') ? v : 'dual';
}

/** 外部（第三方）图片 URL 的处置策略：keep = 原样保留（缺省，零行为变化）| mirror = 镜像进对象存储 */
function ingestMode() {
  const v = String(process.env.IMG_INGEST == null ? 'keep' : process.env.IMG_INGEST).trim().toLowerCase();
  return v === 'mirror' ? 'mirror' : 'keep';
}

/** 是否允许 sharp 重编码（0 = 保原格式，PNG 透明不丢） */
function normalizeRewriteEnabled() {
  return String(process.env.IMG_NORMALIZE == null ? '1' : process.env.IMG_NORMALIZE) !== '0';
}

/** S3 未配置时是否 fail-closed（生产必开：后端发行包不含 assets/，回落本地 = 静默丢图） */
function failOnUnconfigured() {
  return String(process.env.S3_FAIL_ON_UNCONFIGURED == null ? '0' : process.env.S3_FAIL_ON_UNCONFIGURED) === '1';
}

/** 写侧实际落点：local 模式强制本地 */
function writeMode() {
  return urlMode() === 'local' ? 'local' : storageMode();
}

/** 存量迁移 key 前缀（缺省 <S3_KEY_PREFIX>/legacy） */
function migratePrefix() {
  const raw = String(process.env.S3_MIGRATE_PREFIX || '').trim().replace(/^\/+|\/+$/g, '');
  if (raw) return raw;
  const kp = S3.config().keyPrefix;
  return kp ? kp + '/legacy' : 'legacy';
}

/** 本地引用 → 确定性迁移 key：assets/juzhu/sy/x.jpg → <migratePrefix>/juzhu/sy/x.jpg
 *  注意：必须确定性（不能用 keyFor 的 uuid），否则与读侧改写不一致 → 切读必然 404。 */
function legacyKeyOf(ref) {
  const s = String(ref || '').trim();
  if (!isLocalPath(s)) return '';
  const rel = s.replace(/^\/+/, '').replace(/^assets\//i, '');
  if (!rel) return '';
  return migratePrefix() + '/' + rel;
}

function legacyUrlOf(ref) {
  const k = legacyKeyOf(ref);
  return k ? S3.publicUrl(k) : '';
}

const IMG_EXT_RE = /\.(jpe?g|png|webp|gif|avif)$/i;

/** 裸 key 判定：必须带 <keyPrefix>/ / <migratePrefix>/ / housing/ 前缀（写侧从严，避免把历史相对路径误判成对象 key） */
function looksLikeKey(s) {
  const v = String(s || '');
  const kp = S3.config().keyPrefix;
  if (kp && v.startsWith(kp + '/')) return true;
  const mp = migratePrefix();
  if (mp && v.startsWith(mp + '/')) return true;
  return v.startsWith('housing/');
}

function isExternalUrl(p) {
  const s = String(p || '');
  return S3.looksLikeUrl(s) && !isS3Url(s);
}

/**
 * 形态归一化（纯函数，不触网）：任意图片引用 → 统一形态
 *   本地      → /assets/...            （存量零改动：dual 下仅补前导斜杠）
 *   对象存储  → https://<file-domain>/<bucket>/<key>
 *   内联      → data: / blob: 原样
 *   第三方    → 原样保留（是否镜像由 IMG_INGEST 决定，见 ingestRef）
 * @returns {{ok:boolean, ref:string, kind:'local'|'s3'|'external'|'inline'|'unknown', changed:boolean, warn:string}}
 */
function normalizeImageRef(p) {
  const raw = String(p == null ? '' : p).trim();
  if (!raw) return { ok: false, ref: '', kind: 'unknown', changed: false, warn: '空图片引用' };
  if (/^(data|blob):/i.test(raw)) return { ok: true, ref: raw, kind: 'inline', changed: false, warn: '' };
  if (isLocalPath(raw)) {
    const norm = '/' + raw.replace(/^\/+/, '');
    return { ok: true, ref: norm, kind: 'local', changed: norm !== raw, warn: '' };
  }
  if (S3.looksLikeUrl(raw)) {
    if (isS3Url(raw)) {
      const url = S3.publicUrl(parse(raw).key);
      return { ok: true, ref: url || raw, kind: 's3', changed: !!url && url !== raw, warn: '' };
    }
    return { ok: true, ref: raw, kind: 'external', changed: false, warn: '' };
  }
  if (/^s3:\/\//i.test(raw) || looksLikeKey(raw)) {
    return { ok: true, ref: S3.publicUrl(S3.normalizeKey(raw)), kind: 's3', changed: true, warn: '' };
  }
  return { ok: false, ref: raw, kind: 'unknown', changed: false, warn: '无法识别的图片引用（既非本地路径/对象 key，也非 http URL）' };
}

/** 读侧出口：IMG_URL_MODE=s3 时把存量本地引用改写为迁移前缀下的公网 URL（不改库即可灰度切读） */
function resolveForRead(p) {
  const s = String(p == null ? '' : p).trim();
  if (urlMode() !== 's3' || !isLocalPath(s)) return s;
  return legacyUrlOf(s) || s;
}

/** 引用是否"像一张真图"（用于上架封面/图集判定，排除 'todo' / '-' / 空 等脏值） */
function isValidImageRef(p) {
  const raw = String(p == null ? '' : p).trim();
  if (!raw || raw === '-' || raw.length > 600) return false;
  if (/^data:/i.test(raw)) return true;
  if (isLocalPath(raw)) return IMG_EXT_RE.test(raw);
  if (S3.looksLikeUrl(raw)) return true;
  return looksLikeKey(raw);
}

// ── 外部 URL 安全（SSRF 防护） ─────────────────────────────────
function sourceUrlAllowed(url) {
  const raw = String(process.env.S3_SOURCE_URL_ALLOWLIST || '').trim();
  if (!raw) return true;                       // 未配置白名单：不限制（缺省 keep 模式不会走到镜像）
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch (_) { return false; }
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .some((h) => host === h || host.endsWith('.' + h));
}

/**
 * 字面量层面的内网/非法地址拦截（DNS 解析后的私网仍需出网侧策略兜底，见计划书 R8）。
 */
function isBlockedHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.startsWith('[') || h.includes(':')) return true;         // IPv6 一律拒（简化，业务不需要）
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;                     // link-local（云元数据）
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  return false;
}

/**
 * 写入收口：任意图片引用 → 受管引用。
 *   - 非 external：只做形态归一化（不触网）
 *   - external   ：IMG_INGEST=mirror 时（且 opts.mirror 显式为真）镜像进对象存储；否则原样保留
 * @param {string} ref
 * @param {object} opts { mirror?:boolean, prefix?, entityType?, entityId?, makeThumbs? }
 * @returns {Promise<{ok:boolean, ref:string, kind:string, changed:boolean, mirrored:boolean, upload?:object, error?:string, warn?:string}>}
 */
async function ingestRef(ref, opts) {
  const o = opts || {};
  const n = normalizeImageRef(ref);
  if (!n.ok) return { ok: false, ref: '', kind: n.kind, changed: false, mirrored: false, error: n.warn };
  if (n.kind !== 'external') {
    // 本地引用镜像（no-assets 变体：生产发行包不含 assets/，本地引用必坏图）。
    // IMG_INGEST=mirror 时读本地文件上对象存储；key 用 legacyKeyOf() 确定性前缀
    // —— 与存量迁移/读侧改写（IMG_URL_MODE=s3）同口径，重复推送幂等覆盖、零孤儿。
    if (n.kind === 'local' && o.mirror && ingestMode() === 'mirror') {
      const read = await readImage(n.ref).catch(() => null);
      if (read && read.ok && read.buffer && read.buffer.length) {
        const key = legacyKeyOf(n.ref);
        // eslint-disable-next-line no-await-in-loop
        const up = await uploadImage({
          buffer: read.buffer,
          key,
          // 注意：readImage 的 contentType 字段实为扩展名（如 'jpg'），此处传 filename 供格式推导
          filename: path.posix.basename(decodeURIComponent(n.ref)),
          makeThumbs: o.makeThumbs,
        });
        if (up.ok && up.storage === 's3') {
          return { ok: true, ref: up.url, kind: 's3', changed: true, mirrored: true, upload: up, warn: up.warned || '' };
        }
        // 上传失败/回落本地：保留原本地引用（其本身有效，不因镜像失败拒绝业务），带 warn 便于排查
        console.warn('[img] 本地引用镜像未生效，保留本地引用 ' + n.ref + '：' + (up && up.warned ? up.warned : '上传失败'));
        return { ok: true, ref: n.ref, kind: 'local', changed: n.changed, mirrored: false,
          warn: `本地图片镜像对象存储未生效（${up && up.warned ? up.warned : '上传失败'}），保留本地引用` };
      }
      // 本地文件不存在（如 Serverless 无 assets/）：保留原引用
      console.warn('[img] 本地引用镜像跳过（本地文件不存在）：' + n.ref);
    }
    return { ok: true, ref: n.ref, kind: n.kind, changed: n.changed, mirrored: false, warn: n.warn || '' };
  }
  if (!o.mirror || ingestMode() !== 'mirror') {
    console.warn('[img] 外部图片原样保留（mirror=' + !!o.mirror + ' IMG_INGEST=' + (process.env.IMG_INGEST || 'keep') + '）：' + n.ref);
    return { ok: true, ref: n.ref, kind: 'external', changed: false, mirrored: false,
      warn: '外部图片原样保留（IMG_INGEST != mirror）' };
  }
  let host = '';
  try { host = new URL(n.ref).host.toLowerCase(); } catch (_) {
    return { ok: false, ref: n.ref, kind: 'external', changed: false, mirrored: false, error: 'source_url 非法' };
  }
  if (isBlockedHost(host)) {
    return { ok: false, ref: n.ref, kind: 'external', changed: false, mirrored: false,
      error: 'source_url 指向内网/非法地址（SSRF 防护拦截）' };
  }
  if (!sourceUrlAllowed(n.ref)) {
    return { ok: false, ref: n.ref, kind: 'external', changed: false, mirrored: false,
      error: 'source_url 不在 S3_SOURCE_URL_ALLOWLIST 白名单内' };
  }
  const up = await uploadImage({
    sourceUrl: n.ref,
    prefix: o.prefix,
    entityType: o.entityType,
    entityId: o.entityId,
    makeThumbs: o.makeThumbs,
  });
  if (!up.ok) return { ok: false, ref: n.ref, kind: 'external', changed: false, mirrored: false, error: '镜像失败: ' + up.error };
  if (up.storage !== 's3' && failOnUnconfigured()) {
    return { ok: false, ref: n.ref, kind: 'external', changed: false, mirrored: false, error: '镜像未落到对象存储: ' + (up.warned || '') };
  }
  if (up.storage !== 's3') {
    console.warn('[img] 外部图片镜像回落本地（保留原引用 ' + n.ref + ' → ' + up.url + '）：' + (up.warned || '原因未知'));
    return { ok: true, ref: n.ref, kind: 'external', changed: false, mirrored: false,
      warn: '镜像未落到对象存储（' + (up.warned || '原因未知') + '），保留原外部 URL' };
  }
  console.log('[img] 外部图片镜像成功 ' + n.ref + ' → ' + up.url);
  return { ok: true, ref: up.url, kind: 's3', changed: true, mirrored: true, upload: up, warn: up.warned || '' };
}

/**
 * 删除对象（含两档缩略图）；用于"上传成功但落库失败"的补偿删除与显式删除。
 * ⚠ 只接受**本域**引用（s3:// / 裸 key / 本域公网 URL）：
 *   绝不对外部第三方 URL 反解 key —— 否则 https://other-cdn/x.jpg 会被当成 <bucket>/x.jpg 删除，
 *   可能误删同名对象（本函数默认按「不确定就不动」处理）。
 */
async function deleteObjectByRef(ref, opts) {
  const o = opts || {};
  const s = String(ref == null ? '' : ref).trim();
  if (!s) return { ok: false, skipped: true, error: '空引用' };
  if (isLocalPath(s)) return { ok: false, skipped: true, error: '本地引用无需删除对象' };
  let key = '';
  if (/^s3:\/\//i.test(s)) key = S3.normalizeKey(s);
  else if (looksLikeKey(s)) key = s;
  else if (S3.looksLikeUrl(s) && isS3Url(s)) key = parse(s).key;
  else return { ok: false, skipped: true, error: '非本域对象引用（拒绝对外部 URL 反解 key，避免误删）' };
  if (!key) return { ok: false, skipped: true, error: 'key 为空' };
  if (!S3.isConfigured()) return { ok: false, skipped: true, error: 'S3 未配置' };
  const out = { ok: true, key, deleted: [] };
  const del = async (k) => {
    const res = await S3.deleteObject(k);
    if (res.ok) out.deleted.push(k); else out.ok = false;
    return res;
  };
  await del(key);
  if (o.thumbs !== false) {
    for (const size of THUMB_SIZES) await del(thumbKey(key, size));
  }
  return out;
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
  const byMime = MIME_EXT[normalizeMime(contentType)];
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

  // 扩展名三层推导（签名 URL / 非标准 MIME 兜底）：
  //   ① filename / content-type（含别名归一）→ ② sourceUrl pathname（剥签名 query）→ ③ 图片魔数嗅探
  const ext = extFrom(o.filename, contentType)
    || extFromUrl(o.sourceUrl)
    || sniffImageExt(buffer);
  if (!ext) return fail('不支持的图片格式（仅 jpg/jpeg/png/webp）');
  // content-type 归一：非标准/未知 MIME（如 AWS response-content-type=application/jpg）→ 用扩展名反推标准值
  if (!MIME_EXT[normalizeMime(contentType)]) {
    contentType = Object.keys(MIME_EXT).find((k) => MIME_EXT[k] === ext) || 'image/jpeg';
  }

  const norm = normalizeRewriteEnabled()
    ? await normalize(buffer, o.maxWidth)
    : { buffer, changed: false, mime: '', width: null, height: null };
  const finalBuf = norm.buffer;
  // 归一化可能改变编码格式（PNG→JPEG）：Content-Type 与扩展名都必须跟着走
  if (norm.mime) contentType = norm.mime;
  const finalExt = MIME_EXT[String(contentType).toLowerCase()] || ext;
  const thumbs = o.makeThumbs === false ? {} : await makeThumbs(finalBuf);

  // ── S3 分支 ──
  if (writeMode() === 's3') {
    // o.key 用于「幂等重试复用同一 key」；缺省每次生成 uuid key
    const key = o.key ? S3.normalizeKey(o.key) : keyFor({ prefix: o.prefix, entityType: o.entityType, entityId: o.entityId, ext: finalExt });
    const up = await S3.uploadLarge(key, finalBuf, { contentType });
    if (!up.ok) {
      // 上传失败 → 回落本地，业务不中断（同时把失败原因带回，便于排查）
      const reason = `S3 上传失败（HTTP ${up.status}${up.error ? ' ' + up.error : ''}）`;
      if (failOnUnconfigured()) return fail(`${reason}，且 S3_FAIL_ON_UNCONFIGURED=1 禁止回落本地`);
      console.warn('[img] ' + reason + '，已回落本地存储 assets/uploads/（key=' + key + '）');
      const local = saveLocal(finalBuf, finalExt, '');
      return {
        ok: true, storage: 'local', url: local.urlPath, key: local.urlPath,
        thumb_240: '', thumb_640: '', bytes: finalBuf.length,
        content_type: contentType, width: norm.width, height: norm.height,
        warned: `${reason}，已回落本地存储`,
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
  // 生产 fail-closed：后端发行包不含 assets/，回落本地 = 写下不可服务的文件（静默丢图）
  if (failOnUnconfigured() && urlMode() !== 'local') {
    return fail('S3 未配置（S3_ACCESS_KEY/S3_SECRET_KEY/S3_ENDPOINT/S3_BUCKET），且 S3_FAIL_ON_UNCONFIGURED=1 禁止回落本地');
  }
  console.warn('[img] 上传回落本地存储（storage=' + storageMode() + '）：S3 分支未生效，文件仅存服务器磁盘 assets/uploads/');
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
    // 纵深防御：解析后必须仍在仓库根内（防路径穿越读任意文件）
    const rel = path.relative(ROOT, disk);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: '非法本地路径' };
    }
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
  // 灰度 / 回滚开关
  urlMode,
  writeMode,
  ingestMode,
  normalizeRewriteEnabled,
  failOnUnconfigured,
  migratePrefix,
  // 引用归一化（写侧收口 / 读侧出口）
  legacyKeyOf,
  legacyUrlOf,
  isExternalUrl,
  looksLikeKey,
  normalizeImageRef,
  resolveForRead,
  isValidImageRef,
  sourceUrlAllowed,
  isBlockedHost,
  ingestRef,
  deleteObjectByRef,
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
  // 格式推导工具（签名 URL/非标准 MIME 场景，2026-10-12）
  sniffImageExt,
  normalizeMime,
  extFromUrl,
  migrateLocalToS3,
  normalize,
  makeThumbs,
  THUMB_SIZES,
  LOCAL_URL_PREFIX,
  _thumbCache: thumbCache,
};
