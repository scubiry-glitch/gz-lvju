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
  const s = v.trim();
  if (!s) return v;
  if (!(s.startsWith('[') || s.startsWith('{'))) return v;
  try { return JSON.parse(s); } catch (_) { return v; }
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
  const [[c]] = await conn.execute('SELECT COUNT(*) AS c FROM cities');
  if (Number(c.c) > 0) return { skipped: true };

  const snap = loadSnapshots(dir);
  let nCity = 0;
  for (const city of snap.cities) {
    await conn.execute(
      `INSERT INTO cities(id, name, slug, booking_phone, hero_bg_image)
       VALUES(?,?,?,?,?)`,
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

function decorateRow(row, jsonKeys) {
  if (!row) return row;
  const out = Object.assign({}, row);
  for (const k of jsonKeys) out[k] = parseJsonField(out[k]);
  return out;
}

module.exports = {
  enc,
  parseJsonField,
  loadSnapshots,
  seedAll,
  decorateRow,
};
