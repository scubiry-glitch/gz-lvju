'use strict';

const crypto = require('node:crypto');

// This module never opens a connection. The caller supplies the isolated or
// deployment connection; importing it cannot migrate a database.
const VERSION = '20261002_unified_cashier_v1';
const TABLES = [
  `CREATE TABLE IF NOT EXISTS payment_orders (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    biz_order_no VARCHAR(32) NOT NULL,
    app_order_id VARCHAR(28) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    payer_ucid VARCHAR(64) NOT NULL,
    payer_user_type VARCHAR(8) NOT NULL,
    merchant_no VARCHAR(64) NOT NULL,
    share_biz_code VARCHAR(64) NOT NULL,
    cashier_type VARCHAR(8) NOT NULL,
    pay_method VARCHAR(50) NULL,
    pay_status VARCHAR(24) NOT NULL,
    gateway_order_status VARCHAR(8) NULL,
    pay_no VARCHAR(64) NULL,
    cashier_url TEXT NULL,
    callback_url VARCHAR(500) NOT NULL,
    cashier_expires_at DATETIME NULL,
    paid_at DATETIME NULL,
    closed_at DATETIME NULL,
    close_reason VARCHAR(32) NULL,
    query_retry_count INT NOT NULL DEFAULT 0,
    next_query_at DATETIME NULL,
    version INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_po_app_order (app_order_id),
    KEY idx_po_biz_order_id (biz_order_no,id),
    KEY idx_po_biz_order_status (biz_order_no,pay_status),
    KEY idx_po_status_retry (pay_status,next_query_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS payment_refunds (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    payment_order_id BIGINT NOT NULL,
    biz_order_no VARCHAR(32) NOT NULL,
    app_order_id VARCHAR(28) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    refund_reason_type VARCHAR(32) NOT NULL,
    trigger_source VARCHAR(32) NOT NULL,
    refund_amount DECIMAL(12,2) NOT NULL,
    payer_ucid VARCHAR(64) NOT NULL,
    merchant_no VARCHAR(64) NOT NULL,
    refund_status VARCHAR(24) NOT NULL,
    refunded_at DATETIME NULL,
    retry_count INT NOT NULL DEFAULT 0,
    next_retry_at DATETIME NULL,
    version INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_pr_app_order (app_order_id),
    UNIQUE KEY uk_pr_idempotency (idempotency_key),
    KEY idx_pr_biz_order (biz_order_no),
    KEY idx_pr_payment (payment_order_id),
    KEY idx_pr_status_retry (refund_status,next_retry_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS payment_gateway_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    payment_order_id BIGINT NULL,
    payment_refund_id BIGINT NULL,
    app_order_id VARCHAR(28) NOT NULL,
    operation_type VARCHAR(24) NOT NULL,
    request_no VARCHAR(64) NOT NULL,
    http_status INT NULL,
    business_code VARCHAR(64) NULL,
    trace_id VARCHAR(128) NULL,
    success_flag TINYINT NOT NULL DEFAULT 0,
    request_json LONGTEXT NULL,
    response_json LONGTEXT NULL,
    error_message VARCHAR(500) NULL,
    started_at DATETIME NOT NULL,
    finished_at DATETIME NULL,
    UNIQUE KEY uk_pgl_request_no (request_no),
    KEY idx_pgl_payment (payment_order_id,operation_type),
    KEY idx_pgl_refund (payment_refund_id,operation_type),
    KEY idx_pgl_app_order (app_order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS payment_notify_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    notify_key VARCHAR(191) NOT NULL,
    notify_type VARCHAR(16) NOT NULL,
    app_order_id VARCHAR(28) NULL,
    order_status VARCHAR(8) NULL,
    payload_json LONGTEXT NOT NULL,
    handle_result VARCHAR(16) NOT NULL,
    handle_message VARCHAR(500) NULL,
    received_at DATETIME NOT NULL,
    handled_at DATETIME NULL,
    UNIQUE KEY uk_pnl_notify_key (notify_key),
    KEY idx_pnl_app_order (app_order_id),
    KEY idx_pnl_received (received_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS payment_order_guards (
    biz_type VARCHAR(16) NOT NULL,
    biz_order_no VARCHAR(32) NOT NULL,
    account_id VARCHAR(64) NOT NULL,
    amount_minor BIGINT NOT NULL,
    payer_ucid VARCHAR(64) NOT NULL,
    payer_user_type VARCHAR(8) NOT NULL,
    merchant_no VARCHAR(64) NOT NULL,
    share_biz_code VARCHAR(64) NOT NULL,
    app_code VARCHAR(64) NOT NULL,
    project_code VARCHAR(64) NOT NULL,
    callback_url VARCHAR(500) NOT NULL,
    title VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    config_version INT NOT NULL DEFAULT 1,
    snapshot JSON NULL,
    lifecycle VARCHAR(16) NOT NULL DEFAULT 'open',
    active_payment_id BIGINT NULL,
    paid_payment_id BIGINT NULL,
    version INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (biz_type,biz_order_no),
    KEY idx_pg_expiry (lifecycle,expires_at),
    KEY idx_pg_paid (paid_payment_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS payment_requests (
    actor_id VARCHAR(64) NOT NULL,
    operation VARCHAR(32) NOT NULL,
    request_key VARCHAR(80) NOT NULL,
    digest CHAR(64) NOT NULL,
    biz_type VARCHAR(16) NOT NULL,
    biz_order_no VARCHAR(32) NOT NULL,
    payment_order_id BIGINT NULL,
    response_json JSON NULL,
    created_at DATETIME NOT NULL,
    PRIMARY KEY (actor_id,operation,request_key),
    KEY idx_preq_biz (biz_type,biz_order_no)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS payment_jobs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    job_key VARCHAR(191) NOT NULL,
    kind VARCHAR(24) NOT NULL,
    target_id BIGINT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    next_run_at DATETIME NOT NULL,
    lease_token VARCHAR(64) NULL,
    lease_until DATETIME NULL,
    last_error VARCHAR(500) NULL,
    payload JSON NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_pjob_key (job_key),
    KEY idx_pjob_run (status,next_run_at),
    KEY idx_pjob_lease (status,lease_until)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS payment_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    event_key VARCHAR(191) NOT NULL,
    biz_type VARCHAR(16) NOT NULL,
    biz_order_no VARCHAR(32) NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    payload JSON NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    next_run_at DATETIME NOT NULL,
    last_error VARCHAR(500) NULL,
    created_at DATETIME NOT NULL,
    processed_at DATETIME NULL,
    UNIQUE KEY uk_pevent_key (event_key),
    KEY idx_pevent_run (biz_type,status,next_run_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

const COLUMNS = [
  ['payment_orders', 'biz_type', "VARCHAR(16) NOT NULL DEFAULT 'booking'"],
  ['payment_orders', 'app_code', 'VARCHAR(64) NULL'],
  ['payment_orders', 'project_code', 'VARCHAR(64) NULL'],
  ['payment_orders', 'amount_minor', 'BIGINT NULL'],
  ['payment_orders', 'expires_at', 'DATETIME NULL'],
  ['payment_orders', 'title', 'VARCHAR(255) NULL'],
  ['payment_orders', 'client_ip', 'VARCHAR(64) NULL'],
  ['payment_refunds', 'biz_type', "VARCHAR(16) NOT NULL DEFAULT 'booking'"],
  ['payment_refunds', 'amount_minor', 'BIGINT NULL'],
  ['payment_refunds', 'reference_json', 'JSON NULL'],
  ['payment_notify_log', 'attempts', 'INT NOT NULL DEFAULT 0'],
  ['payment_notify_log', 'next_retry_at', 'DATETIME NULL'],
  ['payment_notify_log', 'last_error', 'VARCHAR(500) NULL'],
];

const INDEXES = [
  ['payment_orders', 'idx_po_biz_id', '(biz_type,biz_order_no,id)'],
  ['payment_orders', 'idx_po_biz_status', '(biz_type,biz_order_no,pay_status)'],
  ['payment_refunds', 'idx_pr_biz_type_order', '(biz_type,biz_order_no)'],
];

const BUSINESS_COLUMNS = [
  ['jz_vendors', 'payment_mode', 'VARCHAR(16) NULL'],
  ['jz_vendors', 'payment_config_version', 'INT NOT NULL DEFAULT 0'],
  ['jz_vendors', 'payment_config_json', 'TEXT NULL'],
  ['jz_orders', 'account_id', 'VARCHAR(64) NULL'],
  ['jz_orders', 'product_id', 'INT NULL'],
  ['jz_orders', 'vendor_id', 'INT NULL'],
  ['jz_orders', 'city_id', 'INT NULL'],
  ['jz_orders', 'payment_mode', 'VARCHAR(16) NULL'],
  ['jz_orders', 'payment_config_version', 'INT NULL'],
  ['jz_orders', 'payment_config_snapshot', 'TEXT NULL'],
  ['jz_orders', 'request_key', 'VARCHAR(100) NULL'],
  ['jz_orders', 'request_hash', 'CHAR(64) NULL'],
  ['jz_orders', 'expires_at', 'DATETIME NULL'],
  ['jz_orders', 'slot_reserved', 'TINYINT NOT NULL DEFAULT 0'],
  ['jz_orders', 'refund_status', 'VARCHAR(30) NULL'],
  ['gr_orders', 'biz_type', 'VARCHAR(16) NULL'],
  ['gr_orders', 'payment_mode', 'VARCHAR(16) NULL'],
  ['gr_orders', 'account_id', 'VARCHAR(64) NULL'],
  ['gr_orders', 'pay_status', 'VARCHAR(30) NULL'],
  ['gr_orders', 'refund_status', 'VARCHAR(30) NULL'],
  ['gr_orders', 'order_snapshot', 'TEXT NULL'],
  ['gr_orders', 'request_key', 'VARCHAR(100) NULL'],
  ['gr_orders', 'request_hash', 'CHAR(64) NULL'],
  ['booking_orders', 'request_hash', 'CHAR(64) NULL'],
];
const BUSINESS_INDEXES = [
  ['jz_orders', 'uk_jzo_account_request', '(account_id,request_key)'],
  ['gr_orders', 'uk_gro_user_request', '(user_id,request_key)'],
];

const CHECKSUM = crypto.createHash('sha256').update(JSON.stringify({ TABLES, COLUMNS, INDEXES, BUSINESS_COLUMNS, BUSINESS_INDEXES })).digest('hex');

// The original booking tables did not store app/project codes. Preserve their
// original create-request evidence before the core fills unknown fields from
// deployment defaults. This is a separate data migration: v1's checksum stays
// valid for installations which have already applied it.
const LEGACY_SNAPSHOT_VERSION = '20261002_booking_legacy_snapshot_v2';
const LEGACY_SNAPSHOT_SQL = `UPDATE payment_orders p
  JOIN (
    SELECT l.payment_order_id,MIN(l.id) AS log_id
    FROM payment_gateway_logs l JOIN payment_orders original ON original.id=l.payment_order_id
    WHERE original.biz_type='booking' AND l.operation_type='pay_create'
      AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(l.request_json),l.request_json,'{}'),'$.appOrderId'))=original.app_order_id
      AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(l.request_json),l.request_json,'{}'),'$.appCode')) REGEXP '^[A-Za-z0-9_.:-]{1,64}$'
      AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(l.request_json),l.request_json,'{}'),'$.projectCode')) REGEXP '^[A-Za-z0-9_.:-]{1,64}$'
    GROUP BY l.payment_order_id
  ) evidence ON evidence.payment_order_id=p.id
  JOIN payment_gateway_logs l ON l.id=evidence.log_id
  SET p.app_code=COALESCE(p.app_code,JSON_UNQUOTE(JSON_EXTRACT(l.request_json,'$.appCode'))),
      p.project_code=COALESCE(p.project_code,JSON_UNQUOTE(JSON_EXTRACT(l.request_json,'$.projectCode')))
  WHERE p.app_code IS NULL OR p.project_code IS NULL`;

async function migrateLegacySnapshots(conn) {
  const checksum = crypto.createHash('sha256').update(LEGACY_SNAPSHOT_SQL).digest('hex');
  const [applied] = await conn.execute('SELECT checksum FROM payment_migrations WHERE version=?', [LEGACY_SNAPSHOT_VERSION]);
  if (applied.length) {
    if (applied[0].checksum !== checksum) throw new Error('Booking snapshot migration checksum changed; add a new version');
    return;
  }
  await conn.query(LEGACY_SNAPSHOT_SQL);
  await conn.execute('INSERT INTO payment_migrations(version,checksum) VALUES(?,?)', [LEGACY_SNAPSHOT_VERSION, checksum]);
}

async function addColumn(conn, table, column, definition) {
  const [rows] = await conn.execute(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    [table, column],
  );
  if (!rows.length) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

async function migrateBusinessTables(conn) {
  const [tables] = await conn.query(`SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('jz_vendors','jz_orders','gr_orders','booking_orders','jz_products','commerce_orders')`);
  const present = new Set(tables.map((row) => row.TABLE_NAME));
  for (const [table, column, definition] of BUSINESS_COLUMNS) {
    if (present.has(table)) await addColumn(conn, table, column, definition);
  }
  for (const [table, index, fields] of BUSINESS_INDEXES) {
    if (!present.has(table)) continue;
    const [rows] = await conn.execute('SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?', [table, index]);
    if (!rows.length) await conn.query(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${index}\` ${fields}`);
  }
  const businessVersion = VERSION + '_business';
  const [done] = await conn.execute('SELECT version FROM payment_migrations WHERE version=?', [businessVersion]);
  if (!done.length && ['jz_vendors', 'jz_products', 'gr_orders'].every((table) => present.has(table))) {
    const [linkColumns] = await conn.execute('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', ['jz_vendors', 'url_link']);
    if (linkColumns.length) {
      // Existing external channels remain external even if their HMAC settings
      // need repair. Configuration changes after this migration are not inferred.
      await conn.query("UPDATE jz_vendors SET payment_mode='wechat_mini' WHERE payment_mode IS NULL AND url_link IS NOT NULL AND TRIM(url_link)<>''");
    }
    await conn.query(`UPDATE gr_orders g JOIN jz_products p ON g.sku REGEXP '^[0-9]+$'
      AND p.id=CAST(g.sku AS UNSIGNED) AND p.vendor_id=g.vendor_id
      SET g.biz_type='jiazheng',g.payment_mode='wechat_mini'
      WHERE g.payment_mode IS NULL AND (g.biz_type IS NULL OR g.biz_type='jiazheng')
      AND g.vendor_id IS NOT NULL${present.has('commerce_orders') ? ' AND NOT EXISTS (SELECT 1 FROM commerce_orders co WHERE co.id=g.order_ref)' : ''}`);
    await conn.execute('INSERT INTO payment_migrations(version,checksum) VALUES(?,?)', [businessVersion, CHECKSUM]);
  }
}

