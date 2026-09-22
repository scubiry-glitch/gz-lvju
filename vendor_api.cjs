// vendor_api.cjs — 商家 HMAC 开放接口（对齐 api_doc.md）
// 家政：/api/juzhu/jiazheng/vendor/*；房源：/api/juzhu/housing/vendor/*（同一套 HMAC 鉴权）
'use strict';

const hmacAuth = require('./hmac_auth.cjs');
const grOrders = require('./gr_orders.cjs');
const stayCfg = require('./stay_config.cjs');
const ratingCfg = require('./rating_config.cjs');
const photoCfg = require('./photo_config.cjs');
const roomProfileCfg = require('./room_profile.cjs');
const MIN_PUBLISH_PHOTOS = photoCfg.PHOTO_MIN_PUBLISH;   // 单一数据源 photo_config.cjs（改阈值只改那一处）

function reply(status, data) {
  return { status, data };
}

function verifyVendorAuth(body, vendors) {
  const vendorIdStr = String((body && body.vendor_id) || '').trim();
  if (!vendorIdStr) return { error: '缺少 vendor_id 参数' };
  if (!vendors || !Object.keys(vendors).length) return { error: '服务端未配置任何 vendor 密钥' };
  const vendor = vendors[vendorIdStr];
  if (!vendor) return { error: `vendor_id=${vendorIdStr} 的密钥未配置` };
  const checked = hmacAuth.verifySignature(vendor.key, body);
  if (!checked.ok) return { error: '签名校验失败: ' + checked.message };
  const vendorId = parseInt(vendorIdStr, 10);
  if (!Number.isFinite(vendorId)) return { error: `vendor_id 格式无效: ${vendorIdStr}` };
  return { vendorId };
}

function parseCityIds(raw) {
  const ids = [];
  String(raw || '').split(',').forEach((part) => {
    const s = part.trim();
    if (/^\d+$/.test(s)) ids.push(parseInt(s, 10));
  });
  return ids;
}

async function vendorCityIds(conn, vendorId) {
  const [rows] = await conn.execute('SELECT city_ids FROM jz_vendors WHERE id=?', [vendorId]);
  return parseCityIds(rows[0] && rows[0].city_ids);
}

function validateProductCitySync(cityId, allowedIds) {
  if (cityId == null || (typeof cityId === 'string' && !String(cityId).trim())) {
    return { ok: false, err: '缺少 city_id' };
  }
  const cid = parseInt(cityId, 10);
  if (!Number.isFinite(cid)) return { ok: false, err: 'city_id 非法' };
  if (!allowedIds.includes(cid)) return { ok: false, err: 'city_id 不属于该商家' };
  return { ok: true, cityId: cid };
}

