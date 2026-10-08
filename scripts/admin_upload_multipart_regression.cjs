#!/usr/bin/env node
'use strict';
/**
 * multipart 解析 + 上传入口契约回归（无需 DB / 不触网）
 *
 * 覆盖：
 *   1) app.js 的 parseMultipart / multipartFields / partDisposition / scopeEntity（离线单测）
 *   2) 上传入口契约的静态断言：
 *      - /admin/units/:id/photos 支持 multipart（原实现直接 503）
 *      - /admin/upload（及别名 /admin/photos/upload）支持 multipart + scope（原实现 415）
 *      - 二进制读取必须走 readRawBody（readBody 是 utf8 拼串，不能用于图片）
 *      - 商家 photos/add 走 img_storage 收口；img_storage 导出 ingestRef/deleteObjectByRef
 *
 * 用法：npm run test:admin-upload
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const vendorSrc = fs.readFileSync(path.join(ROOT, 'vendor_api.cjs'), 'utf8');
const imgSrc = fs.readFileSync(path.join(ROOT, 'img_storage.cjs'), 'utf8');
// 2026-09-30 拆分重构后管理域路由在 server/routes/admin.cjs（app.js 只留入口与辅助函数）
const adminSrc = fs.readFileSync(path.join(ROOT, 'server/routes/admin.cjs'), 'utf8');

const app = require(path.join(ROOT, 'app.js'));
const MP = app.__multipart;

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name); }
  catch (e) { fail++; console.error('[FAIL] ' + name + ' → ' + ((e && e.message) || e)); }
}

// ── multipart 构造器（与真实客户端同构） ────────────────────────
const B = '----lvjuTestBoundaryABC123';
const CT = 'multipart/form-data; boundary=' + B;

function part(head, body) {
  return Buffer.concat([
    Buffer.from('--' + B + '\r\n' + head + '\r\n\r\n', 'utf8'),
    Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'),
    Buffer.from('\r\n', 'utf8'),
  ]);
}
function close() { return Buffer.from('--' + B + '--\r\n', 'utf8'); }
function build(parts) { return Buffer.concat(parts.concat([close()])); }

const FILE_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),      // JPEG 头 + 0x00
  Buffer.from('JFIF--not-a-boundary--', 'utf8'),
  Buffer.from([0xff, 0xd9]),                               // EOF
]);

// ── 解析器 ──────────────────────────────────────────────────────
t('parseMultipart：单文件，二进制逐字节保真（含 0x00 / 0xFF）', () => {
  const buf = build([
    part('Content-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg', FILE_BYTES),
  ]);
  const r = MP.parseMultipart(buf, CT);
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.parts.length, 1);
  assert.ok(r.parts[0].body.equals(FILE_BYTES), '二进制必须逐字节一致（不能走 utf8 拼串）');
});

t('parseMultipart：字段 + 多文件混排', () => {
  const buf = build([
    part('Content-Disposition: form-data; name="scope"', 'unit_gallery'),
    part('Content-Disposition: form-data; name="unit_id"', '3101'),
    part('Content-Disposition: form-data; name="file"; filename="1.jpg"\r\nContent-Type: image/jpeg', FILE_BYTES),
    part('Content-Disposition: form-data; name="file"; filename="2.png"\r\nContent-Type: image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  ]);
  const r = MP.parseMultipart(buf, CT);
  assert.ok(!r.error, r.error);
  const { fields, files } = MP.multipartFields(r.parts);
  assert.strictEqual(fields.scope, 'unit_gallery');
  assert.strictEqual(fields.unit_id, '3101');
  assert.strictEqual(files.length, 2);
  assert.deepStrictEqual(files.map((f) => f.filename), ['1.jpg', '2.png']);
  assert.strictEqual(files[1].contentType, 'image/png');
});

t('parseMultipart：正文里出现裸 --boundary 不得被误切（必须匹配 \\r\\n--boundary）', () => {
  // 关键回归：图片字节里偶然出现 `--<boundary>`（前面没有 CRLF）时，绝不能当成分段边界
  const tricky = Buffer.from('AAA--' + B + 'BBB', 'utf8');
  const buf = build([
    part('Content-Disposition: form-data; name="file"; filename="tricky.jpg"\r\nContent-Type: image/jpeg', tricky),
  ]);
  const r = MP.parseMultipart(buf, CT);
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.parts.length, 1, '不应被切成多段');
  assert.ok(r.parts[0].body.equals(tricky), '正文必须完整保留');
});

t('parseMultipart：CRLF 变体与无 filename 的普通字段', () => {
  const buf = build([
    part('Content-Disposition: form-data; name="is_cover"', '1'),
    part('Content-Disposition: form-data; name="file"; filename="x.webp"\r\nContent-Type: image/webp', Buffer.from('RIFF')),
  ]);
  const r = MP.parseMultipart(buf, CT);
  const { fields, files } = MP.multipartFields(r.parts);
  assert.strictEqual(fields.is_cover, '1');
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].field, 'file');
});

t('parseMultipart：缺 boundary / 缺结束边界 → error（不静默产出半截图片）', () => {
  assert.ok(MP.parseMultipart(Buffer.from('x'), 'multipart/form-data').error);
  const truncated = build([part('Content-Disposition: form-data; name="file"; filename="a.jpg"', 'A')]).slice(0, -6);
  assert.ok(MP.parseMultipart(truncated, CT).error);
  assert.ok(MP.parseMultipart(Buffer.from('no boundary here'), CT).error);
});

t('parseMultipart：分段数超限 → error（防 DoS）', () => {
  const parts = [];
  for (let i = 0; i < 40; i++) parts.push(part('Content-Disposition: form-data; name="f' + i + '"', 'v'));
  const r = MP.parseMultipart(build(parts), CT);
  assert.ok(r.error, '应因分段数超限报错');
});

t('partDisposition：name/filename 解析（带引号 / 不带引号）', () => {
  const a = MP.partDisposition('form-data; name="file"; filename="a.jpg"');
  assert.deepStrictEqual([a.name, a.filename, a.hasFilename], ['file', 'a.jpg', true]);
  const b = MP.partDisposition('form-data; name=scope');
  assert.deepStrictEqual([b.name, b.filename], ['scope', '']);
});

// ── scope → 归属实体（对齐 juzhu/server.py:2424-2497） ──────────
t('scopeEntity：7 种 scope 与未知 scope', () => {
  assert.deepStrictEqual(MP.scopeEntity('project_cover', { project_id: '1611' }),
    { entityType: 'project', entityId: 1611, needDb: true });
  assert.deepStrictEqual(MP.scopeEntity('project_cover_new', { channel: 'bzf' }),
    { entityType: 'project_draft', entityId: 0, needDb: false });
  assert.deepStrictEqual(MP.scopeEntity('unit_cover', { unit_id: '3101' }),
    { entityType: 'unit', entityId: 3101, needDb: true });
  assert.deepStrictEqual(MP.scopeEntity('unit_gallery', { unit_id: '3101' }),
    { entityType: 'unit', entityId: 3101, needDb: true });
  assert.deepStrictEqual(MP.scopeEntity('unit_keeper', { unit_id: '3101' }),
    { entityType: 'unit', entityId: 3101, needDb: true });
  const photo = MP.scopeEntity('unit_photo', { photo_id: '77' });
  assert.deepStrictEqual([photo.entityType, photo.needDb, photo.photoId], ['unit', true, 77]);
  assert.deepStrictEqual(MP.scopeEntity('city_hero', {}), { entityType: 'city', entityId: 0, needDb: false });
  assert.strictEqual(MP.scopeEntity('nope', {}), null);
  assert.strictEqual(MP.scopeEntity('', {}), null);
});

// ── 入口契约（静态断言） ────────────────────────────────────────
t('新增房源图片接口：multipart 直传分支已落地（原实现 multipart 直接 503）', () => {
  const idx = adminSrc.indexOf("urlPath.match(/^\\/api\\/juzhu\\/admin\\/units\\/(\\d+)\\/photos$/)");
  assert.ok(idx > 0, '未找到 /admin/units/:id/photos 路由');
  const seg = adminSrc.slice(idx, idx + 4000);
  assert.ok(seg.includes('multipart/form-data'), '应按 content-type 分流 multipart');
  assert.ok(seg.includes('readImageMultipart'), '应走 multipart 解析器');
  assert.ok(seg.includes('imgStorage.uploadImage'), '应上传对象存储');
  assert.ok(seg.includes('insertPhotoRow'), '应落 photos 表');
  assert.ok(!/multipart\/form-data'\)\)\s*\{[\s\S]{0,200}503/.test(seg), '不应再对 multipart 返回 503');
});

t('/admin/upload 与别名 /admin/photos/upload：multipart + scope 通道已落地（原实现 415）', () => {
  const idx = adminSrc.indexOf("urlPath === '/api/juzhu/admin/photos/upload' || urlPath === '/api/juzhu/admin/upload'");
  assert.ok(idx > 0, '未找到 /admin/upload 路由');
  const seg = adminSrc.slice(idx, idx + 6000);
  assert.ok(seg.includes('readImageMultipart'), '应支持 multipart');
  assert.ok(seg.includes('scopeEntity'), '应识别 scope');
  assert.ok(seg.includes('file_path: up.url'), '响应必须保留 file_path（前端历史契约）');
  assert.ok(seg.includes('reuseKey'), 'unit_photo 换图应复用既有 key（零孤儿对象）');
  assert.ok(!/multipart 不支持/.test(seg), '不应再返回 415「multipart 不支持」');
});

t('二进制安全：上传必须用 readRawBody，且 readBody 不得被用于 multipart', () => {
  assert.ok(appSrc.includes('function readRawBody(req, maxBytes)'), '缺少二进制安全的 readRawBody');
  assert.ok(/MULTIPART_MAX_BYTES\s*=/.test(appSrc), '缺少请求体上限');
  const idx = appSrc.indexOf('function readImageMultipart');
  const seg = appSrc.slice(idx, idx + 900);
  assert.ok(seg.includes('readRawBody'), 'readImageMultipart 必须用 readRawBody');
  assert.ok(!/readBody\(req\)[\s\S]{0,80}multipart/.test(appSrc), '不得用 utf8 拼串的 readBody 读 multipart');
});

t('写侧收口：落库失败补偿删除 + 事务与行锁', () => {
  assert.ok(appSrc.includes('async function compensateUpload(upload)'), '缺少补偿删除');
  assert.ok(appSrc.includes('async function normImgRef(ref, opts)'), '缺少收口函数');
  assert.ok(appSrc.includes('SELECT id FROM ${tableOf[entityType]} WHERE id=? FOR UPDATE'), 'insertPhotoRow 应有行锁');
  assert.ok(appSrc.includes('await conn.beginTransaction()'), 'insertPhotoRow 应有事务');
});

t('商家通道：photos/add 与 projects/create 已走 img_storage 收口', () => {
  const idx = vendorSrc.indexOf('async function housingPhotosAdd');
  const seg = vendorSrc.slice(idx, idx + 2600);
  assert.ok(seg.includes('normImgRef'), 'photos/add 应收口 file_path');
  assert.ok(seg.includes('beginTransaction'), 'photos/add 应有事务');
  assert.ok(vendorSrc.includes('normCoverRef(b.cover_image'), 'projects/units 的 cover_image 应收口');
  assert.ok(vendorSrc.includes('imgStorage.isValidImageRef'), '上架闸封面判定应收口');
});

t('img_storage：新增收口 API 均已导出', () => {
  ['urlMode', 'writeMode', 'ingestMode', 'legacyKeyOf', 'legacyUrlOf', 'normalizeImageRef',
    'resolveForRead', 'isValidImageRef', 'sourceUrlAllowed', 'isBlockedHost', 'ingestRef', 'deleteObjectByRef',
  ].forEach((fn) => {
    assert.ok(new RegExp('(^|\\s)' + fn + ',', 'm').test(imgSrc) || imgSrc.includes(fn + ',') || imgSrc.includes(fn + ':'),
      '未导出 ' + fn);
  });
});

t('前端：absolute-URL 兼容（imgUrl）已落地，避免 /https:// 坏图', () => {
  [['juzhu-admin.html', 1], ['juzhu-admin-unit.html', 1]].forEach(([f]) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(src.includes('function imgUrl('), f + ' 缺少 imgUrl()');
    assert.ok(!/url\('\/'\+/.test(src), f + ' 仍有 url(\'/\'+p) 旧写法（遇绝对 URL 必坏图）');
  });
  const rating = fs.readFileSync(path.join(ROOT, 'screens/p-rating-detail.html'), 'utf8');
  assert.ok(rating.includes('function imgUrl('), 'p-rating-detail.html 缺少 imgUrl()');
  assert.ok(!/src="\/'\+/.test(rating), 'p-rating-detail.html 仍有 src=\'/\'+p 旧写法');
});

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
