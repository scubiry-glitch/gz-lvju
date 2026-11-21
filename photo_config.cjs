/**
 * photo_config.cjs —— 房源图集单一数据源（2026-09）
 *
 * 图集的数量 / 分类 / 排序 / 大小与分辨率规则只写在这里，商家开放接口（vendor_api.cjs）
 * 与后台（app.js）共用，页面与其它模块不得再写一份枚举或阈值。
 *
 * 两块能力：
 *  1) 纯函数：分类归一化、全量覆盖入参归一化（分类 + 排序 + 封面 + 去重）、声明值校验；
 *  2) probeImage()：带防护的远程图片探测（仅商家开放接口的上架抽检用）——禁内网/环回/云元数据
 *     地址、限时、限字节、不跟随跨站跳转，任一环节异常都不抛异常、只回状态。
 *     尺寸判定用零依赖 readImageSize()（jpg/png/gif/webp/bmp），**不得依赖 sharp**——
 *     sharp 缺失属服务端缺件，若混入「网络不可达」会让抽检闸静默失效（2026-10-14 线上问题）。
 */
'use strict';

const dns = require('dns');
const http = require('http');
const https = require('https');

// ===== 分类枚举（C 端按 category 分组/打标，label 与 icon 随接口下发）=====
const PHOTO_CATEGORIES = [
  { key: 'bedroom', label: '卧室', short: '卧室', icon: '🛏' },
  { key: 'kitchen', label: '厨房', short: '厨房', icon: '🍳' },
  { key: 'bathroom', label: '卫生间', short: '卫浴', icon: '🛁' },
  { key: 'living', label: '客厅', short: '客厅', icon: '🛋' },
  { key: 'nearby', label: '周边', short: '周边', icon: '🗺' },
  { key: 'other', label: '其他', short: '其他', icon: '🏠' },
];
const PHOTO_CATEGORY_KEYS = PHOTO_CATEGORIES.map((c) => c.key);
const PHOTO_CATEGORY_DEFAULT = 'other';

// ===== 规则阈值 =====
// 上架闸：房源图 + 其户型图集合计。2026-09-18 按商家反馈由 8 调整为 7（含封面即满足）。
// 两个上架闸（vendor_api.publishEligibility / app.js projectPublishEligibility）都读这一份，不得各写一个。
const PHOTO_MIN_PUBLISH = 7;
const PHOTO_MAX_PER_SYNC = 100;                    // 单次全量覆盖上限，超出截取前 100（按 sort/数组顺序）
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;          // 单图 ≤ 10MB
const PHOTO_MIN_WIDTH = 800;                       // 分辨率 ≥ 800×600
const PHOTO_MIN_HEIGHT = 600;
const PHOTO_URL_MAX_LEN = 500;                     // 与 photos.file_path 列宽一致
const PHOTO_SPOT_CHECK = 2;                        // 上架抽检张数（真拉取）
const PHOTO_PROBE_TIMEOUT_MS = 5000;
const PHOTO_PROBE_CACHE_MS = 10 * 60 * 1000;

const CATEGORY_LABEL = {};
PHOTO_CATEGORIES.forEach((c) => { CATEGORY_LABEL[c.key] = c.label; });

/** 分类归一化：空 = other；未知分类抛 Error（写入口据此 400） */
function normalizeCategoryInput(v) {
  if (v == null || v === '') return PHOTO_CATEGORY_DEFAULT;
  const s = String(v).trim().toLowerCase();
  if (!s) return PHOTO_CATEGORY_DEFAULT;
  if (PHOTO_CATEGORY_KEYS.indexOf(s) < 0) {
    throw new Error(`category 须为 ${PHOTO_CATEGORY_KEYS.join(' / ')} 之一（缺省 ${PHOTO_CATEGORY_DEFAULT}）`);
  }
  return s;
}

/** 图片地址：商家开放接口只收绝对 http(s)，避免把平台/相对路径混进外部图集 */
function normalizePhotoUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) throw new Error('url（file_path）必填');
  if (s.length > PHOTO_URL_MAX_LEN) throw new Error(`url 长度须 ≤ ${PHOTO_URL_MAX_LEN}`);
  if (!/^https?:\/\//i.test(s)) throw new Error('url 须为 http/https 绝对地址');
  return s;
}

