/**
 * s3_client.cjs —— 贝壳 ODS 对象存储（S3 兼容）客户端
 *
 * 设计约束（对齐 CLAUDE.md 规则 12/14）：
 *   - 只用 Node，**不引入任何新依赖**（node:crypto + 全局 fetch，Node 22+）
 *   - 纯函数式签名，不连库、不依赖 express 等框架
 *
 * 支持两种签名（接入规范要求 V4，V2 作为兼容保留，用 S3_SIGN_VERSION 切换）：
 *   - v4：AWS Signature Version 4（AWS4-HMAC-SHA256），需要 region（S3_REGION，缺省 us-east-1）。**缺省**
 *   - v2：AWS Signature Version 2（Authorization: AWS <ak>:<base64(hmac-sha1)>），不需要 region
 *
 * 寻址：默认 path-style（https://<endpoint>/<bucket>/<key>），可用 S3_ADDRESSING=virtual 切虚拟主机风格
 * （<bucket>.<endpoint>）。实测（2026-09-21）：本网络下 <bucket>.ods.lianjia.com 域名可解析但端口不通，
 * 故缺省 path；网关放开后改一个环境变量即可。
 *
 * V4 实现要点（踩过的坑，改动勿回退）：
 *   - canonical URI 必须是**URL 实际路径**（virtual→/key，path→/bucket/key）
 *   - `host` **必须**参与签名；`content-length` 不签（由运行时按 body 生成）
 *
 * 环境变量（测试环境示例值见 juzhu/.env.example）：
 *   S3_ACCESS_KEY / S3_SECRET_KEY / S3_ENDPOINT / S3_FILE_ENDPOINT / S3_BUCKET
 *   S3_SIGN_VERSION=v4|v2（缺省 v4）  S3_REGION=us-east-1  S3_ADDRESSING=path|virtual
 *   S3_KEY_PREFIX=（对象 key 前缀，本环境 lvju）  S3_FILE_STYLE=bucket|path（读图 URL 是否带 bucket）
 *   S3_EXTRA_HEADERS=JSON（缺省 {"x-amz-acl":"public-read"}）  S3_TIMEOUT_MS=20000
 */
'use strict';

const crypto = require('crypto');

// ── 配置 ──────────────────────────────────────────────────────
function env(name, dflt) {
  const v = process.env[name];
  return v == null || String(v).trim() === '' ? dflt : String(v).trim();
}

function config() {
  return {
    accessKey: env('S3_ACCESS_KEY', ''),
    secretKey: env('S3_SECRET_KEY', ''),
    endpoint: env('S3_ENDPOINT', '').replace(/\/+$/, ''),
    fileEndpoint: env('S3_FILE_ENDPOINT', '').replace(/\/+$/, ''),
    bucket: env('S3_BUCKET', ''),
    // 接入规范要求 V4；实测本环境 V4 可用（V2 亦可用，作为兼容开关保留）
    signVersion: env('S3_SIGN_VERSION', 'v4').toLowerCase(),
    region: env('S3_REGION', 'us-east-1'),
    addressing: env('S3_ADDRESSING', 'path').toLowerCase(),
    keyPrefix: env('S3_KEY_PREFIX', '').replace(/^\/+|\/+$/g, ''),
    // 实测（2026-09-21，ods.lianjia.com / file.ljcdn.com / bucket=test）：
    //   读图必须带上 bucket —— https://file.ljcdn.com/test/<key> = 200
    //   不带 bucket 会 403 «指令不匹配 (CommandNotMatch): 未申请对应服务: bucket: <首段>»
    // 故缺省 fileStyle=bucket；若环境给的是「每 bucket 一个文件域」则设 path。
    fileStyle: env('S3_FILE_STYLE', 'bucket').toLowerCase(),
    timeoutMs: parseInt(env('S3_TIMEOUT_MS', '20000'), 10) || 20000,
    // 每次请求附带的自定义头（JSON，参与签名）；变更即时生效（带缓存键比）
    extraHeadersRaw: env('S3_EXTRA_HEADERS', '{"x-amz-acl":"public-read"}'),
  };
}

/** 是否已配置到可用的程度（上传/读取的前提） */
function isConfigured() {
  const c = config();
  return !!(c.accessKey && c.secretKey && c.endpoint && c.bucket);
}

