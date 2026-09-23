#!/usr/bin/env node
/**
 * 沈阳 · 生活服务频道货架 seed/clean（除搬家外的 11 个频道）
 *
 * 背景：GET /api/juzhu/jiazheng/skus?city=沈阳 按「商品 p.city_id=当前城市 + 商家 active
 *       且 city_ids 命中」双维度过滤。库里 jz_products.city_id 多为 NULL（任何城市都不展示），
 *       沈阳此前只有 scripts/moving-shenyang-seed.cjs 配的 6 个搬家商品——首页「热门推荐」
 *       （每频道取 1 条）只剩 1 张搬家卡。本脚本把其余 11 个频道的全部可售 SKU 配齐沈阳。
 *
 * 商家映射：用 jz_seed.cjs 的标准频道商家（city_ids 含 1，active+approved）——
 *       cleaning→2 平台优选·保洁 / repair→11 快修家电 / nanny→31 阿姨来了 /
 *       telecom→41 联通装维优选 / insurance→42 安居财险专区 / consumer_finance→43 江苏银行消费金融 /
 *       health_care→44 康养到家 / home_maintain→45 安居养护 / asset→46 贝壳资产顾问 /
 *       recycle→47 绿色回收站 / community→48 邻里便民站。
 *
 * 搬家（moving）**故意不种**：沈阳搬家归蓝犀牛（vendor 151，5161-5166，见
 *       moving-shenyang-seed.cjs）；若再混入其他商家商品，会破坏列表页「当前频道商品全部
 *       来自同一商家才显示频道横幅」的规则（CLAUDE.md 规则 9）。
 *
 * 用法：node scripts/life-shenyang-seed.cjs seed|clean [--dry]
 * 规则12/14：只用 Node + mysql2；凭证只读环境变量（juzhu/.env.local → MYSQL_*）。
 * 约束：幂等（固定 id 段原地更新）；clean 只删本脚本的 id 段（带商家白名单闸），
 *       不动 5161-5166（搬家）与 5255-5300（贵阳演示）。
 */
const path = require('path');
const fs = require('fs');
// 手动加载 env（不覆盖语义=先到先得，.env.local 最先加载）——同 moving-shenyang-seed.cjs
for (const f of ['juzhu/.env.local', '.env', 'runtime.env']) {
  const p = path.join(__dirname, '..', f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const k = t.slice(0, t.indexOf('=')).trim().replace(/^export /, '');
    const v = t.slice(t.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}
const mysql = require('mysql2/promise');

const CITY_SLUG = 'shenyang';
const PRODUCT_ID_BASE = 5341;   // 固定 id 段（现有最大 5300；5161-5166 为搬家、5255-5300 为贵阳演示）
const PRODUCT_ID_SLOTS = 40;    // 预留 40 个槽位（当前非搬家 SKU 共 40 条）

// 频道 → 标准商家（jz_seed.cjs 生成，city_ids 含沈阳；缺 moving，见文件头说明）
const VENDOR_BY_CATEGORY = {
  cleaning: 2, repair: 11, nanny: 31,
  telecom: 41, insurance: 42, consumer_finance: 43, health_care: 44,
  home_maintain: 45, asset: 46, recycle: 47, community: 48,
};
const VENDOR_IDS = Object.values(VENDOR_BY_CATEGORY);

async function connect() {
  return mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DB,
  });
}

async function cityId(conn, slug) {
  const [rows] = await conn.execute('SELECT id FROM cities WHERE slug=? OR name=? LIMIT 1', [slug, slug]);
  if (!rows.length) throw new Error('城市不存在：' + slug + '（先跑 seed 建 cities）');
  return rows[0].id;
}

