#!/usr/bin/env node
/**
 * 沈阳 · 搬家频道 seed/clean（对齐《搬家服务原型说明》蓝犀牛 × 贝壳 2026-09-18）
 *
 * 背景：C 端 juzhu-jiazheng-list.html?type=moving / juzhu-jiazheng-detail.html 走
 *       GET /api/juzhu/jiazheng/skus?city=沈阳，而列表接口按「商品 p.city_id = 当前城市
 *       + 商家 active 且 city_ids 命中」双维度过滤。库里 jz_products.city_id 全为 NULL，
 *       所以任何城市的任何频道都渲染不出服务。本脚本给沈阳(city_id=1)配齐搬家可售商品。
 *
 * 取材：原型说明 4.2「沈阳仅启用同城、跨城的小面、中面、厢货，共 6 个 SPU、6 个 SKU；
 *       小厢货与日式模板供其他城市按实际配置使用」——故本脚本只种这 6 个。
 *
 * 用法：node scripts/moving-shenyang-seed.cjs seed|clean [--dry]
 * 规则12/14：只用 Node + mysql2；凭证只读环境变量（juzhu/.env.local → MYSQL_*）。
 * 约束：幂等（sku 按 slug、product 按固定 id 段原地更新）；
 *       clean 只删本脚本的 6 个 slug 与 5161-5166，不动库里既有搬家 SPU（id 6/7/17-20）。
 */
const path = require('path');
const fs = require('fs');
// 手动加载 env（不覆盖语义=先到先得，.env.local 最先加载）——同 spots-seed.cjs
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
const VENDOR_ID = 151;   // 蓝犀牛搬家（city_ids NULL = 全国投放）
const PRODUCT_ID_BASE = 5161;   // 固定 id 段，便于 clean 与直链稳定

const FLOW = ['提交搬家信息', '匹配搬家师傅', '按时到达指定地址', '完成搬家服务'];
const FLOW_NOTE = [
  '搬家收费标准可在服务商页面中查看',
  '及时响应并确认搬家详情',
  '确保搬家服务有序进行',
  '满意五星好评',
];
// 服务说明分两档：小面/中面 2 项，厢货 4 项（原型说明 D03：每项独立配置标题与正文）
const SERVICES_SMALL = [
  { name: '全程搬运', desc: '标配1名搬家师傅负责全程搬运' },
  { name: '车辆运输', desc: '适合单人搬家使用，装满为止' },
];
const SERVICES_VAN = [
  { name: '全程搬运', desc: '标配2名搬家师傅负责全程搬运' },
  { name: '车辆运输', desc: '适合家庭搬家使用，可装载家具家电' },
  { name: '物品保护', desc: '自研12种搬家保护装备' },
  { name: '合理摆放', desc: '家具家电负责还原在指定位置' },
];
// 品牌简介（商家介绍 D05）。原型稿原句含「好评率 99.8% / 千万用户 / 覆盖 41 城市」，
// 其自带备注要求「正式配置时核对适用时间与统计依据」——未核实前不带具体数字。
const VENDOR_INTRO = '蓝犀牛搬家，互联网搬家推荐品牌，提供明码标价、全程含搬运的专业搬家服务。';
// 频道级横幅（列表页 hero）。图取自《搬家服务原型说明》视觉规范给的 OSS 素材
// https://oss.lanxiniu.com/customer/beike/lxn-banner.png（1164×600），按仓库惯例落到
// assets/ 本地引用（仓库无外链图，且离线/端内可用）。仅当当前城市商品全部来自该商家时展示。
const VENDOR_BANNER = 'assets/lxn-banner.png';

