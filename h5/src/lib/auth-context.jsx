import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { jumpToLogin } from './auth.js';
import { authMe } from './api.js';

export const AuthUserContext = createContext({
  user: null,
  ready: false,
  loggedIn: false,
  refresh: async () => null,
  setUser: () => {},
  clearSession: () => {},
  goLogin: () => {},
});

export function useAuthUser() {
  return useContext(AuthUserContext);
}

/** 未登录则 jumpToLogin → clogin；已登录返回 false 供调用方继续业务 */
export function useRequireLogin() {
  const { ready, loggedIn, goLogin } = useAuthUser();
  return useCallback(
    (next) => {
      if (!ready) return true;
      if (loggedIn) return false;
      goLogin(next);
      return true;
    },
    [ready, loggedIn, goLogin],
  );
}

function pickUser(me) {
  const a = me && me.account;
  if (!a) return null;
  return {
    id: a.id,
    display_name: a.display_name || a.login_name || '',
    phone: a.phone || '',
    login_name: a.login_name || '',
  };
}

/** 壳层暖身份：只探 /api/auth/me（X-Lianjia-Token 头 + Cookie）；C 端不换 BJZ */
export async function loadAuthUser() {
  try {
    return pickUser(await authMe());
  } catch {
    return null;
  }
}

function loginNextPath(next) {
  const raw = next == null || next === '' ? location.pathname + location.search : String(next);
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  const path = raw.startsWith('/') ? raw : '/' + raw;
  return location.origin + '/h5' + path;
}

/** 挂在 AppShell：进站探身份；点击侧 goLogin / useRequireLogin */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  const clearSession = useCallback(() => {
    setUser(null);
    setReady(true);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const u = await loadAuthUser();
      setUser(u);
      return u;
    } catch {
      setUser(null);
      return null;
    } finally {
      setReady(true);
    }
  }, []);

  const goLogin = useCallback((next) => {
    const ret = next == null || next === '' ? location.pathname + location.search : String(next);
    const nextQ = ret.startsWith('/') ? ret : '/' + ret.replace(/^\//, '');
    jumpToLogin(loginNextPath(nextQ));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({
      user,
      ready,
      loggedIn: !!user,
      refresh,
      setUser,
      clearSession,
      goLogin,
    }),
    [user, ready, refresh, clearSession, goLogin],
  );

  return <AuthUserContext.Provider value={value}>{children}</AuthUserContext.Provider>;
}
