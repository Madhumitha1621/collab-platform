import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { gql, readToken, setUnauthenticatedHandler, writeToken, type User } from './api';

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  register(name: string, email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const USER_FIELDS = 'id name email';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => readToken());
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(token));

  const clear = useCallback(() => {
    writeToken(null);
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => setUnauthenticatedHandler(clear), [clear]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    gql<{ me: User }>(`query { me { ${USER_FIELDS} } }`)
      .then(({ me }) => !cancelled && setUser(me))
      .catch(() => !cancelled && clear())
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [token, clear]);

  const accept = useCallback((payload: { token: string; user: User }) => {
    writeToken(payload.token);
    setToken(payload.token);
    setUser(payload.user);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      token,
      loading,
      async login(email, password) {
        const data = await gql<{ login: { token: string; user: User } }>(
          `mutation($input: LoginInput!) { login(input: $input) { token user { ${USER_FIELDS} } } }`,
          { input: { email, password } },
        );
        accept(data.login);
      },
      async register(name, email, password) {
        const data = await gql<{ register: { token: string; user: User } }>(
          `mutation($input: RegisterInput!) { register(input: $input) { token user { ${USER_FIELDS} } } }`,
          { input: { name, email, password } },
        );
        accept(data.register);
      },
      async logout() {
        await gql(`mutation { logout }`).catch(() => undefined);
        clear();
      },
    }),
    [user, token, loading, accept, clear],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
