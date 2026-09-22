/* _beike-login.js · C 端订房登录闸（只跳贝壳/链家 App 原生登录）
 *
 * 用法（详情 / 下单 / 订单 / 我的，以及带 tabbar 的 C 端页）：
 *   <script src="jsbridgesdk.js?v=1"></script>
 *   <script src="screens/_beike-login.js"></script>
 *   BZF_BEIKE_LOGIN.gateThenGo(nextUrl);
 *   引入后自动拦截 tabbar「订单 / 我的」点击。
 *
 * 口径（wiki 登录常见问题 · APP端接入）：
 *  1. 已有 BJZ_TOKEN → 直接放行。
 *  2. 从 App 共享存储取 lianjia_token（$ljBridge.getAccessToken / cookie），
 *     POST /api/juzhu/auth/beike 由服务端 /token/verify 换 BJZ_TOKEN。
 *     不拿 getUserInfo 的 uid+手机号当身份。
 *  3. 没有 token：App 内 $ljBridge.actionLogin(当前页)；浏览器走密码门。
 *  4. 登录回跳无 JS 回调，回跳后再读 token。
 */
(function (w) {
  'use strict';
  var TOKEN_KEY = 'BJZ_TOKEN';
  var JUMP_KEY = 'bzf_beike_login_jumped';
  var NEXT_KEY = 'bzf_beike_login_next';
  var USER_KEY = 'bzf_beike_user';

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

  function lianjiaToken() {
    return getCookie('lianjia_token') || getCookie('lj_token') || '';
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

  /* 换票用的票：App 共享存储 / cookie，不要用 getUserInfo */
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

  /* 贝壳侧已登录：有 lianjia_token 即可，getUserInfo 只作展示兜底 */
  function beikeLoggedIn() {
    if (beikeAccessToken()) return true;
    if (pickUser(appUserInfo())) return true;
    return false;
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

  /* 登录回跳后：读 lianjia_token 换 BJZ_TOKEN。刚回跳时 bridge 可能要等几拍。 */
  function tryExchangeFromApp(done) {
    done = typeof done === 'function' ? done : function () {};
    if (token()) { done(true); return; }
    var tries = 0;
    var hint = jumpedRecently() || !!beikeAccessToken();
    var max = hint ? 8 : 1;
    function once() {
      if (token()) { done(true); return; }
      if (beikeAccessToken()) {
        exchange().then(function (j) { done(!!j); });
        return;
      }
      tries += 1;
      if (tries < max) setTimeout(once, 400);
      else done(false);
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

  function jumpToLogin(returnUrl) {
    if (!isBeikeApp()) return false;
    if (returnUrl) saveNext(returnUrl);
    // 回跳必须是当前页：把目标页传给 actionLogin 会先打开「我的/订单」，取消登录也会停在那里
    var back = location.href;
    markJumped();
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

  function resumeAfterLogin() {
    tryExchangeFromApp(function (ok) {
      var next = '';
      try { next = sessionStorage.getItem(NEXT_KEY) || ''; } catch (e) {}
      if (!next || samePage(next, location.href)) return;
      if (ok || token()) {
        try { sessionStorage.removeItem(NEXT_KEY); } catch (e) {}
        location.href = next;
      }
    });
  }

  /* 详情页「订」/ tab「订单·我的」：没登录每次都弹登录，成功后再去目标页；取消留在当前页。
     不读 jumpedRecently：那是防页面自动连跳，用户再点必须再弹。 */
  function gateThenGo(nextUrl) {
    var next = absUrl(nextUrl);
    if (token()) { location.href = next; return; }
    if (beikeAccessToken()) {
      tryExchangeFromApp(function (ok) {
        if (ok || token()) { location.href = next; return; }
        if (isBeikeApp()) jumpToLogin(next);
        else location.href = next;
      });
      return;
    }
    if (isBeikeApp()) {
      jumpToLogin(next);
      return;
    }
    location.href = next;
  }

  /* 下单页：App 未登录跳登录；有身份则换票；否则走密码门 */
  function ensureAppLogin(opts) {
    opts = opts || {};
    var onReady = opts.onReady || function () {};
    var onNeedPassword = opts.onNeedPassword || function () {};
    if (token()) { onReady(); return; }
    tryExchangeFromApp(function (ok) {
      if (ok || token()) { onReady(); return; }
      if (isBeikeApp() || beikeLoggedIn()) {
        if (!jumpedRecently()) jumpToLogin(location.href);
        var once = function () {
          if (document.visibilityState && document.visibilityState !== 'visible') return;
          tryExchangeFromApp(function (again) {
            if (again || token()) onReady();
          });
        };
        w.addEventListener('pageshow', once);
        document.addEventListener('visibilitychange', once);
        setTimeout(function () {
          if (!token()) onNeedPassword();
        }, 4000);
        return;
      }
      onNeedPassword();
    });
    return;
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
    resumeAfterLogin();
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
    appUserInfo: appUserInfo,
    pickUser: pickUser,
    exchange: exchange,
    jumpToLogin: jumpToLogin,
    nativeLoginUrl: nativeLoginUrl,
    gateThenGo: gateThenGo,
    ensureAppLogin: ensureAppLogin,
    tryExchangeFromApp: tryExchangeFromApp,
    getCookie: getCookie,
    lianjiaToken: lianjiaToken,
    ljAccessToken: ljAccessToken,
    beikeLoggedIn: beikeLoggedIn,
    beikeAccessToken: beikeAccessToken,
    lastUser: lastUser
  };
})(window);
