#!/usr/bin/env node
'use strict';
/**
 * 图片引用收口回归（纯函数，无需 DB / 不触网 / 不读写 S3）
 *
 * 覆盖：img_storage.cjs 的 urlMode/writeMode/ingestMode/legacyKeyOf/legacyUrlOf/
 *       normalizeImageRef/resolveForRead/isValidImageRef/isBlockedHost/sourceUrlAllowed/ingestRef
 *
 * 用法：npm run test:img-ingest
 * 说明：脚本自行设定一组固定的 S3 环境变量（假凭证），只用于断言 URL 形态与开关行为，
 *       不发起任何网络请求（镜像路径全部用 SSRF/白名单负例提前拦住）。
 */
const path = require('path');
const assert = require('assert');

// ── 固定测试环境（勿依赖外部 .env） ──────────────────────────────
process.env.S3_ACCESS_KEY = 'test-ak';
process.env.S3_SECRET_KEY = 'test-sk';
process.env.S3_ENDPOINT = 'https://ods.lianjia.com';
process.env.S3_FILE_ENDPOINT = 'https://file.ljcdn.com';
process.env.S3_BUCKET = 'test';
process.env.S3_KEY_PREFIX = 'lvju';
process.env.S3_FILE_STYLE = 'bucket';
process.env.S3_ADDRESSING = 'path';
process.env.S3_SIGN_VERSION = 'v4';
process.env.IMG_URL_MODE = 'dual';
process.env.IMG_INGEST = 'keep';
process.env.IMG_NORMALIZE = '1';
process.env.S3_FAIL_ON_UNCONFIGURED = '0';
delete process.env.S3_MIGRATE_PREFIX;
delete process.env.S3_SOURCE_URL_ALLOWLIST;

const img = require(path.join(__dirname, '..', 'img_storage.cjs'));
const thumbs = require(path.join(__dirname, '..', 'img_thumbs.cjs'));

const FILE_URL = 'https://file.ljcdn.com/test/lvju/housing/project/1611/2026/09/abc.jpg';
const LEGACY_URL = 'https://file.ljcdn.com/test/lvju/legacy/juzhu/sy/x.jpg';

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name); }
  catch (e) { fail++; console.error('[FAIL] ' + name + ' → ' + ((e && e.message) || e)); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('[PASS] ' + name); }
  catch (e) { fail++; console.error('[FAIL] ' + name + ' → ' + ((e && e.message) || e)); }
}

// ── 开关 ────────────────────────────────────────────────────────
t('urlMode 缺省 dual / 非法值回落 dual', () => {
  delete process.env.IMG_URL_MODE;
  assert.strictEqual(img.urlMode(), 'dual');
  process.env.IMG_URL_MODE = 'bogus';
  assert.strictEqual(img.urlMode(), 'dual');
  process.env.IMG_URL_MODE = 's3';
  assert.strictEqual(img.urlMode(), 's3');
  process.env.IMG_URL_MODE = 'dual';
});

t('writeMode：S3 已配置 → s3；IMG_URL_MODE=local 强制 local（最强回滚）', () => {
  assert.strictEqual(img.writeMode(), 's3');
  process.env.IMG_URL_MODE = 'local';
  assert.strictEqual(img.writeMode(), 'local');
  process.env.IMG_URL_MODE = 'dual';
});

t('ingestMode 缺省 keep，仅 mirror 生效', () => {
  delete process.env.IMG_INGEST;
  assert.strictEqual(img.ingestMode(), 'keep');
  process.env.IMG_INGEST = 'MIRROR';
  assert.strictEqual(img.ingestMode(), 'mirror');
  process.env.IMG_INGEST = 'keep';
});

// ── 迁移 key（必须确定性，否则切读 404） ─────────────────────────
t('legacyKeyOf：去前导斜杠 + 去 assets/ 前缀 + 挂迁移前缀', () => {
  assert.strictEqual(img.legacyKeyOf('assets/juzhu/sy/x.jpg'), 'lvju/legacy/juzhu/sy/x.jpg');
  assert.strictEqual(img.legacyKeyOf('/assets/juzhu/sy/x.jpg'), 'lvju/legacy/juzhu/sy/x.jpg');
  assert.strictEqual(img.legacyKeyOf('assets/lvju/a.png'), 'lvju/legacy/lvju/a.png');
  assert.strictEqual(img.legacyKeyOf(FILE_URL), '', '非本地引用不产生迁移 key');
});

t('legacyKeyOf 确定性（同一输入两次调用完全一致）', () => {
  const a = img.legacyKeyOf('assets/juzhu/sy/中文 名.jpg');
  const b = img.legacyKeyOf('assets/juzhu/sy/中文 名.jpg');
  assert.strictEqual(a, b);
  assert.ok(a.endsWith('中文 名.jpg'), '中文/空格文件名原样保留（编码交给 encodeKey）');
});

