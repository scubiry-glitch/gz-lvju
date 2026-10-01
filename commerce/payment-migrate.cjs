'use strict';
const crypto = require('node:crypto');

// Keep the original commerce migration checksums unchanged.
const columns = [
  ['commerce_orders', 'payment_mode', "VARCHAR(16) NULL"],
  ['commerce_orders', 'payment_status', "VARCHAR(32) NOT NULL DEFAULT 'unpaid'"],
  ['commerce_orders', 'paid_payment_order_id', 'BIGINT NULL'],
  ['commerce_orders', 'paid_at', 'DATETIME NULL'],
  ['commerce_orders', 'refunded_minor', 'BIGINT NOT NULL DEFAULT 0'],
  ['commerce_orders', 'fulfillment_status', "VARCHAR(32) NOT NULL DEFAULT 'unfulfilled'"],
  ['commerce_orders', 'stock_status', 'VARCHAR(16) NULL'],
  ['commerce_refund_orders', 'payment_mode', 'VARCHAR(16) NULL'],
  ['commerce_refund_orders', 'payment_refund_id', 'BIGINT NULL'],
];
async function migrate(conn) {
  const version = '006_cashier', checksum = crypto.createHash('sha256').update(JSON.stringify(columns)).digest('hex');
  const [old] = await conn.execute('SELECT checksum FROM commerce_migrations WHERE version=?', [version]);
  if (old.length) {
    if (old[0].checksum !== checksum) throw new Error('Commerce cashier migration checksum changed');
    return;
  }
  for (const [table, column, definition] of columns) {
    const [found] = await conn.execute('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [table, column]);
    if (!found.length) await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  await conn.execute('INSERT INTO commerce_migrations(version,checksum) VALUES(?,?)', [version, checksum]);
}
module.exports = { migrate, columns };
