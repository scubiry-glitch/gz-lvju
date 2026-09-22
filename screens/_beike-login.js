/* _beike-login.js · C 端订房登录闸（贝壳 App 原生登录 + pcLogin.js）
 *
 * 用法（详情 / 下单页，jsbridgesdk.js 之后）：
 *   <script src="jsbridgesdk.js?v=1"></script>
 *   <script src="screens/_beike-login.js"></script>
 *   BZF_BEIKE_LOGIN.gateThenGo(nextUrl);
 *
 * 口径：
 *  1. 已有 BJZ_TOKEN → 直接放行。
 *  2. 贝壳/链家 App 内：JsBridgeV3.getUserInfo 有身份则换会话；没有则跳转登录页
 *     （scheme://user/login，失败回落 clogin.ke.com?service=回跳地址）。
 *  3. 非 App：动态加载 https://s1.ljcdn.com/clogin/js/pcLogin.js（BeikeLoginSDK），
 *     已登录则换会话；未登录交给页面密码门（不在详情页弹 PC 滑块）。
 *  4. 登录回跳 2 分钟内仍无身份 → 不再连跳，避免死循环。
 */
(function (w) {
  'use strict';
  var TOKEN_KEY = 'BJZ_TOKEN';
  var JUMP_KEY = 'bzf_beike_login_jumped';
  var PC_SDK = 'https://s1.ljcdn.com/clogin/js/pcLogin.js';
  var CLOGIN = 'https://clogin.ke.com/login';
  var _pcP = null;

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

  function loadPcLogin() {
    if (w.BeikeLoginSDK) return Promise.resolve(w.BeikeLoginSDK);
    if (_pcP) return _pcP;
    _pcP = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = PC_SDK;
      s.async = true;
      s.onload = function () { resolve(w.BeikeLoginSDK || null); };
      s.onerror = function () { resolve(null); };
      (document.head || document.documentElement).appendChild(s);
    });
    return _pcP;
  }

  function pcUserInfo() {
    return loadPcLogin().then(function (sdk) {
      if (!sdk || typeof sdk.getUserInfo !== 'function') return null;
      return new Promise(function (resolve) {
        var done = false;
        var finish = function (info) {
          if (done) return;
          done = true;
          resolve(unwrap(info));
        };
        try { sdk.getUserInfo(finish); } catch (e) { resolve(null); return; }
        setTimeout(function () { finish(null); }, 2000);
      });
    }).catch(function () { return null; });
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
    var back = absUrl(returnUrl || location.href);
    var clogin = CLOGIN + '?service=' + encodeURIComponent(back);
    markJumped();
    initBridge();
    if (isBeikeApp() && w.JsBridgeV3 && typeof w.JsBridgeV3.navigateTo === 'function') {
      var native = null;
      try {
        var scheme = typeof w.JsBridgeV3.getScheme === 'function' ? w.JsBridgeV3.getScheme() : '';
        if (scheme && typeof w.JsBridgeV3.getSchemeLink === 'function') {
          native = w.JsBridgeV3.getSchemeLink('user/login?url=' + encodeURIComponent(back));
        }
      } catch (e) { native = null; }
      w.JsBridgeV3.navigateTo({
        url: native || clogin,
        fail: function () {
          w.JsBridgeV3.navigateTo({ url: clogin, fail: function () { location.href = clogin; } });
        }
      });
      return;
    }
    loadPcLogin().then(function (sdk) {
      if (sdk && typeof sdk.init === 'function') {
        try { sdk.init(0, function () { location.href = back; }); return; } catch (e) {}
      }
      location.href = clogin;
    });
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
    pcUserInfo().then(function (info) {
      return exchange(info);
    }).then(function (j) { if (j) onReady(); });
  }

  w.BZF_BEIKE_LOGIN = {
    TOKEN_KEY: TOKEN_KEY,
    isBeikeApp: isBeikeApp,
    token: token,
    setToken: setToken,
    appUserInfo: appUserInfo,
    pickUser: pickUser,
    exchange: exchange,
    jumpToLogin: jumpToLogin,
    gateThenGo: gateThenGo,
    ensureAppLogin: ensureAppLogin,
    loadPcLogin: loadPcLogin
  };
})(window);
