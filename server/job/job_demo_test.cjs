#!/usr/bin/env node
/**
 * server/job/job_demo_test.cjs
 * ---------------------------------------------------------------------------
 * 定时任务联调用最小示例：每秒打印一行日志（当前时间）。
 *
 * 用法：
 *   node server/job/job_demo_test.cjs          # 每秒打印一行，Ctrl+C 退出
 *   node server/job/job_demo_test.cjs 5000     # 可选：第 1 参数为间隔毫秒数（默认 1000）
 * ---------------------------------------------------------------------------
 */
'use strict';

// 格式化本地时间：YYYY-MM-DD HH:mm:ss
function formatNow(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
    + `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

// 启动定时打印；返回 timer 便于外部清理
function start(intervalMs = 60000) {
  let count = 0;
  const timer = setInterval(() => {
    count += 1;
    console.log(`[job/tick_test] #${count} ${formatNow()}`);
  }, intervalMs);

  const stop = () => {
    clearInterval(timer);
    console.log(`[job/tick_test] stopped after ${count} ticks`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  return timer;
}

if (require.main === module) {
  const intervalMs = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 1000;
  console.log(`[job/tick_test] start, interval=${intervalMs}ms (Ctrl+C to stop)`);
  start(intervalMs);
}

module.exports = { start, formatNow };
