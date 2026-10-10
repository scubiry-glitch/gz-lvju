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

/** Tab 点订单/我的：未登录则 Morph Login.toLogin({ url: 回跳地址 })，已登录放行路由。
 * 进站未 ready 前整页不渲染，此处 ready 恒为 true；仍挡一层防竞态。 */
export function useRequireLogin() {
  const { ready, loggedIn, goLogin } = useAuthUser();
  return useCallback(
    (next) => {
      authLog('requireLogin', { next, ready, loggedIn });
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

const LOGIN_NEXT_KEY = 'bzf_h5_login_next';

function loginNextPath(next) {
  const raw = next == null || next === '' ? location.pathname + location.search : String(next);
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  const path = raw.startsWith('/') ? raw : '/' + raw;
  /* 已是 /h5/... 时不要再拼一层 */
  if (path === '/h5' || path.startsWith('/h5/')) return location.origin + path;
  return location.origin + '/h5' + path;
}

function saveLoginNext(path) {
  try {
    sessionStorage.setItem(LOGIN_NEXT_KEY, path);
  } catch {
    /* ignore */
  }
}

function takeLoginNext() {
  try {
    const v = sessionStorage.getItem(LOGIN_NEXT_KEY) || '';
    if (v) sessionStorage.removeItem(LOGIN_NEXT_KEY);
    return v;
  } catch {
    return '';
  }
}

/** App 原生登录常回到「当前 WebView」；若还停在别的路由，补跳到登录前目标页 */
function resumeLoginNext() {
  const next = takeLoginNext();
  if (!next) return;
  const path = next.startsWith('/') ? next : '/' + next;
  const target = path === '/h5' || path.startsWith('/h5/') ? path : '/h5' + path;
  const cur = location.pathname + location.search;
  if (cur === target) return;
  authLog('resumeLoginNext', { from: cur, to: target });
  location.replace(location.origin + target);
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
    saveLoginNext(nextQ);
    jumpToLogin(url);
  }, [user]);

  useEffect(() => {
    logLianjiaTokenCookie('AuthProvider mount');
    /* 首屏也要消费 login next：App 登录后偶发整页回到首页，不会再走 visibility */
    refresh().then((u) => {
      if (u) resumeLoginNext();
    });
  }, [refresh]);

  /* 登录回跳 / App 回前台：再打 getCookie + 重探 /auth/me；已登录则补跳目标页 */
  useEffect(() => {
    const onBack = (tag) => {
      logLianjiaTokenCookie(tag);
      refresh().then((u) => {
        if (u) resumeLoginNext();
      });
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

  /* /api/auth/me 完成前不渲染业务页，避免未登录态闪一下再跳登录 */
  return (
    <AuthUserContext.Provider value={value}>
      {ready ? children : null}
    </AuthUserContext.Provider>
  );
}
