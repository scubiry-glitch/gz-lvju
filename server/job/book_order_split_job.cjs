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
 * - 幂等：payment_split 以 app_order_id = `SPLIT-{order_no}` 唯一；booking 仅在仍
 *   split_status='none' 时更新；分账中台侧 bizOrderNo 亦幂等，失败次日重试。
 * - 必填环境变量（缺失则本次跳过并在日志告警，不影响其余订单/下次执行）：
 *     contractInfo.contractNo 取关联支付单 payment_orders.biz_order_no（即 booking_orders.order_no）
 *     PAY_PLATFORM_MERCHANT_NO      平台商户号（merchantNo_P，平台抽成入账方，复用既有配置）
 *   可配置：SPLIT_JOB_HOUR（默认 8）、SPLIT_JOB_MINUTE（默认 0）
 * - 手动触发：node server/job/book_order_split_job.cjs   （立即跑一次并退出）
 * ---------------------------------------------------------------------------
 */
'use strict';

const path = require('path');
const { queryRows, getPool } = require(path.join(__dirname, '..', 'db.cjs'));
const { payCenter } = require(path.join(__dirname, '..', 'thirdApi', 'payCenter.cjs'));

// 待分账：已离店 + 未分账 + 离店日期 <= 今天-7天
const SQL_SELECT_DUE = `
  SELECT id, order_no, price_total, commission_rate, commission_fee
  FROM booking_orders
  WHERE status = 'checkOut'
    AND split_status = 'none'
    AND checkout <= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
  ORDER BY id`;

// 取该订单已支付成功的支付单（拿收款商户号 + 统一业务码）
const SQL_SELECT_PAID_PAYMENT = `
  SELECT id, merchant_no, share_biz_code, biz_order_no
  FROM payment_orders
  WHERE biz_order_no = ? AND pay_status = 'paid'
  ORDER BY paid_at DESC
  LIMIT 1`;

// 已有分账记录则跳过（防止重复提交/落库）
const SQL_EXISTS_SPLIT = `
  SELECT id FROM payment_split WHERE app_order_id = ? LIMIT 1`;

// 插入分账订单（split_status='split' 分账中）
const SQL_INSERT_SPLIT = `
  INSERT INTO payment_split
    (payment_order_id, biz_order_no, app_order_id, idempotency_key, biz_code,
     order_name, amount, contract_no, source_merchant_no, pay_infos, split_details,
     split_status, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?, 'split', NOW(), NOW())`;

// 更新旅居订单分账状态（只在仍为 none 时更新，防并发/重复）
const SQL_UPDATE_BOOKING = `
  UPDATE booking_orders SET split_status = 'split', updated_at = ?
  WHERE order_no = ? AND split_status = 'none'`;

// 业务时钟（与 app.js 一致）：UTC 'YYYY-MM-DD HH:mm:ss'
function nowStamp() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 组装 ACN 分账申请报文（payCenter.splitApply 入参）。
 * 分账模型：钱先由「源收款商户」收下，再按比例分给「平台」与「收款商户」两方。
 * 金额单位为元（字符串，2 位小数）；内部一律以「分」(minor) 整数运算，平台份额分位向下取整。
 *
 * @param {object}   p
 * @param {string}   p.orderNo             旅居业务订单号（booking_orders.order_no），用于生成幂等 bizOrderNo 与 orderName
 * @param {number}   p.totalMinor          分账总金额（单位：分 = 元×100），取自 booking_orders.price_total
 * @param {number}   p.rate                下单锁定的分账费率（百分比，如 10 表示 10%），取自 booking_orders.commission_rate
 * @param {string}   p.platformMerchantNo  平台商户号（merchantNo_P），平台抽成入账方，取自 PAY_PLATFORM_MERCHANT_NO
 * @param {string}   p.merchantMerchantNo  收款商户号（merchantNo_A），剩余金额（货款）入账方，取自 payment_orders.merchant_no
 * @param {string}   p.sourceMerchantNo    源收款商户号（merchantNo_A），即下单时实际收款方，也是分账的资金出处，取自 payment_orders.merchant_no
 * @param {string}   p.contractNo          分账合同号，取自 payment_orders.biz_order_no（即 booking_orders.order_no）
 * @param {string}   p.bizCode             统一业务码，取自 payment_orders.share_biz_code
 * @returns {object}  splitApply 所需的请求体
 *   - bizOrderNo  : `SPLIT-{orderNo}`，分账业务单号/幂等键 → 对应 payment_split.app_order_id
 *   - bizCode     : 统一业务码
 *   - orderName   : 分账订单名称
 *   - amount      : 分账总金额（元，字符串）
 *   - contractInfo: { contractNo } 分账合同号
 *   - payInfos    : 收款参与方列表 [{ merchantNo, amount }]，两方金额之和 = amount
 *   - details     : 分账明细列表 [{ bizDetailNo, splitLevel, payerMerchantNo(源商户), payAmount, payeeMerchantNo(目标商户), leafFlag, summary }]
 */
