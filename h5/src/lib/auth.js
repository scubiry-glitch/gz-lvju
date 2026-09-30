/** 贝壳 App 内身份：lianjia_token；浏览器侧 Morph 登录跳转 */

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

function hostEnv() {
  const h = location.hostname || '';
  if (/^(localhost|127\.0\.0\.1)$/i.test(h) || /\.test\.ke\.com$/i.test(h)) return 'test';
  return 'prod';
}

/** Morph cookie 只落在 *.ke.com；本地域 / meizu.life 自动跳转回不来票 */
export function morphCookieLikely() {
  const h = location.hostname || '';
  if (isBeikeApp()) return true;
  return /\.ke\.com$/i.test(h);
}

/** Morph H5：clogin → checklogin → 回跳 */
export function jumpToLogin(returnUrl) {
  const ret = returnUrl || location.href;
  const env = hostEnv();
  const clogin = env === 'test' ? 'https://test-clogin.ke.com' : 'https://clogin.ke.com';
  const checkHost = env === 'test' ? 'https://test-m.ke.com' : 'https://m.ke.com';
  const check = checkHost + '/my/checklogin?redirect=' + encodeURIComponent(ret);
  location.href = clogin + '/login?service=' + encodeURIComponent(check) + '&jumpEncryptInfo=';
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
