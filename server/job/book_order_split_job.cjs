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
 *     PAY_NOTIFY_SPLIT_URL          分账异步回调地址
 *   可配置：SPLIT_JOB_HOUR（默认 8）、SPLIT_JOB_MINUTE（默认 0）
 * - 手动触发（立即跑一次并退出），按参数自动加载根目录 env 文件，缺省 test：
 *     node server/job/book_order_split_job.cjs test            → .env.test → .env → runtime.env
 *     node server/job/book_order_split_job.cjs prod            → .env.prod → .env → runtime.env
 *     node server/job/book_order_split_job.cjs --env=prod      → 同上
 *     JUZHU_ENV=prod node server/job/book_order_split_job.cjs  → 同上
 *   选择优先级：命令行参数 > JUZHU_ENV > 默认 test（不读 NODE_ENV，避免 IDE 注入 production 时误连生产）；
 *   与 app.js 同约定：不覆盖已存在的非空环境变量，命令行显式注入仍优先。
 * ---------------------------------------------------------------------------
 *
 * 注意：发起分账以后，只要理房通受理成功了，一个小时就会自动重试一次，分账指令，发起以后，无法撤销
 */
'use strict';

const path = require('path');
const fs = require('fs');

// ── 运行时 env 加载 ─────────────────────────────────────────────────────────
// 直接执行本文件时，按参数/JUZHU_ENV 读取根目录 .env.<env>，再回退 .env、runtime.env；
// 被 app.js 通过 startJobDir require 时环境已注入，不再重复加载。
// 注意：payCenter.cjs 在 require 期即读取 OAUTH_*，env 必须先于下面的 require 加载。
//   node server/job/book_order_split_job.cjs test            → .env.test
//   node server/job/book_order_split_job.cjs prod            → .env.prod
//   node server/job/book_order_split_job.cjs --env=prod      → .env.prod
//   JUZHU_ENV=prod node server/job/book_order_split_job.cjs  → .env.prod
// 与 app.js 同约定：不覆盖已存在的非空环境变量（命令行显式注入仍优先）。
const ROOT_DIR = path.resolve(__dirname, '..', '..');

/** 解析 KEY=VALUE（支持 # 注释 / export 前缀 / 成对引号），不覆盖已存在的非空环境变量 */
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let text = '';
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (_) { return false; }
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (Object.prototype.hasOwnProperty.call(process.env, key) && process.env[key] !== '') continue;
    process.env[key] = val;
  }
  return true;
}

/** 从命令行解析环境：test | prod | dev，或 --env=prod / --env prod / -e prod */
function resolveEnvArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env' || a === '-e') return argv[i + 1] || '';
    if (a.startsWith('--env=')) return a.slice('--env='.length);
    if (/^(test|prod|production|dev|development)$/i.test(a)) return a;
  }
  return '';
}

const ENV_ALIASES = { production: 'prod', development: 'dev' };
let LOADED_ENV = '';
if (require.main === module) {
  // 优先级：命令行参数 > JUZHU_ENV > 默认 test。
  // 刻意不读 NODE_ENV：IDE/工具链常注入 NODE_ENV=production，若据此选库会误连生产。
  const argEnv = resolveEnvArg(process.argv.slice(2));
  const chosen = argEnv || process.env.JUZHU_ENV || 'test';
  const envName = ENV_ALIASES[String(chosen).toLowerCase()] || String(chosen).toLowerCase();
  const envSource = argEnv ? '命令行参数' : (process.env.JUZHU_ENV ? 'JUZHU_ENV' : '默认');
  // 显式参数优先：先落 JUZHU_ENV，防止被 env 文件里的旧值反超（loadDotEnv 不覆盖已有值）
  process.env.JUZHU_ENV = envName;
  const envFile = path.join(ROOT_DIR, `.env.${envName}`);
  const loaded = [];
  if (loadDotEnv(envFile)) loaded.push(path.basename(envFile));
  else console.warn(`[book_order_split_job] 未找到 ${envFile}`);
  if (loadDotEnv(path.join(ROOT_DIR, '.env'))) loaded.push('.env');
  if (loadDotEnv(path.join(ROOT_DIR, 'runtime.env'))) loaded.push('runtime.env');
  LOADED_ENV = envName;
  console.log(`[book_order_split_job] env=${envName}（来源：${envSource}；加载：${loaded.length ? loaded.join(' → ') : '无 env 文件，仅用当前进程环境'}）`);
}

