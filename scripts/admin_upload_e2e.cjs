#!/usr/bin/env node
/**
 * scripts/admin_upload_e2e.cjs —— 「新增房源 / 新增房源图片」上传链路端到端验证（走 HTTP，需要 DB + 管理员账号）
 *
 * 覆盖：
 *   1) 服务探针（GET /api/juzhu/img?p= 返回 400 = 服务在且图片路由已挂载）
 *   2) 管理员登录 → 拿 Bearer token
 *   3) GET /admin/storage/status：回显新增开关（img_url_mode / img_ingest / fail_on_unconfigured …）
 *   4) multipart 直传 /admin/upload（scope=project_cover_new，无需 DB）→ 201 + file_path + 公网可读
 *   5) multipart 直传 /admin/units/{id}/photos（新增房源图片）→ 201 落 photos 表 + 公网可读
 *   6) 负例：unit 不存在 → 404（而不是 503/415，证明鉴权与解析已通过、走到了业务校验）
 *   7) JSON file_path 第三方 URL：IMG_INGEST=keep 时原样保留（形态归一不误伤外链）
 *   8) 清理：删除测试 photos 行 + 已上传对象（除非 --keep）
 *
 * 用法：
 *   node scripts/admin_upload_e2e.cjs --base=http://127.0.0.1:8766 --unit=1
 *   凭证来自环境变量 / .env.dev / juzhu/.env.local；可用 --login= --password= 覆盖。
 *   注意：会在测试库临时插入 1 行 photos 并在结束时删除；异常中断时可能残留（仅测试环境使用）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── env 加载（不覆盖已有值） ────────────────────────────────────
for (const f of ['juzhu/.env.local', '.env', 'runtime.env', '.env.dev']) {
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

const imgStorage = require(path.join(__dirname, '..', 'img_storage.cjs'));

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = (arg('base', 'http://127.0.0.1:8766') || '').replace(/\/+$/, '');
const LOGIN = arg('login', 'admin');
const PASSWORD = arg('password', process.env.JUZHU_ADMIN_PASSWORD || '');
const UNIT_ID = parseInt(arg('unit', '1'), 10);
const KEEP = argv.includes('--keep');
// 期望落点：s3（缺省，IMG_URL_MODE=dual/s3）| local（IMG_URL_MODE=local 回滚验证）
const EXPECT_STORAGE = arg('expect-storage', 's3');

let failed = 0;
const created = { photos: [], objects: [] };
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  if (!cond) failed++;
}

/** 生成/取一张真实图片字节（优先 sharp 合成，回落已有资产图） */
async function sampleImage() {
  try {
    const sharp = require('sharp');
    const buf = await sharp({ create: { width: 48, height: 36, channels: 3, background: { r: 51, g: 102, b: 153 } } })
      .jpeg({ quality: 80 }).toBuffer();
    return { buf, name: 'e2e-upload.jpg', type: 'image/jpeg' };
  } catch (_) {
    const dir = path.join(__dirname, '..', 'assets', 'juzhu');
    const stack = [dir];
    while (stack.length) {
      const d = stack.shift();
      let names = [];
      try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of names) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!/\.jpe?g$/i.test(e.name)) continue;
        const st = fs.statSync(full);
        if (st.size > 300 * 1024) continue;
        return { buf: fs.readFileSync(full), name: e.name, type: 'image/jpeg' };
      }
    }
    return null;
  }
}

async function jfetch(p, opts) {
  const res = await fetch(BASE + p, opts);
  let body = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) { try { body = await res.json(); } catch (_) { body = null; } }
  return { status: res.status, body, headers: res.headers };
}

async function publicReadable(url) {
  try {
    // 本地回落形态是 /assets/uploads/...（相对路径），补 BASE 才能取到
    const target = /^https?:\/\//i.test(url) ? url : BASE + url;
    const r = await fetch(target, { method: 'GET' });
    return { ok: r.ok, status: r.status, bytes: (await r.arrayBuffer()).byteLength };
  } catch (e) { return { ok: false, status: 0, error: String(e.message || e) }; }
}