// ── 工具 ──────────────────────────────────────────────────────
/** 路径段编码（保留 /），SigV4 canonical URI 与真实 URL 都用它 */
function encodeKey(key) {
  return String(key || '')
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest(encoding);
}

function hmacSha1Base64(key, data) {
  return crypto.createHmac('sha1', key).update(data, 'utf8').digest('base64');
}

/** 把「对象 key」归一化：允许以 s3:// 开头、允许带前导 / */
function normalizeKey(key) {
  return String(key || '').replace(/^s3:\/\//i, '').replace(/^\/+/, '');
}

function looksLikeUrl(p) {
  return /^https?:\/\//i.test(String(p || ''));
}

// ── 时间戳 ────────────────────────────────────────────────────
function amzDate(now) {
  const d = now || new Date();
  const iso = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amz: iso, short: iso.slice(0, 8) };
}

function rfc1123(now) {
  return (now || new Date()).toUTCString();
}

// ── 地址拼装 ──────────────────────────────────────────────────
function objectUrl(key, cfg) {
  const c = cfg || config();
  const k = normalizeKey(key);
  if (c.addressing === 'virtual') {
    return `${c.endpoint.replace('://', '://' + c.bucket + '.')}/${encodeKey(k)}`;
  }
  return `${c.endpoint}/${c.bucket}/${encodeKey(k)}`;
}

/**
 * 对外可访问地址（读图用）：
 *   S3_FILE_STYLE=bucket → https://file.ljcdn.com/<bucket>/<key>（本环境实测有效，缺省）
 *   S3_FILE_STYLE=path   → https://file.ljcdn.com/<key>
 * 未配置 file-endpoint 时回落 endpoint（开发环境可用）
 * 若 S3_FILE_ENDPOINT 本身已含 bucket（如 https://file.ljcdn.com/test），请配 S3_FILE_STYLE=path。
 */
function publicUrl(key, cfg) {
  const c = cfg || config();
  const k = normalizeKey(key);
  const base = c.fileEndpoint || c.endpoint;
  if (!base) return k;
  return c.fileStyle === 'bucket' ? `${base}/${c.bucket}/${encodeKey(k)}` : `${base}/${encodeKey(k)}`;
}

// ── 子资源（SigV2 CanonicalizedResource 需要） ────────────────
const SUB_RESOURCES = new Set([
  'acl', 'cors', 'delete', 'lifecycle', 'location', 'logging', 'notification',
  'partNumber', 'policy', 'requestPayment', 'response-cache-control',
  'response-content-disposition', 'response-content-encoding', 'response-content-language',
  'response-content-type', 'response-expires', 'tagging', 'torrent', 'uploadId', 'uploads',
  'versionId', 'versioning', 'versions', 'website', 'object-lock', 'retention', 'legal-hold',
]);

function canonicalizedResource(key, query, cfg) {
  const c = cfg || config();
  const k = normalizeKey(key);
  let res = '/' + c.bucket + (k ? '/' + k : '');
  const parts = [];
  for (const name of Object.keys(query || {}).sort()) {
    if (!SUB_RESOURCES.has(name)) continue;
    const v = query[name];
    parts.push(v == null || v === '' ? name : name + '=' + v);
  }
  return res + (parts.length ? '?' + parts.join('&') : '');
}

function canonicalQuery(query) {
  return Object.keys(query || {}).sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k] == null ? '' : query[k]))
    .join('&');
}

// ── 签名：V2 ──────────────────────────────────────────────────
function signV2(method, key, headers, query, cfg) {
  const c = cfg || config();
  const amzHeaders = Object.keys(headers)
    .filter((h) => h.toLowerCase().startsWith('x-amz-'))
    .map((h) => h.toLowerCase() + ':' + String(headers[h]).trim())
    .sort()
    .map((line) => line + '\n')
    .join('');
  const stringToSign = [
    method,
    headers['Content-MD5'] || '',
    headers['Content-Type'] || '',
    headers['Date'] || '',           // 使用 x-amz-date 时此处为空
    amzHeaders + canonicalizedResource(key, query, c),
  ].join('\n');
  const signature = hmacSha1Base64(c.secretKey, stringToSign);
  return { Authorization: `AWS ${c.accessKey}:${signature}`, __stringToSign: stringToSign };
}

