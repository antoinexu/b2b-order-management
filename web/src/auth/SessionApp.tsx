import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import { RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/api/client';
import { AuthProvider } from '@/auth/AuthContext';
import { sessionStore, type SessionSnapshot } from '@/auth/session';
import { Toaster } from '@/components/ui/sonner';
import { router } from '@/router';

const createQueryClient = () => new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Aborted sessions and client errors cannot be fixed by retrying the same request.
      retry: (failureCount, error) => error.name !== 'AbortError' && !(error instanceof ApiError && error.status < 500) && failureCount < 2,
    },
  },
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (error.name !== 'AbortError' && !mutation.meta?.inlineError) toast.error(errorMessage(error));
    },
  }),
});

function SessionTree({ session }: { session: SessionSnapshot }) {
  // Old mutation callbacks retain their old client and cannot repopulate the new account's cache.
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider session={session}>
        <RouterProvider router={router} />
        <Toaster richColors position="bottom-right" />
      </AuthProvider>
    </QueryClientProvider>
  );
}

export function SessionApp() {
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  return <SessionTree key={session.version} session={session} />;
}
