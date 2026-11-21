// rating_scheme_db.cjs — 评价体系的 settings KV 覆盖读取 + 房源体系解析（admin/vendor_api/api_direct 共用，勿两侧各写一份）。
// KV key：rating_scheme_scopes（{schemeKey:{channels,cities}} 覆盖注册表默认 scope）、
//         rating_gzlvju_grades（[{min,grade}] 覆盖贵州体系分级线）。
'use strict';

async function loadRatingOverrides(queryRows) {
  const rows = await queryRows('SELECT `key`, value FROM settings WHERE `key` IN (?, ?)', [
    'rating_scheme_scopes', 'rating_gzlvju_grades',
  ]);
  const out = { scopes: null, grades: null };
  for (const r of rows || []) {
    try {
      const v = JSON.parse(r.value);
      if (r.key === 'rating_scheme_scopes' && v && typeof v === 'object') out.scopes = v;
      if (r.key === 'rating_gzlvju_grades' && Array.isArray(v) && v.length) out.grades = v;
    } catch (_) { /* 脏 KV 忽略，回注册表默认 */ }
  }
  return out;
}

/**
 * 房源生效体系解析：显式 schemeKey（body 指定 > 房源 rating_scheme 列）> channel 默认。
 * 返回 { ok:true, schemeKey, scheme } 或 { ok:false, status, error }（不存在/范围不含该房源）。
 * projectRow 须含 channel（city_name 可选，用于城市 scope 校验）。
 */
function resolveForProject(ratingCfg, projectRow, wantedKey, overrides) {
  const channel = projectRow.channel;
  const explicit = wantedKey || projectRow.rating_scheme || null;
  const schemeKey = explicit
    ? (ratingCfg.schemeOf(explicit) ? explicit : null)
    : ratingCfg.resolveSchemeKey(null, channel);
  if (!schemeKey) return { ok: false, status: 400, error: '评价体系不存在: ' + explicit };
  const scheme = ratingCfg.schemeOf(schemeKey);
  const ctx = { channel, cityName: projectRow.city_name || null };
  if (!ratingCfg.schemeAppliesTo(schemeKey, ctx, overrides && overrides.scopes)) {
    return { ok: false, status: 400, error: `评价体系「${scheme.name}」不适用于该房源（频道/城市不在适用范围）` };
  }
  return { ok: true, schemeKey, scheme };
}

module.exports = { loadRatingOverrides, resolveForProject };
