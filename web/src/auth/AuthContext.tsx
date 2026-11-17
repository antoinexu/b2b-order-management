import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { createSessionClient, unwrap } from '@/api/client';
import type { Me, Permission } from '@/api/types';
import { assertCurrentSession, sessionStore, type SessionSnapshot } from './session';

interface AuthState {
  token: string | null;
  me: Me | undefined;
  isLoading: boolean;
  error: Error | null;
  retry: () => void;
  api: ReturnType<typeof createSessionClient>;
  signIn: (token: string) => void;
  signOut: () => void;
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ session, children }: { session: SessionSnapshot; children: ReactNode }) {
  const { token } = session;
  const api = useMemo(() => createSessionClient(session), [session]);
  const signOut = useCallback(() => sessionStore.clearIfCurrent(session), [session]);
  const signIn = useCallback((next: string) => {
    assertCurrentSession(session);
    sessionStore.setToken(next);
  }, [session]);

  const meQuery = useQuery({
    queryKey: ['me', token],
    queryFn: ({ signal }) => unwrap(api.GET('/auth/me', { signal })),
    enabled: !!token,
    staleTime: 60_000,
  });

  const { refetch } = meQuery;
  const retry = useCallback(() => { void refetch(); }, [refetch]);
  const value = useMemo<AuthState>(() => {
    const permissions = new Set(meQuery.data?.permissions ?? []);
    return {
      token,
      me: meQuery.data,
      isLoading: !!token && meQuery.isPending,
      error: meQuery.error,
      retry,
      api,
      signIn,
      signOut,
      can: (permission) => permissions.has(permission),
    };
  }, [token, meQuery.data, meQuery.isPending, meQuery.error, retry, api, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
