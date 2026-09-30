import { NavLink, useLocation } from 'react-router-dom';

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
  /* 鉴权在 RequireAuth layout，Tab 直接进页 */
  { to: '/orders', label: '订单', on: '/assets/lvju/icons/tab-orders-on.svg', off: '/assets/lvju/icons/tab-orders-off.svg' },
  { to: '/me', label: '我的', on: '/assets/lvju/icons/tab-me-on.svg', off: '/assets/lvju/icons/tab-me-off.svg' },
];

export default function TabBar() {
  const { pathname } = useLocation();
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
