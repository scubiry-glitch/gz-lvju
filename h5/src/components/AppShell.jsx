import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import TabBar from './TabBar.jsx';
import { AuthProvider } from '../lib/auth-context.jsx';
import { setAppTitle } from '../lib/auth.js';

const APP_TITLE = '贝壳旅居';

const HIDE_TAB = [
  /^\/detail/,
  /^\/booking/,
  /^\/order\//,
  /^\/pay/,
  /^\/paid/,
  /^\/ticket/,
  /^\/spot\//,
  /^\/topic\//,
  /^\/rating-standard/,
  /^\/privacy/,
  /^\/terms/,
  /^\/verify/,
  /^\/vouchers/,
  /^\/voucher/,
];

export default function AppShell() {
  const { pathname } = useLocation();
  const showTab = !HIDE_TAB.some((re) => re.test(pathname));

  useEffect(() => {
    setAppTitle(APP_TITLE);
  }, [pathname]);

  return (
    <AuthProvider>
      <div className="app-shell">
        <main className="app-main">
          <Outlet />
        </main>
        {showTab ? <TabBar /> : null}
      </div>
    </AuthProvider>
  );
}
