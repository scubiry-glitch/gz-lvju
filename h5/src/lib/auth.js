/** C 端身份 = Cookie `lianjia_token`（Morph getCookie）；不换 BJZ */

import { Login, getCookie, getCurrentEnv } from '@ke/morph';

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

function authLog(...args) {
  try {
    console.log('[bzf-auth]', ...args);
  } catch {
    /* ignore */
  }
}

/** Morph getCurrentEnv：https://kedoc.ke.com/morph/docs/base/getCurrentEnv */
export function morphEnv() {
  try {
    return getCurrentEnv() || {};
  } catch (e) {
    authLog('getCurrentEnv error', e && e.message);
    return {};
  }
}

/** C 端贝壳 / 链家 App（hostEnv=beike|lianjia） */
export function isBeikeApp() {
  try {
    if (window.__BZF_IS_BEIKE_APP) return true;
  } catch {
    /* ignore */
  }
  const env = morphEnv();
  const ok = env.hostEnv === 'beike' || env.hostEnv === 'lianjia';
  authLog('isBeikeApp', { ok, hostEnv: env.hostEnv, isApp: env.isApp });
  return ok;
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
  const env = morphEnv();
  if (env.developmentEnv) return env.developmentEnv;
  const h = location.hostname || '';
  if (/localhost|127\.0\.0\.1/i.test(h) || /\.test\.ke\.com$/i.test(h) || /\.tt[abc]\.test\.ke\.com$/i.test(h)) {
    return 'test';
  }
  return 'production';
}

/** App 原生登录 scheme */
function appLoginScheme(back, hostEnv) {
  const path = 'actionlogin?param=' + encodeURIComponent(encodeURIComponent(back));
  try {
    if (window.JsBridgeV3 && typeof window.JsBridgeV3.getSchemeLink === 'function') {
      const linked = window.JsBridgeV3.getSchemeLink(path);
      if (linked) return linked;
    }
  } catch {
    /* ignore */
  }
  let scheme = hostEnv === 'lianjia' ? 'lianjia' : 'lianjiabeike';
  try {
    if (window.JsBridgeV3 && typeof window.JsBridgeV3.getScheme === 'function') {
      scheme = window.JsBridgeV3.getScheme() || scheme;
    }
  } catch {
    /* ignore */
  }
  return scheme + '://' + path;
}

/**
 * App → 原生 scheme（不依赖 $ljBridge.ready）；浏览器 → Morph mLogin（clogin）。
 */
export function jumpToLogin(returnUrl) {
  const back = absUrl(returnUrl || location.href);
  const env = morphEnv();
  const inApp = env.hostEnv === 'beike' || env.hostEnv === 'lianjia' || !!window.__BZF_IS_BEIKE_APP;
  const apiEnv = morphApiEnv();
  authLog('jumpToLogin', { back, inApp, hostEnv: env.hostEnv, isApp: env.isApp, apiEnv });

  if (inApp) {
    const scheme = appLoginScheme(back, env.hostEnv);
    authLog('jumpToLogin → scheme', scheme);
    location.href = scheme;
    return true;
  }

  authLog('jumpToLogin → clogin m', apiEnv);
  Login.toLogin({
    url: back,
    env: 'm',
    apiEnv,
  });
  return true;
}