t('migratePrefix 可覆盖（S3_MIGRATE_PREFIX）', () => {
  process.env.S3_MIGRATE_PREFIX = 'custom/legacy/';
  assert.strictEqual(img.migratePrefix(), 'custom/legacy');
  assert.strictEqual(img.legacyKeyOf('assets/a/b.jpg'), 'custom/legacy/a/b.jpg');
  delete process.env.S3_MIGRATE_PREFIX;
  assert.strictEqual(img.migratePrefix(), 'lvju/legacy');
});

t('legacyUrlOf 与 publicUrl 逐字一致（切读依赖）', () => {
  assert.strictEqual(img.legacyUrlOf('assets/juzhu/sy/x.jpg'), LEGACY_URL);
});

// ── 形态归一化 ──────────────────────────────────────────────────
t('normalizeImageRef：本地路径补前导斜杠（存量只加 /，不改其它）', () => {
  assert.deepStrictEqual(img.normalizeImageRef('/assets/juzhu/sy/x.jpg'),
    { ok: true, ref: '/assets/juzhu/sy/x.jpg', kind: 'local', changed: false, warn: '' });
  const r = img.normalizeImageRef('assets/juzhu/sy/x.jpg');
  assert.strictEqual(r.ref, '/assets/juzhu/sy/x.jpg');
  assert.strictEqual(r.kind, 'local');
  assert.strictEqual(r.changed, true);
});

t('normalizeImageRef：本域对象存储 URL ↔ s3:// ↔ 裸 key 收敛为同一公网 URL', () => {
  assert.strictEqual(img.normalizeImageRef(FILE_URL).ref, FILE_URL);
  assert.strictEqual(img.normalizeImageRef(FILE_URL).kind, 's3');
  assert.strictEqual(img.normalizeImageRef(FILE_URL).changed, false);
  assert.strictEqual(img.normalizeImageRef('s3://lvju/housing/project/1611/2026/09/abc.jpg').ref, FILE_URL);
  assert.strictEqual(img.normalizeImageRef('lvju/housing/project/1611/2026/09/abc.jpg').ref, FILE_URL);
});

t('normalizeImageRef：第三方 URL 原样保留（kind=external，缺省不改写）', () => {
  const r = img.normalizeImageRef('https://vendor-cdn.example.com/a.jpg');
  assert.strictEqual(r.ref, 'https://vendor-cdn.example.com/a.jpg');
  assert.strictEqual(r.kind, 'external');
  assert.strictEqual(r.changed, false);
});

t('normalizeImageRef：data:/blob: 视为内联，原样', () => {
  assert.strictEqual(img.normalizeImageRef('data:image/png;base64,AAAA').kind, 'inline');
  assert.strictEqual(img.normalizeImageRef('blob:http://x/y').kind, 'inline');
});

t('normalizeImageRef：脏值/未知引用 → ok:false（不再静默入库）', () => {
  ['', '   ', 'todo', '-', '—', 'javascript:alert(1)'].forEach((v) => {
    assert.strictEqual(img.normalizeImageRef(v).ok, false, `应拒绝: ${JSON.stringify(v)}`);
  });
});

t('路径穿越防护：assets/../ 与反斜杠一律不算本地路径', () => {
  ['assets/../etc/passwd', '/assets/../../etc/passwd', 'assets/..\\..\\x.jpg', 'assets/a/../../x.jpg'].forEach((v) => {
    assert.strictEqual(img.isLocalPath(v), false, `应拒绝: ${v}`);
    assert.strictEqual(img.normalizeImageRef(v).ok, false, `应拒绝: ${v}`);
  });
  assert.strictEqual(img.isLocalPath('assets/juzhu/sy/x.jpg'), true);
});



// ── 读侧改写 ────────────────────────────────────────────────────
t('resolveForRead：dual/local 不改写，s3 改写为迁移前缀 URL', () => {
  assert.strictEqual(img.resolveForRead('/assets/juzhu/sy/x.jpg'), '/assets/juzhu/sy/x.jpg');
  process.env.IMG_URL_MODE = 'local';
  assert.strictEqual(img.resolveForRead('/assets/juzhu/sy/x.jpg'), '/assets/juzhu/sy/x.jpg');
  process.env.IMG_URL_MODE = 's3';
  assert.strictEqual(img.resolveForRead('/assets/juzhu/sy/x.jpg'), LEGACY_URL);
  assert.strictEqual(img.resolveForRead(FILE_URL), FILE_URL, '已是对象存储引用不再改写');
  process.env.IMG_URL_MODE = 'dual';
});

