#!/usr/bin/env node
/**
 * scripts/vendor_access_config_regression.cjs —— 商家接入配置（webhook_url / url_link / order_detail_url /
 * hmac_key 一键重置；权限点 vendor.config.write）回归
 *
 * 覆盖：权限矩阵（operator_admin 200 / operator_dispatcher 403 / 匿名 401）→ 读出参不泄露完整钥 →
 *       PUT 三条 URL（落库 / 汇总位 / 校验 400 / 空串清除 / 拒收 hmac_key）→ 一键重置（一次性返回 + 审计脱敏）→
 *       缓存失效硬证明（rotate 后不重启进程：旧钥 401、新钥 200）→ webhook-test（SSRF 拦内网）→ config-history
 *
 * 用法：node scripts/vendor_access_config_regression.cjs [base_url]   # 默认 http://127.0.0.1:8766
 * 凭证只读环境变量（MYSQL_* / JUZHU_DB_* / juzhu/.env.local），禁止写入仓库。
 */
'use strict';

const fs = require('fs');
const path = require('path');
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
const mysql = require('mysql2/promise');

const BASE = (process.argv[2] || process.env.JUZHU_REG_BASE || 'http://127.0.0.1:8766').replace(/\/+$/, '');
const RUN = 'vac' + process.pid;

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  if (!cond) failed++;
}

async function connectDb() {
  const g = (ks, dflt) => {
    for (const k of ks) { const v = (process.env[k] || '').trim(); if (v) return v; }
    return dflt;
  };
  return mysql.createConnection({
    host: g(['MYSQL_HOST', 'JUZHU_DB_HOST'], '127.0.0.1'),
    port: parseInt(g(['MYSQL_PORT', 'JUZHU_DB_PORT'], '3306'), 10),
    user: g(['MYSQL_USER', 'JUZHU_DB_USER'], ''),
    password: process.env.MYSQL_PASSWORD ?? process.env.JUZHU_DB_PASSWORD ?? '',
    database: g(['MYSQL_DB', 'JUZHU_DB_NAME'], ''),
    connectTimeout: 8000,
  });
}

async function api(path, opts) {
  opts = opts || {};
  const r = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch (_) { /* ignore */ }
  return { status: r.status, j };
}

/** 完整 64 位 hex 密钥是否出现在文本里（出参 / 审计脱敏断言用） */
function leaksFullKey(text) {
  return /[0-9a-f]{64}/i.test(String(text || ''));
}

