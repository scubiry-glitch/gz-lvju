import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ensureBeikeSession, isLoggedIn, jumpToLogin } from './auth.js';
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
      if (!ready) return true; // 仍在暖身份：先拦住点击
      if (loggedIn) return false;
      goLogin(next);
      return true;
    },
    [ready, loggedIn, goLogin],
  );
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

function clearLocalTokens() {
  try {
    localStorage.removeItem('BJZ_TOKEN');
    localStorage.removeItem('BZF_SESSION_TOKEN');
  } catch {
    /* ignore */
  }
}

/** 壳层启动即暖身份：一律探 /api/auth/me（credentials 带 Cookie，含 HttpOnly）；
 *  可读 lianjia_token 时再并行换 BJZ。不得因本地无票就跳过请求。 */
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

function loginNextPath(next) {
  const raw = next == null || next === '' ? location.pathname + location.search : String(next);
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  const path = raw.startsWith('/') ? raw : '/' + raw;
  // BrowserRouter basename=/h5
  return location.origin + '/h5' + path;
}

/** 挂在 AppShell：首页进站就探身份；点击侧用 goLogin / useRequireLogin */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  const clearSession = useCallback(() => {
    clearLocalTokens();
    setUser(null);
    setReady(true);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const u = await loadAuthUser();
      if (!u) {
        // 本地有票但服务端不认 → 清 BJZ，避免假登录；无本地票则只标未登录
        if (isLoggedIn()) clearLocalTokens();
        setUser(null);
        return null;
      }
      setUser(u);
      return u;
    } catch {
      return null;
    } finally {
      setReady(true);
    }
  }, []);

  const goLogin = useCallback((next) => {
    const ret = next == null || next === '' ? location.pathname + location.search : String(next);
    const nextQ = ret.startsWith('/') ? ret : '/' + ret.replace(/^\//, '');
    // 一律 Morph clogin（App 走原生）；不进 /h5/login、不落页内密码卡
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
