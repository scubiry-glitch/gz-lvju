import { useEffect, useState } from 'react';
import { isLoggedIn, jumpToLogin, morphCookieLikely, ensureBeikeSession } from '../lib/auth.js';
import { authMe, tenantLogin } from '../lib/api.js';
import { AuthUserContext } from '../lib/auth-context.js';

function pickUser(me, beike) {
  const a = me && me.account;
  if (a) {
    return {
      id: a.id,
      display_name: a.display_name || a.login_name || '',
      phone: a.phone || '',
      login_name: a.login_name || '',
    };
  }
  if (beike && beike.ok) {
    return {
      id: beike.uid || '',
      display_name: beike.display_name || beike.login_name || '',
      phone: beike.phone || '',
      phone_masked: beike.phone_masked || '',
    };
  }
  return null;
}

async function loadUser() {
  const beike = await ensureBeikeSession().catch(() => null);
  let me = null;
  try {
    me = await authMe();
  } catch {
    /* 401 / 无会话 */
  }
  return pickUser(me, beike);
}

/**
 * 强制登录闸 + 拉用户资料进 Context。
 * 清单在 App.jsx RequireAuth 子路由；页面用 useAuthUser()。
 */
export default function AuthGate({ children, title = '登录后继续' }) {
  const [phase, setPhase] = useState(() => (isLoggedIn() ? 'load' : 'login')); // load | login | ok
  const [user, setUser] = useState(null);
  const [phone, setPhone] = useState('');
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState('');
  const canMorph = morphCookieLikely();

  useEffect(() => {
    if (phase !== 'load') return;
    let alive = true;
    loadUser().then((u) => {
      if (!alive) return;
      if (!isLoggedIn()) {
        setPhase('login');
        return;
      }
      setUser(u);
      setPhase('ok');
    });
    return () => {
      alive = false;
    };
  }, [phase]);

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
      setUser(
        pickUser(null, {
          ok: true,
          display_name: j.display_name || '',
          phone: phone,
          phone_masked: j.phone_masked || '',
        }),
      );
      setPhase('load');
    } catch (e) {
      setErr(e.message || '登录失败');
    }
  }

  if (phase === 'ok') {
    return <AuthUserContext.Provider value={{ user }}>{children}</AuthUserContext.Provider>;
  }

  if (phase === 'load') {
    return (
      <div className="auth-gate">
        <div className="pt">加载中…</div>
      </div>
    );
  }

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
