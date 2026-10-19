#!/usr/bin/env node
/**
 * server/job/book_order_split_job.cjs
 * ---------------------------------------------------------------------------
 * 旅居订单自动分账：每日 08:00 查找「状态=checkOut 已离店、分账状态=none 未分账、
 * 离店日期 <= 今天-7天（例如今天 8 号，则找 1 号及更早的 backlog）」的 booking_orders，
 * 按订单下单时锁定的 commission_rate（百分比）计算平台分账金额（分位向下取整），
 * 剩余金额分给收款商户（取自关联的 payment_orders.merchant_no），调用 payCenter 的
 * ACN 分账接口（splitApply），成功后插入 payment_split 并将 booking_orders.split_status
 * 置为 split（分账中，终态由异步回调置 done/fail）。
 *
 * - 约定：导出 start()，由 app.js 的 startJobDir 在启动时自动拉起。
 * - 幂等：分账业务单号 app_order_id 由 generateAppOrderId('FZ') 生成（格式 FZ_时间戳_随机，
 *   与支付 XD / 退款 RF 同源）；payment_split 按 biz_order_no 去重，一个旅居订单仅一笔分账；
 *   booking 仅在仍 split_status='none' 时更新；分账中台侧 bizOrderNo 亦幂等，失败可重试。
 * - 必填环境变量（缺失则本次跳过并在日志告警，不影响其余订单/下次执行）：
 *     contractInfo.contractNo 取关联支付单 payment_orders.biz_order_no（即 booking_orders.order_no）
 *     PAY_PLATFORM_MERCHANT_NO      平台商户号（merchantNo_P，平台抽成入账方，复用既有配置）
 *   可配置：SPLIT_JOB_HOUR（默认 8）、SPLIT_JOB_MINUTE（默认 0）
 * - 手动触发：node server/job/book_order_split_job.cjs   （立即跑一次并退出）
 * ---------------------------------------------------------------------------
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const { queryRows, getPool } = require(path.join(__dirname, '..', 'db.cjs'));
const { payCenter } = require(path.join(__dirname, '..', 'thirdApi', 'payCenter.cjs'));
const { generateAppOrderId } = require(path.join(__dirname, '..', 'payment', 'primitives.cjs'));

// 非生产环境（JUZHU_ENV/NODE_ENV 非 prod）打印分账下单入参/出参，便于联调；生产环境关闭
const IS_PROD = process.env.JUZHU_ENV === 'prod' || process.env.NODE_ENV === 'production';

// 待分账：已离店 + 未分账 + 离店日期 <= 今天-7天
const SQL_SELECT_DUE = `
  SELECT id, order_no, price_total, cash_due_minor, commission_rate, commission_fee
  FROM booking_orders
  WHERE status = 'checkOut'
    AND split_status = 'none'
    AND checkout <= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
  ORDER BY id`;

// 取该订单已支付成功的支付单（拿收款商户号 + 统一业务码 + 业务单号）
const SQL_SELECT_PAID_PAYMENT = `
  SELECT id, merchant_no, share_biz_code, biz_order_no, app_order_id
  FROM payment_orders
  WHERE biz_order_no = ? AND pay_status = 'paid'
  ORDER BY paid_at DESC
  LIMIT 1`;

// 去重按 biz_order_no（一个旅居订单只应有一笔分账）；app_order_id 含随机后缀，不能用于跨次去重。
// 注意：fail 记录不视为「已处理」，允许重试（重试前 triggerSplitForOrder 会清掉 fail 记录）。
const SQL_EXISTS_SPLIT = `
  SELECT id FROM payment_split WHERE biz_order_no = ? AND split_status != 'fail' LIMIT 1`;

// 插入分账订单；split_status 由调用方传入（'split' 分账中 / 'fail' 申请失败）
const SQL_INSERT_SPLIT = `
  INSERT INTO payment_split
    (payment_order_id, biz_order_no, app_order_id, idempotency_key, biz_code,
     order_name, amount, contract_no, source_merchant_no, pay_infos, split_details,
     split_status, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?, ?, NOW(), NOW())`;

// 更新旅居订单分账状态（只在仍为 none 时更新，防并发/重复）
const SQL_UPDATE_BOOKING = `
  UPDATE booking_orders SET split_status = 'split', updated_at = ?
  WHERE order_no = ? AND split_status = 'none'`;

// 出战中台调用日志（与支付/退款 worker 一致的写入口径；app_order_id 用分账业务单号 FZ_时间戳_随机，长度 < VARCHAR(28)）
const SQL_INSERT_GATEWAY_LOG = `
  INSERT INTO payment_gateway_logs
    (payment_order_id, payment_refund_id, app_order_id, operation_type, request_no,
     business_code, trace_id, success_flag, request_json, response_json, error_message, started_at, finished_at)
  VALUES (?, NULL, ?, 'split_apply', ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// 业务时钟（与 app.js 一致）：UTC 'YYYY-MM-DD HH:mm:ss'
function nowStamp() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// 落库出战中台调用日志（payment_gateway_logs）。独立于分账主事务，写入失败仅告警，不影响分账主流程。
async function logGateway(p) {
  let conn;
  try {
    conn = await getPool().getConnection();
    await conn.execute(SQL_INSERT_GATEWAY_LOG, [
      p.paymentOrderId != null ? p.paymentOrderId : null, p.appOrderId, p.requestNo,
      p.businessCode != null ? String(p.businessCode) : null,
      p.traceId != null ? String(p.traceId) : null,
      p.successFlag ? 1 : 0,
      p.requestJson, p.responseJson || null, p.errorMessage || null,
      p.startedAt, p.finishedAt,
    ]);
  } catch (e) {
    console.warn('[book_order_split_job] 网关日志写入失败:', e.message);
  } finally {
    if (conn) conn.release();
  }
}

/**
 * 从支付中台异步通知日志 payment_notify_log 解析支付单的 coreNo（支付流水号）。
 * 取 notify_type='pay' 且 order_status='30'（支付成功）的第一条，解析 payload_json 中的 coreNo。
 * @param {string} appOrderId 支付单业务单号（payment_orders.app_order_id，亦即 payment_notify_log.app_order_id）
 * @returns {Promise<string|null>} coreNo，未找到返回 null
 */
