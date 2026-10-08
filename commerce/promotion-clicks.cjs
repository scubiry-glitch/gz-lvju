'use strict';

const crypto = require('node:crypto');

const VERSION = '014_referral_visits';
const DDL = `CREATE TABLE IF NOT EXISTS commerce_referral_visits (
  visitor_key CHAR(64) PRIMARY KEY, aggregate_id VARCHAR(40) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL, KEY expiry_idx(expires_at)
) ENGINE=InnoDB`;
const checksum = crypto.createHash('sha256').update(DDL).digest('hex');
const DAILY_VERSION='016_referral_daily';
const DAILY_DDL=`CREATE TABLE IF NOT EXISTS commerce_referral_daily (
  day DATE NOT NULL, promoter_account_id BIGINT NOT NULL, product_kind VARCHAR(24) NOT NULL,
  product_id BIGINT NOT NULL, clicks BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(day,promoter_account_id,product_kind,product_id),
  KEY promoter_idx(promoter_account_id,product_kind,product_id)
) ENGINE=InnoDB`;
const dailyChecksum=crypto.createHash('sha256').update(DAILY_DDL).digest('hex');

async function migrate(conn) {
  const [found] = await conn.execute('SELECT checksum FROM commerce_migrations WHERE version=?', [VERSION]);
  if (found.length && found[0].checksum !== checksum) throw Error('Referral visits migration checksum changed');
  await conn.query(DDL);
  if (!found.length) await conn.execute('INSERT INTO commerce_migrations(version,checksum) VALUES(?,?)', [VERSION, checksum]);
  const [daily]=await conn.execute('SELECT checksum FROM commerce_migrations WHERE version=?',[DAILY_VERSION]);
  if(daily.length&&daily[0].checksum!==dailyChecksum)throw Error('Referral daily migration checksum changed');
  await conn.query(DAILY_DDL);
  if(!daily.length)await conn.execute('INSERT INTO commerce_migrations(version,checksum) VALUES(?,?)',[DAILY_VERSION,dailyChecksum]);
}

async function record(pool, token, data, { ip = '', userAgent = '' } = {}) {
  const secret = process.env.JUZHU_API_KEY || process.env.JUZHU_ADMIN_PASSWORD;
  if (!secret) throw Error('Referral signing key unavailable');
  const day = new Date().toISOString().slice(0, 10);
  // Only a keyed digest is retained. One visitor can count once per link per day.
  const visitorKey = crypto.createHmac('sha256', secret).update(JSON.stringify([token, day, ip, userAgent])).digest('hex');
  const aggregateId = 'referral:' + data.kind + ':' + data.id;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute('INSERT IGNORE INTO commerce_referral_visits(visitor_key,aggregate_id,expires_at) VALUES(?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 8 DAY))', [visitorKey, aggregateId]);
    if (result.affectedRows) await conn.execute(`INSERT INTO commerce_referral_daily(day,promoter_account_id,product_kind,product_id,clicks)
      VALUES(?,?,?,?,1) ON DUPLICATE KEY UPDATE clicks=clicks+1`,[day,data.aid,data.kind,data.id]);
    await conn.commit();
    return Boolean(result.affectedRows);
  } catch (error) {
    await conn.rollback(); throw error;
  } finally { conn.release(); }
}

module.exports = { migrate, record };
