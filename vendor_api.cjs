// vendor_api.cjs — 商家 HMAC 开放接口（对齐 api_doc.md）
// 家政：/api/juzhu/jiazheng/vendor/*；房源：/api/juzhu/housing/vendor/*（同一套 HMAC 鉴权）
'use strict';

const hmacAuth = require('./hmac_auth.cjs');
const grOrders = require('./gr_orders.cjs');
const stayCfg = require('./stay_config.cjs');

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

async function vendorAllowedCityIds(conn, vendorId) {
  const ids = await vendorCityIds(conn, vendorId);
  return ids; // 空 = 未配置城市约束（不限制）
}

async function housingProjectOut(conn, row) {
  const out = stripContactPhone(Object.assign({}, row));
  Object.assign(out, stayCfg.stayConfigOf(row));
  return out;
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
  for (const r of rows) list.push(await housingProjectOut(conn, r));
  return reply(200, { code: 0, message: 'success', list, total: list.length });
}

async function housingProjectsDetail(conn, body, vendorId) {
  const pid = body && body.id;
  if (!pid) return reply(400, { code: 400, message: '缺少 id 参数' });
  const row = await ownProject(conn, vendorId, pid);
  if (!row) return reply(404, { code: 404, message: '房源不存在或不属于该商家' });
  const [units] = await conn.execute('SELECT * FROM units WHERE project_id=? ORDER BY sort_order, id', [row.id]);
  return reply(200, {
    code: 0, message: 'success',
    project: await housingProjectOut(conn, row),
    units,
  });
}

/** ext 组装：保险标识 + 最短连住（stay_config 校验），未知 key 直接报错 */
function extFromBody(body, baseExt) {
  const ext = stayCfg.parseExtObj(baseExt);
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
      const v = parseInt(body.min_stay_nights, 10);
      if (!(v >= 1 && v <= 365)) throw new Error('min_stay_nights 须为 1-365 的整数');
      ext.min_stay_nights = v;
    }
  }
  return ext;
}

const PROJECT_UPDATABLE_COLS = ['name', 'address', 'cover_image', 'sort_order', 'price_from',
  'is_featured', 'featured_rank', 'old_house_hint', 'unit_count', 'managed_unit_count'];

