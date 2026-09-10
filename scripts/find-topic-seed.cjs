#!/usr/bin/env node
/**
 * 找房专题（topic）seed —— settings KV：key = topic_<slug>，value = JSON {label, tags, channel?}
 * 服务端已支持 GET /api/juzhu/catalog?topic=<slug>（catalog 路由按 KV 的 channel/tags 条件过滤，
 * 见 app.js「topic 定义存 settings KV」）。专题标签取自库内真实 tag（候鸟/康养/亲子/整栋），
 * 不设 channel 约束以便跨频道命中（如「整栋」同时命中 rental/minsu）。
 * bzf（保租房专区）已由既有种子定义（规则 15），本脚本不覆盖。
 * 用法：node scripts/find-topic-seed.cjs seed|clean
 * 规则12/14：只用 Node + mysql2；凭证只读环境变量（juzhu/.env.local → JUZHU_DB_* / MYSQL_*）
 * 幂等：INSERT IGNORE（同名 key 不改写）；clean 只删本脚本 slug 清单内的行。
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

const TOPICS = [
  { slug: 'houniao',   label: '候鸟过冬', tags: ['候鸟'] },
  { slug: 'kangyang',  label: '康养度假', tags: ['康养'] },
  { slug: 'qinzi',     label: '亲子研学', tags: ['亲子'] },
  { slug: 'zhengdong', label: '整栋包栋', tags: ['整栋'] },
];

async function main() {
  const mode = process.argv[2] || 'seed';
  if (mode !== 'seed' && mode !== 'clean') {
    console.error('用法：node scripts/find-topic-seed.cjs seed|clean');
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
  const keys = TOPICS.map((t) => 'topic_' + t.slug);
  if (mode === 'clean') {
    const [r] = await c.execute('DELETE FROM settings WHERE `key` IN (' + keys.map(() => '?').join(',') + ')', keys);
    console.log('clean: 删除 ' + r.affectedRows + ' 行（仅本脚本 slug 清单）');
  } else {
    for (const t of TOPICS) {
      await c.execute(
        'INSERT IGNORE INTO settings(`key`, value) VALUES (?, ?)',
        ['topic_' + t.slug, JSON.stringify({ label: t.label, tags: t.tags })]
      );
      console.log('seed: topic_' + t.slug + ' ← ' + t.label + ' tags=' + t.tags.join('/'));
    }
    console.log('（bzf 保租房专区不在本脚本范围，既有定义未触碰）');
  }
  await c.end();
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
