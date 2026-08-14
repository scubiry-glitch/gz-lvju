#!/usr/bin/env node
'use strict';
/** 与 juzhu/server.py is_public_static 对齐的 Node 拦截 / 鉴权单测 */
const {
  isPublicStatic,
  expectedApiKey,
  FORBIDDEN_API_KEY,
} = require('./app.js');

function assertBlock(p) {
  if (isPublicStatic(p)) throw new Error('should block ' + p);
}
function assertAllow(p) {
  if (!isPublicStatic(p)) throw new Error('should allow ' + p);
}

[
  '/.env',
  '/.env.prod',
  '/package.json',
  '/.gitignore',
  '/README.md',
  '/api_doc.md',
  '/docs/api-document.html',
  '/docs/tp-sign-and-call.md',
  '/docs/xjz-api.html',
  '/juzhu/server.py',
  '/app.js',
  '/scf_bootstrap',
  '/moma_deploy.js',
  '/migrate_to_mysql.cjs',
  '/vendor_api.cjs',
  '/node_modules/mysql2/index.js',
].forEach(assertBlock);

[
  '/',
  '/index.html',
  '/juzhu/app.js',
  '/juzhu/cities.json',
  '/juzhu/data.json',
  '/juzhu-admin.html',
  '/juzhu-amdin.html',
  '/screens/p-jz-product.html',
].forEach(assertAllow);

const oldEnv = process.env.JUZHU_ENV;
const oldKey = process.env.JUZHU_API_KEY;
process.env.JUZHU_ENV = 'production';
assertBlock('/docs/anything.html');
if (oldEnv === undefined) delete process.env.JUZHU_ENV;
else process.env.JUZHU_ENV = oldEnv;

process.env.JUZHU_API_KEY = FORBIDDEN_API_KEY;
if (expectedApiKey() !== '') throw new Error('forbidden key must be rejected');
process.env.JUZHU_API_KEY = 'unit-test-only-key';
if (expectedApiKey() !== 'unit-test-only-key') throw new Error('explicit key must work');
if (oldKey === undefined) delete process.env.JUZHU_API_KEY;
else process.env.JUZHU_API_KEY = oldKey;

console.log('ok: node static guard + api key policy');
