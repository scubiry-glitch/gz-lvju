import { useEffect, useState } from 'react';
import { ensureBeikeSession, isLoggedIn, jumpToLogin } from '../lib/auth.js';
import { tenantLogin } from '../lib/api.js';

/**
 * 订单 / 我的：未登录强制 Morph；浏览器非 *.ke.com 回跳拿不到票时可用密码兜底。
 */
export default function AuthGate({ children, title = '登录后继续' }) {
  const [phase, setPhase] = useState('boot'); // boot | login | ok
  const [phone, setPhone] = useState('');
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState('');
  const [jumping, setJumping] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer;
    (async () => {
      if (isLoggedIn()) {
        await ensureBeikeSession().catch(() => null);
        if (!alive) return;
        if (isLoggedIn()) {
          setPhase('ok');
          return;
        }
      }
      if (!alive) return;
      setPhase('login');
      setJumping(true);
      timer = setTimeout(() => {
        if (alive) jumpToLogin(location.href);
      }, 120);
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

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
      setPhase('ok');
    } catch (e) {
      setErr(e.message || '登录失败');
    }
  }

  if (phase === 'ok') return children;

  if (phase === 'boot') {
    return (
      <div className="auth-gate">
        <div className="pt">正在同步贝壳登录…</div>
        <p className="ps" style={{ margin: 0 }}>
          请稍候
        </p>
      </div>
    );
  }

  return (
    <div className="auth-gate">
      <div className="pt">{title}</div>
      <p className="ps">
        {jumping
          ? '正在跳转贝壳登录…若未自动跳转，请点下方按钮；本地域名回跳拿不到票可用密码'
          : '需登录后查看。默认贝壳 Morph；拿不到票时可用密码登录'}
      </p>
      <button
        type="button"
        className="btn"
        onClick={() => {
          setJumping(true);
          jumpToLogin(location.href);
        }}
      >
        贝壳 Morph 登录
      </button>
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
      <button type="button" className="btn soft" onClick={onPwd}>
        密码登录 / 注册
      </button>
      {err ? <div className="err">{err}</div> : null}
    </div>
  );
}

/** Tab「订单 / 我的」未登录拦截 → Morph，回跳目标为对应 /h5 路径 */
export function guardAuthTab(e, path) {
  if (isLoggedIn()) return false;
  e.preventDefault();
  const base = (import.meta.env.BASE_URL || '/h5/').replace(/\/?$/, '');
  const dest = location.origin + base + (path.startsWith('/') ? path : '/' + path);
  jumpToLogin(dest);
  return true;
}
