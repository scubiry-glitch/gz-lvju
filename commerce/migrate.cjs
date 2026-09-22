'use strict';
const {kinds}=require('./configuration.cjs');
const statements=[
`CREATE TABLE IF NOT EXISTS commerce_migrations (version VARCHAR(64) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`,
...kinds.map(kind=>`CREATE TABLE IF NOT EXISTS commerce_${kind} (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL,
 city_id BIGINT NULL, vendor_id BIGINT NULL, merchant_id BIGINT NULL, store_id BIGINT NULL,
 version INT NOT NULL DEFAULT 1, published_version INT NULL, status VARCHAR(24) NOT NULL DEFAULT 'draft',
 payload JSON NOT NULL, created_by BIGINT NOT NULL, submitted_by BIGINT NULL, reviewed_by BIGINT NULL,
 review_note VARCHAR(1000) NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 KEY scope_idx(city_id,merchant_id), KEY state_idx(status)
) ENGINE=InnoDB`),
`CREATE TABLE IF NOT EXISTS commerce_versions (kind VARCHAR(24) NOT NULL, entity_id BIGINT NOT NULL, version INT NOT NULL, snapshot JSON NOT NULL, reviewed_by BIGINT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(kind,entity_id,version)) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_inventory (sku_id BIGINT PRIMARY KEY, total INT NOT NULL DEFAULT 0, reserved INT NOT NULL DEFAULT 0, granted INT NOT NULL DEFAULT 0, CHECK(total>=0 AND reserved>=0 AND granted>=0 AND total>=reserved+granted)) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_orders (id VARCHAR(40) PRIMARY KEY, account_id BIGINT NOT NULL, city_id BIGINT NOT NULL, product_kind VARCHAR(24) NOT NULL, product_id BIGINT NOT NULL, product_version INT NOT NULL, amount_minor BIGINT NOT NULL, status VARCHAR(24) NOT NULL, expires_at DATETIME NOT NULL, snapshot JSON NOT NULL, source_account_id BIGINT NULL, provider_ref VARCHAR(128) NULL UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY owner_idx(account_id,created_at),KEY expiry_idx(status,expires_at)) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_order_items (id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id VARCHAR(40) NOT NULL, sku_id BIGINT NOT NULL, merchant_id BIGINT NOT NULL, store_id BIGINT NOT NULL, quantity INT NOT NULL, allocation_minor BIGINT NOT NULL, snapshot JSON NOT NULL, KEY order_idx(order_id),KEY merchant_idx(merchant_id)) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_coupons (id VARCHAR(40) PRIMARY KEY, order_id VARCHAR(40) NOT NULL, item_id BIGINT NOT NULL, unit_no INT NOT NULL, account_id BIGINT NOT NULL, merchant_id BIGINT NOT NULL, store_id BIGINT NOT NULL, city_id BIGINT NOT NULL, status VARCHAR(24) NOT NULL, expires_at DATETIME NOT NULL, allocation_minor BIGINT NOT NULL, snapshot JSON NOT NULL, token_hash CHAR(64) NULL, token_expires_at DATETIME NULL, UNIQUE KEY grant_idem(item_id,unit_no),KEY owner_idx(account_id),KEY store_idx(store_id)) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_memberships (order_id VARCHAR(40) PRIMARY KEY, account_id BIGINT NOT NULL, name VARCHAR(255) NOT NULL, expires_at DATETIME NOT NULL, snapshot JSON NOT NULL,KEY owner_idx(account_id)) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_capacity (store_id BIGINT NOT NULL, service_date DATE NOT NULL, total INT NOT NULL, reserved INT NOT NULL DEFAULT 0, PRIMARY KEY(store_id,service_date),CHECK(total>=reserved AND reserved>=0)) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_appointments (id VARCHAR(40) PRIMARY KEY, coupon_id VARCHAR(40) NOT NULL, account_id BIGINT NOT NULL, merchant_id BIGINT NOT NULL, store_id BIGINT NOT NULL, city_id BIGINT NOT NULL, service_date DATE NOT NULL, status VARCHAR(24) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,KEY coupon_idx(coupon_id),KEY store_idx(store_id,service_date,status)) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_redemptions (id VARCHAR(40) PRIMARY KEY, coupon_id VARCHAR(40) NOT NULL UNIQUE, account_id BIGINT NOT NULL, merchant_id BIGINT NOT NULL, store_id BIGINT NOT NULL, city_id BIGINT NOT NULL, operator_id BIGINT NOT NULL, allocation_minor BIGINT NOT NULL, supplier_minor BIGINT NOT NULL, beike_minor BIGINT NOT NULL, channel_minor BIGINT NOT NULL, retained_minor BIGINT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,KEY merchant_idx(merchant_id)) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_cases (id VARCHAR(40) PRIMARY KEY, coupon_id VARCHAR(40) NOT NULL, account_id BIGINT NOT NULL, merchant_id BIGINT NOT NULL, store_id BIGINT NOT NULL, city_id BIGINT NOT NULL, kind VARCHAR(16) NOT NULL, reason VARCHAR(1000) NOT NULL, status VARCHAR(24) NOT NULL, resolution VARCHAR(1000) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,KEY owner_idx(account_id),KEY coupon_idx(coupon_id,status)) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_idempotency (actor_id BIGINT NOT NULL, operation VARCHAR(64) NOT NULL, request_key VARCHAR(80) NOT NULL, digest CHAR(64) NOT NULL, response JSON NULL, PRIMARY KEY(actor_id,operation,request_key)) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_events (id BIGINT AUTO_INCREMENT PRIMARY KEY, aggregate_id VARCHAR(40) NOT NULL, event_type VARCHAR(64) NOT NULL, payload JSON NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, delivered_at DATETIME NULL,KEY delivery_idx(delivered_at)) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_audit (id BIGINT AUTO_INCREMENT PRIMARY KEY, actor_id BIGINT NOT NULL, city_id BIGINT NULL, merchant_id BIGINT NULL, action VARCHAR(64) NOT NULL, resource VARCHAR(64) NOT NULL, detail JSON NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,KEY scope_idx(city_id,merchant_id)) ENGINE=InnoDB`,
];
const crypto=require('node:crypto');
async function migrate(pool) {
 const conn=await pool.getConnection();
 try {
  const [[lock]]=await conn.query("SELECT GET_LOCK('commerce_m1a_migrate',30) AS acquired"); if(!lock.acquired) throw Error('Migration lock unavailable');
  await conn.query(statements[0]);
  const hash=crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  const [existing]=await conn.execute('SELECT checksum FROM commerce_migrations WHERE version=?',['001_m1a']);
  if(existing.length && existing[0].checksum!==hash) throw Error('Migration checksum changed; add a new version');
  if(!existing.length){
  // MySQL DDL commits implicitly. Every step is restart-safe; record only after all succeed.
  for(const sql of statements.slice(1)) await conn.query(sql);
  await conn.execute('INSERT INTO commerce_migrations(version,checksum) VALUES(?,?)',['001_m1a',hash]);
  }
  await require('./exchange-codes.cjs').migrate(conn);
  await require('./settlement.cjs').migrate(conn);
 } finally { await conn.query("SELECT RELEASE_LOCK('commerce_m1a_migrate')").catch(()=>{}); conn.release(); }
}
module.exports={migrate,statements};
if(require.main===module){const pool=require('./db.cjs').createPool();migrate(pool).then(()=>console.log('Commerce migration 001_m1a verified')).catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>pool.end());}
