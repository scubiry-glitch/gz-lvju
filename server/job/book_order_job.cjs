#!/usr/bin/env node
/**
 * server/job/book_order_job.cjs
 * ---------------------------------------------------------------------------
 * 旅居订单自动离店：每日 16:00 查找「状态=confirmed 且 离店日期(checkout) <= 当天」的
 * booking_orders，将其状态更新为 checkOut（已离店）。
 *
 * - 约定：导出 start()，由 app.js 的 startJobDir 在启动时自动拉起。
 * - “当天”用 MySQL CURDATE() 判定，避免 JS 时区偏差。
 * - 支持手动触发： MYSQL_HOST=m12128.mars.test.mysql.ljnode.com  MYSQL_PORT=12128  MYSQL_DB=juzhu  MYSQL_USER=lvju  MYSQL_PASSWORD=GZ@2026.rd node server/job/book_order_job.cjs   （立即跑一次并退出）
 * - 可选环境变量：BOOK_ORDER_JOB_HOUR（默认 16）、BOOK_ORDER_JOB_MINUTE（默认 0）
 * ---------------------------------------------------------------------------
 */
'use strict';

const path = require('path');
const { queryRows } = require(path.join(__dirname, '..', 'db.cjs'));

// 待离店：已确认 + 离店日期 <= 今天
const SQL_SELECT_DUE = `
  SELECT id, order_no, project_id, checkout
  FROM booking_orders
  WHERE status = 'confirmed' AND checkout <= CURDATE()
  ORDER BY id`;

// 批量置为已离店（updated_at 写入北京时间 'YYYY-MM-DD HH:mm:ss'）
const SQL_UPDATE_CHECKOUT = `
  UPDATE booking_orders
  SET status = 'checkOut', updated_at = ?
  WHERE status = 'confirmed' AND checkout <= CURDATE()`;

// 业务时钟：北京时间（UTC+8）'YYYY-MM-DD HH:mm:ss'。
// 中国无夏令时，固定加 8 小时即可，不依赖进程/数据库时区；与 MySQL NOW() 的口径一致。
function nowStamp() {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return bj.toISOString().slice(0, 19).replace('T', ' ');
}

// 执行一次离店更新（可单独调用 / 手动触发）
async function runOnce() {
  const rows = await queryRows(SQL_SELECT_DUE);
  if (!rows || !rows.length) {
    console.log('[book_order_job] 无待离店订单（confirmed & checkout<=今天）');
    return { due: 0, updated: 0 };
  }
  console.log(`[book_order_job] 待离店 ${rows.length} 单: ${rows.map((r) => r.order_no).join(', ')}`);
  const res = await queryRows(SQL_UPDATE_CHECKOUT, [nowStamp()]);
  const updated = (res && res.affectedRows) || 0;
  console.log(`[book_order_job] 已更新 ${updated} 单为 checkOut`);
  return { due: rows.length, updated };
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
      try { await fn(); } catch (e) { console.error('[book_order_job] 执行失败:', e.message); }
      if (!stopped) schedule();
    }, nextDelay());
    if (timer.unref) timer.unref();
  }
  schedule();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

// 启动定时任务（被 startJobDir 调用）；返回可停止的句柄
function start() {
  const hour = parseInt(process.env.BOOK_ORDER_JOB_HOUR || '16', 10) || 16;
  const minute = parseInt(process.env.BOOK_ORDER_JOB_MINUTE || '0', 10) || 0;
  console.log(`[book_order_job] 每日 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} 执行旅居订单自动离店`);
  return scheduleDaily(hour, minute, runOnce);
}

if (require.main === module) {
  (async () => {
    try {
      const r = await runOnce();
      console.log('[book_order_job] 手动执行结果:', JSON.stringify(r));
      process.exit(0);
    } catch (e) {
      console.error('[book_order_job] 手动执行失败:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = { start, runOnce, scheduleDaily };