async function lookupPaymentCoreNo(appOrderId) {
  if (!appOrderId) return null;
  const rows = await queryRows(`
    SELECT payload_json FROM payment_notify_log
    WHERE app_order_id = ? AND notify_type = 'pay' AND order_status = '30'
    ORDER BY id ASC LIMIT 1`, [appOrderId]);
  if (!rows || !rows.length) return null;
  const payload = rows[0].payload_json;
  if (!payload) return null;
  let obj;
  try { obj = JSON.parse(payload); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  return obj.coreNo || (obj.data && obj.data.coreNo) || null;
}

/**
 * 组装 ACN 分账申请报文（payCenter.splitApply 入参）。
 * 分账模型：钱先由「源收款商户」收下，再按比例分给「平台」与「收款商户」两方。
 * 金额单位为元（字符串，2 位小数）；内部一律以「分」(minor) 整数运算，平台份额分位向下取整。
 *
 * @param {object}   p
 * @param {string}   p.orderNo             旅居业务订单号（booking_orders.order_no），用于生成幂等 bizOrderNo 与 orderName
 * @param {number}   p.totalMinor          分账总金额（单位：分 = 元×100），取自 booking_orders.cash_due_minor（实际应收现金，已扣优惠券；历史订单回退 price_total×100）
 * @param {number}   p.rate                下单锁定的分账费率（百分比，如 10 表示 10%），取自 booking_orders.commission_rate
 * @param {string}   p.platformMerchantNo  平台商户号（merchantNo_P），平台抽成入账方，取自 PAY_PLATFORM_MERCHANT_NO
 * @param {string}   p.merchantMerchantNo  收款商户号（merchantNo_A），剩余金额（货款）入账方，取自 payment_orders.merchant_no
 * @param {string}   p.sourceMerchantNo    源收款商户号（merchantNo_A），即下单时实际收款方，也是分账的资金出处，取自 payment_orders.merchant_no
 * @param {string}   p.contractNo          分账合同号，取自 payment_orders.biz_order_no（即 booking_orders.order_no）
 * @param {string}   p.bizCode             统一业务码，取自 payment_orders.share_biz_code
 * @param {string}   p.notifyUrl           分账异步回调地址（完整 URL，取自 PAY_NOTIFY_SPLIT_URL），中台分账结果经此回调 /api/juzhu/payment/split/notify/:token
 * @param {string}   [p.payNo]             原支付单流水号 coreNo（取自 payment_notify_log，支付成功 order_status=30 的回调），写入 payInfos.payNo
 * @returns {object}  splitApply 所需的请求体
 *   - bizOrderNo  : 分账业务单号/幂等键（FZ_时间戳_随机，由 generateAppOrderId('FZ') 生成或外部传入）→ 对应 payment_split.app_order_id
 *   - bizCode     : 统一业务码
 *   - splitModel  : 分账模式，固定 'SPLIT'
 *   - orderName   : 分账订单名称
 *   - amount      : 分账总金额（元，字符串）
 *   - contractInfo: { contractNo } 分账合同号
 *   - callBackInfo: { callbackUrl } 分账异步回调地址（PAY_NOTIFY_SPLIT_URL）
 *   - payInfos    : 收款参与方列表 [{ merchantNo, amount }]，两方金额之和 = amount
 *   - details     : 分账明细列表 [{ bizDetailNo, splitLevel, payerMerchantNo(源商户), payAmount, payeeMerchantNo(目标商户), leafFlag, summary }]
 */
function buildSplitBody({ orderNo, appOrderId, totalMinor, rate, platformMerchantNo, merchantMerchantNo, sourceMerchantNo, contractNo, bizCode, notifyUrl, payNo }) {
  const totalStr = (totalMinor / 100).toFixed(2);
  const platformMinor = Math.floor((totalMinor * rate) / 100); // 分位向下取整
  const merchantMinor = totalMinor - platformMinor;
  const platformStr = (platformMinor / 100).toFixed(2);
  const merchantStr = (merchantMinor / 100).toFixed(2);
  const bizOrderNo = appOrderId || generateAppOrderId('FZ');

  const payInfos = [{ payNo: payNo || null, merchantNo: sourceMerchantNo, amount: totalStr }];
  const details = [{
    bizDetailNo: bizOrderNo+'_1', splitLevel: 1, payerMerchantNo: sourceMerchantNo,
    payAmount: platformStr, payeeMerchantNo: platformMerchantNo, leafFlag: "Y", summary: '平台服务费',
  }];
  if (merchantMinor > 0) {
    details.push({
      bizDetailNo: bizOrderNo+'_2', splitLevel: 1, payerMerchantNo: sourceMerchantNo,
      payAmount: merchantStr, payeeMerchantNo: merchantMerchantNo, leafFlag: "Y", summary: '商户货款',
    });
  }

  return {
    bizOrderNo,
    bizCode,
    splitModel: 'SPLIT',
    orderName: `旅居分账 ${orderNo}`,
    amount: totalStr,
    contractInfo: { contractNo },
    callBackInfo: { callbackUrl: notifyUrl },
    payInfos,
    details,
  };
}

// 处理单个订单：校验 → 调分账中台 → 同事务落库。返回 'processed' | 'skipped'
async function processOne(b, platformMerchantNo) {
  const orderNo = b.order_no;
  // 分账业务单号：沿用支付/退款的 generateAppOrderId 规则（prefix_时间戳_随机），前缀 FZ，全局唯一
  const appOrderId = generateAppOrderId('FZ');

  // 已存在分账记录 → 跳过（按 biz_order_no 去重，保证一个旅居订单仅一笔分账）
  const [existing] = await queryRows(SQL_EXISTS_SPLIT, [orderNo]);
  if (existing && existing.length) return 'skipped';

  // 取已支付支付单（收款商户号 + 统一业务码 + 分账合同号 biz_order_no）
  const paid = await queryRows(SQL_SELECT_PAID_PAYMENT, [orderNo]);
  if (!paid || !paid.length) {
    console.warn(`[book_order_split_job] ${orderNo} 无已支付支付单，跳过`);
    return 'skipped';
  }
  const pay = paid[0];
  const contractNo = pay.biz_order_no; // 分账合同号取支付单的业务订单号
  // 原支付单流水号 coreNo（支付成功 order_status=30 的回调），写入分账报文 payInfos.payNo
  const coreNo = await lookupPaymentCoreNo(pay.app_order_id);
  if (!coreNo) console.warn(`[book_order_split_job] ${orderNo} 未取到支付流水号 coreNo（notify_type=pay & order_status=30），payInfos.payNo 可能为空`);
  if (!pay.share_biz_code) {
    console.warn(`[book_order_split_job] ${orderNo} 支付单缺 share_biz_code，跳过`);
    return 'skipped';
  }

  // 下单锁定的分账费率（百分比），缺失则跳过
  const rate = b.commission_rate == null ? null : Number(b.commission_rate);
  if (rate == null || Number.isNaN(rate)) {
    console.warn(`[book_order_split_job] ${orderNo} 缺 commission_rate，跳过`);
    return 'skipped';
  }
  // 分账总额以实际应收现金（已扣优惠券）cash_due_minor 为准；历史订单无该列时回退标价总额
  const totalMinor = Number(b.cash_due_minor != null ? b.cash_due_minor : Number( b.price_total)*100);
  if (!(totalMinor > 0)) {
    console.warn(`[book_order_split_job] ${orderNo} 金额异常，跳过`);
    return 'skipped';
  }

  const body = buildSplitBody({
    orderNo, appOrderId, totalMinor, rate,
    platformMerchantNo,
    merchantMerchantNo: pay.merchant_no, // 收款商户（merchantNo_A），剩余金额归它
    sourceMerchantNo: pay.merchant_no,   // 源收款商户 = 下单收款方
    contractNo,
    bizCode: pay.share_biz_code,
    notifyUrl: process.env.PAY_NOTIFY_SPLIT_URL, // 分账异步回调地址（完整 URL，含 token）
    payNo: coreNo, // 原支付单流水号 coreNo，写入 payInfos.payNo
  });

  // 调分账中台（bizOrderNo 幂等）。失败分两类：① 网络/SDK 抛异常；② 接口返回业务级错误
  // （errno!=0 或 data 缺失）—— payCenter.splitApply 直接返回原始 JSON，错误时不抛异常，必须显式判失败。
  // 两种失败都须把 payment_split.split_status 记为 fail（不能误判成功去落 split），并保持 booking='none' 以便次日重试。
  const requestNo = crypto.randomUUID();
  const startedAt = nowStamp();
  let res = null;
  let failed = false;
  let failMsg = null;
  try {
    res = await payCenter.splitApply(body);
  } catch (e) {
    failed = true;
    failMsg = e.message;
    console.error(`[book_order_split_job] ${orderNo} 调分账接口异常:`, e.message);
  }
  // 接口返回业务级失败（如 errno!=0 / 缺 data）：按 assertPaySuccess 的成功约定 Number(errno)===200 && data!=null 判定
  if (!failed && !(res && Number(res.errno) === 200 && res.data != null)) {
    failed = true;
    failMsg = (res && (res.error || res.msg || res.message)) || `分账接口返回非成功响应: ${JSON.stringify(res)}`;
    console.error(`[book_order_split_job] ${orderNo} 分账接口返回失败:`, failMsg);
  }
  // 无论成功/失败都落网关调用日志（与支付/退款 worker 一致，便于排查与对账）
  await logGateway({
    paymentOrderId: pay.id,
    appOrderId,
    requestNo,
    businessCode: res && res.errno != null ? String(res.errno) : (res && res.code != null ? String(res.code) : null),
    traceId: res && (res.traceId || (res.data && res.data.traceId)) ? (res.traceId || res.data.traceId) : null,
    successFlag: !failed,
    requestJson: JSON.stringify(body),
    responseJson: res != null ? JSON.stringify(res) : null,
    errorMessage: failMsg,
    startedAt,
    finishedAt: nowStamp(),
  });
  // 非生产环境打印分账下单入参/出参，便于联调（生产环境不打，避免敏感信息外泄）
  if (!IS_PROD) {
    console.log('[split apply] 入参 >>>', JSON.stringify(body));
    console.log('[split apply] 出参 <<<', res != null ? JSON.stringify(res) : null, failMsg ? `err: ${failMsg}` : '');
  }

  // 失败：落 payment_split='fail'（独立事务，便于重试与排查）；booking 保持原 split_status（none）以便次日重试
  if (failed) {
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(SQL_INSERT_SPLIT, [
        pay.id, orderNo, appOrderId, appOrderId, pay.share_biz_code,
        `旅居分账 ${orderNo}`, (totalMinor / 100).toFixed(2), contractNo, pay.merchant_no,
        JSON.stringify(body.payInfos), JSON.stringify(body.details), 'fail',
      ]);
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      console.error(`[book_order_split_job] ${orderNo} 失败分账落库失败:`, e.message);
    } finally {
      conn.release();
    }
    throw new Error(failMsg);
  }

  // 成功：插入分账订单（split）+ 更新旅居订单分账状态（split），同事务
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(SQL_INSERT_SPLIT, [
      pay.id, orderNo, appOrderId, appOrderId, pay.share_biz_code,
      `旅居分账 ${orderNo}`, (totalMinor / 100).toFixed(2), contractNo, pay.merchant_no,
      JSON.stringify(body.payInfos), JSON.stringify(body.details), 'split',
    ]);
    await conn.execute(SQL_UPDATE_BOOKING, [nowStamp(), orderNo]);
    await conn.commit();
    return 'processed';
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error(`[book_order_split_job] ${orderNo} 落库失败:`, e.message);
    throw e;
  } finally {
    conn.release();
  }
}

