#!/usr/bin/env node
/**
 * 单元验收：admin 鉴权 + 静态敏感/文档拦截（不启服务、不连库）
 */
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const app = require(path.join(ROOT, 'app.js'));

function mockRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code; },
    end(buf) { this.body = buf ? String(buf) : ''; },
  };
}

function run() {
  const prevEnv = process.env.JUZHU_ENV;
  const prevKey = process.env.JUZHU_API_KEY;

  // --- 静态：API 文档与敏感文件 ---
  assert.strictEqual(app.isPublicStatic('/docs/api-document.html'), false);
  assert.strictEqual(app.isPublicStatic('/api_doc.md'), false);
  assert.strictEqual(app.isPublicStatic('/.env'), false);
  assert.strictEqual(app.isPublicStatic('/juzhu/server.py'), false);
  assert.strictEqual(app.isPublicStatic('/index.html'), true);

  process.env.JUZHU_ENV = 'production';
  assert.strictEqual(app.isPublicStatic('/docs/tp-sign-and-call.md'), false);
  assert.strictEqual(app.isPublicStatic('/docs/anything.html'), false);

  // 生产：.env 里即使写了开发示例密钥也无效
  process.env.JUZHU_API_KEY = 'dev-juzhu-key';
  assert.strictEqual(app.expectedApiKey(), '');

  process.env.JUZHU_ENV = 'dev';

  // 开发：密钥只来自 .env；示例值可用
  process.env.JUZHU_API_KEY = '';
  assert.strictEqual(app.expectedApiKey(), '');
  process.env.JUZHU_API_KEY = 'dev-juzhu-key';
  assert.strictEqual(app.expectedApiKey(), 'dev-juzhu-key');

  // --- admin 强制鉴权 ---
  process.env.JUZHU_API_KEY = 'dev-juzhu-key';
  let res = mockRes();
  assert.strictEqual(
    app.assertAdminAuthorized('/api/juzhu/admin/districts', { method: 'POST', headers: {} }, res),
    false
  );
  assert.strictEqual(res.statusCode, 401);

  res = mockRes();
  assert.strictEqual(
    app.assertAdminAuthorized(
      '/api/juzhu/admin/districts',
      { method: 'POST', headers: { 'x-api-key': 'dev-juzhu-key' } },
      res
    ),
    true
  );

  res = mockRes();
  assert.strictEqual(
    app.assertAdminAuthorized(
      '/api/juzhu/admin/settings',
      { method: 'PUT', headers: { authorization: 'Bearer wrong-key' } },
      res
    ),
    false
  );
  assert.strictEqual(res.statusCode, 401);

  // 公开路径不挡
  res = mockRes();
  assert.strictEqual(
    app.assertAdminAuthorized('/api/juzhu/districts', { method: 'GET', headers: {} }, res),
    true
  );

  // auth 豁免
  res = mockRes();
  assert.strictEqual(
    app.assertAdminAuthorized('/api/juzhu/admin/auth/login', { method: 'POST', headers: {} }, res),
    true
  );

  if (prevEnv === undefined) delete process.env.JUZHU_ENV;
  else process.env.JUZHU_ENV = prevEnv;
  if (prevKey === undefined) delete process.env.JUZHU_API_KEY;
  else process.env.JUZHU_API_KEY = prevKey;

  console.log('OK scripts/test_juzhu_admin_auth.js');
}

run();
