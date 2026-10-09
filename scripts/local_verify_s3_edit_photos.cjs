#!/usr/bin/env node
/**
 * 本地一键验证（二）：房源更新 + 房源图片接口 → S3 收口与对象回收
 * ---------------------------------------------------------------------------
 * 用法（先启动服务）：
 *   node --env-file=.env.dev scripts/local_verify_s3_edit_photos.cjs
 *   node --env-file=.env.dev scripts/local_verify_s3_edit_photos.cjs --base=http://127.0.0.1:8766 --keep
 *
 * 覆盖场景：
 *   1) PUT /admin/projects/:id            换封面（外链→S3）+ 响应透出
 *   2) POST /admin/projects/:id/units     建单元（外链封面→S3）
 *   3) PUT /admin/units/:id               换封面（外链→S3）
 *   4) POST /admin/units/:id/photos       图片登记（file_path 外链通道 → S3）
 *   5) POST /admin/units/:id/photos       multipart 直传（本地图 → S3）
 *   6) PUT /admin/photos/:id              改图（外链→S3）+ 设封面 + 单元 cover 同步
 *   7) POST /admin/upload                 scope=unit_photo 换图（复用 key、零孤儿）
 *   8) DELETE /admin/photos/:id           删图（开关关闭时对象保留 objects_removed=0）
 * 全程真实 S3 上传；结束时删除测试数据并回收测试对象。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const hit = args.find((a) => a.startsWith('--' + k + '=')); return hit ? hit.slice(k.length + 3) : d; };
const BASE = argVal('base', 'http://127.0.0.1:8766').replace(/\/$/, '');
const KEEP = args.includes('--keep');
const LOGIN = 'local_s3';
const PASSWORD = argVal('password', 's3-local-' + crypto.randomBytes(4).toString('hex'));

const BAIDU = (w, h) => `https://gips2.baidu.com/it/u=195724436,3554684702&fm=3028&app=3028&f=JPEG&fmt=auto?w=${w}&h=${h}`;
const LOCAL_IMG = path.join(ROOT, 'assets/juzhu/sy/projects/bzf/沈河区/庆余家园.jpg');
const LOCAL_IMG2 = path.join(ROOT, 'assets/juzhu/sy/projects/bzf/沈河区/CCB建融家园青年大街店.jpg');

const results = [];
const t = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  ✔ ' : '  ✘ ') + name + (detail ? '  | ' + detail : '')); };
const isS3Url = (u) => /^https:\/\/file\.ljcdn\.com\/test\//.test(String(u || ''));
let TOKEN = '';
const api = (method, p, body) => fetch(BASE + p, {
  method,
  headers: Object.assign({ Authorization: 'Bearer ' + TOKEN }, body ? { 'Content-Type': 'application/json' } : {}),
  body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());

(async () => {
  try { await fetch(BASE + '/api/juzhu/img?p=/assets/x.jpg', { signal: AbortSignal.timeout(8000) }); }
  catch (_) { console.error('✘ 服务不可达 ' + BASE); process.exit(1); }
  console.log('▶ 目标服务:', BASE);

  // ── 账号与登录（复用 local_s3）──
  const { getDbConfig, queryRows, getPool, withDbRetry } = require(path.join(ROOT, 'server/db.cjs'));
  const authCenter = require(path.join(ROOT, 'auth_center.cjs'));
  authCenter.init({
    query: (sql, params) => queryRows(sql, params),
    exec: (sql, params) => withDbRetry(async () => { const [r] = await getPool().execute(sql, params || []); return r; }),
    jsonReply: () => {}, expectedApiKey: () => '', expectedAdminPassword: () => '', isProduction: () => false,
  });
  let acc = (await queryRows('SELECT id FROM accounts WHERE login_name=? LIMIT 1', [LOGIN]))[0];
  if (!acc) {
    const out = await authCenter.createAccount({ login_name: LOGIN, password: PASSWORD, display_name: '本地S3封面验证', roles: ['platform_admin'], principal_type: 'user' });
    if (out.error) { console.error('✘ 创建验证账号失败:', out.error); process.exit(1); }
  } else {
    const r = await authCenter.updateAccount(acc.id, { password: PASSWORD }, {});
    if (r && r.error) { console.error('✘ 重置验证账号密码失败:', r.error); process.exit(1); }
  }
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_name: LOGIN, password: PASSWORD }),
  }).then((r) => r.json());
  if (!login.token) { console.error('✘ 登录失败:', JSON.stringify(login)); process.exit(1); }
  TOKEN = login.token;
  console.log('✔ 登录成功（' + LOGIN + '）');

  const imgStorage = require(path.join(ROOT, 'img_storage.cjs'));
  const createdObjects = [];   // 收集所有测试产生的 S3 对象，结束时回收
  const note = (u) => { if (isS3Url(u)) createdObjects.push(u); };

  // ── 场景 1：创建房源（外链封面）──
  console.log('\n[1] 创建房源（外链封面 A）');
  const cityRow = (await queryRows('SELECT id FROM cities ORDER BY id LIMIT 1'))[0];
  let dRow = (await queryRows('SELECT id FROM districts WHERE city_id=? ORDER BY id LIMIT 1', [cityRow.id]))[0];
  if (!dRow) dRow = (await queryRows('SELECT id FROM districts ORDER BY id LIMIT 1'))[0];
  const pj = await api('POST', '/api/juzhu/admin/projects', {
    name: 'S3验证房源E-' + Date.now().toString().slice(-6), channel: 'rental',
    city_id: cityRow.id, district_id: dRow.id, cover_image: BAIDU(1280, 960),
  });
  if (!pj.ok) { console.error('✘ 建房失败:', JSON.stringify(pj).slice(0, 300)); process.exit(1); }
  const pid = pj.project.id;
  note(pj.project.cover_image);
  t('建房 cover_image 转 S3', isS3Url(pj.project.cover_image), pj.project.cover_image);

  // ── 场景 2：房源更新换封面 ──
  console.log('\n[2] PUT /admin/projects/:id 换封面（外链 B）');
  const oldCover = pj.project.cover_image;
  const pj2 = await api('PUT', '/api/juzhu/admin/projects/' + pid, { cover_image: BAIDU(800, 600) });
  note(pj2.project && pj2.project.cover_image);
  t('更新响应 cover_image_storage=s3', pj2.cover_image_storage === 's3', 'storage=' + pj2.cover_image_storage + ' warned=' + (pj2.cover_warned || '-'));
  t('更新响应 cover_mirrored=true', pj2.cover_mirrored === true);
  t('封面已换为新的 S3 对象', isS3Url(pj2.project.cover_image) && pj2.project.cover_image !== oldCover, pj2.project.cover_image);

  // ── 场景 3：建单元（外链封面）──
  console.log('\n[3] POST /admin/projects/:id/units 建单元（外链封面 C）');
  const un = await api('POST', '/api/juzhu/admin/projects/' + pid + '/units', { name: 'S3验证户型', cover_image: BAIDU(640, 480) });
  if (!un.ok) { console.error('✘ 建单元失败:', JSON.stringify(un).slice(0, 300)); }
  const uid = un.unit && un.unit.id;
  note(un.unit && un.unit.cover_image);
  t('单元 cover_image 转 S3', isS3Url(un.unit && un.unit.cover_image), un.unit && un.unit.cover_image);
  t('单元响应 cover_image_storage=s3', un.cover_image_storage === 's3');

  // ── 场景 4：单元更新换封面 ──
  console.log('\n[4] PUT /admin/units/:id 换封面（外链 B）');
  const un2 = await api('PUT', '/api/juzhu/admin/units/' + uid, { cover_image: BAIDU(800, 600) });
  note(un2.unit && un2.unit.cover_image);
  t('单元更新转 S3', isS3Url(un2.unit && un2.unit.cover_image), un2.unit && un2.unit.cover_image);
  t('单元更新响应 cover_image_storage=s3', un2.cover_image_storage === 's3');

  // ── 场景 5：图片登记（file_path 外链通道）──
  console.log('\n[5] POST /admin/units/:id/photos（file_path 外链 C）');
  const ph1 = await api('POST', '/api/juzhu/admin/units/' + uid + '/photos', { file_path: BAIDU(640, 480) });
  const photo1 = ph1.photo || {};
  note(photo1.file_path);
  t('图片登记 201 + upload.storage=s3', ph1.ok === true && ph1.upload && ph1.upload.storage === 's3', photo1.file_path);
  t('photos.file_path 为 S3 链接', isS3Url(photo1.file_path));

  // ── 场景 6：multipart 直传（本地图）──
  console.log('\n[6] POST /admin/units/:id/photos（multipart 直传本地图）');
  const imgBuf = fs.readFileSync(LOCAL_IMG);
  const fd = new FormData();
  fd.append('file', new Blob([imgBuf], { type: 'image/jpeg' }), '庆余家园.jpg');
  fd.append('is_cover', 'false');
  const ph2 = await fetch(BASE + '/api/juzhu/admin/units/' + uid + '/photos', {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd,
  }).then((r) => r.json());
  const photo2 = ph2.photo || {};
  note(photo2.file_path);
  t('multipart 直传 storage=s3', ph2.ok === true && ph2.storage === 's3', photo2.file_path);
  t('multipart file_path 为 S3 链接', isS3Url(ph2.file_path));

  // ── 场景 7：PUT /admin/photos/:id 改图 + 设封面 ──
  console.log('\n[7] PUT /admin/photos/:id 改图（外链 D）+ 设为封面');
  const ph3 = await api('PUT', '/api/juzhu/admin/photos/' + photo1.id, { file_path: BAIDU(320, 240), is_cover: true });
  note(ph3.photo && ph3.photo.file_path);
  t('改图 200 + file_path 转 S3', ph3.ok === true && isS3Url(ph3.photo && ph3.photo.file_path), ph3.photo && ph3.photo.file_path);
  const unitRow = (await queryRows('SELECT cover_image, sort_order FROM units WHERE id=?', [uid]))[0];
  const projRow = (await queryRows('SELECT cover_image FROM projects WHERE id=?', [pid]))[0];
  t('设封面后 units.cover_image 同步为该图', unitRow && unitRow.cover_image === ph3.photo.file_path, unitRow && unitRow.cover_image);
  t('projects.cover_image 未被污染（独立字段）', isS3Url(projRow.cover_image));

  // ── 场景 8：POST /admin/upload scope=unit_photo 换图（复用 key）──
  console.log('\n[8] POST /admin/upload scope=unit_photo 换图（复用既有 key）');
  const beforeKey = (require(path.join(ROOT, 'img_storage.cjs')).parse(photo2.file_path) || {}).key;
  const imgBuf2 = fs.readFileSync(LOCAL_IMG2);
  const fd2 = new FormData();
  fd2.append('file', new Blob([imgBuf2], { type: 'image/jpeg' }), 'CCB.jpg');
  fd2.append('scope', 'unit_photo');
  fd2.append('photo_id', String(photo2.id));
  const up2 = await fetch(BASE + '/api/juzhu/admin/upload', {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd2,
  }).then((r) => r.json());
  t('换图 200 + storage=s3', up2.ok === true && up2.storage === 's3', up2.file_path);
  t('换图复用既有 key（零孤儿对象）', up2.upload && up2.upload.key === beforeKey, 'key=' + (up2.upload && up2.upload.key));
  const photo2After = (await queryRows('SELECT file_path FROM photos WHERE id=?', [photo2.id]))[0];
  t('换图后 photos.file_path 已更新为 S3', isS3Url(photo2After && photo2After.file_path), photo2After && photo2After.file_path);

  // ── 场景 9：DELETE /admin/photos/:id（开关默认关 → 对象保留）──
  console.log('\n[9] DELETE /admin/photos/:id（S3_DELETE_ON_PHOTO_DELETE 默认 0）');
  const del = await api('DELETE', '/api/juzhu/admin/photos/' + photo2.id);
  const gone = (await queryRows('SELECT id FROM photos WHERE id=?', [photo2.id])).length === 0;
  t('删除成功 + 行已消失', del.ok === true && gone, 'objects_removed=' + del.objects_removed);
  t('开关关闭时不误删对象（objects_removed=0）', del.objects_removed === 0);

  // ── 汇总 ──
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log('\n===== 结果: ' + pass + ' PASS / ' + fail + ' FAIL =====');

  // ── 清理：测试数据 + 测试对象 ──
  if (!KEEP) {
    console.log('\n[清理] 删除测试房源/单元 + 回收测试对象');
    const d1 = await api('DELETE', '/api/juzhu/admin/units/' + uid);
    const d2 = await api('DELETE', '/api/juzhu/admin/projects/' + pid);
    console.log('  · 单元删除:', d1.ok ? 'ok' : JSON.stringify(d1).slice(0, 120));
    console.log('  · 房源删除:', d2.ok ? 'ok' : JSON.stringify(d2).slice(0, 120));
    let cleaned = 0;
    for (const u of createdObjects) { try { const r = await imgStorage.deleteObjectByRef(u); if (r && r.ok) cleaned += 1; } catch (_) {} }
    console.log('  · 测试对象回收:', cleaned, '/', createdObjects.length);
  } else {
    console.log('\n[清理] --keep：保留测试数据（房源 #' + pid + '，单元 #' + uid + '）');
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('✘ 异常:', (e && e.stack) || e); process.exit(1); });