async function createUnit(conn, projectId, channel, priceFrom, u) {
  const name = String((u && u.name) || '').trim();
  if (!name) throw new Error('户型 name 必填');
  const slug = await uniqueUnitSlug(conn, projectId, name, u.slug);
  let ext = {};
  if (u.price_night != null && u.price_night !== '') {
    const pn = parseInt(u.price_night, 10);
    if (!(pn >= 0)) throw new Error('units[].price_night 须为非负整数（元/晚）');
    ext.price_night = pn;
  }
  const [r] = await conn.execute(
    `INSERT INTO units(project_id, name, slug, area_sqm, layout_label, rent_monthly, price_total,
       tags, unit_spec, promo_price, amenities, sort_order, cover_image, ext)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      projectId, name, slug,
      u.area_sqm == null || u.area_sqm === '' ? null : Number(u.area_sqm),
      u.layout_label || null,
      u.rent_monthly == null || u.rent_monthly === '' ? null : parseInt(u.rent_monthly, 10),
      u.price_total == null || u.price_total === '' ? null : parseInt(u.price_total, 10),
      tagsToDb(u.tags), u.unit_spec || null,
      u.promo_price == null || u.promo_price === '' ? null : parseInt(u.promo_price, 10),
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
  try { ext = extFromBody(b, {}); }
  catch (e) { return reply(400, { code: 400, message: e.message }); }
  const status = b.status == null || b.status === '' ? 'draft' : String(b.status);
  if (['online', 'offline', 'draft'].indexOf(status) < 0) {
    return reply(400, { code: 400, message: 'status 须为 online / offline / draft（缺省 draft）' });
  }
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
  return reply(200, { code: 0, message: 'success', project: await housingProjectOut(conn, row) });
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
  if (Object.prototype.hasOwnProperty.call(b, 'insurance') || Object.prototype.hasOwnProperty.call(b, 'min_stay_nights')) {
    let ext;
    try { ext = extFromBody(b, row.ext); }
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
  return reply(200, { code: 0, message: 'success', project: await housingProjectOut(conn, fresh) });
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
  if (status === 'online') {
    if (!row.price_from) return reply(400, { code: 400, message: '上架前须设置 price_from（起价，元）' });
    const [u] = await conn.execute('SELECT COUNT(*) AS c FROM units WHERE project_id=?', [row.id]);
    if (!u.length || !u[0].c) return reply(400, { code: 400, message: '上架前须至少创建 1 个户型（units/create）' });
  }
  await conn.execute('UPDATE projects SET status=? WHERE id=?', [status, row.id]);
  return reply(200, { code: 0, message: 'success', id: row.id, status });
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
    return reply(200, { code: 0, message: 'success', unit: u[0] });
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
  if (Object.prototype.hasOwnProperty.call(b, 'tags')) { sets.push('tags=?'); params.push(tagsToDb(b.tags)); }
  if (Object.prototype.hasOwnProperty.call(b, 'amenities')) { sets.push('amenities=?'); params.push(tagsToDb(b.amenities)); }
  if (Object.prototype.hasOwnProperty.call(b, 'price_night')) {
    const cur = stayCfg.parseExtObj(rows[0].ext);
    if (b.price_night === null || b.price_night === '') delete cur.price_night;
    else {
      const pn = parseInt(b.price_night, 10);
      if (!(pn >= 0)) return reply(400, { code: 400, message: 'price_night 须为非负整数（元/晚）' });
      cur.price_night = pn;
    }
    sets.push('ext=?'); params.push(Object.keys(cur).length ? JSON.stringify(cur) : null);
  }
  if (!sets.length) return reply(400, { code: 400, message: '无可更新字段' });
  params.push(rows[0].id);
  await conn.execute(`UPDATE units SET ${sets.join(', ')} WHERE id=?`, params);
  const [u] = await conn.execute('SELECT * FROM units WHERE id=?', [rows[0].id]);
  return reply(200, { code: 0, message: 'success', unit: u[0] });
}

/** 房态批量设置：与 C/B 端同口径（已订晚不可改；open+无夜价=恢复默认价并删差异行） */
async function housingStayCalendarSet(conn, body, vendorId) {
  const b = body || {};
  if (!b.project_id) return reply(400, { code: 400, message: '缺少 project_id 参数' });
  const row = await ownProject(conn, vendorId, b.project_id);
  if (!row) return reply(404, { code: 404, message: '房源不存在或不属于该商家' });
  const unitId = b.unit_id != null && b.unit_id !== '' ? parseInt(b.unit_id, 10) : 0;
  const status = String(b.status || '');
  const dates = Array.isArray(b.dates) ? b.dates.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  const price = (b.price_night === null || b.price_night === undefined || b.price_night === '') ? null : parseInt(b.price_night, 10);
  if (['open', 'blocked'].indexOf(status) < 0) return reply(400, { code: 400, message: 'status 须为 open / blocked（booked 由订单写入）' });
  if (price != null && !(price >= 0)) return reply(400, { code: 400, message: 'price_night 须为非负整数或空' });
  if (!dates.length) return reply(400, { code: 400, message: 'dates 必填（YYYY-MM-DD 数组，单次 ≤ 400 天）' });
  if (dates.length > 400) return reply(400, { code: 400, message: '单次最多 400 天' });
  if (unitId) {
    const [u] = await conn.execute('SELECT id FROM units WHERE id=? AND project_id=?', [unitId, row.id]);
    if (!u.length) return reply(400, { code: 400, message: 'unit_id 不存在或不属于该房源' });
  }
  const marks = dates.map(() => '?').join(',');
  const [booked] = await conn.execute(
    `SELECT stay_date FROM stay_calendar WHERE project_id=? AND unit_id IN (0, ?)
     AND status='booked' AND stay_date IN (${marks})`, [row.id, unitId, ...dates]);
  if (booked.length) {
    return reply(400, { code: 400, message: '以下日期已有预订占用，须先取消订单：' + booked.map((r) => r.stay_date).join('、') });
  }
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let affected = 0;
  if (status === 'blocked') {
    for (const d of dates) {
      const [r] = await conn.execute(
        `INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, price_night, source, updated_at)
         VALUES (?,?,?,'blocked',?,'vendor',?)
         ON DUPLICATE KEY UPDATE status='blocked', source='vendor', booking_id=NULL, updated_at=VALUES(updated_at)`,
        [row.id, unitId, d, price, now]);
      affected += r.affectedRows || 0;
    }
  } else if (price != null) {
    for (const d of dates) {
      const [r] = await conn.execute(
        `INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, price_night, source, updated_at)
         VALUES (?,?,?,'open',?,'vendor',?)
         ON DUPLICATE KEY UPDATE status='open', price_night=VALUES(price_night), updated_at=VALUES(updated_at)`,
        [row.id, unitId, d, price, now]);
      affected += r.affectedRows || 0;
    }
  } else {
    const [r] = await conn.execute(
      `DELETE FROM stay_calendar WHERE project_id=? AND unit_id=? AND status IN ('open','blocked')
       AND stay_date IN (${marks})`, [row.id, unitId, ...dates]);
    affected = r.affectedRows || 0;
  }
  return reply(200, { code: 0, message: 'success', project_id: row.id, unit_id: unitId, status, price_night: price, dates: dates.length, affected });
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
                    b.nights, b.price_total, b.status, b.pay_status, b.pay_method, b.pay_at, b.created_at,
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
  const row = await ownBooking(conn, vendorId, b.id);
  if (!row) return reply(404, { code: 404, message: '订单不存在或不属于该商家' });
  if (row.status === 'cancelled') return reply(400, { code: 400, message: '订单已取消，不可再确认' });
  // 预付口径：minsu 单未支付不可确认生效（与 B 端工作台同口径）
  if (row.pay_status === 'unpaid') {
    return reply(400, { code: 400, message: '租客尚未支付（收银台待付），支付完成后可确认生效' });
  }
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await conn.execute("UPDATE booking_orders SET status='confirmed', updated_at=? WHERE id=?", [now, row.id]);
  return reply(200, { code: 0, message: 'success', id: row.id, order_no: row.order_no, status: 'confirmed' });
}

async function housingBookingsCancel(conn, body, vendorId) {
  const b = body || {};
  if (!b.id) return reply(400, { code: 400, message: '缺少 id 参数' });
  const row = await ownBooking(conn, vendorId, b.id);
  if (!row) return reply(404, { code: 404, message: '订单不存在或不属于该商家' });
  if (row.status === 'cancelled') return reply(400, { code: 400, message: '订单已取消，不可再变更' });
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const newPay = row.pay_status === 'paid' ? 'refunded' : row.pay_status;
  await conn.execute('UPDATE booking_orders SET status=?, pay_status=?, updated_at=? WHERE id=?', ['cancelled', newPay, now, row.id]);
  // 拒单/取消 → 释放房态（与 B 端工作台同口径）；已支付标记退款（模拟通道）
  await conn.execute("DELETE FROM stay_calendar WHERE booking_id=? AND source='booking'", [row.id]);
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
  const [booked] = await conn.execute("SELECT COUNT(*) AS c FROM stay_calendar WHERE unit_id=? AND status='booked'", [uid]);
  if (booked[0].c > 0) return reply(400, { code: 400, message: '该户型仍有被占用晚，须先取消相关订单' });
  await conn.execute('DELETE FROM stay_calendar WHERE unit_id=?', [uid]);
  await conn.execute('DELETE FROM units WHERE id=?', [uid]);
  await conn.execute('UPDATE projects SET unit_count=(SELECT COUNT(*) FROM units WHERE project_id=?) WHERE id=?', [pid, pid]);
  return reply(200, { code: 0, message: 'success', id: uid });
}

const HOUSING_ROUTES = {
  '/api/juzhu/housing/vendor/projects/list': housingProjectsList,
  '/api/juzhu/housing/vendor/projects/detail': housingProjectsDetail,
  '/api/juzhu/housing/vendor/projects/create': housingProjectsCreate,
  '/api/juzhu/housing/vendor/projects/update': housingProjectsUpdate,
  '/api/juzhu/housing/vendor/projects/status': housingProjectsStatus,
  '/api/juzhu/housing/vendor/units/create': housingUnitsCreate,
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
  VENDOR_ROUTES,
  HOUSING_ROUTES,
};
