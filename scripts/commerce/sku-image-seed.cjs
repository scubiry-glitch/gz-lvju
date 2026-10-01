#!/usr/bin/env node
// C9 商品主图管线：给演示批次（payload.initialization.mode==='demo'）的已发布 snapshot 写 image 字段。
// 管线：commerce_versions.snapshot.image → /catalog 与 /promotion/products 透传 → 卡片封面/详情 hero 消费，
//       onerror 回落品类图标。同步实体 payload，避免下次发布回滚掉 image。
// 2026-10-02 起不再一刀切盖同一张 living.webp（整墙同图观感差），改为按实体映射：
//   有合适实拍的范围仓库复用（搬家=蓝犀牛横幅、餐饮/景点=lvju 实拍、酒店通兑=房态照、旅居=living.webp），
//   其余服务品类本地生成品牌海报 SVG（CAT_THEME 品类色 + 品类图标 + 该券服务短名）到
//   assets/commerce/posters/<slug>.svg —— 一券一图，确定性可重跑。
// 用法：node scripts/commerce/sku-image-seed.cjs [--apply] [--clean] [--set /assets/...]
//   缺省=按映射表写；--set 强制全部同一张（保留旧用法）；--clean 还原无图态。
'use strict';
const fs = require('fs');
const path = require('path');
const { createPool } = require('../../commerce/db.cjs');

const ROOT = path.resolve(__dirname, '../..');
const POSTER_DIR = path.join(ROOT, 'assets/commerce/posters');
const COVER_DIR = '/assets/commerce/covers';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const clean = args.includes('--clean');
const setIdx = args.indexOf('--set');
const forceImage = setIdx >= 0 ? args[setIdx + 1] : null;
const KINDS = [['skus', 'commerce_skus'], ['packages', 'commerce_packages'], ['plans', 'commerce_plans']];
// 参与配图的实体：演示打标（initialization.mode/is_demo）或名字带演示/尊享版的种子夹具
// （M0/M1 手工种的 99003/24-26 无任何 payload 标记，只能按名单放行；真实商品不会叫这些名字）。
const FIXTURE_NAME_RE = /演示|尊享版/;

