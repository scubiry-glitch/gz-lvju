#!/usr/bin/env node
'use strict';
/** 首页加载：lite catalog + 连接池 + settings 去重 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const clientJs = fs.readFileSync(path.join(__dirname, 'juzhu/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function testMysqlPool() {
  assert.match(appJs, /createPool/, 'queryRows 必须走 mysql2 连接池，禁止每次 SQL 新建连接');
  assert.match(appJs, /async function queryRows/, 'queryRows 仍应存在');
  assert.ok(!/async function queryRows[\s\S]{0,200}createConnection/.test(appJs),
    'queryRows 不得再 createConnection');
  console.log('[PASS] testMysqlPool');
}

function testLiteCatalogSkipsUnits() {
  assert.match(appJs, /lite = qp\.get\('lite'\)/, 'catalog 须识别 lite 参数');
  assert.match(appJs, /if \(!lite && projectIds\.length\)/, 'lite 时不得查 units');
  console.log('[PASS] testLiteCatalogSkipsUnits');
}

function testSchemaSingleFlight() {
  assert.match(appJs, /schemaPromise/, '冷启动并发请求必须单飞 ensureSchema');
  console.log('[PASS] testSchemaSingleFlight');
}

function testClientLiteAndSettingsDedupe() {
  assert.match(clientJs, /if \(lite\) parts\.push\('lite=1'\)/, '客户端 lite 须带 lite=1');
  assert.match(clientJs, /if \(_settingsP\) return _settingsP/, 'loadSettings 须复用进行中的请求');
  assert.match(html, /JUZHU\.load\(\{\s*lite:\s*true\s*\}\)/, '首页首屏必须请求 lite catalog');
  assert.ok(!html.includes("fetch('/api/juzhu/settings')"),
    '首页不得再单独 fetch settings，应走 JUZHU.loadSettings');
  console.log('[PASS] testClientLiteAndSettingsDedupe');
}

testMysqlPool();
testLiteCatalogSkipsUnits();
testSchemaSingleFlight();
testClientLiteAndSettingsDedupe();
console.log('ok: home perf');