async function cleanup(token) {
  for (const id of created.photos) {
    await fetch(BASE + '/api/juzhu/admin/photos/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
  }
  for (const url of created.objects) {
    await imgStorage.deleteObjectByRef(url).catch(() => {});
  }
}

(async () => {
  // 1) 服务探针
  const probe = await jfetch('/api/juzhu/img?p=');
  check('服务在且图片路由已挂载（GET /api/juzhu/img?p= → 400）', probe.status === 400, 'status=' + probe.status);
  if (probe.status === 0) { console.error('服务不可达: ' + BASE); process.exit(1); }

  // 2) 登录
  if (!PASSWORD) { console.error('缺少管理员密码：请设置 JUZHU_ADMIN_PASSWORD 或 --password='); process.exit(1); }
  const login = await jfetch('/api/juzhu/admin/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_name: LOGIN, password: PASSWORD }),
  });
  check('管理员登录成功', login.status === 200 && !!(login.body && login.body.token), 'status=' + login.status + ' ' + JSON.stringify(login.body || {}).slice(0, 160));
  if (!(login.body && login.body.token)) process.exit(1);
  const token = login.body.token;
  const auth = { Authorization: 'Bearer ' + token };

  // 3) storage/status 回显新增开关
  const st = await jfetch('/api/juzhu/admin/storage/status', { headers: auth });
  const mode = st.body && st.body.img_url_mode;
  check('storage/status 回显 img_url_mode/ingest/normalize/fail_on_unconfigured/migrate_prefix',
    st.status === 200 && mode && st.body.img_ingest !== undefined && st.body.img_normalize !== undefined
      && st.body.fail_on_unconfigured !== undefined && st.body.migrate_prefix !== undefined,
    JSON.stringify({ mode, ingest: st.body && st.body.img_ingest, write_mode: st.body && st.body.write_mode, sharp: st.body && st.body.sharp }));

  const img = await sampleImage();
  if (!img) { console.error('无法准备测试图片'); process.exit(1); }

  // 4) multipart → /admin/upload（scope=project_cover_new，无需 DB）
  const fd1 = new FormData();
  fd1.append('file', new Blob([img.buf], { type: img.type }), img.name);
  fd1.append('scope', 'project_cover_new');
  fd1.append('channel', 'bzf');
  fd1.append('project_name', 'E2E草稿封面');
  const up1 = await jfetch('/api/juzhu/admin/upload', { method: 'POST', headers: auth, body: fd1 });
  check('multipart /admin/upload(scope=project_cover_new) → 201（原实现 415）',
    up1.status === 201 && !!(up1.body && up1.body.file_path), 'status=' + up1.status + ' ' + JSON.stringify(up1.body || {}).slice(0, 200));
  if (up1.body && up1.body.file_path) {
    created.objects.push(up1.body.file_path);
    const r = await publicReadable(up1.body.file_path);
    check('上传结果公网可读（file 域直读）', r.ok, JSON.stringify(r));
  }

  // 5) multipart → /admin/units/:id/photos（新增房源图片）
  const fd2 = new FormData();
  fd2.append('file', new Blob([img.buf], { type: img.type }), img.name);
  const up2 = await jfetch(`/api/juzhu/admin/units/${UNIT_ID}/photos`, { method: 'POST', headers: auth, body: fd2 });
  check(`multipart /admin/units/${UNIT_ID}/photos → 201（原实现 503）`,
    up2.status === 201 && !!(up2.body && up2.body.photo && up2.body.photo.file_path),
    'status=' + up2.status + ' ' + JSON.stringify(up2.body || {}).slice(0, 240));
  if (up2.body) {
    check(`落点符合期望（--expect-storage=${EXPECT_STORAGE}）`, up2.body.storage === EXPECT_STORAGE,
      'storage=' + up2.body.storage + ' file_path=' + up2.body.file_path);
  }
  if (up2.body && up2.body.photo) {
    created.photos.push(up2.body.photo.id);
    created.objects.push(up2.body.photo.file_path);
    const listed = await jfetch(`/api/juzhu/admin/units/${UNIT_ID}/photos`, { headers: auth });
    const found = (listed.body && listed.body.photos || []).some((p) => p.id === up2.body.photo.id);
    check('新增图片已落 photos 表且列表可见', found);
    const r = await publicReadable(up2.body.photo.file_path);
    check('新增图片公网可读', r.ok, JSON.stringify(r));
  }

  // 6) 负例：unit 不存在 → 404（而不是 503/415）
  const fd3 = new FormData();
  fd3.append('file', new Blob([img.buf], { type: img.type }), img.name);
  const up3 = await jfetch('/api/juzhu/admin/units/99999999/photos', { method: 'POST', headers: auth, body: fd3 });
  check('unit 不存在 → 404（证明鉴权/解析通过，非 503/415）', up3.status === 404, 'status=' + up3.status);

  // 7) JSON file_path 第三方 URL：IMG_INGEST=keep 时原样保留
  const extUrl = 'https://vendor-cdn.example.com/e2e-' + Date.now() + '.jpg';
  const up4 = await jfetch(`/api/juzhu/admin/units/${UNIT_ID}/photos`, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
    body: JSON.stringify({ file_path: extUrl }),
  });
  if (up4.status === 201 && up4.body && up4.body.photo) {
    created.photos.push(up4.body.photo.id);
    const keepMode = (st.body && st.body.img_ingest) !== 'mirror';
    check('外部 URL 入库：镜像关闭时原样保留 / 开启时被替换为对象存储 URL',
      keepMode ? up4.body.photo.file_path === extUrl : /^https?:\/\/.+/.test(up4.body.photo.file_path),
      'file_path=' + up4.body.photo.file_path);
  } else {
    check('JSON file_path 通道可用（201）', false, 'status=' + up4.status + ' ' + JSON.stringify(up4.body || {}).slice(0, 160));
  }

  // 8) 清理
  if (!KEEP) { await cleanup(token); console.log('已清理测试数据（photos 行 + 对象）'); }
  else { console.log('--keep：已保留测试对象/数据'); }

  console.log(`\n${failed ? 'FAILED: ' + failed : 'OK'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
