import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ensureBeikeSession, isLoggedIn } from './auth.js';
import { authMe } from './api.js';

export const AuthUserContext = createContext({
  user: null,
  ready: false,
  refresh: async () => null,
  setUser: () => {},
});

export function useAuthUser() {
  return useContext(AuthUserContext);
}

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

/** 壳层启动即暖身份：有票先 /auth/me，贝壳换票并行不挡页面 */
export async function loadAuthUser() {
  const beikeP = ensureBeikeSession().catch(() => null);
  let me = null;
  try {
    me = await authMe();
  } catch {
    /* 401 / 无会话 */
  }
  const beike = await beikeP;
  if (!me && beike && beike.ok) {
    try {
      me = await authMe();
    } catch {
      /* ignore */
    }
  }
  return pickUser(me, beike);
}

/** 挂在 AppShell：首页进站就知道是谁，订单/我的直接读 Context */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(() => !isLoggedIn());

  const refresh = useCallback(async () => {
    if (!isLoggedIn()) {
      setUser(null);
      setReady(true);
      return null;
    }
    try {
      const u = await loadAuthUser();
      setUser(u);
      return u;
    } catch {
      return null;
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <AuthUserContext.Provider value={{ user, ready, refresh, setUser }}>{children}</AuthUserContext.Provider>
  );
}
