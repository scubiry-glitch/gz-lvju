#!/usr/bin/env node
/**
 * 演示房源数据 seed/clean（goal：空频道数据；约束：可按 tag「演示」一键清理）
 * 用法：node scripts/demo-listings.cjs seed|clean
 * 规则14：只用 Node + mysql2；凭证只读环境变量（JUZHU_DB_* / MYSQL_*）
 */
const path = require('path');
// 手动加载 env（不覆盖语义=先到先得，故 .env.local 最先加载，优先于 runtime.env 的陈旧远程 HOST）
const fs = require('fs');
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

const DEMO_TAG = '演示';
const DEMO_VENDORS = [
  { type: 'developer', name: '示例置业（演示）', login_name: 'demo_developer', password: 'demo-dev-pass' },
  { type: 'agent', name: '示例中介（演示）', login_name: 'demo_agent', password: 'demo-agent-pass' },
];
const CITY_SLUG = 'guiyang';
const DISTRICT_NAMES = ['观山湖区', '花溪区'];

const DEMO = [
  // ── minsu 惠居（彩贝 5 维口径）──
  {
    channel: 'minsu', slug: 'demo-minsu-xingkong', name: '示例·星空整栋惠居',
    address: '观山湖区 · 示例景区东门', price_from: 980, featured: 1,
    units: [
      { name: '整栋 · 6 室', layout_label: '6室3卫', area_sqm: 260, rent_monthly: 19600, tags: ['整栋包栋', '管家服务'] },
      { name: '庭院大床房', layout_label: '1室1卫', area_sqm: 32, rent_monthly: 980, tags: ['含双早', '庭院'] },
    ],
  },
  {
    channel: 'minsu', slug: 'demo-minsu-guzhen', name: '示例·古镇石巷小筑',
    address: '花溪区 · 示例古镇南街', price_from: 528, featured: 0,
    units: [{ name: '庭院房', layout_label: '1室1卫', area_sqm: 28, rent_monthly: 528, tags: ['古镇里弄', '好停车'] }],
  },
  // ── newhouse 新房（总价口径）──
  {
    channel: 'newhouse', slug: 'demo-newhouse-yunjing', name: '示例·云景台',
    address: '观山湖区 · 示例大道 88 号', price_total: 98, price_from: 9800, featured: 1,
    units: [
      { name: '三居 108㎡', layout_label: '3室2厅', area_sqm: 108, price_total: 98, tags: ['南北通透', '地铁盘'] },
      { name: '两居 82㎡', layout_label: '2室2厅', area_sqm: 82, price_total: 76, tags: ['低总价', '现房'] },
    ],
  },
  {
    channel: 'newhouse', slug: 'demo-newhouse-xishan', name: '示例·西山云庐',
    address: '花溪区 · 示例山麓', price_total: 168, price_from: 13800, featured: 0,
    units: [{ name: '洋房四居 142㎡', layout_label: '4室2厅', area_sqm: 142, price_total: 168, tags: ['低密度', '山景'] }],
  },
  // ── resale 二手（一房一档，总价口径）──
  {
    channel: 'resale', slug: 'demo-resale-shiji', name: '示例世纪城',
    address: '观山湖区 · 示例世纪城', featured: 0,
    units: [
      { name: '南北三居 88㎡', layout_label: '3室2厅', area_sqm: 88, price_total: 128, tags: ['满五唯一', 'VR看房'] },
      { name: '高层两居 76㎡', layout_label: '2室2厅', area_sqm: 76, price_total: 99, tags: ['一线江景', '电梯'] },
    ],
  },
  {
    channel: 'resale', slug: 'demo-resale-huaguoyuan', name: '示例花果园',
    address: '南明区 · 示例花果园', featured: 0,
    units: [{ name: '高层一居 52㎡', layout_label: '1室1厅', area_sqm: 52, price_total: 56, tags: ['低总价', '近商圈'] }],
  },
];

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

function slugify(name) {
  return (name || '').replace(/[（(].*?[）)]/g, '').trim().replace(/\s+/g, '-') || 'item';
}

async function ensureVendor(db, v, bcrypt) {
  const [rows] = await db.execute('SELECT id FROM jz_vendors WHERE login_name=? LIMIT 1', [v.login_name]);
  if (rows.length) return rows[0].id;
  const [r] = await db.execute(
    'INSERT INTO jz_vendors(type,name,status,login_name,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    [v.type, v.name, 'active', v.login_name, bcrypt.hashSync(v.password, 10), new Date().toISOString().slice(0, 19).replace('T', ' '), new Date().toISOString().slice(0, 19).replace('T', ' ')]
  );
  return r.insertId;
}

