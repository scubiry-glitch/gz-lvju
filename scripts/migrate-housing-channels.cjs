#!/usr/bin/env node
/**
 * 房源库通用化一次性迁移（幂等，可重复执行）：
 *  1) 备份 projects / units / jz_vendors → *_bak_20260904（快照表，可手动删除回滚参考）
 *  2) channels 增 rental/minsu/newhouse/resale；bzf 行置首（保租房专区=首屏默认 tab）
 *  3) settings 写 topic_bzf 专题定义 KV（channel=rental + tags 含「保租房」）
 *  4) jz_vendors 增 housing 域商家（platform 池 + 白名单运营商/旅居托管/开发商/经纪），
 *     login 账号仅在缺失时创建，密码随机生成并打印一次（不入库明文、不写文档）
 *  5) 存量 47 个项目 owner_vendor_id 从 1(春晖家政) 挪到 platform 池（1 号是家政商家，不能复用）
 *  6) 各频道种子演示项目 + 户型（旅居/长租→rental，民宿→minsu，新房→newhouse，二手→resale）
 *
 * 用法： set -a; . juzhu/.env.local; set +a; node scripts/migrate-housing-channels.cjs
 * 约束：只增量（新行/带默认值列），不改 jz_orders / jiazheng 域任何行。
 */
const mysql2 = require('mysql2/promise');

function getDbConfig() {
  const host = (process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '').trim();
  const database = (process.env.MYSQL_DB || process.env.JUZHU_DB_NAME || '').trim();
  const user = (process.env.MYSQL_USER || process.env.JUZHU_DB_USER || '').trim();
  const password = process.env.MYSQL_PASSWORD != null && process.env.MYSQL_PASSWORD !== ''
    ? process.env.MYSQL_PASSWORD
    : process.env.JUZHU_DB_PASSWORD;
  const port = parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10);
  if (!host || !database || !user || password == null || password === '') {
    throw new Error('MySQL env incomplete: set MYSQL_* or JUZHU_DB_*');
  }
  return { host, port, database, user, password, charset: 'utf8mb4' };
}

const CHANNEL_SEEDS = [
  ['bzf', '保租房专区', -1],
  ['rental', '长租', 0],
  ['trade', '卖旧买新专区', 2],
  ['jiazheng', '生活服务专区', 3],
  ['minsu', '民宿', 4],
  ['newhouse', '新房', 5],
  ['resale', '二手', 6],
];
const TOPIC_BZF = JSON.stringify({ label: '保租房专区', channel: 'rental', tags: ['保租房'] });

// housing 域商家（type 枚举扩展：housing_operator/lvju_host/developer/agent；platform=存量池）
const VENDOR_SEEDS = [
  { login: 'chengyu', type: 'housing_operator', name: '城寓资产管理（白名单运营商）', cityIds: '1', sort: 901 },
  { login: 'shanshe', type: 'lvju_host', name: '山舍旅居托管', cityIds: '3', sort: 902 },
  { login: 'yunqi', type: 'lvju_host', name: '云栖民宿', cityIds: '2,3', sort: 903 },
  { login: 'chengfa', type: 'developer', name: '城发置地', cityIds: '1', sort: 904 },
  { login: 'zhenfy', type: 'agent', name: '真房源经纪', cityIds: '1', sort: 905 },
];
const PLATFORM_VENDOR = { type: 'platform', name: '平台自营（待分配运营商）' };

