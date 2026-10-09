#!/usr/bin/env node
/**
 * S3 环境诊断（一条命令给出完整结论）
 * ---------------------------------------------------------------------------
 * 用法（在仓库根执行，与线上同款 env 链）：
 *   node scripts/s3_env_diag.cjs                     # 按 app.js 顺序加载 .env.{mode} → .env → runtime.env
 *   node --env-file=runtime.env scripts/s3_env_diag.cjs   # 指定文件（SCF/systemd 常见用法）
 *
 * 检查项：
 *   1) env 来源链与 S3/IMG 关键键（密钥打码）
 *   2) s3_client 配置 + 各开关（storageMode/writeMode/urlMode/ingestMode）
 *   3) 真实探针：内存生成 1x1 PNG → uploadImage 完整链路 → 公网 HEAD 校验 → 清理对象
 *   4) 最终结论：链路可用 / 缺什么、该怎么补
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── 1. 复刻 app.js 的 env 加载顺序（--env-file 已注入的键不覆盖）────────────
function loadDotEnv(p) {
  if (!fs.existsSync(p)) return null;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (Object.prototype.hasOwnProperty.call(process.env, key) && process.env[key] !== '') continue;
    process.env[key] = val;
  }
  return p;
}
const loaded = [];
const mode = process.env.JUZHU_ENV || process.env.NODE_ENV;
if (mode) { const f = loadDotEnv(path.join(ROOT, '.env.' + mode)); if (f) loaded.push(path.basename(f)); }
const f2 = loadDotEnv(path.join(ROOT, '.env')); if (f2) loaded.push('.env');
const f3 = loadDotEnv(path.join(ROOT, 'runtime.env')); if (f3) loaded.push('runtime.env');

const mask = (v) => {
  const s = String(v || '');
  if (!s) return '(未设置)';
  return s.slice(0, 4) + '***' + s.slice(-2) + ` (len=${s.length})`;
};

console.log('=== S3 环境诊断 ' + new Date().toISOString() + ' ===');
console.log('cwd      =', process.cwd());
console.log('NODE_ENV =', process.env.NODE_ENV || '(空)', '| JUZHU_ENV =', process.env.JUZHU_ENV || '(空)');
console.log('env 链   =', loaded.length ? loaded.join(' → ') + '（后加载不覆盖已有键，--env-file 优先级最高）' : '(仅进程环境变量)');
console.log('');

const S3 = require(path.join(ROOT, 's3_client.cjs'));
const img = require(path.join(ROOT, 'img_storage.cjs'));
const c = S3.config();

console.log('--- 关键键 ---');
console.log('S3_ACCESS_KEY      =', mask(process.env.S3_ACCESS_KEY));
console.log('S3_SECRET_KEY      =', mask(process.env.S3_SECRET_KEY));
console.log('S3_ENDPOINT        =', c.endpoint || '(未设置)');
console.log('S3_BUCKET          =', c.bucket || '(未设置)');
console.log('S3_FILE_ENDPOINT   =', c.fileEndpoint || '(未设置)');
console.log('S3_FILE_STYLE      =', c.fileStyle, '| S3_ADDRESSING =', c.addressing, '| S3_SIGN_VERSION =', c.signVersion);
console.log('S3_KEY_PREFIX      =', c.keyPrefix, '| S3_MAX_BYTES =', img.maxBytes());
console.log('IMG_INGEST         =', process.env.IMG_INGEST || 'keep(缺省)');
console.log('IMG_URL_MODE       =', process.env.IMG_URL_MODE || 'dual(缺省)');
console.log('S3_FAIL_ON_UNCONFIGURED =', process.env.S3_FAIL_ON_UNCONFIGURED || '0(缺省)');
console.log('');

console.log('--- 判定 ---');
console.log('isConfigured  =', S3.isConfigured(), '（false = 上传必然回落本地磁盘）');
console.log('storageMode   =', img.storageMode());
console.log('writeMode     =', img.writeMode());
console.log('urlMode       =', img.urlMode());
console.log('ingestMode    =', img.ingestMode(), '（mirror = 外链/本地引用会上传对象存储）');
console.log('sharp         =', (() => { try { require('sharp'); return true; } catch (_) { return false; } })());
console.log('');

// ── 3. 真实探针 ─────────────────────────────────────────────────────────────
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

(async () => {
  console.log('--- 真实探针（上传/公网读/清理）---');
  if (!S3.isConfigured()) {
    console.log('[SKIP] S3 未配置（缺 ACCESS_KEY/SECRET_KEY/ENDPOINT/BUCKET 之一），探针无法执行');
    console.log('');
    console.log('结论：test/prod 环境必须先补齐 S3 四件套（密钥见本地 .env 或运维），');
    console.log('      否则所有上传静默回落本地磁盘 assets/uploads/（发行包不含 assets/ → 生产必坏图）。');
    process.exit(2);
  }
  const up = await img.uploadImage({
    buffer: PNG_1PX, filename: 'diag.png', contentType: 'image/png',
    prefix: 'diag', entityType: 'project', entityId: 0, makeThumbs: false,
  });
  console.log('upload: ok=' + up.ok, 'storage=' + up.storage, 'warned=' + (up.warned || '(无)'));
  console.log('  url =', up.url || up.error || '(空)');
  if (up.ok && up.storage === 's3' && up.url) {
    try {
      const head = await fetch(up.url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      console.log('  公网读: HTTP', head.status, '| content-type =', head.headers.get('content-type') || '-');
    } catch (e) {
      console.log('  公网读: 失败', String(e.message || e));
    }
    try { await img.deleteObjectByRef(up.url); console.log('  探针对象已清理'); } catch (_) { console.log('  探针对象清理失败（可手工删 key=' + up.key + '）'); }
  }
  console.log('');
  const ok = up.ok && up.storage === 's3';
  console.log('结论：' + (ok
    ? '✔ 链路正常——S3 配置齐全、上传/公网读全部可用。若业务接口仍返回原链接，说明该环境跑的是旧代码（未含 cover 收口），或 IMG_INGEST≠mirror。'
    : '✘ 上传未落到 S3（storage=' + up.storage + (up.warned ? '，' + up.warned : '') + '）——按上方 warned 排查。'));
  process.exit(ok ? 0 : 1);
})();
