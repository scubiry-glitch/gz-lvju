'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createCashier } = require('../../screens/_cashier.js');
const source = fs.readFileSync(path.resolve(__dirname, '../../screens/_jzapi.js'), 'utf8');

function bus(respond, { app = false, noCashier = false, noCrypto = false, brokenStorage = false } = {}) {
  const values = new Map(), listeners = {}, requests = [];
  const storage = { getItem: key => { if (brokenStorage) throw new Error('storage unavailable'); return values.get(key) || null; },
    setItem: (key, value) => { if (brokenStorage) throw new Error('storage unavailable'); values.set(key, value); }, removeItem: key => values.delete(key) };
  const element = () => ({ style: {}, classList: { toggle() {} }, appendChild() {}, setAttribute() {} });
  const env = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: storage,
    crypto: noCrypto ? undefined : crypto, Uint8Array, URLSearchParams, location: { search: '', href: '' }, navigator: { userAgent: app ? 'Lianjia/Beike' : 'ordinary browser' },
    CustomEvent: class { constructor(type) { this.type = type; } },
    document: { getElementById: () => null, createElement: element, head: element(), documentElement: element(), querySelector: () => null },
    setTimeout: fn => setTimeout(fn, 0), clearTimeout, setInterval, clearInterval,
    dispatchEvent() {}, addEventListener: (key, fn) => { listeners[key] = fn; }, removeEventListener: key => { delete listeners[key]; },
    fetch: async (url, options = {}) => { requests.push({ url, options, body: options.body && JSON.parse(options.body) }); const result = await respond(url, options);
      return { ok: (result.status || 200) < 400, status: result.status || 200, json: async () => result.body }; },
  };
  env.window = env;
  env.JsBridgeV3 = { getSchemeLink: () => 'lianjiabeike://bkjfwallet?url=', callAndBack: input => { env.lastBridgeCall = input; } };
  if (!noCashier) env.BZF_CASHIER = createCashier(env);
  vm.runInNewContext(source, env);
  return { env, api: env.BZF_JZ, requests, listeners };
}

test('legacy create preserves its no-key contract for server retry and terminal-generation handling', async () => {
  // This isolated fixture models the backend contract; backend generation and
  // transactional deduplication are verified in the separate route suite.
  let lostResponse = true, generation = 1, state = 'pending';
  const f = bus(async () => {
    if (state === 'cancelled' || state === 'done') { generation++; state = 'pending'; }
    if (lostResponse) { lostResponse = false; throw new Error('isolated network loss'); }
    return { body: { ok: true, order: { id: 'JZ-' + generation, status: state, pay_status: 'unpaid' } } };
  }, { noCashier: true, noCrypto: true, brokenStorage: true });
  const payload = { sku_id: 1, category: 'cleaning', house: 'Test address', phone: '13000000000', expectTime: '2099-10-02 18:00', slot_id: '4', worker_id: '5' };
  await assert.rejects(f.api.create(payload), /isolated network loss/);
  assert.equal((await f.api.create(payload)).id, 'JZ-1');
  assert.equal((await f.api.create(payload)).id, 'JZ-1');
  state = 'cancelled'; assert.equal((await f.api.create(payload)).id, 'JZ-2');
  state = 'done'; assert.equal((await f.api.create(payload)).id, 'JZ-3');
  for (const request of f.requests) {
    assert.deepEqual(request.body, payload);
    assert.equal(request.options.headers['Idempotency-Key'], undefined);
  }
});

test('modern create keeps its explicit key across an unknown result without crypto or storage', async () => {
  let fail = true;
  const f = bus(async () => { if (fail) { fail = false; throw new Error('isolated network loss'); }
    return { body: { order: { id: 'JZ-explicit', pay_status: 'unpaid' } } }; }, { noCashier: true, noCrypto: true, brokenStorage: true });
  const key = f.api.requestKey('checkout:fixture');
  const payload = { product_id: 123, house: 'Test address', idempotency_key: key };
  await assert.rejects(f.api.create(payload), /isolated network loss/);
  assert.equal(f.api.requestKey('checkout:fixture'), key);
  assert.equal((await f.api.create(payload)).id, 'JZ-explicit');
  for (const request of f.requests) assert.equal(request.options.headers['Idempotency-Key'], key);
  assert.notEqual(f.api.requestKey('checkout:fixture', true), key);
});

