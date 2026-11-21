#!/usr/bin/env node
/**
 * scripts/s3_api_e2e.cjs —— 图片上传/读取「走 HTTP 接口」的端到端验证
 *
 * 与 s3_smoke.cjs 的分工：
 *   s3_smoke.cjs  = 直连 S3 协议层自检（不需数据库、不需登录）→ 先跑它排除存储侧问题
 *   本脚本        = 走 app.js 真实 HTTP 链路（需数据库可达 + 一个能登录的账号）→ 验证集成
 *
 * 覆盖：登录 → 存储自检 → 上传（save=false，不落库）→ 代理读取 → 公网读取 → 预签名直传 → 清理
 *      可选 --project=<id> 验证「上传 + 落库 photos 表」（会在该房源下产生一条图片记录）
 *
 * 用法：
 *   node scripts/s3_api_e2e.cjs                              # 默认 http://127.0.0.1:8766
 *   node scripts/s3_api_e2e.cjs http://127.0.0.1:9000
 *   node scripts/s3_api_e2e.cjs --user=admin --password=***   # 或 env S3_E2E_USER / S3_E2E_PASSWORD
 *   node scripts/s3_api_e2e.cjs --project=9001                # 额外验证落库（建议用演示房源）
 *   node scripts/s3_api_e2e.cjs --keep                        # 保留 S3 对象便于人工核对
 *
 * 安全：默认 save=false **不写业务表**；--project 才会插入 photos 行（需人工在后台删除）。
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
const arg = (n) => { const h = argv.find((a) => a.startsWith('--' + n + '=')); return h ? h.split('=').slice(1).join('=') : null; };
const flag = (n) => argv.includes('--' + n);
const BASE = (argv.find((a) => /^https?:\/\//.test(a)) || process.env.S3_E2E_BASE || 'http://127.0.0.1:8766').replace(/\/+$/, '');
const USER = arg('user') || process.env.S3_E2E_USER || 'admin';
const PASS = arg('password') || process.env.S3_E2E_PASSWORD || process.env.JUZHU_ADMIN_PASSWORD || '';
const PROJECT = arg('project');
const UNIT = arg('unit');
const KEEP = flag('keep');

let failed = 0;
let token = null;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  if (!cond) failed++;
}

async function api(method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (_) { /* 非 JSON */ }
  return { status: r.status, j };
}

// 无依赖生成一张可辨认的小 PNG（与 s3_smoke 同一套）
function crc32(buf) {
  let c;
  const t = crc32.t || (crc32.t = (() => { const a = new Uint32Array(256); for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; a[n] = c >>> 0; } return a; })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, c]);
}
function tinyPng(w = 96, h = 96) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) { raw[o++] = (x * 255 / w) | 0; raw[o++] = (y * 255 / h) | 0; raw[o++] = 120; }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