// 执行一次分账（可单独调用 / 手动触发）
async function runOnce() {
  const platformMerchantNo = process.env.PAY_PLATFORM_MERCHANT_NO;
  const notifyUrl = process.env.PAY_NOTIFY_SPLIT_URL;
  if (!platformMerchantNo || !notifyUrl) {
    console.error('[book_order_split_job] 缺少必填环境变量 PAY_PLATFORM_MERCHANT_NO / PAY_NOTIFY_SPLIT_URL，跳过本次执行');
    return { due: 0, processed: 0, skipped: 0, failed: 0, reason: 'missing_env' };
  }

  const due = await queryRows(SQL_SELECT_DUE);
  if (!due || !due.length) {
    console.log('[book_order_split_job] 无待分账订单（checkOut & split_status=none & checkout<=今天-7天）');
    return { due: 0, processed: 0, skipped: 0, failed: 0 };
  }
  console.log(`[book_order_split_job] 待分账 ${due.length} 单`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  for (const b of due) {
    try {
      const r = await processOne(b, platformMerchantNo);
      if (r === 'processed') processed++;
      else if (r === 'skipped') skipped++;
    } catch (e) {
      failed++;
      // 单笔失败不影响其余订单；保留 split_status='none' 次日重试
    }
  }
  console.log(`[book_order_split_job] 完成 processed=${processed} skipped=${skipped} failed=${failed}`);
  return { due: due.length, processed, skipped, failed };
}

// 每天在指定时分触发一次 fn（容错：单次失败仅告警，不影响下次）
function scheduleDaily(hour, minute, fn) {
  let stopped = false;
  let timer = null;
  function nextDelay() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }
  function schedule() {
    timer = setTimeout(async () => {
      if (stopped) return;
      try { await fn(); } catch (e) { console.error('[book_order_split_job] 执行失败:', e.message); }
      if (!stopped) schedule();
    }, nextDelay());
    if (timer.unref) timer.unref();
  }
  schedule();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

// 启动定时任务（被 startJobDir 调用）；返回可停止的句柄
function start() {
  const hour = parseInt(process.env.SPLIT_JOB_HOUR || '8', 10) || 8;
  const minute = parseInt(process.env.SPLIT_JOB_MINUTE || '0', 10) || 0;
  console.log(`[book_order_split_job] 每日 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} 执行旅居订单自动分账`);
  return scheduleDaily(hour, minute, runOnce);
}

/**
 * 按 order_no 单独触发某条 booking_orders 的分账（供 /cmd 测试/运维接口复用，绕过每日定时与 7 天延迟）。
 * 仅按 order_no 取数，不强制 status='checkOut'；已 done/split 直接返回，fail 可重试。
 * @param {string} orderNo
 * @param {{allowRetryFail?: boolean}} [opts]
 * @returns {Promise<{ok:boolean, code?:string, message?:string, result?:string, order_no?:string}>}
 */
async function triggerSplitForOrder(orderNo, { allowRetryFail = true } = {}) {
  const platformMerchantNo = process.env.PAY_PLATFORM_MERCHANT_NO;
  const notifyUrl = process.env.PAY_NOTIFY_SPLIT_URL;
  if (!platformMerchantNo || !notifyUrl) {
    return { ok: false, code: 'missing_env', message: '缺少 PAY_PLATFORM_MERCHANT_NO / PAY_NOTIFY_SPLIT_URL' };
  }
  const rows = await queryRows(
    'SELECT id, order_no, price_total, cash_due_minor, commission_rate, commission_fee, status, split_status FROM booking_orders WHERE order_no = ?',
    [orderNo],
  );
  if (!rows || !rows.length) return { ok: false, code: 'not_found', message: '订单不存在' };
  const b = rows[0];
  if (b.split_status === 'done') return { ok: false, code: 'already_done', message: '已分账(done)，无需重复触发' };
  if (b.split_status === 'split') return { ok: false, code: 'in_progress', message: '分账中(split)，请等待回调终态' };
  // 失败单重试：先清理旧的失败分账记录（gateway 侧 bizOrderNo 幂等，可重提）
  if (allowRetryFail && b.split_status === 'fail') {
    const conn = await getPool().getConnection();
    try {
      await conn.execute('DELETE FROM payment_split WHERE biz_order_no = ? AND split_status = ?', [orderNo, 'fail']);
    } finally {
      conn.release();
    }
  }
  try {
    const r = await processOne(b, platformMerchantNo);
    return { ok: true, result: r, order_no: orderNo };
  } catch (e) {
    return { ok: false, code: 'failed', message: e.message };
  }
}

if (require.main === module) {
  (async () => {
    try {
      const r = await runOnce();
      console.log('[book_order_split_job] 手动执行结果:', JSON.stringify(r));
      process.exit(0);
    } catch (e) {
      console.error('[book_order_split_job] 手动执行失败:', e.message);
      process.exit(1);
    }
  })();
}
module.exports = { start, runOnce, scheduleDaily, buildSplitBody, triggerSplitForOrder };
