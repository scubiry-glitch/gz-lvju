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

export function isBeikeApp() {
  try {
    if (window.__BZF_IS_BEIKE_APP) return true;
    const ua = navigator.userAgent || '';
    if (/lianjia|beike|ke\.com/i.test(ua) && (window.JsBridgeV3 || window.LJBridge || window.jsbridge3)) return true;
    return !!(window.JsBridgeV3 || window.BeiKeSdk || window.__beikeSdk);
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

/** App → env=app；浏览器 → env=m。https://kedoc.ke.com/morph/docs/business/login */
export function jumpToLogin(returnUrl) {
  const back = absUrl(returnUrl || location.href);
  Login.toLogin({
    url: back,
    env: isBeikeApp() ? 'app' : 'm',
    apiEnv: morphApiEnv(),
  });
  return true;
}