async function migrate(conn) {
  const [[db]] = await conn.query('SELECT DATABASE() AS name');
  if (!db || !db.name) throw new Error('Payment migration requires an explicitly selected database');
  const lockName = 'payment_migrate_' + crypto.createHash('sha256').update(db.name).digest('hex').slice(0, 32);
  const [[lock]] = await conn.execute('SELECT GET_LOCK(?,30) AS acquired', [lockName]);
  if (!lock || Number(lock.acquired) !== 1) throw new Error('Payment migration lock unavailable');
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS payment_migrations (
      version VARCHAR(64) PRIMARY KEY, checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const [applied] = await conn.execute('SELECT checksum FROM payment_migrations WHERE version=?', [VERSION]);
    if (applied.length) {
      if (applied[0].checksum !== CHECKSUM) throw new Error('Payment migration checksum changed; add a new version');
      await migrateBusinessTables(conn);
      await migrateLegacySnapshots(conn);
      return { version: VERSION, applied: false };
    }
    // DDL commits implicitly in MySQL: each step must survive a partial run.
    for (const sql of TABLES) await conn.query(sql);
    for (const [table, column, definition] of COLUMNS) await addColumn(conn, table, column, definition);
    for (const [table, index, fields] of INDEXES) {
      const [rows] = await conn.execute(
        'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?',
        [table, index],
      );
      if (!rows.length) await conn.query(`ALTER TABLE \`${table}\` ADD KEY \`${index}\` ${fields}`);
    }
    // Do not alter the historic order-number width or infer unknown merchants.
    const [widths] = await conn.execute(`SELECT TABLE_NAME,CHARACTER_MAXIMUM_LENGTH AS width
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
      AND TABLE_NAME IN ('payment_orders','payment_refunds','payment_order_guards') AND COLUMN_NAME='biz_order_no'`);
    if (widths.some((row) => Number(row.width) !== 32)) throw new Error('Payment biz_order_no must remain VARCHAR(32)');
    await conn.query('UPDATE payment_orders SET amount_minor=ROUND(amount*100) WHERE amount_minor IS NULL');
    await conn.query('UPDATE payment_refunds SET amount_minor=ROUND(refund_amount*100) WHERE amount_minor IS NULL');
    await migrateBusinessTables(conn);
    await migrateLegacySnapshots(conn);
    await conn.execute('INSERT INTO payment_migrations(version,checksum) VALUES(?,?)', [VERSION, CHECKSUM]);
    return { version: VERSION, applied: true };
  } finally {
    await conn.execute('SELECT RELEASE_LOCK(?)', [lockName]);
  }
}

module.exports = { migrate, VERSION, TABLES, COLUMNS, INDEXES, BUSINESS_COLUMNS, BUSINESS_INDEXES, CHECKSUM, addColumn };