async function seed(conn, dry) {
  const cid = await cityId(conn, CITY_SLUG);
  console.log(`[seed] 城市 ${CITY_SLUG} = city_id ${cid}，频道商家映射 ${Object.keys(VENDOR_BY_CATEGORY).length} 个`);

  // 频道商家就位校验（active + 已过复审；city_ids 命中由接口 cityIdsClause 判，缺列直接报错）
  const [vendors] = await conn.execute(
    `SELECT id,name,status,review_status FROM jz_vendors WHERE id IN (${VENDOR_IDS.map(() => '?').join(',')})`,
    VENDOR_IDS
  );
  const vendorById = new Map(vendors.map(v => [v.id, v]));
  for (const [cat, vid] of Object.entries(VENDOR_BY_CATEGORY)) {
    const v = vendorById.get(vid);
    if (!v) throw new Error(`频道 ${cat} 的商家不存在：vendor_id ${vid}`);
    if (v.status !== 'active') throw new Error(`商家 ${vid} ${v.name} 未启用（status=${v.status}）`);
    console.log(`[seed] ${cat} → v${vid} ${v.name}`);
  }

  // 覆盖非搬家频道的全部启用 SKU（搬家归 moving-shenyang-seed.cjs）
  const [skus] = await conn.execute(
    'SELECT id,category_id,name,slug,spec,price_from,price_unit,duration_min,sort_order FROM jz_skus WHERE enabled=1 ORDER BY category_id, sort_order, id'
  );
  const targets = skus.filter(s => VENDOR_BY_CATEGORY[s.category_id]);
  if (targets.length > PRODUCT_ID_SLOTS) {
    throw new Error(`非搬家 SKU ${targets.length} 条超出预留 id 段 ${PRODUCT_ID_SLOTS} 个（调大 PRODUCT_ID_SLOTS 后重跑）`);
  }
  console.log(`[seed] 待配 SKU ${targets.length} 条（搬家 SKU ${skus.filter(s => s.category_id === 'moving').length} 条跳过，归 moving-shenyang-seed.cjs）`);

  const coveredSkuIds = targets.map(s => s.id);
  for (let i = 0; i < targets.length; i++) {
    const s = targets[i];
    const vid = VENDOR_BY_CATEGORY[s.category_id];
    const pid = PRODUCT_ID_BASE + i;
    const price = Number(s.price_from) || 0;
    const vals = [
      vid, s.name, s.spec || s.name, s.category_id, Math.max(1, Math.round((s.duration_min || 60) / 60)),
      s.price_unit || '次', price, price ? Math.round(price * 1.5) : null,
      '今天 18:00', 2, 100, 4.7, JSON.stringify(['本地生活', '可预约']), cid, s.id,
    ];
    const [exist] = await conn.execute('SELECT id FROM jz_products WHERE id=?', [pid]);
    if (exist.length) {
      if (!dry) {
        await conn.execute(
          `UPDATE jz_products SET vendor_id=?, title=?, subtitle=?, category=?, duration_hours=?,
             unit=?, price=?, original_price=?, earliest_time=?, advance_booking_hours=?,
             sales_count=?, rating=?, service_tags=?, city_id=?, channel_sku_id=?, status='on'
           WHERE id=?`,
          [...vals, pid]
        );
      }
      console.log(`[seed] 商品更新 ${pid} v${vid} ${s.name}`);
    } else if (!dry) {
      await conn.execute(
        `INSERT INTO jz_products(id,vendor_id,title,subtitle,category,duration_hours,unit,price,
           original_price,earliest_time,advance_booking_hours,sales_count,rating,service_tags,
           city_id,channel_sku_id,status)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'on')`,
        [pid, ...vals]
      );
      console.log(`[seed] 商品新增 ${pid} v${vid} ${s.name}`);
    }
  }

  // 关联商家名下已有服务者（v2/v11/v31 有种子服务者；41-48 暂无则跳过，详情页档期为空即可）
  if (!dry && coveredSkuIds.length) {
    const [workers] = await conn.execute(
      `SELECT id,vendor_id FROM jz_workers WHERE status='active' AND vendor_id IN (${VENDOR_IDS.map(() => '?').join(',')})`,
      VENDOR_IDS
    );
    let linked = 0;
    for (let i = 0; i < targets.length; i++) {
      const vid = VENDOR_BY_CATEGORY[targets[i].category_id];
      for (const w of workers.filter(x => x.vendor_id === vid)) {
        await conn.execute('INSERT IGNORE INTO jz_sku_workers(product_id,worker_id) VALUES(?,?)', [PRODUCT_ID_BASE + i, w.id]);
        linked++;
      }
    }
    console.log(`[seed] 服务者关联 ${linked} 条`);
  }
  console.log(dry ? '[seed] --dry：未写库' : '[seed] 完成');
}

async function clean(conn, dry) {
  const pidList = Array.from({ length: PRODUCT_ID_SLOTS }, (_, i) => PRODUCT_ID_BASE + i);
  const ph = pidList.map(() => '?').join(',');
  // 安全闸：只删本脚本 id 段内、且挂在频道商家白名单上的行（id 段被挪用时不误伤）
  const [rows] = await conn.execute(
    `SELECT id FROM jz_products WHERE id IN (${ph}) AND vendor_id IN (${VENDOR_IDS.map(() => '?').join(',')})`,
    [...pidList, ...VENDOR_IDS]
  );
  const ids = rows.map(r => r.id);
  if (!dry) {
    if (ids.length) {
      await conn.execute(`DELETE FROM jz_sku_workers WHERE product_id IN (${ids.map(() => '?').join(',')})`, ids);
      const [r] = await conn.execute(`DELETE FROM jz_products WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      console.log(`[clean] 删商品 ${r.affectedRows} 行（含服务者关联）`);
    } else {
      console.log('[clean] 本脚本 id 段无可清理商品');
    }
  } else {
    console.log(`[clean] --dry：将删商品 ${ids.length} 行`);
  }
}

(async () => {
  const cmd = process.argv[2];
  const dry = process.argv.includes('--dry');
  if (cmd !== 'seed' && cmd !== 'clean') {
    console.error('用法：node scripts/life-shenyang-seed.cjs seed|clean [--dry]');
    process.exit(2);
  }
  const conn = await connect();
  try {
    await (cmd === 'seed' ? seed : clean)(conn, dry);
  } finally {
    await conn.end();
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
