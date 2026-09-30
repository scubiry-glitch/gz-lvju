import { NavLink, useLocation } from 'react-router-dom';
import { useRequireLogin } from '../lib/auth-context.jsx';

const TABS = [
  { to: '/', end: true, label: '首页', on: '/assets/lvju/icons/tab-home-on.svg', off: '/assets/lvju/icons/tab-home-off.svg' },
  {
    to: '/search',
    label: '找房',
    match: [/^\/search/, /^\/lvju/, /^\/minsu/, /^\/changzu/, /^\/guide/],
    on: '/assets/lvju/icons/tab-search-on.svg',
    off: '/assets/lvju/icons/tab-search-off.svg',
  },
  {
    to: '/spots',
    label: '内容',
    match: [/^\/spots/, /^\/routes/, /^\/food/, /^\/convenience/, /^\/spot\//],
    on: '/assets/lvju/icons/tab-content-on.svg',
    off: '/assets/lvju/icons/tab-content-off.svg',
  },
  {
    to: '/orders',
    label: '订单',
    needAuth: true,
    on: '/assets/lvju/icons/tab-orders-on.svg',
    off: '/assets/lvju/icons/tab-orders-off.svg',
  },
  {
    to: '/me',
    label: '我的',
    needAuth: true,
    on: '/assets/lvju/icons/tab-me-on.svg',
    off: '/assets/lvju/icons/tab-me-off.svg',
  },
];

export default function TabBar() {
  const { pathname } = useLocation();
  const requireLogin = useRequireLogin();

  return (
    <nav className="tabbar" aria-label="主导航">
      {TABS.map((t) => {
        const active = t.match ? t.match.some((re) => re.test(pathname)) : null;
        return (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) => ((active != null ? active : isActive) ? 'on' : undefined)}
            onClick={(e) => {
              if (!t.needAuth) return;
              if (requireLogin(t.to)) e.preventDefault();
            }}
          >
            {({ isActive }) => {
              const on = active != null ? active : isActive;
              return (
                <>
                  <span className="ti">
                    <img src={on ? t.on : t.off} alt="" />
                  </span>
                  {t.label}
                </>
              );
            }}
          </NavLink>
        );
      })}
    </nav>
  );
}
