'use strict';
/**
 * server/job/cmd_split.cjs
 * ---------------------------------------------------------------------------
 * 测试/运维用命令接口（所有路由以 /cmd/ 开头），用于在每日定时任务之外，
 * 单独对某条 booking_orders 触发分账，便于联调与补救。
 *
 * 接入：app.js 主分发器对 rawPath.startsWith('/cmd') 调用 createCmdRouter(...) 返回的处理器。
 * 鉴权：CMD_API_TOKEN（建议仅测试/运维环境配置；缺失则禁用全部 /cmd 请求，返回 401）。
 *       请求头带 x-cmd-token 或 Authorization: Bearer <token>。
 *
 * 路由：
 *   POST /cmd/split/by-order   body: { order_no }  —— 按 order_no 触发单笔分账
 *   POST /cmd/split/query      body: { order_type?, order_no?|biz_code?|fee_type?, biz_order_no?, order_no_gateway?, env? }
 *                                     —— 查询分账结果 / 分账回退结果（分账中台 querySplitResult）
 *   POST /cmd/ddl              body: { sql } 或 { file }, 可选 dry_run / max
 *                                     —— 执行 DDL（补表注释/字段注释用），仅放行 ALTER/CREATE 等，
 *                                        禁止 DROP TABLE、TRUNCATE、DML 等破坏性语句
 *   POST /cmd/dml              body: { sql } 或 { file }, 可选 dry_run / allow_full_table / max / max_affected
 *                                     —— 执行 DML（数据修正用），仅放行 INSERT/UPDATE/DELETE/REPLACE，
 *                                        整批事务执行、失败自动回滚；不带 WHERE 的 UPDATE/DELETE 默认拒绝
 *   POST /cmd/query            body: { sql }, 可选 max_rows / timeout_ms
 *                                     —— 执行只读查询（SELECT/SHOW/DESC/EXPLAIN）；无 LIMIT 的 SELECT
 *                                        自动补 LIMIT max_rows，避免一次性拉全表
 * ---------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const { jsonReply, createReadBody } = require(path.join(__dirname, '..', 'http_util.cjs'));
const { triggerSplitForOrder } = require(path.join(__dirname, 'book_order_split_job.cjs'));
const { createPayCenter } = require(path.join(__dirname, '..', 'thirdApi', 'payCenter.cjs'));
const { queryRows, getPool, getMysql, getDbConfig } = require(path.join(__dirname, '..', 'db.cjs'));

const readBody = createReadBody();

// ─────────────────────────── DDL 执行（/cmd/ddl）辅助 ───────────────────────────

// 允许执行的 DDL 语句首关键字
const DDL_ALLOW_RE = /^(ALTER|CREATE|RENAME|COMMENT|DROP\s+INDEX)\b/i;
// 命中即拒绝的高危语句（即使被包在允许的首关键字里也拦截）
const DDL_BLOCK_RE = /\b(TRUNCATE|GRANT|REVOKE|LOAD\s+DATA|CALL)\b|\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW|TRIGGER|PROCEDURE|FUNCTION|USER)\b|\bCREATE\s+(USER|DATABASE|SCHEMA)\b|\bINTO\s+(OUTFILE|DUMPFILE)\b/i;

// 注释 SQL 文件目录：server/sqlbak
const DDL_DIR = path.join(__dirname, '..', 'sqlbak');

/** 去掉 -- 行注释、# 注释、/* *\/ 块注释，保留字符串字面量内容 */
function stripSqlComments(sql) {
  let out = '';
  let quote = null;
  const n = sql.length;
  for (let i = 0; i < n; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < n) { out += sql[i + 1]; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (ch === '#') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 按分号拆句（忽略字符串内的分号） */
function splitStatements(sql) {
  const list = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < sql.length) { cur += sql[i + 1]; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === ';') { if (cur.trim()) list.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) list.push(cur.trim());
  return list;
}

/** 遮掉字符串字面量的内容（保留引号），避免把值里的关键字当成语句关键字 */
function maskStrings(sql) {
  let out = '';
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === '\\' && i + 1 < sql.length) { i++; continue; }
      if (ch === quote) { quote = null; out += ch; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    out += ch;
  }
  return out;
}

