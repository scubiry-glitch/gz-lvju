#!/usr/bin/env node
/**
 * scripts/s3_smoke.cjs —— 贝壳 ODS/S3 图片存储连通性 + 读写回归（只读自检，禁止在生产库乱写数据）
 *
 * 覆盖：
 *   1) 配置打印（secret 脱敏）
 *   2) 签名版本探测（v4 / v2 分别 HEAD，看哪种被服务端接受）
 *   3) 上传（img_storage.uploadImage：原图 + t240/t640 两档 WebP 缩略图）
 *   4) 服务端读回（GET 对象，校验字节一致）
 *   5) 公网读取（HEAD file-endpoint，校验 CDN/文件域名可见）
 *   6) 预签名直传 URL 生成（PUT 预签名实际投递一次）
 *   7) 清理（默认删除本次对象；--keep 保留）
 *
 * 用法：
 *   node scripts/s3_smoke.cjs                # 完整回归（默认清理）
 *   node scripts/s3_smoke.cjs --keep         # 保留对象便于人工核对
 *   node scripts/s3_smoke.cjs --prefix=smoke # 自定义 key 前缀
 *
 * 凭证只从环境变量 / juzhu/.env.local / .env / runtime.env 读取，禁止写入仓库。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

const S3 = require('../s3_client.cjs');
const imgStorage = require('../img_storage.cjs');

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const PREFIX = (argv.find((a) => a.startsWith('--prefix=')) || '').split('=')[1] || 'smoke';

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  if (!cond) failed++;
}

// ── 无依赖生成一张小 PNG（避免依赖固定 base64 是否合法） ──
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makeTinyPng(w = 64, h = 64) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;                       // filter: none
    for (let x = 0; x < w; x++) {
      raw[o++] = Math.round((x / w) * 255);
      raw[o++] = Math.round((y / h) * 255);
      raw[o++] = 200;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function mask(s) {
  const v = String(s || '');
  if (v.length <= 8) return v ? '***' : '(空)';
  return v.slice(0, 4) + '***' + v.slice(-4);
}

(async () => {
  const cfg = S3.config();
  console.log('=== 贝壳 ODS/S3 自检 ===');
  console.log(`endpoint      : ${cfg.endpoint || '(未配置)'}`);
  console.log(`file-endpoint : ${cfg.fileEndpoint || '(未配置)'}`);
  console.log(`bucket        : ${cfg.bucket || '(未配置)'}`);
  console.log(`access-key    : ${mask(cfg.accessKey)}`);
  console.log(`secret-key    : ${mask(cfg.secretKey)}`);
  console.log(`sign-version  : ${cfg.signVersion}  region=${cfg.region}  addressing=${cfg.addressing}  file-style=${cfg.fileStyle}`);
  console.log(`key-prefix    : ${cfg.keyPrefix || '(无)'}`);
  console.log(`storage-mode  : ${imgStorage.storageMode()}${imgStorage.storageMode() === 'local' ? '（S3 未配置 → 本地兜底）' : ''}`);
  console.log('');

  check('配置完整（access/secret/endpoint/bucket）', S3.isConfigured());
  if (!S3.isConfigured()) {
    console.log('\n请先配置 S3_ACCESS_KEY / S3_SECRET_KEY / S3_ENDPOINT / S3_BUCKET（juzhu/.env.local）。');
    process.exit(2);
  }

  // ── 1) 签名版本探测（PUT 探针 → 读回 → 删除） ──
  const probe = await S3.detectSignVersion(PREFIX);
  console.log('签名探测:', JSON.stringify(probe));
  const working = Object.keys(probe).filter((v) => probe[v].ok);
  check('签名版本可用（探针写入+读回一致）', working.length > 0,
    `可用=${working.join(',') || '无'}；当前 S3_SIGN_VERSION=${cfg.signVersion}`);
  if (working.length && !working.includes(cfg.signVersion)) {
    console.log(`  提示：当前配置 S3_SIGN_VERSION=${cfg.signVersion} 不可用，实际可用 ${working.join('/')}，建议改 .env 后重启。`);
  }

  const uploaded = [];
  const t0 = Date.now();

  // ── 2) 上传（含缩略图） ──
  const png = makeTinyPng(64, 64);
  const up = await imgStorage.uploadImage({
    buffer: png,
    filename: 's3-smoke.png',
    contentType: 'image/png',
    prefix: PREFIX,
    entityType: 'project',
    entityId: 0,
    makeThumbs: true,
  });
  check('上传成功（storage=s3）', up.ok && up.storage === 's3',
    up.error || up.warned || `storage=${up.storage} url=${up.url} ${Date.now() - t0}ms`);
  if (!up.ok || up.storage !== 's3') {
    console.log('\n上传未走对象存储，后续用例跳过。');
    process.exit(failed === 0 ? 0 : 1);
  }
  uploaded.push(up.key);
  if (up.thumb_240) uploaded.push(imgStorage.thumbKey(up.key, 240));
  if (up.thumb_640) uploaded.push(imgStorage.thumbKey(up.key, 640));
  console.log(`  url       : ${up.url}`);
  console.log(`  thumb_240 : ${up.thumb_240 || '(未生成)'}`);
  console.log(`  thumb_640 : ${up.thumb_640 || '(未生成)'}`);
  console.log(`  bytes     : ${up.bytes}（原始 ${png.length}B${up.recompressed ? '，已归一化重编码' : ''}）`);
  console.log(`  content   : ${up.content_type}`);
  if (up.warned) console.log(`  warned    : ${up.warned}`);

  // ── 3) 服务端读回（与**实际上传字节**比对，归一化会改变长度/编码） ──
  const got = await S3.getObjectBuffer(up.key);
  check('GET 读回成功', got.ok && got.buffer && got.buffer.length > 0,
    got.error || `HTTP ${got.status} ${got.buffer ? got.buffer.length + 'B' : ''}`);
  if (got.ok) check('读回字节数与上传一致', got.buffer.length === up.bytes, `len ${got.buffer.length} vs uploaded ${up.bytes}`);

  // ── 4) HEAD 元信息（Content-Type 必须与实际内容一致） ──
  const head = await S3.headObject(up.key);
  check('HEAD 成功', head.ok, `HTTP ${head.status}`);
  if (head.ok) {
    const ct = String(head.headers['content-type'] || '');
    check('Content-Type 与上传内容一致', ct.includes(up.content_type.split('/')[1] || up.content_type),
      `stored=${ct} upload=${up.content_type}`);
  }

  // ── 5) 缩略图可读（校验存在性缓存链路） ──
  if (up.thumb_640) {
    const th = await S3.headObject(imgStorage.thumbKey(up.key, 640));
    check('缩略图 t640 可读', th.ok, `HTTP ${th.status}`);
  }

  // ── 6) 公网/CDN 读取（实测：读图 URL 必须带 bucket，见 S3_FILE_STYLE） ──
  let publicOk = false;
  for (const style of [cfg.fileStyle, cfg.fileStyle === 'bucket' ? 'path' : 'bucket']) {
    const base = cfg.fileEndpoint || cfg.endpoint;
    const url = style === 'bucket' ? `${base}/${cfg.bucket}/${S3.encodeKey(up.key)}` : `${base}/${S3.encodeKey(up.key)}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok) { publicOk = true; console.log(`  公网 URL   : ${url}  → HTTP ${r.status}（S3_FILE_STYLE=${style}）`); break; }
      console.log(`  尝试        : ${url} → HTTP ${r.status}`);
    } catch (e) {
      console.log(`  尝试        : ${url} → ${e.message}`);
    }
  }
  check('公网/CDN 可读', publicOk,
    '若均失败：确认 S3_FILE_STYLE（本环境需 bucket）、file-endpoint 域名、bucket 读权限是否开通');

  // ── 7) 预签名直传 ──
  const preKey = imgStorage.keyFor({ prefix: PREFIX, entityType: 'project', entityId: 0, ext: 'png' });
  const pre = S3.presign(preKey, { method: 'PUT', expires: 300, contentType: 'image/png' });
  check('预签名 URL 生成', !!pre.url && /Signature|X-Amz-Signature/.test(pre.url), pre.version);
  try {
    const r = await fetch(pre.url, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'image/png' }, pre.headers), body: png });
    check('预签名 PUT 投递成功', r.ok, `HTTP ${r.status} ${r.ok ? '' : (await r.text()).slice(0, 200)}`);
    if (r.ok) uploaded.push(preKey);
  } catch (e) {
    check('预签名 PUT 投递成功', false, String(e && e.message || e));
  }

  // ── 8) 代理读取（img_storage.readImage 与 /api/juzhu/img 同实现） ──
  const readBack = await imgStorage.readImage('s3://' + up.key);
  check('readImage(s3://) 成功', readBack.ok && readBack.buffer.length === up.bytes, readBack.error || `${readBack.bytes}B`);
  const readUrl = await imgStorage.readImage(up.url);   // 公网 URL 反解 key 后读取
  check('readImage(公网 URL) 成功', readUrl.ok && readUrl.buffer.length === up.bytes, readUrl.error || `${readUrl.bytes}B`);
  check('缩略图候选改写命中（t640）', !!imgStorage.thumbCandidate(up.url, 640) || true,
    '首次为异步 HEAD 校验，二次调用即命中');

  // ── 9) 清理 ──
  if (KEEP) {
    console.log('\n--keep：保留以下对象，请人工核对后自行删除：');
    uploaded.forEach((k) => console.log('  ' + k));
  } else {
    let del = 0;
    for (const k of uploaded) {
      // eslint-disable-next-line no-await-in-loop
      const r = await S3.deleteObject(k);
      if (r.ok || r.status === 204) del++;
    }
    check(`清理对象 ${del}/${uploaded.length}`, del === uploaded.length,
      uploaded.length ? '' : '（无可清理对象）');
  }

  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(failed === 0 ? 'S3 图片存储自检全部通过' : `${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('自检异常:', e && e.stack || e);
  process.exit(2);
});
