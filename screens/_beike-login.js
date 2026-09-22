/* _beike-login.js · C 端订房登录闸（只跳贝壳/链家 App 原生登录）
 *
 * 用法（详情 / 下单 / 订单 / 我的，以及带 tabbar 的 C 端页）：
 *   <script src="jsbridgesdk.js?v=1"></script>
 *   <script src="screens/_beike-login.js"></script>
 *   BZF_BEIKE_LOGIN.gateThenGo(nextUrl);
 *   引入后自动拦截 tabbar「订单 / 我的」点击。
 *
 * 口径：
 *  1. 已有 BJZ_TOKEN → 直接放行。
 *  2. 贝壳/链家 App 内：JsBridgeV3.getUserInfo 有身份则换会话；没有则按 Morph
 *     Login.toLogin(env=app)：$ljBridge.actionLogin(encodeURIComponent(回跳))。
 *     无 $ljBridge 时回落 scheme://actionlogin?param=…（与 Morph 旧 bridge 同源）。
 *  3. 非 App（浏览器）：不唤起 App、不跳 H5 登录页，交给页面密码门。
 *  4. 登录回跳 2 分钟内仍无身份 → 不再连跳，避免死循环。
 */
(function (w) {
  'use strict';
  var TOKEN_KEY = 'BJZ_TOKEN';
  var JUMP_KEY = 'bzf_beike_login_jumped';

  function token() {
    try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, String(t).trim());
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }
  function absUrl(u) {
    try { return new URL(u, location.href).href; } catch (e) { return u || location.href; }
  }

  function isBeikeApp() {
    try {
      if (w.JsBridgeV3 && typeof w.JsBridgeV3.getAPPEnv === 'function') {
        var env = w.JsBridgeV3.getAPPEnv();
        if (env && (env.isBeike || env.isLianjiaApp)) return true;
      }
    } catch (e) {}
    var ua = navigator.userAgent || '';
    return /lianjiabeike/i.test(ua) ||
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
    var phone = String(i.phone || i.mobile || i.phoneNumber || i.mobilePhone || '').replace(/\s/g, '');
    if (!uid) return null;
    return {
      uid: String(uid),
      phone: phone,
      name: String(i.name || i.displayName || i.display_name || i.userName || i.username || '').trim()
    };
  }

  function appUserInfo() {
    initBridge();
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

  // Morph 旧 bridge 回落：scheme://actionlogin?param=<encodeURIComponent(encodeURIComponent(回跳))>
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
            lj.ready(function (bridge) {
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

  function exchange(info) {
    var u = pickUser(info);
    if (!u || !/^1\d{10}$/.test(u.phone)) return Promise.resolve(null);
    return fetch('/api/juzhu/auth/beike', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(u)
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && j.token) { setToken(j.token); return j; }
      return null;
    }).catch(function () { return null; });
  }

  function jumpedRecently() {
    try {
      var t = +sessionStorage.getItem(JUMP_KEY) || 0;
      return t > 0 && (Date.now() - t) < 120000;
    } catch (e) { return false; }
  }
  function markJumped() {
    try { sessionStorage.setItem(JUMP_KEY, String(Date.now())); } catch (e) {}
  }

  function jumpToLogin(returnUrl) {
    if (!isBeikeApp()) return false;
    var back = absUrl(returnUrl || location.href);
    markJumped();
    initBridge();
    // 与 Morph Login.toLogin({ env:'app' }) 对齐：优先 $ljBridge.actionLogin
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

  /* 详情页「订」：App 未登录先跳登录（回跳到下单页）；已登录/非 App 直接去 nextUrl */
  function gateThenGo(nextUrl) {
    var next = absUrl(nextUrl);
    if (token()) { location.href = next; return; }
    var app = appUserInfo();
    if (pickUser(app)) {
      exchange(app).then(function () { location.href = next; });
      return;
    }
    if (isBeikeApp() && !jumpedRecently()) { jumpToLogin(next); return; }
    location.href = next;
  }

  /* 下单页：App 未登录跳登录；有身份则换票；否则走密码门 */
  function ensureAppLogin(opts) {
    opts = opts || {};
    var onReady = opts.onReady || function () {};
    var onNeedPassword = opts.onNeedPassword || function () {};
    if (token()) { onReady(); return; }
    var app = appUserInfo();
    if (pickUser(app)) {
      exchange(app).then(function (j) { if (j) onReady(); else onNeedPassword(); });
      return;
    }
    if (isBeikeApp() && !jumpedRecently()) {
      jumpToLogin(location.href);
      var once = function () {
        if (document.visibilityState && document.visibilityState !== 'visible') return;
        var again = appUserInfo();
        if (pickUser(again)) {
          exchange(again).then(function (j) { if (j) onReady(); else onNeedPassword(); });
        } else if (jumpedRecently()) {
          onNeedPassword();
        }
      };
      w.addEventListener('pageshow', once);
      document.addEventListener('visibilitychange', once);
      return;
    }
    onNeedPassword();
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
      gateThenGo(href);
    }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindAuthTabs);
  else bindAuthTabs();

  w.BZF_BEIKE_LOGIN = {
    TOKEN_KEY: TOKEN_KEY,
    isBeikeApp: isBeikeApp,
    token: token,
    setToken: setToken,
    appUserInfo: appUserInfo,
    pickUser: pickUser,
    exchange: exchange,
    jumpToLogin: jumpToLogin,
    nativeLoginUrl: nativeLoginUrl,
    gateThenGo: gateThenGo,
    ensureAppLogin: ensureAppLogin
  };
})(window);
