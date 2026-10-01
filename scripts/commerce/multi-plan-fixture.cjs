#!/usr/bin/env node
// 多会员方案验证夹具：临时造第二个同城会员方案（会员中心多方案滑动卡组的验收用），验证完 --clean 还原。
// 固定 id 99001、city_id=3（贵阳），payload 克隆现有 plans 首行改名改价，幂等；clean 同时清掉 demo_promoter 名下因该方案产生的订单/券/会员记录。
// 用法：node scripts/commerce/multi-plan-fixture.cjs seed|clean
'use strict';
const { createPool } = require('../../commerce/db.cjs');
const ID = 99001, CITY_ID = 3;
const mode = process.argv[2] || 'seed';

(async () => {
  const pool = createPool();
  if (mode === 'clean') {
    const [acc] = await pool.query("SELECT id FROM accounts WHERE login_name='demo_promoter'");
    if (acc.length) {
      const [orders] = await pool.query('SELECT id FROM commerce_orders WHERE product_id=? AND account_id=?', [ID, acc[0].id]);
      for (const o of orders) {
        await pool.execute('DELETE FROM commerce_coupons WHERE order_id=?', [o.id]);
        await pool.execute('DELETE FROM commerce_memberships WHERE order_id=?', [o.id]);
        await pool.execute('DELETE FROM commerce_order_items WHERE order_id=?', [o.id]);
        await pool.execute('DELETE FROM commerce_orders WHERE id=?', [o.id]);
        console.log('removed order', o.id);
      }
    }
    await pool.execute("DELETE FROM commerce_versions WHERE kind='plans' AND entity_id=?", [ID]);
    await pool.execute('DELETE FROM commerce_plans WHERE id=?', [ID]);
    console.log('removed plan', ID);
  } else {
    const [first] = await pool.query('SELECT payload FROM commerce_plans ORDER BY id LIMIT 1');
    const payload = typeof first[0].payload === 'string' ? JSON.parse(first[0].payload) : first[0].payload;
    payload.name = '新居住会员 · 尊享版（演示）';
    payload.price_minor = 199900;
    payload.description = '多方案验证样例：尊享版含全部基础礼遇与双倍赠券。';
    payload.initialization = { ...(payload.initialization || { mode: 'demo' }), mode: 'demo', seed_key: 'verify-multi-plan-' + ID, note: '多方案展示验证样例，验证后 multi-plan-fixture.cjs clean 删除' };
    await pool.execute(
      'INSERT INTO commerce_plans(id,name,city_id,version,published_version,status,payload,created_by) VALUES (?,?,?,?,?,?,?,0) ON DUPLICATE KEY UPDATE payload=VALUES(payload), name=VALUES(name)',
      [ID, payload.name, CITY_ID, 1, 1, 'draft', JSON.stringify(payload)]
    );
    await pool.execute(
      "INSERT INTO commerce_versions(kind,entity_id,version,snapshot,reviewed_by) VALUES ('plans',?,1,?,0) ON DUPLICATE KEY UPDATE snapshot=VALUES(snapshot)",
      [ID, JSON.stringify(payload)]
    );
    console.log('seeded plan', ID, payload.name);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