/** 声明值（可选）：仅做范围校验，真伪由上架抽检核对 */
function validateDeclared(declared) {
  const d = declared || {};
  const out = {};
  const pickInt = (v, name, min, max) => {
    if (v == null || v === '') return null;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} 须为正整数`);
    if (n > max) throw new Error(`${name} 超出上限（${max}）`);
    if (n < min && name !== 'size_bytes') throw new Error(`${name} 低于下限（${min}）`);
    return n;
  };
  const w = pickInt(d.width, 'width', PHOTO_MIN_WIDTH, 100000);
  const h = pickInt(d.height, 'height', PHOTO_MIN_HEIGHT, 100000);
  const b = d.size_bytes == null || d.size_bytes === '' ? null : parseInt(d.size_bytes, 10);
  if (b != null && (!Number.isFinite(b) || b <= 0)) throw new Error('size_bytes 须为正整数');
  if (b != null && b > PHOTO_MAX_BYTES) throw new Error(`单图不得超过 ${Math.round(PHOTO_MAX_BYTES / 1048576)}MB`);
  if (w != null) out.width = w;
  if (h != null) out.height = h;
  if (b != null) out.size_bytes = b;
  return out;
}

/**
 * 全量覆盖入参归一化：分类 / 排序 / 封面 / 去重 / 上限截取。
 * 返回 { items, truncated, warnings, cover_index }；非法直接抛 Error（调用方 400）。
 * items[i] = { file_path, category, sort_order, is_cover, external_id, declared }
 * sort_order 归一化为 0..n-1：显式 sort 优先，缺省按数组下标；同值按原顺序稳定排列。
 */
function normalizeGalleryInput(list) {
  if (!Array.isArray(list)) throw new Error('photos 须为数组');
  if (!list.length) throw new Error('photos 不能为空数组（如需清空请改用逐张删除）');
  const warnings = [];
  let truncated = false;
  let raw = list;
  if (raw.length > PHOTO_MAX_PER_SYNC) {
    // 按 sort（缺省下标）排序后截取前 N，与最终落库顺序一致
    raw = raw.map((it, i) => ({ it, i }))
      .sort((a, b) => {
        const sa = a.it && a.it.sort != null && a.it.sort !== '' ? Number(a.it.sort) : a.i;
        const sb = b.it && b.it.sort != null && b.it.sort !== '' ? Number(b.it.sort) : b.i;
        return (Number.isFinite(sa) ? sa : a.i) - (Number.isFinite(sb) ? sb : b.i);
      })
      .slice(0, PHOTO_MAX_PER_SYNC)
      .sort((a, b) => a.i - b.i)          // 还原原数组顺序，便于报错定位
      .map((x) => x.it);
    truncated = true;
    warnings.push(`photos 超过 ${PHOTO_MAX_PER_SYNC} 张，已按 sort / 数组顺序截取前 ${PHOTO_MAX_PER_SYNC} 张`);
  }
  const seenUrl = new Set();
  const seenExt = new Set();
  const items = raw.map((rawItem, i) => {
    const it = rawItem || {};
    const filePath = normalizePhotoUrl(it.url != null ? it.url : it.file_path);
    if (seenUrl.has(filePath)) throw new Error(`photos[${i}].url 重复（同一张图只能出现一次）`);
    seenUrl.add(filePath);
    const ext = it.external_id == null || it.external_id === '' ? null : String(it.external_id).trim().slice(0, 120);
    if (ext) {
      if (seenExt.has(ext)) throw new Error(`photos[${i}].external_id 重复（${ext}）`);
      seenExt.add(ext);
    }
    const declared = validateDeclared(it.declared && typeof it.declared === 'object' ? it.declared : {
      width: it.width, height: it.height, size_bytes: it.size_bytes,
    });
    const rawSort = it.sort == null || it.sort === '' ? i : parseInt(it.sort, 10);
    return {
      file_path: filePath,
      category: normalizeCategoryInput(it.category),
      is_cover: it.is_cover === true || it.is_cover === 'true' || it.is_cover === 1 || it.is_cover === '1',
      external_id: ext,
      declared,
      _rawSort: Number.isFinite(rawSort) ? rawSort : i,
      _idx: i,
    };
  });
  return { items, truncated, warnings };
}

/** 归一化 sort_order：按 _rawSort 升序，同值保持原数组顺序 → 0..n-1 */
function assignSortOrders(items) {
  return items.slice()
    .sort((a, b) => (a._rawSort - b._rawSort) || (a._idx - b._idx))
    .map((it, idx) => Object.assign({}, it, { sort_order: idx }));
}

/** 封面归属：显式 is_cover 里 sort 最靠前的那张；都没有 = null（由调用方取排第一张） */
function pickCoverIndex(items) {
  let best = -1;
  let bestSort = Infinity;
  items.forEach((it, i) => {
    if (!it.is_cover) return;
    if (it.sort_order < bestSort) { bestSort = it.sort_order; best = i; }
  });
  return best;
}

/**
 * 图集出参：补分类中文名（C 端 / 后台直接渲染，不要再造一份中文名映射）。
 * 存量行 category 可能为 NULL（迁移前）→ 回落到 other。
 */
function photoOut(r) {
  if (!r || typeof r !== 'object') return r;
  const o = Object.assign({}, r);
  o.category = o.category || PHOTO_CATEGORY_DEFAULT;
  o.category_label = CATEGORY_LABEL[o.category] || o.category;
  return o;
}

/** 批量出参（数组） */
function photosOut(list) {
  return (list || []).map(photoOut);
}

// ===== 远程图片探测（仅上架抽检用）=====

/** 内网 / 环回 / 链路本地 / 云元数据 / 组播地址一律拒绝（SSRF 防护） */
function ipIsBlocked(ip) {
  const s = String(ip || '').trim().toLowerCase();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;              // link-local / 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网段
    if (a >= 224) return true;                            // 组播 / 保留
    return false;
  }
  if (s.startsWith('::ffff:')) return ipIsBlocked(s.slice(7));   // v4-mapped
  const g = parseInt((s.split(':')[0] || '0'), 16);
  if (!Number.isFinite(g)) return true;                   // 解析不出来 = 不放行
  if (s === '::' || s === '::1') return true;
  if ((g & 0xfe00) === 0xfc00) return true;               // fc00::/7 ULA
  if ((g & 0xffc0) === 0xfe80) return true;               // fe80::/10 link-local
  if ((g & 0xff00) === 0xff00) return true;               // ff00::/8 组播
  return false;
}

const probeCache = new Map();   // url → { at, result }

/**
 * 判定一张图的探测结果（纯函数，与网络 I/O 分离，便于单测/回归直接喂事实）。
 * f = { bytes, width, height, statusCode, error, parseFailed }
 * 返回 { status, width?, height?, bytes?, reason? }；status 语义见 probeImage。
 */
function judgeProbe(f) {
  const x = f || {};
  if (x.error) return { status: 'unreachable', reason: x.error };
  if (x.statusCode && (x.statusCode < 200 || x.statusCode >= 300)) {
    return { status: 'unreachable', reason: 'HTTP ' + x.statusCode };
  }
  if (x.bytes != null && x.bytes > PHOTO_MAX_BYTES) {
    return { status: 'rejected', bytes: x.bytes, reason: `单图 ${(x.bytes / 1048576).toFixed(1)}MB，超过 ${Math.round(PHOTO_MAX_BYTES / 1048576)}MB` };
  }
  if (x.parseFailed || x.width == null || x.height == null) {
    return { status: 'rejected', reason: '无法解析图片尺寸（可能不是图片或已损坏）' };
  }
  if (x.width < PHOTO_MIN_WIDTH || x.height < PHOTO_MIN_HEIGHT) {
    return { status: 'rejected', width: x.width, height: x.height, bytes: x.bytes,
      reason: `分辨率 ${x.width}×${x.height} 低于 ${PHOTO_MIN_WIDTH}×${PHOTO_MIN_HEIGHT}` };
  }
  return { status: 'ok', width: x.width, height: x.height, bytes: x.bytes };
}

// ===== 尺寸解析（纯 JS，零依赖；见 readImageSize 注释为何不依赖 sharp）=====

/** JPEG：从 SOFn 段取尺寸（跳过 APPn/COM 等带载荷段） */
function readJpegSize(buf) {
  const n = buf.length;
  let i = 2;
  while (i + 9 < n) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }                              // 段间填充
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }  // 无载荷
    if (marker === 0xda) return null;                                       // 进压缩数据 = 没找到 SOF
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0..SOF15（排除 DHT=C4 / JPG=C8 / DAC=CC）携带宽高
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), format: 'jpeg' };
    }
    i += 2 + len;
  }
  return null;
}

/** WebP：VP8X（扩展）/ VP8L（无损）/ VP8（有损）三种载荷头 */
function readWebpSize(buf) {
  const fourcc = buf.slice(12, 16).toString('latin1');
  if (fourcc === 'VP8X' && buf.length >= 30) {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), format: 'webp' };
  }
  if (fourcc === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, format: 'webp' };
  }
  if (fourcc === 'VP8 ' && buf.length >= 30
    && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' };
  }
  return null;
}

/**
 * 读取图片尺寸（纯 JS，按文件头判定，不解码像素）：
 * JPEG / PNG / GIF / WebP / BMP 覆盖商家图集实际会出现的全部格式。
 * 返回 { width, height, format }；识别不出（非图 / 损坏 / 非白名单格式）→ null。
 *
 * 为什么不走 sharp：sharp 是**原生依赖**，发行包在 mac 上打包、跑到 Linux 上时平台二进制不匹配
 * （或 `npm ci --omit=dev` 未装 devDependencies）→ require('sharp') 直接抛错。
 * 原实现把这种「服务端自身缺件」混进 unreachable 只记 warning，等于上架抽检闸被静默关闭
 * （2026-10-14 线上告警即此）。此处改为零依赖解析，sharp 仅作为未知格式的兜底。
 */
function readImageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {   // PNG + IHDR
    return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' } : null;
  }
  if (buf.slice(0, 3).toString('latin1') === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
  }
  if (buf.slice(0, 2).toString('latin1') === 'BM' && buf.length >= 26) {            // BMP（高可为负=倒序行）
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)), format: 'bmp' };
  }
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return readWebpSize(buf);
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return readJpegSize(buf);                // JPEG SOI
  return null;
}

/**
 * 抽检取尺寸：优先零依赖解析；解析不出（少见格式）再用 sharp 兜底；都没有 → 视为解析失败。
 */
function probeDimensions(buf) {
  const size = readImageSize(buf);
  if (size) return Promise.resolve(size);
  let sharp = null;
  try { sharp = require('sharp'); } catch (_) {}
  if (!sharp) return Promise.resolve(null);
  return sharp(buf, { failOn: 'none' }).metadata()
    .then((m) => (m && m.width && m.height ? { width: m.width, height: m.height, format: m.format } : null))
    .catch(() => null);
}

/**
 * 探测一张远程图：返回 { status, width, height, bytes, reason }
 *   status = 'ok'（读到了且能解析）/ 'rejected'（确定性不合格：超限、非图、地址不合法）
 *          / 'unreachable'（网络/超时/DNS 等非确定性问题——调用方不应据此拒绝）
 * 只在响应体里累计到 PHOTO_MAX_BYTES，超出立即中断（不把大图拉完）。
 */
function probeImage(url, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || PHOTO_PROBE_TIMEOUT_MS;
  const maxBytes = o.maxBytes || PHOTO_MAX_BYTES;
  const useCache = o.cache !== false;
  const cached = useCache ? probeCache.get(url) : null;
  if (cached && Date.now() - cached.at < PHOTO_PROBE_CACHE_MS) return Promise.resolve(cached.result);
  return probeOnce(url, o, timeoutMs, maxBytes, 0).then((result) => {
    if (useCache) probeCache.set(url, { at: Date.now(), result });
    return result;
  });
}

function probeOnce(url, o, timeoutMs, maxBytes, depth) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ status: 'rejected', reason: '图片地址不是合法 URL' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolve({ status: 'rejected', reason: '图片地址须为 http/https' });
    }
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: { 'User-Agent': 'sy-photo-check/1.0', Accept: 'image/*' },
      timeout: timeoutMs,
      // DNS 解析即校验：命中的地址在建连前拦掉，避免解析后重绑定
      lookup: (hostname, options, cb) => {
        dns.lookup(hostname, { all: true }, (err, addrs) => {
          if (err) return cb(err);
          const list = Array.isArray(addrs) ? addrs : [addrs];
          const bad = list.find((a) => ipIsBlocked(a.address));
          if (bad) return cb(new Error('目标地址解析到内网/环回/元数据地址，已拒绝'));
          const first = list[0];
          if (options && options.all) return cb(null, list);
          cb(null, first.address, first.family);
        });
      },
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (depth >= 2) return done({ status: 'rejected', reason: '图片地址跳转次数过多' });
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch (_) { return done({ status: 'rejected', reason: '跳转地址非法' }); }
        return probeOnce(next, o, timeoutMs, maxBytes, depth + 1).then(done);
      }
      if (code !== 200 && code !== 206) {
        res.resume();
        return done({ status: 'unreachable', reason: '图片地址返回 HTTP ' + code });
      }
      const declaredLen = parseInt(res.headers['content-length'] || '', 10);
      if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
        res.destroy();
        return done(judgeProbe({ bytes: declaredLen }));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(); return done(judgeProbe({ bytes: size })); }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        probeDimensions(buf).then((size) => done(judgeProbe({
          bytes: buf.length,
          width: size && size.width,
          height: size && size.height,
          parseFailed: !size,
        })));
      });
      res.on('error', () => done({ status: 'unreachable', reason: '图片下载中断' }));
    });
    req.on('timeout', () => { req.destroy(); done({ status: 'unreachable', reason: `图片地址超时（>${timeoutMs}ms）` }); });
    req.on('error', (e) => done({ status: 'unreachable', reason: '图片地址不可达：' + String(e.message || e).slice(0, 80) }));
    req.end();
  });
}

/** 清空探测缓存（回归脚本用，避免跨用例串味） */
function clearProbeCache() { probeCache.clear(); }

/**
 * 上架抽检：对给定图片地址逐个探测（最多 PHOTO_SPOT_CHECK 张，默认取前几张）。
 * 返回 { error, warnings }：**确定性不合格**（超 10MB / 小于 800×600 / 非图 / 地址非法）→ error 阻断上架；
 * **仅网络不可达**（超时/DNS/非 200）→ 记 warning 放行——商家 CDN 抖动不该卡住上架，问题留在警告里可复查。
 * 平台自有相对路径图（assets/…）由平台自己管，跳过。
 */
async function spotCheck(urls, opts) {
  const o = opts || {};
  const list = (urls || []).filter(Boolean).slice(0, o.count || PHOTO_SPOT_CHECK);
  const warnings = [];
  for (const url of list) {
    if (!/^https?:\/\//i.test(String(url))) continue;
    const r = await probeImage(url, o);
    if (r.status === 'rejected') {
      return { error: `图片校验不通过（${url}）：${r.reason}`, warnings };
    }
    if (r.status === 'unreachable') warnings.push(`抽检未取到图 ${url}：${r.reason}`);
  }
  return { error: null, warnings };
}

module.exports = {
  PHOTO_CATEGORIES,
  PHOTO_CATEGORY_KEYS,
  PHOTO_CATEGORY_DEFAULT,
  PHOTO_MIN_PUBLISH,
  PHOTO_MAX_PER_SYNC,
  PHOTO_MAX_BYTES,
  PHOTO_MIN_WIDTH,
  PHOTO_MIN_HEIGHT,
  PHOTO_SPOT_CHECK,
  CATEGORY_LABEL,
  photoOut,
  photosOut,
  normalizeCategoryInput,
  normalizePhotoUrl,
  validateDeclared,
  normalizeGalleryInput,
  assignSortOrders,
  pickCoverIndex,
  ipIsBlocked,
  judgeProbe,
  readImageSize,
  probeDimensions,
  probeImage,
  spotCheck,
  clearProbeCache,
};