test('modern pay preserves the old order envelope without inventing paid state', async () => {
  const f = bus(async () => ({ status: 202, body: { ok: true, order: { id: 'JZ-one', pay_status: 'unpaid', status: 'pending' }, next_action: 'poll' } }));
  const payment = await f.api.payIntent('JZ-one');
  assert.equal(payment.pay_status, 'unpaid'); assert.equal(payment.order_pay_status, 'unpaid');
  assert.equal(payment.order.id, 'JZ-one'); assert.equal(f.requests[0].body.cashier_type, '2');
});

test('old pay(id, method) rejects unknown and closed attempts instead of resolving success', async () => {
  for (const state of ['creating', 'closed']) {
    const f = bus(async () => ({ status: 202, body: { pay_status: state, order_pay_status: state === 'closed' ? 'closed' : 'unpaid', next_action: 'poll' } }));
    await assert.rejects(f.api.pay('JZ-one', '贝壳支付'), /支付结果确认中/);
    assert.equal(f.requests[0].body.pay_method, '贝壳支付'); assert.equal(f.requests[0].body.cashier_type, '2');
    assert.equal(f.env.location.href, '');
  }
});

test('omitted, undefined and null legacy payment labels never resolve an unpaid intent', async () => {
  for (const args of [[], [undefined], [null]]) {
    const f = bus(async () => ({ status: 202, body: { pay_status: 'creating', order_pay_status: 'unpaid', next_action: 'poll' } }));
    await assert.rejects(f.api.pay('JZ-one', ...args), /支付结果确认中/);
    assert.equal(f.requests[0].body.pay_method, '贝壳支付');
  }
});

test('legacy success never overrides cancelled or refunded business orders', async () => {
  for (const order of [
    { status: 'cancelled', pay_status: 'paid' },
    { status: 'pending', pay_status: 'paid', refund_status: 'refunding' },
    { status: 'pending', pay_status: 'paid', refund_status: 'refunded' },
    { status: 'pending', pay_status: 'partially_refunded' },
  ]) {
    const f = bus(async () => ({ body: { order: { id: 'JZ-one', ...order }, pay_status: 'paid', order_pay_status: 'paid' } }));
    await assert.rejects(f.api.pay('JZ-one'), /支付结果确认中|尚未确认支付成功/);
    assert.equal(f.env.location.href, '');
  }
  const f = bus(async url => ({ body: url.endsWith('/pay')
    ? { pay_status: 'paid', order_pay_status: 'paid', order: { id: 'JZ-one', status: 'pending', pay_status: 'paid' } }
    : { order: { id: 'JZ-one', status: 'cancelled', pay_status: 'paid' } } }));
  await assert.rejects(f.api.pay('JZ-one'), /尚未确认支付成功/);
});

test('legacy H5 navigation never resolves pay before an authoritative success', async () => {
  let paid = false;
  const f = bus(async url => ({ body: url.endsWith('/pay')
    ? { cashier_type: '2', cashier_url: 'https://cashier.test/isolated', pay_status: 'paying', order_pay_status: 'unpaid' }
    : { order_pay_status: paid ? 'paid' : 'unpaid', pay_status: paid ? 'paid' : 'paying', order: { id: 'JZ-one', pay_status: paid ? 'paid' : 'unpaid' } } }));
  let resolved = false;
  const pending = f.api.pay('JZ-one', '贝壳支付').then(order => { resolved = true; return order; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.env.location.href, 'https://cashier.test/isolated'); assert.equal(resolved, false);
  paid = true; f.listeners.pagehide(); f.listeners.pageshow();
  assert.equal((await pending).pay_status, 'paid');
});

test('legacy App callback cancellation cannot fulfill the old success continuation', async () => {
  const f = bus(async () => ({ body: { cashier_type: '1', cashier_url: 'WalletSDK://isolated', pay_status: 'paying', order_pay_status: 'unpaid' } }), { app: true });
  const promise = f.api.pay('JZ-one', '微信支付');
  const rejected = assert.rejects(promise, /支付已取消/);
  await new Promise(resolve => setTimeout(resolve, 10));
  f.env[f.env.lastBridgeCall.functionName]('{"code":-1}'); await rejected;
  assert.equal(f.env.location.href, '');
});
