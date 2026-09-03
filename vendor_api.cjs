// vendor_api.cjs — 商家 HMAC 开放接口（对齐 api_doc.md）
'use strict';

const hmacAuth = require('./hmac_auth.cjs');
const grOrders = require('./gr_orders.cjs');

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

async function handleRequest(path, body, conn, vendors) {
  const auth = verifyVendorAuth(body, vendors);
  if (auth.error) return reply(401, { code: 401, message: auth.error });
  if (path === '/api/juzhu/callback') {
    return handleCallback(conn, body, auth.vendorId);
  }
  const fn = VENDOR_ROUTES[path];
  if (!fn) return reply(404, { code: 404, message: '未知 vendor 路由' });
  return fn(conn, body, auth.vendorId);
}

module.exports = {
  verifyVendorAuth,
  parseCityIds,
  validateProductCitySync,
  handleRequest,
  VENDOR_ROUTES,
};
