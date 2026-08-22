// housing_seed.cjs — 保租房/卖旧买新 MySQL 种子（从 juzhu/data*.json 灌入）
// 仅在 cities 表为空时写入，幂等安全。
'use strict';

const fs = require('fs');
const path = require('path');

function enc(v) {
  if (v == null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function parseJsonField(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v !== 'string') return v;
  let cur = v;
  for (let i = 0; i < 8; i++) {
    if (typeof cur !== 'string') return cur;
    const s = cur.trim();
    if (!s) return cur;
    const looksJson = s.startsWith('[') || s.startsWith('{')
      || (s.startsWith('"') && s.endsWith('"') && s.length >= 2);
    if (!looksJson) return cur;
    try { cur = JSON.parse(s); } catch (_) { return cur; }
  }
  return cur;
}

function coerceTags(tags) {
  let v = parseJsonField(tags);
  if (Array.isArray(v)) {
    return v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    return s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

/** 管理端写入 tags：始终存 JSON 数组文本，避免对字符串再 JSON.stringify 套娃 */
function tagsToDb(tags) {
  if (tags == null || tags === '') return null;
  return JSON.stringify(coerceTags(tags));
}

function selectMissingUnits(snapUnits, projectIds, unitIds) {
  const proj = projectIds instanceof Set ? projectIds : new Set(projectIds || []);
  const have = unitIds instanceof Set ? unitIds : new Set(unitIds || []);
  return (snapUnits || []).filter((u) => {
    if (u == null || u.id == null) return false;
    if (!proj.has(Number(u.project_id))) return false;
    return !have.has(Number(u.id));
  });
}

function pickCoverPath(photos, entityType, entityId) {
  const id = Number(entityId);
  const list = (photos || []).filter((p) => (
    p && p.entity_type === entityType && Number(p.entity_id) === id
  )).slice().sort((a, b) => {
    const cover = (Number(b.is_cover) || 0) - (Number(a.is_cover) || 0);
    if (cover) return cover;
    const sort = (a.sort_order || 0) - (b.sort_order || 0);
    if (sort) return sort;
    return (a.id || 0) - (b.id || 0);
  });
  return (list[0] && list[0].file_path) || null;
}

function hydrateCoverFields(catalog) {
  if (!catalog) return catalog;
  const photos = catalog.photos || [];
  function fill(list, type) {
    (list || []).forEach((row) => {
      if (!row || row.cover_image) return;
      const path = pickCoverPath(photos, type, row.id);
      if (path) row.cover_image = path;
    });
  }
  fill(catalog.districts, 'district');
  fill(catalog.projects, 'project');
  fill(catalog.units, 'unit');
  return catalog;
}

function snapshotFiles(juzhuDir) {
  const names = ['data.json', 'data-nanjing.json', 'data-guiyang.json'];
  return names
    .map((n) => path.join(juzhuDir, n))
    .filter((p) => fs.existsSync(p));
}

function loadSnapshots(juzhuDir) {
  const cities = [];
  const districts = [];
  const projects = [];
  const units = [];
  const photos = [];
  const seenCity = new Set();
  for (const file of snapshotFiles(juzhuDir)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const city = data.city;
    if (city && city.id != null && !seenCity.has(Number(city.id))) {
      cities.push(city);
      seenCity.add(Number(city.id));
    }
    for (const row of data.districts || []) districts.push(row);
    for (const row of data.projects || []) projects.push(row);
    for (const row of data.units || []) units.push(row);
    for (const row of data.photos || []) photos.push(row);
  }
  return { cities, districts, projects, units, photos };
}

async function seedAll(conn, juzhuDir) {
  const dir = juzhuDir || path.join(__dirname, 'juzhu');
  // 以项目是否已有为准：cities 可能已有占位行（生产 sy2_full），不能因此跳过房源灌入
  const [[p]] = await conn.execute('SELECT COUNT(*) AS c FROM projects');
  if (Number(p.c) > 0) return { skipped: true };

  const snap = loadSnapshots(dir);
  let nCity = 0;
  for (const city of snap.cities) {
    await conn.execute(
      `INSERT INTO cities(id, name, slug, booking_phone, hero_bg_image)
       VALUES(?,?,?,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), slug=VALUES(slug),
         booking_phone=VALUES(booking_phone), hero_bg_image=VALUES(hero_bg_image)`,
      [city.id, city.name, city.slug, city.booking_phone || null, city.hero_bg_image || null]
    );
    nCity += 1;
  }

  let nDist = 0;
  for (const d of snap.districts) {
    await conn.execute(
      `INSERT INTO districts(id, city_id, name, slug, note, has_projects, sort_order,
        cover_image, project_count, unit_count, vacant_count, managed_unit_count,
        avg_price, is_hot, layout_tall, layout_wide, bg_class)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        d.id, d.city_id, d.name, d.slug, d.note || null,
        d.has_projects ? 1 : 0, d.sort_order || 0, d.cover_image || null,
        d.project_count || 0, d.unit_count || 0, d.vacant_count == null ? null : d.vacant_count,
        d.managed_unit_count == null ? null : d.managed_unit_count,
        d.avg_price == null ? null : d.avg_price,
        d.is_hot ? 1 : 0, d.layout_tall ? 1 : 0, d.layout_wide ? 1 : 0,
        d.bg_class || null,
      ]
    );
    nDist += 1;
  }

  let nProj = 0;
  for (const p of snap.projects) {
    await conn.execute(
      `INSERT INTO projects(id, city_id, district_id, channel, name, slug, cover_image,
        address, tags, sort_order, unit_count, managed_unit_count, price_from,
        is_featured, featured_rank, old_house_hint, rating_status, rating,
        rating_submitted_at, rating_reviewed_at, rating_note)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        p.id, p.city_id, p.district_id, p.channel, p.name, p.slug,
        p.cover_image || null, p.address || null, enc(p.tags),
        p.sort_order || 0, p.unit_count || 0,
        p.managed_unit_count == null ? null : p.managed_unit_count,
        p.price_from == null ? null : p.price_from,
        p.is_featured ? 1 : 0, p.featured_rank == null ? null : p.featured_rank,
        p.old_house_hint || null, p.rating_status || 'draft', enc(p.rating),
        p.rating_submitted_at || null, p.rating_reviewed_at || null, p.rating_note || null,
      ]
    );
    nProj += 1;
  }

  let nUnit = 0;
  for (const u of snap.units) {
    await conn.execute(
      `INSERT INTO units(id, project_id, name, slug, area_sqm, layout_label, rent_monthly,
        price_total, tags, unit_spec, promo_price, amenities, keeper, rent_detail,
        sort_order, cover_image)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        u.id, u.project_id, u.name, u.slug,
        u.area_sqm == null ? null : u.area_sqm,
        u.layout_label || null,
        u.rent_monthly == null ? null : u.rent_monthly,
        u.price_total == null ? null : u.price_total,
        enc(u.tags), u.unit_spec || null,
        u.promo_price == null ? null : u.promo_price,
        enc(u.amenities), enc(u.keeper), enc(u.rent_detail),
        u.sort_order || 0, u.cover_image || null,
      ]
    );
    nUnit += 1;
  }

  let nPhoto = 0;
  for (const p of snap.photos) {
    await conn.execute(
      `INSERT INTO photos(id, entity_type, entity_id, file_path, source_path, is_cover, sort_order)
       VALUES(?,?,?,?,?,?,?)`,
      [
        p.id, p.entity_type, p.entity_id, p.file_path,
        p.source_path || null, p.is_cover ? 1 : 0, p.sort_order || 0,
      ]
    );
    nPhoto += 1;
  }

  return {
    skipped: false,
    inserted: { cities: nCity, districts: nDist, projects: nProj, units: nUnit, photos: nPhoto },
  };
}

async function fillEmptyCoverColumn(conn, table, entityType) {
  const [empties] = await conn.execute(
    `SELECT id FROM ${table} WHERE cover_image IS NULL OR cover_image=''`
  );
  let n = 0;
  for (const row of empties || []) {
    const [ph] = await conn.execute(
      `SELECT file_path FROM photos WHERE entity_type=? AND entity_id=?
       ORDER BY is_cover DESC, sort_order, id LIMIT 1`,
      [entityType, row.id]
    );
    if (!ph.length || !ph[0].file_path) continue;
    const [r] = await conn.execute(
      `UPDATE ${table} SET cover_image=? WHERE id=? AND (cover_image IS NULL OR cover_image='')`,
      [ph[0].file_path, row.id]
    );
    n += r.affectedRows || 0;
  }
  return n;
}

/** 项目已存在时仍补缺失户型/图片，并回写空的 cover_image */
async function backfillPhotos(conn, juzhuDir) {
  const dir = juzhuDir || path.join(__dirname, 'juzhu');
  const snap = loadSnapshots(dir);
  const [projRows] = await conn.execute('SELECT id FROM projects');
  const [unitRows] = await conn.execute('SELECT id FROM units');
  const projectIds = new Set((projRows || []).map((r) => Number(r.id)));
  const unitIds = new Set((unitRows || []).map((r) => Number(r.id)));

  let nUnit = 0;
  for (const u of selectMissingUnits(snap.units, projectIds, unitIds)) {
    try {
      await conn.execute(
        `INSERT INTO units(id, project_id, name, slug, area_sqm, layout_label, rent_monthly,
          price_total, tags, unit_spec, promo_price, amenities, keeper, rent_detail,
          sort_order, cover_image)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          u.id, u.project_id, u.name, u.slug,
          u.area_sqm == null ? null : u.area_sqm,
          u.layout_label || null,
          u.rent_monthly == null ? null : u.rent_monthly,
          u.price_total == null ? null : u.price_total,
          enc(u.tags), u.unit_spec || null,
          u.promo_price == null ? null : u.promo_price,
          enc(u.amenities), enc(u.keeper), enc(u.rent_detail),
          u.sort_order || 0, u.cover_image || null,
        ]
      );
      nUnit += 1;
      unitIds.add(Number(u.id));
    } catch (_) { /* 主键/slug 冲突则跳过 */ }
  }

  let nPhoto = 0;
  for (const p of snap.photos) {
    const eid = Number(p.entity_id);
    if (p.entity_type === 'project' && !projectIds.has(eid)) continue;
    if (p.entity_type === 'unit' && !unitIds.has(eid)) continue;
    try {
      const [exist] = await conn.execute(
        'SELECT id FROM photos WHERE entity_type=? AND entity_id=? AND file_path=? LIMIT 1',
        [p.entity_type, p.entity_id, p.file_path]
      );
      if (exist.length) continue;
      await conn.execute(
        `INSERT INTO photos(entity_type, entity_id, file_path, source_path, is_cover, sort_order)
         VALUES(?,?,?,?,?,?)`,
        [p.entity_type, p.entity_id, p.file_path, p.source_path || null, p.is_cover ? 1 : 0, p.sort_order || 0]
      );
      nPhoto += 1;
    } catch (_) { /* 单条失败不中断后续封面回写 */ }
  }

  let nCover = 0;
  for (const u of snap.units) {
    if (!u.cover_image || !unitIds.has(Number(u.id))) continue;
    try {
      const [r] = await conn.execute(
        'UPDATE units SET cover_image=? WHERE id=? AND (cover_image IS NULL OR cover_image="")',
        [u.cover_image, u.id]
      );
      nCover += r.affectedRows || 0;
    } catch (_) { /* ignore */ }
  }
  nCover += await fillEmptyCoverColumn(conn, 'units', 'unit');
  nCover += await fillEmptyCoverColumn(conn, 'projects', 'project');
  nCover += await fillEmptyCoverColumn(conn, 'districts', 'district');

  for (const city of snap.cities) {
    if (!city.hero_bg_image) continue;
    try {
      const [r] = await conn.execute(
        'UPDATE cities SET hero_bg_image=? WHERE id=? AND (hero_bg_image IS NULL OR hero_bg_image="")',
        [city.hero_bg_image, city.id]
      );
      nCover += r.affectedRows || 0;
    } catch (_) { /* ignore */ }
  }

  return { inserted: nPhoto, covers: nCover, units: nUnit };
}

function decorateRow(row, jsonKeys) {
  if (!row) return row;
  const out = Object.assign({}, row);
  for (const k of jsonKeys) out[k] = parseJsonField(out[k]);
  return out;
}

module.exports = {
  enc,
  parseJsonField,
  coerceTags,
  tagsToDb,
  loadSnapshots,
  seedAll,
  backfillPhotos,
  decorateRow,
  selectMissingUnits,
  pickCoverPath,
  hydrateCoverFields,
};