function buildSplitBody({ orderNo, totalMinor, rate, platformMerchantNo, merchantMerchantNo, sourceMerchantNo, contractNo, bizCode }) {
  const totalStr = (totalMinor / 100).toFixed(2);
  const platformMinor = Math.floor((totalMinor * rate) / 100); // 分位向下取整
  const merchantMinor = totalMinor - platformMinor;
  const platformStr = (platformMinor / 100).toFixed(2);
  const merchantStr = (merchantMinor / 100).toFixed(2);
  const appOrderId = `SPLIT-${orderNo}`;

  const payInfos = [{ merchantNo: platformMerchantNo, amount: platformStr }];
  const details = [{
    bizDetailNo: '1', splitLevel: 1, payerMerchantNo: sourceMerchantNo,
    payAmount: platformStr, payeeMerchantNo: platformMerchantNo, leafFlag: 1, summary: '平台服务费',
  }];
  if (merchantMinor > 0) {
    payInfos.push({ merchantNo: merchantMerchantNo, amount: merchantStr });
    details.push({
      bizDetailNo: '2', splitLevel: 1, payerMerchantNo: sourceMerchantNo,
      payAmount: merchantStr, payeeMerchantNo: merchantMerchantNo, leafFlag: 1, summary: '商户货款',
    });
  }

  return {
    bizOrderNo: appOrderId,
    bizCode,
    orderName: `旅居分账 ${orderNo}`,
    amount: totalStr,
    contractInfo: { contractNo },
    payInfos,
    details,
  };
}

// 处理单个订单：校验 → 调分账中台 → 同事务落库。返回 'processed' | 'skipped'
async function processOne(b, platformMerchantNo) {
  const orderNo = b.order_no;
  const appOrderId = `SPLIT-${orderNo}`;

  // 已存在分账记录 → 跳过（保证幂等）
  const [existing] = await queryRows(SQL_EXISTS_SPLIT, [appOrderId]);
  if (existing && existing.length) return 'skipped';

  // 取已支付支付单（收款商户号 + 统一业务码 + 分账合同号 biz_order_no）
  const paid = await queryRows(SQL_SELECT_PAID_PAYMENT, [orderNo]);
  if (!paid || !paid.length) {
    console.warn(`[book_order_split_job] ${orderNo} 无已支付支付单，跳过`);
    return 'skipped';
  }
  const pay = paid[0];
  const contractNo = pay.biz_order_no; // 分账合同号取支付单的业务订单号
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
  const totalMinor = Math.round(Number(b.price_total) * 100);
  if (!(totalMinor > 0)) {
    console.warn(`[book_order_split_job] ${orderNo} 金额异常，跳过`);
    return 'skipped';
  }

  const body = buildSplitBody({
    orderNo, totalMinor, rate,
    platformMerchantNo,
    merchantMerchantNo: pay.merchant_no, // 收款商户（merchantNo_A），剩余金额归它
    sourceMerchantNo: pay.merchant_no,   // 源收款商户 = 下单收款方
    contractNo,
    bizCode: pay.share_biz_code,
  });

  // 调分账中台（bizOrderNo 幂等，失败抛出由上层计 failed，保留 none 次日重试）
  try {
    await payCenter.splitApply(body);
  } catch (e) {
    console.error(`[book_order_split_job] ${orderNo} 调分账接口失败:`, e.message);
    throw e;
  }

  // 落库：插入分账订单 + 更新旅居订单分账状态（同事务）
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(SQL_INSERT_SPLIT, [
      pay.id, orderNo, appOrderId, appOrderId, pay.share_biz_code,
      `旅居分账 ${orderNo}`, (totalMinor / 100).toFixed(2), contractNo, pay.merchant_no,
      JSON.stringify(body.payInfos), JSON.stringify(body.details),
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
  if (!platformMerchantNo) {
    console.error('[book_order_split_job] 缺少必填环境变量 PAY_PLATFORM_MERCHANT_NO，跳过本次执行');
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

module.exports = { start, runOnce, scheduleDaily, buildSplitBody };
