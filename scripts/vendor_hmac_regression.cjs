#!/usr/bin/env node
/**
 * scripts/vendor_hmac_regression.cjs —— 商家开放接口 HMAC 回归（Node 版，替代 test_vendor_api.py）
 *
 * 用库里真实 vendor 的 hmac_key 对只读端点（cities/categories/skus/products list）
 * 走完整 HTTP 签名链路；另验一条「错误签名必须被拒」。
 * 用法：node scripts/vendor_hmac_regression.cjs [base_url]   # 默认 http://127.0.0.1:8766
 * 连接配置走 MYSQL_* / JUZHU_DB_* 环境变量（同 app.js），禁止写入凭证。
 */
'use strict';

const hmac = require('../hmac_auth.cjs');

const BASE = (process.argv[2] || process.env.JUZHU_REG_BASE || 'http://127.0.0.1:8766').replace(/\/+$/, '');
const READ_PATHS = [
  '/api/juzhu/jiazheng/vendor/cities/list',
  '/api/juzhu/jiazheng/vendor/categories/list',
  '/api/juzhu/jiazheng/vendor/skus/list',
  '/api/juzhu/jiazheng/vendor/products/list',
];

async function pickVendor() {
  const mysql = require('mysql2/promise');
  const host = (process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '').trim();
  const db = (process.env.MYSQL_DB || process.env.JUZHU_DB_NAME || '').trim();
  const user = (process.env.MYSQL_USER || process.env.JUZHU_DB_USER || '').trim();
  const password = process.env.MYSQL_PASSWORD ?? process.env.JUZHU_DB_PASSWORD;
  const port = parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10);
  if (!host || !db || !user || password == null || password === '') {
    throw new Error('MYSQL_* env 不完整');
  }
  const conn = await (async () => {
    // 远程链路偶发抖动：重试 3 次
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const c = await mysql.createConnection({ host, port, database: db, user, password, connectTimeout: 8000 });
        return c;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
    throw lastErr;
  })();
  const [rows] = await conn.execute(
    "SELECT id, name, hmac_key FROM jz_vendors WHERE hmac_key IS NOT NULL AND hmac_key <> '' AND status='active' ORDER BY id LIMIT 1"
  );
  await conn.end();
  if (!rows.length) throw new Error('库中无可用 vendor hmac_key');
  return rows[0];
}

function post(path, payload) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(async (r) => ({ status: r.status, text: (await r.text()).slice(0, 160) }));
}

(async () => {
  const vendor = await pickVendor();
  console.log(`vendor: #${vendor.id} ${vendor.name}`);
  let failed = 0;

  for (const p of READ_PATHS) {
    const signed = hmac.generateSignature(vendor.hmac_key, { vendor_id: vendor.id });
    const r = await post(p, signed);
    const ok = r.status === 200;
    console.log(`${ok ? 'PASS' : 'FAIL'}  POST ${p} → ${r.status} ${ok ? '' : r.text}`);
    if (!ok) failed++;
  }

  // 负例：篡改签名必须被拒
  const bad = hmac.generateSignature(vendor.hmac_key, {});
  bad.sign = 'deadbeef'.repeat(8);
  const rb = await post('/api/juzhu/jiazheng/vendor/skus/list', bad);
  const rejected = rb.status === 401 || rb.status === 403;
  console.log(`${rejected ? 'PASS' : 'FAIL'}  错误签名被拒 → ${rb.status} ${rejected ? '' : rb.text}`);
  if (!rejected) failed++;

  console.log(failed === 0 ? '\nHMAC 回归全部通过' : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('回归脚本异常:', e.message);
  process.exit(2);
});