t('切读接线：IMG_URL_MODE=s3 时 C 端出口把本地引用改写为迁移前缀 URL', () => {
  process.env.S3_THUMB_REWRITE = '0';       // 关掉缩略图改写，隔离断言（免 HEAD 网络请求）
  assert.strictEqual(thumbs.thumbOf('/assets/juzhu/sy/x.jpg', 240), '/assets/juzhu/sy/x.jpg',
    'dual 下本地引用保持原样');
  process.env.IMG_URL_MODE = 's3';
  assert.strictEqual(thumbs.thumbOf('/assets/juzhu/sy/x.jpg', 240), LEGACY_URL);
  assert.strictEqual(thumbs.mapThumbsDeep({ cover_image: 'assets/juzhu/sy/x.jpg' }, 640).cover_image, LEGACY_URL,
    '无前导斜杠的存量写法也要能被改写');
  assert.strictEqual(thumbs.thumbOf(FILE_URL, 240), FILE_URL, '已是对象存储引用不改写');
  process.env.IMG_URL_MODE = 'dual';
  delete process.env.S3_THUMB_REWRITE;
});

// ── 有效性（上架封面判定） ──────────────────────────────────────
t('isValidImageRef：脏值不算图，真图才算', () => {
  ['', '-', 'todo', 'assets/x.txt', 'n/a'].forEach((v) => assert.strictEqual(img.isValidImageRef(v), false, `应无效: ${v}`));
  ['/assets/x.jpg', 'assets/x.JPEG', FILE_URL, 'lvju/a.png', 'data:image/png;base64,AA'].forEach((v) =>
    assert.strictEqual(img.isValidImageRef(v), true, `应有效: ${v}`));
});

// ── SSRF / 白名单 ───────────────────────────────────────────────
t('isBlockedHost：内网/回环/元数据地址拦截，公网放行', () => {
  ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.1', '169.254.169.254',
    'localhost', 'a.internal', '[::1]'].forEach((h) => assert.strictEqual(img.isBlockedHost(h), true, `应拦截: ${h}`));
  ['172.32.0.1', '8.8.8.8', 'file.ljcdn.com', 'cdn.example.com'].forEach((h) =>
    assert.strictEqual(img.isBlockedHost(h), false, `应放行: ${h}`));
});

t('sourceUrlAllowed：未配白名单不限制；配了按域（含子域）匹配', () => {
  assert.strictEqual(img.sourceUrlAllowed('https://any.example.com/a.jpg'), true);
  process.env.S3_SOURCE_URL_ALLOWLIST = 'example.com, cdn.lianjia.com';
  assert.strictEqual(img.sourceUrlAllowed('https://example.com/a.jpg'), true);
  assert.strictEqual(img.sourceUrlAllowed('https://img.example.com/a.jpg'), true, '子域应放行');
  assert.strictEqual(img.sourceUrlAllowed('https://imagesexample.com/a.jpg'), false, '后缀伪装不应放行');
  assert.strictEqual(img.sourceUrlAllowed('https://evil.com/a.jpg'), false);
  delete process.env.S3_SOURCE_URL_ALLOWLIST;
});

