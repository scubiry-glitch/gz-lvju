'use strict';
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
function loadEnvironment() {
  // Only credential-related keys from the existing host mechanism; never log values.
  const file = process.env.COMMERCE_ENV_FILE || path.resolve(__dirname, '../juzhu/.env.local');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.trim().match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/); if (!m) continue;
    if (!/^(MYSQL_|JUZHU_DB_|JUZHU_API_KEY$|JUZHU_ADMIN_PASSWORD$|AUTH_)/.test(m[1])) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}
function config() {
  loadEnvironment();
  const env = process.env;
  const value = { host: env.MYSQL_HOST || env.JUZHU_DB_HOST, port: Number(env.MYSQL_PORT || env.JUZHU_DB_PORT || 3306), database: env.COMMERCE_DB_NAME || env.MYSQL_DB || env.JUZHU_DB_NAME, user: env.MYSQL_USER || env.JUZHU_DB_USER, password: env.MYSQL_PASSWORD || env.JUZHU_DB_PASSWORD };
  if (!value.host || !value.database || !value.user || !value.password) throw new Error('Commerce database configuration missing in host credential mechanism');
  return { ...value, charset: 'utf8mb4', connectTimeout: 10000, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: false, multipleStatements: false };
}
function createPool() { return mysql.createPool({ ...config(), connectionLimit: 8, waitForConnections: true, queueLimit: 50 }); }
function initAuth(pool) {
  const auth = require('../auth_center.cjs');
  auth.init({ query: async (sql, args) => (await pool.execute(sql, args || []))[0], exec: async (sql, args) => (await pool.execute(sql, args || []))[0], expectedApiKey: () => process.env.JUZHU_API_KEY || '', expectedAdminPassword: () => process.env.JUZHU_ADMIN_PASSWORD || '', isProduction: () => true });
  return auth;
}
module.exports = { createPool, config, initAuth, loadEnvironment };