(async () => {
  const conn = await connectDb();
  if (!conn.config.database) throw new Error('MYSQL_*/JUZHU_DB_* env 不完整');

  // ── 准备：管理员（operator_admin，含 vendor.config.write）+ 无权限对照 + 商家 ──
  const adminLogin = await api('/api/auth/login', { method: 'POST', body: { login_name: 'staff_admin', password: 'staff-admin-2026' } });
  const adminTok = adminLogin.j && adminLogin.j.token;
  check('staff_admin 登录', adminLogin.status === 200 && !!adminTok, JSON.stringify(adminLogin.j).slice(0, 100));
  const dispLogin = await api('/api/auth/login', { method: 'POST', body: { login_name: 'staff_disp', password: 'staff-disp-2026' } });
  const dispTok = dispLogin.j && dispLogin.j.token;
  const AH = { Authorization: 'Bearer ' + adminTok };
  const DH = dispTok ? { Authorization: 'Bearer ' + dispTok } : {};

  const [vrows] = await conn.execute(
    "SELECT id, name, webhook_url, url_link, order_detail_url, hmac_key FROM jz_vendors WHERE hmac_key IS NOT NULL AND hmac_key <> '' AND status='active' ORDER BY id");
  const vendor = vrows[0];   // 任意配置了 hmac_key 的在营商家即可
  if (!vendor) throw new Error('库中无可用 vendor（先在 jz_vendors 配置 hmac_key）');
  console.log(`vendor: #${vendor.id} ${vendor.name}\n`);
  const vid = vendor.id;
  const saved = {
    webhook_url: vendor.webhook_url,
    url_link: vendor.url_link,
    order_detail_url: vendor.order_detail_url,
    hmac_key: vendor.hmac_key,
  };
  const oldKey = String(saved.hmac_key).trim();
  const sign = (payload) => {
    const hmac = require('../hmac_auth.cjs');
    return hmac.generateSignature(oldKey, Object.assign({ vendor_id: vid }, payload));
  };

  try {
    // ── 1. 权限矩阵 ──
    let r = await api('/api/juzhu/admin/vendors/config', { headers: AH });
    check('GET /config 200（operator_admin）', r.status === 200 && Array.isArray(r.j.items), JSON.stringify(r.j).slice(0, 120));
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config', { headers: AH });
    check('GET :id/config 200', r.status === 200 && r.j.vendor && r.j.vendor.id === vid, JSON.stringify(r.j).slice(0, 140));
    r = await api('/api/juzhu/admin/vendors/config');
    check('匿名 401', r.status === 401, 'HTTP ' + r.status);
    if (dispTok) {
      let d = await api('/api/juzhu/admin/vendors/config', { headers: DH });
      check('operator_dispatcher 汇总 403', d.status === 403, JSON.stringify(d.j).slice(0, 100));
      d = await api('/api/juzhu/admin/vendors/' + vid + '/config', { headers: DH });
      check('operator_dispatcher 详情 403', d.status === 403, JSON.stringify(d.j).slice(0, 100));
      d = await api('/api/juzhu/admin/vendors/' + vid + '/config', { method: 'PUT', headers: DH, body: { url_link: 'https://x.example.com' } });
      check('operator_dispatcher 写 403', d.status === 403, JSON.stringify(d.j).slice(0, 100));
      d = await api('/api/juzhu/admin/vendors/' + vid + '/config/hmac-key/rotate', { method: 'POST', headers: DH });
      check('operator_dispatcher rotate 403', d.status === 403, JSON.stringify(d.j).slice(0, 100));
    } else {
      console.log('— staff_disp 不可用，跳过权限负例');
    }

    // ── 2. 读出参脱敏：只有 head + 长度，绝无完整钥 ──
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config', { headers: AH });
    const vj = r.j.vendor;
    check('详情不含 hmac_key 字段', vj.hmac_key === undefined, JSON.stringify(Object.keys(vj)));
    check('详情带 head + len', vj.has_hmac_key === 1 && typeof vj.hmac_key_head === 'string' && vj.hmac_key_head.length === 8, JSON.stringify(vj).slice(0, 160));
    check('详情无完整钥（64 hex 不出现）', !leaksFullKey(JSON.stringify(r.j)), JSON.stringify(vj).slice(0, 160));
    r = await api('/api/juzhu/admin/vendors/config', { headers: AH });
    const item = (r.j.items || []).filter((x) => x.id === vid)[0];
    check('汇总带布尔位且无完整钥', !!item && item.has_hmac_key === 1 && 'webhook_url_set' in item && !leaksFullKey(JSON.stringify(r.j)), JSON.stringify(item || {}).slice(0, 160));

    // ── 3. PUT 三条 URL：写入 / 汇总位 / 校验 / 清除 / 拒收密钥 ──
    const newLink = 'https://vac-regress.example.com/generate/urllink';
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config', { method: 'PUT', headers: AH, body: { url_link: newLink } });
    check('PUT url_link → 200 回显', r.status === 200 && r.j.vendor.url_link === newLink, JSON.stringify(r.j).slice(0, 140));
    const [db1] = await conn.execute('SELECT url_link FROM jz_vendors WHERE id=?', [vid]);
    check('url_link 落库', db1[0].url_link === newLink, JSON.stringify(db1[0]));
    r = await api('/api/juzhu/admin/vendors/config', { headers: AH });
    check('汇总位 url_link_set 翻转', (r.j.items.filter((x) => x.id === vid)[0] || {}).url_link_set === 1, JSON.stringify(r.j).slice(0, 100));

    r = await api('/api/juzhu/admin/vendors/' + vid + '/config', { method: 'PUT', headers: AH, body: { webhook_url: 'ftp://x.example.com' } });
    check('非 http(s) 400', r.status === 400, JSON.stringify(r.j));
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config', { method: 'PUT', headers: AH, body: { webhook_url: 'https://' + 'a'.repeat(500) + '.com' } });
    check('webhook_url 超 500 400', r.status === 400, JSON.stringify(r.j).slice(0, 120));
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config', { method: 'PUT', headers: AH, body: { hmac_key: 'deadbeef'.repeat(8) } });
    check('hmac_key 手工录入 400', r.status === 400 && /rotate/.test(r.j.error || ''), JSON.stringify(r.j));
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config', { method: 'PUT', headers: AH, body: { hmac_key_rotate: true } });
    check('PUT 带 rotate 字段 400', r.status === 400, JSON.stringify(r.j));
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config', { method: 'PUT', headers: AH, body: {} });
    check('空 body 400', r.status === 400, JSON.stringify(r.j));

    r = await api('/api/juzhu/admin/vendors/' + vid + '/config', { method: 'PUT', headers: AH, body: { order_detail_url: '' } });
    check('空串 = 清除', r.status === 200, JSON.stringify(r.j).slice(0, 100));
    const [db2] = await conn.execute('SELECT order_detail_url FROM jz_vendors WHERE id=?', [vid]);
    check('清除后 NULL', db2[0].order_detail_url === null, JSON.stringify(db2[0]));
    const [notFound] = [await api('/api/juzhu/admin/vendors/99999999/config', { headers: AH })];
    check('不存在商家 404', notFound.status === 404, 'HTTP ' + notFound.status);

    // ── 4. 缓存失效硬证明（不重启进程）：rotate 后旧钥 401、新钥 200 ──
    const hmacCall = (key) => fetch(BASE + '/api/juzhu/housing/vendor/bookings/list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(require('../hmac_auth.cjs').generateSignature(key, { vendor_id: vid })),
    });
    let hr = await hmacCall(oldKey);
    check('rotate 前旧钥可用（开放接口 200）', hr.status === 200, 'HTTP ' + hr.status);
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config/hmac-key/rotate', { method: 'POST', headers: AH });
    const newKey = r.j && r.j.hmac_key;
    check('rotate → 200 一次性返回 64 位 hex', r.status === 200 && typeof newKey === 'string' && /^[0-9a-f]{64}$/.test(newKey), JSON.stringify(r.j).slice(0, 100));
    hr = await hmacCall(oldKey);
    check('rotate 后旧钥 401（旧钥作废）', hr.status === 401, 'HTTP ' + hr.status);
    hr = await hmacCall(newKey);
    check('rotate 后新钥 200（进程缓存已失效重读，未重启）', hr.status === 200, 'HTTP ' + hr.status);
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config', { headers: AH });
    check('rotate 后读接口只剩新 head', r.j.vendor.hmac_key_head === newKey.slice(0, 8) && !leaksFullKey(JSON.stringify(r.j)), JSON.stringify(r.j.vendor).slice(0, 120));

    // ── 5. 审计脱敏（DB 直查）──
    const [arows] = await conn.execute(
      "SELECT before_json, after_json FROM audit_log WHERE action='vendor.hmac_key.rotate' AND resource_id=? ORDER BY id DESC LIMIT 1",
      [String(vid)]);
    check('rotate 审计不落明文钥', arows.length > 0 && !leaksFullKey(arows[0].before_json) && !leaksFullKey(arows[0].after_json), JSON.stringify(arows[0] || {}));
    check('rotate 审计带 rotated + head', arows.length > 0 && JSON.parse(arows[0].after_json).hmac_key.rotated === true
      && JSON.parse(arows[0].after_json).hmac_key.head === newKey.slice(0, 8), JSON.stringify(arows[0] || {}).slice(0, 160));
    const [crows] = await conn.execute(
      "SELECT before_json, after_json FROM audit_log WHERE action='vendor.config.update' AND resource_id=? ORDER BY id DESC LIMIT 1",
      [String(vid)]);
    check('config 审计 before/after 均有 url_link', crows.length > 0
      && JSON.parse(crows[0].before_json).url_link !== undefined
      && JSON.parse(crows[0].after_json).url_link === newLink, JSON.stringify(crows[0] || {}).slice(0, 200));

    // ── 6. webhook-test：未配 400 → 内网地址被 SSRF 层拒（ok:false，不出网）→ 审计 fail ──
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config', { method: 'PUT', headers: AH, body: { webhook_url: '' } });
    check('清除回调 200', r.status === 200, JSON.stringify(r.j).slice(0, 100));
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config/webhook-test', { method: 'POST', headers: AH });
    check('未配回调 400', r.status === 400 && /webhook_url/.test(r.j.error || ''), JSON.stringify(r.j));
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config', { method: 'PUT', headers: AH, body: { webhook_url: 'http://127.0.0.1:9/vac-hook' } });
    check('预置内网回调 200', r.status === 200, JSON.stringify(r.j).slice(0, 100));
    r = await api('/api/juzhu/admin/vendors/' + vid + '/config/webhook-test', { method: 'POST', headers: AH });
    check('内网目标被拒（ok:false，非 5xx）', r.status === 200 && r.j.ok === false, JSON.stringify(r.j).slice(0, 140));
    const [trows] = await conn.execute(
      "SELECT result, after_json FROM audit_log WHERE action='vendor.webhook.test' AND resource_id=? ORDER BY id DESC LIMIT 1",
      [String(vid)]);
    check('webhook.test 审计 result=fail', trows.length > 0 && trows[0].result === 'fail', JSON.stringify(trows[0] || {}).slice(0, 140));

    // ── 7. config-history（含 vendor_id 过滤）──
    r = await api('/api/juzhu/admin/vendors/config-history?vendor_id=' + vid, { headers: AH });
    const acts = (r.j.items || []).map((x) => x.action);
    check('历史含三种 action', r.status === 200 && acts.includes('vendor.config.update')
      && acts.includes('vendor.hmac_key.rotate') && acts.includes('vendor.webhook.test'), JSON.stringify(acts));
    r = await api('/api/juzhu/admin/vendors/config-history', { headers: AH });
    check('历史全量 200', r.status === 200 && Array.isArray(r.j.items), 'HTTP ' + r.status);
  } finally {
    // ── 清理：商家接入配置原值还原（密钥 / 三条 URL）──
    await conn.execute(
      'UPDATE jz_vendors SET webhook_url=?, url_link=?, order_detail_url=?, hmac_key=? WHERE id=?',
      [saved.webhook_url, saved.url_link, saved.order_detail_url, saved.hmac_key, vid]);
    await conn.end();
    console.log('\ncleanup done（商家 webhook_url / url_link / order_detail_url / hmac_key 原值已还原；审计留痕保留）');
  }

  console.log(failed ? `\n${failed} 项 FAIL` : '\n全部 PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL:', e.message, '\n', (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