// 6 个沈阳可售 SKU（原型说明 4.3 表格：名称/描述/标签/参考起价）
const SKUS = [
  { slug: 'moving-local-small-van', name: '同城搬家 · 小面', sort: 1,
    spec: '小面 · 1.6×1.3×1.1m · 1人全程搬运',
    listDesc: '1人全程搬运 · 装载空间 1.6×1.3×1.1m', price: 96, dur: 180,
    tags: ['全程搬运', '明码标价', '24小时可约'], includes: SERVICES_SMALL,
    badge: '省心搬', sales: '已搬 7800+' },
  { slug: 'moving-local-medium-van', name: '同城搬家 · 中面', sort: 2,
    spec: '中面 · 2.5×1.4×1.2m · 1人全程搬运',
    listDesc: '1人全程搬运 · 装载空间 2.5×1.4×1.2m', price: 168, dur: 180,
    tags: ['全程搬运', '明码标价', '24小时可约'], includes: SERVICES_SMALL,
    badge: '省心搬', sales: '已搬 7800+' },
  { slug: 'moving-local-box-truck', name: '同城搬家 · 厢货', sort: 3,
    spec: '厢货 · 4.2×1.8×1.8m · 2人全程搬运',
    listDesc: '2人全程搬运 · 装载空间 4.2×1.8×1.8m', price: 308, dur: 180,
    tags: ['全程搬家', '物品分类保护', '明码标价', '24小时可约'], includes: SERVICES_VAN,
    badge: '省心搬', sales: '已搬 7800+' },
  { slug: 'moving-longhaul-small-van', name: '跨城搬家 · 小面', sort: 4,
    spec: '小面 · 1.6×1.3×1.1m · 1人全程搬运',
    listDesc: '1人全程搬运 · 装载空间 1.6×1.3×1.1m', price: 96, dur: 600,
    tags: ['整车专送', '门到门服务', '全程搬运', '明码标价'], includes: SERVICES_SMALL,
    badge: '跨城保障', sales: '跨城专线 稳定发车' },
  { slug: 'moving-longhaul-medium-van', name: '跨城搬家 · 中面', sort: 5,
    spec: '中面 · 2.5×1.4×1.2m · 1人全程搬运',
    listDesc: '1人全程搬运 · 装载空间 2.5×1.4×1.2m', price: 168, dur: 600,
    tags: ['整车专送', '门到门服务', '全程搬运', '明码标价'], includes: SERVICES_SMALL,
    badge: '跨城保障', sales: '跨城专线 稳定发车' },
  { slug: 'moving-longhaul-box-truck', name: '跨城搬家 · 厢货', sort: 6,
    spec: '厢货 · 4.2×1.8×1.8m · 2人全程搬运',
    listDesc: '2人全程搬运 · 装载空间 4.2×1.8×1.8m', price: 308, dur: 600,
    tags: ['整车专送', '门到门服务', '全程搬运', '分类保护', '明码标价'], includes: SERVICES_VAN,
    badge: '跨城保障', sales: '跨城专线 稳定发车' },
];

