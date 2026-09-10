#!/usr/bin/env node
/**
 * 旅游路线（routes）seed/clean —— 内容域演示数据（规则 19）
 * 路线 = spots 的有序编排（站点复用 scripts/spots-seed.cjs 的既有地点，不复制内容）；
 * cover_image 留空 = C 端回落首个有点位的封面，与 spots 同图源不重复维护。
 * 用法：node scripts/routes-seed.cjs seed|clean
 * 规则12/14：只用 Node + mysql2；凭证只读环境变量（juzhu/.env.local → JUZHU_DB_* / MYSQL_*）
 * 幂等：seed 按 slug ON DUPLICATE KEY UPDATE（可重跑刷新）；clean 只删本脚本 slug 清单内的行。
 */
const path = require('path');
const fs = require('fs');
// 手动加载 env（不覆盖语义=先到先得，.env.local 最先加载）——同 lvju-stay-seed.cjs
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

// 站点全部取自 spots-seed.cjs 的既有 slug；note 为该站行程提示（非正文）
const ROUTES = [
  { slug: 'guiyang-leisure-2d', name: '筑城慢享 · 古镇两日', days: 2, sort_order: 10,
    summary: '青岩古镇住下来，慢慢逛集市、吃小吃、喝咖啡，次日顺十里河滩湿地收尾，节奏松弛适合首刷。',
    stops: [
      { slug: 'qingyan-ancient-town', note: 'Day1 下午 · 古镇石板街 + 城墙日落' },
      { slug: 'qingyan-north-market', note: 'Day1 傍晚 · 北门集市备手信' },
      { slug: 'qingyan-food-lane', note: 'Day1 晚餐 · 南门美食巷' },
      { slug: 'qingyan-cafe', note: 'Day1 夜 · 南城门院落咖啡' },
      { slug: 'huaxi-beef-noodle', note: 'Day2 早 · 花溪牛肉粉开局' },
      { slug: 'shilihetan-wetland', note: 'Day2 上午 · 十里河滩骑行收尾' },
    ] },
  { slug: 'guiyang-soak-2d', name: '温泉山水 · 候鸟两日', days: 2, sort_order: 20,
    summary: '息烽温泉泡汤过夜，次日香纸沟竹林徒步、红枫湖看湖，候鸟康养节奏，适合连住旅居客。',
    stops: [
      { slug: 'xifeng-hot-spring', note: 'Day1 全天 · 温泉汤院泡汤' },
      { slug: 'xifeng-food-street', note: 'Day1 晚餐 · 县城食街' },
      { slug: 'xiangzhigou', note: 'Day2 上午 · 香纸沟竹林徒步' },
      { slug: 'hongfeng-hu', note: 'Day2 下午 · 红枫湖环湖' },
    ] },
  { slug: 'guiyang-family-1d', name: '亲子山水 · 一日', days: 1, sort_order: 30,
    summary: '南江峡谷轻徒步 + 桃源河玩水，回程带娃逛阳明文化园，一日闭环不赶路。',
    stops: [
      { slug: 'nanjiang-canyon', note: '上午 · 峡谷栈道轻徒步' },
      { slug: 'taoyuanhe', note: '午后 · 桃源河亲水' },
      { slug: 'yangming-culture-park', note: '傍晚 · 阳明文化园研学收尾' },
    ] },
];

async function main() {
  const mode = process.argv[2] || 'seed';
  if (mode !== 'seed' && mode !== 'clean') {
    console.error('用法：node scripts/routes-seed.cjs seed|clean');
    process.exit(1);
  }
  const c = await mysql.createConnection({
    host: process.env.JUZHU_DB_HOST || process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.JUZHU_DB_PORT || process.env.MYSQL_PORT || '3306', 10),
    user: process.env.JUZHU_DB_USER || process.env.MYSQL_USER || 'root',
    password: process.env.JUZHU_DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
    database: process.env.JUZHU_DB_NAME || process.env.MYSQL_DB || 'juzhu',
    charset: 'utf8mb4',
  });
  const [city] = await c.execute('SELECT id FROM cities WHERE slug=? LIMIT 1', [CITY_SLUG]);
  if (!city.length) throw new Error('找不到城市 ' + CITY_SLUG + '（先跑 housing_seed）');
  const cityId = city[0].id;

  if (mode === 'clean') {
    const slugs = ROUTES.map((r) => r.slug);
    const [r] = await c.execute('DELETE FROM routes WHERE slug IN (' + slugs.map(() => '?').join(',') + ')', slugs);
    console.log('clean: 删除 ' + r.affectedRows + ' 条（仅本脚本 slug 清单）');
  } else {
    // slug → spot_id 解析（站点必须在库：先跑 spots-seed）
    const missing = [];
    for (const r of ROUTES) {
      for (const s of r.stops) {
        const [sp] = await c.execute('SELECT id FROM spots WHERE slug=? LIMIT 1', [s.slug]);
        if (!sp.length) { missing.push(s.slug); continue; }
        s.spot_id = sp[0].id;
      }
    }
    if (missing.length) throw new Error('以下站点不在 spots 表（先跑 scripts/spots-seed.cjs seed）：' + missing.join(', '));
    for (const r of ROUTES) {
      await c.execute(
        'INSERT INTO routes(city_id, slug, name, summary, cover_image, days, stops, sort_order, enabled) VALUES (?,?,?,?,NULL,?,?,?,1)' +
        ' ON DUPLICATE KEY UPDATE city_id=VALUES(city_id), name=VALUES(name), summary=VALUES(summary), days=VALUES(days), stops=VALUES(stops), sort_order=VALUES(sort_order), enabled=1',
        [cityId, r.slug, r.name, r.summary, r.days,
         JSON.stringify(r.stops.map((s) => ({ spot_id: s.spot_id, note: s.note }))), r.sort_order]
      );
      console.log('seed: ' + r.slug + ' ← ' + r.name + '（' + r.stops.length + ' 站 / ' + r.days + ' 天）');
    }
  }
  await c.end();
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