// 清理验收残留：测试商家（vendor_a/b）+ 其测试项目（104/105 等 slug 前缀 test-vendor-）+ 评级记录
async function cleanTest(db) {
  const [projects] = await db.query("SELECT id FROM projects WHERE slug LIKE 'test-vendor-%'");
  for (const p of projects) {
    await db.execute('DELETE FROM photos WHERE entity_type=? AND entity_id IN (SELECT id FROM units WHERE project_id=?)', ['unit', p.id]);
    await db.execute('DELETE FROM units WHERE project_id=?', [p.id]);
    await db.execute('DELETE FROM projects WHERE id=?', [p.id]);
  }
  const [vendors] = await db.query("SELECT id FROM jz_vendors WHERE login_name IN ('vendor_a','vendor_b')");
  for (const v of vendors) {
    await db.execute('DELETE FROM photos WHERE entity_type=? AND entity_id IN (SELECT id FROM units WHERE project_id IN (SELECT id FROM projects WHERE owner_vendor_id=?))', ['unit', v.id]).catch(() => {});
    await db.execute('DELETE FROM projects WHERE owner_vendor_id=?', [v.id]);
    await db.execute('DELETE FROM jz_vendors WHERE id=?', [v.id]);
  }
  console.log(`clean-test: 删除测试项目 ${projects.length} 个、测试商家 ${vendors.length} 个（含评级记录）`);
}

async function clean(db, bcrypt) {
  const [projects] = await db.query(
    "SELECT id FROM projects WHERE JSON_CONTAINS(tags, ?) OR slug LIKE 'demo-%'",
    [JSON.stringify(DEMO_TAG)]
  );
  for (const p of projects) {
    await db.execute('DELETE FROM photos WHERE entity_type=? AND entity_id IN (SELECT id FROM units WHERE project_id=?)', ['unit', p.id]);
    await db.execute('DELETE FROM units WHERE project_id=?', [p.id]);
    await db.execute('DELETE FROM photos WHERE entity_type=? AND entity_id=?', ['project', p.id]);
    await db.execute('DELETE FROM projects WHERE id=?', [p.id]);
  }
  for (const v of DEMO_VENDORS) {
    const [rows] = await db.execute('SELECT id FROM jz_vendors WHERE login_name=? LIMIT 1', [v.login_name]);
    if (!rows.length) continue;
    const vid = rows[0].id;
    const [used] = await db.query('SELECT COUNT(*) n FROM projects WHERE owner_vendor_id=?', [vid]);
    if (!used[0].n) await db.execute('DELETE FROM jz_vendors WHERE id=?', [vid]);
  }
  console.log(`clean: 删除演示项目 ${projects.length} 个（含户型/图片）`);
}

async function seed(db, bcrypt) {
  await clean(db, bcrypt);
  const [city] = await db.execute('SELECT id FROM cities WHERE slug=? LIMIT 1', [CITY_SLUG]);
  if (!city.length) throw new Error('找不到城市 ' + CITY_SLUG);
  const cityId = city[0].id;
  const districts = {};
  for (const dn of DISTRICT_NAMES) {
    const [d] = await db.execute('SELECT id FROM districts WHERE city_id=? AND name LIKE ? LIMIT 1', [cityId, '%' + dn + '%']);
    if (d.length) districts[dn] = d[0].id;
  }
  const vendorIds = {
    minsu: await ensureVendor(db, DEMO_VENDORS[0], bcrypt), // 惠居暂挂示例置业；如需 lvju_host 可改
    newhouse: await ensureVendor(db, DEMO_VENDORS[0], bcrypt),
    resale: await ensureVendor(db, DEMO_VENDORS[1], bcrypt),
  };
  let nProj = 0, nUnits = 0;
  for (const item of DEMO) {
    const districtKey = DISTRICT_NAMES.find((dn) => (item.address || '').includes(dn));
    const [r] = await db.execute(
      `INSERT INTO projects(city_id,district_id,channel,name,slug,address,tags,sort_order,price_from,is_featured,featured_rank,status,owner_vendor_id,unit_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [cityId, districtKey ? districts[districtKey] || null : null, item.channel, item.name, item.slug, item.address,
        JSON.stringify([DEMO_TAG, ...(item.featured ? ['精选'] : [])]),
        item.featured ? 1 : 50, item.price_from || null,
        item.featured ? 1 : 0, item.featured ? 1 : null, 'online', vendorIds[item.channel]]
    );
    const pid = r.insertId;
    nProj++;
    for (const u of item.units || []) {
      await db.execute(
        `INSERT INTO units(project_id,name,slug,area_sqm,layout_label,rent_monthly,price_total,tags)
         VALUES (?,?,?,?,?,?,?,?)`,
        [pid, u.name, slugify(u.name), u.area_sqm || null, u.layout_label || null,
          u.rent_monthly || null, u.price_total || null,
          JSON.stringify(u.tags || [])]
      );
      nUnits++;
    }
    console.log(`seed: [${item.channel}] ${item.name} (#${pid}, ${nProj}个)`);
  }
  // units 表计数量同步
  for (const item of DEMO) {
    await db.execute(
      'UPDATE projects SET unit_count=(SELECT COUNT(*) FROM units WHERE project_id=projects.id) WHERE slug=? AND channel=?',
      [item.slug, item.channel]
    );
  }
  console.log(`seed 完成：项目 ${nProj} 个，户型 ${nUnits} 个（tag=${DEMO_TAG}，可用 clean 一键清理）`);
}

(async () => {
  const mode = process.argv[2] || '';
  if (!['seed', 'clean', 'clean-test'].includes(mode)) {
    console.error('用法: node scripts/demo-listings.cjs seed|clean|clean-test');
    process.exit(1);
  }
  const bcrypt = require('bcryptjs');
  const db = await conn();
  try {
    if (mode === 'seed') await seed(db, bcrypt);
    else if (mode === 'clean-test') await cleanTest(db);
    else await clean(db, bcrypt);
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
