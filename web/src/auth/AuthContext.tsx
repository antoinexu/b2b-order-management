import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler, tokenStorage, unwrap } from '@/api/client';
import type { Me, Permission } from '@/api/types';

interface AuthState {
  token: string | null;
  me: Me | undefined;
  isLoading: boolean;
  signIn: (token: string) => void;
  signOut: () => void;
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState(() => tokenStorage.get());

  const signOut = useCallback(() => {
    tokenStorage.clear();
    setToken(null);
    queryClient.clear(); // never show one user's cached data to the next
  }, [queryClient]);

  const signIn = useCallback((next: string) => {
    queryClient.clear();
    tokenStorage.set(next);
    setToken(next);
  }, [queryClient]);

  useEffect(() => setUnauthorizedHandler(signOut), [signOut]);

  const meQuery = useQuery({
    queryKey: ['me', token],
    queryFn: () => unwrap(api.GET('/auth/me')),
    enabled: !!token,
    staleTime: 60_000,
  });

  const value = useMemo<AuthState>(() => {
    const permissions = new Set(meQuery.data?.permissions ?? []);
    return {
      token,
      me: meQuery.data,
      isLoading: !!token && meQuery.isPending,
      signIn,
      signOut,
      can: (permission) => permissions.has(permission),
    };
  }, [token, meQuery.data, meQuery.isPending, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
