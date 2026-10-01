#!/usr/bin/env node
// C9 商品主图管线试点：给演示批次（payload.initialization.mode==='demo'）的已发布 snapshot 写 image 字段。
// 管线：commerce_versions.snapshot.image → /catalog 与 /promotion/products 透传 → 卡片缩略图/详情 hero 消费，onerror 回落品类图标。
// 同步实体 payload，避免下次发布回滚掉 image。运营配图后重跑（--set <url>）替换；--clean 还原无图态。
// 用法：node scripts/commerce/sku-image-seed.cjs [--apply] [--set /assets/commerce/living.webp] [--clean]
'use strict';
const { createPool } = require('../../commerce/db.cjs');

const IMG_DEFAULT = '/assets/commerce/living.webp';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const clean = args.includes('--clean');
const setIdx = args.indexOf('--set');
const image = setIdx >= 0 ? args[setIdx + 1] : IMG_DEFAULT;
const KINDS = [['skus', 'commerce_skus'], ['packages', 'commerce_packages'], ['plans', 'commerce_plans']];

(async () => {
  const pool = createPool();
  let hit = 0, changed = 0;
  for (const [kind, table] of KINDS) {
    const [rows] = await pool.query(`SELECT e.id, e.published_version, e.payload FROM ${table} e WHERE e.published_version IS NOT NULL`);
    for (const r of rows) {
      let payload, published;
      try { payload = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload; } catch { continue; }
      if (!(payload && (payload.initialization?.mode === 'demo' || payload.is_demo === true))) continue;
      const [vs] = await pool.query('SELECT snapshot FROM commerce_versions WHERE kind=? AND entity_id=? AND version=? LIMIT 1', [kind, r.id, r.published_version]);
      if (!vs.length) continue;
      try { published = typeof vs[0].snapshot === "string" ? JSON.parse(vs[0].snapshot) : vs[0].snapshot; } catch { continue; }
      hit++;
      const after = clean ? null : image;
      if ((published.image || null) === after) continue;
      changed++;
      if (after === null) { delete published.image; delete payload.image; } else { published.image = after; payload.image = after; }
      if (apply) {
        await pool.execute('UPDATE commerce_versions SET snapshot=? WHERE kind=? AND entity_id=? AND version=?', [JSON.stringify(published), kind, r.id, r.published_version]);
        await pool.execute(`UPDATE ${table} SET payload=? WHERE id=?`, [JSON.stringify(payload), r.id]);
      }
    }
  }
  console.log(`demo products: ${hit}, to ${apply ? (clean ? 'clean' : 'set') + ' image=' + image : 'inspect'}: changed=${changed}${apply ? '' : ' (dry-run, add --apply)'}`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
