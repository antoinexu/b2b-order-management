import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import {
  Boxes, Building2, FileText, LayoutDashboard, LogOut, Menu, Package, Users, X,
} from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import type { Permission } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { capitalize } from '@/lib/format';
import { cn } from '@/lib/utils';

const NAV: { to: string; label: string; icon: typeof LayoutDashboard; permission?: Permission }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/customers', label: 'Customers', icon: Building2, permission: 'customers:read' },
  { to: '/products', label: 'Products', icon: Package, permission: 'products:read' },
  { to: '/quotes', label: 'Quotes', icon: FileText, permission: 'quotes:read' },
  { to: '/orders', label: 'Orders', icon: Boxes, permission: 'orders:read' },
  { to: '/users', label: 'Team', icon: Users, permission: 'users:read' },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { me, can, signOut } = useAuth();
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="px-2">
        <p className="text-sm font-semibold">B2B Orders</p>
        <p className="truncate text-xs text-muted-foreground">{me?.organization.name}</p>
      </div>
      <nav className="flex flex-1 flex-col gap-1" aria-label="Main">
        {NAV.filter((item) => !item.permission || can(item.permission)).map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            onClick={onNavigate}
            className={({ isActive }) => cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
              isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>
      {me && (
        <div className="border-t pt-4">
          <div className="flex items-center justify-between gap-2 px-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{me.user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{me.user.email}</p>
            </div>
            <Badge variant="outline">{capitalize(me.user.role)}</Badge>
          </div>
          <Button variant="ghost" size="sm" className="mt-3 w-full justify-start" onClick={signOut}>
            <LogOut /> Sign out
          </Button>
        </div>
      )}
    </div>
  );
}

export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="min-h-svh bg-background text-foreground md:grid md:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-svh border-r bg-muted/30 md:block">
        <Sidebar />
      </aside>

      <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/95 px-4 py-3 backdrop-blur md:hidden">
        <span className="text-sm font-semibold">B2B Orders</span>
        <Button variant="ghost" size="icon-sm" aria-label={mobileOpen ? 'Close menu' : 'Open menu'} onClick={() => setMobileOpen((o) => !o)}>
          {mobileOpen ? <X /> : <Menu />}
        </Button>
      </header>
      {mobileOpen && (
        <div className="fixed inset-x-0 top-[53px] bottom-0 z-20 bg-background md:hidden">
          <Sidebar onNavigate={() => setMobileOpen(false)} />
        </div>
      )}

      <main className="min-w-0 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