// ── ingestRef（写入收口） ───────────────────────────────────────
(async () => {
  await ta('ingestRef：本地/对象存储引用只做归一化，不触网', async () => {
    const a = await img.ingestRef('assets/juzhu/sy/x.jpg');
    assert.strictEqual(a.ok, true);
    assert.strictEqual(a.ref, '/assets/juzhu/sy/x.jpg');
    assert.strictEqual(a.mirrored, false);
    const b = await img.ingestRef('lvju/housing/project/1611/2026/09/abc.jpg');
    assert.strictEqual(b.ref, FILE_URL);
  });

  await ta('ingestRef：非法引用直接 ok:false（不落库）', async () => {
    const r = await img.ingestRef('todo');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error, '应带回错误原因');
  });

  await ta('ingestRef：IMG_INGEST=keep 时第三方 URL 原样保留', async () => {
    const r = await img.ingestRef('https://vendor-cdn.example.com/a.jpg', { mirror: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.kind, 'external');
    assert.strictEqual(r.mirrored, false);
    assert.strictEqual(r.ref, 'https://vendor-cdn.example.com/a.jpg');
  });

  await ta('ingestRef：IMG_INGEST=mirror 时内网地址被 SSRF 拦截（不发请求）', async () => {
    process.env.IMG_INGEST = 'mirror';
    const r = await img.ingestRef('http://169.254.169.254/latest/meta-data/a.jpg', { mirror: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /SSRF|内网/);
    const r2 = await img.ingestRef('http://10.0.0.1/a.jpg', { mirror: true });
    assert.strictEqual(r2.ok, false);
    process.env.IMG_INGEST = 'keep';
  });

  await ta('ingestRef：IMG_INGEST=mirror 且配白名单时，域外地址被拒（不发请求）', async () => {
    process.env.IMG_INGEST = 'mirror';
    process.env.S3_SOURCE_URL_ALLOWLIST = 'allowed.example';
    const r = await img.ingestRef('https://evil.example/a.jpg', { mirror: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /白名单/);
    process.env.IMG_INGEST = 'keep';
    delete process.env.S3_SOURCE_URL_ALLOWLIST;
  });

  await ta('readImage：本地路径解析后必须仍在仓库内（穿越直接拒绝）', async () => {
    const bad = await img.readImage('/assets/../../etc/passwd');
    assert.strictEqual(bad.ok, false);
  });

  await ta('deleteObjectByRef：拒绝对外部 URL 反解 key（防误删同名对象），本地引用直接跳过', async () => {
    const ext = await img.deleteObjectByRef('https://other-cdn.example.com/a.jpg');
    assert.strictEqual(ext.ok, false);
    assert.strictEqual(ext.skipped, true);
    assert.match(ext.error, /外部/);
    const loc = await img.deleteObjectByRef('/assets/juzhu/sy/x.jpg');
    assert.strictEqual(loc.ok, false);
    assert.strictEqual(loc.skipped, true);
    const empty = await img.deleteObjectByRef('');
    assert.strictEqual(empty.ok, false);
  });

  await ta('ingestRef：opts.mirror 未显式开启时，即便 IMG_INGEST=mirror 也不镜像', async () => {
    process.env.IMG_INGEST = 'mirror';
    const r = await img.ingestRef('https://vendor-cdn.example.com/a.jpg');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mirrored, false);
    process.env.IMG_INGEST = 'keep';
  });

  // ── 回滚开关与 fail-closed（直接打 uploadImage，不连库不触网除本地写盘）──
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64');
  const fsMod = require('fs');
  const pathMod = require('path');

  await ta('IMG_URL_MODE=local：S3 配齐也强制落本地（最强回滚开关）', async () => {
    process.env.IMG_URL_MODE = 'local';
    const up = await img.uploadImage({ buffer: PNG_1PX, filename: 'rollback.png', contentType: 'image/png', entityType: 'unit', entityId: 1, makeThumbs: false });
    assert.strictEqual(up.ok, true, up.error);
    assert.strictEqual(up.storage, 'local');
    assert.ok(up.url.startsWith('/assets/uploads/'), up.url);
    try { fsMod.unlinkSync(pathMod.join(__dirname, '..', up.url.replace(/^\//, ''))); } catch (_) {}
    process.env.IMG_URL_MODE = 'dual';
  });

  await ta('S3_FAIL_ON_UNCONFIGURED=1 且 S3 未配置 → fail-closed（不静默写本地）', async () => {
    const savedKey = process.env.S3_ACCESS_KEY;
    const savedFlag = process.env.S3_FAIL_ON_UNCONFIGURED;
    process.env.S3_FAIL_ON_UNCONFIGURED = '1';
    delete process.env.S3_ACCESS_KEY;
    const up = await img.uploadImage({ buffer: PNG_1PX, filename: 'x.jpg', contentType: 'image/jpeg', makeThumbs: false });
    assert.strictEqual(up.ok, false);
    assert.match(up.error, /S3 未配置/);
    process.env.S3_ACCESS_KEY = savedKey;
    process.env.S3_FAIL_ON_UNCONFIGURED = savedFlag || '0';
  });

  // 签名 URL / 非标准 MIME 兜底（2026-10-12 商家 AWS 预签名 URL 场景）
  await ta('格式推导：AWS 预签名 URL（application/jpg + 签名 query）→ 正确推导 jpg', () => {
    assert.strictEqual(img.normalizeMime('application/jpg'), 'image/jpeg');
    assert.strictEqual(img.normalizeMime('application/jpg; charset=utf-8'), 'image/jpeg');
    assert.strictEqual(img.extFromUrl('https://x.s3.cn-northwest-1.amazonaws.com.cn/a/b/6acc8c44.jpg?X-Amz-Date=1&X-Amz-Signature=ab'), 'jpg');
    assert.strictEqual(img.extFromUrl('https://x/a.png?response-content-type=application%2Fpng'), 'png');
    assert.strictEqual(img.extFromUrl('https://x/a/noext?X-Amz-Signature=ab'), '');
  });
  await ta('格式推导：魔数嗅探（不依赖 URL/响应头）', () => {
    assert.strictEqual(img.sniffImageExt(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg');
    assert.strictEqual(img.sniffImageExt(PNG_1PX), 'png');
    assert.strictEqual(img.sniffImageExt(Buffer.from('RIFF____WEBPVP8 ', 'binary')), 'webp');
    assert.strictEqual(img.sniffImageExt(Buffer.from('not-an-image-content')), '');
    assert.strictEqual(img.sniffImageExt(Buffer.from([0xFF, 0xD8])), '');
  });

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