const crypto = require('crypto');
const { queryRows, getPool } = require(path.join(__dirname, '..', 'db.cjs'));
const { payCenter } = require(path.join(__dirname, '..', 'thirdApi', 'payCenter.cjs'));
const { generateAppOrderId } = require(path.join(__dirname, '..', 'payment', 'primitives.cjs'));
const { sendMarkdown } = require(path.join(__dirname, '..', 'utils', 'wecom-robot.cjs'));

// 非生产环境打印分账下单入参/出参，便于联调；生产环境关闭。
// 以 JUZHU_ENV 为准（上面已按参数落定），不掺入 IDE 常注入的 NODE_ENV。
const IS_PROD = /^(prod|production)$/i.test(process.env.JUZHU_ENV || '');

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
const SQL_EXISTS_SPLIT = `
  SELECT id FROM payment_split WHERE biz_order_no = ?   LIMIT 1`;

// 插入分账订单；split_status 由调用方传入（'split' 分账中 / 'fail' 申请失败）；
// split_order_no / gateway_order_status 在 apply 成功时从响应 data 回写（失败响应为 null）
const SQL_INSERT_SPLIT = `
  INSERT INTO payment_split
    (payment_order_id, biz_order_no, app_order_id, idempotency_key, biz_code,
     order_name, amount, contract_no, source_merchant_no, pay_infos, split_details,
     split_status, split_order_no, gateway_order_status, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?, ?, ?, ?, NOW(), NOW())`;

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

// 业务时钟：北京时间（UTC+8）'YYYY-MM-DD HH:mm:ss'。
// 中国无夏令时，固定加 8 小时即可，不依赖进程/数据库时区；与 MySQL NOW() 的口径一致。
function nowStamp() {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return bj.toISOString().slice(0, 19).replace('T', ' ');
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
 *   - orderCallbackUrl: 分账异步回调地址（PAY_NOTIFY_SPLIT_URL），中台分账结果经此回调 /api/juzhu/payment/split/notify/:token
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
    orderCallbackUrl: notifyUrl,
    payInfos,
    details,
  };
}

// 跳过原因 → 企微通知展示文案（键顺序即通知中的展示顺序）
const SKIP_LABELS = {
  'skipped:existing_split': '已有分账记录',
  'skipped:no_paid_payment': '无已支付支付单',
  'skipped:no_share_biz_code': '支付单缺 share_biz_code',
  'skipped:no_commission_rate': '缺 commission_rate',
  'skipped:invalid_amount': '分账金额异常',
};
const SKIP_CODES = Object.keys(SKIP_LABELS);

