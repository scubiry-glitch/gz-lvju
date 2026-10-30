'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiDirectRouter } = require('../routes/api_direct.cjs');
const permRegistry = require('../../perm_registry.cjs');

function harness(execute) {
  const audits = [];
  const sqls = [];
  const exec = async (sql, params) => { sqls.push({ sql, params }); return execute(sql, params); };
  const router = createApiDirectRouter({
    ADMIN_PREFIX: '/api/juzhu/admin',
    assertAdminAuthorized: async () => true,
    assertApiAuthorized: async () => true,
    ensureSchema: async () => {},
    handleBookingRoutes: async () => false,
    handleJiazhengRoutes: async () => false,
    handleAdminRoutes: async () => false,
    permRegistry,
    requirePerm: async (req, res, perm) => {
      if (req.allow) return true;
      res.status = 403;
      res.body = { ok: false, error: 'forbidden', perm };
      return false;
    },
    readBody: async (req) => req.body,
    getDbConfig: () => ({}),
    mysql2: { createConnection: async () => ({ execute: exec, end: async () => {} }) },
    auditIfAccount: async (_req, action, resource, id, after) => { audits.push({ action, resource, id, after }); },
    jsonReply: (res, body, status = 200) => Object.assign(res, { body, status }),
  });
  return { audits, sqls, router };
}

test('SPU writes require spu.write and are registered outside the admin prefix', async () => {
  assert.equal(permRegistry.match('/api/juzhu/jz/spu', 'POST').perm, 'spu.write');
  assert.equal(permRegistry.match('/api/juzhu/jz/spu/41', 'PUT').act, 'spu.update');
  const { router, sqls } = harness(async () => { throw new Error('db'); });
  const denied = {};
  await router('/api/juzhu/jz/spu', '', { method: 'POST', body: { name: 'x', slug: 'x' } }, denied);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.perm, 'spu.write');
  assert.equal(sqls.length, 0);
});

test('POST accepts the console comma fields and object service items', async () => {
  let inserted = null;
  const { router, audits } = harness(async (sql, params) => {
    if (sql.startsWith('SELECT id FROM jz_categories')) return [[{ id: 'moving' }]];
    if (sql.startsWith('INSERT')) { inserted = { sql, params }; return [{ insertId: 47 }]; }
    throw new Error(sql);
  });
  const res = {};
  await router('/api/juzhu/jz/spu', '', {
    method: 'POST', allow: true,
    body: {
      category_id: 'moving', name: '同城搬家 · 小面', slug: 'moving-local-small-van',
      spec: '小面 · 1.6×1.3×1.1m', price_from: 96, price_unit: '起', duration_min: 180,
      tags: '全程搬运,明码标价', service_flow: '提交搬家信息\n匹配搬家师傅',
      includes: [{ name: '全程搬运', desc: '标配1名搬家师傅负责全程搬运' }],
      enabled: '1', sort_order: 1, worker_min_level: 'L2',
    },
  }, res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.id, 47);
  const includesAt = inserted.sql.split(',').indexOf('includes');
  // column list is unquoted; find the value by column name instead
  const cols = inserted.sql.slice(inserted.sql.indexOf('(') + 1, inserted.sql.indexOf(')')).split(',');
  const at = (name) => inserted.params[cols.indexOf(name)];
  assert.deepEqual(JSON.parse(at('tags')), ['全程搬运', '明码标价']);
  assert.deepEqual(JSON.parse(at('service_flow')), ['提交搬家信息', '匹配搬家师傅']);
  assert.deepEqual(JSON.parse(at('includes')), [{ name: '全程搬运', desc: '标配1名搬家师傅负责全程搬运' }]);
  assert.equal(at('price_from'), 96);
  assert.equal(audits[0].action, 'spu.create');
  assert.equal(audits[0].id, '47');
  assert.equal(includesAt >= -1, true);
});

test('POST rejects a duplicate slug and a missing category without inserting', async () => {
  const { router } = harness(async (sql) => {
    if (sql.startsWith('SELECT id FROM jz_categories')) return [[]];
    if (sql.startsWith('INSERT')) { const err = new Error('dup'); err.code = 'ER_DUP_ENTRY'; throw err; }
    throw new Error(sql);
  });
  const missing = {};
  await router('/api/juzhu/jz/spu', '', {
    method: 'POST', allow: true,
    body: { category_id: 'nope', name: '小面', slug: 'moving-local-small-van' },
  }, missing);
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, '类目不存在');

  const dupRouter = harness(async (sql) => {
    if (sql.startsWith('SELECT id FROM jz_categories')) return [[{ id: 'moving' }]];
    const err = new Error('dup'); err.code = 'ER_DUP_ENTRY'; throw err;
  }).router;
  const dup = {};
  await dupRouter('/api/juzhu/jz/spu', '', {
    method: 'POST', allow: true,
    body: { category_id: 'moving', name: '小面', slug: 'moving-local-small-van' },
  }, dup);
  assert.equal(dup.status, 400);
  assert.equal(dup.body.error, 'slug 已存在');
});

test('PUT updates only the supplied fields and reports a missing row', async () => {
  let update = null;
  const { router } = harness(async (sql, params) => {
    if (sql.startsWith('SELECT id FROM jz_skus')) return params[0] === 6 ? [[{ id: 6 }]] : [[]];
    if (sql.startsWith('UPDATE')) { update = { sql, params }; return [{ affectedRows: 1 }]; }
    throw new Error(sql);
  });
  const ok = {};
  await router('/api/juzhu/jz/spu/6', '', { method: 'PUT', allow: true, body: { enabled: 0, includes: ['基础搬运', '车辆运输'] } }, ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.match(update.sql, /^UPDATE jz_skus SET includes=\?, enabled=\? WHERE id=\?$/);
  assert.deepEqual(JSON.parse(update.params[0]), ['基础搬运', '车辆运输']);
  assert.equal(update.params[1], 0);
  assert.equal(update.params[2], 6);

  const missing = {};
  await router('/api/juzhu/jz/spu/99', '', { method: 'PUT', allow: true, body: { enabled: 1 } }, missing);
  assert.equal(missing.status, 404);

  const empty = {};
  await router('/api/juzhu/jz/spu/6', '', { method: 'PUT', allow: true, body: {} }, empty);
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, '没有可更新字段');
});
