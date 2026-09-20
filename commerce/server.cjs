'use strict';
// Deliberately separate from app.js: M0 must never initialize production DB/auth.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Commerce, DomainError, identities } = require('./domain.cjs');
const ROOT = path.resolve(__dirname, '..');
const PREFIX = '/api/commerce/v1';
const STATIC = new Set(['index.html', 'overview.html', 'juzhu-commerce.html', 'juzhu-promoter.html', 'screens/commerce-merchant.html', 'screens/commerce-admin.html', 'lvju-app.css', 'jiazheng-app.css', 'screens/_commerce.css', 'screens/_commerce-ui.js', 'screens/_commerce-api.js', 'screens/_commerce-entry.js', 'screens/_nav.js', 'screens/_region.js', 'screens/_navmobile.js', 'screens/_jzapi.js', 'juzhu/app.js', 'juzhu/cities.json', 'juzhu/data.json', 'juzhu/data-shenyang.json']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
async function bodyOf(req) {
  let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 20000) throw new DomainError(413, 'BODY_TOO_LARGE', '请求过大'); }
  try { const v = JSON.parse(body || '{}'); if (!v || Array.isArray(v) || typeof v !== 'object') throw new Error(); return v; } catch { throw new DomainError(400, 'JSON', '请求必须是JSON对象'); }
}
function createServer({ domain = new Commerce(), publicOrigin = '' } = {}) {
  let previewOrigin = null;
  if (publicOrigin) {
    const parsed = new URL(publicOrigin);
    if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin || parsed.username || parsed.password) throw new Error('COMMERCE_PUBLIC_ORIGIN must be an exact HTTPS origin');
    previewOrigin = parsed;
  }
  const sessions = new Map(), rates = new Map();
  const server = http.createServer(async (req, res) => {
    const request_id = randomUUID();
    try {
      // DNS rebinding and cross-origin writes cannot select demo identities.
      const host = req.headers.host || '';
      const publicHost = previewOrigin && host === previewOrigin.host;
      if (!publicHost && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new DomainError(403, 'HOST', '测试服务仅允许本机或已配置的预览域名');
      const allowedOrigin = publicHost ? previewOrigin.origin : `http://${host}`;
      if (req.headers.origin && req.headers.origin !== allowedOrigin) throw new DomainError(403, 'ORIGIN', '拒绝跨站访问');
      const url = new URL(req.url, `http://${host}`), route = url.pathname.slice(PREFIX.length);
      if (url.pathname.startsWith(PREFIX)) {
        const method = req.method, body = method === 'POST' ? await bodyOf(req) : {};
        const result = (data, status = 200) => send(res, status, { request_id, code: 'OK', data, test_only: true });
        if (route === '/meta' && method === 'GET') return result({ mode: 'isolated-memory-test', real_money: false, identities });
        if (route === '/test-sessions' && method === 'POST') {
          const actor = identities.find((a) => a.id === body.identity);
          if (!actor) throw new DomainError(422, 'IDENTITY', '无效的测试身份');
          if (sessions.size > 1000) sessions.clear();
          const token = randomUUID(); sessions.set(token, { actor, expires: Date.now() + 8 * 3600000 }); return result({ token, actor });
        }
        if (route === '/catalog' && method === 'GET') return result(domain.catalog(url.searchParams.get('city') || '沈阳'));
        if (route.startsWith('/products/') && method === 'GET') return result(domain.product(decodeURIComponent(route.slice(10))));
        const session = sessions.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
        const actor = session && session.expires > Date.now() ? session.actor : null;
        if (!actor) throw new DomainError(401, 'LOGIN_REQUIRED', '请先选择隔离测试身份');
        if (route === '/state' && method === 'GET') return result(domain.view(actor));
        if (route.startsWith('/me/coupons/') && method === 'GET') return result(domain.coupon(actor, route.split('/')[3]));
        if (method !== 'POST') throw new DomainError(404, 'NOT_FOUND', '接口不存在');
        const rateKey = `${actor.id}:${route.replace(/_[\w-]+/g, '')}`;
        if (/redemption/.test(route)) {
          const rate = rates.get(rateKey) || { start: Date.now(), count: 0 };
          if (Date.now() - rate.start > 60000) { rate.start = Date.now(); rate.count = 0; }
          rate.count++; rates.set(rateKey, rate);
          if (rate.count > 30) throw new DomainError(429, 'RATE_LIMIT', '操作频繁，请稍后重试');
        }
        return result(domain.write(actor, route, req.headers['idempotency-key'], body, () => {
          if (route === '/order-quotes') { domain.role(actor, 'consumer'); return domain.quote(body); }
          if (route === '/orders') return domain.order(actor, body);
          let m;
          if ((m = route.match(/^\/orders\/([^/]+)\/test-pay$/))) return domain.pay(actor, m[1], body);
          if ((m = route.match(/^\/admin\/orders\/([^/]+)\/retry$/))) return domain.retry(actor, m[1]);
          if (route === '/appointments') return domain.appointment(actor, body);
          if ((m = route.match(/^\/appointments\/([^/]+)\/cancel$/))) return domain.cancelAppointment(actor, m[1]);
          if ((m = route.match(/^\/me\/coupons\/([^/]+)\/redemption-token$/))) return domain.token(actor, m[1]);
          if (route === '/redemption-previews') return domain.preview(actor, body);
          if (route === '/redemptions') return domain.redeem(actor, body);
          if (route === '/refunds') return domain.refund(actor, body);
          if ((m = route.match(/^\/admin\/refunds\/([^/]+)\/approve$/))) return domain.reviewRefund(actor, m[1]);
          if ((m = route.match(/^\/admin\/coupons\/([^/]+)\/test-expire$/))) return domain.expire(actor, m[1]);
          if (route === '/admin/expiry-job') return domain.expiryJob(actor);
          if ((m = route.match(/^\/admin\/compensations\/([^/]+)\/recover$/))) return domain.recover(actor, m[1]);
          if (route === '/admin/test-release') return domain.release(actor);
          if (route === '/withdrawals') return domain.withdraw(actor, body);
          if ((m = route.match(/^\/admin\/payouts\/([^/]+)\/(unknown|query|paid)$/))) return domain.payout(actor, m[1], m[2]);
          if (route === '/promotion-links') return domain.share(actor, body);
          if (route === '/help') return domain.helpRequest(actor, body);
          if ((m = route.match(/^\/admin\/help\/([^/]+)\/resolve$/))) return domain.resolveHelp(actor, m[1]);
          if (route === '/admin/sales') { domain.role(actor, 'admin'); if (typeof body.enabled !== 'boolean') throw new DomainError(422, 'BOOLEAN', 'enabled须为布尔值'); domain.salesEnabled = body.enabled; return { enabled: domain.salesEnabled }; }
          if (route === '/admin/test-capacity') {
            domain.role(actor, 'admin'); domain.dateCheck(body.date);
            if (!/^store-[A-E]$/.test(body.store) || !Number.isInteger(body.total) || body.total < domain.used(body.store, body.date) || body.total > 100) throw new DomainError(422, 'CAPACITY', '产能不能小于已预约量，或超出0–100');
            domain.capacity.set(`${body.store}:${body.date}`, body.total); return { ...body };
          }
          if (route === '/admin/test-membership-expire') {
            domain.role(actor, 'admin'); const row = domain.memberships.find((m) => m.id === body.id);
            if (!row) throw new DomainError(404, 'NOT_FOUND', '会员记录不存在'); row.end = domain.now() - 1; return { id: row.id, end: row.end };
          }
          throw new DomainError(404, 'NOT_FOUND', '接口不存在');
        }));
      }
      // Minimal public fixture for the existing homepage, not a production proxy.
      if (url.pathname === '/api/juzhu/settings') return send(res, 200, { show_city_switcher: true, show_life_service: true, channel_name: '新居住频道' });
      if (url.pathname.startsWith('/api/juzhu/')) {
        if (url.pathname.includes('categories')) return send(res, 200, []);
        if (url.pathname.includes('catalog')) return send(res, 200, { districts: [], projects: [], units: [], channels: [{ id: 'jiazheng', label: '生活服务专区', enabled: 1 }], test_only: true });
        return send(res, 404, { error: '隔离联调不连接原业务接口' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new DomainError(405, 'METHOD', '不支持此方法');
      let file; try { file = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html'; } catch { throw new DomainError(400, 'PATH', '路径无效'); }
      if (file.split('/').some((p) => !p || p.startsWith('.')) || !(STATIC.has(file) || /^assets\/[\w/.-]+\.(png|webp|jpg|svg|woff2)$/.test(file))) throw new DomainError(404, 'NOT_FOUND', '页面不存在');
      const filename = path.resolve(ROOT, file);
      if (!filename.startsWith(`${ROOT}/`) || !fs.existsSync(filename)) throw new DomainError(404, 'NOT_FOUND', '页面不存在');
      const real = fs.realpathSync(filename); if (!real.startsWith(`${ROOT}/`)) throw new DomainError(404, 'NOT_FOUND', '页面不存在');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filename).pipe(res);
    } catch (err) { send(res, err.status || 500, { request_id, code: err.code || 'INTERNAL', error: err.status ? err.message : '联调服务异常', test_only: true }); }
  });
  const expiryTimer = setInterval(() => {
    const result = domain.expiryJob(identities.find((a) => a.id === 'admin'));
    if (result.processed) domain.log({ id: 'expiry-job' }, 'automatic-expiry-refunds', String(result.processed));
  }, 15000);
  expiryTimer.unref(); server.on('close', () => clearInterval(expiryTimer));
  server.commerce = domain; return server;
}
if (require.main === module) {
  if (process.env.NODE_ENV === 'production' || process.env.JUZHU_ENV === 'production') throw new Error('M0服务禁止生产模式启动');
  const port = Number(process.env.COMMERCE_TEST_PORT || 38779);
  createServer({ publicOrigin: process.env.COMMERCE_PUBLIC_ORIGIN || '' }).listen(port, '127.0.0.1', () => console.log(`M0 无资金联调：http://127.0.0.1:${port}/juzhu-commerce.html（内存数据，重启清空）`));
}
module.exports = { createServer };
