'use strict';
async function migrate(c){
 const [tables]=await c.execute("SELECT 1 FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='booking_orders'");
 if(tables.length){
  await require('./schema.cjs').column(c,'booking_orders','payment_config_snapshot','JSON NULL');
  const [[price]]=await c.execute("SELECT DATA_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='booking_orders' AND COLUMN_NAME='price_total'");
  if(price&&['tinyint','smallint','mediumint','int'].includes(price.DATA_TYPE))await c.query('ALTER TABLE booking_orders MODIFY price_total DECIMAL(12,2) '+(price.IS_NULLABLE==='YES'?'NULL':'NOT NULL'));
 }
 await c.query(`CREATE TABLE IF NOT EXISTS commerce_booking_statement_facts (
 id VARCHAR(36) PRIMARY KEY,sequence_no BIGINT NOT NULL AUTO_INCREMENT UNIQUE,context_id VARCHAR(36) NOT NULL,snapshot_hash CHAR(64) NOT NULL,snapshot JSON NOT NULL,
 recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,KEY as_of_idx(context_id,recorded_at,sequence_no)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
}
module.exports={migrate};
