'use strict';
/**
 * HTTP JSON 响应与 body 读取（从 app.js 拆出）。
 */

function jsonReply(res, data, code) {
  const body = JSON.stringify(data);
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * @param {(raw: string) => void} [onBodyLog] 可选：读完 body 后打日志（app.js reqLogBody）
 */
function createReadBody(onBodyLog) {
  return function readBody(req) {
    if (req._rawBody !== undefined) {
      try { return Promise.resolve(req._rawBody ? JSON.parse(req._rawBody) : {}); }
      catch (_) { return Promise.resolve({}); }
    }
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => {
        req._rawBody = data;
        if (typeof onBodyLog === 'function') onBodyLog(data);
        try { resolve(data ? JSON.parse(data) : {}); }
        catch (_) { resolve({}); }
      });
      req.on('error', reject);
    });
  };
}

module.exports = { jsonReply, createReadBody };