// ── 品类主题：色取 screens/_jzapi.js CAT_THEME（单一数据源，勿另造色值）；en 为角标 kicker。
const THEMES = {
  cleaning:      { brand: '#0f766e', brand2: '#14b8a6', deep: '#0b5d56', en: 'HOME CLEANING' },
  repair:        { brand: '#ea580c', brand2: '#fb923c', deep: '#bf4b13', en: 'HOME REPAIR' },
  nanny:         { brand: '#7c3aed', brand2: '#a78bfa', deep: '#4d2579', en: 'HOME CARE' },
  telecom:       { brand: '#1d4e89', brand2: '#60a5fa', deep: '#123a66', en: 'BROADBAND' },
  health_care:   { brand: '#0e7490', brand2: '#67e8f9', deep: '#0a5568', en: 'WELLNESS' },
  home_maintain: { brand: '#3f6212', brand2: '#a3e635', deep: '#2d4a0c', en: 'MAINTENANCE' },
  asset:         { brand: '#1e3a5f', brand2: '#93c5fd', deep: '#152a45', en: 'ASSESSMENT' },
  moving:        { brand: '#1678ff', brand2: '#168FFA', deep: '#0E61FF', en: 'MOVING' },
  community:     { brand: '#6d28d9', brand2: '#c4b5fd', deep: '#4c1d95', en: 'COMMUNITY' },
  recycle:       { brand: '#166534', brand2: '#86efac', deep: '#0f4a26', en: 'GREEN LIVING' },
  online:        { brand: '#0f172a', brand2: '#64748b', deep: '#020617', en: 'ONLINE SERVICE' },
  gift:          { brand: '#8c6224', brand2: '#c9a24b', deep: '#6b4a1a', en: 'BENEFITS' },
  member:        { brand: '#0f1a4d', brand2: '#8ba3e0', deep: '#0a1028', en: 'MEMBERSHIP' }
};
// 24×24 描边图标（stroke 由模板统一给白），线宽 1.7、圆角端点。
const ICONS = {
  cleaning: '<path d="M12 3l1.9 4.7L18.6 9.6l-4.7 1.9L12 16.2l-1.9-4.7L5.4 9.6l4.7-1.9z"/><path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  repair: '<path d="M14.9 6.2a4.2 4.2 0 0 0-5.6 5.6L4 17.1V20h2.9l5.3-5.3a4.2 4.2 0 0 0 5.6-5.6l-2.7 2.7-2.6-.6-.6-2.6z"/>',
  nanny: '<path d="M12 20.4S4.6 15.6 2.9 11.5C1.6 8.3 3.7 5.4 6.8 5.4c2.1 0 3.7 1.1 5.2 3.2 1.5-2.1 3.1-3.2 5.2-3.2 3.1 0 5.2 2.9 3.9 6.1C19.4 15.6 12 20.4 12 20.4z"/>',
  telecom: '<path d="M4 9.6c4.6-4 11.4-4 16 0"/><path d="M7 13.1c3-2.6 7-2.6 10 0"/><circle cx="12" cy="17" r="1.6"/>',
  health_care: '<circle cx="12" cy="12" r="8.6"/><path d="M12 8.2v7.6M8.2 12h7.6"/>',
  home_maintain: '<path d="M12 3.2l7 2.9v5.8c0 4.3-2.9 7.2-7 8.9-4.1-1.7-7-4.6-7-8.9V6.1z"/><path d="M9 12l2.1 2.1L15.3 10"/>',
  asset: '<path d="M4 11l8-7 8 7"/><path d="M6.2 9.6V19h11.6V9.6"/><path d="M10 19v-5.2h4V19"/>',
  community: '<path d="M12 21c-4.1-4.3-6.6-7.5-6.6-10.7a6.6 6.6 0 0 1 13.2 0C18.6 13.5 16.1 16.7 12 21z"/><circle cx="12" cy="10.2" r="2.4"/>',
  recycle: '<path d="M6.2 18C6.2 10.4 12 5.4 18.8 5.2c.2 7.6-4.6 13-12.6 12.8z"/><path d="M6.2 18c1.9-4.8 5.6-7.9 9.4-9"/>',
  online: '<path d="M4.5 13v-2a7.5 7.5 0 0 1 15 0v2"/><rect x="3.5" y="12.6" width="4" height="6.4" rx="1.6"/><rect x="16.5" y="12.6" width="4" height="6.4" rx="1.6"/><path d="M19 19.2c0 1.6-1.6 2.4-4 2.4"/>',
  gift: '<rect x="4.2" y="10.4" width="15.6" height="9.4" rx="1.4"/><path d="M3.4 7.4h17.2v3H3.4zM12 7.4V19.8"/><path d="M12 7.4C10.4 3.6 6 3.7 6 6.1c0 1.6 2.9 1.5 6 1.3zm0 0c1.6-3.8 6-3.7 6-1.3 0 1.6-2.9 1.5-6 1.3z"/>',
  member: '<path d="M4.4 16.6L2.8 7.8 8.2 11.6 12 4.9l3.8 6.7 5.4-3.8-1.6 8.8z"/><path d="M5.4 19.6h13.2"/>',
  moving: '<path d="M3 7h9v9H3z"/><path d="M12 10h4.2l2.8 3v3H12"/><circle cx="7" cy="18" r="1.8"/><circle cx="16.5" cy="18" r="1.8"/>'
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 演示名 → 海报短名："跨城搬家 · 厢货 · 单品券（演示）" → "跨城搬家 · 厢货"
function shortName(name) {
  return (name || '').replace(/（演示）/g, '').replace(/·?\s*单品券/g, '').replace(/·?\s*券包/g, '').replace(/·?\s*体验包/g, '').replace(/\s*·\s*$/, '').trim() || '生活权益';
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function posterSvg(slug, label, themeKey, place) {
  const t = THEMES[themeKey] || THEMES.cleaning;
  const v = hash(slug) % 3;
  // 画布 1600×900 = 卡面 16:9 原生比例，object-fit:cover 不裁任何元素；
  // 详情 hero 更竖时左右轻微裁切，主体居中不受影响。
  // place：线上类券右侧有竖排「线上核销」签 → 标签移到左上（缺省右下）。
  const lx = place?.lx ?? 1520, ly = place?.ly ?? 688, anchor = place?.anchor ?? 'end';
  const fs_ = label.length > 9 ? 72 : label.length > 6 ? 80 : 88;
  const decor = [
    '<circle cx="1370" cy="130" r="330" fill="#ffffff" opacity=".07"/><circle cx="180" cy="770" r="230" fill="none" stroke="#ffffff" stroke-width="3" opacity=".15"/><path d="M0 640 L1600 430 L1600 900 L0 900 Z" fill="#ffffff" opacity=".05"/>',
    '<circle cx="150" cy="120" r="260" fill="#ffffff" opacity=".07"/><circle cx="1450" cy="760" r="250" fill="none" stroke="#ffffff" stroke-width="3" opacity=".15"/><path d="M0 250 L1600 480 L1600 900 L0 900 Z" fill="#ffffff" opacity=".05"/>',
    '<circle cx="1240" cy="720" r="320" fill="#ffffff" opacity=".07"/><circle cx="360" cy="160" r="200" fill="none" stroke="#ffffff" stroke-width="3" opacity=".15"/><path d="M0 520 L1600 640 L1600 900 L0 900 Z" fill="#ffffff" opacity=".05"/>'
  ][v];
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" role="img" aria-label="' + esc(label) + '">' +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.deep}"/><stop offset=".55" stop-color="${t.brand}"/><stop offset="1" stop-color="${t.brand2}"/></linearGradient></defs>` +
    `<rect width="1600" height="900" fill="url(#g)"/>` + decor +
    `<g transform="translate(800,392)" stroke="#ffffff" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".96">` +
    `<g transform="translate(-110,-110) scale(9.2)">${ICONS[themeKey] || ICONS.gift}</g></g>` +
    `<text x="112" y="140" font-size="30" letter-spacing="10" fill="#ffffffb3" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${t.en}</text>` +
    `<text x="${lx}" y="${ly}" text-anchor="${anchor}" font-size="${fs_}" font-weight="600" fill="#ffffff" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(label)}</text>` +
    `<rect x="${anchor === 'end' ? lx - 72 : lx + 2}" y="${ly + 24}" width="72" height="6" rx="3" fill="#ffffff" opacity=".72"/>` +
    '</svg>';
}

// ── 实体 → 封面映射（有序，先命中先用）。返回 {path(以 / 开头) | poster:{slug,label,theme}} ──
function coverFor(p) {
  const slug = p.channel_slug || p.initialization?.channel_slug || '';
  const cat = p.category_id || '';
  const topic = p.topic_id || p.initialization?.topic_id || '';
  const name = p.name || '';
  const tier = p.exchange_tier || '';
  const isSku = !p.items && p.retail_minor !== undefined;
  const label = shortName(name);
  // 实拍复用
  if (cat === 'moving' || slug.startsWith('moving')) return { poster: { slug: slug || 'demo-moving', label, theme: 'moving' } };
  if (cat === 'dining' || /餐饮|风味/.test(name)) return { path: '/assets/lvju/food-banquet.jpg' };
  if (cat === 'scenic_ticket' || /景点|漫游/.test(name)) return { path: '/assets/lvju/huangguoshu.jpg' };
  if (cat === 'hotel_exchange' || tier) {
    const t = ({ t80: 't80', t100: 't100', t120: 't120', t160: 't160', t180: 't180', t200: 't200' })[tier] || 't100';
    return { path: `${COVER_DIR}/hotel-${t}.jpg` };
  }
  if (/^新旅居尊享|新旅居会员/.test(name)) return { path: '/assets/lvju/wanfenglin.jpg' };
  if (cat === 'community' && (/travel$/.test(slug) || /旅居/.test(name))) return { path: '/assets/commerce/living.webp' };
  if (topic === 'new-home' || /新居入住/.test(name)) return { path: '/assets/commerce/living.webp' };
  if (/酒店通兑体验/.test(name)) return { path: `${COVER_DIR}/hotel-t160.jpg` };
  // 海报：主题键 → slug 级 SVG
  let theme = null;
  if (cat === 'cleaning' || /保洁|清洁/.test(name)) theme = 'cleaning';
  else if (cat === 'repair' || /维修|检修|疏通|安装/.test(name)) theme = 'repair';
  else if (cat === 'nanny' || /保姆|月嫂|育儿|养老|陪护|护理|钟点工/.test(name)) theme = 'nanny';
  else if (cat === 'telecom' || /宽带/.test(name)) theme = 'telecom';
  else if (cat === 'health_care' || /体检|康养/.test(name)) theme = 'health_care';
  else if (cat === 'home_maintain' || /保养|养护/.test(name)) theme = 'home_maintain';
  else if (cat === 'asset' || topic === 'asset' || /资产|评估|安心包/.test(name)) theme = 'asset';
  else if (cat === 'recycle' || topic === 'green' || /绿色|焕新|回收/.test(name)) theme = 'recycle';
  else if (cat === 'online_service' || /线上/.test(name)) theme = 'online';
  // 线上核销券卡面右侧有竖排「线上核销」签，海报标签放左上（y=548 在左下徽章区 566 之上）
  if (theme === 'online') return { poster: { slug: slug || ('demo-' + (cat || theme) + '-' + (hash(label) % 9999)), label, theme, lx: 96, ly: 548, anchor: 'start' } };
  else if (topic === 'neighbor' || cat === 'community' || /邻里|代办|跑腿|社区/.test(name)) theme = 'community';
  else if (topic === 'care' || /康养到家/.test(name)) theme = 'health_care';
  else if (kindOf(p) === 'plans' || /会员/.test(name)) theme = 'member';
  else if (/礼包|券包|安居/.test(name)) theme = 'gift';
  // 无 channel_slug 的实体按 名字哈希 取文件名：同名单名共享一张（同城双城一致），
  // 异名不同文件——否则共享 slug 的两张海报互相覆盖、文件内容每次运行翻转。
  if (theme) return { poster: { slug: slug || ('demo-' + (cat || topic || theme) + '-' + (hash(label) % 9999)), label, theme } };
  return { poster: { slug: 'demo-gift-' + (hash(label) % 9999), label, theme: 'gift' } };
}
function kindOf(p) { return p.items && p.price_minor !== undefined && p.valid_days !== undefined ? 'plans' : (p.items ? 'packages' : 'skus'); }

(async () => {
  const pool = createPool();
  let hit = 0, changed = 0, posters = 0;
  const preview = [];
  for (const [kind, table] of KINDS) {
    const [rows] = await pool.query(`SELECT e.id, e.published_version, e.payload FROM ${table} e WHERE e.published_version IS NOT NULL`);
    for (const r of rows) {
      let payload, published;
      try { payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload; } catch { continue; }
      if (!(payload && (payload.initialization?.mode === 'demo' || payload.is_demo === true || FIXTURE_NAME_RE.test(payload.name || '')))) continue;
      const [vs] = await pool.query('SELECT snapshot FROM commerce_versions WHERE kind=? AND entity_id=? AND version=? LIMIT 1', [kind, r.id, r.published_version]);
      if (!vs.length) continue;
      try { published = typeof vs[0].snapshot === 'string' ? JSON.parse(vs[0].snapshot) : vs[0].snapshot; } catch { continue; }
      hit++;
      let after;
      if (clean) after = null;
      else if (forceImage) after = forceImage;
      else {
        const c = coverFor(payload);
        if (c.poster) {
          const file = path.join(POSTER_DIR, c.poster.slug + '.svg');
          const svg = posterSvg(c.poster.slug, c.poster.label, c.poster.theme, c.poster);
          if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== svg) {
            if (apply) { fs.mkdirSync(POSTER_DIR, { recursive: true }); fs.writeFileSync(file, svg); }
            posters++;
          }
          after = '/assets/commerce/posters/' + c.poster.slug + '.svg';
        } else after = c.path;
      }
      if (preview.length < 130) preview.push([kind, (payload.name || '').slice(0, 22), after]);
      if ((published.image || null) === after) continue;
      changed++;
      if (after === null) { delete published.image; delete payload.image; } else { published.image = after; payload.image = after; }
      if (apply) {
        await pool.execute('UPDATE commerce_versions SET snapshot=? WHERE kind=? AND entity_id=? AND version=?', [JSON.stringify(published), kind, r.id, r.published_version]);
        await pool.execute(`UPDATE ${table} SET payload=? WHERE id=?`, [JSON.stringify(payload), r.id]);
      }
    }
  }
  preview.forEach((x) => console.log(x.join('  →  ')));
  console.log(`demo products: ${hit}, posters ${apply ? 'written' : 'pending'}: ${posters}, to ${apply ? (clean ? 'clean' : forceImage ? 'set ' + forceImage : 'map') : 'inspect'}: changed=${changed}${apply ? '' : ' (dry-run, add --apply)'}`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
