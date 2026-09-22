'use strict';
/**
 * 贝壳 session 验票（C 端 App 内 H5）。
 * 口径：H5 从 jsbridge 取 lianjia_token，服务端 POST /token/verify，不信前端 uid/手机号。
 * 文档：wiki 登录常见问题 APP端接入 + session服务接口文档 验证Token。
 * 仅内网 http，不走 https。
 */

function isProduction() {
  const env = (process.env.JUZHU_ENV || '').trim().toLowerCase();
  return env === 'prod' || env === 'production';
}

/** tta/ttb/ttc 测试域默认对（登录 FAQ「浏览器端接入」）。生产禁止用这对。 */
const TTC_TEST_SOURCE = 'test-tta-ttb';
const TTC_TEST_SIGNATURE = 'VDTrskG3nlu6QVipfeQ4G8KIZPGif15U';

function config() {
  const prod = isProduction();
  const source = (process.env.SESSION_SOURCE || '').trim() || (prod ? '' : TTC_TEST_SOURCE);
  const signature = (process.env.SESSION_SIGNATURE || '').trim() || (prod ? '' : TTC_TEST_SIGNATURE);
  const base = ((process.env.SESSION_VERIFY_URL || '').trim()
    || (prod ? 'http://i.session.lianjia.com' : 'http://test3-i.token.lianjia.com'))
    .replace(/\/$/, '');
  return { source, signature, base, prod };
}

function normalizeMobile(s) {
  let raw = String(s || '').replace(/\D/g, '');
  if (raw.length === 13 && raw.indexOf('86') === 0) raw = raw.slice(2);
  return /^1\d{10}$/.test(raw) ? raw : '';
}

function pickUser(data) {
  const tokenInfo = (data && data.token_info) || {};
  const userInfo = (data && data.user_info) || {};
  const ucid = tokenInfo.ucid || userInfo.id || (data && data.ucid);
  if (ucid == null || String(ucid).trim() === '') return null;
  return {
    ucid: String(ucid).trim(),
    phone: normalizeMobile(userInfo.mobile || userInfo.phone || userInfo.mobilePhone),
    displayName: String(userInfo.displayName || userInfo.realName || userInfo.nickName || '').trim(),
  };
}

/**
 * @param {string} token lianjia_token / accessToken
 * @param {{ referer?: string }} [opts]
 * @returns {Promise<{ok:true, ucid:string, phone:string, displayName:string}|{ok:false, error:string, error_code?:number, status:number}>}
 */
async function verify(token, opts) {
  const t = String(token || '').trim();
  if (!t) return { ok: false, error: '缺少 lianjia_token', status: 400 };
  const cfg = config();
  if (!cfg.source || !cfg.signature) {
    return { ok: false, error: '未配置 SESSION_SOURCE / SESSION_SIGNATURE', status: 501 };
  }
  const url = cfg.base + '/token/verify';
  const referer = String((opts && opts.referer) || process.env.SESSION_REFERER || 'http://localhost/');
  const body = new URLSearchParams({
    source: cfg.source,
    signature: cfg.signature,
    token: t,
  }).toString();
  let json;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Referer: referer,
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    try { json = JSON.parse(text); } catch (_) {
      return { ok: false, error: 'session 验票响应无法解析', status: 502 };
    }
  } catch (e) {
    const msg = e && e.name === 'TimeoutError' ? 'session 验票超时' : 'session 验票不可达';
    return { ok: false, error: msg, status: 502 };
  }
  const code = json && json.error_code;
  if (code === 0) {
    const u = pickUser(json.data);
    if (!u) return { ok: false, error: '验票成功但没有 ucid', status: 502 };
    return { ok: true, ucid: u.ucid, phone: u.phone, displayName: u.displayName };
  }
  if (code === 200003 || code === 200009) {
    return { ok: false, error: (json && json.error) || '登录已失效，请重新登录', error_code: code, status: 401 };
  }
  if (code === 111002 || code === 140001) {
    return { ok: false, error: 'session source/signature 不匹配', error_code: code, status: 502 };
  }
  return {
    ok: false,
    error: (json && json.error) || '验票失败',
    error_code: code,
    status: 401,
  };
}

module.exports = { verify, config, normalizeMobile };