// ── 签名：V4 ──────────────────────────────────────────────────
function v4Scope(c, short) {
  return `${short}/${c.region}/s3/aws4_request`;
}

function v4SigningKey(c, short) {
  return hmac(hmac(hmac(hmac('AWS4' + c.secretKey, short), c.region), 's3'), 'aws4_request');
}

/** 每次请求都要附带的额外头（S3_EXTRA_HEADERS=JSON，如 {"x-amz-acl":"public-read"}） */
let _extraHeadersCache = null;
function extraHeaders(cfg) {
  const c = cfg || config();
  if (_extraHeadersCache && _extraHeadersCache.raw === c.extraHeadersRaw) return _extraHeadersCache.map;
  let map = {};
  if (c.extraHeadersRaw) {
    try {
      const parsed = JSON.parse(c.extraHeadersRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (v != null && v !== '') map[String(k)] = String(v);
      }
    } catch (_) { /* 配置非法则忽略 */ }
  }
  _extraHeadersCache = { raw: c.extraHeadersRaw, map };
  return map;
}

/**
 * AWS Signature V4（S3）
 * - canonical URI 必须是**URL 实际路径**：virtual 寻址 = /<key>，path 寻址 = /<bucket>/<key>
 * - `host` 必须参与签名（AWS/兼容网关均强制）；`content-length` 约定不签（由运行时按 body 生成）
 * @param {string} method
 * @param {string} urlStr  完整请求 URL（含 query），canonical URI/Host 都从它推导
 * @param {object} rawHeaders 需要参与签名的头（不含 host / x-amz-date，函数内补齐）
 * @param {string} payloadHash  正文 sha256 hex（未签名负载用 'UNSIGNED-PAYLOAD'）
 * @param {object} cfg
 * @param {Date} now
 */
function signV4(method, urlStr, rawHeaders, payloadHash, cfg, now) {
  const c = cfg || config();
  const u = new URL(urlStr);
  const { amz, short } = amzDate(now);

  const signable = {};
  for (const [h, v] of Object.entries(rawHeaders || {})) {
    const name = String(h).toLowerCase();
    if (name === 'authorization' || name === 'content-length' || v == null) continue;
    signable[name] = String(v).trim();
  }
  signable.host = u.host;                                  // 必须签
  signable['x-amz-date'] = amz;
  if (payloadHash) signable['x-amz-content-sha256'] = payloadHash;

  const signedHeaderNames = Object.keys(signable).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => h + ':' + signable[h] + '\n').join('');
  const signedHeaders = signedHeaderNames.join(';');

  // URL.pathname 已是百分号编码形态，S3 要求单次编码，直接使用
  const canonicalRequest = [
    method,
    u.pathname || '/',
    u.search ? u.search.slice(1) : '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = v4Scope(c, short);
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(v4SigningKey(c, short), stringToSign, 'hex');

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate: amz,
    signedHeaders,
    __stringToSign: stringToSign,
  };
}

// ── 统一请求 ──────────────────────────────────────────────────
/**
 * @param {string} method   GET/PUT/HEAD/DELETE/POST
 * @param {string} key      对象 key（空 = bucket 级操作）
 * @param {object} opts     { body, contentType, query, headers, timeoutMs, debug }
 * @returns {Promise<{ok:boolean,status:number,headers:object,buffer:Buffer|null,text:string,error?:string,stringToSign?:string}>}
 */
