'use strict';

const crypto = require('node:crypto');
const { fail, parseObject, paymentConfig } = require('./vendor-payment.cjs');
const utc = (value = new Date()) => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
const accountUser = id => 'commerce-account-' + String(id);
function amountMinor(value) {
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw fail('商品价格无效', 400);
  const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > 2147483647) throw fail('商品价格超出支付范围', 400);
  return amount;
}
function normalizeOrder(input) {
  const productId = Number(input.productId), slotId = input.slotId ? Number(input.slotId) : null;
  const requestKey = String(input.requestKey || '').trim();
  if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(requestKey)) throw fail('请提供有效的 Idempotency-Key', 400);
  if (!Number.isSafeInteger(productId) || productId <= 0 || (slotId !== null && (!Number.isSafeInteger(slotId) || slotId <= 0))) throw fail('商品或档期无效', 400);
  const house = String(input.house || '').trim(), phone = String(input.phone || '').trim();
  const expectTime = String(input.expectTime || '').trim(), desc = String(input.desc || '').trim();
  if (!house || house.length > 500 || !/^1\d{10}$/.test(phone) || !expectTime || expectTime.length > 100 || desc.length > 2000) throw fail('请填写服务地址、11 位手机号和服务时间', 400);
  const priceMinor = input.priceMinor == null ? null : Number(input.priceMinor);
  if (priceMinor !== null && (!Number.isSafeInteger(priceMinor) || priceMinor < 0)) throw fail('确认价格无效', 400);
  const couponId = input.couponId == null || input.couponId === '' ? null : String(input.couponId);
  if (couponId && !/^[0-9a-f-]{36,40}$/i.test(couponId)) throw fail('券编号无效', 400);
  const fields = { productId, slotId, house, phone, expectTime, desc, priceMinor, couponId };
  const hashFields = couponId ? fields : { productId, slotId, house, phone, expectTime, desc, priceMinor };
  return { ...fields, requestKey, requestHash: crypto.createHash('sha256').update(JSON.stringify(hashFields)).digest('hex') };
}
function createJiazhengAdapter({ createConnection, paymentCore, config = process.env }) {
  async function projectOrder(conn, order) {
    const snapshot = parseObject(order.payment_config_snapshot);
    const status = order.status === 'cancelled' ? 'cancelled'
      : ['done', 'rated'].includes(order.status) ? 'completed'
      : order.status === 'serving' ? 'serving'
      : ['dispatched', 'accepted'].includes(order.status) ? 'assigned'
      : ['paid','coupon_funded'].includes(order.pay_status) ? 'paid' : 'pending';
    const [existing] = await conn.execute('SELECT user_id FROM gr_orders WHERE order_ref=? FOR UPDATE', [order.id]);
    if (existing.length && existing[0].user_id !== accountUser(order.account_id)) throw fail('主订单归属不一致');
    if (!existing.length) {
      await conn.execute(`INSERT INTO gr_orders(order_ref,vendor_id,user_id,sku,city,status,fee,created_at,updated_at,
        biz_type,payment_mode,account_id,pay_status,refund_status,order_snapshot)
        VALUES(?,?,?,?,?,?,?,?,?,'jiazheng','pay_center',?,?,?,?)`,
      [order.id, order.vendor_id, accountUser(order.account_id), String(order.product_id), snapshot.cityName || '', status,
        order.fee, order.created_at, order.updated_at, String(order.account_id), order.pay_status, order.refund_status || null,
        JSON.stringify({ product_name: snapshot.productTitle, category_id: order.category_id, cancel_policy: snapshot.cancelPolicy })]);
    } else {
      await conn.execute(`UPDATE gr_orders SET status=?,pay_status=?,refund_status=?,fee=?,updated_at=?,paid_at=COALESCE(paid_at,?),
        completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE completed_at END WHERE order_ref=? AND user_id=? AND payment_mode='pay_center'`,
      [status, order.pay_status, order.refund_status || null, order.fee, order.updated_at, order.pay_at || null,
        status, order.updated_at, order.id, accountUser(order.account_id)]);
    }
  }
  async function createOrder(input, attempt = 0) {
    const account = input.account;
    if (!account || !account.id || account.status === 'locked') throw fail('请先登录本人账号', 401);
    if (account.idp_type !== 'beike' || !account.idp_subject) throw fail('在线支付请使用贝壳账号登录', 403);
    const data = normalizeOrder(input), conn = await createConnection();
    try {
      await conn.beginTransaction();
      const [old] = await conn.execute('SELECT * FROM jz_orders WHERE account_id=? AND request_key=? FOR UPDATE', [String(account.id), data.requestKey]);
      if (old.length) {
        if (old[0].request_hash !== data.requestHash) throw fail('同一请求键对应不同下单内容');
        await conn.commit(); return { order: old[0], reused: true };
      }
      const [products] = await conn.execute(`SELECT p.*,s.category_id,s.name AS sku_name,c.name AS category_name,
        v.payment_mode,v.payment_config_version,v.payment_config_json,v.pay_merchant_no,v.city_ids,v.status AS vendor_status,
        cities.name AS city_name FROM jz_products p JOIN jz_skus s ON s.id=p.channel_sku_id
        JOIN jz_categories c ON c.id=s.category_id JOIN jz_vendors v ON v.id=p.vendor_id
        LEFT JOIN cities ON cities.id=p.city_id
        WHERE p.id=? AND p.status='on' AND s.enabled=1 AND c.enabled=1 FOR UPDATE`, [data.productId]);
      const product = products[0];
      if (!product || product.vendor_status !== 'active') throw fail('商品不存在或商家暂停服务', 404);
      if (product.payment_mode !== 'pay_center') throw fail('该商家未开通本站支付，请返回商品页');
      if (!product.city_id || (String(product.city_ids || '').trim() && !String(product.city_ids).split(',').map(s => s.trim()).includes(String(product.city_id)))) throw fail('该商品暂无可用服务城市');
      if (/^(guiyang|shenyang)-life-demo-v1:/.test(String(product.query || ''))) throw fail('演示商品不支持真实付款');
      const listedFee = amountMinor(product.price);
      if (listedFee <= 0) throw fail('此项为咨询或估价服务，无需在线付款');
      if (data.priceMinor !== null && data.priceMinor !== listedFee) throw fail('价格已更新，请返回商品页确认后重新提交');
      const merchantNo = String(product.pay_merchant_no || '').trim();
      if (!merchantNo) throw fail('商家尚未完成收款配置');
      const settings = paymentConfig(product.payment_config_json);
      const now = utc(), expiresAt = utc(Date.now() + 15 * 60 * 1000);
      const id = 'WO-' + crypto.randomBytes(14).toString('hex');
      const couponUse = require('../../commerce/coupon-application.cjs');
      const application = data.couponId ? await couponUse.reserve(conn, {
        couponId: data.couponId, accountId: account.id, bizType: 'jiazheng', orderNo: id,
        cityId: product.city_id, vendorId: product.vendor_id, itemId: product.id, grossMinor: listedFee,
      }) : null;
      const fee = application ? Number(application.gross_minor) : listedFee;
      const cashDue = application ? Number(application.cash_minor) : fee;
      const snapshot = { ...settings, merchantNo, productTitle: product.title, skuName: product.sku_name,
        categoryName: product.category_name, cityName: product.city_name, priceMinor: fee, listedPriceMinor: listedFee,
        coupon_application_id: application?.id || null, coupon_minor: application ? Number(application.coupon_minor) : 0, cash_due_minor: cashDue,
        cancelPolicy: 'before_dispatch_full_refund' };
      const settlementProfile = await require('../settlement/business.cjs').captureProfile(conn, { biz_type: 'jiazheng', entity_id: product.vendor_id, payment_mode: 'pay_center' }, config);
      if (application && !settlementProfile) throw fail('该商户尚未完成用券结算准入', 409);
      if (application) await couponUse.assertFundingRoute(conn, application, settlementProfile);
      if(settlementProfile&&settlementProfile.collection.source_merchant_no!==merchantNo)throw fail('商户收款配置与已批准的受控结算账户不一致');
      if (settlementProfile) snapshot.settlement_profile = settlementProfile;
      const order = { id, account_id: String(account.id), product_id: product.id, vendor_id: product.vendor_id,
        city_id: product.city_id, sku_id: product.channel_sku_id, category_id: product.category_id, type: product.category_id,
        house: data.house, phone: data.phone, expect_time: data.expectTime, desc: data.desc, source: '新居住中台支付', fee, pay_status: cashDue ? 'unpaid' : 'coupon_funded', status: 'pending',
        coupon_minor: application ? Number(application.coupon_minor) : 0, cash_due_minor: cashDue, coupon_application_id: application?.id || null,
        slot_id: data.slotId, slot_reserved: data.slotId ? 1 : 0, payment_mode: 'pay_center',
        payment_config_version: Number(product.payment_config_version || 0), payment_config_snapshot: JSON.stringify(snapshot),
        expires_at: expiresAt, created_at: now, updated_at: now };
      await conn.execute(`INSERT INTO jz_orders(id,sku_id,category_id,type,house,phone,expect_time,\`desc\`,fee,pay_status,status,coupon_minor,cash_due_minor,coupon_application_id,
        slot_id,source,created_at,updated_at,log_json,account_id,product_id,vendor_id,city_id,payment_mode,payment_config_version,
        payment_config_snapshot,request_key,request_hash,expires_at,slot_reserved)
        VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,'新居住中台支付',?,?,?,?,?,?,?,'pay_center',?,?,?,?,?,?)`,
      [id, order.sku_id, order.category_id, order.type, data.house, data.phone, data.expectTime, data.desc, fee, order.pay_status, order.coupon_minor, cashDue, order.coupon_application_id, data.slotId,
        now, now, JSON.stringify([{ at: now, action: 'created' }]), order.account_id, order.product_id, order.vendor_id, order.city_id,
        order.payment_config_version, order.payment_config_snapshot, data.requestKey, data.requestHash, expiresAt, order.slot_reserved]);
      if (cashDue) await paymentCore.registerOrder(conn, { bizType: 'jiazheng', orderId: id, accountId: order.account_id, amountMinor: cashDue,
        merchantNo, payerUcid: account.idp_subject, payerUserType: config.PAY_USER_TYPE || '2', ...settings,
        expiresAt, title: product.title, configVersion: order.payment_config_version, snapshot });
      if (data.slotId) {
        const [slots] = await conn.execute(`SELECT * FROM jz_sku_slots WHERE id=? AND product_id=? FOR UPDATE`, [data.slotId, data.productId]);
        const slot = slots[0], instant = slot && Date.parse(slot.slot_date + 'T' + slot.start_time + (String(slot.start_time).length === 5 ? ':00' : '') + '+08:00');
        if (!slot || slot.status !== 'open' || slot.booked >= slot.capacity || !Number.isFinite(instant) || instant <= Date.now() + Number(product.advance_booking_hours || 0) * 3600000) throw fail('档期已满或已过预约时间，请重新选择');
        await conn.execute('UPDATE jz_sku_slots SET booked=booked+1 WHERE id=? AND booked<capacity', [data.slotId]);
        order.expect_time = slot.slot_date + ' ' + slot.start_time;
        await conn.execute('UPDATE jz_orders SET expect_time=? WHERE id=?', [order.expect_time, id]);
      }
      await projectOrder(conn, order);
      await conn.commit();
      return { order, reused: false };
    } catch (error) {
      await conn.rollback();
      if (error.code === 'ER_LOCK_DEADLOCK' && attempt < 2) return createOrder(input, attempt + 1);
      if (error.code === 'ER_DUP_ENTRY' || error.code === 'ER_LOCK_DEADLOCK') {
        const [old] = await conn.execute('SELECT * FROM jz_orders WHERE account_id=? AND request_key=?', [String(account.id), data.requestKey]);
        if (old[0]) {
          if (old[0].request_hash !== data.requestHash) throw fail('同一请求键对应不同下单内容');
          return { order: old[0], reused: true };
        }
      }
      throw error;
    } finally { await conn.end(); }
  }
  async function releaseSlot(conn, order) {
    if (order.slot_id && Number(order.slot_reserved) > 0) {
      await conn.execute('UPDATE jz_sku_slots SET booked=GREATEST(booked-1,0) WHERE id=?', [order.slot_id]);
      await conn.execute('UPDATE jz_orders SET slot_reserved=0 WHERE id=?', [order.id]);
      order.slot_reserved = 0;
    }
  }
  async function handleEvent(conn, event, guard) {
    const orderId = event.order_id || guard.biz_order_no;
    const [rows] = await conn.execute('SELECT * FROM jz_orders WHERE id=? FOR UPDATE', [orderId]);
    const order = rows[0];
    if (!order || order.payment_mode !== 'pay_center' || String(order.account_id) !== String(guard.account_id)) throw fail('生活服务订单归属与支付记录不一致');
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload || {};
    if (event.event_type === 'payment.accepted') {
      if (String(payload.paymentId) !== String(guard.paid_payment_id) || Number(payload.amountMinor) !== Number(order.cash_due_minor ?? order.fee)) throw fail('生活服务支付金额或关联不一致');
      if (order.status === 'cancelled' && order.refund_status) return;
      if (order.status === 'cancelled') throw fail('已取消服务单不可恢复履约');
      await conn.execute(`UPDATE jz_orders SET pay_status='paid',pay_at=COALESCE(pay_at,?),pay_method='pay_center',
        slot_reserved=CASE WHEN slot_reserved=1 THEN 2 ELSE slot_reserved END,updated_at=? WHERE id=?`, [utc(), utc(), order.id]);
      order.pay_status = 'paid'; order.pay_at = order.pay_at || utc();
      await require('../settlement/business.cjs').onPaymentAccepted(conn,{biz_type:'jiazheng',order,guard});
    } else if (event.event_type === 'order.closed') {
      if (order.pay_status === 'paid' || order.refund_status) return;
      await releaseSlot(conn, order);
      await conn.execute("UPDATE jz_orders SET status='cancelled',pay_status='closed',updated_at=? WHERE id=?", [utc(), order.id]);
      if (order.coupon_application_id) await require('../../commerce/coupon-application.cjs').transition(conn, { bizType:'jiazheng', orderNo:order.id, from:['reserved','committed'], to:'released', evidence:{payment_event:'order.closed'} });
      order.status = 'cancelled'; order.pay_status = 'closed';
    } else if (event.event_type === 'refund.succeeded') {
      if (String(payload.paymentId || '') !== String(guard.paid_payment_id || '') || !guard.paid_payment_id) return;
      const sharedRefund=await require('../settlement/business.cjs').onRefundSucceeded(conn,{biz_type:'jiazheng',order,payload});
      if (!sharedRefund && Number(payload.amountMinor) !== Number(order.cash_due_minor ?? order.fee)) throw fail('生活服务退款金额不一致');
      if(sharedRefund){const [[totals]]=await conn.execute("SELECT COALESCE(SUM(amount_minor),0) amount FROM payment_refunds WHERE payment_order_id=? AND refund_status='refunded'",[guard.paid_payment_id]);if(BigInt(totals.amount)<BigInt(order.cash_due_minor ?? order.fee)){await conn.execute("UPDATE jz_orders SET refund_status='partially_refunded',updated_at=? WHERE id=?",[utc(),order.id]);order.refund_status='partially_refunded';order.updated_at=utc();await projectOrder(conn,order);return;}}
      if (order.coupon_application_id) await require('../../commerce/coupon-application.cjs').transition(conn, { bizType:'jiazheng', orderNo:order.id, from:['reserved','committed'], to:'released', evidence:{refund_id:payload.refundId} });
      await releaseSlot(conn, order);
      await conn.execute("UPDATE jz_orders SET status='cancelled',pay_status='refunded',refund_status='refunded',updated_at=? WHERE id=?", [utc(), order.id]);
      order.status = 'cancelled'; order.pay_status = 'refunded'; order.refund_status = 'refunded';
    } else return;
    order.updated_at = utc(); await projectOrder(conn, order);
  }
  async function cancel({ account, orderId, requestKey, reason }) {
    if (!account || !account.id) throw fail('请先登录本人账号', 401);
    const conn = await createConnection();
    try {
      await conn.beginTransaction();
      const [guards] = await conn.execute("SELECT * FROM payment_order_guards WHERE biz_type='jiazheng' AND biz_order_no=? FOR UPDATE", [orderId]);
      const [rows] = await conn.execute('SELECT * FROM jz_orders WHERE id=? AND account_id=? FOR UPDATE', [orderId, String(account.id)]);
      const order = rows[0], guard = guards[0];
      if (!order || order.payment_mode !== 'pay_center' || (!guard && order.pay_status !== 'coupon_funded')) throw fail('订单不存在或不支持线上取消', 404);
      if (order.status === 'cancelled') { await conn.commit(); return { order, reused: true }; }
      if (order.status !== 'pending') throw fail('服务已派单，请通过售后协商取消');
      if (!guard) {
        await releaseSlot(conn, order);
        await require('../../commerce/coupon-application.cjs').transition(conn, { bizType:'jiazheng', orderNo:order.id, from:['reserved','committed'], to:'released', evidence:{reason:'customer_cancel'} });
        await conn.execute("UPDATE jz_orders SET status='cancelled',pay_status='closed',updated_at=? WHERE id=?", [utc(), order.id]);
        order.status='cancelled';order.pay_status='closed';order.updated_at=utc();await projectOrder(conn,order);
        await conn.commit();return {order,ok:true};
      }
      let result;
      if (guard.paid_payment_id) {
        const snapshot = parseObject(order.payment_config_snapshot);
        if (snapshot.cancelPolicy !== 'before_dispatch_full_refund') throw fail('该订单需通过售后确认退款规则');
        result = await paymentCore.requestRefund({ bizType: 'jiazheng', orderId, paymentId: guard.paid_payment_id,
          amountMinor: Number(order.cash_due_minor ?? order.fee), requestKey: 'jiazheng-cancel:' + order.id, source: 'customer_cancel', reference: { orderId: order.id },
          reason: String(reason || '用户取消待派订单').slice(0, 200) }, conn);
        await conn.execute("UPDATE jz_orders SET refund_status='refunding',status='cancelled',updated_at=? WHERE id=?", [utc(), orderId]);
        order.status = 'cancelled'; order.refund_status = 'refunding'; order.updated_at = utc();
        await projectOrder(conn, order);
      } else {
        result = await paymentCore.requestClose({ bizType: 'jiazheng', orderId, accountId: String(account.id), reason: 'customer_cancel', reopen: false }, conn);
        await conn.execute("UPDATE jz_orders SET pay_status='closing',updated_at=? WHERE id=?", [utc(), orderId]);
        order.pay_status = 'closing'; order.updated_at = utc(); await projectOrder(conn, order);
      }
      await conn.commit(); return { ...result, order };
    } catch (error) { await conn.rollback(); throw error; } finally { await conn.end(); }
  }
  async function expire(limit = 50) {
    const bounded = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), 200);
    const conn = await createConnection(); let rows, couponRows;
    try { [rows] = await conn.execute(`SELECT o.id,o.account_id FROM jz_orders o JOIN payment_order_guards g
      ON g.biz_type='jiazheng' AND g.biz_order_no=o.id
      WHERE o.payment_mode='pay_center' AND o.status='pending' AND o.pay_status='unpaid'
      AND g.lifecycle='open' AND g.paid_payment_id IS NULL AND o.expires_at<=UTC_TIMESTAMP()
      ORDER BY o.expires_at LIMIT ${bounded}`);
      [couponRows] = await conn.execute(`SELECT o.id FROM jz_orders o WHERE o.payment_mode='pay_center'
        AND o.status='pending' AND o.pay_status='coupon_funded' AND o.cash_due_minor=0
        AND o.coupon_application_id IS NOT NULL AND o.expires_at<=UTC_TIMESTAMP()
        ORDER BY o.expires_at LIMIT ${bounded}`);
    }
    finally { await conn.end(); }
    for (const order of rows) await paymentCore.requestClose({ bizType: 'jiazheng', orderId: order.id, accountId: String(order.account_id), reason: 'expired', reopen: false });
    let released=0;
    for (const row of couponRows) {
      const c=await createConnection();
      try {
        await c.beginTransaction();
        const [[order]]=await c.execute('SELECT * FROM jz_orders WHERE id=? FOR UPDATE',[row.id]);
        if (order?.status==='pending' && order.pay_status==='coupon_funded' && Number(order.cash_due_minor)===0) {
          const [[time]]=await c.execute('SELECT ?<=UTC_TIMESTAMP() AS due',[order.expires_at]);
          if (Number(time.due)===1) {
            await releaseSlot(c,order);
            await require('../../commerce/coupon-application.cjs').transition(c,{bizType:'jiazheng',orderNo:order.id,
              from:['reserved','committed'],to:'released',evidence:{reason:'order_expired'}});
            await c.execute("UPDATE jz_orders SET status='cancelled',pay_status='expired',updated_at=? WHERE id=?",[utc(),order.id]);
            order.status='cancelled';order.pay_status='expired';order.updated_at=utc();
            await projectOrder(c,order);released++;
          }
        }
        await c.commit();
      }catch(error){await c.rollback();throw error;}finally{await c.end();}
    }
    return rows.length+released;
  }
  return { createOrder, projectOrder, handleEvent, expire, cancel };
}
module.exports = { createJiazhengAdapter, normalizeOrder, amountMinor, accountUser };
