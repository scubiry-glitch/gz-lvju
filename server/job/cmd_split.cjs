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
 * ---------------------------------------------------------------------------
 */
const path = require('path');
const { jsonReply, createReadBody } = require(path.join(__dirname, '..', 'http_util.cjs'));
const { triggerSplitForOrder } = require(path.join(__dirname, 'book_order_split_job.cjs'));
const { createPayCenter } = require(path.join(__dirname, '..', 'thirdApi', 'payCenter.cjs'));
const { queryRows } = require(path.join(__dirname, '..', 'db.cjs'));

const readBody = createReadBody();

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
    //   biz_code:      分账标准业务码（与 fee_type 二选一必传；传 order_no 时若本地无记录则需显式给）
    //   fee_type:      分账业务类型（与 biz_code 二选一必传）
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
      let feeType = body.fee_type || body.feeType;
      //业务单号（与分账单号二选一必传）
      let bizOrderNo = body.biz_order_no || body.bizOrderNo;
      //分账单号（与业务单号二选一必传）
      let orderNo = body.order_no_gateway || body.orderNoGateway  ;
      let local = null;
      // 给了旅居业务订单号 → 从 payment_split 反查 biz_code / 中台单号 / 本地状态（本地无 fee_type 列，不反查）
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
      if (!bizCode && !feeType) {
        return jsonReply(res, { error: 'invalid_param', message: '无法解析 biz_code / fee_type（请传其一，或传有效的 order_no 反查 biz_code）' }, 400);
      }
      if (!bizOrderNo && !orderNo) {
        return jsonReply(res, { error: 'invalid_param', message: '需提供 biz_order_no 或 order_no_gateway（或有效的 order_no）' }, 400);
      }
      const params = { orderType };
      if (bizCode) params.bizCode = bizCode;
      if (feeType) params.feeType = feeType;
      if (bizOrderNo) params.bizOrderNo = bizOrderNo;
      if (orderNo) params.orderNo = orderNo;
      try {
        const pc = createPayCenter(body.env);
        const gateway = await pc.querySplitResult(params);
        return jsonReply(res, { order_type: orderType, biz_code: bizCode, fee_type: feeType, biz_order_no: bizOrderNo, order_no_gateway: orderNo, local, gateway }, 200);
      } catch (e) {
        return jsonReply(res, { error: 'query_failed', message: e && e.message }, 502);
      }
    }

    return jsonReply(res, { error: 'not_found', message: '未知 /cmd 接口' }, 404);
  };
}

module.exports = { createCmdRouter, handleCmdRoutes: createCmdRouter() };