async function request(method, key, opts) {
  const o = opts || {};
  const c = config();
  if (!isConfigured()) return { ok: false, status: 0, headers: {}, buffer: null, text: '', error: 'S3 未配置（缺 S3_ACCESS_KEY/S3_SECRET_KEY/S3_ENDPOINT/S3_BUCKET）' };

  const bodyBuf = o.body == null ? null
    : (Buffer.isBuffer(o.body) ? o.body
      : (typeof o.body === 'string' ? Buffer.from(o.body, 'utf8') : Buffer.from(JSON.stringify(o.body), 'utf8')));

  const query = Object.assign({}, o.query || {});
  const qs = canonicalQuery(query);
  const url = objectUrl(key, c) + (qs ? '?' + qs : '');

  // 实际发送的头：额外头 + 调用方头 + Content-Type（Content-Length 交给运行时按 body 生成，不手动设）
  const headers = Object.assign({}, extraHeaders(c), o.headers || {});
  if (bodyBuf && !headers['Content-Type']) {
    headers['Content-Type'] = o.contentType || 'application/octet-stream';
  } else if (bodyBuf && o.contentType) {
    headers['Content-Type'] = o.contentType;
  }

  let stringToSign = '';
  if (c.signVersion === 'v4') {
    const payloadHash = bodyBuf ? sha256Hex(bodyBuf) : sha256Hex('');
    headers['x-amz-content-sha256'] = payloadHash;
    const signed = signV4(method, url, headers, payloadHash, c, new Date());
    headers['x-amz-date'] = signed.amzDate;      // 必须与实际发送一致（在 SignedHeaders 内）
    headers.Authorization = signed.Authorization;
    stringToSign = signed.__stringToSign;
  } else {
    headers.Date = rfc1123();
    const signed = signV2(method, key, headers, query, c);
    headers.Authorization = signed.Authorization;
    stringToSign = signed.__stringToSign;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs || c.timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body: bodyBuf || undefined, signal: ac.signal });
    const buf = res.status === 204 || method === 'HEAD' ? null : Buffer.from(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      buffer: buf,
      text: buf ? buf.toString('utf8') : '',
      stringToSign: o.debug ? stringToSign : undefined,
    };
  } catch (e) {
    return { ok: false, status: 0, headers: {}, buffer: null, text: '', error: String(e && e.message || e), stringToSign: o.debug ? stringToSign : undefined };
  } finally {
    clearTimeout(timer);
  }
}

// ── 对象操作 ──────────────────────────────────────────────────
function putObject(key, body, opts) {
  return request('PUT', key, Object.assign({}, opts || {}, { body }));
}

async function getObjectBuffer(key, opts) {
  const r = await request('GET', key, opts);
  if (!r.ok) return { ok: false, status: r.status, error: r.error || r.text.slice(0, 300), buffer: null };
  return { ok: true, status: r.status, buffer: r.buffer, contentType: r.headers['content-type'] };
}

function headObject(key, opts) {
  return request('HEAD', key, opts);
}

function deleteObject(key, opts) {
  return request('DELETE', key, opts);
}

function copyObject(fromKey, toKey, opts) {
  const c = config();
  return request('PUT', toKey, Object.assign({}, opts, {
    headers: Object.assign({ 'x-amz-copy-source': `/${c.bucket}/${encodeKey(normalizeKey(fromKey))}` }, (opts || {}).headers || {}),
  }));
}

/** 分片上传（>5MB 的图/视频；part 大小默认 8MB，单 PUT 上限阈值 16MB） */
async function uploadLarge(key, body, opts) {
  const o = opts || {};
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const threshold = o.threshold || 16 * 1024 * 1024;
  const partSize = o.partSize || 8 * 1024 * 1024;
  if (buf.length <= threshold) return putObject(key, buf, o);

  const created = await request('POST', key, { query: { uploads: '' }, contentType: o.contentType });
  if (!created.ok) return { ok: false, status: created.status, error: '初始化分片失败: ' + (created.error || created.text.slice(0, 200)) };
  const uploadId = (created.text.match(/<UploadId>([^<]+)<\/UploadId>/) || [])[1];
  if (!uploadId) return { ok: false, status: created.status, error: '未取到 UploadId' };

  const parts = [];
  try {
    for (let i = 0, n = 1; i < buf.length; i += partSize, n++) {
      const chunk = buf.subarray(i, Math.min(i + partSize, buf.length));
      const up = await request('PUT', key, { body: chunk, query: { partNumber: n, uploadId } });
      if (!up.ok) {
        await request('DELETE', key, { query: { uploadId } });
        return { ok: false, status: up.status, error: `分片 ${n} 上传失败: ` + (up.error || up.text.slice(0, 200)) };
      }
      parts.push(`<Part><PartNumber>${n}</PartNumber><ETag>${up.headers.etag || ''}</ETag></Part>`);
    }
    const bodyXml = `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`;
    const done = await request('POST', key, { body: bodyXml, query: { uploadId }, contentType: 'application/xml' });
    return done;
  } catch (e) {
    await request('DELETE', key, { query: { uploadId } }).catch(() => {});
    return { ok: false, status: 0, error: String(e && e.message || e) };
  }
}

