#!/usr/bin/env node
'use strict';
/** 首页首屏不得先露出占位 tab / 空选区租房，再等 catalog 回来抖一下 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function testBootClassOnApp() {
  assert.match(html, /class="app[^"]*\bis-booting\b/, '首屏 .app 必须带 is-booting，避免画出未灌数据的壳');
  console.log('[PASS] testBootClassOnApp');
}

function testBootCssHidesIncompleteShell() {
  assert.match(html, /\.app\.is-booting[\s\S]*?\.pane[\s\S]*?display\s*:\s*none/,
    'booting 时必须 display:none 掉 .pane，空的「选区租房」不能占布局');
  assert.match(html, /\.app\.is-booting[\s\S]*?\.split-hd \.in[\s\S]*?(visibility\s*:\s*hidden|opacity\s*:\s*0)/,
    'booting 时必须藏起 hero 文案和 3 个占位 tab');
  console.log('[PASS] testBootCssHidesIncompleteShell');
}

function testRevealAfterCatalogPaint() {
  const reveal = html.includes("classList.remove('is-booting')")
    || html.includes('classList.remove("is-booting")');
  assert.ok(reveal, 'catalog 渲染后必须摘掉 is-booting');
  const loadIdx = html.indexOf('Promise.all([JUZHU.load({ lite: true })');
  assert.ok(loadIdx > 0, '应在 JUZHU.load({ lite: true }) 完成后揭开首屏');
  const afterLoad = html.slice(loadIdx);
  assert.ok(
    afterLoad.includes("classList.remove('is-booting')")
      || afterLoad.includes('classList.remove("is-booting")')
      || afterLoad.includes('revealHome()'),
    '揭开首屏必须发生在 catalog 回调里，不能在 fetch 之前'
  );
  console.log('[PASS] testRevealAfterCatalogPaint');
}

testBootClassOnApp();
testBootCssHidesIncompleteShell();
testRevealAfterCatalogPaint();
console.log('ok: index boot shell');