/** 校验单条语句；返回 null 表示通过，否则返回拒绝原因 */
function checkDdl(stmt) {
  if (!DDL_ALLOW_RE.test(stmt)) {
    return '仅允许 ALTER / CREATE / RENAME / COMMENT / DROP INDEX 开头的 DDL';
  }
  if (DDL_BLOCK_RE.test(maskStrings(stmt))) {
    return '语句包含高危操作（DROP TABLE / TRUNCATE / DML / 授权等），已拒绝';
  }
  return null;
}

/** 解析 sqlbak 下的文件名，禁止路径穿越 */
function resolveDdlFile(name) {
  const base = String(name || '').trim();
  if (!base) return { error: 'file 为空' };
  if (base.includes('/') || base.includes('\\') || base.includes('..')) {
    return { error: 'file 只允许 server/sqlbak 下的文件名，不允许路径' };
  }
  if (!/\.sql$/i.test(base)) return { error: 'file 必须以 .sql 结尾' };
  const full = path.join(DDL_DIR, base);
  if (path.dirname(full) !== DDL_DIR) return { error: 'file 路径非法' };
  if (!fs.existsSync(full)) return { error: '文件不存在：' + base };
  return { full, base };
}

// ─────────────────────────── DML 执行（/cmd/dml）辅助 ───────────────────────────

// 允许执行的 DML 语句首关键字
const DML_ALLOW_RE = /^(INSERT|UPDATE|DELETE|REPLACE)\b/i;
// 命中即拒绝：DDL、授权、文件导出等（DDL 走 /cmd/ddl）
const DML_BLOCK_RE = /\b(TRUNCATE|GRANT|REVOKE|LOAD\s+DATA|CALL)\b|\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW|TRIGGER|PROCEDURE|FUNCTION|USER|INDEX)\b|\bALTER\s+TABLE\b|\bCREATE\s+(TABLE|DATABASE|SCHEMA|USER|INDEX)\b|\bRENAME\s+TABLE\b|\bINTO\s+(OUTFILE|DUMPFILE)\b/i;

/**
 * 校验单条 DML；返回 null 表示通过。
 * 默认禁止不带 WHERE 的 UPDATE / DELETE，避免误伤全表；确需全表时显式传 allow_full_table。
 */
function checkDml(stmt, opts = {}) {
  if (!DML_ALLOW_RE.test(stmt)) {
    return '仅允许 INSERT / UPDATE / DELETE / REPLACE 开头的 DML';
  }
  // 用遮罩后的语句判断关键字，避免 SET note='DELETE' / 'WHERE' 这类值绕过校验
  const masked = maskStrings(stmt);
  if (DML_BLOCK_RE.test(masked)) {
    return '语句包含 DDL 或高危操作，已拒绝（DDL 请改用 /cmd/ddl）';
  }
  const isUpdate = /^UPDATE\b/i.test(stmt);
  const isDelete = /^DELETE\b/i.test(stmt);
  if ((isUpdate || isDelete) && !/\bWHERE\b/i.test(masked) && !opts.allowFullTable) {
    return `不带 WHERE 的 ${isUpdate ? 'UPDATE' : 'DELETE'} 默认禁止；确需全表操作请显式传 allow_full_table=true`;
  }
  return null;
}

// ─────────────────────────── 只读查询（/cmd/query）辅助 ───────────────────────────

// 允许执行的只读语句首关键字
const QUERY_ALLOW_RE = /^(SELECT|WITH|SHOW|DESC|DESCRIBE|EXPLAIN)\b/i;
// 命中即拒绝：任何写操作与文件导出
const QUERY_BLOCK_RE = /\b(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|GRANT|REVOKE|LOAD\s+DATA|CALL)\b|\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW|TRIGGER|PROCEDURE|FUNCTION|USER|INDEX)\b|\bALTER\s+TABLE\b|\bCREATE\s+(TABLE|DATABASE|SCHEMA|USER|INDEX)\b|\bRENAME\s+TABLE\b|\bINTO\s+(OUTFILE|DUMPFILE)\b/i;

