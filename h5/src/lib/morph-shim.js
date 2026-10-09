/**
 * @ke/morph 本地等价 shim（仅当 node_modules 里装不到真包时由 vite alias 兜底）。
 *
 * 背景：@ke/morph 是贝壳内网私有包（artifactory.intra.ke.com），预览机 / 外网环境
 * 装不到，构建会因这一个 import 整体失败。H5 用到的导出：
 *   getCookie / Login.toLogin / getCurrentEnv
 * 内网装到真包后 vite.config.js 条件 alias 优先走真包，本文件不参与打包。
 *
 * 口径：C 端身份 = Cookie lianjia_token（规则 25）。
 * getCurrentEnv 文档：https://kedoc.ke.com/morph/docs/base/getCurrentEnv
 */

/** 对齐 Morph getCurrentEnv（精简：够用 isApp / hostEnv / developmentEnv） */
export function getCurrentEnv(userAgent, hostName) {
  const ua = userAgent || (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
  const host = hostName || (typeof location !== 'undefined' ? location.hostname : '') || '';
  const isBeike = /lianjiabeike/gim.test(ua);
  const isLianjia =
    /Lianjia/gim.test(ua) &&
    !/Alliance|lianjiabaichuan|lianjiaatom|Link|LiveInBeike|beikeanzhu|fanghuoji|beikesteward|beikejinggong|decorate|beike_rentplat|zhidao/gim.test(
      ua,
    );
  const isApp = isBeike || isLianjia;
  let hostEnv = 'm';
  if (isBeike) hostEnv = 'beike';
  else if (isLianjia) hostEnv = 'lianjia';
  else if (/Macintosh|windows/gim.test(ua) && !/mobile/gim.test(ua)) hostEnv = 'pc';
  let developmentEnv = 'production';
  if (/test/.test(host)) developmentEnv = 'test';
  else if (/preview/.test(host)) developmentEnv = 'preview';
  else if (/0\.0\.0\.0|127\.0\.0\.1|localhost|dev/.test(host)) developmentEnv = 'development';
  return {
    isApp,
    hostEnv,
    domainEnv: host.indexOf('lianjia.com') > -1 ? 'lianjia.com' : 'ke.com',
    developmentEnv,
    os: /iphone|ipad/gim.test(ua) ? 'ios' : /android|adr/gim.test(ua) ? 'android' : 'android',
  };
}

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
 * 对齐 Morph Login.toLogin：不传 env 时按 getCurrentEnv 分流。
 * https://kedoc.ke.com/morph/docs/business/login
 */
export const Login = {
  toLogin(opts = {}) {
    const back = absUrl(opts.url);
    const forced = opts.env || '';
    const cur = getCurrentEnv();
    const hostEnv = forced || cur.hostEnv || 'm';
    const useApp =
      forced === 'app' ||
      hostEnv === 'beike' ||
      hostEnv === 'lianjia' ||
      hostEnv === 'app' ||
      (!forced && cur.isApp);
    if (useApp) {
      if (window.$ljBridge && typeof window.$ljBridge.ready === 'function') {
        window.$ljBridge.ready((bridge, webStatus) => {
          if (webStatus && webStatus.isApp) window.__BZF_IS_BEIKE_APP = true;
          if (bridge && typeof bridge.actionLogin === 'function') {
            bridge.actionLogin(encodeURIComponent(back));
            return;
          }
          location.href = appLoginUrl(back);
        });
        return true;
      }
      location.href = appLoginUrl(back);
      return true;
    }
    const cfg = loginCfg();
    const service = `${cfg.service_base}?redirect=${encodeURIComponent(back)}`;
    location.href = `${cfg.login_base}/login?service=${encodeURIComponent(service)}&type=${cfg.type}`;
    return true;
  },
};

export default { getCookie, getCurrentEnv, Login };
