'use strict';
// M0 only: isolated, synchronous in-memory domain. No database or network dependencies.
const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const id = (p) => `${p}_${randomUUID()}`;
const DAY = 86400000;
class DomainError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
function requireThat(ok, status, code, message) { if (!ok) throw new DomainError(status, code, message); }
const identities = [
  { id: 'user-a', role: 'consumer', name: '体验用户 · 林女士' },
  { id: 'user-b', role: 'consumer', name: '另一位用户 · 陈先生' },
  ...['A', 'B', 'C', 'D', 'E'].map((m) => ({ id: `merchant-${m}`, role: 'merchant', merchant: m, name: `测试供应商 ${m}` })),
  { id: 'promoter-a', role: 'promoter', name: '推广员 · 小沈' },
  { id: 'promoter-b', role: 'promoter', name: '另一位推广员' },
  { id: 'admin', role: 'admin', name: '运营 / 财务复核' },
];
const skuSeed = [
  ['A', '全屋安心保洁', '4小时标准保洁', 19980, 'cleaning'],
  ['B', '居家维修服务', '基础检修一次', 13320, 'repair'],
  ['C', '同城搬家服务', '小型搬家一次', 27750, 'moving'],
  ['D', '周末旅居体验', '指定房型一晚', 33300, 'travel'],
  ['E', '城市漫游门票', '指定景区单人票', 5550, 'ticket'],
];
function calculate(basis, attributed) {
  requireThat(Number.isSafeInteger(basis) && basis >= 0, 422, 'MONEY', '金额须为非负整数分');
  const beike = Math.round(basis * 2000 / 10000);
  const channel = attributed ? Math.floor(beike / 2) : 0;
  return { basis, supplier: basis - beike, beike, channel, retained: beike - channel };
}

// The provider owns its test reservation state; domain balance is always a projection.
class TestProvider {
  constructor() { this.available = new Map(); this.requests = new Map(); }
  credit(who, amount) { this.available.set(who, (this.available.get(who) || 0) + amount); }
  reserve(who, request, amount) {
    if (this.requests.has(request)) return this.requests.get(request);
    requireThat(amount > 0 && amount <= (this.available.get(who) || 0), 409, 'PROVIDER_BALANCE', '测试机构可用金额不足');
    this.available.set(who, this.available.get(who) - amount);
    const row = { id: request, who, amount, status: 'PROCESSING', remote_status: 'PROCESSING' };
    this.requests.set(request, row); return row;
  }
  query(request) {
    const row = this.requests.get(request);
    requireThat(row, 404, 'NOT_FOUND', '机构指令不存在');
    row.status = row.remote_status;
    return row;
  }
}

