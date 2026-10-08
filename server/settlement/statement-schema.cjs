'use strict';

// Additive statement and external-evidence storage. None of these tables owns
// consumer funds or creates a payment instruction.
const callbackInboxDdl=`CREATE TABLE IF NOT EXISTS commerce_external_callback_inbox (
 id VARCHAR(36) PRIMARY KEY, vendor_id VARCHAR(64) NOT NULL, order_ref VARCHAR(191) NOT NULL,
 event_key CHAR(64) NOT NULL UNIQUE, payload_hash CHAR(64) NOT NULL, payload JSON NOT NULL,
 received_at DATETIME(3) NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
 party_id VARCHAR(64) NULL, consumed_at DATETIME(3) NULL, attempts INT NOT NULL DEFAULT 0,
 last_error VARCHAR(100) NULL, KEY callback_pending(vendor_id,status,received_at)
) ENGINE=InnoDB`;
const ddl = [
callbackInboxDdl,
`CREATE TABLE IF NOT EXISTS commerce_statement_requests (
 actor_id VARCHAR(64) NOT NULL, operation VARCHAR(64) NOT NULL, request_key VARCHAR(128) NOT NULL,
 request_hash CHAR(64) NOT NULL, response JSON NULL, created_at DATETIME(3) NOT NULL,
 PRIMARY KEY(actor_id,operation,request_key)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_external_trade_events (
 id VARCHAR(36) PRIMARY KEY, party_id VARCHAR(64) NOT NULL, context_id VARCHAR(36) NULL,
 channel VARCHAR(48) NOT NULL, environment VARCHAR(16) NOT NULL, merchant_account VARCHAR(128) NOT NULL,
 event_kind VARCHAR(32) NOT NULL, trade_key CHAR(64) NOT NULL UNIQUE, transaction_id VARCHAR(191) NULL,
 original_event_id VARCHAR(36) NULL, amount_minor BIGINT NULL, currency CHAR(3) NULL,
 occurred_at DATETIME(3) NULL, received_at DATETIME(3) NOT NULL, verified_at DATETIME(3) NULL,
 verification_status VARCHAR(24) NOT NULL DEFAULT 'REPORTED', version INT NOT NULL DEFAULT 1,
 accepted_evidence_id VARCHAR(36) NULL, snapshot JSON NOT NULL,
 KEY external_party(party_id,received_at), KEY external_context(context_id,event_kind), KEY external_original(original_event_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_external_trade_aliases (
 alias_key CHAR(64) PRIMARY KEY, event_id VARCHAR(36) NOT NULL, created_at DATETIME(3) NOT NULL,
 KEY event_idx(event_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_external_evidence (
 id VARCHAR(36) PRIMARY KEY, event_id VARCHAR(36) NOT NULL, party_id VARCHAR(64) NOT NULL,
 source_type VARCHAR(32) NOT NULL, source_event_id VARCHAR(191) NULL, payload_hash CHAR(64) NOT NULL,
 evidence_ref VARCHAR(500) NOT NULL, normalized JSON NOT NULL, submitted_by VARCHAR(64) NOT NULL,
 review_status VARCHAR(24) NOT NULL DEFAULT 'PENDING', created_at DATETIME(3) NOT NULL,
 UNIQUE KEY evidence_once(event_id,payload_hash), KEY evidence_party(party_id,review_status)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_external_reviews (
 id VARCHAR(36) PRIMARY KEY, evidence_id VARCHAR(36) NOT NULL, event_id VARCHAR(36) NOT NULL,
 reviewer_id VARCHAR(64) NOT NULL, decision VARCHAR(24) NOT NULL, note VARCHAR(1000) NOT NULL,
 fact_version INT NOT NULL, snapshot JSON NOT NULL, created_at DATETIME(3) NOT NULL,
 UNIQUE KEY review_once(evidence_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_external_trade_allocations (
 id VARCHAR(36) PRIMARY KEY, event_id VARCHAR(36) NOT NULL, context_id VARCHAR(36) NOT NULL,
 purpose VARCHAR(32) NOT NULL, amount_minor BIGINT NOT NULL, currency CHAR(3) NOT NULL,
 request_key CHAR(64) NOT NULL UNIQUE, created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL,
 KEY event_idx(event_id), KEY context_idx(context_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_external_import_batches (
 id VARCHAR(36) PRIMARY KEY, party_id VARCHAR(64) NOT NULL, channel VARCHAR(48) NOT NULL,
 environment VARCHAR(16) NOT NULL, file_hash CHAR(64) NOT NULL, template_version VARCHAR(32) NOT NULL,
 original_name VARCHAR(200) NOT NULL, source_blob LONGBLOB NOT NULL, submitted_by VARCHAR(64) NOT NULL,
 status VARCHAR(24) NOT NULL, results JSON NOT NULL, created_at DATETIME(3) NOT NULL,
 UNIQUE KEY import_once(party_id,channel,environment,file_hash)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_external_coverage_reports (
 id VARCHAR(36) PRIMARY KEY, party_id VARCHAR(64) NOT NULL, currency CHAR(3) NOT NULL,
 period_start DATETIME(3) NOT NULL, period_end DATETIME(3) NOT NULL, fact_types JSON NOT NULL,
 evidence_ref VARCHAR(500) NOT NULL, submitted_by VARCHAR(64) NOT NULL, reviewed_by VARCHAR(64) NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'PENDING', review_note VARCHAR(1000) NULL,
 created_at DATETIME(3) NOT NULL, reviewed_at DATETIME(3) NULL,
 KEY coverage_scope(party_id,currency,period_start,period_end)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_external_obligations (
 id VARCHAR(36) PRIMARY KEY, context_id VARCHAR(36) NOT NULL, party_id VARCHAR(64) NOT NULL,
 creditor_party_id VARCHAR(64) NOT NULL, debtor_party_id VARCHAR(64) NOT NULL, currency CHAR(3) NOT NULL,
 component VARCHAR(48) NOT NULL, agreement_ref VARCHAR(191) NOT NULL, rule_version VARCHAR(64) NOT NULL,
 accrued_minor BIGINT NOT NULL DEFAULT 0, reduced_minor BIGINT NOT NULL DEFAULT 0,
 settled_minor BIGINT NOT NULL DEFAULT 0, return_due_minor BIGINT NOT NULL DEFAULT 0,
 created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
 UNIQUE KEY external_obligation(context_id,component,creditor_party_id,debtor_party_id,agreement_ref),
 KEY debtor_idx(debtor_party_id), KEY creditor_idx(creditor_party_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_external_obligation_events (
 id VARCHAR(36) PRIMARY KEY, obligation_id VARCHAR(36) NOT NULL, party_id VARCHAR(64) NOT NULL,
 event_kind VARCHAR(24) NOT NULL, amount_minor BIGINT NOT NULL, evidence_event_id VARCHAR(36) NULL,
 request_key CHAR(64) NOT NULL UNIQUE, request_hash CHAR(64) NOT NULL, agreement_evidence VARCHAR(500) NOT NULL,
 reason VARCHAR(1000) NOT NULL, submitted_by VARCHAR(64) NOT NULL, reviewed_by VARCHAR(64) NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'PENDING', posted_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL,
 snapshot JSON NOT NULL, KEY obligation_idx(obligation_id,status), KEY evidence_idx(evidence_event_id,status)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_payee_statement_policies (
 id VARCHAR(36) PRIMARY KEY, party_id VARCHAR(64) NOT NULL, currency CHAR(3) NOT NULL,
 scope_json JSON NOT NULL, scope_hash CHAR(64) NOT NULL, billing_day TINYINT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
 next_run_at DATETIME(3) NOT NULL, created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL,
 UNIQUE KEY policy_scope(party_id,currency,scope_hash), KEY due_idx(status,next_run_at)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_payee_statements (
 id VARCHAR(36) PRIMARY KEY, statement_no VARCHAR(64) NOT NULL UNIQUE, party_id VARCHAR(64) NOT NULL,
 currency CHAR(3) NOT NULL, period_start DATETIME(3) NOT NULL, period_end DATETIME(3) NOT NULL,
 as_of DATETIME(3) NOT NULL, scope_json JSON NOT NULL, scope_hash CHAR(64) NOT NULL,
 version INT NOT NULL, source_hash CHAR(64) NOT NULL, publication_status VARCHAR(16) NOT NULL,
 recon_status VARCHAR(16) NOT NULL, coverage_status VARCHAR(16) NOT NULL,
 summary JSON NOT NULL, snapshot JSON NOT NULL, created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL,
 UNIQUE KEY statement_revision(party_id,currency,period_start,period_end,scope_hash,version),
 UNIQUE KEY statement_content(party_id,currency,period_start,period_end,scope_hash,source_hash),
 KEY statements_party(party_id,period_end)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_payee_statement_locks (
 scope_key CHAR(64) PRIMARY KEY, created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_payee_statement_confirmations (
 id VARCHAR(36) PRIMARY KEY, statement_id VARCHAR(36) NOT NULL, actor_id VARCHAR(64) NOT NULL,
 note VARCHAR(1000) NOT NULL, created_at DATETIME(3) NOT NULL, UNIQUE KEY confirmation(statement_id,actor_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_statement_disputes (
 id VARCHAR(36) PRIMARY KEY, statement_id VARCHAR(36) NOT NULL, line_key VARCHAR(191) NULL,
 party_id VARCHAR(64) NOT NULL, reason VARCHAR(1000) NOT NULL, evidence_ref VARCHAR(500) NOT NULL,
 created_by VARCHAR(64) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
 resolution VARCHAR(1000) NULL, resolution_evidence VARCHAR(500) NULL, resolved_by VARCHAR(64) NULL,
 created_at DATETIME(3) NOT NULL, resolved_at DATETIME(3) NULL, KEY statement_idx(statement_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_statement_export_jobs (
 id VARCHAR(36) PRIMARY KEY, statement_id VARCHAR(36) NOT NULL, party_id VARCHAR(64) NOT NULL,
 format VARCHAR(8) NOT NULL, request_key CHAR(64) NOT NULL UNIQUE, created_by VARCHAR(64) NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'QUEUED', attempts INT NOT NULL DEFAULT 0,
 lease_token VARCHAR(36) NULL, lease_until DATETIME(3) NULL, file_blob LONGBLOB NULL,
 file_hash CHAR(64) NULL, filename VARCHAR(200) NULL, content_type VARCHAR(150) NULL,
 error_code VARCHAR(100) NULL, created_at DATETIME(3) NOT NULL, expires_at DATETIME(3) NULL,
 KEY export_queue(status,created_at), KEY export_statement(statement_id)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_statement_access_audit (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, actor_id VARCHAR(64) NOT NULL, party_id VARCHAR(64) NOT NULL,
 statement_id VARCHAR(36) NULL, export_job_id VARCHAR(36) NULL, action VARCHAR(32) NOT NULL,
 result VARCHAR(16) NOT NULL, file_hash CHAR(64) NULL, created_at DATETIME(3) NOT NULL,
 KEY access_party(party_id,created_at)
) ENGINE=InnoDB`,
];

async function migrate(c) {
 for (const sql of ddl) await c.query(sql);
 // 账单日（T+N 账期出账）：NULL = 自然月（缺省），1–28 = 每月该日出账。
 await require('./schema.cjs').column(c,'commerce_payee_statement_policies','billing_day','TINYINT NULL');
}
module.exports = { ddl, migrate, callbackInboxDdl };
