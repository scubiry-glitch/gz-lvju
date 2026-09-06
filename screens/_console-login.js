/* _console-login.js · 控制台统一账号登录门（阶段3「都用账号登录」）
 *
 * 用法（任何后台/控制台页面）：
 *   <script src="_console-login.js"></script>
 *   <script>
 *     BZF_CONSOLE.requireLogin({ hint: '运营控制台' }).then(function (me) { initPage(); });
 *   </script>
 *
 * 行为：
 *  1. 全局 fetch 拦截：/api/juzhu/* 与 /api/auth/* 请求自动带
 *     Authorization: Bearer <会话token>（localStorage BZF_SESSION_TOKEN），
 *     并剥离 X-API-Key（旧全局 key 已停用，防止页面残留配置混入）；
 *  2. 收到 401 自动弹出登录层（单次去重），登录成功后自动重放原请求一次；
 *  3. requireLogin() 返回 /api/auth/me 的会话信息（account/roles/permissions/scope）。
 *
 * 登录走账号中心 POST /api/auth/login（accounts 表；gov/bank 走 IdP 的组织后续接
 * /api/auth/idp/login）。旧 /api/juzhu/vendor/login 与全局 key 不再是页面入口。
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'BZF_SESSION_TOKEN';
  var overlayEl = null;
  var pending = [];      // 等登录后重放的 {resolve, reject, input, init}
  var overlayOpen = false;

  function token() {
    try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); } catch (_) { return ''; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, String(t).trim());
      else localStorage.removeItem(TOKEN_KEY);
    } catch (_) {}
  }

  function isApiUrl(url) {
    return /\/api\/(juzhu|auth)\//.test(String(url));
  }

  // ── 全局 fetch 拦截：注入会话、剥离旧 key、401 自动重登并重放一次 ──
  var _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!isApiUrl(url)) return _fetch(input, init);
    init = Object.assign({}, init || {});
    var headers = new Headers((init && init.headers) || (input && input.headers) || {});
    var t = token();
    if (t && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + t);
    headers.delete('X-API-Key'); // 旧全局 key 已停用
    init.headers = headers;
    var replayed = (init && init.__replayed) || false;
    return _fetch(input, init).then(function (r) {
      // 登录接口自身的 401 交给页面登录表单处理，不弹层不重放（否则一次密码错误会被计成两次节流失败）
      if (r.status === 401 && !replayed && !/\/auth\/login(\?|$)/.test(url)) {
        return ensureLogin().then(function () {
          var init2 = Object.assign({}, init, { __replayed: true });
          return window.fetch(input, init2);
        });
      }
      return r;
    });
  };

  // ── 登录层 UI ──
  function ensureOverlay(hint) {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.92);' +
      'display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
    overlayEl.innerHTML =
      '<div style="width:320px;background:#fff;border-radius:14px;padding:26px 24px;box-shadow:0 20px 60px rgba(0,0,0,.35);">' +
      '<div style="font-size:16px;font-weight:700;color:#0f172a;margin-bottom:4px;">账号登录</div>' +
      '<div style="font-size:12px;color:#64748b;margin-bottom:14px;" id="bzfcl-hint"></div>' +
      '<input id="bzfcl-user" placeholder="账号 / 手机号" autocomplete="username" ' +
      'style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cbd5e1;border-radius:9px;font-size:13px;margin-bottom:8px;">' +
      '<input id="bzfcl-pwd" type="password" placeholder="密码" autocomplete="current-password" ' +
      'style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cbd5e1;border-radius:9px;font-size:13px;margin-bottom:12px;">' +
      '<button id="bzfcl-go" style="width:100%;padding:10px;border:0;border-radius:9px;background:#0f766e;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">登 录</button>' +
      '<div id="bzfcl-err" style="font-size:12px;color:#dc2626;margin-top:8px;min-height:16px;"></div>' +
      '</div>';
    document.body.appendChild(overlayEl);
    var go = function () { doLogin(hint); };
    overlayEl.querySelector('#bzfcl-go').addEventListener('click', go);
    overlayEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    return overlayEl;
  }

  function doLogin(hint) {
    var user = overlayEl.querySelector('#bzfcl-user').value.trim();
    var pwd = overlayEl.querySelector('#bzfcl-pwd').value;
    var errEl = overlayEl.querySelector('#bzfcl-err');
    if (!user || !pwd) { errEl.textContent = '请输入账号与密码'; return; }
    errEl.textContent = '登录中…';
    _fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login_name: user, password: pwd }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.token) { errEl.textContent = res.d.error || '登录失败'; return; }
        setToken(res.d.token);
        closeOverlay();
        var waiters = pending.splice(0);
        waiters.forEach(function (w) { w.resolve(); });
      })
      .catch(function () { errEl.textContent = '登录请求失败'; });
  }

  function closeOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    overlayOpen = false;
  }

  function ensureLogin(hint) {
    if (token()) {
      // 已有 token：校验有效性（无效则清掉重新弹层）
      return _fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token() } })
        .then(function (r) {
          if (r.status === 200) return r.json();
          setToken('');
          return ensureLogin(hint);
        });
    }
    if (document.readyState === 'loading') {
      return new Promise(function (resolve) {
        document.addEventListener('DOMContentLoaded', function () { ensureLogin(hint).then(resolve); });
      });
    }
    if (!overlayOpen) {
      overlayOpen = true;
      ensureOverlay(hint);
      var hintEl = overlayEl.querySelector('#bzfcl-hint');
      if (hintEl) hintEl.textContent = hint || '请使用账号中心账号登录（旧 API Key 方式已停用）';
      setTimeout(function () { var u = overlayEl && overlayEl.querySelector('#bzfcl-user'); if (u) u.focus(); }, 50);
    }
    return new Promise(function (resolve) { pending.push({ resolve: resolve }); });
  }

  window.BZF_CONSOLE = {
    token: token,
    setToken: setToken,
    requireLogin: ensureLogin,
    logout: function (reload) {
      var t = token();
      setToken('');
      if (t) _fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).catch(function () {});
      if (reload !== false) location.reload();
    },
  };

  // 引入本脚本即视为控制台页面：DOMContentLoaded 自动过登录门。
  // 不想被门控的页面不要引入本脚本（而非加开关）。
  function autoGate() {
    if (document.documentElement.dataset.consoleLogin === 'off') return;
    ensureLogin();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoGate);
  else autoGate();
})();
