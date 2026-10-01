'use strict';
/**
 * C 端预订 + 支付确认/回调（从 app.js 拆出）。
 * 覆盖：
 *   GET  /api/juzhu/booking/my
 *   GET|POST|DELETE /api/juzhu/booking/contacts[/:id]
 *   POST /api/juzhu/booking
 *   POST /api/juzhu/booking/lookup|cancel|pay
 *   POST /api/juzhu/payment/query
 *   POST /api/juzhu/payment/notify/:token
 *
 * 调用：
 *   const handle = createBookingRouter(deps);
 *   if ((await handle(urlPath, qs, req, res)) !== false) return;
 * 命中路由时 handler 经 return jsonReply/... 返回 undefined；未命中返回 false。
 */
function createBookingRouter(deps) {
  return async function handleBookingRoutes(urlPath, qs, req, res) {
    const {
      queryRows, jsonReply, readBody, requestSession, maskPhoneStd,
      orderCancelInfoOf, mysql2, getDbConfig, crypto, stayCfg, connExec,
      stayNightPrices, releaseStayQty, stayDateList,
      transactionCapabilitiesOf, minStayNightsOf,
      cancelPolicyOf, cancelPolicyTextOf, wholeHousePriceUnit,
      fallbackUnitRowFor, settingValue, vendorRate,
      getPaymentService, getBookingPaymentAdapter, notifyVendorBooking, bookingPaymentExpired,
      expireBooking,
    } = deps;

    // GET /api/juzhu/booking/my —— 我的预订（登录会话；仅按 user_id，不按手机号认领）
    if (urlPath === '/api/juzhu/booking/my' && req.method === 'GET') {
      const t0 = Date.now();
      const sess = await requestSession(req);
      const authMs = Date.now() - t0;
      if (!sess || !sess.account) return jsonReply(res, { error: 'unauthorized', message: '请先登录（贝壳 SDK 或手机号密码）' }, 401);
      const t1 = Date.now();
      const rows = await queryRows(
        `SELECT b.id, b.order_no, b.project_id, b.unit_id, b.channel, p.name AS project_name,
                b.checkin, b.checkout, b.nights, b.rooms, b.price_total, b.status, b.created_at,
                b.pay_status, b.pay_method,
                b.contact_name, b.contact_phone, uu.ext AS unit_ext
         FROM booking_orders b LEFT JOIN projects p ON p.id=b.project_id
         LEFT JOIN units uu ON uu.id=b.unit_id
         WHERE b.user_id=?
         ORDER BY b.id DESC LIMIT 100`,
        [String(sess.account.id)],
      );
      // 整栋单：一次查出各项目排序最前户型的 ext，避免 N 次 fallbackUnitRowFor
      const firstExtByProject = {};
      const unitlessPids = [...new Set(rows.filter((o) => o.unit_id == null).map((o) => o.project_id).filter(Boolean))];
      if (unitlessPids.length) {
        const placeholders = unitlessPids.map(() => '?').join(',');
        const urows = await queryRows(
          `SELECT project_id, ext FROM units WHERE project_id IN (${placeholders}) ORDER BY project_id, sort_order, id`,
          unitlessPids,
        );
        for (const u of urows) {
          if (firstExtByProject[u.project_id] === undefined) firstExtByProject[u.project_id] = u.ext;
        }
      }
      const sqlMs = Date.now() - t1;
      console.log('[booking/my] auth=%dms sql=%dms rows=%d total=%dms', authMs, sqlMs, rows.length, Date.now() - t0);
      return jsonReply(res, {
        role: sess.role,
        items: rows.map((o) => {
          const cpUnit = o.unit_ext ? { ext: o.unit_ext } : (firstExtByProject[o.project_id] != null ? { ext: firstExtByProject[o.project_id] } : null);
          const cancelInfo = orderCancelInfoOf(cpUnit, o);
          return Object.assign({}, o, {
            price_total: Number(o.price_total),
            contact_phone: maskPhoneStd(o.contact_phone),
            contact_phone_masked: maskPhoneStd(o.contact_phone), // 别名：与 /booking/lookup 出参字段对齐
            contact_phone_raw: o.contact_phone, // 本人订单，取消/支付接口需要原号
            cancel_policy_text: cancelInfo.cancel_policy_text, // 退改口径随单下发，C 端取消按钮以 can_cancel 为准
            cancel_deadline: cancelInfo.cancel_deadline,
            can_cancel: cancelInfo.can_cancel,
          });
        }),
      });
    }

    // ===== 联系人簿（booking_contacts，登录用户自己的常用联系人）=====

    // GET /api/juzhu/booking/contacts —— 我的联系人（本人视角，手机号不脱敏）
    if (urlPath === '/api/juzhu/booking/contacts' && req.method === 'GET') {
      const sess = await requestSession(req);
      if (!sess || !sess.account) return jsonReply(res, { error: 'unauthorized' }, 401);
      const rows = await queryRows(
        'SELECT id, name, phone FROM booking_contacts WHERE user_id=? ORDER BY id DESC LIMIT 20',
        [String(sess.account.id)]
      );
      return jsonReply(res, { items: rows });
    }

    // POST /api/juzhu/booking/contacts —— 新增联系人（本人，上限 20）
    if (urlPath === '/api/juzhu/booking/contacts' && req.method === 'POST') {
      const sess = await requestSession(req);
      if (!sess || !sess.account) return jsonReply(res, { error: 'unauthorized' }, 401);
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const phone = String(body.phone || '').trim();
      if (!name || !/^1\d{10}$/.test(phone)) return jsonReply(res, { error: '姓名与 11 位手机号为必填' }, 400);
      const cntRows = await queryRows('SELECT COUNT(*) AS n FROM booking_contacts WHERE user_id=?', [String(sess.account.id)]);
      if (cntRows[0].n >= 20) return jsonReply(res, { error: '联系人最多 20 个' }, 400);
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [r] = await conn.execute(
          'INSERT INTO booking_contacts(user_id,name,phone,created_at) VALUES (?,?,?,?)',
          [String(sess.account.id), name, phone, now]
        );
        await conn.commit();
        return jsonReply(res, { ok: true, id: r.insertId, name, phone });
      } finally { await conn.end(); }
    }

    // DELETE /api/juzhu/booking/contacts/:id —— 删除本人联系人
    {
      const m = urlPath.match(/^\/api\/juzhu\/booking\/contacts\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const sess = await requestSession(req);
        if (!sess || !sess.account) return jsonReply(res, { error: 'unauthorized' }, 401);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [r] = await conn.execute(
            'DELETE FROM booking_contacts WHERE id=? AND user_id=?',
            [parseInt(m[1], 10), String(sess.account.id)]
          );
          await conn.commit();
          return jsonReply(res, { ok: r.affectedRows > 0 });
        } finally { await conn.end(); }
      }
    }

    // ===== 旅居预订（booking_orders）：C 端公开下单/查单/取消 + 商家确认 =====

    // POST /api/juzhu/booking —— 公开下单（规则10：手机号只入库，响应不回显）
    if (urlPath === '/api/juzhu/booking' && req.method === 'POST') {
      const body = await readBody(req);
      const projectId = parseInt(body.project_id, 10);
      const unitId = body.unit_id == null || body.unit_id === '' ? null : parseInt(body.unit_id, 10);
      const name = String(body.contact_name || '').trim();
      const phone = String(body.contact_phone || '').trim();
      const checkin = String(body.checkin || '').trim();
      const checkout = String(body.checkout || '').trim();
      const requestedTransactionMode = String(body.transaction_mode || '').trim();
      const suppliedKey = String(req.headers['idempotency-key'] || body.idempotency_key || '').trim();
      if (suppliedKey && !/^[A-Za-z0-9:_-]{8,80}$/.test(suppliedKey)) return jsonReply(res, { error: '幂等请求标识格式无效' }, 422);
      const bookingSession = await requestSession(req);
      const bookingAccount = bookingSession && bookingSession.account;
      const bookingUserId = bookingAccount ? String(bookingAccount.id) : null;
      const idempotencyKey = suppliedKey ? crypto.createHash('sha256').update('booking:' + (bookingUserId || phone) + ':' + suppliedKey).digest('hex') : '';
      if (!projectId || !name || !/^1\d{10}$/.test(phone)) return jsonReply(res, { error: '项目、联系人、11 位手机号为必填' }, 400);
      if (unitId !== null && (!Number.isInteger(unitId) || unitId <= 0)) return jsonReply(res, { error: 'unit_id 须为正整数' }, 400);
      if (!stayCfg.isValidDateString(checkin) || !stayCfg.isValidDateString(checkout)) return jsonReply(res, { error: '日期须为真实有效的 YYYY-MM-DD' }, 400);
      if (requestedTransactionMode && !['booking', 'payment'].includes(requestedTransactionMode)) {
        return jsonReply(res, { error: 'transaction_mode 须为 booking / payment' }, 400);
      }
      const nights = Math.round((new Date(checkout) - new Date(checkin)) / 864e5);
      if (!(nights >= 1)) return jsonReply(res, { error: '离店须晚于入住至少 1 晚' }, 400);
      if (new Date(checkin) < new Date(new Date().toDateString())) return jsonReply(res, { error: '入住日期不能早于今天' }, 400);
      // 间数（多间库存 2026-09-10）：unit 单可订多间（上限 99），整栋单恒 1 间（整栋只有一份）
      const roomsRaw = parseInt(body.rooms, 10);
      let rooms = Number.isFinite(roomsRaw) && roomsRaw >= 1 ? Math.min(roomsRaw, 99) : 1;
      if (unitId === null) rooms = 1;
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({ projectId, unitId, name, phone, checkin, checkout, rooms, requestedTransactionMode })).digest('hex');
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        // This lookup runs before the transaction: locking a missing unique key
        // here creates a gap-lock cycle with the project inventory lock.
        if (idempotencyKey) {
          const [existing] = await conn.execute('SELECT * FROM booking_orders WHERE idempotency_key=? LIMIT 1', [idempotencyKey]);
          if (existing.length) {
            if (existing[0].request_hash !== requestHash) return jsonReply(res, { error: '同一请求标识对应不同预订内容' }, 409);
            return jsonReply(res, { ok: true, order_no: existing[0].order_no, nights: existing[0].nights, rooms: existing[0].rooms,
              price_total: Number(existing[0].price_total), status: existing[0].status, pay_status: existing[0].pay_status,
              idempotent_replay: true });
          }
        }
        await conn.beginTransaction();
        const [projs] = await conn.execute('SELECT id, name, channel, status, rating_status, price_from, owner_vendor_id, city_id, ext, tags FROM projects WHERE id=? FOR UPDATE', [projectId]);
        // First consistent read in this transaction occurs after the project
        // lock, so a concurrent identical booking sees the committed original
        // before checking inventory that the original has just reserved.
        if (idempotencyKey) {
          const [existing] = await conn.execute('SELECT * FROM booking_orders WHERE idempotency_key=? LIMIT 1', [idempotencyKey]);
          if (existing.length) {
            if (existing[0].request_hash !== requestHash) { await conn.rollback(); return jsonReply(res, { error: '同一请求标识对应不同预订内容' }, 409); }
            await conn.commit();
            return jsonReply(res, { ok: true, order_no: existing[0].order_no, nights: existing[0].nights, rooms: existing[0].rooms,
              price_total: Number(existing[0].price_total), status: existing[0].status, pay_status: existing[0].pay_status,
              idempotent_replay: true });
          }
        }
        const proj = projs[0];
        if (!proj) { await conn.rollback(); return jsonReply(res, { error: '项目不存在' }, 404); }
        if (!['rental', 'minsu'].includes(proj.channel)) { await conn.rollback(); return jsonReply(res, { error: '该频道不支持预订（仅 rental/minsu）' }, 400); }
        if (proj.status !== 'online' || proj.rating_status !== 'passed') { await conn.rollback(); return jsonReply(res, { error: '房源未通过审核或已下架，暂不可预订' }, 400); }
        // 交易能力按房源配置，不按频道分流：booking=在线预订/线下收款，payment=在线支付。
        const txCaps = transactionCapabilitiesOf(proj);
        if (!txCaps.online_booking && !txCaps.online_payment) {
          await conn.rollback();
          return jsonReply(res, { error: '该房源未配置可用交易方式' }, 400);
        }
        const transactionMode = requestedTransactionMode
          || (txCaps.online_booking ? 'booking' : 'payment');
        if (transactionMode === 'booking' && !txCaps.online_booking) {
          await conn.rollback();
          return jsonReply(res, { error: '该房源不支持在线预订，请选择在线支付', online_booking: false, online_payment: txCaps.online_payment }, 400);
        }
        if (transactionMode === 'payment' && !txCaps.online_payment) {
          await conn.rollback();
          return jsonReply(res, { error: '该房源不支持在线支付，请选择在线预订', online_booking: txCaps.online_booking, online_payment: false }, 400);
        }
        const initialPayStatus = transactionMode === 'payment' ? 'unpaid' : null;
        if (transactionMode === 'payment' && (!bookingAccount || bookingAccount.idp_type !== 'beike' || !bookingAccount.idp_subject)) {
          await conn.rollback(); return jsonReply(res, { error: '在线付款预订请先登录贝壳账号' }, 401);
        }
        // Expiry is serialized through payment guards by the background worker.
        // A booking transaction must not release inventory ahead of gateway close.
        // 户型归属与总间数（须在逐晚可用数校验前取出，remaining 依赖 total_qty）
        let unitRow = null;
        if (unitId) {
          const [us] = await conn.execute('SELECT id, project_id, rent_monthly, ext, total_qty FROM units WHERE id=?', [unitId]);
          if (!us.length || us[0].project_id !== projectId) { await conn.rollback(); return jsonReply(res, { error: '户型不存在或不属于该项目' }, 400); }
          unitRow = us[0];
          if (rooms > stayCfg.totalQtyOf(unitRow)) {
            await conn.rollback();
            return jsonReply(res, { error: `该房型总间数仅 ${stayCfg.totalQtyOf(unitRow)} 间，无法预订 ${rooms} 间` }, 400);
          }
        }
        // 最短连住（2026-09 下放户型）：户型级 > 房源级 > 频道默认；整栋单按「排序最前户型」取，
        // 与取消政策同一套回退（fallbackUnitRowFor）。三处同口径：C 端日历 / 下单页 / 本闸。
        const stayRuleUnit = unitRow || await fallbackUnitRowFor(connExec(conn), unitId, projectId);
        const minNights = minStayNightsOf(proj, stayRuleUnit);
        if (nights < minNights) {
          await conn.rollback();
          return jsonReply(res, { error: `该房源须连住至少 ${minNights} 晚（当前 ${nights} 晚）`, min_stay_nights: minNights }, 400);
        }
        // 逐晚可用数校验（多间库存）：指定户型 → 项目级闸（关房/整栋被订）+ 户型级 remaining>=rooms；
        // unit 未指定 = 整栋/不限房型 → 全项目任一晚有占用/关房即拒（整栋包圆，沿用原语义）
        const [scRows] = await conn.execute(
          `SELECT sc.unit_id, sc.stay_date, sc.status, sc.qty, sc.qty_base, sc.booked_qty, u.total_qty
           FROM stay_calendar sc LEFT JOIN units u ON u.id=sc.unit_id
           WHERE sc.project_id=? AND sc.stay_date >= ? AND sc.stay_date < ?
           ${unitId ? 'AND sc.unit_id IN (0, ?)' : ''} FOR UPDATE`,
          unitId ? [projectId, checkin, checkout, unitId] : [projectId, checkin, checkout]
        );
        const stayDates = stayDateList(checkin, checkout);
        let conflictDate = null;
        let conflictLeft = 0;
        for (const d of stayDates) {
          const rowsD = scRows.filter((r) => r.stay_date === d);
          const projRow = rowsD.find((r) => !Number(r.unit_id));
          if (projRow) {
            const projBooked = Math.max(parseInt(projRow.booked_qty, 10) || 0, projRow.status === 'booked' ? 1 : 0);
            if (projRow.status === 'blocked' || projBooked > 0) { conflictDate = d; conflictLeft = 0; break; }
          }
          if (unitId) {
            const uRow = rowsD.find((r) => Number(r.unit_id) === unitId) || null;
            const left = stayCfg.remainingOf(uRow, unitRow, proj);   // 含净可售基线 / 默认关房口径
            if (left < rooms) { conflictDate = d; conflictLeft = left; break; }
          } else {
            const occupied = rowsD.find((r) => Number(r.unit_id) > 0
              && (r.status === 'blocked' || (parseInt(r.booked_qty, 10) || 0) > 0 || r.status === 'booked'));
            if (occupied) { conflictDate = d; conflictLeft = 0; break; }
          }
        }
        if (conflictDate) {
          await conn.rollback();
          const detail = unitId && conflictLeft > 0
            ? `（仅剩 ${conflictLeft} 间，需 ${rooms} 间）`
            : '';
          return jsonReply(res, { error: `所选日期 ${conflictDate} 库存不足或已关房，请换时段${detail}`, conflict_date: conflictDate, remaining: conflictLeft }, 400);
        }
        // 逐晚计价（2026-09-10）：每晚 = 日历覆盖价（户型级 > 项目级）否则默认夜价，
        // 单一数据源 stay_config.cjs，与 C 端日历/下单页展示同口径；price_total 为逐晚合计
        // 整栋单价格基准：有起价按起价（存量语义），无起价回落排序最前户型（stayRuleUnit）
        const nightCalc = await stayNightPrices(
          async (sql, p) => (await conn.execute(sql, p))[0], proj,
          unitRow || wholeHousePriceUnit(proj, stayRuleUnit), unitId, checkin, checkout);
        // 多间库存（2026-09-10）：单间逐晚口径不变，合计 × 间数
        const priceTotal = nightCalc.total * rooms;
        // 无价闸（2026-09）：price_from 改为选填后价格链必须真能算出价，否则会 0 元成单；
        // 与上架闸「每个户型都要有默认夜价」呼应，此处是第二道兜底
        if (!(priceTotal > 0)) {
          await conn.rollback();
          return jsonReply(res, { error: '该房源未配置价格，暂不可预订' }, 400);
        }
        // 佣金快照（规则 20）：按 owner 商家 housing 档生效费率锁定，调价不追溯；
        // 平台自营（无商家行）回落全局基准
        const [vrate] = proj.owner_vendor_id
          ? await conn.execute('SELECT commission_housing FROM jz_vendors WHERE id=?', [proj.owner_vendor_id])
          : [[]];
        const rate = vendorRate.effectiveRateOf(vrate[0] || null, 'housing',
          { commission_housing_default: await settingValue(vendorRate.defaultSettingKey('housing')) });
        const commissionFee = vendorRate.commissionAmountOf(priceTotal, rate);
        const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z').slice(0, 19).replace('T', ' ');
        const paymentExpiresAt = transactionMode === 'payment' ? new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') : null;
        const tempOrderNo = `TMP-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`.slice(0, 32);
        const [ins] = await conn.execute(
          `INSERT INTO booking_orders(order_no,project_id,unit_id,channel,city_id,owner_vendor_id,user_id,contact_name,contact_phone,checkin,checkout,nights,rooms,price_total,commission_rate,commission_fee,status,pay_status,idempotency_key,request_hash,payment_expires_at,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)`,
          [tempOrderNo, projectId, unitId, proj.channel, proj.city_id, proj.owner_vendor_id, bookingUserId, name, phone, checkin, checkout, nights, rooms, priceTotal,
           rate, commissionFee,
           initialPayStatus, idempotencyKey || null, requestHash, paymentExpiresAt, now, now]
        );
        const orderNo = `BKG-${proj.channel.toUpperCase()}-${String(ins.insertId).padStart(5, '0')}`;
        await conn.execute('UPDATE booking_orders SET order_no=? WHERE id=?', [orderNo, ins.insertId]);
        const createdOrder = {
          id: ins.insertId, order_no: orderNo, user_id: bookingUserId, owner_vendor_id: proj.owner_vendor_id,
          project_id: projectId, unit_id: unitId, channel: proj.channel, city_id: proj.city_id,
          checkin, checkout, nights, rooms, price_total: priceTotal.toFixed(2),
          commission_rate: rate, commission_fee: commissionFee, created_at: now,
          pay_status: initialPayStatus, status: 'pending', payment_expires_at: paymentExpiresAt,
        };
        const paymentAdapter = getBookingPaymentAdapter();
        await paymentAdapter.captureOrder(conn, createdOrder, { newOrder: true });
        if (transactionMode === 'payment') await paymentAdapter.prepare(conn, createdOrder, bookingAccount);
        // 下单即占库存（多间口径，2026-09-10）：① 补缺行（无行=默认可订 的落库形态，INSERT IGNORE 依赖
        // uk_sc 幂等，不动 price_night/qty）→ ② booked_qty 条件递增（booking_id 仅首占用时写）。
        // 不再翻整行 status：booked 由 remaining<=0 派生；区间可用性已被上方 FOR UPDATE 校验锁定
        if (stayDates.length) {
          const nowSc = now;
          const occUnitId = unitId || 0;
          await conn.query(
            `INSERT IGNORE INTO stay_calendar(project_id, unit_id, stay_date, status, source, updated_at)
             VALUES ${stayDates.map(() => '(?,?,?,\'open\',\'booking\',?)').join(',')}`,
            stayDates.flatMap((d) => [projectId, occUnitId, d, nowSc])
          );
          const [occ] = await conn.execute(
            `UPDATE stay_calendar SET booked_qty=booked_qty+?, source='booking',
               booking_id=COALESCE(booking_id, ?), updated_at=?
             WHERE project_id=? AND unit_id=? AND stay_date IN (${stayDates.map(() => '?').join(',')})`,
            [rooms, ins.insertId, nowSc, projectId, occUnitId, ...stayDates]
          );
          if ((occ.affectedRows || 0) !== stayDates.length) {
            await conn.rollback();
            return jsonReply(res, { error: '所选日期库存不足，请换时段或减少间数' }, 400);
          }
        }
        await conn.commit();
        notifyVendorBooking(proj.owner_vendor_id, 'booking.created', {
          id: ins.insertId, order_no: orderNo, project_id: projectId, unit_id: unitId || null,
          channel: proj.channel, checkin: checkin, checkout: checkout,
          nights: nights, rooms: rooms, price_total: priceTotal, status: 'pending', pay_status: initialPayStatus,
          transaction_mode: transactionMode,
        });
        // 下单即回显所选房型的退改口径（units.ext.cancel_policy，单一数据源 stay_config.cjs）；
        // 整栋单（未选房型）按项目首个房型政策执行
        const cpUnit = unitRow || await fallbackUnitRowFor(async (sql, p) => (await conn.execute(sql, p))[0], unitId, projectId);
        const cancelInfo = orderCancelInfoOf(cpUnit, { status: 'pending', checkin });
        return jsonReply(res, { ok: true, order_no: orderNo, nights, rooms, price_total: priceTotal, min_stay_nights: minNights,
          payment_expires_at: paymentExpiresAt, pay_status: initialPayStatus, transaction_mode: transactionMode,
          commission_rate: rate, commission_amount: commissionFee,   // 规则 20：下单锁定的佣金快照
          cancel_policy_text: cancelInfo.cancel_policy_text, cancel_deadline: cancelInfo.cancel_deadline, can_cancel: cancelInfo.can_cancel });
      } catch (e) {
        try { await conn.rollback(); } catch (_) {}
        if (e && e.code === 'ER_DUP_ENTRY' && idempotencyKey) {
          const [existing] = await conn.execute('SELECT * FROM booking_orders WHERE idempotency_key=? LIMIT 1', [idempotencyKey]);
          if (existing.length && existing[0].request_hash === requestHash) return jsonReply(res, { ok: true, order_no: existing[0].order_no, status: existing[0].status, pay_status: existing[0].pay_status, idempotent_replay: true });
          if (existing.length) return jsonReply(res, { error: '同一请求标识对应不同预订内容' }, 409);
        }
        throw e;
      } finally { await conn.end(); }
    }

    // POST /api/juzhu/booking/lookup —— order_no + 手机号 双因子查单（规则9：禁止 ?phone= 匿名旁路）
    if (urlPath === '/api/juzhu/booking/lookup' && req.method === 'POST') {
      const body = await readBody(req);
      const orderNo = String(body.order_no || '').trim();
      const phone = String(body.contact_phone || '').trim();
      const lookupSession = !phone ? await requestSession(req) : null;
      if (!orderNo || (!phone && !(lookupSession && lookupSession.account))) return jsonReply(res, { error: '订单号必填，请登录本人账号或提供预订手机号' }, 400);
      const rows = await queryRows(
        `SELECT b.*, p.name AS project_name, uu.ext AS unit_ext FROM booking_orders b
         LEFT JOIN projects p ON p.id=b.project_id
         LEFT JOIN units uu ON uu.id=b.unit_id
         WHERE b.order_no=? AND ${phone ? 'b.contact_phone' : 'b.user_id'}=? LIMIT 1`, [orderNo, phone || String(lookupSession.account.id)]);
      if (!rows.length) return jsonReply(res, { error: '订单不存在或手机号不匹配' }, 404);
      const o = rows[0];
      // Public lookup is read-only. Guard-driven expiry confirms gateway closure
      // before the event consumer releases inventory.
      // 退改口径随单下发（units.ext.cancel_policy；整栋单按项目首个房型政策执行）
      const lookupUnit = o.unit_ext ? { ext: o.unit_ext } : await fallbackUnitRowFor(queryRows, o.unit_id, o.project_id);
      const cancelInfo = orderCancelInfoOf(lookupUnit, o);
      return jsonReply(res, {
        order: {
          id: o.id, order_no: o.order_no, project_id: o.project_id, unit_id: o.unit_id, channel: o.channel,
          project_name: o.project_name,
          contact_name: o.contact_name, contact_phone_masked: maskPhoneStd(o.contact_phone),
          checkin: o.checkin, checkout: o.checkout, nights: o.nights, rooms: o.rooms, price_total: Number(o.price_total),
          status: o.status, pay_status: o.pay_status, pay_method: o.pay_method, payment_expires_at: o.payment_expires_at, created_at: o.created_at,
          cancel_policy_text: cancelInfo.cancel_policy_text, cancel_deadline: cancelInfo.cancel_deadline, can_cancel: cancelInfo.can_cancel,
        },
      });
    }

    // POST /api/juzhu/booking/cancel —— 用户取消自己的 pending
    if (urlPath === '/api/juzhu/booking/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      const orderNo = String(body.order_no || '').trim();
      const phone = String(body.contact_phone || '').trim();
      if (!orderNo || !phone) return jsonReply(res, { error: 'order_no 与手机号必填' }, 400);
      const found = await queryRows('SELECT pay_status FROM booking_orders WHERE order_no=? AND contact_phone=?', [orderNo, phone]);
      if (found[0] && found[0].pay_status != null) {
        const session = await requestSession(req);
        if (!session || !session.account || session.role !== 'user') return jsonReply(res, { error: '请登录订单所属账号' }, 401);
        try {
          const out = await getBookingPaymentAdapter().cancel({ orderNo, contactPhone: phone, account: session.account, source: 'user' });
          return jsonReply(res, out, out.pending ? 202 : 200);
        } catch (error) { return jsonReply(res, { error: error.message, code: error.code }, error.status || 409); }
      }
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        await conn.beginTransaction();
        const [rows] = await conn.execute('SELECT * FROM booking_orders WHERE order_no=? AND contact_phone=? LIMIT 1 FOR UPDATE', [orderNo, phone]);
        if (!rows.length) { await conn.rollback(); return jsonReply(res, { error: '订单不存在或手机号不匹配' }, 404); }
        if (rows[0].pay_status != null) { await conn.rollback(); return jsonReply(res, { error: '订单支付状态已变化，请重试取消' }, 409); }
        if (rows[0].status !== 'pending') { await conn.rollback(); return jsonReply(res, { error: '仅待确认订单可取消' }, 400); }
        // 免费取消窗口（房型维度 units.ext.cancel_policy，单一数据源 stay_config.cjs）：
        // 窗口外 / 未启用一律不可取消不可退；商家侧（B 端 / HMAC）取消接口不受此闸约束
        const cUnit = await fallbackUnitRowFor(async (sql, p) => (await conn.execute(sql, p))[0], rows[0].unit_id, rows[0].project_id);
        const cInfo = orderCancelInfoOf(cUnit, rows[0]);
        if (!cInfo.can_cancel) {
          await conn.rollback();
          const reason = cInfo.cancel_policy.enabled
            ? `已超过免费取消截止时间（${cInfo.cancel_deadline}），不可取消`
            : '该订单未开通免费取消，预订成功后不可取消';
          return jsonReply(res, { error: reason, cancel_policy_text: cInfo.cancel_policy_text, cancel_deadline: cInfo.cancel_deadline }, 400);
        }
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        // This compatibility branch only handles offline bookings.
        await conn.execute("UPDATE booking_orders SET status='cancelled', updated_at=? WHERE id=?", [now, rows[0].id]);
        // 释放库存（多间口径 2026-09-10）：递减 booked_qty，纯占用行删行（商家夜价/qty 差异行保留）
        await releaseStayQty(connExec(conn), {
          project_id: rows[0].project_id, unit_id: rows[0].unit_id, rooms: rows[0].rooms,
          checkin: rows[0].checkin, checkout: rows[0].checkout, now,
        });
        await conn.commit();
        notifyVendorBooking(rows[0].owner_vendor_id, 'booking.cancelled', {
          id: rows[0].id, order_no: orderNo, project_id: rows[0].project_id, unit_id: rows[0].unit_id || null,
          channel: rows[0].channel, checkin: rows[0].checkin, checkout: rows[0].checkout,
          nights: rows[0].nights, price_total: Number(rows[0].price_total),
          status: 'cancelled', pay_status: null, cancel_by: 'customer',
        });
        return jsonReply(res, { ok: true, order_no: orderNo, status: 'cancelled', pay_status: null });
      } finally { await conn.end(); }
    }

    // POST /api/juzhu/booking/pay —— 创建或复用真实支付中台收银台
    if (urlPath === '/api/juzhu/booking/pay' && req.method === 'POST') {
      const body = await readBody(req);
      const orderNo = String(body.order_no || '').trim();
      const phone = String(body.contact_phone || '').trim();
      const cashierType = String(body.cashier_type || '').trim();
      if (!orderNo) return jsonReply(res, { error: '订单号必填' }, 400);
      if (!['1', '2'].includes(cashierType)) return jsonReply(res, { error: 'cashier_type 仅支持 1 或 2' }, 400);
      const sess = await requestSession(req);
      if (!sess || !sess.account || sess.role !== 'user') return jsonReply(res, { error: '仅贝壳登录用户可发起在线支付' }, 401);
      try {
        const requestKey = String(req.headers['idempotency-key'] || body.idempotency_key || '');
        const input = {
          orderNo,
          contactPhone: phone,
          account: sess.account,
          requestKey,
          cashierType,
          clientIp: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
        };
        const out = requestKey ? await getBookingPaymentAdapter().intent(input)
          : await getPaymentService().createOrReusePayment(input);
        return jsonReply(res, { ok: true, order_no: orderNo, ...out }, requestKey && out.next_action === 'poll' ? 202 : 200);
      } catch (e) {
        return jsonReply(res, { error: e.message || '支付单创建失败', code: e.code || null }, e.status || 400);
      }
    }

    // POST /api/juzhu/payment/query —— 前端支付结果确认
    if (urlPath === '/api/juzhu/payment/query' && req.method === 'POST') {
      const body = await readBody(req);
      const orderNo = String(body.order_no || '').trim();
      const phone = String(body.contact_phone || '').trim();
      if (!orderNo) return jsonReply(res, { error: '订单号必填' }, 400);
      const sess = await requestSession(req);
      if (!sess || !sess.account || sess.role !== 'user') return jsonReply(res, { error: 'unauthorized' }, 401);
      try {
        const out = await getPaymentService().queryPayment({ orderNo, contactPhone: phone, account: sess.account,
          appOrderId: String(body.app_order_id || '').trim() || undefined });
        return jsonReply(res, { ok: true, ...out.status, result: out.data });
      } catch (e) {
        return jsonReply(res, { error: e.message || '支付状态查询失败', code: e.code || null }, e.status || 400);
      }
    }

    // POST /api/juzhu/payment/notify/:token —— 支付中台异步通知
    if (process.env.PAY_NOTIFY_TOKEN
      && urlPath === `/api/juzhu/payment/notify/${process.env.PAY_NOTIFY_TOKEN}` && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const result = await getPaymentService().handleNotify(body);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(result);
      } catch (_) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('FAILED');
      }
    }


    return false;
  };
}

module.exports = { createBookingRouter };
