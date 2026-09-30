/** 贝壳 App 内身份：lianjia_token；浏览器登录走 @ke/morph Login.toLogin（对齐 Morph 文档） */

import { Login } from '@ke/morph';

const TOKEN_KEYS = ['lianjia_token', 'lianjia_tokne', 'lj_token'];

function readCookie(name) {
  try {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
  }
}

export function getLianjiaToken() {
  for (const k of TOKEN_KEYS) {
    const v = (readCookie(k) || '').trim();
    if (v) return v;
  }
  try {
    const q = new URLSearchParams(location.search).get('lianjia_token');
    if (q) return q.trim();
  } catch {
    /* ignore */
  }
  return '';
}

export function isLoggedIn() {
  return !!getLianjiaToken() || !!(localStorage.getItem('BJZ_TOKEN') || '').trim();
}

export function authHeaders(extra = {}) {
  const h = { ...extra };
  const lj = getLianjiaToken();
  if (lj) h['X-Lianjia-Token'] = lj;
  const bjz = (localStorage.getItem('BJZ_TOKEN') || localStorage.getItem('BZF_SESSION_TOKEN') || '').trim();
  if (bjz && !lj) h.Authorization = 'Bearer ' + bjz;
  if (!h.Authorization && !h['X-Lianjia-Token']) {
    const k = (localStorage.getItem('JUZHU_API_KEY') || '').trim();
    if (k) h.Authorization = 'Bearer ' + k;
  }
  return h;
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

/** Morph cookie 只落在 *.ke.com；本地域 / meizu.life 自动跳转回不来票 */
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

/** Morph apiEnv：localhost / *.test.ke.com → test，其余 production */
function morphApiEnv() {
  const h = location.hostname || '';
  if (/localhost|127\.0\.0\.1/i.test(h) || /\.test\.ke\.com$/i.test(h) || /\.tt[abc]\.test\.ke\.com$/i.test(h)) {
    return 'test';
  }
  return 'production';
}

/**
 * App → Morph env=app（原生）；浏览器 H5 → 强制 env=m（避免桌面被判成 pc）。
 * 文档：https://kedoc.ke.com/morph/docs/business/login
 */
export function jumpToLogin(returnUrl) {
  const back = absUrl(returnUrl || location.href);
  Login.toLogin({
    url: back,
    env: isBeikeApp() ? 'app' : 'm',
    apiEnv: morphApiEnv(),
  });
  return true;
}

export async function ensureBeikeSession() {
  const lj = getLianjiaToken();
  if (!lj) return null;
  try {
    const r = await fetch('/api/juzhu/auth/beike', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lianjia-Token': lj },
      body: JSON.stringify({ lianjia_token: lj }),
      credentials: 'same-origin',
    });
    const j = await r.json().catch(() => ({}));
    if (!(j && j.ok)) return null;
    if (j.token) {
      try {
        localStorage.setItem('BJZ_TOKEN', j.token);
        localStorage.setItem('BZF_SESSION_TOKEN', j.token);
      } catch {
        /* ignore */
      }
    }
    return j;
  } catch {
    /* ignore */
  }
  return null;
}
