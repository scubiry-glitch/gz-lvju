'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Commerce, identities, calculate, DAY } = require('../../commerce/domain.cjs');
const actor = (name) => identities.find((a) => a.id === name);
const user = actor('user-a'), admin = actor('admin'), promoter = actor('promoter-a');
function fixture() { let time = Date.parse('2026-09-19T00:00:00Z'); const d = new Commerce({ now: () => time }); return { d, advance: (n) => { time += n; } }; }
function purchase(d, extra = {}, type = 'package-999') {
  const o = d.order(user, { product_id: type, version: 1, ...extra });
  d.pay(user, o.id, {}); return o;
}
function redeem(d, c) {
  d.appointment(user, { coupon_id: c.id, date: '2026-09-22' });
  const t = d.token(user, c.id); return d.redeem(actor('merchant-' + c.merchant), { token: t.token, store: c.store, service_confirmed: true });
}
test('AC02/03: separate products, city availability, version changes and stop-sale preserve holdings', () => {
  const { d } = fixture(); assert.equal(d.catalog().length, 2); assert.equal(d.catalog('其他城市').length, 0);
  assert.notEqual(d.products[0].type, d.products[1].type);
  assert.equal(d.catalog()[0].items[0].availability[0].remaining, 10);
  assert.throws(() => d.quote({ product_id: 'package-999', version: 0 }), { code: 'VERSION_CHANGED' });
  purchase(d); d.salesEnabled = false;
  assert.equal(d.catalog().length, 0); assert.equal(d.view(user).coupons.length, 5);
  assert.throws(() => purchase(d), { code: 'NOT_PUBLISHED' });
});
test('AC05: repeated payment and grant retry issue one batch; failure retains full liability', () => {
  const { d } = fixture(); const o = d.order(user, { product_id: 'package-999', version: 1 });
  const pay = { fail_grant: true };
  d.pay(user, o.id, pay); assert.equal(d.coupons.length, 0); assert.equal(d.summary().unredeemed, 99900);
  d.pay(user, o.id, pay); assert.equal(d.ledger.length, 1);
  d.retry(admin, o.id); d.retry(admin, o.id); assert.equal(d.coupons.length, 5); assert.equal(new Set(d.coupons.map((c) => c.grant_item)).size, 5);
});
test('AC05: duplicate SKU units have independent instances; snapshots survive live product edits', () => {
  const { d } = fixture(); d.products[0].items[0].quantity = 2; d.products[0].price += d.products[0].items[0].basis;
  const o = d.order(user, { product_id: 'package-999', version: 1 });
  d.products[0].items[0].name = 'new-name'; d.pay(user, o.id, {});
  assert.equal(d.coupons.length, 6); assert.notEqual(d.coupons[0].id, d.coupons[1].id);
  assert.equal(d.coupons[0].name, '全屋安心保洁');
  redeem(d, d.coupons[0]); assert.equal(d.coupons[1].status, 'ISSUED');
});
test('AC05: idempotency request replay and conflict', () => {
  const { d } = fixture(); const body = { product_id: 'package-999', version: 1 };
  const run = () => d.order(user, body);
  const first = d.write(user, '/orders', 'same-key-123', body, run);
  const second = d.write(user, '/orders', 'same-key-123', body, run);
  assert.deepEqual(first, second); assert.equal(d.orders.length, 1);
  assert.throws(() => d.write(user, '/orders', 'same-key-123', { ...body, version: 2 }, run), { code: 'KEY_REUSED' });
});
test('AC06: membership expiry independent from coupons; renewal extends period and uses a new grant', () => {
  const { d, advance } = fixture(); purchase(d, {}, 'member-999');
  const first = d.memberships[0]; first.end = d.now() - 1;
  assert.equal(d.view(user).memberships[0].status, 'EXPIRED'); assert.equal(d.view(user).coupons[0].status, 'ISSUED');
  purchase(d, {}, 'member-999'); assert.equal(d.memberships.length, 2); assert.equal(d.coupons.length, 10);
  assert.notEqual(d.coupons[0].grant_item, d.coupons[5].grant_item);
  assert.equal(d.memberships[1].end, d.now() + 365 * DAY);
  purchase(d, {}, 'member-999'); assert.equal(d.memberships[2].start, d.memberships[1].end);
  advance(2 * DAY); assert.equal(d.view(user).memberships[1].status, 'ACTIVE');
});
test('AC07: 10 reservations fill a day; 11th fails; failed reschedule preserves slot; cancellation releases', () => {
  const { d } = fixture(); for (let i = 0; i < 11; i++) purchase(d);
  const coupons = d.coupons.filter((c) => c.merchant === 'A'); assert.equal(d.appointments.length, 0);
  for (let i = 0; i < 10; i++) d.appointment(user, { coupon_id: coupons[i].id, date: '2026-09-22' });
  assert.throws(() => d.appointment(user, { coupon_id: coupons[10].id, date: '2026-09-22' }), { code: 'CAPACITY_FULL' });
  const other = d.appointment(user, { coupon_id: coupons[10].id, date: '2026-09-23' });
  assert.throws(() => d.appointment(user, { coupon_id: coupons[10].id, date: '2026-09-22' }), { code: 'CAPACITY_FULL' });
  assert.equal(d.appointments.find((a) => a.id === other.id).status, 'RESERVED');
  d.cancelAppointment(user, d.appointments[0].id);
  d.appointment(user, { coupon_id: coupons[10].id, date: '2026-09-22' });
  assert.equal(d.used('store-A', '2026-09-22'), 10); assert.equal(d.used('store-A', '2026-09-23'), 0);
  const t = d.token(user, coupons[1].id);
  d.redeem(actor('merchant-A'), { token: t.token, store: 'store-A', service_confirmed: true });
  assert.equal(d.used('store-A', '2026-09-22'), 10, 'fulfillment does not create a second capacity reservation');
});
test('AC08/13: preview has no side effects; wrong merchant/store rejected; duplicate redemption rejected', () => {
  const { d } = fixture(); purchase(d); const c = d.coupons[0];
  assert.throws(() => d.token(user, c.id), { code: 'APPOINTMENT_REQUIRED' });
  d.appointment(user, { coupon_id: c.id, date: '2026-09-22' }); const t = d.token(user, c.id);
  const body = { token: t.token, store: 'store-A', service_confirmed: true };
  const p = d.preview(actor('merchant-A'), body); assert.equal(p.supplier_payable, 15984); assert.equal(d.redemptions.length, 0);
  assert.throws(() => d.preview(actor('merchant-B'), body), { code: 'STORE_FORBIDDEN' });
  assert.throws(() => d.preview(actor('merchant-A'), { ...body, store: 'store-B' }), { code: 'STORE_FORBIDDEN' });
  d.redeem(actor('merchant-A'), body); assert.throws(() => d.redeem(actor('merchant-A'), body), { code: 'COUPON_UNAVAILABLE' });
  assert.equal(d.redemptions.length, 1);
});
test('AC08: expired short token and invalid dates cannot redeem or reserve', () => {
  const { d, advance } = fixture(); purchase(d); const c = d.coupons[0];
  assert.throws(() => d.appointment(user, { coupon_id: c.id, date: '2026-09-19' }), { code: 'LEAD_TIME' });
  assert.throws(() => d.appointment(user, { coupon_id: c.id, date: '2027-09-22' }), { code: 'VALIDITY' });
  d.appointment(user, { coupon_id: c.id, date: '2026-09-22' }); const t = d.token(user, c.id); advance(120001);
  assert.throws(() => d.preview(actor('merchant-A'), { token: t.token, store: c.store }), { code: 'TOKEN_INVALID' });
});
test('AC09/10: attributed five-coupon arithmetic, partial liability, projection privacy, no attribution zero commission', () => {
  const { d } = fixture(); const link = d.share(promoter, { product_id: 'package-999' }); purchase(d, { promotion_token: link.token });
  assert.equal(d.redemptions.length, 0); redeem(d, d.coupons[0]);
  assert.deepEqual(calculate(19980, true), { basis: 19980, supplier: 15984, beike: 3996, channel: 1998, retained: 1998 });
  assert.equal(d.summary().unredeemed, 79920); assert.equal(d.view(promoter).commissions[0].amount, 1998);
  assert.equal(d.view(actor('merchant-A')).redemptions[0].channel, undefined);
  assert.equal(d.view(user).orders[0].promoter, undefined); assert.equal(d.view(actor('promoter-b')).commissions.length, 0);
  for (const c of d.coupons.slice(1)) redeem(d, c);
  const s = d.summary(); assert.equal(s.supplier, 79920); assert.equal(s.channel, 9990); assert.equal(s.retained, 9990); assert.equal(s.unredeemed, 0);
  const clean = fixture().d; purchase(clean); redeem(clean, clean.coupons[0]); assert.equal(clean.summary().channel, 0);
});
test('AC10: signed attribution cannot be forged, reused for another product, or used after expiry', () => {
  const { d, advance } = fixture(); const link = d.share(promoter, { product_id: 'package-999' });
  assert.throws(() => purchase(d, { promotion_token: link.token + 'x' }), { code: 'BAD_LINK' });
  assert.throws(() => purchase(d, { promotion_token: link.token }, 'member-999'), { code: 'BAD_LINK' });
  advance(8 * DAY); assert.throws(() => purchase(d, { promotion_token: link.token }), { code: 'LINK_EXPIRED' });
  assert.equal(d.stock, 100);
});
test('AC11: refund freezes redemption; expiry refunds once; no unearned commission reversals', () => {
  const { d } = fixture(); purchase(d); const c = d.coupons[0];
  d.appointment(user, { coupon_id: c.id, date: '2026-09-22' }); const t = d.token(user, c.id);
  const f = d.refund(user, { coupon_id: c.id, reason: '无需使用' });
  assert.throws(() => d.redeem(actor('merchant-A'), { token: t.token, store: c.store, service_confirmed: true }), { code: 'COUPON_UNAVAILABLE' });
  d.reviewRefund(admin, f.id); d.reviewRefund(admin, f.id);
  assert.equal(d.summary().refunded, 19980); assert.equal(d.compensations.length, 0); assert.equal(d.redemptions.length, 0);
  d.expire(admin, d.coupons[1].id); assert.equal(d.expiryJob(admin).processed, 0); assert.equal(d.summary().refunded, 33300);
  assert.equal(d.used('store-A', '2026-09-22'), 0);
});
test('AC11: redeemed service failure uses own-account compensation and recoverable supplier receivable', () => {
  const { d } = fixture(); purchase(d); const c = d.coupons[0]; redeem(d, c);
  const f = d.refund(user, { coupon_id: c.id, reason: '服务履约失败' }); d.reviewRefund(admin, f.id);
  const comp = d.compensations[0]; assert.equal(comp.recovery_merchant, 'A'); assert.equal(comp.amount, 19980); assert.equal(d.summary().refunded, 0);
  d.recover(admin, comp.id); assert.equal(comp.recovered, comp.amount); assert.equal(d.summary().recovery, 19980);
  assert.throws(() => d.recover(admin, comp.id), { code: 'RECOVERY' });
});
test('AC12: provider reserves, unknown does not release, query uses original request, release cannot double-credit', () => {
  const { d } = fixture(); purchase(d, { promotion_token: d.share(promoter, { product_id: 'package-999' }).token }); redeem(d, d.coupons[0]);
  assert.throws(() => d.withdraw(promoter, { amount: 1998 }), { code: 'PROVIDER_BALANCE' });
  d.release(admin); d.release(admin); assert.equal(d.view(promoter).provider_available, 1998);
  const p = d.withdraw(promoter, { amount: 1998 }); d.payout(admin, p.id, 'unknown');
  assert.equal(d.view(promoter).provider_available, 0); assert.equal(d.payouts[0].status, 'UNKNOWN');
  assert.throws(() => d.withdraw(promoter, { amount: 1998 }), { code: 'PROVIDER_BALANCE' });
  assert.throws(() => d.payout(admin, p.id, 'paid'), { code: 'PAYOUT_STATE' });
  assert.equal(d.payout(admin, p.id, 'query').status, 'PAID');
  assert.equal(d.provider.requests.size, 1); assert.equal(d.payouts[0].provider_request, p.provider_request);
});
test('AC13: consumer cannot read or mutate another owner; merchant cannot approve or release', () => {
  const { d } = fixture(); const o = purchase(d);
  assert.throws(() => d.coupon(actor('user-b'), d.coupons[0].id), { code: 'FORBIDDEN' });
  assert.throws(() => d.pay(actor('user-b'), o.id, {}), { code: 'FORBIDDEN' });
  assert.throws(() => d.release(actor('merchant-A')), { code: 'FORBIDDEN' });
  assert.throws(() => d.refund(admin, { coupon_id: d.coupons[0].id, reason: 'admin request' }), { code: 'FORBIDDEN' });
  assert.equal(d.view(actor('user-b')).orders.length, 0);
});
test('help/invoice acceptance is owned, deduplicated and auditable; not a real invoice', () => {
  const { d } = fixture(); const o = purchase(d);
  const h = d.helpRequest(user, { order_id: o.id, kind: 'INVOICE' });
  assert.equal(d.helpRequest(user, { order_id: o.id, kind: 'INVOICE' }).id, h.id);
  assert.throws(() => d.helpRequest(actor('user-b'), { order_id: o.id, kind: 'HELP' }), { code: 'FORBIDDEN' });
  d.resolveHelp(admin, h.id); assert.equal(d.view(user).help[0].status, 'RESOLVED');
});
test('money: balanced immutable groups and negative/unbalanced counterexamples rejected', () => {
  const { d } = fixture(); purchase(d); redeem(d, d.coupons[0]);
  for (const group of d.ledger) {
    assert.equal(group.lines.reduce((s,l) => s + (l.debit || 0), 0), group.lines.reduce((s,l) => s + (l.credit || 0), 0));
    assert.throws(() => { group.lines[0].debit = 1; }, TypeError);
  }
  assert.throws(() => d.post('bad', [{ account: 'a', debit: 10 }, { account: 'b', credit: 9 }]), { code: 'LEDGER_UNBALANCED' });
  assert.throws(() => calculate(-1, true), { code: 'MONEY' });
  const s = d.summary(); assert.equal(s.paid, s.unredeemed + s.supplier + s.channel + s.retained + s.refunded);
});
