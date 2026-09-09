#!/usr/bin/env node
/**
 * 旅居频道补充房源 seed/clean（goal：lvju-app-lvju 旅居视图房源过少，补齐到 8 套）
 * 背景：页面接库前的硬编码 mock（西江苗寨/荔波小七孔/梵净山/万峰林 4 套）在 6f1c8ad 接库时被删，
 *       库里仅 migrate-housing-channels.cjs 灌入的 2 套（山舍·青岩/森林溪畔）。本脚本补 6 套
 *       贵阳各区真实旅居目的地，口径与 #93/#94 完全一致（rental + 「旅居」tag + stay_bookable）。
 * 用法：node scripts/lvju-stay-seed.cjs seed|clean
 * 规则12/14：只用 Node + mysql2；凭证只读环境变量（juzhu/.env.local → JUZHU_DB_* / MYSQL_*）
 * 约束：幂等（按 slug 判重）；clean 只删本脚本 slug 清单内的行，不动 #93/#94 等既有房源。
 */
const path = require('path');
const fs = require('fs');
// 手动加载 env（不覆盖语义=先到先得，.env.local 最先加载）——同 demo-listings.cjs
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

const CITY_SLUG = 'guiyang';
const VENDOR_LOGIN = 'shanshe'; // 山舍旅居托管（migrate-housing-channels.cjs 创建，lvju_host）

// rental 月租口径（旅居卡按 月租/30 折算夜价）；封面取 assets/lvju 未占用图，一一对应不重复
const SEEDS = [
  { slug: 'shanshe-nanjiang', name: '山舍·南江峡谷树屋', district: '开阳县',
    tags: ['旅居', '康养', '森林'], cover: 'assets/lvju/countryside.jpg',
    units: [['峡谷树屋大床房', '一居一卫', 30, 19800], ['林景双床房', '二居一卫', 26, 15800]] },
  { slug: 'shanshe-xifeng-wenquan', name: '山舍·息烽温泉汤院', district: '息烽县',
    tags: ['旅居', '康养', '候鸟'], cover: 'assets/lvju/fanjingshan.jpg',
    units: [['温泉汤屋大床房', '一居一卫', 34, 22800], ['理疗疗养套房', '一居一厅', 45, 29800]] },
  { slug: 'shanshe-hongfenghu', name: '山舍·红枫湖候鸟湖居', district: '清镇市',
    tags: ['旅居', '候鸟', '湖景'], cover: 'assets/lvju/huangguoshu.jpg',
    units: [['湖景大床房', '一居一卫', 28, 17800], ['候鸟两居室', '二居一厅', 52, 26800]] },
  { slug: 'shanshe-taoyuanhe', name: '山舍·桃源河畔田园小院', district: '修文县',
    tags: ['旅居', '亲子', '田园'], cover: 'assets/lvju/zhaoxing-dong.jpg',
    units: [['田园小院套房', '一居一厅', 40, 16800], ['河畔亲子双床房', '二居一卫', 35, 18800]] },
  { slug: 'shanshe-shilihetan', name: '山舍·十里河滩湿地别院', district: '花溪区',
    tags: ['旅居', '康养', '湿地'], cover: 'assets/lvju/guiyang-river.jpg',
    units: [['湿地别院大床房', '一居一卫', 32, 23800], ['河滩观景套房', '一居一厅', 48, 32800]] },
  { slug: 'shanshe-xiangzhigou', name: '山舍·香纸沟山林小筑', district: '乌当区',
    tags: ['旅居', '亲子', '山林'], cover: 'assets/lvju/stilt-miao.jpg',
    units: [['山林大床房', '一居一卫', 28, 14800], ['吊脚楼双床房', '二居一卫', 30, 16800]] },
];

// 与 #93/#94 一致的项目级 ext（规则16：按晚预订开关 + 保险标识）
const PROJECT_EXT = JSON.stringify({ insurance: ['switch_rental', 'property'], stay_bookable: true });

async function conn() {
  const c = await mysql.createConnection({
    host: process.env.JUZHU_DB_HOST || process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.JUZHU_DB_PORT || process.env.MYSQL_PORT || '3306', 10),
    user: process.env.JUZHU_DB_USER || process.env.MYSQL_USER || 'root',
    password: process.env.JUZHU_DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
    database: process.env.JUZHU_DB_NAME || process.env.MYSQL_DB || 'juzhu',
    charset: 'utf8mb4',
  });
  return c;
}