// 处理单个订单：校验 → 调分账中台 → 同事务落库。
// 返回 'processed' | 'skipped:<reason>'（reason 见 SKIP_LABELS），
// 带原因后缀便于 runOnce 按类型统计、企微通知分别展示各类跳过次数。
async function processOne(b, platformMerchantNo) {
  const orderNo = b.order_no;
  // 分账业务单号：沿用支付/退款的 generateAppOrderId 规则（prefix_时间戳_随机），前缀 FZ，全局唯一
  const appOrderId = generateAppOrderId('FZ');

  // 已存在分账记录 → 跳过（按 biz_order_no 去重，保证一个旅居订单仅一笔分账）
  const [existing] = await queryRows(SQL_EXISTS_SPLIT, [orderNo]);
  if (existing && existing.length) return 'skipped:existing_split';

  // 取已支付支付单（收款商户号 + 统一业务码 + 分账合同号 biz_order_no）
  const paid = await queryRows(SQL_SELECT_PAID_PAYMENT, [orderNo]);
  if (!paid || !paid.length) {
    console.warn(`[book_order_split_job] ${orderNo} 无已支付支付单，跳过`);
    return 'skipped:no_paid_payment';
  }
  const pay = paid[0];
  const contractNo = pay.biz_order_no; // 分账合同号取支付单的业务订单号
  // 原支付单流水号 coreNo（支付成功 order_status=30 的回调），写入分账报文 payInfos.payNo
  const coreNo = await lookupPaymentCoreNo(pay.app_order_id);
  if (!coreNo) console.warn(`[book_order_split_job] ${orderNo} 未取到支付流水号 coreNo（notify_type=pay & order_status=30），payInfos.payNo 可能为空`);
  if (!pay.share_biz_code) {
    console.warn(`[book_order_split_job] ${orderNo} 支付单缺 share_biz_code，跳过`);
    return 'skipped:no_share_biz_code';
  }

  // 下单锁定的分账费率（百分比），缺失则跳过
  const rate = b.commission_rate == null ? null : Number(b.commission_rate);
  if (rate == null || Number.isNaN(rate)) {
    console.warn(`[book_order_split_job] ${orderNo} 缺 commission_rate，跳过`);
    return 'skipped:no_commission_rate';
  }
  // 分账总额以实际应收现金（已扣优惠券）cash_due_minor 为准；历史订单无该列时回退标价总额
  const totalMinor = Number(b.cash_due_minor != null ? b.cash_due_minor : Number( b.price_total)*100);
  if (!(totalMinor > 0)) {
    console.warn(`[book_order_split_job] ${orderNo} 金额异常，跳过`);
    return 'skipped:invalid_amount';
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

  // 从成功响应解析中台分账单号与状态，落库时回写 payment_split。
  // 字段与回调一致：data.orderNo → split_order_no；data.orderStatus/data.status → gateway_order_status。
  // 失败响应 data 为空，这里自然为 null。
  const splitData = res && res.data && typeof res.data === 'object' ? res.data : null;
  const splitOrderNo = splitData ? (splitData.orderNo || splitData.splitOrderNo || null) : null;
  const gatewayStatus = splitData ? (splitData.orderStatus || splitData.status || null) : null;

  // 失败：落 payment_split='fail'（独立事务，便于重试与排查）；booking 保持原 split_status（none）以便次日重试
  if (failed) {
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(SQL_INSERT_SPLIT, [
        pay.id, orderNo, appOrderId, appOrderId, pay.share_biz_code,
        `旅居分账 ${orderNo}`, (totalMinor / 100).toFixed(2), contractNo, pay.merchant_no,
        JSON.stringify(body.payInfos), JSON.stringify(body.details), 'fail', null, null,
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
      JSON.stringify(body.payInfos), JSON.stringify(body.details), 'split', splitOrderNo, gatewayStatus,
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

// 企微通知（异常只告警，绝不影响分账主流程）
async function notifySplit(content) {
  try {
    await sendMarkdown(content);
  } catch (e) {
    console.warn('[book_order_split_job] 企微通知发送失败:', e && e.message);
  }
}

// 执行一次分账（可单独调用 / 手动触发）
async function runOnce() {
  const platformMerchantNo = process.env.PAY_PLATFORM_MERCHANT_NO;
  const notifyUrl = process.env.PAY_NOTIFY_SPLIT_URL;
  if (!platformMerchantNo || !notifyUrl) {
    const envHint = LOADED_ENV || process.env.JUZHU_ENV || 'unknown';
    const reason = `缺少必填环境变量 PAY_PLATFORM_MERCHANT_NO / PAY_NOTIFY_SPLIT_URL（当前 env=${envHint}），跳过本次执行；`
      + `请检查根目录 .env.${envHint}，或用 node server/job/book_order_split_job.cjs test|prod 指定环境`;
    console.error('[book_order_split_job] ' + reason);
    await notifySplit(`**旅居分账定时任务跳过**\n> 原因：${reason}\n> 时间：${nowStamp()}`);
    return { due: 0, processed: 0, skipped: 0, failed: 0, skip_reasons: {}, reason: 'missing_env' };
  }

  let due;
  try {
    due = await queryRows(SQL_SELECT_DUE);
  } catch (e) {
    const msg = `查询待分账订单失败: ${(e && e.message) || e}`;
    console.error('[book_order_split_job] ' + msg);
    await notifySplit(`**旅居分账定时任务执行失败**\n> 错误：${msg}\n> 时间：${nowStamp()}`);
    throw e;
  }
  if (!due || !due.length) {
    console.log('[book_order_split_job] 无待分账订单（checkOut & split_status=none & checkout<=今天-7天）');
    if (process.env.SPLIT_JOB_NOTIFY_ALWAYS === '1') {
      await notifySplit(`**旅居分账定时任务**\n> 无待分账订单\n> 时间：${nowStamp()}`);
    }
    return { due: 0, processed: 0, skipped: 0, failed: 0, skip_reasons: {} };
  }
  console.log(`[book_order_split_job] 待分账 ${due.length} 单`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];
  const skipCounts = {}; // skipped:<reason> -> 次数，用于企微通知按类型展示
  for (const b of due) {
    try {
      const r = await processOne(b, platformMerchantNo);
      if (r === 'processed') processed++;
      else if (typeof r === 'string' && r.startsWith('skipped:')) {
        skipped++;
        skipCounts[r] = (skipCounts[r] || 0) + 1;
      }
    } catch (e) {
      failed++;
      // 单笔失败不影响其余订单；保留 split_status='none' 次日重试
      failures.push({ orderNo: b.order_no, message: (e && e.message) || String(e) });
    }
  }
  console.log(`[book_order_split_job] 完成 processed=${processed} skipped=${skipped} failed=${failed} skipCounts=${JSON.stringify(skipCounts)}`);

  // 企微通知：本次有待分账订单即汇总推送（含跳过分类与失败明细）；无待分账时可设 SPLIT_JOB_NOTIFY_ALWAYS=1 也推送
  const lines = [
    failed > 0 ? '**旅居分账定时任务（有失败）**' : '**旅居分账定时任务**',
    `> 待分账：${due.length}`,
    `> 成功：${processed}`,
    `> 跳过：${skipped}`,
  ];
  // 跳过按原因分类展示，只列本次实际出现的类型；顺序固定，便于横向对比
  SKIP_CODES.forEach((code) => {
    const n = skipCounts[code];
    if (n) lines.push(`>   - ${SKIP_LABELS[code]}：${n}`);
  });
  lines.push(`> 失败：${failed}`, `> 时间：${nowStamp()}`);
  if (failures.length) {
    lines.push('', '**失败明细**');
    failures.forEach((f) => lines.push(`- ${f.orderNo}：${f.message}`));
  }
  await notifySplit(lines.join('\n'));

  return { due: due.length, processed, skipped, failed, skip_reasons: skipCounts };
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
 *   result 取值：'processed' | 'skipped:<reason>'（reason 见 SKIP_LABELS）
 */
async function triggerSplitForOrder(orderNo, { allowRetryFail = true } = {}) {
  const platformMerchantNo = process.env.PAY_PLATFORM_MERCHANT_NO;
  const notifyUrl = process.env.PAY_NOTIFY_SPLIT_URL;
  if (!platformMerchantNo || !notifyUrl) {
    const envHint = LOADED_ENV || process.env.JUZHU_ENV || 'unknown';
    return { ok: false, code: 'missing_env', message: `缺少 PAY_PLATFORM_MERCHANT_NO / PAY_NOTIFY_SPLIT_URL（当前 env=${envHint}）` };
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
module.exports = { start, runOnce, scheduleDaily, buildSplitBody, triggerSplitForOrder, SKIP_LABELS, SKIP_CODES };