const SLUGS = SKUS.map(s => s.slug);
const jd = v => JSON.stringify(v == null ? [] : v);

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
  console.log(`[seed] 城市 ${CITY_SLUG} = city_id ${cid}，商家 vendor_id ${VENDOR_ID}`);

  const [[v]] = await conn.execute('SELECT id,name FROM jz_vendors WHERE id=?', [VENDOR_ID]);
  if (!v) throw new Error('商家不存在：vendor_id ' + VENDOR_ID);
  console.log(`[seed] 商家：${v.name}`);

  // 0) 品牌简介（商家介绍 D05）+ 频道横幅（列表页 hero）
  if (!dry) await conn.execute('UPDATE jz_vendors SET intro=?, banner_url=? WHERE id=?',
    [VENDOR_INTRO, VENDOR_BANNER, VENDOR_ID]);
  console.log(`[seed] 品牌简介 / 频道横幅 ${dry ? '(dry 未写)' : '已写入'}`);

  // 1) SKU：按 slug 原地更新 / 缺失则插入
  const skuIds = {};
  for (const s of SKUS) {
    const [exist] = await conn.execute('SELECT id FROM jz_skus WHERE slug=?', [s.slug]);
    const cols = [
      s.name, s.spec, s.price, '起', s.dur, jd(s.tags), jd([s.badge]), s.sales,
      4.7, 'L2', jd(s.includes), jd(FLOW), jd(FLOW_NOTE), s.sort,
    ];
    if (exist.length) {
      skuIds[s.slug] = exist[0].id;
      if (!dry) {
        await conn.execute(
          `UPDATE jz_skus SET name=?, spec=?, price_from=?, price_unit=?, duration_min=?,
             tags=?, badges=?, sales_text=?, rating_score=?, worker_min_level=?,
             includes=?, service_flow=?, service_notice=?, sort_order=?, enabled=1
           WHERE slug=?`,
          [...cols, s.slug]
        );
      }
      console.log(`[seed] SKU 更新 ${s.slug} (id ${exist[0].id})`);
    } else {
      if (!dry) {
        const [r] = await conn.execute(
          `INSERT INTO jz_skus(category_id,name,slug,spec,price_from,price_unit,duration_min,
             tags,badges,sales_text,rating_score,worker_min_level,includes,service_flow,
             service_notice,sort_order,enabled)
           VALUES('moving',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
          [s.name, s.slug, s.spec, s.price, '起', s.dur, jd(s.tags), jd([s.badge]), s.sales,
           4.7, 'L2', jd(s.includes), jd(FLOW), jd(FLOW_NOTE), s.sort]
        );
        skuIds[s.slug] = r.insertId;
      }
      console.log(`[seed] SKU 新增 ${s.slug}`);
    }
  }

  // 2) 商品：固定 id 段，按 channel_sku_id 原地更新
  for (let i = 0; i < SKUS.length; i++) {
    const s = SKUS[i];
    const pid = PRODUCT_ID_BASE + i;
    const sid = skuIds[s.slug];
    // subtitle = 原型说明 4.3「列表描述」列（详情页头部用 spec，列表卡片摘要用这条）
    const vals = [s.name, s.listDesc, s.name.split(' · ')[0], s.price, Math.round(s.price * 1.6),
      s.dur / 60, '车次', jd(s.tags), cid, sid, s.sort];
    const [exist] = await conn.execute('SELECT id FROM jz_products WHERE id=?', [pid]);
    if (exist.length) {
      if (!dry) {
        await conn.execute(
          `UPDATE jz_products SET title=?, subtitle=?, category=?, price=?, original_price=?,
             duration_hours=?, unit=?, service_tags=?, city_id=?, channel_sku_id=?, sort_order=?,
             vendor_id=?, status='on'
           WHERE id=?`,
          [...vals, VENDOR_ID, pid]
        );
      }
      console.log(`[seed] 商品更新 ${pid} ${s.name}`);
    } else if (!dry) {
      await conn.execute(
        `INSERT INTO jz_products(id,vendor_id,title,subtitle,category,price,original_price,
           duration_hours,unit,service_tags,city_id,channel_sku_id,sort_order,status)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'on')`,
        [pid, VENDOR_ID, ...vals]
      );
      console.log(`[seed] 商品新增 ${pid} ${s.name}`);
    }
  }
  console.log(dry ? '[seed] --dry：未写库' : '[seed] 完成');
}

async function clean(conn, dry) {
  const ph = SLUGS.map(() => '?').join(',');
  const [skus] = await conn.execute(`SELECT id,slug FROM jz_skus WHERE slug IN (${ph})`, SLUGS);
  const ids = skus.map(r => r.id);

  // 安全闸：本脚本的 SKU 若已被订单引用则拒绝清理
  if (ids.length) {
    const [ord] = await conn.execute(
      `SELECT COUNT(*) n FROM jz_orders WHERE category_id='moving' AND sku_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    if (ord[0].n > 0) throw new Error(`有 ${ord[0].n} 条搬家订单引用这些 SKU，拒绝 clean`);
  }

  const pidList = SKUS.map((_, i) => PRODUCT_ID_BASE + i);
  if (!dry) {
    const [r1] = await conn.execute(
      `DELETE FROM jz_products WHERE id IN (${pidList.map(() => '?').join(',')}) AND vendor_id=?`,
      [...pidList, VENDOR_ID]
    );
    const [r2] = ids.length
      ? await conn.execute(`DELETE FROM jz_skus WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
      : [{ affectedRows: 0 }];
    console.log(`[clean] 删商品 ${r1.affectedRows} 行、SKU ${r2.affectedRows} 行`);
  } else {
    console.log(`[clean] --dry：将删商品 ${pidList.length} 行、SKU ${ids.length} 行`);
  }
}

(async () => {
  const cmd = process.argv[2];
  const dry = process.argv.includes('--dry');
  if (cmd !== 'seed' && cmd !== 'clean') {
    console.error('用法：node scripts/moving-shenyang-seed.cjs seed|clean [--dry]');
    process.exit(2);
  }
  const conn = await connect();
  try {
    await (cmd === 'seed' ? seed : clean)(conn, dry);
  } finally {
    await conn.end();
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
