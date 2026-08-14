// housing_cities.cjs — 保租房/卖旧买新城市 CRUD 纯函数（不连库）
'use strict';

function slugifyCity(name) {
  const trimmed = String(name || '').replace(/[（(].*?[）)]/g, '').trim();
  return trimmed.replace(/\s+/g, '-') || 'city';
}

function validateCityWrite(body, opts) {
  const partial = !!(opts && opts.partial);
  const raw = body || {};
  const hasName = Object.prototype.hasOwnProperty.call(raw, 'name');
  const name = hasName || !partial ? String(raw.name || '').trim() : '';

  if (!partial) {
    if (!name) return { ok: false, error: '城市名称不能为空', status: 400 };
  } else if (hasName && !name) {
    return { ok: false, error: '城市名称不能为空', status: 400 };
  }

  const fields = {};
  if (name) fields.name = name;

  if (Object.prototype.hasOwnProperty.call(raw, 'slug')) {
    const slug = String(raw.slug || '').trim();
    if (slug) fields.slug = slug;
    else if (name) fields.slug = slugifyCity(name);
  } else if (name) {
    fields.slug = slugifyCity(name);
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'booking_phone')) {
    fields.booking_phone = String(raw.booking_phone || '').trim() || null;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'hero_bg_image')) {
    fields.hero_bg_image = String(raw.hero_bg_image || '').trim() || null;
  }

  if (partial && !Object.keys(fields).length) {
    return { ok: false, error: '无更新字段', status: 400 };
  }
  return { ok: true, fields };
}

function canDeleteCity(counts) {
  const cityCount = Number(counts && counts.cityCount) || 0;
  const districtCount = Number(counts && counts.districtCount) || 0;
  const projectCount = Number(counts && counts.projectCount) || 0;
  if (cityCount <= 1) return { ok: false, error: '至少保留一座城市', status: 400 };
  if (districtCount > 0) {
    return { ok: false, error: `该城市仍有 ${districtCount} 个行政区，无法删除`, status: 400 };
  }
  if (projectCount > 0) {
    return { ok: false, error: `该城市仍有 ${projectCount} 个项目，无法删除`, status: 400 };
  }
  return { ok: true };
}

function pickCity(cities, hint) {
  const list = Array.isArray(cities) ? cities : [];
  if (!list.length) return null;
  const h = String(hint || '').trim();
  if (!h) return list[0];
  return list.find((c) => c && (c.slug === h || c.name === h || String(c.id) === h)) || null;
}

function duplicateCityError(kind) {
  if (kind === 'name') return { ok: false, error: '城市名称已存在', status: 400 };
  if (kind === 'slug') return { ok: false, error: 'slug 已存在', status: 400 };
  return { ok: false, error: '城市已存在', status: 400 };
}

function classifyDupKey(err) {
  const msg = String((err && err.message) || err || '');
  const code = err && err.code;
  const isDup = code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(msg);
  if (!isDup) return null;
  if (/uk_slug|for key .*slug/i.test(msg)) return 'slug';
  if (/uk_name|for key .*name/i.test(msg)) return 'name';
  return 'dup';
}

module.exports = {
  slugifyCity,
  validateCityWrite,
  canDeleteCity,
  pickCity,
  duplicateCityError,
  classifyDupKey,
};
