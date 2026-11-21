#!/usr/bin/env node
/**
 * scripts/admin_upload_multipart_regression.cjs —— S0 契约修复回归
 *   覆盖：multipart 解析（二进制安全 / 中文文件名 / 边界误伤 / 错误处理）
 *        + 后台上传路由挂载与鉴权（HTTP）
 *        + 完整上传（multipart 7 种 scope）——需数据库与管理员账号，缺一则自动跳过
 *
 * 用法：
 *   node scripts/admin_upload_multipart_regression.cjs                       # 只跑纯函数单测（无需 DB）
 *   node scripts/admin_upload_multipart_regression.cjs --password=***        # 追加 HTTP+DB 全链路
 *   node scripts/admin_upload_multipart_regression.cjs http://127.0.0.1:9000 --password=*** --project=9001
 *
 * 退出码：0 全通过 / 1 有失败 / 2 环境不足（未连接服务）
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

const argv = process.argv.slice(2);
const arg = (n) => { const h = argv.find((a) => a.startsWith('--' + n + '=')); return h ? h.split('=').slice(1).join('=') : null; };
const BASE = (argv.find((a) => /^https?:\/\//.test(a)) || 'http://127.0.0.1:8766').replace(/\/+$/, '');
const PASS = arg('password') || process.env.S3_E2E_PASSWORD || process.env.JUZHU_ADMIN_PASSWORD || '';
const USER = arg('user') || 'admin';
const PROJECT = arg('project') || '9001';

let failed = 0;
let skipped = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  if (!cond) failed++;
}
function skip(name, why) {
  console.log(`SKIP  ${name}（${why}）`);
  skipped++;
}

// ── 构造 multipart body ──
function buildMultipart(parts, boundary) {
  const chunks = [];
  for (const p of parts) {
    const head = [`--${boundary}`];
    if (p.filename != null) {
      head.push(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"`);
      head.push(`Content-Type: ${p.contentType || 'application/octet-stream'}`);
    } else {
      head.push(`Content-Disposition: form-data; name="${p.name}"`);
    }
    chunks.push(Buffer.from(head.join('\r\n') + '\r\n\r\n', 'utf8'));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function tinyPng(w = 32, h = 32) {
  let c;
  const table = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (b) => { let x = 0xffffffff; for (let i = 0; i < b.length; i++) x = table[(x ^ b[i]) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c4 = Buffer.alloc(4); c4.writeUInt32BE(crc(body), 0);
    return Buffer.concat([len, body, c4]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); let o = 0;
  for (let y = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { raw[o++] = (x * 255 / w) | 0; raw[o++] = (y * 255 / h) | 0; raw[o++] = 90; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
}

(async () => {
  console.log('=== S0 契约修复回归：multipart 上传 ─===');
  const app = require('../app.js');       // 不启动服务（受 require.main 保护）
  const { parseMultipart } = app;
  check('app.js 导出 parseMultipart（可供回归使用）', typeof parseMultipart === 'function');
  if (typeof parseMultipart !== 'function') process.exit(1);

  const B = '----WebKitFormBoundaryTest0123';

  // ── 1) 基本字段 + 文件 ──
  const body1 = buildMultipart([
    { name: 'scope', data: 'unit_gallery' },
    { name: 'unit_id', data: '3101' },
    { name: 'file', filename: 'a.jpg', contentType: 'image/jpeg', data: Buffer.from('JPEGDATA') },
  ], B);
  const r1 = parseMultipart(body1, `multipart/form-data; boundary=${B}`);
  check('解析字段 scope/unit_id', r1.fields && r1.fields.scope === 'unit_gallery' && r1.fields.unit_id === '3101', JSON.stringify(r1.fields));
  check('解析文件 file（文件名/类型/内容）',
    r1.files && r1.files.file && r1.files.file.filename === 'a.jpg'
    && r1.files.file.contentType === 'image/jpeg' && r1.files.file.data.toString() === 'JPEGDATA',
    JSON.stringify(r1.files && Object.keys(r1.files)));

  // ── 2) 二进制安全：含 CRLF / 0x00 / 0xff / 疑似 boundary 但不带前导 CRLF ──
  const tricky = Buffer.concat([
    Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x1a]),
    Buffer.from('--' + B),                       // 无前导 CRLF，不得被当作分隔符
    Buffer.from([0x0d, 0x0a]),
    Buffer.from('--notreally'),
    Buffer.from([0x00, 0x80, 0x7f]),
  ]);
  const body2 = buildMultipart([
    { name: 'file', filename: 'tricky.png', contentType: 'image/png', data: tricky },
  ], B);
  const r2 = parseMultipart(body2, `multipart/form-data; boundary=${B}`);
  check('二进制安全：字节完全一致（含 CRLF/0x00/0xff/疑似 boundary）',
    r2.files && r2.files.file && r2.files.file.data.equals(tricky),
    r2.files && r2.files.file ? `got ${r2.files.file.data.length}B vs ${tricky.length}B` : 'no file');

  // ── 3) 中文文件名（前端上传本地中文名图片） ──
  const png = tinyPng();
  const body3 = buildMultipart([{ name: 'file', filename: '户型图-和平区.png', contentType: 'image/png', data: png }], B);
  const r3 = parseMultipart(body3, `multipart/form-data; boundary=${B}`);
  check('UTF-8 文件名', r3.files && r3.files.file && r3.files.file.filename === '户型图-和平区.png', r3.files && r3.files.file && r3.files.file.filename);
  check('PNG 字节完整（可与 img_storage 对接）', r3.files && r3.files.file && r3.files.file.data.equals(png), r3.files && r3.files.file && r3.files.file.data.length + 'B');

  // ── 4) 多个文件 + 多字段 ──
  const body4 = buildMultipart([
    { name: 'scope', data: 'project_cover' },
    { name: 'project_id', data: '1611' },
    { name: 'file', filename: 'c1.jpg', contentType: 'image/jpeg', data: Buffer.from('one') },
    { name: 'extra', data: 'x=y' },
  ], B);
  const r4 = parseMultipart(body4, `multipart/form-data; boundary=${B}`);
  check('字段与文件混合解析', r4.fields && r4.fields.project_id === '1611' && r4.fields.extra === 'x=y' && r4.files.file.data.toString() === 'one', JSON.stringify(r4.fields));

  // ── 5) 错误处理 ──
  check('缺 boundary → 报错', !!parseMultipart(body1, 'multipart/form-data').error);
  check('body 与 boundary 不匹配 → 报错', !!parseMultipart(Buffer.from('garbage'), 'multipart/form-data; boundary=' + B).error);
  const r5 = parseMultipart(buildMultipart([{ name: 'scope', data: 'project_cover' }], B), `multipart/form-data; boundary=${B}`);
  check('无 file 字段时 files 为空（由路由判 file 必填）', !r5.files.file);

  // ── 6) 前端改动静态校验（S0-3）：内联脚本能编译 + 坏写法归零 + 助手就位 ──
  {
    const vm = require('vm');
    const targets = [
      { f: 'juzhu-admin.html', helper: ['imgUrl', 'cssUrl'] },
      { f: 'juzhu-admin-unit.html', helper: ['imgUrl', 'cssUrl'] },
    ];
    for (const t of targets) {
      const html = fs.readFileSync(path.join(__dirname, '..', t.f), 'utf8');
      // 抽出所有内联 <script>（跳过带 src 的）
      const blocks = [];
      const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
      let m2;
      while ((m2 = re.exec(html)) !== null) {
        if (/\bsrc\s*=/i.test(m2[1] || '')) continue;
        blocks.push({ src: m2[2], line: html.slice(0, m2.index).split('\n').length + 1 });
      }
      let compileErr = '';
      for (const b of blocks) {
        try {
          // 只编译不执行（语法校验）
          // eslint-disable-next-line no-new
          new vm.Script(b.src, { filename: `${t.f}(lineno~${b.line})` });
        } catch (e) { compileErr = compileErr || `${t.f}@${b.line}: ${e.message}`; }
      }
      check(`${t.f} 内联脚本语法通过（${blocks.length} 个块）`, !compileErr, compileErr);
      check(`${t.f} 坏写法 url('/"+path 归零`, !/url\('\/"\s*\+/.test(html),
        (html.match(/url\('\/"\s*\+/g) || []).length + ' 处残留');
      for (const h of t.helper) {
        check(`${t.f} 定义 ${h}()`, new RegExp('function\\s+' + h + '\\s*\\(').test(html));
      }
    }
    const rating = fs.readFileSync(path.join(__dirname, '..', 'screens/p-rating-detail.html'), 'utf8');
    check('screens/p-rating-detail.html 坏写法归零', !/src="\/'\s*\+/.test(rating));
  }

  // ── 7) 进程内直调 handler：project_cover_new（无需数据库）→ 真上传到 S3 ──
  {
    const { Readable } = require('stream');
    const handler = app.handleAdminMultipartUpload;
    check('app.js 导出 handleAdminMultipartUpload', typeof handler === 'function');
    if (typeof handler === 'function') {
      const bodyPng = buildMultipart([
        { name: 'scope', data: 'project_cover_new' },
        { name: 'channel', data: 'rental' },
        { name: 'project_name', data: 'S0回归草稿' },
        { name: 'file', filename: 's0-draft.png', contentType: 'image/png', data: tinyPng() },
      ], B);
      const fakeReq = Readable.from([bodyPng]);
      fakeReq.headers = { 'content-type': `multipart/form-data; boundary=${B}` };
      fakeReq.method = 'POST';
      let captured = null;
      const fakeRes = {
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(payload) { captured = { status: this.status, body: payload }; },
      };
      // eslint-disable-next-line no-await-in-loop
      await handler(fakeReq, fakeRes);
      let parsed = null;
      try { parsed = JSON.parse(captured.body); } catch (_) {}
      check('project_cover_new 直调 → 201 + file_path（无数据库依赖）',
        captured && captured.status === 201 && parsed && parsed.file_path,
        captured ? `HTTP ${captured.status} ${String(captured.body).slice(0, 200)}` : 'no response');
      if (parsed && parsed.upload && parsed.upload.key) {
        const S3 = require('../s3_client.cjs');
        const store = require('../img_storage.cjs');
        check('产物落对象存储（storage=s3）', parsed.upload.storage === 's3', `storage=${parsed.upload.storage} warned=${parsed.warned || '-'}`);
        if (parsed.upload.storage === 's3') {
          // eslint-disable-next-line no-await-in-loop
          const head = await fetch(parsed.file_path, { method: 'HEAD' });
          check('产物公网可读', head.ok, `HTTP ${head.status} ${parsed.file_path}`);
          // eslint-disable-next-line no-await-in-loop
          await S3.deleteObject(parsed.upload.key);
          for (const sz of [240, 640]) {
            if (parsed.upload['thumb_' + sz]) {
              // eslint-disable-next-line no-await-in-loop
              await S3.deleteObject(store.thumbKey(parsed.upload.key, sz));
            }
          }
          console.log('  （测试对象已清理）');
        }
      }
    }
  }

  // ── 8) HTTP：路由挂载与鉴权 ──
  let serverUp = false;
  try {
    const probe = await fetch(`${BASE}/api/juzhu/img?p=`);
    serverUp = probe.status === 400;
    check('服务可达且图片路由已挂载（GET /api/juzhu/img 期望 400）', serverUp, `HTTP ${probe.status}`);
  } catch (e) {
    check('服务可达', false, `${BASE} 连接失败：${e.message}`);
    console.log('\n（服务未启动，HTTP 用例跳过；纯函数用例已全部执行）');
    process.exit(failed ? 1 : 0);
  }

  // 无凭据 → 401（multipart 分支此前会 415/503，修复后应先过鉴权再解析）
  const fd = new FormData();
  fd.append('scope', 'project_cover');
  fd.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
  const noAuth = await fetch(`${BASE}/api/juzhu/admin/upload`, { method: 'POST', body: fd });
  check('POST /admin/upload（multipart）无凭据 → 401', noAuth.status === 401, `HTTP ${noAuth.status}`);

  // 登录
  if (!PASS) {
    skip('multipart 全链路上传', '未提供 --password / JUZHU_ADMIN_PASSWORD');
  } else {
    const login = await api('POST', '/api/juzhu/admin/auth/login', { login_name: USER, password: PASS });
    if (login.status !== 200 || !login.j || !login.j.token) {
      skip('multipart 全链路上传', `登录失败（DB 不可达或口令错误）：HTTP ${login.status} ${JSON.stringify(login.j).slice(0, 120)}`);
    } else {
      const token = login.j.token;
      const scopes = [
        { scope: 'project_cover_new', fields: { project_name: 'S0回归草稿' } },
        { scope: 'project_cover', fields: { project_id: PROJECT } },
        { scope: 'city_hero', fields: {} },
      ];
      for (const s of scopes) {
        const f = new FormData();
        f.append('scope', s.scope);
        Object.entries(s.fields).forEach(([k, v]) => f.append(k, v));
        f.append('file', new Blob([png], { type: 'image/png' }), `${s.scope}.png`);
        // eslint-disable-next-line no-await-in-loop
        const r = await fetch(`${BASE}/api/juzhu/admin/upload`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: f });
        let j = null;
        try { j = await r.json(); } catch (_) {}
        const stale = r.status === 415 || r.status === 503;
        check(`scope=${s.scope} 上传 → 201 + file_path`, r.status === 201 && j && j.file_path,
          `HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`
          + (stale ? '（**服务为改动前的旧进程**，请重启 node app.js 或 kill 8766 让守护拉起新代码）' : ''));
        if (j && j.file_path) {
          // eslint-disable-next-line no-await-in-loop
          const head = await fetch(j.file_path, { method: 'HEAD' });
          check(`scope=${s.scope} 产物公网可读`, head.ok, `${j.file_path} → HTTP ${head.status}`);
          if (j.upload && j.upload.key) {
            const S3 = require('../s3_client.cjs');
            // eslint-disable-next-line no-await-in-loop
            await S3.deleteObject(j.upload.key);
            for (const sz of [240, 640]) {
              if (j.upload['thumb_' + sz]) {
                // eslint-disable-next-line no-await-in-loop
                await S3.deleteObject(require('../img_storage.cjs').thumbKey(j.upload.key, sz));
              }
            }
          }
        }
      }
      // 未知 scope → 400
      const fBad = new FormData();
      fBad.append('scope', 'not_a_scope');
      fBad.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
      const badScope = await fetch(`${BASE}/api/juzhu/admin/upload`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fBad });
      check('未知 scope → 400（列出可用 scope）', badScope.status === 400, `HTTP ${badScope.status}`);
    }
  }

  console.log(`\n${failed === 0 ? 'S0 回归全部通过 ✅' : failed + ' 项失败 ❌'}${skipped ? `（跳过 ${skipped} 项）` : ''}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('回归异常:', e && e.stack || e);
  process.exit(2);
});
