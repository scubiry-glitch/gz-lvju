/** C 端身份 = Cookie `lianjia_token`（Morph getCookie）；不换 BJZ */

import { Login, getCookie, getCurrentEnv } from '@ke/morph';

/** Morph App 登录依赖 $ljBridge；页面未注入时补载官方 bridge（与 Morph appLogin 配套） */
const LJ_BRIDGE_SDK = '//s1.ljcdn.com/m-base/release/v04.4/asset/bridge_d0b9f70cd88e0a5q.js';
let _ljBridgeP = null;

/** 只从 cookie 取 lianjia_token（Morph 口径须传名字） */
export function getLianjiaToken() {
  try {
    const v = getCookie('lianjia_token') || getCookie('lj_token') || '';
    return String(v).trim();
  } catch {
    return '';
  }
}

/** 调试：打印 Morph getCookie('lianjia_token') 是否有值 */
export function logLianjiaTokenCookie(tag) {
  let lj = '';
  let alt = '';
  try {
    lj = String(getCookie('lianjia_token') || '').trim();
    alt = String(getCookie('lj_token') || '').trim();
  } catch {
    /* ignore */
  }
  authLog('getCookie(lianjia_token)', {
    tag: tag || '',
    hasValue: !!lj,
    length: lj.length,
    value: lj || '(empty)',
    lj_token_hasValue: !!alt,
    lj_token_length: alt.length,
    lj_token_value: alt || '(empty)',
  });
  return lj || alt;
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

/** https://kedoc.ke.com/morph/docs/base/getCurrentEnv */
export function morphEnv() {
  try {
    return getCurrentEnv() || {};
  } catch (e) {
    authLog('getCurrentEnv error', e && e.message);
    return {};
  }
}

/** Morph：hostEnv=beike|lianjia，或 isApp */
export function isBeikeApp() {
  try {
    if (window.__BZF_IS_BEIKE_APP) return true;
  } catch {
    /* ignore */
  }
  const env = morphEnv();
  const ok = env.hostEnv === 'beike' || env.hostEnv === 'lianjia' || !!env.isApp;
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
  return 'production';
}

function ensureLjBridge() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.$ljBridge) return Promise.resolve(window.$ljBridge);
  if (_ljBridgeP) return _ljBridgeP;
  _ljBridgeP = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = (location.protocol === 'http:' ? 'https:' : location.protocol) + LJ_BRIDGE_SDK;
    s.async = true;
    s.onload = () => {
      authLog('ljBridge script ok', !!window.$ljBridge);
      resolve(window.$ljBridge || null);
    };
    s.onerror = () => {
      authLog('ljBridge script fail');
      resolve(null);
    };
    (document.head || document.documentElement).appendChild(s);
  });
  return _ljBridgeP;
}

/**
 * 登录跳转走 @ke/morph Login.toLogin（文档与 getCurrentEnv 自动分流 App / m）。
 * https://kedoc.ke.com/morph/docs/business/login
 * App 路径内部用 $ljBridge.actionLogin，故先 ensure  bridge。
 */
export function jumpToLogin(returnUrl) {
  const back = absUrl(returnUrl || location.href);
  const env = morphEnv();
  const apiEnv = morphApiEnv();
  authLog('jumpToLogin → Morph Login.toLogin', {
    back,
    hostEnv: env.hostEnv,
    isApp: env.isApp,
    apiEnv,
  });

  const run = () => {
    // 不传 env：Morph 用 getCurrentEnv().hostEnv / isApp 决定 beike→appLogin、m→clogin
    Login.toLogin({ url: back, apiEnv });
  };

  if (env.isApp || env.hostEnv === 'beike' || env.hostEnv === 'lianjia') {
    ensureLjBridge().then(run).catch(run);
    return true;
  }
  run();
  return true;
}
