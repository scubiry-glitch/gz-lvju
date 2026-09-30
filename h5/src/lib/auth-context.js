import { createContext, useContext } from 'react';

/** RequireAuth / AuthGate 登录通过后下发；子页用 useAuthUser() 读 */
export const AuthUserContext = createContext({ user: null });

export function useAuthUser() {
  return useContext(AuthUserContext);
}
