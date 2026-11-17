import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/api/client';
import { AuthProvider } from '@/auth/AuthContext';
import { Toaster } from '@/components/ui/sonner';
import { router } from '@/router';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Don't retry client errors (401/403/404/validation); they won't fix themselves.
      retry: (failureCount, error) => !(error instanceof ApiError && error.status < 500) && failureCount < 2,
    },
  },
  mutationCache: new MutationCache({
    // Mutations that render their own error inline opt out with meta: { inlineError: true }.
    onError: (error, _vars, _ctx, mutation) => {
      if (!mutation.meta?.inlineError) toast.error(errorMessage(error));
    },
  }),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
        <Toaster richColors position="bottom-right" />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
