import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { unwrap } from '@/api/client';
import type { OrderStatus } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/States';
import { StatusBadge } from '@/components/StatusBadge';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, formatMoney } from '@/lib/format';

/** Counts come from each list endpoint's `meta.total` (pageSize 1), so they stay exact at any volume. */
const ORDER_STATS: { status: OrderStatus; label: string; hint: string }[] = [
  { status: 'pending', label: 'Awaiting confirmation', hint: 'Pending orders' },
  { status: 'confirmed', label: 'Ready to ship', hint: 'Confirmed orders' },
  { status: 'shipped', label: 'In transit', hint: 'Shipped orders' },
];

export function DashboardPage() {
  const { api, me } = useAuth();

  const orderCounts = useQueries({
    queries: ORDER_STATS.map(({ status }) => ({
      queryKey: ['orders', { status, page: 1, pageSize: 1 }],
      queryFn: () => unwrap(api.GET('/orders', { params: { query: { status, pageSize: 1 } } })),
    })),
  });
  const sentQuotes = useQuery({
    queryKey: ['quotes', { status: 'sent', dashboard: true }],
    queryFn: () => unwrap(api.GET('/quotes', { params: { query: { status: 'sent', pageSize: 5 } } })),
  });
  const recentOrders = useQuery({
    queryKey: ['orders', { recent: true }],
    queryFn: () => unwrap(api.GET('/orders', { params: { query: { pageSize: 6 } } })),
  });

  const stats = [
    ...ORDER_STATS.map((s, i) => ({ ...s, to: `/orders?status=${s.status}`, value: orderCounts[i]?.data?.meta.total })),
    { status: 'sent', label: 'Quotes out', hint: 'Waiting on the customer', to: '/quotes?status=sent', value: sentQuotes.data?.meta.total },
  ];

  return (
    <>
      <PageHeader title={`Welcome back${me ? `, ${me.user.name.split(' ')[0]}` : ''}`} description={me?.organization.name} />

      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.status} to={s.to} className="rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
            <Card className="h-full transition-colors hover:bg-muted/40">
              <CardContent>
                <p className="text-sm text-muted-foreground">{s.label}</p>
                {s.value === undefined ? <Skeleton className="mt-2 h-8 w-12" /> : <p className="mt-1 text-3xl font-semibold tabular-nums">{s.value}</p>}
                <p className="mt-1 text-xs text-muted-foreground">{s.hint}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Recent orders</CardTitle>
            <CardAction><Link to="/orders" className="text-sm text-muted-foreground hover:text-foreground">View all</Link></CardAction>
          </CardHeader>
          <CardContent>
            {recentOrders.isPending ? <TableSkeleton rows={4} /> : recentOrders.isError ? <ErrorState error={recentOrders.error} /> :
              recentOrders.data.data.length === 0 ? <EmptyState title="No orders yet" /> : (
                <ul className="divide-y">
                  {recentOrders.data.data.map((o) => (
                    <li key={o.id}>
                      <Link to={`/orders/${o.id}`} className="flex items-center justify-between gap-3 py-3 hover:opacity-80">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{o.customerName}</p>
                          <p className="text-xs text-muted-foreground"><span className="font-mono">{o.number}</span> · {formatDate(o.createdAt)}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <StatusBadge status={o.status} />
                          <span className="hidden w-24 text-right text-sm tabular-nums sm:block">{formatMoney(o.totalCents, o.currency)}</span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quotes awaiting response</CardTitle>
            <CardAction><Link to="/quotes?status=sent" className="text-sm text-muted-foreground hover:text-foreground">View all</Link></CardAction>
          </CardHeader>
          <CardContent>
            {sentQuotes.isPending ? <TableSkeleton rows={3} /> : sentQuotes.isError ? <ErrorState error={sentQuotes.error} /> :
              sentQuotes.data.data.length === 0 ? <EmptyState title="Nothing waiting" description="Sent quotes appear here until the customer responds." /> : (
                <ul className="divide-y">
                  {sentQuotes.data.data.map((q) => (
                    <li key={q.id}>
                      <Link to={`/quotes/${q.id}`} className="flex items-center justify-between gap-3 py-3 hover:opacity-80">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{q.customerName}</p>
                          <p className="text-xs text-muted-foreground"><span className="font-mono">{q.number}</span> · valid until {formatDate(q.validUntil)}</p>
                        </div>
                        <span className="text-sm tabular-nums">{formatMoney(q.totalCents, q.currency)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