(async () => {
  console.log(`=== 图片上传/读取 端到端验证（HTTP）===`);
  console.log(`base  : ${BASE}`);
  console.log(`user  : ${USER}${PASS ? '' : '（未提供密码）'}`);
  console.log(`mode  : ${PROJECT ? '上传 + 落库（project ' + PROJECT + (UNIT ? ' / unit ' + UNIT : '') + '）' : '仅上传（save=false，不写业务表）'}`);
  console.log('');

  // ── 0) 服务可达性 + 图片路由已挂载 ──
  // 用 /api/juzhu/img 做探针：它位于 ensureSchema() 之前，不需要数据库即可响应
  // （p 为空 → 400；若路由未挂载会落到统一鉴权 → 401，据此可判断路由是否存在）
  try {
    const r = await fetch(BASE + '/api/juzhu/img?p=');
    check('服务可达且图片路由已挂载（期望 400）', r.status === 400,
      `HTTP ${r.status}${r.status === 401 ? '（图片路由未生效或服务为旧版本，请重启 node app.js）' : ''}`);
  } catch (e) {
    check('服务可达', false, `${BASE} 连接失败：${e.message}（先 node app.js 起服务）`);
    process.exit(2);
  }

  // ── 1) 登录取会话 ──
  if (!PASS) {
    check('登录凭据', false, '未提供密码：用 --password= 或 env S3_E2E_PASSWORD / JUZHU_ADMIN_PASSWORD');
    process.exit(2);
  }
  const login = await api('POST', '/api/juzhu/admin/auth/login', { login_name: USER, password: PASS });
  check('账号登录（POST /api/juzhu/admin/auth/login）', login.status === 200 && login.j && login.j.token,
    login.j ? JSON.stringify(login.j).slice(0, 160) : `HTTP ${login.status}`);
  if (!login.j || !login.j.token) process.exit(2);
  token = login.j.token;
  console.log(`  角色: ${JSON.stringify(login.j.roles)}\n`);

  // ── 2) 存储自检（服务端视角配置） ──
  const st = await api('GET', '/api/juzhu/admin/storage/status');
  check('GET /admin/storage/status', st.status === 200 && st.j, `HTTP ${st.status}`);
  if (st.j) {
    console.log(`  mode=${st.j.mode} bucket=${st.j.bucket} sign=${st.j.sign_version} addressing=${st.j.addressing} file_style=${st.j.file_style} prefix=${st.j.key_prefix}`);
    console.log(`  额外头/缺省 ACL: ${JSON.stringify(st.j.extra_headers || '(未返回)')}`);
    check('存储模式为 s3', st.j.mode === 's3', `mode=${st.j.mode}（未配置 S3_* 会回落 local）`);
    check('sample_public_url 形态正确', String(st.j.sample_public_url || '').includes(st.j.bucket || '#'), st.j.sample_public_url);
  }

  const png = tinyPng();
  const uploaded = [];

  // ── 3) 上传（save=false，不落库） ──
  const up = await api('POST', '/api/juzhu/admin/photos/upload', {
    data_url: 'data:image/png;base64,' + png.toString('base64'),
    filename: 'e2e-verify.png',
    save: false,
    prefix: 'verify',
  });
  check('POST /admin/photos/upload（save=false）', up.status === 201 && up.j && up.j.upload && up.j.upload.ok,
    up.j ? JSON.stringify(up.j).slice(0, 220) : `HTTP ${up.status}`);
  if (!up.j || !up.j.upload) { console.log('\n上传失败，后续用例跳过'); process.exit(failed ? 1 : 0); }
  const U = up.j.upload;
  uploaded.push(U.key);
  if (U.thumb_240) uploaded.push(imgStorage.thumbKey(U.key, 240));
  if (U.thumb_640) uploaded.push(imgStorage.thumbKey(U.key, 640));
  console.log(`  storage=${U.storage} url=${U.url}`);
  console.log(`  bytes=${U.bytes} content_type=${U.content_type} 缩略图=${U.thumb_640 ? '有' : '无'}${U.warned ? ' warned=' + U.warned : ''}`);
  check('落库被跳过（save=false）', up.j.saved === false);

  // ── 4) 代理读取（服务端读，公网可读接口） ──
  let proxyLen = 0;
  {
    const r = await fetch(`${BASE}/api/juzhu/img?p=${encodeURIComponent(U.key)}`);
    const b = Buffer.from(await r.arrayBuffer());
    proxyLen = b.length;
    check('GET /api/juzhu/img 代理读取', r.status === 200 && b.length === U.bytes,
      `HTTP ${r.status} ${b.length}B（期望 ${U.bytes}B）`);
  }

  // ── 5) 公网/CDN 读取（浏览器同路径） ──
  try {
    const r = await fetch(U.url, { method: 'HEAD' });
    check('公网 URL 可读（HEAD）', r.ok, `HTTP ${r.status} ${U.url}`);
    const g = await fetch(U.url);
    const b = Buffer.from(await g.arrayBuffer());
    check('公网 URL 内容长度一致', b.length === U.bytes, `${b.length}B vs ${U.bytes}B`);
  } catch (e) {
    check('公网 URL 可读', false, String(e.message));
  }
  if (U.thumb_640) {
    const r = await fetch(U.thumb_640, { method: 'HEAD' });
    check('缩略图公网可读（t640）', r.ok, `HTTP ${r.status}`);
  }

  // ── 6) 预签名直传（前端同路径） ──
  const pre = await api('POST', '/api/juzhu/admin/photos/presign', { ext: 'png', prefix: 'verify', expires: 300 });
  check('POST /admin/photos/presign', pre.status === 200 && pre.j && pre.j.url, pre.j ? JSON.stringify(pre.j).slice(0, 180) : `HTTP ${pre.status}`);
  if (pre.j && pre.j.url) {
    const put = await fetch(pre.j.url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png });
    check('预签名 PUT 直传', put.ok, `HTTP ${put.status} ${put.ok ? '' : (await put.text()).slice(0, 160)}`);
    if (put.ok) {
      uploaded.push(pre.j.key);
      const head = await fetch(pre.j.public_url, { method: 'HEAD' });
      check('预签名产物公网可读', head.ok, `HTTP ${head.status}`);
    }
  }

  // ── 7) 可选：验证落库（写 photos 表） ──
  if (PROJECT) {
    const body = { data_url: 'data:image/png;base64,' + png.toString('base64'), filename: 'e2e-db.png', prefix: 'verify', is_cover: false };
    if (UNIT) body.unit_id = parseInt(UNIT, 10); else body.project_id = parseInt(PROJECT, 10);
    const dbUp = await api('POST', '/api/juzhu/admin/photos/upload', body);
    const photo = dbUp.j && dbUp.j.photo;
    check('上传并落库（photos 表）', dbUp.status === 201 && photo && photo.id, dbUp.j ? JSON.stringify(dbUp.j).slice(0, 220) : `HTTP ${dbUp.status}`);
    if (dbUp.j && dbUp.j.upload) {
      const du = dbUp.j.upload;
      uploaded.push(du.key);
      if (du.thumb_240) uploaded.push(imgStorage.thumbKey(du.key, 240));
      if (du.thumb_640) uploaded.push(imgStorage.thumbKey(du.key, 640));
    }
    if (photo) {
      console.log(`  photo id=${photo.id} entity=${photo.entity_type}#${photo.entity_id}`);
      console.log(`  file_path=${photo.file_path}`);
      check('photos.file_path 为可直用 URL', /^https?:\/\//.test(String(photo.file_path)) || String(photo.file_path).startsWith('/assets/'), photo.file_path);
      if (photo.entity_type === 'unit') {
        const del = await api('DELETE', `/api/juzhu/admin/photos/${photo.id}`);
        check('回滚测试数据（DELETE /admin/photos/:id）', del.status === 200, `HTTP ${del.status}`);
      } else {
        console.log(`  ⚠ project 图片无删除接口（DELETE 仅支持 unit 图）：请在后台「项目编辑器」删除 photo id=${photo.id}`);
      }
    }
  }

  // ── 8) 清理 S3 对象 ──
  if (KEEP) {
    console.log('\n--keep：保留以下对象，请人工核对后自行删除：');
    uploaded.forEach((k) => console.log('  ' + k));
  } else {
    let del = 0;
    for (const k of new Set(uploaded)) {
      // eslint-disable-next-line no-await-in-loop
      const r = await S3.deleteObject(k);
      if (r.ok || r.status === 204) del++;
    }
    check(`清理 S3 对象 ${del}/${new Set(uploaded).size}`, del === new Set(uploaded).size);
  }

  console.log(failed === 0 ? '\n端到端验证全部通过 ✅' : `\n${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('验证异常:', e && e.stack || e);
  process.exit(2);
});
