#!/usr/bin/env node
// ⚠️ 一次性数据修复脚本（2026-09-03 金额单位 bug）：勿重复执行！
// 背景：vendor 开放接口此前未做「分→元」换算，商家按 api_doc.md 传「分」被原样存入
//      jz_products.price（库内约定为「元」）。vendor_api.cjs 已修复为边界换算，
//      本脚本将存量「分」单位数据 ÷100 修正为「元」。
// 范围：仅 vendor 41（来来）/ 42（蓝犀牛）经商家 API 创建的商品（测试库无平台种子商品）。
// 回滚：修复前旧值已在会话留档；如需回滚将 price/original_price ×100 即可。
// 用法：node assets/_scratch/fix_jz_product_price_to_yuan.cjs [--dry]
'use strict';
const fs = require('fs');
const path = require('path');

const dry = process.argv.includes('--dry');
const envPath = path.resolve(__dirname, '../../juzhu/.env');
for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq <= 0) continue;
  const k = line.slice(0, eq).trim();
  let v = line.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}

const mysql2 = require('mysql2/promise');

(async () => {
  const conn = await mysql2.createConnection({
    host: process.env.JUZHU_DB_HOST,
    port: +process.env.JUZHU_DB_PORT || 3306,
    user: process.env.JUZHU_DB_USER,
    password: process.env.JUZHU_DB_PASSWORD,
    database: process.env.JUZHU_DB_NAME,
    decimalNumbers: true,
  });
  try {
    const [before] = await conn.execute(
      'SELECT id, vendor_id, title, price, original_price FROM jz_products WHERE vendor_id IN (41,42) ORDER BY id'
    );
    console.log('[before]');
    for (const p of before) console.log(` #${p.id} vendor=${p.vendor_id} ${JSON.stringify(p.title)} price=${p.price} orig=${p.original_price}`);

    if (dry) {
      console.log('[dry-run] 未执行更新');
    } else {
      const [r] = await conn.execute(
        'UPDATE jz_products SET price = ROUND(price/100, 2), original_price = ROUND(original_price/100, 2) WHERE vendor_id IN (41,42)'
      );
      console.log('[update] affectedRows =', r.affectedRows);
      const [after] = await conn.execute(
        'SELECT id, vendor_id, title, price, original_price FROM jz_products WHERE vendor_id IN (41,42) ORDER BY id'
      );
      console.log('[after]');
      for (const p of after) console.log(` #${p.id} vendor=${p.vendor_id} ${JSON.stringify(p.title)} price=${p.price} orig=${p.original_price}`);
    }
  } finally {
    await conn.end();
  }
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
