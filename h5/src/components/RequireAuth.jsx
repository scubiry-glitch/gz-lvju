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
    if (!ready || loggedIn || jumped.current) return;
    jumped.current = true;
    goLogin(pathname + search);
  }, [ready, loggedIn, pathname, search, goLogin]);

  if (!ready || !loggedIn) return null;
  return <Outlet />;
}
