import { useState } from 'react';
import { isLoggedIn, jumpToLogin, morphCookieLikely } from '../lib/auth.js';
import { tenantLogin } from '../lib/api.js';
import { useAuthUser } from '../lib/auth-context.jsx';

/**
 * 强制登录闸：只拦未登录。身份由壳层 AuthProvider 已拉好，不再卡「加载中」。
 */
export default function AuthGate({ children, title = '登录后继续' }) {
  const { setUser, refresh } = useAuthUser();
  const [needLogin, setNeedLogin] = useState(() => !isLoggedIn());
  const [phone, setPhone] = useState('');
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState('');
  const canMorph = morphCookieLikely();

  async function onPwd() {
    setErr('');
    if (!/^1\d{10}$/.test(phone) || pwd.length < 8) {
      setErr('手机号 11 位、密码至少 8 位');
      return;
    }
    try {
      const j = await tenantLogin(phone, pwd);
      if (j.token) {
        try {
          localStorage.setItem('BJZ_TOKEN', j.token);
          localStorage.setItem('BZF_SESSION_TOKEN', j.token);
        } catch {
          /* ignore */
        }
      }
      setUser({
        id: j.account_id || '',
        display_name: j.display_name || '',
        phone,
        phone_masked: j.phone_masked || '',
      });
      setNeedLogin(false);
      refresh();
    } catch (e) {
      setErr(e.message || '登录失败');
    }
  }

  if (!needLogin && isLoggedIn()) return children;

  return (
    <div className="auth-gate">
      <div className="pt">{title}</div>
      <p className="ps">
        {canMorph
          ? '需登录后继续；可用贝壳登录，或手机号密码（首次即注册）'
          : '需登录后继续；当前域名回跳拿不到贝壳票，请用手机号密码登录（首次即注册）'}
      </p>
      {canMorph ? (
        <button type="button" className="btn" onClick={() => jumpToLogin(location.href)}>
          贝壳登录
        </button>
      ) : null}
      <div className="row">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="手机号"
          inputMode="numeric"
          maxLength={11}
        />
        <input
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          placeholder="密码（≥8位）"
          type="password"
          style={{ flex: 1.4 }}
        />
      </div>
      <button type="button" className={'btn' + (canMorph ? ' soft' : '')} onClick={onPwd}>
        密码登录 / 注册
      </button>
      {err ? <div className="err">{err}</div> : null}
    </div>
  );
}
