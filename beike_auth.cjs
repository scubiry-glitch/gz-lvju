'use strict';
/**
 * 贝壳 App C 端身份：lianjia_token → /token/verify → ucid → accounts。
 * App 内以 lianjia_token 为身份标准；BJZ 会话仅为可选短缓存（浏览器密码旁路仍走会话）。
 */
const crypto = require('crypto');
const sessionToken = require('./session_token.cjs');

const MEMO = new Map();
const TTL_OK_MS = 120000;   // 验票成功缓存 2 分钟，避免每个 API 都打 session
const TTL_FAIL_MS = 20000;
const MEMO_MAX = 800;

/** 贝壳换票签发的 BJZ 会话 TTL（短缓存，非长期身份） */
const BEIKE_SESSION_TTL_SECONDS = 2 * 3600;

function tokenHash(t) {
  return crypto.createHash('sha256').update(String(t || ''), 'utf8').digest('hex');
}

function memoGet(h) {
  const e = MEMO.get(h);
  if (!e) return null;
  if (Date.now() > e.until) {
    MEMO.delete(h);
    return null;
  }
  return e.value;
}

function memoSet(h, value, ttl) {
  if (MEMO.size >= MEMO_MAX) {
    const oldest = MEMO.keys().next().value;
    if (oldest != null) MEMO.delete(oldest);
  }
  MEMO.set(h, { until: Date.now() + ttl, value });
}

function lianjiaTokenOf(req) {
  // 与 auth_center 对齐：只认 Cookie，不读 X-Lianjia-Token
  const raw = (req && req.headers && req.headers.cookie) || '';
  const parts = String(raw).split(';');
  for (const name of ['lianjia_token', 'lj_token']) {
    for (const part of parts) {
      const p = part.trim();
      const eq = p.indexOf('=');
      if (eq <= 0) continue;
      if (p.slice(0, eq).trim() !== name) continue;
      try {
        return decodeURIComponent(p.slice(eq + 1).trim());
      } catch {
        return p.slice(eq + 1).trim();
      }
    }
  }
  return '';
}

/**
 * @param {string} ljToken
 * @param {{ referer?: string }} [opts]
 */
async function verifyMemoized(ljToken, opts) {
  const t = String(ljToken || '').trim();
  if (!t) return { ok: false, error: '缺少 lianjia_token', status: 400 };
  const h = tokenHash(t);
  const hit = memoGet(h);
  if (hit) return hit;
  const verified = await sessionToken.verify(t, opts);
  memoSet(h, verified, verified.ok ? TTL_OK_MS : TTL_FAIL_MS);
  return verified;
}

/**
 * 按 ucid 找到或建档 accounts（idp_type=beike）。
 * @returns {Promise<{accountId:number, ucid:string, phone:string, displayName:string}|{error:string, status:number}>}
 */
async function ensureBeikeAccount(verified, deps, meta) {
  const queryRows = deps.queryRows;
  const authCenter = deps.authCenter;
  const uid = String(verified.ucid || '').trim();
  if (!uid) return { error: '验票成功但没有 ucid', status: 502 };
  const phone = verified.phone || '';
  const name = verified.displayName || '';
  const loginName = 'bk' + uid;
  const ip = (meta && meta.ip) || '';
  const ua = (meta && meta.ua) || '';

  let accRows = await queryRows(
    `SELECT id FROM accounts WHERE idp_type='beike' AND idp_subject=? LIMIT 1`,
    [uid],
  );
  if (!accRows.length) {
    accRows = await queryRows('SELECT id FROM accounts WHERE login_name=? LIMIT 1', [loginName]);
    if (accRows.length) {
      await queryRows(
        `UPDATE accounts SET idp_type='beike', idp_subject=? WHERE id=? AND (idp_type IS NULL OR idp_type='beike')`,
        [uid, accRows[0].id],
      );
    }
  }
  if (!accRows.length) {
    const created = await authCenter.createAccount({
      login_name: loginName,
      password: 'bk-' + crypto.randomBytes(12).toString('hex'),
      roles: ['user'],
      principal_type: 'user',
      phone: phone || undefined,
      display_name: name || ('贝壳用户' + uid.slice(-4)),
    }, { ip, ua });
    if (created.error) return { error: created.error, status: 400 };
    await queryRows(
      `UPDATE accounts SET idp_type='beike', idp_subject=? WHERE id=?`,
      [uid, created.account.id],
    );
  } else if (phone || name) {
    await queryRows(
      'UPDATE accounts SET phone=COALESCE(NULLIF(?,""),phone), display_name=COALESCE(NULLIF(?,""),display_name) WHERE id=?',
      [phone, name, accRows[0].id],
    ).catch(() => {});
  }
  accRows = await queryRows(
    `SELECT id FROM accounts WHERE idp_type='beike' AND idp_subject=? LIMIT 1`,
    [uid],
  );
  if (!accRows.length) return { error: '建档后找不到账号', status: 500 };
  return {
    accountId: accRows[0].id,
    ucid: uid,
    phone,
    displayName: name || ('贝壳用户' + uid.slice(-4)),
  };
}

/**
 * 请求级解析：验票 → 账号 → { account, roles }（不签发 BJZ）。
 * @returns {Promise<{account, roles}|null>}
 */
async function resolveLianjiaPrincipal(ljToken, deps, meta) {
  const referer = (meta && meta.referer) || undefined;
  const verified = await verifyMemoized(ljToken, { referer });
  if (!verified.ok) return null;
  const ensured = await ensureBeikeAccount(verified, deps, meta);
  if (ensured.error) return null;
  const full = await deps.authCenter.getAccountWithRoles(ensured.accountId);
  if (!full || !full.account) return null;
  return full;
}

module.exports = {
  lianjiaTokenOf,
  verifyMemoized,
  ensureBeikeAccount,
  resolveLianjiaPrincipal,
  BEIKE_SESSION_TTL_SECONDS,
};
