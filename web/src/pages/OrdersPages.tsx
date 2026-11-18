import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { unwrap } from '@/api/client';
import { ORDER_STATUSES, ORDER_TRANSITIONS, type OrderStatus } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Detail } from '@/components/Detail';
import { DocumentEditor, type DocumentDraft } from '@/components/DocumentEditor';
import { LineItemsTable } from '@/components/LineItemsTable';
import { PageHeader } from '@/components/PageHeader';
import { Pagination } from '@/components/Pagination';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/States';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { StatusTimeline } from '@/components/StatusTimeline';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { capitalize, formatDate, formatMoney } from '@/lib/format';

const PAGE_SIZE = 20;

const ACTION_LABEL: Record<OrderStatus, string> = {
  pending: 'Mark pending',
  confirmed: 'Confirm order',
  shipped: 'Mark shipped',
  delivered: 'Mark delivered',
  cancelled: 'Cancel order',
};

export function OrdersPage() {
  const { api, can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? '') as OrderStatus | '';
  const page = Number(params.get('page') ?? 1);
  const setFilter = (next: { status?: string; page?: number }) => {
    const p = new URLSearchParams(params);
    if (next.status !== undefined) { if (next.status) p.set('status', next.status); else p.delete('status'); p.delete('page'); }
    if (next.page !== undefined) p.set('page', String(next.page));
    setParams(p);
  };

  const orders = useQuery({
    queryKey: ['orders', { status, page }],
    queryFn: () => unwrap(api.GET('/orders', { params: { query: { page, pageSize: PAGE_SIZE, status: status || undefined } } })),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Orders"
        description="Confirmed purchases and their fulfilment status."
        actions={can('orders:write') && <Link to="/orders/new" className={buttonVariants()}><Plus /> New order</Link>}
      />
      <StatusFilter statuses={ORDER_STATUSES} value={status} onChange={(s) => setFilter({ status: s })} />

      {orders.isPending ? <TableSkeleton /> : orders.isError ? <ErrorState error={orders.error} onRetry={() => orders.refetch()} /> :
        orders.data.data.length === 0 ? <EmptyState title="No orders" description={status ? `No ${status} orders.` : 'Convert an accepted quote or create an order directly.'} /> : (
          <>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">PO</TableHead>
                    <TableHead className="hidden sm:table-cell">Created</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.data.data.map((o) => (
                    <TableRow key={o.id} className="cursor-pointer" onClick={() => navigate(`/orders/${o.id}`)}>
                      <TableCell className="font-mono text-xs">
                        <Link to={`/orders/${o.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">{o.number}</Link>
                      </TableCell>
                      <TableCell>{o.customerName}</TableCell>
                      <TableCell><StatusBadge status={o.status} /></TableCell>
                      <TableCell className="hidden md:table-cell">{o.poNumber ?? '—'}</TableCell>
                      <TableCell className="hidden sm:table-cell">{formatDate(o.createdAt)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(o.totalCents, o.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination page={page} pageSize={PAGE_SIZE} total={orders.data.meta.total} onPageChange={(p) => setFilter({ page: p })} />
          </>
        )}
    </>
  );
}

export function OrderNewPage() {
  const { api } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: (d: DocumentDraft) => unwrap(api.POST('/orders', {
      body: { customerId: d.customerId, currency: d.currency, taxRateBps: d.taxRateBps, notes: d.notes, poNumber: d.poNumber, items: d.items },
    })),
    onSuccess: (order) => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      toast.success(`Order ${order.number} created`);
      navigate(`/orders/${order.id}`);
    },
    meta: { inlineError: true },
  });
  return (
    <>
      <PageHeader title="New order" description="For repeat purchases that don't need a quote." />
      <DocumentEditor kind="order" submitLabel="Create order" isSubmitting={create.isPending} error={create.error}
        onSubmit={(d) => create.mutate(d)} onCancel={() => navigate('/orders')} />
    </>
  );
}

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const { api, can } = useAuth();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  const order = useQuery({
    queryKey: ['orders', id],
    queryFn: () => unwrap(api.GET('/orders/{id}', { params: { path: { id } } })),
  });
  const changeStatus = useMutation({
    mutationFn: (status: OrderStatus) => unwrap(api.POST('/orders/{id}/status', {
      params: { path: { id } }, body: { status, note: note.trim() || undefined },
    })),
    onSuccess: (o) => {
      queryClient.setQueryData(['orders', id], o);
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      setNote('');
      toast.success(`Order ${o.status}`);
    },
  });

  if (order.isPending) return <TableSkeleton />;
  if (order.isError) return <ErrorState error={order.error} onRetry={() => order.refetch()} />;
  const o = order.data;
  const next = can('orders:status') ? ORDER_TRANSITIONS[o.status] : [];

  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-3">{o.number} <StatusBadge status={o.status} /></span>}
        description={<>For <span className="font-medium text-foreground">{o.customerName}</span> · Created {formatDate(o.createdAt)}</>}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="grid content-start gap-6">
          <LineItemsTable items={o.items} currency={o.currency} subtotalCents={o.subtotalCents} taxCents={o.taxCents} taxRateBps={o.taxRateBps} totalCents={o.totalCents} />

          {next.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Update status</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                <Input aria-label="Status change note" placeholder="Note (optional), e.g. tracking number" maxLength={1000}
                  value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="flex flex-wrap gap-2">
                  {next.map((status) => status === 'cancelled' ? (
                    <ConfirmDialog key={status}
                      trigger={<Button variant="destructive" disabled={changeStatus.isPending}>{ACTION_LABEL[status]}</Button>}
                      title="Cancel this order?" description="Cancelled orders can't be reopened." confirmLabel="Cancel order" destructive
                      onConfirm={() => changeStatus.mutate(status)} />
                  ) : (
                    <Button key={status} disabled={changeStatus.isPending} onClick={() => changeStatus.mutate(status)}>{ACTION_LABEL[status]}</Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardContent className="grid gap-3 text-sm">
              <Detail label="Customer PO" value={o.poNumber ?? '—'} />
              <Detail label="Source" value={o.quoteId ? <Link className="underline underline-offset-4" to={`/quotes/${o.quoteId}`}>From quote</Link> : 'Direct order'} />
              {o.notes && <Detail label="Notes" value={<span className="whitespace-pre-wrap">{o.notes}</span>} />}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent>
              <StatusTimeline entries={o.history.map((h) => ({ label: capitalize(h.toStatus), at: h.createdAt, detail: h.note }))} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