// 演示项目：vendor login → 项目数组（units: [名称, 布局, 面积, 月租或总价]）
const PROJECT_SEEDS = [
  { vendor: 'shanshe', city: 3, district: 66, channel: 'rental', name: '山舍·青岩古镇院落', slug: 'shanshe-qingyan',
    tags: ['旅居', '候鸟', '康养'], priceFrom: 26800, cover: 'assets/lvju/qingyan.jpg',
    units: [['院落大床房', '一居一卫', 28, 28800], ['观山套房', '一居一厅', 42, 36800]] },
  { vendor: 'shanshe', city: 3, district: 65, channel: 'rental', name: '山舍·森林溪畔栈屋', slug: 'shanshe-forest',
    tags: ['旅居', '康养'], priceFrom: 21800, cover: 'assets/lvju/wanfenglin.jpg',
    units: [['溪畔双床房', '二居一卫', 26, 21800], ['栈屋大床房', '一居一卫', 32, 25800]] },
  { vendor: 'yunqi', city: 3, district: 65, channel: 'minsu', name: '云栖·观山整栋民宿', slug: 'yunqi-guanshan',
    tags: ['整栋', '星级'], priceFrom: 12800, cover: 'assets/lvju/guiyang-city.jpg',
    units: [['整栋四居', '四居三卫', 160, null, 128000], ['星级大床房', '一居一卫', 35, 15800]] },
  { vendor: 'yunqi', city: 3, district: 63, channel: 'minsu', name: '云栖·管家服务小院', slug: 'yunqi-guanjia',
    tags: ['管家', '星级'], priceFrom: 15800, cover: 'assets/lvju/xiaoqikong.jpg',
    units: [['小院套房', '一居一厅', 45, 16800], ['管家双床房', '二居一卫', 30, 13800]] },
  { vendor: 'yunqi', city: 2, district: 54, channel: 'minsu', name: '云栖·秦淮灯火民宿', slug: 'yunqi-qinhuai',
    tags: ['星级', '管家'], priceFrom: 9800, cover: 'assets/lvju/xijiang-night.jpg',
    units: [['灯火大床房', '一居一卫', 30, 9800], ['灯火亲子房', '二居一厅', 40, 13800]] },
  { vendor: 'chengyu', city: 1, district: 2, channel: 'rental', name: '城寓·青年里整租公寓', slug: 'chengyu-qingnianli',
    tags: ['长租', '整租', '月付'], priceFrom: 2380, cover: 'assets/juzhu/sy/projects/bzf/和平区/逸居雪莲店.jpg',
    units: [['青年里一居', '一居一卫', 45, 2380], ['青年里两居', '二居一厅', 68, 3480]] },
  { vendor: 'chengyu', city: 1, district: 5, channel: 'rental', name: '城寓·合租月付之家', slug: 'chengyu-hezu',
    tags: ['长租', '合租', '月付'], priceFrom: 980, cover: 'assets/juzhu/sy/projects/bzf/大东区/观泉店.jpg',
    units: [['四居南卧', '合租·南向', 18, 1080], ['四居北卧', '合租·北向', 15, 980]] },
  { vendor: 'chengfa', city: 1, district: 6, channel: 'newhouse', name: '城发·云璟台', slug: 'chengfa-yunjingtai',
    tags: ['楼盘', '特价房'], priceFrom: 1650000, cover: null,
    units: [['云璟台 89㎡ 三居', '三居两卫', 89, null, 1650000], ['云璟台 118㎡ 四居', '四居两卫', 118, null, 2190000]] },
  { vendor: 'chengfa', city: 1, district: 9, channel: 'newhouse', name: '城发·璟悦府', slug: 'chengfa-jingyuefu',
    tags: ['楼盘'], priceFrom: 1420000, cover: null,
    units: [['璟悦府 75㎡ 两居', '两居一卫', 75, null, 1420000], ['璟悦府 98㎡ 三居', '三居两卫', 98, null, 1780000]] },
  { vendor: 'zhenfy', city: 1, district: 4, channel: 'resale', name: '万科首府·两房在售', slug: 'zhenfy-wanke-shoufu',
    tags: ['在售', '真房源'], priceFrom: 1180000, cover: null,
    units: [['首府两房', '两居一卫', 76, null, 1180000], ['首府三房', '三居一卫', 98, null, 1450000]] },
  { vendor: 'zhenfy', city: 1, district: 7, channel: 'resale', name: '中海城·三房在售', slug: 'zhenfy-zhonghai',
    tags: ['在售', '真房源'], priceFrom: 1320000, cover: null,
    units: [['中海城三房', '三居两卫', 89, null, 1320000], ['中海城三房边户', '三居两卫', 105, null, 1560000]] },
];

const DISTRICT_NAMES = { 2: '和平区', 4: '沈北新区', 5: '沈河区', 6: '浑南区', 7: '皇姑区', 9: '铁西区',
  63: '云岩区', 64: '南明区', 65: '观山湖区', 66: '花溪区', 54: '秦淮区' };
const CITY_NAMES = { 1: '沈阳', 2: '南京', 3: '贵阳' };

function randPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