async function resolveRefs(db) {
  const [city] = await db.execute('SELECT id FROM cities WHERE slug=? LIMIT 1', [CITY_SLUG]);
  if (!city.length) throw new Error('找不到城市 ' + CITY_SLUG);
  const [vendor] = await db.execute('SELECT id FROM jz_vendors WHERE login_name=? LIMIT 1', [VENDOR_LOGIN]);
  if (!vendor.length) throw new Error(`找不到商家 ${VENDOR_LOGIN}，请先执行 scripts/migrate-housing-channels.cjs`);
  const districtIds = {};
  for (const s of SEEDS) {
    const [d] = await db.execute('SELECT id FROM districts WHERE city_id=? AND name=? LIMIT 1', [city[0].id, s.district]);
    if (!d.length) throw new Error(`找不到区县 ${s.district}（city_id=${city[0].id}）`);
    districtIds[s.district] = d[0].id;
  }
  return { cityId: city[0].id, vendorId: vendor[0].id, districtIds };
}

async function seed(db) {
  const { cityId, vendorId, districtIds } = await resolveRefs(db);
  let nProj = 0, nUnits = 0, nSkip = 0;
  for (const s of SEEDS) {
    const [ex] = await db.execute('SELECT id FROM projects WHERE slug=? LIMIT 1', [s.slug]);
    if (ex.length) { console.log(`seed: ${s.slug} 已存在 (#${ex[0].id})，跳过`); nSkip++; continue; }
    const priceFrom = Math.min(...s.units.map((u) => u[3]));
    const address = `${s.district} · ${s.name}`;
    const [r] = await db.execute(
      `INSERT INTO projects(city_id,district_id,channel,name,slug,cover_image,address,tags,
        sort_order,unit_count,managed_unit_count,price_from,owner_vendor_id,status,ext)
       VALUES (?,?,?,?,?,?,?,?,900,?,?,?,?,'online',?)`,
      [cityId, districtIds[s.district], 'rental', s.name, s.slug, s.cover, address, JSON.stringify(s.tags),
        s.units.length, s.units.length, priceFrom, vendorId, PROJECT_EXT]);
    const pid = r.insertId;
    let seq = 0;
    for (const [uname, layout, area, rent] of s.units) {
      seq += 1;
      await db.execute(
        `INSERT INTO units(project_id,name,slug,area_sqm,layout_label,rent_monthly,tags,sort_order)
         VALUES (?,?,?,?,?,?,?,?)`,
        [pid, uname, `${s.slug}-u${seq}`, area, layout, rent,
          JSON.stringify([s.tags[0], s.tags[1]]), seq]);
      nUnits++;
    }
    nProj++;
    console.log(`seed: ${s.name} (#${pid}, ${s.district}, 月租起 ¥${priceFrom})`);
  }
  console.log(`seed 完成：新增 ${nProj} 套 / 跳过 ${nSkip} 套，户型 ${nUnits} 个；旅居视图合计 ${2 + nProj} 套（不含已存在跳过）`);
}

async function clean(db) {
  let n = 0;
  for (const s of SEEDS) {
    const [rows] = await db.execute('SELECT id FROM projects WHERE slug=? LIMIT 1', [s.slug]);
    if (!rows.length) continue;
    const pid = rows[0].id;
    await db.execute('DELETE FROM stay_calendar WHERE project_id=?', [pid]).catch(() => {});   // 含 unit_id=0 项目级行
    await db.execute('DELETE FROM photos WHERE entity_type=? AND entity_id IN (SELECT id FROM units WHERE project_id=?)', ['unit', pid]).catch(() => {});
    await db.execute('DELETE FROM units WHERE project_id=?', [pid]);
    await db.execute('DELETE FROM photos WHERE entity_type=? AND entity_id=?', ['project', pid]).catch(() => {});
    await db.execute('DELETE FROM projects WHERE id=?', [pid]);
    n++;
    console.log(`clean: 已删除 ${s.slug} (#${pid})`);
  }
  console.log(`clean 完成：删除 ${n} 套（仅本脚本 slug 清单，#93/#94 不受影响）`);
}

(async () => {
  const mode = process.argv[2] || '';
  if (!['seed', 'clean'].includes(mode)) {
    console.error('用法: node scripts/lvju-stay-seed.cjs seed|clean');
    process.exit(1);
  }
  const db = await conn();
  try {
    if (mode === 'seed') await seed(db);
    else await clean(db);
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
