/** C 端身份 = Cookie `lianjia_token`（Morph getCookie）；不换 BJZ */

import { Login, getCookie } from '@ke/morph';

/** 只从 cookie 取 lianjia_token（Morph 口径须传名字） */
export function getLianjiaToken() {
  try {
    const v = getCookie('lianjia_token') || getCookie('lj_token') || '';
    return String(v).trim();
  } catch {
    return '';
  }
}

/** 本地可读 cookie；HttpOnly 时以壳层 /auth/me 为准 */
export function isLoggedIn() {
  return !!getLianjiaToken();
}

/**
 * C 端：请求只靠 Cookie `lianjia_token`（credentials），服务端不读 X-Lianjia-Token。
 * 可读 cookie 仅用于本地 isLoggedIn 判断；HttpOnly 时以 /auth/me 为准。
 */
export function authHeaders(extra = {}) {
  return { ...extra };
}

export function maskPhone(p) {
  p = String(p || '');
  return /^1\d{10}$/.test(p) ? p.slice(0, 3) + '****' + p.slice(7) : p || '已登录';
}

/** 与 screens/_beike-login.js 同口径：UA / getAPPEnv 即可，不依赖页面是否引入 jsbridgesdk */
export function isBeikeApp() {
  try {
    if (window.__BZF_IS_BEIKE_APP) return true;
  } catch {
    /* ignore */
  }
  try {
    if (window.JsBridgeV3 && typeof window.JsBridgeV3.getAPPEnv === 'function') {
      const env = window.JsBridgeV3.getAPPEnv();
      if (env && (env.isBeike || env.isLianjiaApp)) return true;
    }
  } catch {
    /* ignore */
  }
  try {
    const ua = navigator.userAgent || '';
    return (
      /lianjiabeike/i.test(ua) ||
      /Lianjia\/Beike/i.test(ua) ||
      (/Lianjia/i.test(ua) &&
        !/Alliance|lianjiabaichuan|beikesteward|beike_rentplat|decorate|LiveInBeike|beikeanzhu|fanghuoji/i.test(ua))
    );
  } catch {
    return false;
  }
}

export function morphCookieLikely() {
  const h = location.hostname || '';
  if (isBeikeApp()) return true;
  return /\.ke\.com$/i.test(h);
}

function absUrl(u) {
  try {
    return new URL(u || location.href, location.href).href;
  } catch {
    return String(u || location.href);
  }
}

function morphApiEnv() {
  const h = location.hostname || '';
  if (/localhost|127\.0\.0\.1/i.test(h) || /\.test\.ke\.com$/i.test(h) || /\.tt[abc]\.test\.ke\.com$/i.test(h)) {
    return 'test';
  }
  return 'production';
}

/** App 原生登录 scheme（Morph app 路径只认 $ljBridge，未注入时走此兜底） */
function appLoginScheme(back) {
  const path = 'actionlogin?param=' + encodeURIComponent(encodeURIComponent(back));
  try {
    if (window.JsBridgeV3 && typeof window.JsBridgeV3.getSchemeLink === 'function') {
      const linked = window.JsBridgeV3.getSchemeLink(path);
      if (linked) return linked;
    }
  } catch {
    /* ignore */
  }
  let scheme = 'lianjiabeike';
  try {
    if (window.JsBridgeV3 && typeof window.JsBridgeV3.getScheme === 'function') {
      scheme = window.JsBridgeV3.getScheme() || scheme;
    }
  } catch {
    /* ignore */
  }
  try {
    const env = window.JsBridgeV3 && window.JsBridgeV3.getAPPEnv && window.JsBridgeV3.getAPPEnv();
    if (env && env.isLianjiaApp && !env.isBeike) scheme = 'lianjia';
  } catch {
    /* ignore */
  }
  return scheme + '://' + path;
}

/**
 * App → 原生登录（$ljBridge / scheme）；浏览器 → Morph mLogin（clogin）。
 * https://kedoc.ke.com/morph/docs/business/login
 */
export function jumpToLogin(returnUrl) {
  const back = absUrl(returnUrl || location.href);
  if (isBeikeApp()) {
    try {
      if (window.$ljBridge && typeof window.$ljBridge.ready === 'function') {
        Login.toLogin({ url: back, env: 'app', apiEnv: morphApiEnv() });
        return true;
      }
    } catch {
      /* fall through */
    }
    location.href = appLoginScheme(back);
    return true;
  }
  Login.toLogin({
    url: back,
    env: 'm',
    apiEnv: morphApiEnv(),
  });
  return true;
}