/** 校验单条只读语句；返回 null 表示通过 */
function checkQuery(stmt) {
  if (!QUERY_ALLOW_RE.test(stmt)) {
    return '仅允许 SELECT / WITH / SHOW / DESC / EXPLAIN 开头的只读语句';
  }
  if (QUERY_BLOCK_RE.test(maskStrings(stmt))) {
    return '语句包含写操作或高危操作，已拒绝（写入请用 /cmd/dml，DDL 请用 /cmd/ddl）';
  }
  return null;
}

function createCmdRouter(deps = {}) {
  const cmdToken = deps.cmdToken != null ? deps.cmdToken : process.env.CMD_API_TOKEN;
  return async function handleCmdRoutes(urlPath, qs, req, res) {
    const p = String(urlPath || '').replace(/\/+$/, '') || '/';

    // 鉴权：未配置 token 或校验不通过 → 401
    if (!cmdToken) {
      return jsonReply(res, { error: 'unauthorized', message: '未配置 CMD_API_TOKEN，/cmd 接口已禁用' }, 401);
    }
    const provided = (req.headers && (req.headers['x-cmd-token'] || req.headers['authorization'] || '')) || '';
    const got = provided.replace(/^Bearer\s+/i, '').trim();
    if (got !== cmdToken) {
      return jsonReply(res, { error: 'unauthorized', message: 'CMD token 校验失败' }, 401);
    }

    // POST /cmd/split/by-order —— 按 order_no 触发单笔分账
    if (p === '/cmd/split/by-order' && req.method === 'POST') {
      const body = await readBody(req);
      const orderNo = body && (body.order_no || body.orderNo);
      if (!orderNo || typeof orderNo !== 'string') {
        return jsonReply(res, { error: 'invalid_param', message: 'order_no 必填' }, 400);
      }
      const r = await triggerSplitForOrder(orderNo);
      const code = r.ok ? 200 : (r.code === 'not_found' ? 404 : 400);
      return jsonReply(res, r, code);
    }

    // POST /cmd/split/query —— 查询分账结果 / 分账回退结果（调用 payCenter.querySplitResult）
    // body:
    //   order_type:    'DIRECT_SPLIT'(默认=分账) | 'SPLIT_RETURN'(=分账回退/追回)
    //   order_no:      旅居业务订单号（biz_order_no）—— 可据此从 payment_split 反查 biz_code 与中台单号
    //   biz_code:      分账标准业务码 必传；传 order_no 时若本地无记录则需显式给）
    //   biz_order_no:  中台分账业务单号（= 发起分账时的 FZ 号 = payment_split.app_order_id）
    //   order_no_gateway: 中台分账单号（= payment_split.split_order_no；回调 orderNo）
    //   env:          可选 test|prod，指定查询环境（默认随进程 JUZHU_ENV）
    if (p === '/cmd/split/query' && req.method === 'POST') {
      const body = await readBody(req);
      const orderType = String(body.order_type || body.orderType || 'DIRECT_SPLIT');
      if (!['DIRECT_SPLIT', 'SPLIT_RETURN'].includes(orderType)) {
        return jsonReply(res, { error: 'invalid_param', message: 'order_type 须为 DIRECT_SPLIT 或 SPLIT_RETURN' }, 400);
      }
      let bizCode = body.biz_code || body.bizCode;
      //业务单号（与分账单号二选一必传）
      let bizOrderNo = body.biz_order_no || body.bizOrderNo;
      //分账单号（与业务单号二选一必传）
      let orderNo = body.order_no_gateway || body.orderNoGateway  ;
      let local = null;
      // 给了旅居业务订单号 → 从 payment_split 反查 biz_code / 中台单号 / 本地状态
      if (body.order_no) {
        const rows = await queryRows(
          `SELECT biz_code, app_order_id, split_order_no, split_status, gateway_order_status
             FROM payment_split WHERE biz_order_no = ? ORDER BY id DESC LIMIT 1`,
          [String(body.order_no)],
        );
        if (rows && rows.length) {
          const r = rows[0];
          local = {
            biz_code: r.biz_code, biz_order_no: r.app_order_id, order_no_gateway: r.split_order_no,
            split_status: r.split_status, gateway_order_status: r.gateway_order_status,
          };
          bizCode = bizCode || r.biz_code;
          bizOrderNo = bizOrderNo || r.app_order_id;
          orderNo = orderNo || r.split_order_no;
        }
      }
      if (!bizCode  ) {
        return jsonReply(res, { error: 'invalid_param', message: '无法解析 biz_code （传有效的 order_no 反查 biz_code）' }, 400);
      }
      if (!bizOrderNo && !orderNo) {
        return jsonReply(res, { error: 'invalid_param', message: '需提供 biz_order_no 或 order_no_gateway（或有效的 order_no）' }, 400);
      }
      const params = { orderType };
      if (bizCode) params.bizCode = bizCode;
      if (bizOrderNo) params.bizOrderNo = bizOrderNo;
      if (orderNo) params.orderNo = orderNo;
      try {
        const pc = createPayCenter(body.env);
        const gateway = await pc.querySplitResult(params);
        return jsonReply(res, { order_type: orderType, biz_code: bizCode,   biz_order_no: bizOrderNo, order_no_gateway: orderNo, local, gateway }, 200);
      } catch (e) {
        return jsonReply(res, {
          error: 'query_failed',
          message: e && e.message,
          http_status: e && e.httpStatus,
          trace_id: e && e.traceId,
          gateway_response: e && e.responseText,
        }, 502);
      }
    }

    // POST /cmd/ddl —— 执行 DDL（补表注释 / 字段注释等），仅放行 ALTER/CREATE 等安全语句
    // body:
    //   sql:     'ALTER TABLE t COMMENT = ...; ALTER TABLE t MODIFY COLUMN ...'  与 file 二选一
    //   file:    'booking_orders.sql'   执行 server/sqlbak 下的文件（禁止路径穿越）
    //   dry_run: true                   只校验并拆句，不真正执行
    //   max:     单次最多执行语句数，默认 500，上限 2000
    if (p === '/cmd/ddl' && req.method === 'POST') {
      if (String(process.env.CMD_DDL_DISABLED || '') === '1') {
        return jsonReply(res, { error: 'disabled', message: 'CMD_DDL_DISABLED=1，DDL 接口已关闭' }, 403);
      }
      const body = await readBody(req);
      const dryRun = body.dry_run === true || body.dryRun === true;
      const max = Math.max(1, Math.min(2000, parseInt(body.max, 10) || 500));

      let raw = '';
      let source = 'inline';
      let fileName = null;

      if (body.file) {
        const r = resolveDdlFile(body.file);
        if (r.error) return jsonReply(res, { error: 'invalid_param', message: r.error }, 400);
        source = 'file';
        fileName = r.base;
        try { raw = fs.readFileSync(r.full, 'utf8'); }
        catch (e) { return jsonReply(res, { error: 'read_failed', message: e.message }, 400); }
      } else if (typeof body.sql === 'string' && body.sql.trim()) {
        raw = body.sql;
      } else {
        return jsonReply(res, { error: 'invalid_param', message: 'sql 或 file 至少提供一个' }, 400);
      }

      const statements = splitStatements(stripSqlComments(raw));
      if (!statements.length) {
        return jsonReply(res, { error: 'invalid_param', message: '没有可执行的语句（可能全是注释）' }, 400);
      }
      if (statements.length > max) {
        return jsonReply(res, { error: 'too_many', message: `语句数 ${statements.length} 超过上限 ${max}，可调大 max` }, 400);
      }
      // 先整批校验：任一条不合规则整批拒绝，避免执行到一半才发现危险语句
      for (let i = 0; i < statements.length; i++) {
        const bad = checkDdl(statements[i]);
        if (bad) {
          return jsonReply(res, {
            error: 'statement_rejected',
            message: `第 ${i + 1} 条语句被拒绝：${bad}`,
            index: i + 1,
            statement: statements[i].slice(0, 500),
          }, 400);
        }
      }

      if (dryRun) {
        return jsonReply(res, {
          ok: true, source, file: fileName, dry_run: true,
          total: statements.length, executed: 0,
          statements: statements.map((s, i) => ({ index: i + 1, sql: s.slice(0, 500) })),
        }, 200);
      }

      const pool = getPool();
      const results = [];
      let executed = 0;
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        try {
          const [result] = await pool.query(stmt);
          executed++;
          results.push({
            index: i + 1,
            ok: true,
            sql: stmt.slice(0, 200),
            affected_rows: result && result.affectedRows != null ? result.affectedRows : null,
            warnings: result && result.warningStatus != null ? result.warningStatus : null,
          });
        } catch (e) {
          return jsonReply(res, {
            ok: false,
            error: 'ddl_failed',
            message: e && e.message,
            code: e && (e.code || e.errno),
            source, file: fileName,
            total: statements.length,
            executed,
            failed_index: i + 1,
            failed_statement: stmt.slice(0, 500),
            results,
          }, 400);
        }
      }
      return jsonReply(res, {
        ok: true, source, file: fileName, dry_run: false,
        total: statements.length, executed, results,
      }, 200);
    }

    // POST /cmd/dml —— 执行 DML（数据修正 / 补数据），整批事务，失败自动回滚
    // body:
    //   sql:              'UPDATE t SET a=1 WHERE id=2;'  与 file 二选一
    //   file:             'fix_xxx.sql'                   执行 server/sqlbak 下的文件
    //   dry_run:          true                            只校验并拆句，不执行
    //   allow_full_table: true                            允许不带 WHERE 的 UPDATE/DELETE（默认拒绝）
    //   max:              单次最多语句数，默认 500，上限 2000
    //   max_affected:     可选；累计影响行数超过该值时整批回滚
    if (p === '/cmd/dml' && req.method === 'POST') {
      if (String(process.env.CMD_DML_DISABLED || '') === '1') {
        return jsonReply(res, { error: 'disabled', message: 'CMD_DML_DISABLED=1，DML 接口已关闭' }, 403);
      }
      const body = await readBody(req);
      const dryRun = body.dry_run === true || body.dryRun === true;
      const allowFullTable = body.allow_full_table === true || body.allowFullTable === true;
      const max = Math.max(1, Math.min(2000, parseInt(body.max, 10) || 500));
      const maxAffectedRaw = body.max_affected != null ? body.max_affected : body.maxAffected;
      const maxAffected = maxAffectedRaw != null ? Math.max(0, parseInt(maxAffectedRaw, 10) || 0) : null;

      let raw = '';
      let source = 'inline';
      let fileName = null;

      if (body.file) {
        const r = resolveDdlFile(body.file);
        if (r.error) return jsonReply(res, { error: 'invalid_param', message: r.error }, 400);
        source = 'file';
        fileName = r.base;
        try { raw = fs.readFileSync(r.full, 'utf8'); }
        catch (e) { return jsonReply(res, { error: 'read_failed', message: e.message }, 400); }
      } else if (typeof body.sql === 'string' && body.sql.trim()) {
        raw = body.sql;
      } else {
        return jsonReply(res, { error: 'invalid_param', message: 'sql 或 file 至少提供一个' }, 400);
      }

      const statements = splitStatements(stripSqlComments(raw));
      if (!statements.length) {
        return jsonReply(res, { error: 'invalid_param', message: '没有可执行的语句（可能全是注释）' }, 400);
      }
      if (statements.length > max) {
        return jsonReply(res, { error: 'too_many', message: `语句数 ${statements.length} 超过上限 ${max}，可调大 max` }, 400);
      }
      // 先整批校验，任一条不合法则整批拒绝，避免执行到一半才发现问题
      for (let i = 0; i < statements.length; i++) {
        const bad = checkDml(statements[i], { allowFullTable });
        if (bad) {
          return jsonReply(res, {
            error: 'statement_rejected',
            message: `第 ${i + 1} 条语句被拒绝：${bad}`,
            index: i + 1,
            statement: statements[i].slice(0, 500),
          }, 400);
        }
      }

      if (dryRun) {
        return jsonReply(res, {
          ok: true, source, file: fileName, dry_run: true, allow_full_table: allowFullTable,
          total: statements.length, executed: 0,
          statements: statements.map((s, i) => ({ index: i + 1, sql: s.slice(0, 500) })),
        }, 200);
      }

      const conn = await getPool().getConnection();
      const results = [];
      let executed = 0;
      let totalAffected = 0;
      try {
        await conn.beginTransaction();
        for (let i = 0; i < statements.length; i++) {
          const stmt = statements[i];
          const [result] = await conn.query(stmt);
          const affected = result && result.affectedRows != null ? result.affectedRows : 0;
          totalAffected += affected;
          executed++;
          results.push({
            index: i + 1,
            ok: true,
            sql: stmt.slice(0, 200),
            affected_rows: affected,
            insert_id: result && result.insertId != null ? result.insertId : null,
            warnings: result && result.warningStatus != null ? result.warningStatus : null,
          });
          if (maxAffected != null && totalAffected > maxAffected) {
            await conn.rollback();
            return jsonReply(res, {
              ok: false, error: 'affected_exceeded', rolled_back: true,
              message: `累计影响行数 ${totalAffected} 超过 max_affected=${maxAffected}，已整批回滚`,
              source, file: fileName,
              total: statements.length, executed, affected_rows: totalAffected, results,
            }, 400);
          }
        }
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch (_) {}
        return jsonReply(res, {
          ok: false, error: 'dml_failed', message: e && e.message, code: e && (e.code || e.errno),
          rolled_back: true,
          source, file: fileName,
          total: statements.length, executed, affected_rows: totalAffected,
          failed_index: executed + 1,
          failed_statement: statements[executed] ? statements[executed].slice(0, 500) : null,
          results,
        }, 400);
      } finally {
        conn.release();
      }

      return jsonReply(res, {
        ok: true, source, file: fileName, dry_run: false, allow_full_table: allowFullTable,
        total: statements.length, executed, affected_rows: totalAffected, results,
      }, 200);
    }

    // POST /cmd/query —— 执行只读查询（SELECT / SHOW / DESC / EXPLAIN）
    // body:
    //   sql:          'SELECT * FROM booking_orders WHERE order_no=?'  必填
    //   max_rows:     返回行数上限，默认 200，上限 5000；带 FROM 且无 LIMIT 的 SELECT 自动补 LIMIT
    //   timeout_ms:   单条语句执行超时（MySQL max_execution_time），默认 10000，0 表示不限
    //   date_strings: 默认 true，DATE/DATETIME/TIMESTAMP 原样返回数据库里的字符串（与 mysql 客户端一致）；
    //                 传 false 则返回 ISO 8601（带 Z 的 UTC 表示）
    if (p === '/cmd/query' && req.method === 'POST') {
      if (String(process.env.CMD_QUERY_DISABLED || '') === '1') {
        return jsonReply(res, { error: 'disabled', message: 'CMD_QUERY_DISABLED=1，查询接口已关闭' }, 403);
      }
      const body = await readBody(req);
      const rawMaxRows = body.max_rows != null ? body.max_rows : body.maxRows;
      const maxRows = Math.max(1, Math.min(5000, parseInt(rawMaxRows, 10) || 200));
      const rawTimeout = body.timeout_ms != null ? body.timeout_ms : body.timeoutMs;
      const timeoutMs = Math.max(0, Math.min(60000, parseInt(rawTimeout, 10) || 10000));
      const rawDateStrings = body.date_strings != null ? body.date_strings : body.dateStrings;
      const dateStrings = rawDateStrings === undefined || rawDateStrings === null
        ? true
        : !(rawDateStrings === false || rawDateStrings === 'false' || rawDateStrings === 0);

      const raw = typeof body.sql === 'string' ? body.sql : '';
      if (!raw.trim()) {
        return jsonReply(res, { error: 'invalid_param', message: 'sql 必填' }, 400);
      }

      const statements = splitStatements(stripSqlComments(raw));
      if (!statements.length) {
        return jsonReply(res, { error: 'invalid_param', message: '没有可执行的语句（可能全是注释）' }, 400);
      }
      if (statements.length > 20) {
        return jsonReply(res, { error: 'too_many', message: `语句数 ${statements.length} 超过上限 20` }, 400);
      }
      for (let i = 0; i < statements.length; i++) {
        const bad = checkQuery(statements[i]);
        if (bad) {
          return jsonReply(res, {
            error: 'statement_rejected',
            message: `第 ${i + 1} 条语句被拒绝：${bad}`,
            index: i + 1,
            statement: statements[i].slice(0, 500),
          }, 400);
        }
      }

      // 带 FROM 且无 LIMIT 的 SELECT 自动补 LIMIT，避免一次拉全表把内存打爆；
      // 形如 SELECT CURRENT_TIMESTAMP() 的标量查询不加，避免出现无意义的 LIMIT 与 truncated 标记
      const prepared = statements.map((s) => {
        const masked = maskStrings(s);
        const needLimit = /^(SELECT|WITH)\b/i.test(s)
          && /\bFROM\b/i.test(masked)
          && !/\blimit\b/i.test(masked);
        return needLimit ? { sql: `${s} LIMIT ${maxRows}`, capped: true } : { sql: s, capped: false };
      });

      const mysql2 = getMysql();
      if (!mysql2) {
        return jsonReply(res, { error: 'db_unavailable', message: 'mysql2 不可用' }, 500);
      }

      const results = [];
      // 用独立连接，避免 SET SESSION 污染连接池里的共享连接
      let conn;
      try {
        // dateStrings 默认开启：DATE/DATETIME/TIMESTAMP 直接返回数据库里的字符串，
        // 避免 Date 对象被 JSON 序列化成 UTC（带 Z）而误以为时间少了 8 小时
        conn = await mysql2.createConnection(Object.assign({}, getDbConfig(), { dateStrings }));
        if (timeoutMs > 0) {
          try { await conn.query(`SET SESSION max_execution_time = ${timeoutMs}`); } catch (_) { /* 老版本 MySQL 无此变量 */ }
        }
        for (let i = 0; i < prepared.length; i++) {
          const startedAt = Date.now();
          const [rows, fields] = await conn.query(prepared[i].sql);
          const list = Array.isArray(rows) ? rows : [];
          results.push({
            index: i + 1,
            sql: prepared[i].sql.slice(0, 300),
            truncated: prepared[i].capped,
            row_count: list.length,
            elapsed_ms: Date.now() - startedAt,
            columns: Array.isArray(fields) ? fields.map((f) => f.name) : [],
            rows: list,
          });
        }
      } catch (e) {
        const failedIdx = results.length;
        return jsonReply(res, {
          ok: false, error: 'query_failed',
          message: e && e.message, code: e && (e.code || e.errno),
          date_strings: dateStrings,
          total: prepared.length, executed: results.length,
          failed_index: failedIdx + 1,
          failed_statement: prepared[failedIdx] ? prepared[failedIdx].sql.slice(0, 500) : null,
          results,
        }, 400);
      } finally {
        if (conn) { try { await conn.end(); } catch (_) {} }
      }

      return jsonReply(res, {
        ok: true, total: prepared.length, executed: results.length,
        max_rows: maxRows, timeout_ms: timeoutMs, date_strings: dateStrings, results,
      }, 200);
    }

    return jsonReply(res, { error: 'not_found', message: '未知 /cmd 接口' }, 404);
  };
}

module.exports = { createCmdRouter, handleCmdRoutes: createCmdRouter() };
