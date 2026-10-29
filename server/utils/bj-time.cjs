'use strict';
/**
 * 北京时间工具（UTC+8）。
 * ---------------------------------------------------------------------------
 * 全库统一口径：数据库时间列一律存「北京时间」的 'YYYY-MM-DD HH:mm:ss'，
 * 不再使用 UTC。中国无夏令时，固定加 8 小时即可，不依赖进程或数据库时区。
 *
 * 与 mysql2 的配合：
 *   - 连接配置使用 timezone: '+08:00'（客户端解析/序列化按北京时间）
 *   - 不再执行 SET time_zone='+00:00'，让 MySQL 会话保持 +08:00，
 *     这样 NOW() / DEFAULT CURRENT_TIMESTAMP 生成的也是北京时间
 * ---------------------------------------------------------------------------
 */

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 'YYYY-MM-DD HH:mm:ss' 或 'YYYY-MM-DDTHH:mm:ss'（可带小数秒） */
const DB_TIME_RE = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/;

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error('时间无效: ' + String(value));
  return d;
}

/**
 * 任意时间 → 北京时间 'YYYY-MM-DD HH:mm:ss'
 * 已是该格式的字符串视为北京时间原样返回（幂等，避免二次 +8）。
 */
function bjStamp(value = new Date()) {
  if (typeof value === 'string' && DB_TIME_RE.test(value)) {
    return value.replace('T', ' ').slice(0, 19);
  }
  return new Date(toDate(value).getTime() + BJ_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/** 任意时间 → 北京时间 ISO 8601（带 +08:00 偏移，如 2026-10-29T12:29:51+08:00） */
function bjIso(value = new Date()) {
  if (typeof value === 'string' && DB_TIME_RE.test(value)) {
    return value.replace(' ', 'T').slice(0, 19) + '+08:00';
  }
  return new Date(toDate(value).getTime() + BJ_OFFSET_MS).toISOString().slice(0, 19) + '+08:00';
}

/**
 * 数据库时间字符串（北京时间）→ Date
 * 兼容历史 UTC 数据：显式带 Z / 偏移的字符串按标准解析。
 */
function parseDbTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  const s = String(value);
  if (DB_TIME_RE.test(s)) return new Date(s.replace(' ', 'T') + '+08:00');
  return new Date(s);
}

/** 数据库时间字符串 → 毫秒时间戳；无效返回 NaN */
function dbTimeMs(value) {
  const d = parseDbTime(value);
  return d ? d.getTime() : NaN;
}

/** 当前时间 + seconds 秒后的北京时间字符串（用于过期时间） */
function bjStampPlus(seconds, base = Date.now()) {
  const b = base instanceof Date ? base.getTime() : Number(base);
  return bjStamp(new Date((Number.isFinite(b) ? b : Date.now()) + seconds * 1000));
}

module.exports = { BJ_OFFSET_MS, bjStamp, bjIso, parseDbTime, dbTimeMs, bjStampPlus };
