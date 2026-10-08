'use strict';
const ddl = [
`CREATE TABLE IF NOT EXISTS commerce_execution_plans (
 id VARCHAR(36) PRIMARY KEY, request_key VARCHAR(128) NOT NULL, request_hash CHAR(64) NOT NULL,
 created_by VARCHAR(64) NOT NULL, status VARCHAR(32) NOT NULL, snapshot JSON NOT NULL,
 created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
 UNIQUE KEY uk_plan_request(created_by,request_key)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_execution_orders (
 id VARCHAR(36) PRIMARY KEY, plan_id VARCHAR(36) NOT NULL, context_id VARCHAR(36) NOT NULL,
 source_id VARCHAR(36) NOT NULL, operation VARCHAR(24) NOT NULL, provider VARCHAR(64) NOT NULL,
 environment VARCHAR(24) NOT NULL, mapping_version VARCHAR(64) NULL, contract_hash CHAR(64) NULL,
 request_no VARCHAR(48) NOT NULL, amount_minor BIGINT NOT NULL, status VARCHAR(32) NOT NULL,
 canonical_request JSON NOT NULL, request_payload JSON NULL, query_payload JSON NULL, payload_hash CHAR(64) NULL,
 created_by VARCHAR(64) NOT NULL, approved_by VARCHAR(64) NULL, provider_order_no VARCHAR(128) NULL,
 submitted_at DATETIME(3) NULL, completed_at DATETIME(3) NULL, last_error VARCHAR(255) NULL,
 created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
 UNIQUE KEY uk_provider_request(provider,environment,operation,request_no), KEY plan_idx(plan_id), KEY source_idx(source_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_execution_lines (
 id VARCHAR(36) PRIMARY KEY, order_id VARCHAR(36) NOT NULL, item_id BIGINT NULL,
 source_id VARCHAR(36) NOT NULL, context_id VARCHAR(36) NOT NULL, unit_id VARCHAR(64) NULL,
 account_id VARCHAR(36) NOT NULL, effect_kind VARCHAR(32) NOT NULL, amount_minor BIGINT NOT NULL,
 authorization_id VARCHAR(36) NULL, authorization_hash CHAR(64) NULL, item_revision INT NULL,
 original_line_id VARCHAR(36) NULL, status VARCHAR(32) NOT NULL, provider_line_id VARCHAR(128) NULL,
 snapshot JSON NOT NULL, returned_minor BIGINT NOT NULL DEFAULT 0, return_reserved_minor BIGINT NOT NULL DEFAULT 0,
 bank_returned_minor BIGINT NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
 KEY order_idx(order_id), KEY item_idx(item_id), KEY original_idx(original_line_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_execution_allocations (
 line_id VARCHAR(36) PRIMARY KEY, item_id BIGINT NULL, source_id VARCHAR(36) NOT NULL,
 reserved_minor BIGINT NOT NULL DEFAULT 0, transferred_minor BIGINT NOT NULL DEFAULT 0,
 merchant_released_minor BIGINT NOT NULL DEFAULT 0, reservation_released_minor BIGINT NOT NULL DEFAULT 0,
 returned_minor BIGINT NOT NULL DEFAULT 0, status VARCHAR(24) NOT NULL,
 KEY item_idx(item_id), KEY source_idx(source_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_execution_jobs (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id VARCHAR(36) NOT NULL, status VARCHAR(24) NOT NULL,
 next_run_at DATETIME(3) NOT NULL, lease_token VARCHAR(36) NULL, lease_until DATETIME(3) NULL,
 attempts INT NOT NULL DEFAULT 0, last_error VARCHAR(255) NULL, created_at DATETIME(3) NOT NULL,
 UNIQUE KEY uk_job_order(order_id), KEY due_idx(status,next_run_at,lease_until)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_execution_receipts (
 id VARCHAR(36) PRIMARY KEY, order_id VARCHAR(36) NOT NULL, source VARCHAR(24) NOT NULL,
 digest CHAR(64) NOT NULL, raw_payload JSON NOT NULL, normalized JSON NULL,
 created_at DATETIME(3) NOT NULL, UNIQUE KEY uk_receipt(order_id,digest)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_execution_events (
 event_key VARCHAR(160) PRIMARY KEY, order_id VARCHAR(36) NOT NULL, line_id VARCHAR(36) NULL,
 kind VARCHAR(32) NOT NULL, amount_minor BIGINT NOT NULL, evidence JSON NOT NULL, created_at DATETIME(3) NOT NULL,
 KEY order_idx(order_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_commission_funding_lots (
 id VARCHAR(36) PRIMARY KEY, source_execution_line_id VARCHAR(36) NOT NULL, source_id VARCHAR(36) NOT NULL,
 context_id VARCHAR(36) NOT NULL, unit_id VARCHAR(64) NULL, received_minor BIGINT NOT NULL,
 status VARCHAR(24) NOT NULL, created_at DATETIME(3) NOT NULL,
 UNIQUE KEY uk_lot_line(source_execution_line_id), UNIQUE KEY uk_lot_source(source_id), KEY unit_idx(context_id,unit_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_execution_refund_plans (
 order_id VARCHAR(36) PRIMARY KEY, amount_minor BIGINT NOT NULL, payment_refund_id VARCHAR(64) NULL,
 dependencies JSON NOT NULL, request_key VARCHAR(128) NOT NULL, refund_input JSON NOT NULL,
 source_reserved TINYINT NOT NULL DEFAULT 0, UNIQUE KEY uk_payment_refund(payment_refund_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_execution_returned (
 id VARCHAR(36) PRIMARY KEY, line_id VARCHAR(36) NOT NULL, evidence_key VARCHAR(160) NOT NULL,
 amount_minor BIGINT NOT NULL, evidence JSON NOT NULL, created_by VARCHAR(64) NOT NULL,
 status VARCHAR(24) NOT NULL, approved_by VARCHAR(64) NULL, repayment_item_id BIGINT NULL, created_at DATETIME(3) NOT NULL,
 UNIQUE KEY uk_returned_evidence(evidence_key), KEY line_idx(line_id)
) ENGINE=InnoDB`,
];
async function migrate(c) {
 for (const sql of ddl) await c.query(sql);
 const [[column]]=await c.execute("SELECT 1 ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='commerce_funding_sources' AND COLUMN_NAME='external_refunded_minor'");
 if(!column)await c.query('ALTER TABLE commerce_funding_sources ADD COLUMN external_refunded_minor BIGINT NOT NULL DEFAULT 0');
 const [[repayment]]=await c.execute("SELECT 1 ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='commerce_execution_returned' AND COLUMN_NAME='repayment_item_id'");
 if(!repayment)await c.query('ALTER TABLE commerce_execution_returned ADD COLUMN repayment_item_id BIGINT NULL');
}
module.exports = { ddl, migrate };