class Commerce {
  constructor({ now = Date.now, secret = randomUUID() } = {}) {
    this.now = now; this.secret = secret; this.provider = new TestProvider();
    this.orders = []; this.coupons = []; this.memberships = []; this.appointments = [];
    this.redemptions = []; this.refunds = []; this.compensations = []; this.payouts = []; this.help = [];
    this.audit = []; this.ledger = []; this.tokens = new Map(); this.idempotency = new Map();
    this.stock = 100; this.capacity = new Map(); this.stopped = new Set(); this.salesEnabled = true;
    this.products = [
      { id: 'package-999', type: 'package', name: '新居生活 · 五重安心券包', tagline: '从安家到出发，让每一份权益用在生活里', price: 99900, version: 1, city: '沈阳' },
      { id: 'member-999', type: 'membership', name: '新居住 · 年度会员', tagline: '一年相伴，赠送五重安心券包', price: 99900, version: 1, city: '沈阳', term_days: 365 },
    ].map((p) => ({ ...p, test_only: true, items: skuSeed.map(([merchant, name, spec, basis, category]) => ({ merchant, name, spec, basis, category, store: `store-${merchant}`, quantity: 1 })) }));
  }
  role(actor, ...roles) { requireThat(actor && roles.includes(actor.role), actor ? 403 : 401, 'FORBIDDEN', '当前身份无权执行此操作'); }
  own(row, actor) { requireThat(row, 404, 'NOT_FOUND', '记录不存在'); requireThat(row.user === actor.id || actor.role === 'admin', 403, 'FORBIDDEN', '只能访问本人的记录'); return row; }
  log(actor, action, target) { this.audit.push({ id: id('audit'), actor: actor.id, action, target, at: this.now() }); }
  write(actor, operation, key, body, fn) {
    requireThat(typeof key === 'string' && key.length >= 8 && key.length <= 200, 422, 'IDEMPOTENCY_REQUIRED', '写操作需要幂等键');
    const scope = `${actor.id}:${operation}:${key}`, digest = JSON.stringify(body);
    if (this.idempotency.has(scope)) {
      const old = this.idempotency.get(scope);
      requireThat(old.digest === digest, 409, 'KEY_REUSED', '同一幂等键不能用于不同请求');
      return structuredClone(old.result);
    }
    const result = fn();
    this.idempotency.set(scope, { digest, result: structuredClone(result) });
    this.log(actor, operation, result.id || 'batch'); return result;
  }
  sign(payload) { const raw = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${raw}.${createHmac('sha256', this.secret).update(raw).digest('base64url')}`; }
  verify(token) {
    const [raw, sig] = String(token || '').split('.');
    const want = createHmac('sha256', this.secret).update(raw || '').digest('base64url');
    requireThat(sig && sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want)), 422, 'BAD_LINK', '推广链接无效或已被修改');
    let p; try { p = JSON.parse(Buffer.from(raw, 'base64url')); } catch { throw new DomainError(422, 'BAD_LINK', '链接内容无效'); }
    requireThat(p.expires > this.now(), 422, 'LINK_EXPIRED', '推广链接已过期'); return p;
  }
  product(productId) { const p = this.products.find((p) => p.id === productId); requireThat(p, 404, 'NOT_FOUND', '商品不存在'); return p; }
  catalog(city = '沈阳') { return city === '沈阳' && this.salesEnabled && !this.stopped.size ? this.products.map((p) => ({ ...structuredClone(p), items: p.items.map((i) => ({ ...structuredClone(i), availability: this.availability({ ...i, valid_to: this.now() + 30 * DAY }) })) })) : []; }
  quote(body) {
    const p = this.product(body.product_id);
    requireThat(p.items.every((i) => Number.isSafeInteger(i.quantity) && i.quantity > 0 && Number.isSafeInteger(i.basis) && i.basis >= 0) && p.items.reduce((s, i) => s + i.basis * i.quantity, 0) === p.price, 422, 'ALLOCATION', '测试商品逐券分摊与实付金额不一致，禁止销售');
    requireThat(this.salesEnabled && !this.stopped.size, 422, 'NOT_PUBLISHED', '商品已停售，已购权益仍可查询及售后');
    requireThat(body.version === p.version, 409, 'VERSION_CHANGED', '商品版本变化，请重新确认');
    requireThat(!body.city || body.city === p.city, 422, 'CITY', '当前城市暂无可售权益');
    return { product_id: p.id, name: p.name, version: p.version, total: p.price, test_only: true, rule_version: 'test-rules-v1', items: p.items, refund_notice: '未核销到期自动原路退回；联调不发生真实资金交易。' };
  }
  order(actor, body) {
    this.role(actor, 'consumer'); const q = this.quote(body);
    requireThat(this.stock > 0, 422, 'OUT_OF_STOCK', '测试商品库存不足');
    let promoter = null;
    if (body.promotion_token) {
      const link = this.verify(body.promotion_token);
      requireThat(link.product === q.product_id && identities.some((x) => x.id === link.promoter && x.role === 'promoter'), 422, 'BAD_LINK', '推广链接与商品不匹配');
      promoter = link.promoter;
    }
    const row = { id: id('order'), user: actor.id, product_id: q.product_id, product_type: this.product(q.product_id).type, name: q.name, total: q.total, version: q.version, rule_version: q.rule_version, items: structuredClone(q.items), promoter, status: 'UNPAID', grant_status: 'PENDING', grant_batch: id('grant'), created_at: this.now(), test_only: true };
    this.stock--; this.orders.push(row); return structuredClone(row);
  }
  pay(actor, orderId, body) {
    this.role(actor, 'consumer'); const o = this.own(this.orders.find((x) => x.id === orderId), actor);
    if (o.status === 'PAID') return structuredClone(o);
    requireThat(o.status === 'UNPAID', 409, 'ORDER_STATE', '订单状态不可支付');
    o.status = 'PAID'; o.payment_ref = id('testpay'); o.paid_at = this.now();
    this.post(o.id, [{ account: 'provider_receivable', debit: o.total }, { account: 'unredeemed_liability', credit: o.total }]);
    if (body.fail_grant) o.grant_status = 'RETRY_PENDING'; else this.grant(o);
    return structuredClone(o);
  }
  grant(o) {
    for (let i = 0; i < o.items.length; i++) {
      const item = o.items[i];
      for (let unit = 0; unit < item.quantity; unit++) {
        const unique = `${o.grant_batch}:${i}:${unit}`;
        if (this.coupons.some((c) => c.grant_item === unique)) continue;
        this.coupons.push({ id: id('coupon'), grant_item: unique, order: o.id, user: o.user, merchant: item.merchant, store: item.store, name: item.name, spec: item.spec, basis: item.basis, category: item.category, rule_version: o.rule_version, status: 'ISSUED', valid_to: this.now() + 30 * DAY, created_at: this.now() });
      }
    }
    if (o.product_type === 'membership' && !this.memberships.some((m) => m.order === o.id)) {
      const previous = this.memberships.filter((m) => m.user === o.user).reduce((end, m) => Math.max(end, m.end), this.now());
      this.memberships.push({ id: id('membership'), order: o.id, user: o.user, start: previous, end: previous + 365 * DAY, plan: o.product_id });
    }
    o.grant_status = 'COMPLETED';
  }
  retry(actor, orderId) {
    this.role(actor, 'admin'); const o = this.orders.find((o) => o.id === orderId);
    requireThat(o && o.status === 'PAID', 409, 'ORDER_STATE', '只能补发已测试支付的订单'); this.grant(o); return structuredClone(o);
  }
  coupon(actor, couponId) { this.role(actor, 'consumer', 'admin'); return this.own(this.coupons.find((c) => c.id === couponId), actor); }
  active(c) { requireThat(c.status === 'ISSUED' && c.valid_to > this.now(), 409, 'COUPON_UNAVAILABLE', '券已使用、过期或处于退款冻结'); requireThat(!this.stopped.has(c.merchant), 409, 'MERCHANT_STOPPED', '商户暂不可履约，请联系售后'); }
  dateCheck(date) {
    requireThat(/^\d{4}-\d{2}-\d{2}$/.test(date || '') && Number.isFinite(Date.parse(`${date}T00:00:00+08:00`)), 422, 'DATE', '请选择有效预约日期');
    const day = Date.parse(`${date}T00:00:00+08:00`);
    requireThat(day >= this.now() + DAY, 422, 'LEAD_TIME', '至少提前一天预约（按完整日校验）'); return day;
  }
  used(store, date, exclude) { return this.appointments.filter((a) => a.id !== exclude && a.store === store && a.date === date && ['RESERVED', 'FULFILLED'].includes(a.status)).length; }
  availability(c) {
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(this.now() + (i + 2) * DAY).toISOString().slice(0, 10);
      const total = this.capacity.get(`${c.store}:${date}`) ?? 10;
      return { date, total, remaining: Math.max(0, total - this.used(c.store, date)), usable: Date.parse(`${date}T23:59:59+08:00`) < c.valid_to && !this.stopped.has(c.merchant) };
    });
  }
  appointment(actor, body) {
    this.role(actor, 'consumer'); const c = this.coupon(actor, body.coupon_id); this.active(c);
    this.dateCheck(body.date);
    requireThat(Date.parse(`${body.date}T23:59:59+08:00`) < c.valid_to, 422, 'VALIDITY', '预约日期超出券有效期');
    const old = this.appointments.find((a) => a.coupon === c.id && a.status === 'RESERVED');
    const total = this.capacity.get(`${c.store}:${body.date}`) ?? 10;
    requireThat(this.used(c.store, body.date, old?.id) < total, 409, 'CAPACITY_FULL', '门店当日已约满，请选择其他日期');
    // Validate new slot first so failed rescheduling preserves the original reservation.
    if (old) old.status = 'RESCHEDULED';
    const a = { id: id('appointment'), coupon: c.id, user: c.user, merchant: c.merchant, store: c.store, date: body.date, status: 'RESERVED', rescheduled_from: old?.id || null };
    this.appointments.push(a); return structuredClone(a);
  }
  cancelAppointment(actor, aid) {
    this.role(actor, 'consumer'); const a = this.own(this.appointments.find((a) => a.id === aid), actor);
    requireThat(a.status === 'RESERVED', 409, 'APPOINTMENT_STATE', '当前预约不可取消'); a.status = 'CANCELLED'; return structuredClone(a);
  }
  token(actor, cid) {
    this.role(actor, 'consumer'); const c = this.coupon(actor, cid); this.active(c);
    requireThat(this.appointments.some((a) => a.coupon === cid && a.status === 'RESERVED'), 409, 'APPOINTMENT_REQUIRED', '请先预约服务');
    const token = randomUUID(); this.tokens.set(token, { coupon: cid, expires: this.now() + 120000 });
    return { token, expires_at: this.now() + 120000, test_only: true };
  }
  preview(actor, body) {
    this.role(actor, 'merchant'); const t = this.tokens.get(body.token);
    requireThat(t && t.expires > this.now(), 422, 'TOKEN_INVALID', '核销口令无效或已过期');
    const c = this.coupons.find((x) => x.id === t.coupon);
    requireThat(c && c.merchant === actor.merchant && c.store === body.store, 403, 'STORE_FORBIDDEN', '不能核销其他商户或门店的券');
    this.active(c); const a = this.appointments.find((a) => a.coupon === c.id && a.status === 'RESERVED');
    requireThat(a, 409, 'APPOINTMENT_REQUIRED', '缺少有效预约');
    return { id: c.id, name: c.name, merchant: c.merchant, store: c.store, appointment_date: a.date, supplier_payable: calculate(c.basis, false).supplier, expected_payment: '核销后测试双周账期；非到账承诺', test_only: true };
  }
  redeem(actor, body) {
    const preview = this.preview(actor, body);
    requireThat(body.service_confirmed === true, 422, 'EVIDENCE_REQUIRED', '请确认测试履约完成并留存核销凭证');
    const c = this.coupons.find((c) => c.id === preview.id), o = this.orders.find((o) => o.id === c.order);
    const r = { id: id('redemption'), coupon: c.id, order: o.id, merchant: c.merchant, user: c.user, promoter: o.promoter, ...calculate(c.basis, !!o.promoter), at: this.now(), status: 'CONFIRMED', provider_released: false };
    c.status = 'REDEEMED'; this.appointments.find((a) => a.coupon === c.id && a.status === 'RESERVED').status = 'FULFILLED';
    this.redemptions.push(r);
    this.post(r.id, [{ account: 'unredeemed_liability', debit: r.basis }, { account: `supplier:${r.merchant}`, credit: r.supplier }, { account: `promoter:${r.promoter || 'none'}`, credit: r.channel }, { account: 'platform_retained', credit: r.retained }]);
    return { id: r.id, coupon: c.id, status: r.status, supplier_payable: r.supplier, expected_payment: preview.expected_payment, test_only: true };
  }
  post(source, lines) {
    const debit = lines.reduce((s, x) => s + (x.debit || 0), 0), credit = lines.reduce((s, x) => s + (x.credit || 0), 0);
    requireThat(debit === credit && lines.every((x) => Number.isSafeInteger(x.debit || 0) && Number.isSafeInteger(x.credit || 0) && (x.debit || 0) >= 0 && (x.credit || 0) >= 0), 422, 'LEDGER_UNBALANCED', '账务不平衡');
    this.ledger.push(Object.freeze({ id: id('ledger'), source, at: this.now(), lines: Object.freeze(lines.map((l) => Object.freeze({ ...l }))) }));
  }
  refund(actor, body) {
    this.role(actor, 'consumer'); const c = this.coupon(actor, body.coupon_id);
    requireThat(['ISSUED', 'REDEEMED'].includes(c.status), 409, 'REFUND_STATE', '该券已经在售后处理中或已退款');
    requireThat(typeof body.reason === 'string' && body.reason.trim().length >= 2 && body.reason.length <= 500, 422, 'REASON', '请填写售后原因（2–500字）');
    const row = { id: id('refund'), coupon: c.id, user: actor.id, previous: c.status, amount: c.basis, reason: body.reason, type: c.status === 'REDEEMED' ? 'SERVICE_FAILURE' : 'UNUSED', status: 'REQUESTED', requested_by: actor.id };
    c.status = 'FROZEN'; this.refunds.push(row); return structuredClone(row);
  }
  reviewRefund(actor, rid) {
    this.role(actor, 'admin'); const f = this.refunds.find((f) => f.id === rid);
    requireThat(f, 404, 'NOT_FOUND', '售后单不存在');
    if (f.status === 'SUCCEEDED') return structuredClone(f);
    requireThat(f.status === 'REQUESTED' && f.requested_by !== actor.id, 409, 'REVIEW', '需由另一名授权人员复核');
    const c = this.coupons.find((c) => c.id === f.coupon);
    if (f.type === 'SERVICE_FAILURE') {
      const compensation = { id: id('compensation'), refund: f.id, coupon: c.id, amount: f.amount, source: 'PLATFORM_OWN_COMPENSATION_ACCOUNT', recovery_merchant: c.merchant, recovery_amount: f.amount, recovered: 0, status: 'PAID_TEST', recovery_status: 'UNRECOVERED' };
      this.compensations.push(compensation);
      this.post(compensation.id, [{ account: `recovery_receivable:${c.merchant}`, debit: f.amount }, { account: 'platform_own_compensation_cash', credit: f.amount }]);
    } else this.post(f.id, [{ account: 'unredeemed_liability', debit: f.amount }, { account: 'provider_receivable', credit: f.amount }]);
    f.status = 'SUCCEEDED'; f.provider_ref = id('testrefund'); f.approved_by = actor.id; c.status = 'REFUNDED';
    this.appointments.filter((a) => a.coupon === c.id && a.status === 'RESERVED').forEach((a) => { a.status = 'CANCELLED'; });
    return structuredClone(f);
  }
  expire(actor, cid) {
    this.role(actor, 'admin'); const c = this.coupons.find((c) => c.id === cid);
    requireThat(c && c.status === 'ISSUED', 409, 'EXPIRY', '仅可推进未使用测试券至到期');
    c.valid_to = this.now() - 1; return this.expiryJob(actor);
  }
  expiryJob(actor) {
    this.role(actor, 'admin'); const done = [];
    for (const c of this.coupons.filter((c) => c.status === 'ISSUED' && c.valid_to <= this.now())) {
      c.status = 'FROZEN'; const f = { id: id('refund'), coupon: c.id, user: c.user, previous: 'ISSUED', amount: c.basis, reason: '有效期届满，自动原路退回（测试）', type: 'EXPIRED', status: 'REQUESTED', requested_by: 'expiry-job' };
      this.refunds.push(f); done.push(this.reviewRefund(actor, f.id));
    }
    return { processed: done.length, refunds: done };
  }
  recover(actor, cid) {
    this.role(actor, 'admin'); const c = this.compensations.find((c) => c.id === cid);
    requireThat(c && c.recovery_status === 'UNRECOVERED', 409, 'RECOVERY', '无待追回金额');
    this.post(c.id, [{ account: 'platform_own_compensation_cash', debit: c.amount }, { account: `recovery_receivable:${c.recovery_merchant}`, credit: c.amount }]);
    c.recovered = c.amount; c.recovery_status = 'RECOVERED_TEST'; return structuredClone(c);
  }
  release(actor) {
    this.role(actor, 'admin'); let n = 0;
    for (const r of this.redemptions.filter((r) => !r.provider_released)) {
      this.provider.credit(`merchant-${r.merchant}`, r.supplier);
      if (r.promoter) this.provider.credit(r.promoter, r.channel);
      r.provider_released = true; n++;
    }
    return { released: n, source: 'TEST_PROVIDER', message: '测试机构账期已到，可用金额为机构镜像' };
  }
  withdraw(actor, body) {
    this.role(actor, 'promoter', 'merchant');
    requireThat(Number.isSafeInteger(body.amount) && body.amount > 0, 422, 'MONEY', '请输入正整数分');
    const request = id('provider_request'); this.provider.reserve(actor.id, request, body.amount);
    const row = { id: id('payout'), provider_request: request, who: actor.id, amount: body.amount, status: 'PROCESSING', account_ref: 'TEST_ACCOUNT_ONLY', test_only: true };
    this.payouts.push(row); return structuredClone(row);
  }
  payout(actor, pid, action) {
    this.role(actor, 'admin'); const p = this.payouts.find((p) => p.id === pid);
    requireThat(p, 404, 'NOT_FOUND', '代发指令不存在'); const remote = this.provider.requests.get(p.provider_request);
    if (action === 'unknown') {
      requireThat(p.status === 'PROCESSING', 409, 'PAYOUT_STATE', '只有处理中的指令可以模拟超时');
      p.status = 'UNKNOWN'; remote.status = 'UNKNOWN'; remote.remote_status = 'PAID';
    } else if (action === 'query') { p.status = this.provider.query(p.provider_request).status; }
    else {
      requireThat(p.status === 'PROCESSING', 409, 'PAYOUT_STATE', '未知结果必须查原请求'); remote.remote_status = 'PAID'; p.status = this.provider.query(p.provider_request).status;
    }
    return structuredClone(p);
  }
  share(actor, body) {
    this.role(actor, 'promoter'); const p = this.product(body.product_id);
    const token = this.sign({ promoter: actor.id, product: p.id, expires: this.now() + 7 * DAY });
    return { token, href: `/juzhu-commerce.html?product=${p.id}&ref=${encodeURIComponent(token)}`, expires_at: this.now() + 7 * DAY };
  }
  helpRequest(actor, body) {
    this.role(actor, 'consumer'); this.own(this.orders.find((o) => o.id === body.order_id), actor);
    requireThat(['INVOICE', 'HELP'].includes(body.kind), 422, 'KIND', '请选择开票或帮助');
    const old = this.help.find((h) => h.order === body.order_id && h.kind === body.kind && h.status === 'REQUESTED');
    if (old) return structuredClone(old);
    const h = { id: id('help'), order: body.order_id, user: actor.id, kind: body.kind, status: 'REQUESTED', created_at: this.now(), sla: '1个工作日响应（测试）' };
    this.help.push(h); return structuredClone(h);
  }
  resolveHelp(actor, hid) {
    this.role(actor, 'admin'); const h = this.help.find((h) => h.id === hid);
    requireThat(h, 404, 'NOT_FOUND', '工单不存在'); h.status = 'RESOLVED'; h.reply = '已登记测试受理回复；未开具真实发票，未发送真实通知。'; h.resolved_by = actor.id; return structuredClone(h);
  }
  summary() {
    const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
    const paid = sum(this.orders.filter((o) => o.status === 'PAID'), 'total');
    const refunded = sum(this.refunds.filter((r) => r.status === 'SUCCEEDED' && r.type !== 'SERVICE_FAILURE'), 'amount');
    return { paid, supplier: sum(this.redemptions, 'supplier'), channel: sum(this.redemptions, 'channel'), retained: sum(this.redemptions, 'retained'), unredeemed: paid - sum(this.redemptions, 'basis') - refunded, refunded, compensation: sum(this.compensations, 'amount'), recovery: sum(this.compensations, 'recovered') };
  }
  view(actor) {
    requireThat(actor, 401, 'LOGIN_REQUIRED', '请先选择隔离测试身份');
    const base = { actor, test_only: true, now: this.now(), products: this.catalog(), sales_enabled: this.salesEnabled };
    if (actor.role === 'consumer') return { ...base, orders: structuredClone(this.orders.filter((o) => o.user === actor.id).map(({ promoter, ...o }) => o)), coupons: structuredClone(this.coupons.filter((c) => c.user === actor.id).map((c) => ({ ...c, availability: this.availability(c) }))), memberships: this.memberships.filter((m) => m.user === actor.id).map((m) => ({ ...m, status: m.end > this.now() ? 'ACTIVE' : 'EXPIRED' })), appointments: this.appointments.filter((a) => a.user === actor.id), refunds: this.refunds.filter((f) => f.user === actor.id), help: this.help.filter((h) => h.user === actor.id) };
    if (actor.role === 'merchant') return { ...base, appointments: this.appointments.filter((a) => a.merchant === actor.merchant).map(({ user, ...a }) => a), redemptions: this.redemptions.filter((r) => r.merchant === actor.merchant).map((r) => ({ id: r.id, coupon: r.coupon, at: r.at, supplier_payable: r.supplier, status: r.provider_released ? 'AVAILABLE_TEST' : 'CONFIRMED' })), provider_available: this.provider.available.get(actor.id) || 0, payouts: this.payouts.filter((p) => p.who === actor.id), provider_updated_at: this.now() };
    if (actor.role === 'promoter') return { ...base, commissions: this.redemptions.filter((r) => r.promoter === actor.id).map((r) => ({ id: r.id, at: r.at, amount: r.channel, status: r.provider_released ? 'AVAILABLE_TEST' : 'CONFIRMED' })), orders: this.orders.filter((o) => o.promoter === actor.id).map((o) => ({ id: o.id, name: o.name, status: o.status, grant_status: o.grant_status })), provider_available: this.provider.available.get(actor.id) || 0, payouts: this.payouts.filter((p) => p.who === actor.id), provider_updated_at: this.now() };
    this.role(actor, 'admin'); return { ...base, orders: structuredClone(this.orders), coupons: structuredClone(this.coupons), memberships: structuredClone(this.memberships), appointments: structuredClone(this.appointments), redemptions: structuredClone(this.redemptions), refunds: structuredClone(this.refunds), compensations: structuredClone(this.compensations), payouts: structuredClone(this.payouts), ledger: structuredClone(this.ledger), audit: structuredClone(this.audit.slice(-100)), summary: this.summary(), help: structuredClone(this.help) };
  }
}
module.exports = { Commerce, DomainError, identities, calculate, DAY };
