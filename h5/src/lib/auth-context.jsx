import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getLianjiaToken, jumpToLogin, logLianjiaTokenCookie, morphEnv } from './auth.js';
import { authMe } from './api.js';

function authLog(...args) {
  try {
    console.log('[bzf-auth]', ...args);
  } catch {
    /* ignore */
  }
}

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

/** 未登录则 jumpToLogin；已登录返回 false 供调用方继续业务。
 * ready 未完成时放行路由，交给 RequireAuth，避免 Tab 点了 preventDefault 却不跳登录（App 内像没反应）。 */
export function useRequireLogin() {
  const { ready, loggedIn, goLogin } = useAuthUser();
  return useCallback(
    (next) => {
      authLog('requireLogin', { next, ready, loggedIn });
      if (!ready) return false;
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

/** 壳层暖身份：只探 /api/auth/me（Cookie）；C 端不换 BJZ */
export async function loadAuthUser() {
  const env = morphEnv();
  logLianjiaTokenCookie('loadAuthUser');
  const readableToken = !!getLianjiaToken();
  authLog('loadAuthUser start', {
    hostEnv: env.hostEnv,
    isApp: env.isApp,
    readableLianjiaToken: readableToken,
  });
  try {
    const me = await authMe();
    const u = pickUser(me);
    logLianjiaTokenCookie('after auth/me ok');
    authLog('登录状态', {
      loggedIn: !!u,
      accountId: u && u.id,
      display_name: u && u.display_name,
      phone: u && u.phone,
      hostEnv: env.hostEnv,
    });
    return u;
  } catch (e) {
    logLianjiaTokenCookie('after auth/me fail');
    authLog('登录状态', {
      loggedIn: false,
      reason: (e && (e.message || e.status)) || 'auth/me failed',
      status: e && e.status,
      hostEnv: env.hostEnv,
      readableLianjiaToken: readableToken,
    });
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
      authLog('AuthProvider ready', { loggedIn: !!u });
      return u;
    } catch {
      setUser(null);
      authLog('AuthProvider ready', { loggedIn: false });
      return null;
    } finally {
      setReady(true);
    }
  }, []);

  const goLogin = useCallback((next) => {
    const ret = next == null || next === '' ? location.pathname + location.search : String(next);
    const nextQ = ret.startsWith('/') ? ret : '/' + ret.replace(/^\//, '');
    const url = loginNextPath(nextQ);
    authLog('goLogin', { next, url, currentlyLoggedIn: !!user });
    jumpToLogin(url);
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /* 登录回跳 / App 回前台：再打 getCookie + 重探 /auth/me */
  useEffect(() => {
    logLianjiaTokenCookie('AuthProvider mount');
    const onBack = (tag) => {
      logLianjiaTokenCookie(tag);
      refresh();
    };
    const onPageShow = (e) => {
      if (e && e.persisted) onBack('pageshow persisted');
      else logLianjiaTokenCookie('pageshow');
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') onBack('visibility visible');
    };
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVis);
    };
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
