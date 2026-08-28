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

  // 开发：历史示例密钥任何环境均无效
  process.env.JUZHU_API_KEY = '';
  assert.strictEqual(app.expectedApiKey(), '');
  process.env.JUZHU_API_KEY = 'dev-juzhu-key';
  assert.strictEqual(app.expectedApiKey(), '');
  process.env.JUZHU_API_KEY = 'local-only-change-me';
  assert.strictEqual(app.expectedApiKey(), 'local-only-change-me');

  // --- admin 强制鉴权 ---
  process.env.JUZHU_API_KEY = 'local-only-change-me';
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
      { method: 'POST', headers: { 'x-api-key': 'local-only-change-me' } },
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

  // 登录 HMAC token 可代替 API Key（管理页登录后即可读写）
  const crypto = require('crypto');
  const prevPwd = process.env.JUZHU_ADMIN_PASSWORD;
  process.env.JUZHU_ENV = 'test';
  process.env.JUZHU_ADMIN_PASSWORD = 'dongbo2026';
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = crypto.createHmac('sha256', 'dongbo2026').update(String(exp)).digest('hex');
  res = mockRes();
  assert.strictEqual(
    app.assertAdminAuthorized(
      '/api/juzhu/admin/dictionary',
      { method: 'GET', headers: { authorization: 'Bearer ' + exp + '.' + sig } },
      res
    ),
    true
  );
  if (prevPwd === undefined) delete process.env.JUZHU_ADMIN_PASSWORD;
  else process.env.JUZHU_ADMIN_PASSWORD = prevPwd;

  if (prevEnv === undefined) delete process.env.JUZHU_ENV;
  else process.env.JUZHU_ENV = prevEnv;
  if (prevKey === undefined) delete process.env.JUZHU_API_KEY;
  else process.env.JUZHU_API_KEY = prevKey;

  console.log('OK scripts/test_juzhu_admin_auth.js');
}

run();
