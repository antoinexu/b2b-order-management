import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Link, Navigate, Outlet, useLocation } from 'react-router';
import type { Permission } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/States';
import { AcceptInvitationPage, ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from '@/pages/auth/AuthPages';

// Route-level code splitting: each page is downloaded the first time it is visited.
const page = <M extends Record<string, React.ComponentType>>(load: () => Promise<M>, name: keyof M) =>
  lazy(() => load().then((m) => ({ default: m[name] as React.ComponentType })));
const DashboardPage = page(() => import('@/pages/DashboardPage'), 'DashboardPage');
const CustomersPage = page(() => import('@/pages/CustomersPage'), 'CustomersPage');
const ProductsPage = page(() => import('@/pages/ProductsPage'), 'ProductsPage');
const QuotesPage = page(() => import('@/pages/QuotesPages'), 'QuotesPage');
const QuoteNewPage = page(() => import('@/pages/QuotesPages'), 'QuoteNewPage');
const QuoteDetailPage = page(() => import('@/pages/QuotesPages'), 'QuoteDetailPage');
const QuoteEditPage = page(() => import('@/pages/QuotesPages'), 'QuoteEditPage');
const OrdersPage = page(() => import('@/pages/OrdersPages'), 'OrdersPage');
const OrderNewPage = page(() => import('@/pages/OrdersPages'), 'OrderNewPage');
const OrderDetailPage = page(() => import('@/pages/OrdersPages'), 'OrderDetailPage');
const UsersPage = page(() => import('@/pages/UsersPage'), 'UsersPage');

function PageFallback() {
  return <div className="space-y-3" aria-busy="true"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>;
}

function RequireAuth() {
  const { token, me, isLoading, error, retry, signOut } = useAuth();
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: location }} />;
  if (isLoading) {
    return (
      <div className="grid min-h-svh place-items-center" aria-busy="true">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }
  if (!me) {
    return (
      <div className="mx-auto grid min-h-svh max-w-lg content-center gap-4 px-4">
        <ErrorState error={error ?? new Error('Unable to load your account.')} onRetry={retry} />
        <Button variant="outline" onClick={signOut}>Sign out</Button>
      </div>
    );
  }
  return <Outlet />;
}

/** UI-level guard for nicer UX; the API enforces the same permission regardless. */
function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <div className="py-20 text-center">
        <h1 className="text-xl font-semibold">You don't have access to this page</h1>
        <p className="mt-2 text-sm text-muted-foreground">Ask an admin for the <code>{permission}</code> permission.</p>
      </div>
    );
  }
  return children;
}

function NotFound() {
  return (
    <div className="py-20 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Link to="/" className={cn(buttonVariants({ variant: "outline" }), "mt-4")}>Back to dashboard</Link>
    </div>
  );
}

const guard = (permission: Permission, element: ReactNode) => (
  <RequirePermission permission={permission}><Suspense fallback={<PageFallback />}>{element}</Suspense></RequirePermission>
);

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/accept-invitation', element: <AcceptInvitationPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <Suspense fallback={<PageFallback />}><DashboardPage /></Suspense> },
          { path: 'customers', element: guard('customers:read', <CustomersPage />) },
          { path: 'products', element: guard('products:read', <ProductsPage />) },
          { path: 'quotes', element: guard('quotes:read', <QuotesPage />) },
          { path: 'quotes/new', element: guard('quotes:write', <QuoteNewPage />) },
          { path: 'quotes/:id', element: guard('quotes:read', <QuoteDetailPage />) },
          { path: 'quotes/:id/edit', element: guard('quotes:write', <QuoteEditPage />) },
          { path: 'orders', element: guard('orders:read', <OrdersPage />) },
          { path: 'orders/new', element: guard('orders:write', <OrderNewPage />) },
          { path: 'orders/:id', element: guard('orders:read', <OrderDetailPage />) },
          { path: 'users', element: guard('users:read', <UsersPage />) },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);
