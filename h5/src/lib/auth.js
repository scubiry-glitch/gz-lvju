/** 贝壳 App 内身份：lianjia_token；浏览器 Morph 登录对齐 screens/_beike-login.js */

const TOKEN_KEYS = ['lianjia_token', 'lianjia_tokne', 'lj_token'];
const LJ_BRIDGE_SDK = '//s1.ljcdn.com/m-base/release/v04.4/asset/bridge_d0b9f70cd88e0a5q.js';

let _loginCfg = null;
let _loginCfgP = null;
let _ljP = null;

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

/** Morph mLogin 默认：clogin + m 站 checklogin；type=2 */
function defaultLoginCfg() {
  const host = location.hostname || '';
  const domainEnv = /\.lianjia\.com$/i.test(host) ? 'lianjia.com' : 'ke.com';
  const isTest =
    /\.tt[abc]\.test\.ke\.com$/i.test(host) ||
    /\.test\.ke\.com$/i.test(host) ||
    /localhost|127\.0\.0\.1/i.test(host);
  const prefix = isTest ? 'test-' : '';
  return {
    login_base: 'https://' + prefix + 'clogin.' + domainEnv,
    service_base: 'https://' + prefix + 'm.' + domainEnv + '/my/checklogin',
    type: 2,
  };
}

function resolveLoginCfg() {
  if (_loginCfg) return Promise.resolve(_loginCfg);
  if (window.__BZF_BEIKE_H5_LOGIN__) {
    const o = window.__BZF_BEIKE_H5_LOGIN__;
    if (typeof o === 'string') {
      _loginCfg = { ...defaultLoginCfg(), login_base: String(o).replace(/\/$/, '') };
    } else {
      _loginCfg = { ...defaultLoginCfg(), ...(o || {}) };
    }
    return Promise.resolve(_loginCfg);
  }
  if (_loginCfgP) return _loginCfgP;
  _loginCfgP = fetch('/api/juzhu/auth/beike-config', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((j) => {
      const d = defaultLoginCfg();
      _loginCfg = {
        login_base: j && j.login_base ? String(j.login_base).replace(/\/$/, '') : d.login_base,
        service_base: j && j.service_base ? String(j.service_base).replace(/\/$/, '') : d.service_base,
        type: j && j.type != null ? j.type : 2,
      };
      return _loginCfg;
    })
    .catch(() => {
      _loginCfg = defaultLoginCfg();
      return _loginCfg;
    });
  return _loginCfgP;
}

/** Morph m.ts: loginUrl?service=enc(serviceUrl?redirect=enc(url))&type=2 */
export function browserH5LoginUrl(back, cfg) {
  const c = cfg || _loginCfg || defaultLoginCfg();
  const redirect = absUrl(back || location.href);
  const service = c.service_base + '?redirect=' + encodeURIComponent(redirect);
  return c.login_base + '/login?service=' + encodeURIComponent(service) + '&type=' + (c.type != null ? c.type : 2);
}

function loadLjBridge() {
  if (window.$ljBridge) return Promise.resolve(window.$ljBridge);
  if (_ljP) return _ljP;
  _ljP = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = (location.protocol === 'http:' ? 'https:' : location.protocol) + LJ_BRIDGE_SDK;
    s.async = true;
    s.onload = () => resolve(window.$ljBridge || null);
    s.onerror = () => resolve(null);
    (document.head || document.documentElement).appendChild(s);
  });
  return _ljP;
}

function nativeLoginUrl(back) {
  const path = 'actionlogin?param=' + encodeURIComponent(encodeURIComponent(back));
  try {
    if (window.JsBridgeV3 && typeof window.JsBridgeV3.getSchemeLink === 'function') {
      const linked = window.JsBridgeV3.getSchemeLink(path);
      if (linked) return linked;
    }
  } catch {
    /* ignore */
  }
  let scheme = '';
  try {
    if (window.JsBridgeV3 && typeof window.JsBridgeV3.getScheme === 'function') {
      scheme = window.JsBridgeV3.getScheme() || '';
    }
  } catch {
    /* ignore */
  }
  if (!scheme) {
    let env = null;
    try {
      env = window.JsBridgeV3 && window.JsBridgeV3.getAPPEnv && window.JsBridgeV3.getAPPEnv();
    } catch {
      /* ignore */
    }
    scheme = env && env.isLianjiaApp && !env.isBeike ? 'lianjia' : 'lianjiabeike';
  }
  return scheme + '://' + path;
}

function morphAppLogin(back) {
  return loadLjBridge().then((lj) => {
    if (lj && typeof lj.ready === 'function') {
      return new Promise((resolve) => {
        try {
          lj.ready((bridge, webStatus) => {
            if (webStatus && webStatus.isApp) window.__BZF_IS_BEIKE_APP = true;
            if (bridge && typeof bridge.actionLogin === 'function') {
              bridge.actionLogin(encodeURIComponent(back));
              resolve(true);
              return;
            }
            resolve(false);
          });
        } catch {
          resolve(false);
        }
      });
    }
    return false;
  });
}

/**
 * App → 原生登录；浏览器 → Morph mLogin（beike-config + type=2）。
 * returnUrl 为登录成功回跳（须绝对地址，如 origin+/h5/orders）。
 */
export function jumpToLogin(returnUrl) {
  const back = absUrl(returnUrl || location.href);
  if (isBeikeApp()) {
    morphAppLogin(back).then((ok) => {
      if (ok) return;
      const url = nativeLoginUrl(back);
      if (window.JsBridgeV3 && typeof window.JsBridgeV3.navigateTo === 'function') {
        window.JsBridgeV3.navigateTo({ url, fail: () => { location.href = url; } });
      } else {
        location.href = url;
      }
    });
    return true;
  }
  resolveLoginCfg().then((cfg) => {
    location.href = browserH5LoginUrl(back, cfg);
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
