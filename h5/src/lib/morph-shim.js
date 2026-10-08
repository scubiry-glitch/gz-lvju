/**
 * @ke/morph 本地等价 shim（仅当 node_modules 里装不到真包时由 vite alias 兜底）。
 *
 * 背景：@ke/morph 是贝壳内网私有包（artifactory.intra.ke.com），预览机 / 外网环境
 * 装不到，构建会因这一个 import 整体失败。H5 全部源码只用到它的两个导出：
 *   getCookie(name[, cookies]) / Login.toLogin({url, env, apiEnv})
 * 这里按 screens/_beike-login.js 的既有口径等价实现；内网环境装到真包后
 * vite.config.js 的条件 alias 会优先走真包，本文件不参与打包。
 *
 * 口径：C 端身份 = Cookie lianjia_token（规则 25）。
 */

/* Morph getCookie：必须传名字；getCookie() 空调用的结果是 "" 而不是全文 */
export function getCookie(cookieName, cookies) {
  cookieName = cookieName || '';
  let windowCookies = '';
  try {
    windowCookies = cookies == null || cookies === '' ? document.cookie || '' : cookies;
  } catch {
    windowCookies = '';
  }
  if (!cookieName || !windowCookies) return '';
  const parts = String(windowCookies).split(';');
  for (let i = 0; i < parts.length; i++) {
    const kv = parts[i].split('=');
    if (kv[0].trim() === String(cookieName).trim()) return (kv[1] || '').trim();
  }
  return '';
}

function absUrl(u) {
  try {
    return new URL(u || location.href, location.href).href;
  } catch {
    return String(u || location.href);
  }
}

function isTestHost() {
  const h = location.hostname || '';
  return /localhost|127\.0\.0\.1/i.test(h) || /\.test\.ke\.com$/i.test(h) || /\.tt[abc]\.test\.ke\.com$/i.test(h);
}

function loginCfg() {
  const host = location.hostname || '';
  const domainEnv = /\.lianjia\.com$/i.test(host) ? 'lianjia.com' : 'ke.com';
  const prefix = isTestHost() ? 'test-' : '';
  return {
    login_base: `https://${prefix}clogin.${domainEnv}`,
    service_base: `https://${prefix}m.${domainEnv}/my/checklogin`,
    type: 2,
  };
}

/* App 内：优先 JsBridgeV3 scheme（lianjiabeike://actionlogin?param=enc(enc(back))） */
function appLoginUrl(back) {
  const enc = encodeURIComponent(back);
  const path = `actionlogin?param=${encodeURIComponent(enc)}`;
  try {
    if (window.JsBridgeV3 && typeof window.JsBridgeV3.getSchemeLink === 'function') {
      const linked = window.JsBridgeV3.getSchemeLink(path);
      if (linked) return linked;
    }
  } catch {}
  let scheme = '';
  try {
    if (window.JsBridgeV3 && typeof window.JsBridgeV3.getScheme === 'function') scheme = window.JsBridgeV3.getScheme() || '';
  } catch {}
  if (!scheme) {
    let env = null;
    try { env = window.JsBridgeV3 && window.JsBridgeV3.getAPPEnv && window.JsBridgeV3.getAPPEnv(); } catch {}
    scheme = env && env.isLianjiaApp && !env.isBeike ? 'lianjia' : 'lianjiabeike';
  }
  return `${scheme}://${path}`;
}

/**
 * Morph m.ts：loginUrl?service=enc(serviceUrl?redirect=enc(url))&type=2
 * env='app' → 原生登录 scheme；env='m' → 浏览器 mLogin。
 */
export const Login = {
  toLogin(opts = {}) {
    const back = absUrl(opts.url);
    let href;
    if (opts.env === 'app') {
      href = appLoginUrl(back);
    } else {
      const cfg = loginCfg();
      const service = `${cfg.service_base}?redirect=${encodeURIComponent(back)}`;
      href = `${cfg.login_base}/login?service=${encodeURIComponent(service)}&type=${cfg.type}`;
    }
    location.href = href;
    return true;
  },
};

export default { getCookie, Login };