function levelNum(lv) {
  const n = parseInt(String(lv || '').replace(/^[Ll]/, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

// api_doc.md 约定商家开放接口金额单位为「分」，而库内 jz_products.price 与 C 端展示均为「元」，
// 故在 vendor 接口边界做双向换算：入参分→元存储，出参元→分返回（对齐文档示例 29900 = 299 元）。
function centsToYuan(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) / 100 : null;
}

function yuanToCents(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// 商家产品出参：price / original_price 元→分
function productPriceOut(item) {
  if (item.price != null) item.price = yuanToCents(item.price);
  if (item.original_price != null) item.original_price = yuanToCents(item.original_price);
  return item;
}

async function setProductWorkers(conn, productId, workerIds) {
  await conn.execute('DELETE FROM jz_sku_workers WHERE product_id=?', [productId]);
  const [minRows] = await conn.execute(
    `SELECT sk.worker_min_level FROM jz_products p
     LEFT JOIN jz_skus sk ON sk.id=p.channel_sku_id WHERE p.id=?`,
    [productId]
  );
  const minLv = minRows[0] ? levelNum(minRows[0].worker_min_level) : 0;
  for (const raw of workerIds || []) {
    const wid = parseInt(raw, 10);
    if (!Number.isFinite(wid)) continue;
    if (minLv) {
      const [wl] = await conn.execute('SELECT level FROM jz_workers WHERE id=?', [wid]);
      if (!wl.length || levelNum(wl[0].level) < minLv) continue;
    }
    await conn.execute(
      'INSERT IGNORE INTO jz_sku_workers(product_id, worker_id) VALUES (?,?)',
      [productId, wid]
    );
  }
}

async function attachProductExtras(conn, item) {
  if (item.channel_sku_id) {
    const [srows] = await conn.execute('SELECT name FROM jz_skus WHERE id=?', [item.channel_sku_id]);
    item.spu_name = srows[0] ? srows[0].name : null;
  } else {
    item.spu_name = null;
  }
  const [wrows] = await conn.execute(
    'SELECT worker_id FROM jz_sku_workers WHERE product_id=?',
    [item.id]
  );
  item.worker_ids = wrows.map((w) => w.worker_id);
  return item;
}

async function citiesList(conn, vendorId) {
  const ids = await vendorCityIds(conn, vendorId);
  if (!ids.length) return reply(200, { code: 0, message: 'success', list: [] });
  const marks = ids.map(() => '?').join(',');
  const [rows] = await conn.execute(
    `SELECT id, name, slug FROM cities WHERE id IN (${marks})`,
    ids
  );
  const order = {};
  ids.forEach((id, i) => { order[id] = i; });
  const cities = rows.slice().sort((a, b) => (order[a.id] == null ? 99 : order[a.id]) - (order[b.id] == null ? 99 : order[b.id]));
  return reply(200, { code: 0, message: 'success', list: cities });
}

async function categoriesList(conn) {
  const [rows] = await conn.execute(
    'SELECT id, id AS parent_type, name, icon, sort_order FROM jz_categories WHERE enabled=1 ORDER BY sort_order, id'
  );
  return reply(200, { code: 0, message: 'success', list: rows });
}

async function skusList(conn) {
  const [rows] = await conn.execute(
    `SELECT id, category_id, name, slug, spec, price_from, price_unit,
            duration_min, tags, badges, worker_min_level
     FROM jz_skus WHERE enabled=1 ORDER BY sort_order, id`
  );
  return reply(200, { code: 0, message: 'success', list: rows });
}

async function productsList(conn, body, vendorId) {
  let sql = `SELECT p.*, v.name AS vendor_name, v.type AS vendor_type, c.name AS city_name
             FROM jz_products p LEFT JOIN jz_vendors v ON v.id=p.vendor_id
             LEFT JOIN cities c ON c.id=p.city_id
             WHERE p.vendor_id=?`;
  const params = [vendorId];
  const category = String((body && body.category) || '').trim();
  if (category) { sql += ' AND p.category=?'; params.push(category); }
  const status = String((body && body.status) || '').trim();
  if (status) { sql += ' AND p.status=?'; params.push(status); }
  if (body && body.city_id != null && body.city_id !== '') {
    sql += ' AND p.city_id=?';
    params.push(parseInt(body.city_id, 10));
  }
  const name = String((body && body.name) || '').trim();
  if (name) { sql += ' AND p.title LIKE ?'; params.push('%' + name + '%'); }
  sql += ' ORDER BY p.sort_order, p.id';
  const [rows] = await conn.execute(sql, params);
  for (const it of rows) await attachProductExtras(conn, it);
  rows.forEach(productPriceOut);
  return reply(200, { code: 0, message: 'success', list: rows });
}

async function productsDetail(conn, body, vendorId) {
  const pid = body && body.id;
  if (!pid) return reply(400, { code: 400, message: '缺少 id 参数' });
  const [rows] = await conn.execute(
    `SELECT p.*, c.name AS city_name FROM jz_products p
     LEFT JOIN cities c ON c.id=p.city_id
     WHERE p.id=? AND p.vendor_id=?`,
    [parseInt(pid, 10), vendorId]
  );
  if (!rows.length) return reply(404, { code: 404, message: '产品不存在或不属于该商家' });
  await attachProductExtras(conn, rows[0]);
  productPriceOut(rows[0]);
  return reply(200, { code: 0, message: 'success', product: rows[0] });
}

function jsonTags(v) {
  if (v == null) return JSON.stringify([]);
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

async function createProduct(conn, data) {
  const [result] = await conn.execute(
    `INSERT INTO jz_products
       (vendor_id, city_id, title, subtitle, category, duration_hours, area_range, unit,
        price, original_price, discount_label, earliest_time, advance_booking_hours,
        sales_count, rating, service_tags, channel_sku_id, path, query, status, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      parseInt(data.vendor_id, 10) || 0,
      data.city_id ? parseInt(data.city_id, 10) : null,
      data.title || '',
      data.subtitle || '',
      data.category || '',
      data.duration_hours == null || data.duration_hours === '' ? 0 : Number(data.duration_hours),
      data.area_range || '',
      data.unit || '次',
      data.price == null || data.price === '' ? 0 : centsToYuan(data.price),
      data.original_price == null || data.original_price === '' ? null : centsToYuan(data.original_price),
      data.discount_label || '',
      data.earliest_time || '',
      parseInt(data.advance_booking_hours, 10) || 0,
      parseInt(data.sales_count, 10) || 0,
      data.rating == null || data.rating === '' ? 0 : Number(data.rating),
      jsonTags(data.service_tags || []),
      data.channel_sku_id ? parseInt(data.channel_sku_id, 10) : null,
      data.path || '',
      data.query || '',
      data.status || 'on',
      data.sort_order == null || data.sort_order === '' ? 99 : parseInt(data.sort_order, 10),
    ]
  );
  const pid = result.insertId;
  if (Object.prototype.hasOwnProperty.call(data, 'worker_ids')) {
    await setProductWorkers(conn, pid, data.worker_ids || []);
  }
  return pid;
}

const PRODUCT_UPDATE_FIELDS = [
  'vendor_id', 'city_id', 'title', 'subtitle', 'category', 'duration_hours', 'area_range',
  'unit', 'price', 'original_price', 'discount_label', 'earliest_time',
  'advance_booking_hours', 'sales_count', 'rating', 'service_tags',
  'channel_sku_id', 'path', 'query', 'status', 'sort_order',
];

async function updateProduct(conn, pid, data) {
  const fields = [];
  const params = [];
  for (const k of PRODUCT_UPDATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
    let v = data[k];
    if (k === 'service_tags') v = jsonTags(v);
    else if (k === 'channel_sku_id' || k === 'city_id') v = v ? parseInt(v, 10) : null;
    else if (k === 'price') v = v == null || v === '' ? 0 : centsToYuan(v);            // 商家传入分→库存元
    else if (k === 'original_price') v = v == null || v === '' ? null : centsToYuan(v); // 同上
    fields.push('`' + k + '`=?');
    params.push(v);
  }
  let ok = true;
  if (fields.length) {
    params.push(pid);
    const [result] = await conn.execute(
      `UPDATE jz_products SET ${fields.join(', ')} WHERE id=?`,
      params
    );
    ok = result.affectedRows > 0;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'worker_ids')) {
    await setProductWorkers(conn, pid, data.worker_ids || []);
    ok = true;
  }
  return ok;
}

async function productsCreate(conn, body, vendorId) {
  const allowed = await vendorCityIds(conn, vendorId);
  const checked = validateProductCitySync(body && body.city_id, allowed);
  if (!checked.ok) return reply(400, { code: 400, message: checked.err });
  const data = Object.assign({}, body, { vendor_id: vendorId, city_id: checked.cityId });
  const pid = await createProduct(conn, data);
  return reply(200, { code: 0, message: 'success', id: pid });
}

async function productsUpdate(conn, body, vendorId) {
  const pid = body && body.id;
  if (!pid) return reply(400, { code: 400, message: '缺少 id 参数' });
  const [rows] = await conn.execute(
    'SELECT id FROM jz_products WHERE id=? AND vendor_id=?',
    [parseInt(pid, 10), vendorId]
  );
  if (!rows.length) return reply(404, { code: 404, message: '产品不存在或不属于该商家' });
  if (body.city_id != null) {
    const allowed = await vendorCityIds(conn, vendorId);
    const checked = validateProductCitySync(body.city_id, allowed);
    if (!checked.ok) return reply(400, { code: 400, message: checked.err });
  }
  const data = Object.assign({}, body);
  delete data.vendor_id;
  delete data.id;
  const ok = await updateProduct(conn, parseInt(pid, 10), data);
  return reply(200, { code: 0, message: ok ? 'success' : '未变更' });
}

async function productsStatus(conn, body, vendorId) {
  const pid = body && body.id;
  const status = String((body && body.status) || '').trim();
  if (!pid) return reply(400, { code: 400, message: '缺少 id 参数' });
  if (['on', 'off', 'sold_out'].indexOf(status) < 0) {
    return reply(400, { code: 400, message: 'status 须为 on / off / sold_out' });
  }
  const [result] = await conn.execute(
    'UPDATE jz_products SET status=? WHERE id=? AND vendor_id=?',
    [status, parseInt(pid, 10), vendorId]
  );
  if (!result.affectedRows) return reply(404, { code: 404, message: '产品不存在或不属于该商家' });
  return reply(200, { code: 0, message: 'success' });
}

async function productsDelete(conn, body, vendorId) {
  const pid = body && body.id;
  if (!pid) return reply(400, { code: 400, message: '缺少 id 参数' });
  const [result] = await conn.execute(
    "UPDATE jz_products SET status='off' WHERE id=? AND vendor_id=? AND status!='off'",
    [parseInt(pid, 10), vendorId]
  );
  if (!result.affectedRows) {
    return reply(404, { code: 404, message: '产品不存在、不属于该商家或已是下架状态' });
  }
  return reply(200, { code: 0, message: 'success' });
}

async function handleCallback(conn, body, vendorId) {
  const parsed = grOrders.validateCallbackBody(body);
  if (!parsed.ok) return reply(parsed.status, { code: parsed.code, message: parsed.message });
  let order;
  if (parsed.status === 'paid') order = await grOrders.getOrderByRef(conn, parsed.orderRef);
  else order = await grOrders.getOrderByRefAndVendor(conn, parsed.orderRef, parsed.vendorOid);
  if (!order && parsed.status !== 'paid') {
    // 容错：商家跳过 paid 回调直接推后续状态时，订单 vendor_oid 尚为 NULL 联合查询落空。
    // 按 order_ref 回退 + vendor_id 归属校验（vendorId 来自 HMAC 验签，可信，防跨商家篡改他人订单），
    // 命中则回填 vendor_oid 后按正常链路重查。
    const fallback = await grOrders.getOrderByRef(conn, parsed.orderRef);
    if (fallback && fallback.vendor_id === vendorId && !fallback.vendor_oid) {
      await grOrders.backfillVendorOid(conn, parsed.orderRef, parsed.vendorOid, vendorId);
      order = await grOrders.getOrderByRefAndVendor(conn, parsed.orderRef, parsed.vendorOid);
    }
  }
  if (!order) return reply(404, { code: 404, message: '订单不存在' });
  await grOrders.updateOrderCallback(conn, {
    order_ref: parsed.orderRef,
    vendor_oid: parsed.vendorOid,
    status: parsed.status,
    fee: parsed.fee,
    worker_name: parsed.worker && parsed.worker.name,
    worker_phone: parsed.worker && parsed.worker.phone,
    eta: parsed.worker && parsed.worker.eta ? grOrders.normEtaPeking(parsed.worker.eta) : null,
    cancel_reason: parsed.cancelReason,
    vendor_id: vendorId,
  });
  return reply(200, { code: 0, message: 'success' });
}

const VENDOR_ROUTES = {
  '/api/juzhu/jiazheng/vendor/cities/list': (conn, body, vendorId) => citiesList(conn, vendorId),
  '/api/juzhu/jiazheng/vendor/categories/list': (conn, body, vendorId) => categoriesList(conn, vendorId),
  '/api/juzhu/jiazheng/vendor/skus/list': (conn, body, vendorId) => skusList(conn, vendorId),
  '/api/juzhu/jiazheng/vendor/products/list': productsList,
  '/api/juzhu/jiazheng/vendor/products/detail': productsDetail,
  '/api/juzhu/jiazheng/vendor/products/create': productsCreate,
  '/api/juzhu/jiazheng/vendor/products/update': productsUpdate,
  '/api/juzhu/jiazheng/vendor/products/status': productsStatus,
  '/api/juzhu/jiazheng/vendor/products/delete': productsDelete,
};

// ============================================================
// 房源开放接口（/api/juzhu/housing/vendor/*）
// 与会话态 /api/juzhu/vendor/* 同一库、同一口径：owner_vendor_id 隔离、
// 上架=projects.status、保险/最短连住走 projects.ext（stay_config 单一数据源）
// ============================================================

function stripContactPhone(row) {
  if (!row) return row;
  const out = Object.assign({}, row);
  delete out.contact_phone;
  return out;
}

function slugifyName(name) {
  return (String(name || '').replace(/[（(].*?[）)]/g, '').trim().replace(/\s+/g, '-')) || 'item';
}

async function uniqueProjectSlug(conn, channel, name, want) {
  const base = String(want || '').trim() || slugifyName(name);
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const [rows] = await conn.execute(
      'SELECT id FROM projects WHERE channel=? AND slug=? LIMIT 1', [channel, slug]);
    if (!rows.length) return slug;
    slug = base + '-' + i;
  }
  return base + '-' + Date.now();
}

async function uniqueUnitSlug(conn, projectId, name, want) {
  const base = String(want || '').trim() || slugifyName(name);
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const [rows] = await conn.execute(
      'SELECT id FROM units WHERE project_id=? AND slug=? LIMIT 1', [projectId, slug]);
    if (!rows.length) return slug;
    slug = base + '-' + i;
  }
  return base + '-' + Date.now();
}

function tagsToDb(v) {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean));
  return JSON.stringify(String(v).split(',').map((x) => x.trim()).filter(Boolean));
}

function phoneFromBody(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!/^1\d{10}$/.test(s)) throw new Error('contact_phone 须为 11 位手机号');
  return s;
}

/** 商家自有房源校验：不存在/非本商家 → 404（不泄露他人房源存在性） */
async function ownProject(conn, vendorId, pid) {
  const [rows] = await conn.execute('SELECT * FROM projects WHERE id=?', [parseInt(pid, 10)]);
  if (!rows.length || rows[0].owner_vendor_id !== vendorId) return null;
  return rows[0];
}

/** 上架前置检查：返回 { error, warnings }——error 非空即阻断上架；warnings 随成功响应回给商家 */
async function publishEligibility(conn, row) {
  const [vendors] = await conn.execute('SELECT status, review_status FROM jz_vendors WHERE id=?', [row.owner_vendor_id]);
  const vendor = vendors[0];
  if (!vendor || vendor.status !== 'active' || (vendor.review_status && vendor.review_status !== 'approved')) {
    return { error: '商家尚未通过审核或已停用' };
  }
  if (row.rating_status !== 'passed') return { error: '房源审核/评级未通过，不能上架' };
  // 价格闸（2026-09）：price_from 改为选填——改成逐个户型校验「默认夜价 > 0」
  // （户型 price_night > 月租/30 > 房源起价/30，见 stay_config.unitNightPrice）。
  // 传了起价的房源全部户型自动继承，行为与旧闸一致；不传起价则每个户型须自带价。
  const [units] = await conn.execute(
    'SELECT id, name, rent_monthly, ext FROM units WHERE project_id=? ORDER BY sort_order, id', [row.id]);
  if (!units.length) return { error: '上架前须至少创建 1 个户型（units/create）' };
  const unpriced = units.filter((u) => !(stayCfg.unitNightPrice(row, u) > 0));
  if (unpriced.length) {
    return { error: '上架前须设置价格：' + unpriced.map((u) => u.name || ('#' + u.id)).join('、')
      + ' 缺夜价（price_night）或月租（rent_monthly），且房源未设置 price_from' };
  }
  const [ph] = await conn.execute(`SELECT COUNT(*) AS c, MAX(is_cover) AS has_cover FROM photos
    WHERE (entity_type='project' AND entity_id=?) OR (entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id=?))`, [row.id, row.id]);
  if (!ph[0] || Number(ph[0].c) < MIN_PUBLISH_PHOTOS) return { error: `上架前须至少上传 ${MIN_PUBLISH_PHOTOS} 张房源照片` };
  if (!row.cover_image && !Number(ph[0].has_cover || 0)) return { error: '上架前须设置房源封面图' };
  // 图集抽检（2026-09）：真拉取前 N 张核对大小/分辨率——封面优先
  const check = await spotCheckPhotos(conn, row.id);
  if (check.error) return { error: check.error };
  return { error: null, warnings: check.warnings };
}

/** 抽检取数：封面 + 排序靠前的图，最多 photo_config.PHOTO_SPOT_CHECK 张
 *  （LIMIT 用内联常量：预编译语句下 `LIMIT ?` 传 number 会被 MySQL 拒） */
async function spotCheckPhotos(conn, projectId) {
  const [rows] = await conn.execute(
    `SELECT file_path FROM photos
      WHERE (entity_type='project' AND entity_id=?)
         OR (entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id=?))
      ORDER BY is_cover DESC, entity_type, entity_id, sort_order, id LIMIT ${photoCfg.PHOTO_SPOT_CHECK}`,
    [projectId, projectId]);
  return photoCfg.spotCheck(rows.map((r) => r.file_path));
}

async function vendorAllowedCityIds(conn, vendorId) {
  const ids = await vendorCityIds(conn, vendorId);
  return ids; // 空 = 未配置城市约束（不限制）
}

/** 城市/行政区枚举（city_id / district_id 选值主数据）：限商家开放城市；city_ids 空 = 不限（出全量） */
async function housingRegionsList(conn, body, vendorId) {
  const allowed = await vendorCityIds(conn, vendorId);
  let cityRows;
  if (allowed.length) {
    const marks = allowed.map(() => '?').join(',');
    [cityRows] = await conn.execute(`SELECT id, name, slug FROM cities WHERE id IN (${marks}) ORDER BY id`, allowed);
  } else {
    [cityRows] = await conn.execute('SELECT id, name, slug FROM cities ORDER BY id');
  }
  if (!cityRows.length) return reply(200, { code: 0, message: 'success', list: [], total: 0 });
  const marks = cityRows.map(() => '?').join(',');
  const [distRows] = await conn.execute(
    `SELECT id, city_id, name, slug FROM districts WHERE city_id IN (${marks}) ORDER BY city_id, sort_order, id`,
    cityRows.map((c) => c.id));
  const list = cityRows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, districts: [] }));
  const byCity = new Map(list.map((c) => [c.id, c]));
  for (const d of distRows) {
    const c = byCity.get(d.city_id);
    if (c) c.districts.push({ id: d.id, name: d.name, slug: d.slug });
  }
  return reply(200, { code: 0, message: 'success', list, total: list.length });
}

/** 房源透出对象：脱敏 + 房态配置 + 展示价三件套（disp 由 priceDisplayOf 求得，与 C 端卡片同口径） */
function housingProjectOut(row, disp) {
  const out = stripContactPhone(Object.assign({}, row));
  Object.assign(out, stayCfg.stayConfigOf(row));
  Object.assign(out, disp || { price_from_display: null, price_unit: null, price_note: '' });
  return out;
}

/** 单房源透出（含展示价三件套）：create / update / status 的响应统一走这里 */
async function housingProjectOutOne(conn, row) {
  const lows = await displayPricesOf(conn, [row]);
  return housingProjectOut(row, stayCfg.priceDisplayOf(row, lows.get(row.id)));
}

/** 批量求「最低可售单夜价」（Map<project_id, number|null>）：一次查户型 + 一次查房态差异行 */
async function displayPricesOf(conn, projects) {
  const ids = projects.map((p) => p.id);
  let units = [];
  if (ids.length) {
    [units] = await conn.execute(
      `SELECT id, project_id, rent_monthly, total_qty, ext FROM units WHERE project_id IN (${ids.map(() => '?').join(',')})`,
      ids);
  }
  return stayCfg.priceDisplayScan(connRows(conn), projects, units);
}

async function housingProjectsList(conn, body, vendorId) {
  let sql = `SELECT p.*, d.name AS district_name, c.name AS city_name
             FROM projects p
             LEFT JOIN districts d ON d.id=p.district_id
             LEFT JOIN cities c ON c.id=p.city_id
             WHERE p.owner_vendor_id=?`;
  const params = [vendorId];
  const b = body || {};
  if (b.channel) { sql += ' AND p.channel=?'; params.push(String(b.channel)); }
  if (b.status) { sql += ' AND p.status=?'; params.push(String(b.status)); }
  if (b.city_id != null && b.city_id !== '') { sql += ' AND p.city_id=?'; params.push(parseInt(b.city_id, 10)); }
  const kw = String(b.keyword || '').trim();
  if (kw) { sql += ' AND p.name LIKE ?'; params.push('%' + kw + '%'); }
  sql += ' ORDER BY p.sort_order, p.id DESC LIMIT 200';
  const [rows] = await conn.execute(sql, params);
  const list = [];
  const lows = await displayPricesOf(conn, rows);
  for (const r of rows) list.push(housingProjectOut(r, stayCfg.priceDisplayOf(r, lows.get(r.id))));
  return reply(200, { code: 0, message: 'success', list, total: list.length });
}

async function housingProjectsDetail(conn, body, vendorId) {
  const pid = body && body.id;
  if (!pid) return reply(400, { code: 400, message: '缺少 id 参数' });
  const row = await ownProject(conn, vendorId, pid);
  if (!row) return reply(404, { code: 404, message: '房源不存在或不属于该商家' });
  const [units] = await conn.execute('SELECT * FROM units WHERE project_id=? ORDER BY sort_order, id', [row.id]);
  const lows = await displayPricesOf(conn, [row]);
  return reply(200, {
    code: 0, message: 'success',
    project: housingProjectOut(row, stayCfg.priceDisplayOf(row, lows.get(row.id))),
    units: units.map((u) => unitOut(u, row)),
  });
}

/** ext 组装：保险标识 + 最短连住（stay_config 校验），未知 key 直接报错 */
function extFromBody(body, baseExt, channel) {
  let ext = Object.assign({}, stayCfg.parseExtObj(baseExt));
  if (Object.prototype.hasOwnProperty.call(body, 'insurance')) {
    if (body.insurance === null || body.insurance === '') ext.insurance = [];
    else if (Array.isArray(body.insurance)) {
      const unknown = body.insurance.map(String).filter((k) => !stayCfg.INSURANCE_KEYS.includes(k));
      if (unknown.length) throw new Error('insurance 含未知标识: ' + unknown.join(',') + '（可用: ' + stayCfg.INSURANCE_KEYS.join('/') + '）');
      ext.insurance = body.insurance.map(String);
    } else throw new Error('insurance 须为标识数组: ' + stayCfg.INSURANCE_KEYS.join('/'));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'min_stay_nights')) {
    if (body.min_stay_nights === null || body.min_stay_nights === '') delete ext.min_stay_nights;
    else {
      ext.min_stay_nights = stayCfg.normalizeMinStayNightsInput(body.min_stay_nights, channel);
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'default_closed')) {
    if (body.default_closed === null || body.default_closed === '') delete ext.default_closed;
    else if (stayCfg.normalizeDefaultClosedInput(body.default_closed)) ext.default_closed = true; else delete ext.default_closed;
  }
  // 审核通过后自动上架（2026-09-22 商家诉求 3.1）：true = 评级复核通过即由平台自动推 online
  //（仍走同一套上架闸与图片抽检；闸不过保持 draft，原因随 rating.reviewed webhook 带回）
  if (Object.prototype.hasOwnProperty.call(body, 'auto_publish')) {
    if (body.auto_publish === true || body.auto_publish === 'true') ext.auto_publish = true;
    else delete ext.auto_publish;
  }
  ext = stayCfg.applyTransactionCapabilities(ext, body, channel);
  return ext;
}

const PROJECT_UPDATABLE_COLS = ['name', 'address', 'cover_image', 'sort_order', 'price_from',
  'is_featured', 'featured_rank', 'old_house_hint', 'unit_count', 'managed_unit_count'];

async function createUnit(conn, projectId, channel, priceFrom, u) {
  const name = String((u && u.name) || '').trim();
  if (!name) throw new Error('户型 name 必填');
  const slug = await uniqueUnitSlug(conn, projectId, name, u.slug);
  let totalQty = 1;
  if (u.total_qty != null && u.total_qty !== '') {
    totalQty = parseInt(u.total_qty, 10);
    if (!(totalQty >= 1 && totalQty <= 999)) throw new Error('units[].total_qty（总间数）须为 1-999 的整数');
  }
  let ext = {};
  if (u.price_night != null && u.price_night !== '') {
    const pn = parseInt(u.price_night, 10);
    if (!(pn >= 0)) throw new Error('units[].price_night 须为非负整数（元/晚）');
    ext.price_night = pn;
  }
  // 最短连住（2026-09 下放户型）：户型级 > 房源级 > 频道默认，下限按频道校验
  if (u.min_stay_nights != null && u.min_stay_nights !== '') {
    try { ext.min_stay_nights = stayCfg.normalizeMinStayNightsInput(u.min_stay_nights, channel); }
    catch (e) { throw new Error('units[].' + e.message); }
  }
  // 默认关房（2026-09 方案 B 配套）：未推送放出的日期默认不可订，多渠道商家防超售
  if (u.default_closed != null && u.default_closed !== '') {
    try { if (stayCfg.normalizeDefaultClosedInput(u.default_closed)) ext.default_closed = true; }
    catch (e) { throw new Error('units[].' + e.message); }
  }
  // 房间档案（Excel 房源字段）：字段清单 / 长度 / 枚举校验在 room_profile.cjs（单一数据源）
  if (u.room_profile != null && u.room_profile !== '') {
    try { roomProfileCfg.mergeRoomProfileIntoExt(ext, u.room_profile); }
    catch (e) { throw new Error('units[].' + e.message); }
  }
  const [r] = await conn.execute(
    `INSERT INTO units(project_id, name, slug, area_sqm, layout_label, rent_monthly, price_total,
       tags, unit_spec, promo_price, total_qty, amenities, sort_order, cover_image, ext)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      projectId, name, slug,
      u.area_sqm == null || u.area_sqm === '' ? null : Number(u.area_sqm),
      u.layout_label || null,
      u.rent_monthly == null || u.rent_monthly === '' ? null : parseInt(u.rent_monthly, 10),
      u.price_total == null || u.price_total === '' ? null : parseInt(u.price_total, 10),
      tagsToDb(u.tags), u.unit_spec || null,
      u.promo_price == null || u.promo_price === '' ? null : parseInt(u.promo_price, 10),
      totalQty,
      tagsToDb(u.amenities),
      u.sort_order == null || u.sort_order === '' ? 99 : parseInt(u.sort_order, 10),
      u.cover_image || null,
      Object.keys(ext).length ? JSON.stringify(ext) : null,
    ]
  );
  return r.insertId;
}

async function housingProjectsCreate(conn, body, vendorId) {
  const b = body || {};
  const name = String(b.name || '').trim();
  if (!name) return reply(400, { code: 400, message: 'name 必填' });
  const channel = String(b.channel || 'rental');
  if (!stayCfg.HOUSING_CHANNELS.includes(channel)) {
    return reply(400, { code: 400, message: 'channel 须为 ' + stayCfg.HOUSING_CHANNELS.join('/') });
  }
  const cityId = parseInt(b.city_id, 10);
  if (!cityId) return reply(400, { code: 400, message: 'city_id 必填' });
  const [city] = await conn.execute('SELECT id, name FROM cities WHERE id=?', [cityId]);
  if (!city.length) return reply(400, { code: 400, message: 'city_id 不存在' });
  const allowed = await vendorAllowedCityIds(conn, vendorId);
  if (allowed.length && !allowed.includes(cityId)) {
    return reply(400, { code: 400, message: 'city_id 不属于该商家开放城市' });
  }
  let districtId = b.district_id != null && b.district_id !== '' ? parseInt(b.district_id, 10) : null;
  if (districtId) {
    const [d] = await conn.execute('SELECT id FROM districts WHERE id=? AND city_id=?', [districtId, cityId]);
    if (!d.length) return reply(400, { code: 400, message: 'district_id 不存在或不属于该城市' });
  }
  let contactPhone;
  try { contactPhone = phoneFromBody(b.contact_phone); }
  catch (e) { return reply(400, { code: 400, message: e.message }); }
  let ext;
  try { ext = extFromBody(b, {}, channel); }
  catch (e) { return reply(400, { code: 400, message: e.message }); }
  const status = b.status == null || b.status === '' ? 'draft' : String(b.status);
  if (['online', 'offline', 'draft'].indexOf(status) < 0) {
    return reply(400, { code: 400, message: 'status 须为 online / offline / draft（缺省 draft）' });
  }
  if (status === 'online') return reply(400, { code: 400, message: '新建房源必须先保存为 draft，完成商家/房源审核后再上架' });
  const slug = await uniqueProjectSlug(conn, channel, name, b.slug);
  const address = String(b.address || '').trim() || (city[0].name + ' · ' + name);
  const [r] = await conn.execute(
    `INSERT INTO projects(city_id, district_id, channel, name, slug, cover_image, address, tags,
       sort_order, unit_count, price_from, is_featured, old_house_hint, contact_phone,
       owner_vendor_id, status, ext)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      cityId, districtId, channel, name, slug, b.cover_image || null, address, tagsToDb(b.tags),
      b.sort_order == null || b.sort_order === '' ? 999 : parseInt(b.sort_order, 10),
      Array.isArray(b.units) ? b.units.length : 0,
      b.price_from == null || b.price_from === '' ? null : parseInt(b.price_from, 10),
      0, b.old_house_hint || null, contactPhone,
      vendorId, status, Object.keys(ext).length ? JSON.stringify(ext) : null,
    ]
  );
  const pid = r.insertId;
  for (const u of (Array.isArray(b.units) ? b.units : [])) {
    try { await createUnit(conn, pid, channel, b.price_from, u); }
    catch (e) { return reply(400, { code: 400, message: 'units 创建失败：' + e.message, project_id: pid }); }
  }
  const row = await ownProject(conn, vendorId, pid);
  return reply(200, { code: 0, message: 'success', project: await housingProjectOutOne(conn, row) });
}

async function housingProjectsUpdate(conn, body, vendorId) {
  const b = body || {};
  if (!b.id) return reply(400, { code: 400, message: '缺少 id 参数' });
  const row = await ownProject(conn, vendorId, b.id);
  if (!row) return reply(404, { code: 404, message: '房源不存在或不属于该商家' });
  const sets = [], params = [];
  if (b.name != null && String(b.name).trim()) {
    sets.push('name=?'); params.push(String(b.name).trim());
    sets.push('slug=?'); params.push(await uniqueProjectSlug(conn, row.channel, b.name, b.slug));
  } else if (b.slug) {
    sets.push('slug=?'); params.push(await uniqueProjectSlug(conn, row.channel, row.name, b.slug));
  }
  for (const col of PROJECT_UPDATABLE_COLS) {
    if (col === 'name') continue;
    if (Object.prototype.hasOwnProperty.call(b, col)) {
      let v = b[col];
      if (['sort_order', 'price_from', 'unit_count', 'managed_unit_count', 'featured_rank'].includes(col)) {
        v = v == null || v === '' ? null : parseInt(v, 10);
      } else if (col === 'is_featured') {
        v = v ? 1 : 0;
      } else if (v != null && typeof v === 'object') {
        v = JSON.stringify(v);
      }
      sets.push('`' + col + '`=?'); params.push(v);
    }
  }
  if (Object.prototype.hasOwnProperty.call(b, 'tags')) { sets.push('tags=?'); params.push(tagsToDb(b.tags)); }
  if (Object.prototype.hasOwnProperty.call(b, 'contact_phone')) {
    try { sets.push('contact_phone=?'); params.push(phoneFromBody(b.contact_phone)); }
    catch (e) { return reply(400, { code: 400, message: e.message }); }
  }
  if (Object.prototype.hasOwnProperty.call(b, 'insurance') || Object.prototype.hasOwnProperty.call(b, 'min_stay_nights')
    || Object.prototype.hasOwnProperty.call(b, 'online_booking') || Object.prototype.hasOwnProperty.call(b, 'online_payment')
    || Object.prototype.hasOwnProperty.call(b, 'stay_bookable')) {
    let ext;
    try { ext = extFromBody(b, row.ext, row.channel); }
    catch (e) { return reply(400, { code: 400, message: e.message }); }
    sets.push('ext=?'); params.push(JSON.stringify(ext));
  }
  if (Object.prototype.hasOwnProperty.call(b, 'district_id')) {
    const did = b.district_id != null && b.district_id !== '' ? parseInt(b.district_id, 10) : null;
    if (did) {
      const [d] = await conn.execute('SELECT id FROM districts WHERE id=? AND city_id=?', [did, row.city_id]);
      if (!d.length) return reply(400, { code: 400, message: 'district_id 不存在或不属于该城市' });
    }
    sets.push('district_id=?'); params.push(did);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'city_id')) {
    return reply(400, { code: 400, message: 'city_id 不支持修改（请下架后新建房源）' });
  }
  if (!sets.length) return reply(400, { code: 400, message: '无可更新字段' });
  params.push(row.id);
  await conn.execute(`UPDATE projects SET ${sets.join(', ')} WHERE id=?`, params);
  const fresh = await ownProject(conn, vendorId, row.id);
  return reply(200, { code: 0, message: 'success', project: await housingProjectOutOne(conn, fresh) });
}

async function housingProjectsStatus(conn, body, vendorId) {
  const b = body || {};
  if (!b.id) return reply(400, { code: 400, message: '缺少 id 参数' });
  const status = String(b.status || '').trim();
  if (['online', 'offline', 'draft'].indexOf(status) < 0) {
    return reply(400, { code: 400, message: 'status 须为 online（上架）/ offline（下架）/ draft（草稿）' });
  }
  const row = await ownProject(conn, vendorId, b.id);
  if (!row) return reply(404, { code: 404, message: '房源不存在或不属于该商家' });
  // 上架前置检查：无价格、无图片的房源不允许直接上架（C 端 catalog 只出 online）
  let warnings = [];
  if (status === 'online') {
    const gate = await publishEligibility(conn, row);
    if (gate.error) return reply(400, { code: 400, message: gate.error });
    warnings = gate.warnings || [];
  }
  await conn.execute('UPDATE projects SET status=? WHERE id=?', [status, row.id]);
  return reply(200, {
    code: 0, message: 'success', id: row.id, status,
    ...(warnings.length ? { warnings } : {}),
  });
}

// ── 评级提审 / 审核状态（rating_status：draft → pending → passed/rejected，平台复核唯一闸）──

/** 提交评级自评并进入平台复核队列：dims 按频道全维度校验（rating_config 单一数据源）；pending 中不可重复提 */
async function housingRatingSubmit(conn, body, vendorId) {
  const b = body || {};
  if (!b.id) return reply(400, { code: 400, message: '缺少 id 参数' });
  const row = await ownProject(conn, vendorId, b.id);
  if (!row) return reply(404, { code: 404, message: '房源不存在或不属于该商家' });
  if (!ratingCfg.RATING_DIMS[row.channel]) {
    return reply(400, { code: 400, message: '该频道暂不支持评级（支持 rental/minsu）' });
  }
  if (row.rating_status === 'pending') {
    return reply(400, { code: 400, message: '已在平台复核队列中，请等待审核结果（rating/status 可查）' });
  }
  let dims;
  try { dims = ratingCfg.normalizeDimsInput(row.channel, b.dims); }
  catch (e) { return reply(400, { code: 400, message: e.message }); }
  let rating = {};
  try { rating = JSON.parse(row.rating || '{}') || {}; } catch (_) { rating = {}; }
  rating.dims = dims;
  rating.code = `${ratingCfg.RATING_CODE_PREFIX[row.channel] || 'SY'}-${row.id}`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await conn.execute(
    "UPDATE projects SET rating=?, rating_status='pending', rating_submitted_at=?, rating_note=NULL WHERE id=?",
    [JSON.stringify(rating), now, row.id]);
  return reply(200, {
    code: 0, message: 'success', project_id: row.id,
    rating_status: 'pending', rating_code: rating.code, dims,
  });
}

/** 查审核状态：rating_status + 驳回原因（rating_note）+ 维度自评分与缺口，提审前可据此自检 */
async function housingRatingStatus(conn, body, vendorId) {
  const b = body || {};
  if (!b.id) return reply(400, { code: 400, message: '缺少 id 参数' });
  const row = await ownProject(conn, vendorId, b.id);
  if (!row) return reply(404, { code: 404, message: '房源不存在或不属于该商家' });
  let rating = {};
  try { rating = JSON.parse(row.rating || '{}') || {}; } catch (_) { rating = {}; }
  const reqDims = ratingCfg.RATING_DIMS[row.channel] || [];
  const dims = (rating.dims && typeof rating.dims === 'object' && !Array.isArray(rating.dims)) ? rating.dims : null;
  return reply(200, {
    code: 0, message: 'success', project_id: row.id, channel: row.channel,
    rating_status: row.rating_status,
    rating_code: rating.code || null,
    dims, missing_dims: dims ? [] : reqDims,
    dims_meta: ratingCfg.dimsMetaOf(row.channel),
    note: row.rating_note || null,
    submitted_at: row.rating_submitted_at || null,
    reviewed_at: row.rating_reviewed_at || null,
  });
}

async function housingUnitsCreate(conn, body, vendorId) {
  const b = body || {};
  if (!b.project_id) return reply(400, { code: 400, message: '缺少 project_id 参数' });
  const row = await ownProject(conn, vendorId, b.project_id);
  if (!row) return reply(404, { code: 404, message: '房源不存在或不属于该商家' });
  try {
    const uid = await createUnit(conn, row.id, row.channel, row.price_from, b);
    await conn.execute('UPDATE projects SET unit_count=(SELECT COUNT(*) FROM units WHERE project_id=?) WHERE id=?', [row.id, row.id]);
    const [u] = await conn.execute('SELECT * FROM units WHERE id=?', [uid]);
    return reply(200, { code: 0, message: 'success', unit: unitOut(u[0], row) });
  } catch (e) {
    return reply(400, { code: 400, message: e.message });
  }
}

async function housingUnitsUpdate(conn, body, vendorId) {
  const b = body || {};
  if (!b.id) return reply(400, { code: 400, message: '缺少 id 参数' });
  const [rows] = await conn.execute(
    `SELECT u.*, p.owner_vendor_id, p.channel AS channel FROM units u
     JOIN projects p ON p.id=u.project_id WHERE u.id=?`, [parseInt(b.id, 10)]);
  if (!rows.length || rows[0].owner_vendor_id !== vendorId) {
    return reply(404, { code: 404, message: '户型不存在或不属于该商家' });
  }
  const sets = [], params = [];
  for (const col of ['name', 'layout_label', 'unit_spec', 'cover_image']) {
    if (Object.prototype.hasOwnProperty.call(b, col)) { sets.push('`' + col + '`=?'); params.push(b[col]); }
  }
  for (const col of ['area_sqm']) {
    if (Object.prototype.hasOwnProperty.call(b, col)) {
      sets.push('`' + col + '`=?'); params.push(b[col] == null || b[col] === '' ? null : Number(b[col]));
    }
  }
  for (const col of ['rent_monthly', 'price_total', 'promo_price', 'sort_order']) {
    if (Object.prototype.hasOwnProperty.call(b, col)) {
      sets.push('`' + col + '`=?'); params.push(b[col] == null || b[col] === '' ? null : parseInt(b[col], 10));
    }
  }
  if (Object.prototype.hasOwnProperty.call(b, 'total_qty')) {
    // 总间数（多间库存 2026-09-10）：1-999；不得低于未来晚已订间数（否则隐性超售）
    const tq = parseInt(b.total_qty, 10);
    if (!(tq >= 1 && tq <= 999)) return reply(400, { code: 400, message: 'total_qty（总间数）须为 1-999 的整数' });
    const [bmax] = await conn.execute(
      `SELECT COALESCE(MAX(GREATEST(booked_qty, status='booked')), 0) AS m FROM stay_calendar
       WHERE unit_id=? AND stay_date>=CURDATE()`, [rows[0].id]);
    if (Number(bmax[0].m) > tq) return reply(400, { code: 400, message: `未来已有晚的已订间数达 ${bmax[0].m}，total_qty 不得低于该值` });
    sets.push('`total_qty`=?'); params.push(tq);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'tags')) { sets.push('tags=?'); params.push(tagsToDb(b.tags)); }
  if (Object.prototype.hasOwnProperty.call(b, 'amenities')) { sets.push('amenities=?'); params.push(tagsToDb(b.amenities)); }
  let extDirty = false;
  const cur = stayCfg.parseExtObj(rows[0].ext);
  if (Object.prototype.hasOwnProperty.call(b, 'price_night')) {
    if (b.price_night === null || b.price_night === '') delete cur.price_night;
    else {
      const pn = parseInt(b.price_night, 10);
      if (!(pn >= 0)) return reply(400, { code: 400, message: 'price_night 须为非负整数（元/晚）' });
      cur.price_night = pn;
    }
    extDirty = true;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'cancel_policy')) {
    // 免费取消政策（房型维度，免费取消窗口 = 入住日往前推 days_before 天的 cutoff_time）；
    // 口径单一数据源 stay_config.cjs，非法值直接拒绝；null = 清除（视为未开通，不可取消）
    if (b.cancel_policy === null) delete cur.cancel_policy;
    else {
      try { cur.cancel_policy = stayCfg.normalizeCancelPolicyInput(b.cancel_policy); }
      catch (e) { return reply(400, { code: 400, message: e.message }); }
    }
    extDirty = true;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'min_stay_nights')) {
    // 最短连住（2026-09 下放户型）：户型级 > 房源级 > 频道默认；null/'' = 清除（回落房源级）
    if (b.min_stay_nights === null || b.min_stay_nights === '') delete cur.min_stay_nights;
    else {
      try { cur.min_stay_nights = stayCfg.normalizeMinStayNightsInput(b.min_stay_nights, rows[0].channel); }
      catch (e) { return reply(400, { code: 400, message: e.message }); }
    }
    extDirty = true;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'default_closed')) {
    // 默认关房（2026-09 方案 B 配套）：true = 未推送放出的日期默认不可订；null/'' = 清除（关闭）
    if (b.default_closed === null || b.default_closed === '') delete cur.default_closed;
    else {
      try { const dc = stayCfg.normalizeDefaultClosedInput(b.default_closed); if (dc) cur.default_closed = true; else delete cur.default_closed; }
      catch (e) { return reply(400, { code: 400, message: e.message }); }
    }
    extDirty = true;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'room_profile')) {
    // 房间档案（Excel 房源字段，2026-09 开放给商家接口）：只合并 ext.room_profile，保留其它键；
    // 传 null/'' = 清除；未知键按白名单丢弃，字段越界/非法取值 400（校验在 room_profile.cjs）
    if (b.room_profile === null || b.room_profile === '') delete cur.room_profile;
    else {
      try { roomProfileCfg.mergeRoomProfileIntoExt(cur, b.room_profile); }
      catch (e) { return reply(400, { code: 400, message: e.message }); }
    }
    extDirty = true;
  }
  if (extDirty) { sets.push('ext=?'); params.push(Object.keys(cur).length ? JSON.stringify(cur) : null); }
  if (!sets.length) return reply(400, { code: 400, message: '无可更新字段' });
  params.push(rows[0].id);
  await conn.execute(`UPDATE units SET ${sets.join(', ')} WHERE id=?`, params);
  const [u] = await conn.execute('SELECT * FROM units WHERE id=?', [rows[0].id]);
  // 回显生效值（最短连住 / 默认夜价 / 取消政策），与 detail/list 出参同口径
  const [prow] = await conn.execute('SELECT * FROM projects WHERE id=?', [rows[0].project_id]);
  return reply(200, { code: 0, message: 'success', unit: unitOut(u[0], prow[0] || { channel: rows[0].channel }) });
}

async function housingPhotosAdd(conn, body, vendorId) {
  const b = body || {};
  const projectId = parseInt(b.project_id, 10);
  const unitId = b.unit_id == null || b.unit_id === '' ? null : parseInt(b.unit_id, 10);
  const filePath = String(b.file_path || '').trim();
  if (!projectId || !filePath || filePath.length > 500) return reply(400, { code: 400, message: 'project_id 与 file_path 必填（URL 长度 ≤500）' });
  const [projects] = await conn.execute('SELECT id, owner_vendor_id FROM projects WHERE id=?', [projectId]);
  if (!projects.length || projects[0].owner_vendor_id !== vendorId) return reply(404, { code: 404, message: '房源不存在或不属于该商家' });
  let entityType = 'project';
  let entityId = projectId;
  if (unitId) {
    const [units] = await conn.execute('SELECT id FROM units WHERE id=? AND project_id=?', [unitId, projectId]);
    if (!units.length) return reply(400, { code: 400, message: '户型不存在或不属于该房源' });
    entityType = 'unit'; entityId = unitId;
  }
  // 分类 / 稳定图 id（2026-09）：与 photos/sync 同口径，C 端按 category 分组展示
  let category;
  try { category = photoCfg.normalizeCategoryInput(b.category); }
  catch (e) { return reply(400, { code: 400, message: e.message }); }
  const externalId = b.external_id == null || b.external_id === '' ? null : String(b.external_id).trim().slice(0, 120);
  const isCover = b.is_cover ? 1 : 0;
  // 幂等（2026-09）：同实体同 URL / 同 external_id 已存在 → 原地更新，不再插重复行
  // （商家反馈：反复推同一张图会堆重复、C 端重复展示）
  const [dup] = await conn.execute(
    `SELECT id FROM photos WHERE entity_type=? AND entity_id=?
       AND (file_path=?${externalId ? ' OR external_id=?' : ''}) LIMIT 1`,
    externalId ? [entityType, entityId, filePath, externalId] : [entityType, entityId, filePath]);
  if (dup.length) {
    const sets = ['file_path=?', 'category=?'];
    const vals = [filePath, category];
    if (externalId) { sets.push('external_id=?'); vals.push(externalId); }
    if (b.source_path != null) { sets.push('source_path=?'); vals.push(b.source_path || null); }
    // sort_order 显式传入才改（旧行为是忽略入参、永远追加到末尾——2026-09 一并修掉）
    if (b.sort_order != null && b.sort_order !== '') { sets.push('sort_order=?'); vals.push(parseInt(b.sort_order, 10) || 0); }
    if (isCover) { sets.push('is_cover=1'); await conn.execute('UPDATE photos SET is_cover=0 WHERE entity_type=? AND entity_id=?', [entityType, entityId]); }
    vals.push(dup[0].id);
    await conn.execute(`UPDATE photos SET ${sets.join(', ')} WHERE id=?`, vals);
    if (isCover && entityType === 'project') await conn.execute('UPDATE projects SET cover_image=? WHERE id=?', [filePath, projectId]);
    if (isCover && entityType === 'unit') await conn.execute('UPDATE units SET cover_image=? WHERE id=?', [filePath, unitId]);
    const [upd] = await conn.execute('SELECT * FROM photos WHERE id=?', [dup[0].id]);
    return reply(200, { code: 0, message: 'success', updated: true, photo: photoOut(upd[0]) });
  }
  if (isCover) await conn.execute('UPDATE photos SET is_cover=0 WHERE entity_type=? AND entity_id=?', [entityType, entityId]);
  let nextSort;
  if (b.sort_order != null && b.sort_order !== '' && Number.isFinite(parseInt(b.sort_order, 10))) {
    nextSort = parseInt(b.sort_order, 10);
  } else {
    const [mx] = await conn.execute(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM photos WHERE entity_type=? AND entity_id=?',
      [entityType, entityId]);
    nextSort = mx[0].n;
  }
  const [r] = await conn.execute(
    `INSERT INTO photos(entity_type, entity_id, file_path, source_path, is_cover, sort_order, category, external_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [entityType, entityId, filePath, b.source_path || null, isCover, nextSort, category, externalId]);
  if (isCover && entityType === 'project') await conn.execute('UPDATE projects SET cover_image=? WHERE id=?', [filePath, projectId]);
  if (isCover && entityType === 'unit') await conn.execute('UPDATE units SET cover_image=? WHERE id=?', [filePath, unitId]);
  const [photo] = await conn.execute('SELECT * FROM photos WHERE id=?', [r.insertId]);
  return reply(200, { code: 0, message: 'success', photo: photoOut(photo[0]) });
}

/** 图集出参：分类中文名映射在 photo_config（单一数据源） */
const photoOut = photoCfg.photoOut;

/**
 * 户型出参（商家接口统一走这里）：附房态生效值（最短连住 / 默认夜价 / 取消政策）
 * 与**已解析**的 room_profile（Excel 房源字段）——商家不必自己去 parse ext 字符串。
 */
function unitOut(u, proj) {
  if (!u) return u;
  const ext = stayCfg.parseExtObj(u.ext);
  const o = Object.assign({}, u, { room_profile: ext.room_profile || null });
  return stayCfg.withStayRules(o, proj);
}

/** 房源图集合计张数（房源级 + 其全部户型级）：上架闸与覆盖告警共用 */
async function galleryCountOf(conn, projectId) {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS c FROM photos
      WHERE (entity_type='project' AND entity_id=?)
         OR (entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id=?))`,
    [projectId, projectId]);
  return Number(rows[0] && rows[0].c) || 0;
}

/**
 * 图集全量覆盖（2026-09，商家反馈点 4）——传入该实体**当前完整的图集**，平台对比存量：
 * 匹配上的原地更新（保住图片 id、C 端引用不抖），不在列表内的旧图删除，新增的插入；整体一个事务。
 * 匹配键：external_id 优先（URL 带签名会变，认不出同一张图），其次 URL。
 * 覆盖是**按实体**的：房源级只动 entity_type='project' 的行，户型级只动该 unit 的行，互不误删。
 * 排序按 sort（缺省数组顺序）归一化为 0..n-1；封面取 is_cover 中排最前的一张，都没有则取第一张，
 * 并同步到 projects.cover_image / units.cover_image。
 */
async function housingPhotosSync(conn, body, vendorId) {
  const b = body || {};
  const projectId = parseInt(b.project_id, 10);
  if (!projectId) return reply(400, { code: 400, message: '缺少 project_id 参数' });
  const [projects] = await conn.execute('SELECT id, owner_vendor_id FROM projects WHERE id=?', [projectId]);
  if (!projects.length || projects[0].owner_vendor_id !== vendorId) {
    return reply(404, { code: 404, message: '房源不存在或不属于该商家' });
  }
  const unitId = b.unit_id == null || b.unit_id === '' ? null : parseInt(b.unit_id, 10);
  let entityType = 'project';
  let entityId = projectId;
  if (unitId) {
    const [units] = await conn.execute('SELECT id FROM units WHERE id=? AND project_id=?', [unitId, projectId]);
    if (!units.length) return reply(400, { code: 400, message: '户型不存在或不属于该房源' });
    entityType = 'unit';
    entityId = unitId;
  }
  let norm;
  try { norm = photoCfg.normalizeGalleryInput(b.photos); }
  catch (e) { return reply(400, { code: 400, message: e.message }); }
  const items = photoCfg.assignSortOrders(norm.items);
  const coverIdx = photoCfg.pickCoverIndex(items);
  const cover = coverIdx >= 0 ? items[coverIdx].file_path : (items[0] ? items[0].file_path : null);

  const [existing] = await conn.execute(
    'SELECT * FROM photos WHERE entity_type=? AND entity_id=? ORDER BY sort_order, id', [entityType, entityId]);
  const byExt = new Map();
  const byUrl = new Map();
  for (const r of existing) {
    if (r.external_id) byExt.set(r.external_id, r);
    byUrl.set(r.file_path, r);
  }
  const plan = items.map((it) => ({
    it,
    hit: (it.external_id && byExt.get(it.external_id)) || byUrl.get(it.file_path) || null,
  }));
  const keptIds = new Set(plan.filter((x) => x.hit).map((x) => x.hit.id));
  const delIds = existing.filter((r) => !keptIds.has(r.id)).map((r) => r.id);

  await conn.beginTransaction();
  try {
    let removed = 0;
    if (delIds.length) {
      const [dr] = await conn.execute(
        `DELETE FROM photos WHERE id IN (${delIds.map(() => '?').join(',')})`, delIds);
      removed = dr.affectedRows || 0;
    }
    let added = 0;
    let updated = 0;
    for (const { it, hit } of plan) {
      const isCover = it.file_path === cover ? 1 : 0;
      if (hit) {
        await conn.execute(
          'UPDATE photos SET file_path=?, category=?, sort_order=?, is_cover=?, external_id=? WHERE id=?',
          [it.file_path, it.category, it.sort_order, isCover, it.external_id, hit.id]);
        updated++;
      } else {
        await conn.execute(
          `INSERT INTO photos(entity_type, entity_id, file_path, category, sort_order, is_cover, external_id)
           VALUES (?,?,?,?,?,?,?)`,
          [entityType, entityId, it.file_path, it.category, it.sort_order, isCover, it.external_id]);
        added++;
      }
    }
    // 封面同步到实体列（C 端列表/卡片读它）
    if (entityType === 'project') await conn.execute('UPDATE projects SET cover_image=? WHERE id=?', [cover, projectId]);
    else await conn.execute('UPDATE units SET cover_image=? WHERE id=?', [cover, unitId]);
    await conn.commit();

    const warnings = norm.warnings.slice();
    const total = await galleryCountOf(conn, projectId);
    if (total < photoCfg.PHOTO_MIN_PUBLISH) {
      warnings.push(`该房源图集合计 ${total} 张，低于上架所需的 ${photoCfg.PHOTO_MIN_PUBLISH} 张（房源 + 户型合计）`);
    }
    const [after] = await conn.execute(
      'SELECT * FROM photos WHERE entity_type=? AND entity_id=? ORDER BY sort_order, id', [entityType, entityId]);
    return reply(200, {
      code: 0, message: 'success',
      entity_type: entityType, entity_id: entityId,
      applied: items.length, added, updated, removed,
      cover, truncated: norm.truncated, warnings,
      gallery_total: total,
      photos: after.map(photoOut),
    });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    return reply(400, { code: 400, message: '图集覆盖失败：' + e.message });
  }
}

/** 房态批量设置：与 C/B 端同口径（多间库存 2026-09-10：已订晚 booked_qty>0 不可关房；
 *  open+price/qty=设覆盖，qty 不得低于已订；open 无 price 无 qty=恢复默认，占用行保留计数清覆盖） */
async function housingStayCalendarSet(conn, body, vendorId) {
  const b = body || {};
  if (!b.project_id) return reply(400, { code: 400, message: '缺少 project_id 参数' });
  const row = await ownProject(conn, vendorId, b.project_id);
  if (!row) return reply(404, { code: 404, message: '房源不存在或不属于该商家' });
  const unitId = b.unit_id != null && b.unit_id !== '' ? parseInt(b.unit_id, 10) : 0;
  if (!Number.isInteger(unitId) || unitId < 0) return reply(400, { code: 400, message: 'unit_id 须为非负整数' });
  // dates 双形态（2026-09-22 商家诉求）：
  //   ① 平铺字符串数组 + 顶层 status/price_night/qty/available_qty —— 所有晚同值（向后兼容）；
  //   ② 对象数组 [{stay_date, status?, price_night?, qty?, available_qty?}] —— 逐晚独立值。
  // status 可选：不传 = 保持对应间夜现状（无行的晚按默认 open 建行），只改价格/净可售；
  // status='open' 且不带任何字段 = 恢复默认（旧行为保留）。
  // available_qty（2026-09 方案 B）：净可售绝对值 = 推送时点「平台还能卖几间」（已扣他渠道与不可售），
  // 服务端记基线，之后的平台占用才从它里面扣（见 stay_config.remainingOf）
  const rawDates = Array.isArray(b.dates) ? b.dates : [];
  if (!rawDates.length || rawDates.length > 400) return reply(400, { code: 400, message: 'dates 必填且必须为真实有效的 YYYY-MM-DD 日期（单次 ≤ 400 天）' });
  const optInt = (v) => (v === null || v === undefined || v === '') ? null : parseInt(v, 10);
  const optStatus = (v) => (v === null || v === undefined || v === '') ? null : String(v);
  const topStatus = optStatus(b.status);
  const entries = [];
  for (const item of rawDates) {
    if (item && typeof item === 'object') {
      const d = String(item.stay_date || item.date || '');
      if (!stayCfg.isValidDateString(d)) return reply(400, { code: 400, message: 'dates 对象项须含合法 stay_date（YYYY-MM-DD）' });
      entries.push({ date: d, status: optStatus(item.status), price: optInt(item.price_night), qty: optInt(item.qty), available: optInt(item.available_qty) });
    } else {
      const d = String(item);
      if (!stayCfg.isValidDateString(d)) return reply(400, { code: 400, message: 'dates 必填且必须为真实有效的 YYYY-MM-DD 日期（单次 ≤ 400 天）' });
      entries.push({ date: d, status: topStatus, price: optInt(b.price_night), qty: optInt(b.qty), available: optInt(b.available_qty) });
    }
  }
  const badStatus = entries.find((e) => e.status !== null && ['open', 'blocked'].indexOf(e.status) < 0);
  if (badStatus) return reply(400, { code: 400, message: 'status 须为 open / blocked（booked 为剩余售罄的派生态，由订单占用）' });
  const badPrice = entries.find((e) => e.price != null && !(e.price >= 0));
  if (badPrice) return reply(400, { code: 400, message: 'price_night 须为非负整数或空' });
  const badQty = entries.find((e) => e.qty != null && (!(e.qty >= 1) || e.qty > 999));
  if (badQty) return reply(400, { code: 400, message: 'qty（放出间数）须为 1-999 的整数或空' });
  const badAvail = entries.find((e) => e.available != null && (!(e.available >= 0) || e.available > 999));
  if (badAvail) return reply(400, { code: 400, message: 'available_qty（净可售）须为 0-999 的整数或空' });
  if (entries.some((e) => e.qty != null && e.available != null)) return reply(400, { code: 400, message: 'qty（放出总量）与 available_qty（净可售）语义不同，同一次调用只能传一个' });
  if (entries.some((e) => e.qty != null || e.available != null) && !unitId) return reply(400, { code: 400, message: '项目级（不限房型）容量恒 1，不支持 qty / available_qty 覆盖' });
  if (entries.some((e) => e.status === null && e.price == null && e.qty == null && e.available == null)) {
    return reply(400, { code: 400, message: 'status 缺省时须至少传 price_night / qty / available_qty 之一（恢复默认请显式传 status: open）' });
  }
  let setUnitRow = null;
  if (unitId) {
    const [u] = await conn.execute('SELECT id, ext, total_qty FROM units WHERE id=? AND project_id=?', [unitId, row.id]);
    if (!u.length) return reply(400, { code: 400, message: 'unit_id 不存在或不属于该房源' });
    setUnitRow = u[0];
  }
  const marks = entries.map(() => '?').join(',');
  // 已订晚保护（多间口径）：booked_qty>0 的晚不可关房；qty 不得低于该晚已订间数
  const [booked] = await conn.execute(
    `SELECT stay_date, booked_qty, status FROM stay_calendar WHERE project_id=? AND unit_id IN (0, ?)
     AND (booked_qty>0 OR status='booked') AND stay_date IN (${marks})`, [row.id, unitId, ...entries.map((e) => e.date)]);
  const bookedInfo = new Map(booked.map((r) => [r.stay_date, { qty: parseInt(r.booked_qty, 10) || 0, wasBooked: r.status === 'booked' }]));
  const blockedHits = entries.filter((e) => e.status === 'blocked' && bookedInfo.has(e.date));
  if (blockedHits.length) {
    return reply(400, { code: 400, message: '以下日期已有预订占用，须先取消订单：' + [...new Set(blockedHits.map((e) => e.date))].join('、') });
  }
  const over = entries.filter((e) => e.qty != null && bookedInfo.has(e.date)
    && Math.max(bookedInfo.get(e.date).qty, bookedInfo.get(e.date).wasBooked ? 1 : 0) > e.qty);
  if (over.length) {
    return reply(400, { code: 400, message: '以下日期已订间数超过放出间数，须先取消订单或调高 qty：' + [...new Set(over.map((e) => e.date))].join('、') });
  }
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let affected = 0;
  for (const e of entries) {
    if (e.status === 'blocked') {
      const [r] = await conn.execute(
        `INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, price_night, source, updated_at)
         VALUES (?,?,?,'blocked',?,'vendor',?)
         ON DUPLICATE KEY UPDATE status='blocked', source='vendor', updated_at=VALUES(updated_at)`,
        [row.id, unitId, e.date, e.price, now]);
      affected += r.affectedRows || 0;
    } else if (e.status === 'open' && e.price == null && e.qty == null && e.available == null) {
      // 恢复默认：纯差异行删行；有占用的行保留计数，仅清 price/qty/qty_base 回默认
      const [r] = await conn.execute(
        `DELETE FROM stay_calendar WHERE project_id=? AND unit_id=? AND status IN ('open','blocked')
         AND booked_qty=0 AND stay_date=?`, [row.id, unitId, e.date]);
      affected += r.affectedRows || 0;
      const [r2] = await conn.execute(
        `UPDATE stay_calendar SET price_night=NULL, qty=NULL, qty_base=NULL, updated_at=?
         WHERE project_id=? AND unit_id=? AND booked_qty>0 AND stay_date=?`,
        [now, row.id, unitId, e.date]);
      affected += r2.affectedRows || 0;
    } else if (e.status === 'open') {
      // 设覆盖价 / 放出间数（彼此独立，只写传入的字段）
      // 放出量两种口径：available_qty = 净可售（基线取该晚当前已订数，逐晚不同）；
      // qty = 旧「放出总量」（基线重置为 0）。两者都会整对写入 qty + qty_base，不混口径。
      const pushQty = e.available != null ? e.available : e.qty;
      const pushBase = e.available != null ? (bookedInfo.get(e.date) ? bookedInfo.get(e.date).qty : 0) : null;
      const [r] = await conn.execute(
        `INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, price_night, qty, qty_base, source, updated_at)
         VALUES (?,?,?,'open',?,?,?,'vendor',?)
         ON DUPLICATE KEY UPDATE status='open', source='vendor',
           ${e.price != null ? 'price_night=VALUES(price_night),' : ''}
           ${pushQty != null ? 'qty=VALUES(qty), qty_base=VALUES(qty_base),' : ''}
           updated_at=VALUES(updated_at)`,
        [row.id, unitId, e.date, e.price, pushQty, pushBase, now]);
      affected += r.affectedRows || 0;
    } else {
      // status 缺省：保持该晚现状（blocked 晚保持 blocked），只更新传入字段；无行的晚按默认 open 建行
      const pushQty = e.available != null ? e.available : e.qty;
      const pushBase = e.available != null ? (bookedInfo.get(e.date) ? bookedInfo.get(e.date).qty : 0) : null;
      const [ex] = await conn.execute('SELECT status FROM stay_calendar WHERE project_id=? AND unit_id=? AND stay_date=?', [row.id, unitId, e.date]);
      const st = ex.length ? ex[0].status : 'open';
      const [r] = await conn.execute(
        `INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, price_night, qty, qty_base, source, updated_at)
         VALUES (?,?,?,?,?,?,?,'vendor',?)
         ON DUPLICATE KEY UPDATE source='vendor', updated_at=VALUES(updated_at)
           ${e.price != null ? ', price_night=VALUES(price_night)' : ''}
           ${pushQty != null ? ', qty=VALUES(qty), qty_base=VALUES(qty_base)' : ''}`,
        [row.id, unitId, e.date, st, e.price, pushQty, pushBase, now]);
      affected += r.affectedRows || 0;
    }
  }
  // 回显落地结果（推完即对账，不必再查一次日历）：逐日给出 放出量 / 基线 / 已订 / 剩余
  const [after] = await conn.execute(
    `SELECT stay_date, qty, qty_base, booked_qty, status FROM stay_calendar
     WHERE project_id=? AND unit_id=? AND stay_date IN (${marks})`, [row.id, unitId, ...entries.map((e) => e.date)]);
  const byDate = new Map(after.map((r) => [r.stay_date, r]));
  const days = entries.map((e) => {
    const r = byDate.get(e.date) || null;
    return {
      date: e.date,
      status: r ? r.status : 'open',
      qty: r && r.qty != null ? parseInt(r.qty, 10) : null,
      qty_base: r ? (parseInt(r.qty_base, 10) || 0) : 0,
      available_qty: r && r.qty != null && (parseInt(r.qty_base, 10) || 0) > 0 ? parseInt(r.qty, 10) : null,
      booked_qty: r ? (parseInt(r.booked_qty, 10) || 0) : 0,
      remaining: stayCfg.remainingOf(r, setUnitRow, row),
    };
  });
  return reply(200, {
    code: 0, message: 'success', project_id: row.id, unit_id: unitId,
    status: topStatus, price_night: optInt(b.price_night), qty: optInt(b.qty), available_qty: optInt(b.available_qty),
    dates: entries.length, affected, days,
  });
}

// ── 订单履约：商家查单 / 确认 / 拒单（与 B 端会话接口同库同口径）──

function maskPhone(v) {
  const s = String(v || '');
  return s.length === 11 ? s.slice(0, 3) + '****' + s.slice(7) : s;
}

function connRows(conn) {
  return async (sql, params) => (await conn.execute(sql, params))[0];
}

async function housingBookingsList(conn, body, vendorId) {
  const b = body || {};
  let sql = `SELECT b.id, b.order_no, b.project_id, b.unit_id, b.channel, b.checkin, b.checkout,
                    b.nights, b.rooms, b.price_total, b.commission_rate, b.commission_fee,
                    b.status, b.pay_status, b.pay_method, b.pay_at, b.payment_expires_at, b.created_at,
                    b.contact_name, b.contact_phone, p.name AS project_name
             FROM booking_orders b LEFT JOIN projects p ON p.id=b.project_id
             WHERE b.owner_vendor_id=?`;
  const params = [vendorId];
  if (b.status) { sql += ' AND b.status=?'; params.push(String(b.status)); }
  if (b.pay_status) { sql += ' AND b.pay_status=?'; params.push(String(b.pay_status)); }
  if (b.project_id != null && b.project_id !== '') { sql += ' AND b.project_id=?'; params.push(parseInt(b.project_id, 10)); }
  sql += ' ORDER BY b.id DESC LIMIT 200';
  const [rows] = await conn.execute(sql, params);
  const list = rows.map((r) => Object.assign({}, r, { contact_phone: maskPhone(r.contact_phone) }));
  return reply(200, { code: 0, message: 'success', list, total: list.length });
}

async function ownBooking(conn, vendorId, id) {
  const [rows] = await conn.execute('SELECT * FROM booking_orders WHERE id=?', [parseInt(id, 10)]);
  if (!rows.length || rows[0].owner_vendor_id !== vendorId) return null;
  return rows[0];
}

async function housingBookingsDetail(conn, body, vendorId) {
  const b = body || {};
  if (!b.id) return reply(400, { code: 400, message: '缺少 id 参数' });
  const row = await ownBooking(conn, vendorId, b.id);
  if (!row) return reply(404, { code: 404, message: '订单不存在或不属于该商家' });
  const [p] = await conn.execute('SELECT name AS project_name FROM projects WHERE id=?', [row.project_id]);
  const out = Object.assign({}, row, {
    contact_phone: maskPhone(row.contact_phone),
    project_name: p.length ? p[0].project_name : null,
  });
  return reply(200, { code: 0, message: 'success', booking: out });
}

async function housingBookingsConfirm(conn, body, vendorId) {
  const b = body || {};
  if (!b.id) return reply(400, { code: 400, message: '缺少 id 参数' });
  await conn.beginTransaction();
  const [lockedRows] = await conn.execute('SELECT * FROM booking_orders WHERE id=? FOR UPDATE', [parseInt(b.id, 10)]);
  const row = lockedRows[0];
  if (!row || row.owner_vendor_id !== vendorId) { await conn.rollback(); return reply(404, { code: 404, message: '订单不存在或不属于该商家' }); }
  if (row.status === 'pending' && row.pay_status === 'unpaid' && row.payment_expires_at
    && new Date(row.payment_expires_at.replace(' ', 'T') + 'Z').getTime() <= Date.now()) {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await conn.execute("UPDATE booking_orders SET status='cancelled', pay_status='expired', updated_at=? WHERE id=? AND status='pending'", [now, row.id]);
    await stayCfg.releaseStayQty(connRows(conn), { project_id: row.project_id, unit_id: row.unit_id, rooms: row.rooms, checkin: row.checkin, checkout: row.checkout, now });
    await conn.commit();
    return reply(400, { code: 400, message: '待支付订单已过期并释放房态' });
  }
  if (row.status === 'cancelled') { await conn.rollback(); return reply(400, { code: 400, message: '订单已取消，不可再确认' }); }
  // 在线支付单未支付不可确认生效（与 B 端工作台同口径）
  if (row.pay_status === 'unpaid') {
    await conn.rollback();
    return reply(400, { code: 400, message: '租客尚未支付（收银台待付），支付完成后可确认生效' });
  }
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await conn.execute("UPDATE booking_orders SET status='confirmed', updated_at=? WHERE id=?", [now, row.id]);
  await conn.commit();
  return reply(200, { code: 0, message: 'success', id: row.id, order_no: row.order_no, status: 'confirmed' });
}

async function housingBookingsCancel(conn, body, vendorId) {
  const b = body || {};
  if (!b.id) return reply(400, { code: 400, message: '缺少 id 参数' });
  await conn.beginTransaction();
  const [lockedRows] = await conn.execute('SELECT * FROM booking_orders WHERE id=? FOR UPDATE', [parseInt(b.id, 10)]);
  const row = lockedRows[0];
  if (!row || row.owner_vendor_id !== vendorId) { await conn.rollback(); return reply(404, { code: 404, message: '订单不存在或不属于该商家' }); }
  if (row.status === 'cancelled') { await conn.rollback(); return reply(400, { code: 400, message: '订单已取消，不可再变更' }); }
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const newPay = row.pay_status === 'paid' ? 'refunded' : row.pay_status;
  await conn.execute('UPDATE booking_orders SET status=?, pay_status=?, updated_at=? WHERE id=?', ['cancelled', newPay, now, row.id]);
  // 拒单/取消 → 释放库存（多间口径 2026-09-10：递减 booked_qty，商家差异行保留；与 B 端工作台同口径）
  await stayCfg.releaseStayQty(connRows(conn), { project_id: row.project_id, unit_id: row.unit_id, rooms: row.rooms, checkin: row.checkin, checkout: row.checkout, now });
  await conn.commit();
  return reply(200, {
    code: 0, message: 'success', id: row.id, order_no: row.order_no, status: 'cancelled',
    pay_status: newPay || null,
  });
}

/** 商家侧房态查询：与 C 端公开日历同口径，额外返回占用来源与关联订单 */
async function housingStayCalendarQuery(conn, body, vendorId) {
  const b = body || {};
  if (!b.project_id) return reply(400, { code: 400, message: '缺少 project_id 参数' });
  const row = await ownProject(conn, vendorId, b.project_id);
  if (!row) return reply(404, { code: 404, message: '房源不存在或不属于该商家' });
  const unitId = b.unit_id != null && b.unit_id !== '' ? parseInt(b.unit_id, 10) : 0;
  const mth = /^(\d{4})-(\d{2})$/.exec(String(b.month || '').trim());
  if (mth && (parseInt(mth[2], 10) < 1 || parseInt(mth[2], 10) > 12)) return reply(400, { code: 400, message: 'month 须为 YYYY-MM 且月份有效' });
  const today = new Date();
  const y = mth ? parseInt(mth[1], 10) : today.getFullYear();
  const mo = mth ? (parseInt(mth[2], 10) - 1) : today.getMonth();
  let unit = null;
  if (unitId) {
    const [u] = await conn.execute('SELECT * FROM units WHERE id=? AND project_id=?', [unitId, row.id]);
    if (!u.length) return reply(400, { code: 400, message: 'unit_id 不存在或不属于该房源' });
    unit = u[0];
  }
  const cal = await stayCfg.buildStayMonth(connRows(conn), row, unit, unitId, y, mo);
  return reply(200, Object.assign({
    code: 0, message: 'success',
    project_id: row.id, unit_id: unitId, writable: true,
  }, cal, stayCfg.stayConfigOf(row)));
}

/** 删除户型：有关联订单或被占用晚时拒绝；删后同步房源户型数 */
async function housingUnitsDelete(conn, body, vendorId) {
  const b = body || {};
  if (!b.id) return reply(400, { code: 400, message: '缺少 id 参数' });
  const [rows] = await conn.execute(
    `SELECT u.id, u.project_id, p.owner_vendor_id FROM units u
     JOIN projects p ON p.id=u.project_id WHERE u.id=?`, [parseInt(b.id, 10)]);
  if (!rows.length || rows[0].owner_vendor_id !== vendorId) {
    return reply(404, { code: 404, message: '户型不存在或不属于该商家' });
  }
  const uid = rows[0].id, pid = rows[0].project_id;
  const [orders] = await conn.execute('SELECT COUNT(*) AS c FROM booking_orders WHERE unit_id=?', [uid]);
  if (orders[0].c > 0) return reply(400, { code: 400, message: '该户型已有 ' + orders[0].c + ' 笔订单关联，不可删除（可先下架房源）' });
  const [booked] = await conn.execute("SELECT COUNT(*) AS c FROM stay_calendar WHERE unit_id=? AND (booked_qty>0 OR status='booked')", [uid]);
  if (booked[0].c > 0) return reply(400, { code: 400, message: '该户型仍有被占用晚，须先取消相关订单' });
  await conn.execute('DELETE FROM stay_calendar WHERE unit_id=?', [uid]);
  await conn.execute('DELETE FROM units WHERE id=?', [uid]);
  await conn.execute('UPDATE projects SET unit_count=(SELECT COUNT(*) FROM units WHERE project_id=?) WHERE id=?', [pid, pid]);
  return reply(200, { code: 0, message: 'success', id: uid });
}

const HOUSING_ROUTES = {
  '/api/juzhu/housing/vendor/regions/list': housingRegionsList,
  '/api/juzhu/housing/vendor/projects/list': housingProjectsList,
  '/api/juzhu/housing/vendor/projects/detail': housingProjectsDetail,
  '/api/juzhu/housing/vendor/projects/create': housingProjectsCreate,
  '/api/juzhu/housing/vendor/projects/update': housingProjectsUpdate,
  '/api/juzhu/housing/vendor/projects/status': housingProjectsStatus,
  '/api/juzhu/housing/vendor/projects/rating/submit': housingRatingSubmit,
  '/api/juzhu/housing/vendor/projects/rating/status': housingRatingStatus,
  '/api/juzhu/housing/vendor/units/create': housingUnitsCreate,
  '/api/juzhu/housing/vendor/photos/add': housingPhotosAdd,
  '/api/juzhu/housing/vendor/photos/sync': housingPhotosSync,
  '/api/juzhu/housing/vendor/units/update': housingUnitsUpdate,
  '/api/juzhu/housing/vendor/stay-calendar/set': housingStayCalendarSet,
  '/api/juzhu/housing/vendor/stay-calendar/query': housingStayCalendarQuery,
  '/api/juzhu/housing/vendor/units/delete': housingUnitsDelete,
  '/api/juzhu/housing/vendor/bookings/list': housingBookingsList,
  '/api/juzhu/housing/vendor/bookings/detail': housingBookingsDetail,
  '/api/juzhu/housing/vendor/bookings/confirm': housingBookingsConfirm,
  '/api/juzhu/housing/vendor/bookings/cancel': housingBookingsCancel,
};

async function handleRequest(path, body, conn, vendors) {
  const auth = verifyVendorAuth(body, vendors);
  if (auth.error) return reply(401, { code: 401, message: auth.error });
  const [vendorRows] = await conn.execute('SELECT status, review_status FROM jz_vendors WHERE id=?', [auth.vendorId]);
  if (!vendorRows.length) return reply(401, { code: 401, message: '商家不存在' });
  if (vendorRows[0].status !== 'active' || (vendorRows[0].review_status && vendorRows[0].review_status !== 'approved')) {
    return reply(403, { code: 403, message: '商家未通过审核或已停用' });
  }
  if (path === '/api/juzhu/callback') {
    return handleCallback(conn, body, auth.vendorId);
  }
  const fn = VENDOR_ROUTES[path] || HOUSING_ROUTES[path];
  if (!fn) return reply(404, { code: 404, message: '未知 vendor 路由' });
  return fn(conn, body, auth.vendorId);
}

module.exports = {
  verifyVendorAuth,
  parseCityIds,
  validateProductCitySync,
  handleRequest,
  housingProjectsStatus,
  VENDOR_ROUTES,
  HOUSING_ROUTES,
};
