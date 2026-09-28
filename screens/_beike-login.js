/* _beike-login.js · C 端订房登录闸
 *
 * 用法（详情 / 下单 / 订单 / 我的，以及带 tabbar 的 C 端页）：
 *   <script src="jsbridgesdk.js?v=1"></script>
 *   <script src="screens/_beike-login.js"></script>
 *   BZF_BEIKE_LOGIN.gateThenGo(nextUrl);
 *
 * 口径（身份标准 = lianjia_token）：
 *  1. App 内：bridge/cookie 取票；无票 → $ljBridge.actionLogin。
 *  2. 普通浏览器：对齐 Morph mLogin —— clogin.ke.com?service=m.ke.com/my/checklogin?redirect=回跳；
 *     回跳后 cookie / 可读票 → X-Lianjia-Token；HttpOnly 时同源 API 靠 Cookie。
 *  3. BJZ_TOKEN 仅为可选短缓存；密码门仅作兜底。
 *  文档：https://kedoc.ke.com/morph/docs/business/login ；源码 Morph/src/business/login/platform/m.ts
 */
(function (w) {
  'use strict';
  var TOKEN_KEY = 'BJZ_TOKEN';
  var JUMP_KEY = 'bzf_beike_login_jumped';
  var NEXT_KEY = 'bzf_beike_login_next';
  var USER_KEY = 'bzf_beike_user';
  var LJ_STORE_KEY = 'bzf_lj_token';
  var cookieSessionOk = false;
  var _loginCfg = null;
  var _loginCfgP = null;

  function token() {
    try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function setToken(t) {
    try {
      var v = t ? String(t).trim() : '';
      if (v) {
        localStorage.setItem(TOKEN_KEY, v);
        localStorage.setItem('BZF_SESSION_TOKEN', v);
      } else {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('BZF_SESSION_TOKEN');
      }
    } catch (e) {}
  }
  function absUrl(u) {
    try { return new URL(u, location.href).href; } catch (e) { return u || location.href; }
  }

  /* Morph getCookie：必须传名字。getCookie() 空调用得到的是 ""，不是 lianjia_token。 */
  function getCookie(cookieName, cookies) {
    cookieName = cookieName || '';
    var windowCookies = (cookies == null || cookies === '')
      ? ((typeof document !== 'undefined' && document.cookie) || '')
      : cookies;
    if (!cookieName || !windowCookies) return '';
    var cookArr = String(windowCookies).split(';');
    for (var i = 0; i < cookArr.length; i++) {
      var parts = cookArr[i].split('=');
      if (parts[0].trim() === cookieName.trim()) return (parts[1] || '').trim();
    }
    return '';
  }

  function storedLjToken() {
    try { return (sessionStorage.getItem(LJ_STORE_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function setStoredLjToken(t) {
    try {
      if (t) sessionStorage.setItem(LJ_STORE_KEY, String(t).trim());
      else sessionStorage.removeItem(LJ_STORE_KEY);
    } catch (e) {}
  }

  /* 部分回跳会把票放在 query/hash；读到后写入 sessionStorage 并 scrub URL */
  function captureTokenFromUrl() {
    try {
      var u = new URL(location.href);
      var t = (u.searchParams.get('lianjia_token') || u.searchParams.get('lj_token') || u.searchParams.get('token') || '').trim();
      if (!t && u.hash) {
        var m = String(u.hash).match(/(?:lianjia_token|lj_token|token)=([^&]+)/i);
        if (m) t = decodeURIComponent(m[1] || '').trim();
      }
      if (!t) return;
      setStoredLjToken(t);
      u.searchParams.delete('lianjia_token');
      u.searchParams.delete('lj_token');
      u.searchParams.delete('token');
      if (/lianjia_token|lj_token|(?:^|[&#])token=/i.test(u.hash || '')) u.hash = '';
      if (w.history && history.replaceState) {
        history.replaceState(null, '', u.pathname + u.search + u.hash);
      }
    } catch (e) {}
  }
  captureTokenFromUrl();

  function lianjiaToken() {
    return getCookie('lianjia_token') || getCookie('lj_token') || storedLjToken() || '';
  }

  function isBeikeApp() {
    try {
      if (w.__BZF_IS_BEIKE_APP) return true;
    } catch (e0) {}
    try {
      if (w.JsBridgeV3 && typeof w.JsBridgeV3.getAPPEnv === 'function') {
        var env = w.JsBridgeV3.getAPPEnv();
        if (env && (env.isBeike || env.isLianjiaApp)) return true;
      }
    } catch (e) {}
    var ua = navigator.userAgent || '';
    return /lianjiabeike/i.test(ua) ||
      /Lianjia\/Beike/i.test(ua) ||
      (/Lianjia/i.test(ua) && !/Alliance|lianjiabaichuan|beikesteward|beike_rentplat|decorate|LiveInBeike|beikeanzhu|fanghuoji/i.test(ua));
  }

  function initBridge() {
    try {
      if (w.JsBridgeV3 && typeof w.JsBridgeV3.init === 'function') {
        w.JsBridgeV3.init({ preventDomainSetting: true });
      }
    } catch (e) {}
  }

  function unwrap(info) {
    if (!info || typeof info !== 'object') return null;
    return info.data && typeof info.data === 'object' ? info.data : info;
  }

  function pickUser(info) {
    var i = unwrap(info);
    if (!i) return null;
    var uid = i.uid || i.userId || i.user_id || i.ucid || i.id;
    var raw = String(i.phone || i.mobile || i.phoneNumber || i.mobilePhone || i.mobile_phone || '').replace(/\D/g, '');
    if (raw.length === 13 && raw.indexOf('86') === 0) raw = raw.slice(2);
    if (!uid) return null;
    return {
      uid: String(uid),
      phone: raw,
      name: String(i.name || i.displayName || i.display_name || i.userName || i.username || '').trim()
    };
  }

  function appUserInfo() {
    initBridge();
    try {
      if (w.$ljBridge && typeof w.$ljBridge.getUserInfo === 'function') {
        var ljU = unwrap(w.$ljBridge.getUserInfo());
        if (ljU) return ljU;
      }
    } catch (e0) {}
    try {
      if (w.JsBridgeV3 && typeof w.JsBridgeV3.getUserInfo === 'function') {
        return unwrap(w.JsBridgeV3.getUserInfo()) || null;
      }
    } catch (e) {}
    var sdk = w.LJBridge || w.jsbridge3 || w.BeiKeSdk || w.__beikeSdk;
    try {
      if (sdk && typeof sdk.getUserInfo === 'function') {
        var u = sdk.getUserInfo();
        if (u && typeof u.then === 'function') return null;
        return unwrap(u);
      }
    } catch (e) {}
    return null;
  }

  function ljAccessToken() {
    try {
      if (w.$ljBridge && typeof w.$ljBridge.getAccessToken === 'function') {
        var t = w.$ljBridge.getAccessToken();
        if (t && typeof t === 'object') t = t.token || t.accessToken || t.lianjia_token || '';
        return t ? String(t).trim() : '';
      }
    } catch (e) {}
    return '';
  }

  function beikeAccessToken() {
    return ljAccessToken() || lianjiaToken();
  }

  function lastUser() {
    try { return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
  }
  function setLastUser(u) {
    try {
      if (u) sessionStorage.setItem(USER_KEY, JSON.stringify(u));
      else sessionStorage.removeItem(USER_KEY);
    } catch (e) {}
  }

  function isLoggedIn() {
    return !!(beikeAccessToken() || token() || cookieSessionOk);
  }

  function beikeLoggedIn() {
    if (beikeAccessToken()) return true;
    if (pickUser(appUserInfo())) return true;
    return false;
  }

  function authHeaders() {
    var h = {};
    var lj = beikeAccessToken();
    if (lj) h['X-Lianjia-Token'] = lj;
    var t = token();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  /* 浏览器 H5：对齐 Morph mLogin（clogin + m 站 checklogin?redirect=） */
  function defaultLoginCfg() {
    var host = location.hostname || '';
    var domainEnv = /\.lianjia\.com$/i.test(host) ? 'lianjia.com' : 'ke.com';
    var isTest = /\.tt[abc]\.test\.ke\.com$/i.test(host) || /\.test\.ke\.com$/i.test(host) ||
      /localhost|127\.0\.0\.1/i.test(host);
    var prefix = isTest ? 'test-' : '';
    return {
      login_base: 'https://' + prefix + 'clogin.' + domainEnv,
      service_base: 'https://' + prefix + 'm.' + domainEnv + '/my/checklogin',
      type: 2
    };
  }

  function resolveLoginCfg(done) {
    done = typeof done === 'function' ? done : function () {};
    if (_loginCfg) { done(_loginCfg); return; }
    if (w.__BZF_BEIKE_H5_LOGIN__) {
      var o = w.__BZF_BEIKE_H5_LOGIN__;
      if (typeof o === 'string') {
        _loginCfg = Object.assign(defaultLoginCfg(), { login_base: String(o).replace(/\/$/, '') });
      } else {
        _loginCfg = Object.assign(defaultLoginCfg(), o || {});
      }
      done(_loginCfg);
      return;
    }
    if (_loginCfgP) { _loginCfgP.then(done); return; }
    _loginCfgP = fetch('/api/juzhu/auth/beike-config', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var d = defaultLoginCfg();
        _loginCfg = {
          login_base: (j && j.login_base) ? String(j.login_base).replace(/\/$/, '') : d.login_base,
          service_base: (j && j.service_base) ? String(j.service_base).replace(/\/$/, '') : d.service_base,
          type: (j && j.type != null) ? j.type : 2
        };
        return _loginCfg;
      })
      .catch(function () {
        _loginCfg = defaultLoginCfg();
        return _loginCfg;
      });
    _loginCfgP.then(done);
  }

  /* Morph m.ts: loginUrl?service=enc(serviceUrl?redirect=enc(url))&type=2 */
  function browserH5LoginUrl(back) {
    var cfg = _loginCfg || defaultLoginCfg();
    var redirect = absUrl(back || location.href);
    var service = cfg.service_base + '?redirect=' + encodeURIComponent(redirect);
    return cfg.login_base + '/login?service=' + encodeURIComponent(service) + '&type=' + (cfg.type != null ? cfg.type : 2);
  }

  function resolveLoginBase(done) {
    resolveLoginCfg(function (cfg) { done(cfg.login_base); });
  }

  var LJ_BRIDGE_SDK = '//s1.ljcdn.com/m-base/release/v04.4/asset/bridge_d0b9f70cd88e0a5q.js';
  var _ljP = null;

  function loadLjBridge() {
    if (w.$ljBridge) return Promise.resolve(w.$ljBridge);
    if (_ljP) return _ljP;
    _ljP = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = (location.protocol === 'http:' ? 'https:' : location.protocol) + LJ_BRIDGE_SDK;
      s.async = true;
      s.onload = function () { resolve(w.$ljBridge || null); };
      s.onerror = function () { resolve(null); };
      (document.head || document.documentElement).appendChild(s);
    });
    return _ljP;
  }

  function nativeLoginUrl(back) {
    var path = 'actionlogin?param=' + encodeURIComponent(encodeURIComponent(back));
    try {
      if (w.JsBridgeV3 && typeof w.JsBridgeV3.getSchemeLink === 'function') {
        var linked = w.JsBridgeV3.getSchemeLink(path);
        if (linked) return linked;
      }
    } catch (e) {}
    var scheme = '';
    try {
      if (w.JsBridgeV3 && typeof w.JsBridgeV3.getScheme === 'function') scheme = w.JsBridgeV3.getScheme() || '';
    } catch (e2) {}
    if (!scheme) {
      var env = null;
      try { env = w.JsBridgeV3 && w.JsBridgeV3.getAPPEnv && w.JsBridgeV3.getAPPEnv(); } catch (e3) {}
      scheme = (env && env.isLianjiaApp && !env.isBeike) ? 'lianjia' : 'lianjiabeike';
    }
    return scheme + '://' + path;
  }

  function morphAppLogin(back) {
    return new Promise(function (resolve) {
      loadLjBridge().then(function (lj) {
        if (lj && typeof lj.ready === 'function') {
          try {
            lj.ready(function (bridge, webStatus) {
              if (webStatus && webStatus.isApp) w.__BZF_IS_BEIKE_APP = true;
              if (bridge && typeof bridge.actionLogin === 'function') {
                bridge.actionLogin(encodeURIComponent(back));
                resolve(true);
                return;
              }
              resolve(false);
            });
            return;
          } catch (e) {}
        }
        resolve(false);
      });
    });
  }

  function exchange() {
    var lj = beikeAccessToken();
    if (!lj) return Promise.resolve(null);
    return fetch('/api/juzhu/auth/beike', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lianjia_token: lj })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && j.token) {
        setToken(j.token);
        setLastUser({
          uid: j.uid || '',
          phone: j.phone_masked || '',
          name: j.display_name || ''
        });
        return j;
      }
      return null;
    }).catch(function () { return null; });
  }

  /* HttpOnly cookie：同源探 /api/auth/me（credentials），避免前端读不到票却已登录 */
  function probeCookieSession() {
    return fetch('/api/auth/me', {
      credentials: 'same-origin',
      headers: authHeaders()
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json();
    }).then(function (j) {
      if (j && j.account) {
        cookieSessionOk = true;
        setLastUser({
          uid: String(j.account.idp_subject || j.account.id || ''),
          phone: j.account.phone || '',
          name: j.account.display_name || ''
        });
        return true;
      }
      return false;
    }).catch(function () { return false; });
  }

  function trySyncIdentity(done) {
    done = typeof done === 'function' ? done : function () {};
    var tries = 0;
    function maxTries() {
      return (jumpedRecently() || isBeikeApp() || w.__BZF_IS_BEIKE_APP) ? 8 : 2;
    }
    function once() {
      var lj = beikeAccessToken();
      if (lj) {
        done(true);
        var prev = lastUser();
        exchange().then(function (j) {
          if (j) {
            if (prev && prev.uid && j.uid && String(prev.uid) !== String(j.uid)) {
              try { console.log('[login] beike account switched', prev.uid, '→', j.uid); } catch (e) {}
            }
            return;
          }
          clearAuthTokens();
          setLastUser(null);
          setStoredLjToken('');
        });
        return;
      }
      if (token()) { done(true); return; }
      probeCookieSession().then(function (ok) {
        if (ok) { done(true); return; }
        tries += 1;
        if (tries < maxTries()) setTimeout(once, 400);
        else done(false);
      });
    }
    loadLjBridge().then(function (lj) {
      if (lj && typeof lj.ready === 'function') {
        try {
          lj.ready(function (bridge, webStatus) {
            if (webStatus && webStatus.isApp) w.__BZF_IS_BEIKE_APP = true;
            once();
          });
          return;
        } catch (e) {}
      }
      once();
    });
  }

  function tryExchangeFromApp(done) { return trySyncIdentity(done); }

  function jumpedRecently() {
    try {
      var t = +sessionStorage.getItem(JUMP_KEY) || 0;
      return t > 0 && (Date.now() - t) < 120000;
    } catch (e) { return false; }
  }
  function markJumped() {
    try { sessionStorage.setItem(JUMP_KEY, String(Date.now())); } catch (e) {}
  }
  function clearJumped() {
    try { sessionStorage.removeItem(JUMP_KEY); } catch (e) {}
  }

  function saveNext(url) {
    try { sessionStorage.setItem(NEXT_KEY, absUrl(url)); } catch (e) {}
  }

  function samePage(a, b) {
    function bare(u) {
      try { var x = new URL(absUrl(u)); x.hash = ''; return x.href; } catch (e) { return absUrl(u); }
    }
    return bare(a) === bare(b);
  }

  /* App → 原生登录；浏览器 → Morph mLogin（clogin + checklogin） */
  function jumpToLogin(returnUrl) {
    if (returnUrl) saveNext(returnUrl);
    var back = location.href;
    markJumped();
    if (isBeikeApp()) {
      initBridge();
      morphAppLogin(back).then(function (ok) {
        if (ok) return;
        var url = nativeLoginUrl(back);
        if (w.JsBridgeV3 && typeof w.JsBridgeV3.navigateTo === 'function') {
          w.JsBridgeV3.navigateTo({ url: url, fail: function () { location.href = url; } });
        } else {
          location.href = url;
        }
      });
      return true;
    }
    resolveLoginCfg(function () {
      location.href = browserH5LoginUrl(back);
    });
    return true;
  }

  function clearAuthTokens() {
    setToken('');
    cookieSessionOk = false;
    setStoredLjToken('');
    try { localStorage.removeItem('JUZHU_VENDOR_TOKEN'); } catch (e) {}
  }

  function isCredentialLoginUrl(url) {
    return /\/api\/auth\/login(?:\?|$)|\/api\/juzhu\/auth\/tenant(?:\?|$)|\/api\/juzhu\/auth\/beike(?:\?|$)/.test(String(url || ''));
  }

  function requestUrl(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
    } catch (e) {}
    return '';
  }

  function requestHadAuth(input, init) {
    try {
      var h = init && init.headers;
      if (h) {
        if (typeof Headers !== 'undefined' && h instanceof Headers) {
          return !!(h.get('Authorization') || h.get('authorization') ||
            h.get('X-Lianjia-Token') || h.get('x-lianjia-token'));
        }
        if (typeof h === 'object') {
          return !!(h.Authorization || h.authorization ||
            h['X-Lianjia-Token'] || h['x-lianjia-token']);
        }
      }
      if (typeof Request !== 'undefined' && input instanceof Request) {
        return !!(input.headers.get('Authorization') || input.headers.get('authorization') ||
          input.headers.get('X-Lianjia-Token') || input.headers.get('x-lianjia-token'));
      }
    } catch (e) {}
    return false;
  }

  function handleUnauthorized(opts) {
    opts = opts || {};
    clearAuthTokens();
    if (!opts.force && jumpedRecently()) return false;
    return jumpToLogin(opts.returnUrl || location.href);
  }

  function installFetchAuth() {
    if (w.__BZF_FETCH_401_PATCHED) return;
    w.__BZF_FETCH_401_PATCHED = true;
    var raw = w.fetch;
    if (typeof raw !== 'function') return;
    w.fetch = function (input, init) {
      var url = requestUrl(input);
      var isApi = /\/api\/(juzhu|auth)\//.test(url);
      if (isApi) {
        init = Object.assign({ credentials: 'same-origin' }, init || {});
        if (!init.credentials) init.credentials = 'same-origin';
        var headers = new Headers(init.headers || (input && input.headers) || {});
        var lj = beikeAccessToken();
        if (lj && !headers.has('X-Lianjia-Token')) headers.set('X-Lianjia-Token', lj);
        var t = token();
        if (t && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + t);
        init.headers = headers;
      }
      var hadAuth = requestHadAuth(input, init) || !!(isApi && (beikeAccessToken() || token() || cookieSessionOk));
      return raw.call(this, input, init).then(function (res) {
        try {
          if (res && res.status === 401 && !isCredentialLoginUrl(url) &&
              (hadAuth || /\/api\/juzhu\//.test(url) || /\/api\/auth\//.test(url))) {
            handleUnauthorized();
          }
        } catch (e) {}
        return res;
      });
    };
  }
  installFetchAuth();

  function resumeAfterLogin() {
    trySyncIdentity(function (ok) {
      var next = '';
      try { next = sessionStorage.getItem(NEXT_KEY) || ''; } catch (e) {}
      if (!next || samePage(next, location.href)) return;
      if (ok || isLoggedIn()) {
        try { sessionStorage.removeItem(NEXT_KEY); } catch (e) {}
        location.href = next;
      }
    });
  }

  function gateThenGo(nextUrl) {
    var next = absUrl(nextUrl);
    trySyncIdentity(function (ok) {
      if (ok || isLoggedIn()) { location.href = next; return; }
      jumpToLogin(next);
    });
  }

  function ensureAppLogin(opts) {
    opts = opts || {};
    var onReady = opts.onReady || function () {};
    var onNeedPassword = opts.onNeedPassword || function () {};
    trySyncIdentity(function (ok) {
      if (ok || isLoggedIn()) { onReady(); return; }
      if (!jumpedRecently()) jumpToLogin(location.href);
      var once = function () {
        if (document.visibilityState && document.visibilityState !== 'visible') return;
        trySyncIdentity(function (again) {
          if (again || isLoggedIn()) onReady();
        });
      };
      w.addEventListener('pageshow', once);
      document.addEventListener('visibilitychange', once);
      // 回跳失败 / 非 ke.com 域拿不到票 → 密码兜底
      setTimeout(function () {
        if (!isLoggedIn()) onNeedPassword();
      }, 5000);
    });
  }

  function isAuthTabHref(href) {
    return /lvju-app-orders\.html|lvju-app-me\.html/.test(String(href || ''));
  }

  function bindAuthTabs() {
    document.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('.tabbar a') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (!isAuthTabHref(href) || a.classList.contains('on')) return;
      ev.preventDefault();
      ev.stopPropagation();
      clearJumped();
      gateThenGo(href);
    }, true);
  }
  function bootLoginResume() {
    bindAuthTabs();
    resolveLoginCfg(function () {});
    resumeAfterLogin();
    trySyncIdentity(function () {});
    w.addEventListener('pageshow', resumeAfterLogin);
    document.addEventListener('visibilitychange', function () {
      if (!document.visibilityState || document.visibilityState === 'visible') resumeAfterLogin();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootLoginResume);
  else bootLoginResume();

  w.BZF_BEIKE_LOGIN = {
    TOKEN_KEY: TOKEN_KEY,
    isBeikeApp: isBeikeApp,
    token: token,
    setToken: setToken,
    isLoggedIn: isLoggedIn,
    authHeaders: authHeaders,
    clearAuthTokens: clearAuthTokens,
    handleUnauthorized: handleUnauthorized,
    appUserInfo: appUserInfo,
    pickUser: pickUser,
    exchange: exchange,
    jumpToLogin: jumpToLogin,
    nativeLoginUrl: nativeLoginUrl,
    browserH5LoginUrl: browserH5LoginUrl,
    resolveLoginCfg: resolveLoginCfg,
    resolveLoginBase: resolveLoginBase,
    gateThenGo: gateThenGo,
    ensureAppLogin: ensureAppLogin,
    tryExchangeFromApp: tryExchangeFromApp,
    trySyncIdentity: trySyncIdentity,
    getCookie: getCookie,
    lianjiaToken: lianjiaToken,
    ljAccessToken: ljAccessToken,
    beikeLoggedIn: beikeLoggedIn,
    beikeAccessToken: beikeAccessToken,
    lastUser: lastUser
  };
})(window);
