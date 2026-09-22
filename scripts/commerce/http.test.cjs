'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { createServer } = require('../../commerce/server.cjs');
test('HTTP boundary, isolation, sessions, idempotency, permissions and cross-origin rejection', async (t) => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  async function req(route, body, token, key, more = {}) {
    const r = await fetch(base + '/api/commerce/v1' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Idempotency-Key': key || randomUUID() } : {}), ...more }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, ...await r.json() };
  }
  assert.equal((await req('/meta')).data.real_money, false); assert.equal((await req('/state')).status, 401);
  const session = (await req('/test-sessions', { identity: 'user-a' })).data;
  assert.equal((await req('/test-sessions', { identity: 'admin' }, null, null, { Origin: 'https://attacker.example' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/commerce/v1/meta', { headers: { Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  const body = { product_id: 'package-999', version: 1 }, key = randomUUID();
  const first = await req('/orders', body, session.token, key), again = await req('/orders', body, session.token, key);
  assert.equal(first.status, 200); assert.equal(first.data.id, again.data.id);
  assert.equal((await req('/orders', { ...body, version: 2 }, session.token, key)).status, 409);
  assert.equal((await req('/admin/test-release', {}, session.token)).status, 403);
  await req('/orders/' + first.data.id + '/test-pay', {}, session.token);
  const state = (await req('/state', undefined, session.token)).data; assert.equal(state.coupons.length, 5);
  const other = (await req('/test-sessions', { identity: 'user-b' })).data;
  assert.equal((await req('/me/coupons/' + state.coupons[0].id, undefined, other.token)).status, 403);
  for (const p of ['/commerce/domain.cjs','/commerce/server.cjs','/.env','/package.json','/scripts/commerce/domain.test.cjs','/docs/prd/PLAN-新居住券包与会员卡-v1.9.md','/%2e%2e/.env']) assert.equal((await fetch(base + p)).status, 404, p);
  for (const p of ['/juzhu-commerce.html','/juzhu-promoter.html','/screens/commerce-merchant.html','/screens/commerce-admin.html','/screens/_commerce-ui.js']) assert.equal((await fetch(base + p)).status, 200, p);
  assert.equal((await req('/orders/' + first.data.id + '/pay', {}, session.token)).status, 404, 'no real payment endpoint exists');
  assert.equal((await req('/callbacks/payments/live', {}, session.token)).status, 404);
});
test('configured HTTPS preview host accepts same-origin requests, rejects arbitrary hosts and origins', async (t) => {
  const server = createServer({ publicOrigin: 'https://sytest.meizu.life' }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  function request(host, origin) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/commerce/v1/test-sessions', headers: { Host: host, Origin: origin, 'Content-Type': 'application/json' } }, res => { let data = ''; res.on('data', d => { data += d; }); res.on('end', () => resolve({status:res.statusCode, body:JSON.parse(data)})); });
      req.on('error', reject); req.end(JSON.stringify({identity:'user-a'}));
    });
  }
  assert.equal((await request('sytest.meizu.life', 'https://sytest.meizu.life')).status, 200);
  assert.equal((await request('sytest.meizu.life', 'https://other.example')).status, 403);
  assert.equal((await request('other.example', 'https://other.example')).status, 403);
  assert.equal((await request('sytest.meizu.life', 'http://sytest.meizu.life')).status, 403);
  assert.throws(() => createServer({publicOrigin:'https://sytest.meizu.life/path'}), /exact HTTPS/);
});
