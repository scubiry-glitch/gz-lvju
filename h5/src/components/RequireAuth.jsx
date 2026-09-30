import { Outlet, useLocation } from 'react-router-dom';
import AuthGate from './AuthGate.jsx';

/** 需要强制登录的路由文案；清单在 App.jsx 的 RequireAuth 子路由里维护 */
const TITLES = [
  [/^\/orders/, '登录后查看订单'],
  [/^\/me/, '登录后进入「我的」'],
  [/^\/booking/, '预订需要先登录'],
];

function titleFor(pathname) {
  for (const [re, t] of TITLES) {
    if (re.test(pathname)) return t;
  }
  return '登录后继续';
}

export default function RequireAuth() {
  const { pathname } = useLocation();
  return (
    <AuthGate title={titleFor(pathname)}>
      <Outlet />
    </AuthGate>
  );
}
