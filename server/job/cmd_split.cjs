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
 * ---------------------------------------------------------------------------
 */
const path = require('path');
const { jsonReply, createReadBody } = require(path.join(__dirname, '..', 'http_util.cjs'));
const { triggerSplitForOrder } = require(path.join(__dirname, 'book_order_split_job.cjs'));

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

    return jsonReply(res, { error: 'not_found', message: '未知 /cmd 接口' }, 404);
  };
}

module.exports = { createCmdRouter, handleCmdRoutes: createCmdRouter() };
