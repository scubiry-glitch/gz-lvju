'use strict';

const crypto = require('node:crypto');
const { assert } = require('./configuration.cjs');

const VERSION = '012_coupon_application';
const DDL = [
  `CREATE TABLE IF NOT EXISTS coupon_applications (
    id VARCHAR(36) PRIMARY KEY, coupon_id VARCHAR(40) NOT NULL,
    account_id BIGINT NOT NULL, biz_type VARCHAR(24) NOT NULL,
    order_no VARCHAR(64) NOT NULL, mode VARCHAR(24) NOT NULL,
    city_id BIGINT NOT NULL, vendor_id BIGINT NOT NULL, item_id BIGINT NOT NULL,
    listed_minor BIGINT NOT NULL, gross_minor BIGINT NOT NULL, coupon_minor BIGINT NOT NULL, cash_minor BIGINT NOT NULL,
    original_order_id VARCHAR(40) NOT NULL, original_payment_id VARCHAR(64) NOT NULL,
    policy_snapshot JSON NOT NULL, status VARCHAR(24) NOT NULL,
    active_coupon_id VARCHAR(40) GENERATED ALWAYS AS
      (CASE WHEN status IN ('reserved','committed','consumed') THEN coupon_id ELSE NULL END) STORED,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_active_coupon(active_coupon_id), UNIQUE KEY uk_target_order(biz_type,order_no),
    KEY owner_idx(account_id,created_at), KEY original_idx(original_order_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS coupon_application_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, application_id VARCHAR(36) NOT NULL,
    event_type VARCHAR(24) NOT NULL, evidence JSON NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY application_idx(application_id,id)
  ) ENGINE=InnoDB`,
];
const COLUMNS = [
  ['booking_orders','coupon_minor','BIGINT NOT NULL DEFAULT 0'],
  ['booking_orders','cash_due_minor','BIGINT NULL'],
  ['booking_orders','coupon_application_id','VARCHAR(36) NULL'],
  ['jz_orders','coupon_minor','BIGINT NOT NULL DEFAULT 0'],
  ['jz_orders','cash_due_minor','BIGINT NULL'],
  ['jz_orders','coupon_application_id','VARCHAR(36) NULL'],
];
const checksum = crypto.createHash('sha256').update(DDL.join('\n') + JSON.stringify(COLUMNS)).digest('hex');
async function migrate(conn) {
  await conn.query('CREATE TABLE IF NOT EXISTS commerce_migrations(version VARCHAR(64) PRIMARY KEY,checksum CHAR(64) NOT NULL,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB');
  const [found] = await conn.execute('SELECT checksum FROM commerce_migrations WHERE version=?', [VERSION]);
  if (found.length && found[0].checksum !== checksum) throw Error('Coupon application migration checksum changed');
  if (!found.length) for (const sql of DDL) await conn.query(sql);
  for (const [table,column,type] of COLUMNS) {
    const [present] = await conn.execute('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table]);
    if (!present.length) continue;
    const [existing] = await conn.execute('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [table,column]);
    if (!existing.length) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
  }
  if (!found.length) await conn.execute('INSERT INTO commerce_migrations(version,checksum) VALUES(?,?)', [VERSION, checksum]);
}
function policyOf(coupon) {
  const snapshot = typeof coupon.snapshot === 'string' ? JSON.parse(coupon.snapshot) : coupon.snapshot || {};
  const sku = snapshot.sku || {};
  const mode = sku.use_mode;
  assert(['exchange','amount_offset'].includes(mode), '此券未发布跨业务用券规则', 409);
  assert(Array.isArray(sku.use_domains) && sku.use_domains.length > 0, '此券缺少适用业务域', 409);
  return { mode, domains: sku.use_domains, exchangeContractMinor: sku.exchange_contract_minor || null, bookingProjectIds: sku.booking_project_ids || [],
    lifeProductIds: sku.life_product_ids || [], vendorIds: sku.use_vendor_ids || [],
    skuVersion: snapshot.sku_version, originalRule: snapshot.rule || null };
}
function calculate({ mode, grossMinor, faceMinor, contractMinor, unitCount = 1 }) {
  const listed = Number(grossMinor), face = Number(faceMinor);
  assert(Number.isSafeInteger(listed) && listed > 0 && Number.isSafeInteger(face) && face > 0, '用券金额无效', 409);
  let gross = listed;
  if (mode === 'exchange') {
    assert(Number.isSafeInteger(unitCount) && unitCount === 1, '直接兑换券每单只覆盖一项签约服务', 409);
    gross = Number(contractMinor);
    assert(Number.isSafeInteger(gross) && gross > 0 && gross === face, '直接兑换项目与券的签约兑付金额不一致', 409);
  }
  // First release consumes a whole funded coupon. No silent change or subsidy.
  assert(gross >= face, '合格金额低于券面值，暂不能使用此券', 409);
  return { listed_minor: listed, gross_minor: gross, coupon_minor: face, cash_minor: gross - face };
}
function validateScope(policy, { bizType, cityId, vendorId, itemId }) {
  assert(policy.domains.includes(bizType), '此券不适用于该业务', 409);
  assert(policy.vendorIds.map(String).includes(String(vendorId)), '此券不适用于该商户', 409);
  const allowed = bizType === 'booking' ? policy.bookingProjectIds : policy.lifeProductIds;
  assert(allowed.map(String).includes(String(itemId)), '此券不适用于该项目或服务', 409);
  assert(Number.isSafeInteger(Number(cityId)) && Number(cityId) > 0, '用券城市无效', 409);
}
async function quote(conn, { couponId, accountId, bizType, cityId, vendorId, itemId, grossMinor, unitCount = 1, lock = false }) {
  assert(['booking','jiazheng'].includes(bizType), '用券业务域无效', 400);
  assert(/^[0-9a-f-]{36,40}$/i.test(String(couponId)), '券编号无效', 400);
  const [coupons] = await conn.execute(`SELECT *,expires_at>UTC_TIMESTAMP() AS still_valid FROM commerce_coupons WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [couponId]);
  const coupon = coupons[0];
  assert(coupon && String(coupon.account_id) === String(accountId), '券不存在或不属于当前账号', 404);
  assert(coupon.status === 'available' && Number(coupon.still_valid) === 1, '券已失效或被占用', 409);
  assert(String(coupon.city_id) === String(cityId), '此券不适用于该城市', 409);
  const snapshot = typeof coupon.snapshot === 'string' ? JSON.parse(coupon.snapshot) : coupon.snapshot || {};
  assert(snapshot.is_demo !== true && snapshot.sku?.is_demo !== true, '演示券不能抵扣真实服务', 409);
  const [appointments]=await conn.execute("SELECT id FROM commerce_appointments WHERE coupon_id=? AND status='booked' LIMIT 1",[couponId]);
  assert(!appointments.length,'券已有到店预约，请先取消预约',409);
  const policy = policyOf(coupon);
  validateScope(policy, { bizType, cityId, vendorId, itemId });
  const [orders] = await conn.execute(`SELECT * FROM commerce_orders WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [coupon.order_id]);
  const original = orders[0];
  assert(original && String(original.account_id) === String(accountId) && String(original.city_id) === String(cityId)
    && original.payment_status === 'paid' && original.paid_payment_order_id && Number(original.refunded_minor || 0) === 0,
    '券原款未确认或已发生退款', 409);
  const originalSnapshot = typeof original.snapshot === 'string' ? JSON.parse(original.snapshot) : original.snapshot || {};
  assert(originalSnapshot.settlement_profiles?.[coupon.merchant_id], '券原款缺少已批准的真实结算协议', 409);
  assert(Number(coupon.allocation_minor) > 0, '券没有可用的已筹资金额', 409);
  const amounts = calculate({ mode: policy.mode, grossMinor, faceMinor: coupon.allocation_minor,
    contractMinor: policy.exchangeContractMinor, unitCount });
  return { coupon, original, policy, ...amounts };
}
async function listQuotes(conn, input) {
  const [coupons] = await conn.execute("SELECT id FROM commerce_coupons WHERE account_id=? AND city_id=? AND status='available' AND expires_at>UTC_TIMESTAMP() ORDER BY expires_at,id LIMIT 100", [input.accountId,input.cityId]);
  const out=[];
  for(const item of coupons){
    try{
      const q=await quote(conn,{...input,couponId:item.id});
      const snapshot=typeof q.coupon.snapshot==='string'?JSON.parse(q.coupon.snapshot):q.coupon.snapshot||{};
      out.push({coupon_id:item.id,name:snapshot.sku?.name||snapshot.name||'权益券',mode:q.policy.mode,
        listed_minor:q.listed_minor,gross_minor:q.gross_minor,coupon_minor:q.coupon_minor,cash_minor:q.cash_minor,expires_at:q.coupon.expires_at});
    }catch(error){if(!Number.isInteger(error.status)||error.status>=500)throw error;}
  }
  return out;
}
async function reserve(conn, { couponId, accountId, bizType, orderNo, cityId, vendorId, itemId, grossMinor, unitCount = 1 }) {
  assert(/^[A-Za-z0-9_.:-]{3,64}$/.test(String(orderNo)), '目标订单号无效', 400);
  const [prior] = await conn.execute('SELECT * FROM coupon_applications WHERE biz_type=? AND order_no=? FOR UPDATE', [bizType, orderNo]);
  if (prior.length) {
    const a = prior[0];
    assert(a.coupon_id === couponId && String(a.account_id) === String(accountId) && Number(a.listed_minor) === Number(grossMinor) && a.status !== 'released', '目标订单用券记录冲突', 409);
    return a;
  }
  const q = await quote(conn, { couponId, accountId, bizType, cityId, vendorId, itemId, grossMinor, unitCount, lock: true });
  const id = crypto.randomUUID();
  await conn.execute(`INSERT INTO coupon_applications(id,coupon_id,account_id,biz_type,order_no,mode,city_id,vendor_id,item_id,
    listed_minor,gross_minor,coupon_minor,cash_minor,original_order_id,original_payment_id,policy_snapshot,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved')`,
  [id, couponId, accountId, bizType, orderNo, q.policy.mode, cityId, vendorId, itemId,
    q.listed_minor, q.gross_minor, q.coupon_minor, q.cash_minor, q.original.id, String(q.original.paid_payment_order_id), JSON.stringify(q.policy)]);
  const [updated] = await conn.execute("UPDATE commerce_coupons SET status='reserved' WHERE id=? AND status='available'", [couponId]);
  assert(updated.affectedRows === 1, '券已被其他订单占用', 409);
  await conn.execute("INSERT INTO coupon_application_events(application_id,event_type,evidence) VALUES(?,'reserved',?)", [id, JSON.stringify({ order_no: orderNo })]);
  return { id, coupon_id: couponId, account_id: accountId, biz_type: bizType, order_no: orderNo,
    mode: q.policy.mode, listed_minor: q.listed_minor, gross_minor: q.gross_minor, coupon_minor: q.coupon_minor, cash_minor: q.cash_minor,
    original_order_id: q.original.id, original_payment_id: String(q.original.paid_payment_order_id), status: 'reserved' };
}
async function assertFundingRoute(conn, application, profile) {
  assert(application && profile?.source_account_id, '用券订单缺少目标结算资金账户', 409);
  const [coupons] = await conn.execute('SELECT merchant_id FROM commerce_coupons WHERE id=?', [application.coupon_id]);
  const [orders] = await conn.execute('SELECT snapshot FROM commerce_orders WHERE id=?', [application.original_order_id]);
  const snapshot = typeof orders[0]?.snapshot === 'string' ? JSON.parse(orders[0].snapshot) : orders[0]?.snapshot || {};
  const original = snapshot.settlement_profiles?.[coupons[0]?.merchant_id];
  assert(original && String(original.source_account_id) === String(profile.source_account_id),
    '此券原款与服务商户的结算资金路线不兼容', 409);
}
async function transition(conn, { bizType, orderNo, from, to, evidence = {} }) {
  const [rows] = await conn.execute('SELECT * FROM coupon_applications WHERE biz_type=? AND order_no=? FOR UPDATE', [bizType, orderNo]);
  const app = rows[0]; if (!app) return null;
  if (app.status === to) return app;
  assert(from.includes(app.status), '用券状态不允许此操作', 409);
  if (to === 'released') {
    const [coupon] = await conn.execute('SELECT status,expires_at>UTC_TIMESTAMP() AS still_valid FROM commerce_coupons WHERE id=? FOR UPDATE', [app.coupon_id]);
    assert(coupon[0]?.status === 'reserved', '券当前状态不允许释放', 409);
    // Free cancellation does not erase an entitlement while it was held by this order.
    if (Number(coupon[0].still_valid) === 1) await conn.execute("UPDATE commerce_coupons SET status='available' WHERE id=?", [app.coupon_id]);
    else await conn.execute("UPDATE commerce_coupons SET status='available',expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 24 HOUR) WHERE id=?", [app.coupon_id]);
  } else if (to === 'consumed') {
    const [coupon] = await conn.execute('SELECT status FROM commerce_coupons WHERE id=? FOR UPDATE', [app.coupon_id]);
    assert(coupon[0]?.status === 'reserved', '券当前状态不允许履约', 409);
    await conn.execute("UPDATE commerce_coupons SET status='redeemed' WHERE id=?", [app.coupon_id]);
  }
  await conn.execute('UPDATE coupon_applications SET status=? WHERE id=?', [to, app.id]);
  await conn.execute('INSERT INTO coupon_application_events(application_id,event_type,evidence) VALUES(?,?,?)', [app.id, to, JSON.stringify(evidence)]);
  return { ...app, status: to };
}
async function recognizeApplied(conn, { bizType, orderNo, profile, targetOrder, cashPaymentId, recognitionId, context }) {
  const business = require('../server/settlement/business.cjs');
  const primitives = require('../server/settlement/primitives.cjs');
  const [applications] = await conn.execute('SELECT * FROM coupon_applications WHERE biz_type=? AND order_no=? FOR UPDATE', [bizType, orderNo]);
  const app = applications[0];
  assert(app && ['reserved','committed','consumed'].includes(app.status), '目标订单没有有效的用券占用', 409);
  const gross = BigInt(app.gross_minor), couponAmount = BigInt(app.coupon_minor), cash = BigInt(app.cash_minor);
  assert(gross === couponAmount + cash && gross > 0n, '订单资金拆分不守恒', 409);
  const [coupons] = await conn.execute('SELECT * FROM commerce_coupons WHERE id=? FOR UPDATE', [app.coupon_id]);
  const coupon = coupons[0];
  assert(coupon && String(coupon.account_id) === String(app.account_id) && (coupon.status === 'reserved' || app.status === 'consumed'), '券身份或占用状态不一致', 409);
  const [orders] = await conn.execute('SELECT * FROM commerce_orders WHERE id=? FOR UPDATE', [app.original_order_id]);
  const original = orders[0];
  assert(original && String(original.account_id) === String(app.account_id) && String(original.city_id) === String(app.city_id)
    && original.payment_status === 'paid' && Number(original.refunded_minor || 0) === 0 && String(original.paid_payment_order_id) === String(app.original_payment_id), '券原款已变更或发生退款', 409);
  const originalSnapshot = typeof original.snapshot === 'string' ? JSON.parse(original.snapshot) : original.snapshot || {};
  const profiles = originalSnapshot.settlement_profiles || {};
  const originalProfile = profiles[coupon.merchant_id];
  assert(originalProfile && profile && String(originalProfile.source_account_id) === String(profile.source_account_id), '券原款与目标商户结算资金路线不兼容', 409);
  const originalContext = await business.registerContext(conn, {
    biz_type:'commerce', source_order_system:'commerce_orders', biz_order_no:original.id,
    party_id:Object.values(profiles)[0].party_id,
    snapshot:{settlement_profile:Object.values(profiles)[0],profiles,account_id:String(original.account_id),city_id:original.city_id},
  });
  assert(primitives.hash(originalContext.snapshot.settlement_profile) === primitives.hash(Object.values(profiles)[0]), '券原款结算合同已变化', 409);
  const couponSource = await business.funding(conn, originalContext, app.original_payment_id);
  const targetContext = context || await business.registerContext(conn, {
    biz_type:bizType, source_order_system:bizType==='booking'?'booking_orders':'jz_orders', biz_order_no:orderNo,
    party_id:profile.party_id, snapshot:{settlement_profile:profile,account_id:String(app.account_id),city_id:app.city_id},
  });
  assert(primitives.hash(targetContext.snapshot.settlement_profile) === primitives.hash(profile), '目标订单结算合同已变化', 409);
  const full = primitives.calculate({...profile.calculation,amount_minor:gross.toString(),promoter_party_id:null});
  const couponMerchant = BigInt(full.merchant_minor) * couponAmount / gross;
  const couponCommission = BigInt(full.commission_minor) * couponAmount / gross;
  const cashMerchant = BigInt(full.merchant_minor) - couponMerchant;
  const cashCommission = BigInt(full.commission_minor) - couponCommission;
  const legProfile = (amount, merchant, commission) => ({...profile,calculation:{...profile.calculation,mode:'FIXED_COST',fixed_cost_minor:merchant.toString(),fixed_commission_minor:commission.toString()}});
  const evidence = { coupon_application_id:app.id,coupon_id:app.coupon_id,original_order_id:original.id,
    original_payment_id:app.original_payment_id,target_order_no:orderNo,recognition_id:recognitionId,
    gross_minor:gross.toString(),coupon_minor:couponAmount.toString(),cash_minor:cash.toString() };
  const units = [];
  units.push(await business.recognize(conn, {ctx:targetContext,unit_key:orderNo+':coupon',recognition_id:recognitionId+':coupon',
    amount_minor:couponAmount.toString(),source:couponSource,profile:legProfile(couponAmount,couponMerchant,couponCommission),
    evidence:{...evidence,source:'coupon'},coupon_id:app.coupon_id,merchant_id:app.vendor_id,city_id:app.city_id,
    promoter_account_id:original.source_account_id,liability_account:'unredeemed_liability'}));
  if (cash > 0n) {
    assert(cashPaymentId, '现金差额尚未完成支付', 409);
    const cashSource = await business.funding(conn, targetContext, cashPaymentId);
    assert(String(cashSource.received_minor) === cash.toString(), '现金实收与用券报价不一致', 409);
    units.push(await business.recognize(conn, {ctx:targetContext,unit_key:orderNo+':cash',recognition_id:recognitionId+':cash',
      amount_minor:cash.toString(),source:cashSource,profile:legProfile(cash,cashMerchant,cashCommission),
      evidence:{...evidence,source:'cash',cash_payment_id:String(cashPaymentId)},merchant_id:app.vendor_id,city_id:app.city_id}));
  }
  await transition(conn, {bizType,orderNo,from:['reserved','committed'],to:'consumed',evidence:{recognition_id:recognitionId,settlement_unit_ids:units.map(u=>u.id)}});
  return {application:app,units,calculation:full};
}
module.exports = { migrate, quote, listQuotes, reserve, assertFundingRoute, transition, recognizeApplied, calculate, policyOf, validateScope };
