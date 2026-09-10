#!/usr/bin/env node
// ⚠️ 一次性迁移脚本（2026-09-03 搬家 SPU 对齐蓝犀牛首期配置表）：勿重复执行！
// 依据：《贝壳SPU对齐建议与蓝犀牛配置表.md》4.1「蓝犀牛首期 SPU 建议配置表」
// 步骤：备份 → 清空关联搬家 SPU 的全部商品（物理删除）→ 删除旧 6 个搬家 SPU → 创建 10 个新 SPU
// 前置核验（2026-09-03）：待删商品无订单引用（jz_orders=0）、无服务者绑定（jz_sku_workers=0）
// 回滚：备份文件 backup_moving_spus_20260903.json 含旧 SPU 与商品全字段，可据此还原。
// 用法：node assets/_scratch/migrate_moving_spus_20260903.cjs [--dry]
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

// ---- 新 SPU 定义（文档 4.1；price_from 为参考起价·元：同城/跨城取蓝犀牛沈阳现价，
//      小厢货 240 与日式半 1080 为插值估算，可在 P 端调整）----
const NEW_SPUS = [
  { key: 'LXN-01', slug: 'moving-local-small-van', name: '同城搬家 · 小面', spec: '小面 · 1.6×1.3×1.1m · 1人全程搬运', price_from: 96, dur: 180, sort: 1,
    tags: ['同城精选', '可加购打包'], badges: ['省心搬', '平台保障'], sales: '已搬 7800+', rating: 4.7, level: 'L2',
    flow: ['提交清单', '客服估价', '确认车辆与人员', '按时搬运'], notice: ['楼层费按现场核算', '超距单独计费', '贵重物品建议保价'] },
  { key: 'LXN-02', slug: 'moving-local-medium-van', name: '同城搬家 · 中面', spec: '中面 · 2.5×1.4×1.2m · 1人全程搬运', price_from: 176, dur: 180, sort: 2,
    tags: ['同城精选', '可加购打包'], badges: ['省心搬', '平台保障'], sales: '已搬 7800+', rating: 4.7, level: 'L2',
    flow: ['提交清单', '客服估价', '确认车辆与人员', '按时搬运'], notice: ['楼层费按现场核算', '超距单独计费', '贵重物品建议保价'] },
  { key: 'LXN-03', slug: 'moving-local-small-box-truck', name: '同城搬家 · 小厢货', spec: '小厢货 · 3.0×1.7×1.5m · 2人全程搬运', price_from: 240, dur: 180, sort: 3,
    tags: ['同城精选', '可加购打包'], badges: ['省心搬', '平台保障'], sales: '已搬 7800+', rating: 4.7, level: 'L2',
    flow: ['提交清单', '客服估价', '确认车辆与人员', '按时搬运'], notice: ['楼层费按现场核算', '超距单独计费', '贵重物品建议保价'] },
  { key: 'LXN-04', slug: 'moving-local-box-truck', name: '同城搬家 · 厢货', spec: '厢货 · 4.2×1.8×1.8m · 2人全程搬运', price_from: 308, dur: 180, sort: 4,
    tags: ['同城精选', '可加购打包'], badges: ['省心搬', '平台保障'], sales: '已搬 7800+', rating: 4.7, level: 'L2',
    flow: ['提交清单', '客服估价', '确认车辆与人员', '按时搬运'], notice: ['楼层费按现场核算', '超距单独计费', '贵重物品建议保价'] },
  { key: 'LXN-05', slug: 'moving-japanese-full', name: '日式搬家 · 全日式', spec: '全日式 · 1.6×1.2×1.1m · 全屋收纳/物品保护/新家还原', price_from: 1680, dur: 480, sort: 5,
    tags: ['高端服务', '全程无忧'], badges: ['PRO'], sales: '企业家庭双适用', rating: 4.9, level: 'L4',
    includes: ['分类打包', '全屋收纳', '物品保护', '新家还原', '垃圾清运'],
    flow: ['顾问勘察', '确认方案', '分工搬运', '到家复原'], notice: ['需提前1天预约', '贵重柜体单独报价', '默认含基础耗材'] },
  { key: 'LXN-06', slug: 'moving-japanese-half', name: '日式搬家 · 半日式', spec: '半日式 · 1.6×1.2×1.1m · 全屋收纳/物品保护/全程搬运', price_from: 1080, dur: 480, sort: 6,
    tags: ['高端服务', '全程无忧'], badges: ['PRO'], sales: '企业家庭双适用', rating: 4.9, level: 'L4',
    includes: ['全屋收纳', '物品保护', '全程搬运'],
    flow: ['顾问勘察', '确认方案', '分工搬运', '到家复原'], notice: ['需提前1天预约', '贵重柜体单独报价', '默认含基础耗材'] },
  { key: 'LXN-07', slug: 'moving-longhaul-small-van', name: '跨城搬家 · 小面', spec: '小面 · 1.6×1.3×1.1m · 1人全程搬运', price_from: 96, dur: 600, sort: 7,
    tags: ['跨城专线', '门到门'], badges: ['跨城保障', '平台保障'], sales: '跨城专线 稳定发车', rating: 4.7, level: 'L2',
    flow: ['提交清单', '客服估价', '确认车辆与人员', '按时搬运'], notice: ['楼层费按现场核算', '超距单独计费', '贵重物品建议保价'] },
  { key: 'LXN-08', slug: 'moving-longhaul-medium-van', name: '跨城搬家 · 中面', spec: '中面 · 2.5×1.4×1.2m · 1人全程搬运', price_from: 176, dur: 600, sort: 8,
    tags: ['跨城专线', '门到门'], badges: ['跨城保障', '平台保障'], sales: '跨城专线 稳定发车', rating: 4.7, level: 'L2',
    flow: ['提交清单', '客服估价', '确认车辆与人员', '按时搬运'], notice: ['楼层费按现场核算', '超距单独计费', '贵重物品建议保价'] },
  { key: 'LXN-09', slug: 'moving-longhaul-small-box-truck', name: '跨城搬家 · 小厢货', spec: '小厢货 · 3.0×1.7×1.5m · 2人全程搬运', price_from: 240, dur: 600, sort: 9,
    tags: ['跨城专线', '门到门'], badges: ['跨城保障', '平台保障'], sales: '跨城专线 稳定发车', rating: 4.7, level: 'L2',
    flow: ['提交清单', '客服估价', '确认车辆与人员', '按时搬运'], notice: ['楼层费按现场核算', '超距单独计费', '贵重物品建议保价'] },
  { key: 'LXN-10', slug: 'moving-longhaul-box-truck', name: '跨城搬家 · 厢货', spec: '厢货 · 4.2×1.8×1.8m · 2人全程搬运', price_from: 308, dur: 600, sort: 10,
    tags: ['跨城专线', '门到门'], badges: ['跨城保障', '平台保障'], sales: '跨城专线 稳定发车', rating: 4.7, level: 'L2',
    flow: ['提交清单', '客服估价', '确认车辆与人员', '按时搬运'], notice: ['楼层费按现场核算', '超距单独计费', '贵重物品建议保价'] },
];
const DEFAULT_INCLUDES = ['基础搬运', '车辆运输', '大件保护包裹', '楼道清运'];
const J = (v) => JSON.stringify(v);