(async () => {
  const bcrypt = require('../node_modules/bcryptjs');
  const conn = await mysql2.createConnection(getDbConfig());
  const log = (...a) => console.log('[migrate]', ...a);

  // 1) 备份（快照表只建一次）
  for (const t of ['projects', 'units', 'jz_vendors']) {
    const bak = `${t}_bak_20260904`;
    const [ex] = await conn.query('SHOW TABLES LIKE ?', [bak]);
    if (!ex.length) {
      await conn.query(`CREATE TABLE \`${bak}\` AS SELECT * FROM \`${t}\``);
      log(`backup ${t} -> ${bak}`);
    } else {
      log(`backup ${bak} 已存在，跳过`);
    }
  }

  // 2) channels 数据行（bzf=保租房专区置首：首屏默认 tab，2026-09-05 按行政区磁力卡片方案恢复）
  for (const [id, label, order] of CHANNEL_SEEDS) {
    await conn.execute('INSERT IGNORE INTO channels(id,label,sort_order,enabled) VALUES (?,?,?,1)', [id, label, order]);
  }
  await conn.execute("UPDATE channels SET enabled=1, sort_order=-1 WHERE id='bzf'");
  log('channels ok; bzf 保租房专区置首（默认 tab）');

  // 3) topic_bzf 专题 KV
  await conn.execute('INSERT IGNORE INTO settings(`key`,value) VALUES (?,?)', ['topic_bzf', TOPIC_BZF]);
  log('settings topic_bzf ok');

  // 4) platform 池 + housing 商家
  let [pv] = await conn.execute('SELECT id FROM jz_vendors WHERE type=? AND name=? LIMIT 1',
    [PLATFORM_VENDOR.type, PLATFORM_VENDOR.name]);
  if (!pv.length) {
    const [r] = await conn.execute(
      'INSERT INTO jz_vendors(type,name,status,sort_order,created_at,updated_at) VALUES (?,?,?,300,?,?)',
      [PLATFORM_VENDOR.type, PLATFORM_VENDOR.name, 'active',
        new Date().toISOString().replace(/\.\d+Z$/, 'Z'), new Date().toISOString().replace(/\.\d+Z$/, 'Z')]);
    pv = await conn.execute('SELECT id FROM jz_vendors WHERE id=?', [r.insertId]).then((x) => x[0]);
    log(`platform vendor #${pv[0].id} created`);
  }
  const platformId = pv[0].id;

  const passwords = {};
  const vendorIdByLogin = {};
  for (const v of VENDOR_SEEDS) {
    const [ex] = await conn.execute('SELECT id FROM jz_vendors WHERE login_name=? LIMIT 1', [v.login]);
    if (ex.length) { vendorIdByLogin[v.login] = ex[0].id; continue; }
    const pwd = randPassword();
    const hash = bcrypt.hashSync(pwd, 10);
    const [r] = await conn.execute(
      'INSERT INTO jz_vendors(type,name,login_name,password_hash,city_ids,status,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [v.type, v.name, v.login, hash, v.cityIds, 'active', v.sort,
        new Date().toISOString().replace(/\.\d+Z$/, 'Z'), new Date().toISOString().replace(/\.\d+Z$/, 'Z')]);
    vendorIdByLogin[v.login] = r.insertId;
    passwords[v.login] = pwd;
    log(`vendor ${v.login} (#${r.insertId}, ${v.type}) created`);
  }

  // 5) 存量项目 owner 回挂：只动仍挂在 1(春晖家政) 上的 housing 行
  const [own] = await conn.execute(
    "UPDATE projects SET owner_vendor_id=? WHERE channel IN ('rental','trade') AND owner_vendor_id=1",
    [platformId]);
  if (own.affectedRows) log(`owner_vendor_id 1 -> ${platformId}: ${own.affectedRows} rows`);

  // 6) 演示项目 + 户型
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  for (const p of PROJECT_SEEDS) {
    const vid = vendorIdByLogin[p.vendor];
    if (!vid) { log(`skip ${p.slug}: vendor ${p.vendor} missing`); continue; }
    const districtName = DISTRICT_NAMES[p.district] || '';
    const address = districtName ? `${districtName} · ${p.name}` : `${CITY_NAMES[p.city] || ''} · ${p.name}`;
    await conn.execute(
      `INSERT IGNORE INTO projects(city_id,district_id,channel,name,slug,cover_image,address,tags,
        sort_order,unit_count,managed_unit_count,price_from,owner_vendor_id,status)
       VALUES (?,?,?,?,?,?,?,?,900,?, ?, ?, ?, 'online')`,
      [p.city, p.district, p.channel, p.name, p.slug, p.cover, address, JSON.stringify(p.tags),
        p.units.length, (p.channel === 'rental' ? p.units.length : null), p.priceFrom, vid]);
    const [pr] = await conn.execute('SELECT id FROM projects WHERE channel=? AND slug=?', [p.channel, p.slug]);
    const pid = pr[0].id;
    let unitSeq = 0;
    for (const [uname, layout, area, rent, total] of p.units) {
      unitSeq += 1;
      await conn.execute(
        `INSERT IGNORE INTO units(project_id,name,slug,area_sqm,layout_label,rent_monthly,price_total,tags,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [pid, uname, `${p.slug}-u${unitSeq}`, area, layout, rent || null, total || null,
          JSON.stringify(p.tags.slice(0, 2)), unitSeq]);
    }
    log(`project ${p.slug} (#${pid}, vendor ${p.vendor}, ${p.channel}) ok`);
  }

  // 汇总验证
  const [byChannel] = await conn.query("SELECT channel,COUNT(*) c FROM projects GROUP BY channel ORDER BY channel");
  const [byVendor] = await conn.query(
    `SELECT v.type, v.name, COUNT(p.id) c FROM projects p LEFT JOIN jz_vendors v ON v.id=p.owner_vendor_id
     GROUP BY v.id ORDER BY c DESC`);
  const [bzfRows] = await conn.query(
    `SELECT COUNT(*) c FROM projects WHERE channel='rental' AND tags LIKE '%"保租房"%'`);
  log('GROUP BY channel:', JSON.stringify(byChannel));
  log('GROUP BY vendor:', JSON.stringify(byVendor));
  log('topic-bzf 命中项目数:', bzfRows[0].c);
  if (Object.keys(passwords).length) {
    console.log('\n=== 新建商家登录账号（仅本次打印，请妥善保存）===');
    for (const [k, v] of Object.entries(passwords)) console.log(`  ${k}: ${v}`);
  }
  await conn.end();
})().catch((e) => { console.error('[migrate] FAIL:', e.message); process.exit(1); });