// ── 预签名（前端直传，避免图片经服务端中转） ──────────────────
/**
 * @param {string} key
 * @param {object} opts { method='PUT', expires=900(秒), contentType }
 * @returns {{url:string, method:string, expires:number, headers:object, version:string}}
 */
function presign(key, opts) {
  const o = opts || {};
  const c = config();
  const method = (o.method || 'PUT').toUpperCase();
  const expires = Math.max(1, Math.min(604800, parseInt(o.expires, 10) || 900));
  const k = normalizeKey(key);

  if (c.signVersion === 'v4') {
    const now = new Date();
    const { amz, short } = amzDate(now);
    const scope = v4Scope(c, short);
    const u = new URL(objectUrl(k, c));
    const query = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${c.accessKey}/${scope}`,
      'X-Amz-Date': amz,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': 'host',
    };
    // 预签名只签 host（canonical URI 用实际路径：virtual→/<key>，path→/<bucket>/<key>）
    const canonicalRequest = [
      method,
      u.pathname,
      canonicalQuery(query),
      `host:${u.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(canonicalRequest)].join('\n');
    query['X-Amz-Signature'] = hmac(v4SigningKey(c, short), stringToSign, 'hex');
    return { url: u.origin + u.pathname + '?' + canonicalQuery(query), method, expires, headers: {}, version: 'v4' };
  }

  const expiresAt = Math.floor(Date.now() / 1000) + expires;
  const query = { AWSAccessKeyId: c.accessKey, Expires: String(expiresAt) };
  const headers = { Date: String(expiresAt), 'Content-Type': o.contentType || '' };
  const signed = signV2(method, k, headers, query, c);
  const sig = signed.Authorization.split(':').slice(1).join(':');
  const url = objectUrl(k, c) + '?' + canonicalQuery(query) + '&Signature=' + encodeURIComponent(sig);
  return { url, method, expires, headers: o.contentType ? { 'Content-Type': o.contentType } : {}, version: 'v2' };
}

// ── 自检/探测 ─────────────────────────────────────────────────
/**
 * 探测哪种签名可用：对每个候选版本做一次「PUT 探针对象 → HEAD 校验 → DELETE」。
 * 注意：不要用 bucket 级 HEAD/GET 探测——那需要 ListBucket 权限，正常业务账号会 403。
 */
async function detectSignVersion(probePrefix) {
  const saved = process.env.S3_SIGN_VERSION;
  const results = {};
  const key = `${probePrefix || 'smoke'}/.probe/${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`;
  const probeBody = Buffer.from('lianjia-ods-probe');
  for (const v of ['v2', 'v4']) {
    process.env.S3_SIGN_VERSION = v;
    try {
      // eslint-disable-next-line no-await-in-loop
      const put = await request('PUT', key, { body: probeBody, contentType: 'text/plain' });
      let readBack = null;
      if (put.ok) {
        // eslint-disable-next-line no-await-in-loop
        const got = await request('GET', key, {});
        readBack = { status: got.status, bytes: got.buffer ? got.buffer.length : 0 };
        // eslint-disable-next-line no-await-in-loop
        await request('DELETE', key, {});
      }
      results[v] = {
        status: put.status,
        ok: !!(put.ok && readBack && readBack.bytes === probeBody.length),
        etag: put.headers && put.headers.etag,
        readBack,
        error: put.error || (put.ok ? (readBack && readBack.bytes !== probeBody.length ? '写入字节与探针不一致' : '') : (put.text || '').slice(0, 200)),
      };
    } catch (e) {
      results[v] = { status: 0, ok: false, error: String(e && e.message || e) };
    }
  }
  if (saved == null) delete process.env.S3_SIGN_VERSION; else process.env.S3_SIGN_VERSION = saved;
  return results;
}

module.exports = {
  config,
  isConfigured,
  encodeKey,
  normalizeKey,
  looksLikeUrl,
  objectUrl,
  publicUrl,
  request,
  putObject,
  uploadLarge,
  getObjectBuffer,
  headObject,
  deleteObject,
  copyObject,
  presign,
  detectSignVersion,
  signV2,
  signV4,
  _internals: { canonicalizedResource, canonicalQuery, sha256Hex },
};