(async () => {
  const conn = await mysql2.createConnection({
    host: process.env.JUZHU_DB_HOST, port: +process.env.JUZHU_DB_PORT || 3306,
    user: process.env.JUZHU_DB_USER, password: process.env.JUZHU_DB_PASSWORD,
    database: process.env.JUZHU_DB_NAME, decimalNumbers: true,
  });
  try {
    // ---- 1. 备份（旧 SPU 全行 + 待删商品全行）----
    const [oldSpus] = await conn.execute("SELECT * FROM jz_skus WHERE category_id='moving' ORDER BY id");
    const [oldProducts] = await conn.execute(
      "SELECT * FROM jz_products WHERE channel_sku_id IN (SELECT id FROM jz_skus WHERE category_id='moving') ORDER BY id"
    );
    const backupPath = path.join(__dirname, 'backup_moving_spus_20260903.json');
    fs.writeFileSync(backupPath, JSON.stringify({ backup_at: new Date().toISOString(), old_spus: oldSpus, old_products: oldProducts }, null, 2));
    console.log('[backup] 搬家 SPU x' + oldSpus.length + '，商品 x' + oldProducts.length + ' → ' + backupPath);

    // 前置安全核验：商品无订单引用才允许删除
    const [[oc]] = await conn.execute(
      "SELECT COUNT(*) AS n FROM jz_orders WHERE sku_id IN (SELECT id FROM jz_products WHERE channel_sku_id IN (SELECT id FROM jz_skus WHERE category_id='moving'))"
    );
    if (oc.n > 0) { console.error('[abort] 发现 ' + oc.n + ' 笔订单引用搬家商品，禁止删除，请先确认'); process.exit(1); }

    if (dry) { console.log('[dry-run] 到此为止，未做任何变更'); return; }

    await conn.beginTransaction();
    try {
      // ---- 2. 物理删除关联搬家 SPU 的全部商品（含防御性清理 worker 绑定）----
      await conn.execute("DELETE FROM jz_sku_workers WHERE product_id IN (SELECT id FROM (SELECT id FROM jz_products WHERE channel_sku_id IN (SELECT id FROM jz_skus WHERE category_id='moving')) t)");
      const [dp] = await conn.execute(
        "DELETE FROM jz_products WHERE channel_sku_id IN (SELECT id FROM (SELECT id FROM jz_skus WHERE category_id='moving') t)"
      );
      console.log('[delete] 搬家商品清除 ' + dp.affectedRows + ' 行');

      // ---- 3. 删除旧 6 个搬家 SPU ----
      const [ds] = await conn.execute("DELETE FROM jz_skus WHERE category_id='moving'");
      console.log('[delete] 旧搬家 SPU 删除 ' + ds.affectedRows + ' 行');

      // ---- 4. 创建 10 个新 SPU ----
      for (const s of NEW_SPUS) {
        const [r] = await conn.execute(
          `INSERT INTO jz_skus(category_id,name,slug,spec,price_from,price_unit,duration_min,
             tags,badges,sales_text,rating_score,worker_min_level,includes,service_flow,service_notice,sort_order,enabled)
           VALUES('moving',?,?,?,?,'起',?,?,?,?,?,?,?,?,?,?,1)`,
          [s.name, s.slug, s.spec, s.price_from, s.dur, J(s.tags), J(s.badges), s.sales, s.rating, s.level,
           J(s.includes || DEFAULT_INCLUDES), J(s.flow), J(s.notice), s.sort]
        );
        console.log('[insert] ' + s.key + ' ' + s.slug + ' → id=' + r.insertId);
      }
      await conn.commit();

      // ---- 5. 验证 ----
      const [after] = await conn.execute("SELECT id,slug,name,price_from,sort_order FROM jz_skus WHERE category_id='moving' ORDER BY sort_order");
      console.log('[verify] 现有搬家 SPU ' + after.length + ' 个：');
      after.forEach((s) => console.log('  id=' + s.id + ' ' + s.slug + ' ' + s.name + ' 参考价¥' + s.price_from));
      const [[pc]] = await conn.execute("SELECT COUNT(*) AS n FROM jz_products WHERE channel_sku_id IN (SELECT id FROM jz_skus WHERE category_id='moving')");
      console.log('[verify] 残留关联搬家 SPU 的商品: ' + pc.n + '（期望 0）');
    } catch (e) {
      await conn.rollback();
      console.error('[rollback]', e.message);
      process.exit(1);
    }
  } finally {
    await conn.end();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
