import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuthUser } from '../lib/auth-context.jsx';

/**
 * 受保护路由：未登录一律 jumpToLogin → clogin（App 原生）。
 * 不进 /h5/login，也不落页内密码卡。
 */
export default function RequireAuth() {
  const { pathname, search } = useLocation();
  const { ready, loggedIn, goLogin } = useAuthUser();
  const jumped = useRef(false);

  useEffect(() => {
    try {
      console.log('[bzf-auth] RequireAuth', { pathname, search, ready, loggedIn, jumped: jumped.current });
    } catch {
      /* ignore */
    }
    if (loggedIn) {
      jumped.current = false;
      return;
    }
    if (!ready || jumped.current) return;
    jumped.current = true;
    goLogin(pathname + search);
  }, [ready, loggedIn, pathname, search, goLogin]);

  if (!ready) {
    return (
      <div className="auth-gate">
        <p>加载中…</p>
      </div>
    );
  }
  if (!loggedIn) {
    return (
      <div className="auth-gate">
        <p>正在前往登录…</p>
      </div>
    );
  }
  return <Outlet />;
}
