(function () {
  'use strict';
  var PREFIX = '/api/commerce/v1', current = null;
  function key() { return crypto.randomUUID(); }
  async function request(path, body, idem) {
    var headers = { 'Content-Type': 'application/json' };
    if (current) headers.Authorization = 'Bearer ' + current.token;
    if (body !== undefined) headers['Idempotency-Key'] = idem || key();
    var response = await fetch(PREFIX + path, { method: body === undefined ? 'GET' : 'POST', headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    var data; try { data = await response.json(); } catch (_) { throw new Error('权益联调服务未启动，请使用本地联调地址。'); }
    if (!response.ok) throw new Error(data.error || '服务暂不可用');
    return data.data;
  }
  async function login(identity) { current = await request('/test-sessions', { identity: identity }); sessionStorage.setItem('commerce_test_session', JSON.stringify(current)); return current.actor; }
  try { current = JSON.parse(sessionStorage.getItem('commerce_test_session') || 'null'); } catch (_) {}
  window.COMMERCE = { request: request, login: login, key: key, actor: function () { return current && current.actor; }, clear: function () { current = null; sessionStorage.removeItem('commerce_test_session'); } };
})();
