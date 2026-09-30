'use strict';
/**
 * MySQL 连接池与查询（从 app.js 拆出）。
 * 凭证只读环境变量 MYSQL_* / JUZHU_DB_*，禁止写死源码。
 */

let mysql2 = null;
try { mysql2 = require('mysql2/promise'); } catch (_) {}

function getDbConfig() {
  const host = (process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '').trim();
  const database = (process.env.MYSQL_DB || process.env.JUZHU_DB_NAME || '').trim();
  const user = (process.env.MYSQL_USER || process.env.JUZHU_DB_USER || '').trim();
  const password = process.env.MYSQL_PASSWORD != null && process.env.MYSQL_PASSWORD !== ''
    ? process.env.MYSQL_PASSWORD
    : process.env.JUZHU_DB_PASSWORD;
  const port = parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10);
  if (!host || !database || !user || password == null || password === '') {
    throw new Error('MySQL env incomplete: set MYSQL_HOST/MYSQL_PORT/MYSQL_DB/MYSQL_USER/MYSQL_PASSWORD (or JUZHU_DB_*)');
  }
  return {
    host,
    port,
    database,
    user,
    password,
    charset: 'utf8mb4',
    connectTimeout: 8000,
    decimalNumbers: true,
  };
}

let _pool = null;
function getPool() {
  if (!mysql2) throw new Error('mysql2 not available');
  if (!_pool) {
    _pool = mysql2.createPool(Object.assign({}, getDbConfig(), {
      waitForConnections: true,
      connectionLimit: 8,
      queueLimit: 0,
      enableKeepAlive: true,
    }));
  }
  return _pool;
}

/** 连接类错误 → 换连接重试一次；业务错误不重试 */
const DB_RETRYABLE = [
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
];

async function withDbRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    const code = e && (e.code || e.errno);
    const fatal = e && e.fatal === true;
    if (!DB_RETRYABLE.includes(code) && !fatal) throw e;
    await new Promise((r) => setTimeout(r, 250));
    return fn();
  }
}

async function queryRows(sql, params) {
  return withDbRetry(async () => {
    const [rows] = await getPool().execute(sql, params || []);
    return rows;
  });
}

function getMysql() {
  return mysql2;
}

module.exports = {
  getDbConfig,
  getPool,
  withDbRetry,
  queryRows,
  getMysql,
};
