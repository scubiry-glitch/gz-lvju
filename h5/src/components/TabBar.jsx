import { NavLink } from 'react-router-dom';
import { guardAuthTab } from './AuthGate.jsx';

const TABS = [
  { to: '/', end: true, label: '首页', on: '/assets/lvju/icons/tab-home-on.svg', off: '/assets/lvju/icons/tab-home-off.svg' },
  { to: '/search', label: '找房', on: '/assets/lvju/icons/tab-search-on.svg', off: '/assets/lvju/icons/tab-search-off.svg' },
  { to: '/spots', label: '内容', on: '/assets/lvju/icons/tab-content-on.svg', off: '/assets/lvju/icons/tab-content-off.svg' },
  { to: '/orders', label: '订单', auth: true, on: '/assets/lvju/icons/tab-orders-on.svg', off: '/assets/lvju/icons/tab-orders-off.svg' },
  { to: '/me', label: '我的', auth: true, on: '/assets/lvju/icons/tab-me-on.svg', off: '/assets/lvju/icons/tab-me-off.svg' },
];

export default function TabBar() {
  return (
    <nav className="tabbar" aria-label="主导航">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) => (isActive ? 'on' : undefined)}
          onClick={(e) => {
            if (t.auth) guardAuthTab(e, t.to);
          }}
        >
          {({ isActive }) => (
            <>
              <span className="ti">
                <img src={isActive ? t.on : t.off} alt="" />
              </span>
              {t.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
