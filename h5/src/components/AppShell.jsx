import { Outlet, useLocation } from 'react-router-dom';
import TabBar from './TabBar.jsx';

const HIDE_TAB = [/^\/detail/, /^\/booking/, /^\/pay/, /^\/paid/, /^\/ticket/, /^\/spot\//];

export default function AppShell() {
  const { pathname } = useLocation();
  const showTab = !HIDE_TAB.some((re) => re.test(pathname));
  return (
    <div className="app-shell">
      <main className="app-main">
        <Outlet />
      </main>
      {showTab ? <TabBar /> : null}
    </div>
  );
}
