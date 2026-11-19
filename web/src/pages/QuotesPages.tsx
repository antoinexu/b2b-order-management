import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Check, Download, Mail, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { unwrap } from '@/api/client';
import { QUOTE_STATUSES, type Quote, type QuoteStatus } from '@/api/types';
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
import { StatusTimeline, type TimelineEntry } from '@/components/StatusTimeline';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { saveFile } from '@/lib/download';
import { formatDate, formatMoney } from '@/lib/format';
import { EmailQuoteDialog, QuoteEmailsCard } from '@/components/QuoteEmails';

const PAGE_SIZE = 20;

export function QuotesPage() {
  const { api, can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? '') as QuoteStatus | '';
  const page = Number(params.get('page') ?? 1);
  const setFilter = (next: { status?: string; page?: number }) => {
    const p = new URLSearchParams(params);
    if (next.status !== undefined) { if (next.status) p.set('status', next.status); else p.delete('status'); p.delete('page'); }
    if (next.page !== undefined) p.set('page', String(next.page));
    setParams(p);
  };

  const quotes = useQuery({
    queryKey: ['quotes', { status, page }],
    queryFn: () => unwrap(api.GET('/quotes', { params: { query: { page, pageSize: PAGE_SIZE, status: status || undefined } } })),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Quotes"
        description="Price proposals sent to customers."
        actions={can('quotes:write') && <Link to="/quotes/new" className={buttonVariants()}><Plus /> New quote</Link>}
      />
      <StatusFilter statuses={QUOTE_STATUSES} value={status} onChange={(s) => setFilter({ status: s })} />

      {quotes.isPending ? <TableSkeleton /> : quotes.isError ? <ErrorState error={quotes.error} onRetry={() => quotes.refetch()} /> :
        quotes.data.data.length === 0 ? <EmptyState title="No quotes" description={status ? `No ${status} quotes.` : 'Create a quote to send pricing to a customer.'} /> : (
          <>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Valid until</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {quotes.data.data.map((q) => (
                    <TableRow key={q.id} className="cursor-pointer" onClick={() => navigate(`/quotes/${q.id}`)}>
                      <TableCell className="font-mono text-xs">
                        <Link to={`/quotes/${q.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">{q.number}</Link>
                      </TableCell>
                      <TableCell>{q.customerName}</TableCell>
                      <TableCell><StatusBadge status={q.status} /></TableCell>
                      <TableCell className="hidden md:table-cell">{formatDate(q.validUntil)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(q.totalCents, q.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination page={page} pageSize={PAGE_SIZE} total={quotes.data.meta.total} onPageChange={(p) => setFilter({ page: p })} />
          </>
        )}
    </>
  );
}

const toQuoteBody = (d: DocumentDraft) => ({
  customerId: d.customerId, currency: d.currency, taxRateBps: d.taxRateBps, notes: d.notes, validUntil: d.validUntil, items: d.items,
});

export function QuoteNewPage() {
  const { api } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: (draft: DocumentDraft) => unwrap(api.POST('/quotes', { body: toQuoteBody(draft) })),
    onSuccess: (quote) => {
      queryClient.invalidateQueries({ queryKey: ['quotes'] });
      toast.success(`Quote ${quote.number} created`);
      navigate(`/quotes/${quote.id}`);
    },
    meta: { inlineError: true },
  });
  return (
    <>
      <PageHeader title="New quote" description="Saved as a draft. You can edit it until it's sent." />
      <DocumentEditor kind="quote" submitLabel="Create draft" isSubmitting={create.isPending} error={create.error}
        onSubmit={(d) => create.mutate(d)} onCancel={() => navigate('/quotes')} />
    </>
  );
}

function useQuote(id: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: ['quotes', id],
    queryFn: () => unwrap(api.GET('/quotes/{id}', { params: { path: { id } } })),
  });
}

export function QuoteEditPage() {
  const { api } = useAuth();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const quote = useQuote(id);
  const update = useMutation({
    mutationFn: (draft: DocumentDraft) => unwrap(api.PATCH('/quotes/{id}', { params: { path: { id } }, body: toQuoteBody(draft) })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quotes'] });
      toast.success('Quote updated');
      navigate(`/quotes/${id}`);
    },
    meta: { inlineError: true },
  });

  if (quote.isPending) return <TableSkeleton />;
  if (quote.isError) return <ErrorState error={quote.error} />;
  if (quote.data.status !== 'draft') return <ErrorState error={new Error('Only draft quotes can be edited.')} />;
  return (
    <>
      <PageHeader title={`Edit ${quote.data.number}`} />
      <DocumentEditor kind="quote" initial={quote.data} submitLabel="Save changes" isSubmitting={update.isPending}
        error={update.error} onSubmit={(d) => update.mutate(d)} onCancel={() => navigate(`/quotes/${id}`)} />
    </>
  );
}

const HISTORY_LABELS: Record<QuoteStatus, string> = {
  draft: 'Created',
  sent: 'Marked as sent',
  accepted: 'Marked as accepted',
  rejected: 'Marked as rejected',
  expired: 'Expired at acceptance',
};
const CUSTOMER_LABELS: Partial<Record<QuoteStatus, string>> = {
  accepted: 'Accepted by the customer online',
  rejected: 'Declined by the customer online',
  expired: 'Expired when the customer tried to respond',
};

/** Recorded changes plus, for a sent quote that lapsed on its own, the derived expiry (never stored as an event). */
function quoteTimeline(q: Quote, timeZone: string): TimelineEntry[] {
  const entries: TimelineEntry[] = q.history.map((h) => h.changedByCustomer
    ? { label: CUSTOMER_LABELS[h.toStatus] ?? HISTORY_LABELS[h.toStatus], at: h.createdAt, by: h.changedByCustomer, detail: h.note }
    : { label: HISTORY_LABELS[h.toStatus], at: h.createdAt, by: h.changedByName ?? undefined, detail: h.note });
  if (q.status === 'expired' && q.history.at(-1)?.toStatus !== 'expired') {
    entries.push({ label: 'Validity ended', detail: `End of ${formatDate(q.validUntil)} (${timeZone})` });
  }
  return entries;
}

export function QuoteDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { api, can, me } = useAuth();
  const quote = useQuote(id);
  const [converting, setConverting] = useState(false);
  const [emailing, setEmailing] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['quotes'] });
  const action = useMutation({
    mutationFn: (kind: 'send' | 'accept' | 'reject') => {
      const path = { params: { path: { id } } };
      if (kind === 'send') return unwrap(api.POST('/quotes/{id}/send', path));
      if (kind === 'accept') return unwrap(api.POST('/quotes/{id}/accept', path));
      return unwrap(api.POST('/quotes/{id}/reject', path));
    },
    onSuccess: (q) => { refresh(); toast.success(`Quote ${q.status}`); },
    // Accepting an expired quote fails *after* the server marks it expired, so refresh either way.
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/quotes/{id}', { params: { path: { id } } })),
    onSuccess: () => { refresh(); toast.success('Draft deleted'); navigate('/quotes'); },
  });
  const downloadPdf = useMutation({
    mutationFn: () => unwrap(api.GET('/quotes/{id}/pdf', { params: { path: { id } }, parseAs: 'blob' })),
    onSuccess: (blob) => saveFile(blob, `${quote.data?.number ?? 'quote'}.pdf`),
  });

  if (quote.isPending) return <TableSkeleton />;
  if (quote.isError) return <ErrorState error={quote.error} onRetry={() => quote.refetch()} />;
  const q = quote.data;
  const canWrite = can('quotes:write');

  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-3">{q.number} <StatusBadge status={q.status} /></span>}
        description={<>For <span className="font-medium text-foreground">{q.customerName}</span> · Created {formatDate(q.createdAt)}</>}
        actions={
          <>
            <Button variant="outline" disabled={downloadPdf.isPending} onClick={() => downloadPdf.mutate()}>
              <Download /> {downloadPdf.isPending ? 'Preparing…' : 'PDF'}
            </Button>
            {canWrite && (q.status === 'draft' || q.status === 'sent') && (
              <Button variant={q.status === 'draft' ? 'default' : 'outline'} onClick={() => setEmailing(true)}><Mail /> Email to customer</Button>
            )}
            {canWrite && q.status === 'draft' && (
              <>
                <ConfirmDialog trigger={<Button variant="ghost" disabled={remove.isPending}><Trash2 /> Delete</Button>}
                  title="Delete this draft?" description="This can't be undone." confirmLabel="Delete draft" destructive onConfirm={() => remove.mutate()} />
                <Link to={`/quotes/${id}/edit`} className={buttonVariants({ variant: "outline" })}><Pencil /> Edit</Link>
                <Button variant="outline" disabled={action.isPending} title="For quotes sent some other way"
                  onClick={() => action.mutate('send')}><Send /> Mark as sent</Button>
              </>
            )}
            {canWrite && q.status === 'sent' && (
              <>
                <Button variant="outline" disabled={action.isPending} onClick={() => action.mutate('reject')}><X /> Rejected</Button>
                <Button disabled={action.isPending} onClick={() => action.mutate('accept')}><Check /> Accepted</Button>
              </>
            )}
            {can('orders:write') && q.status === 'accepted' && (
              <Button onClick={() => setConverting(true)}><ArrowRightLeft /> Convert to order</Button>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
        <LineItemsTable items={q.items} currency={q.currency} subtotalCents={q.subtotalCents} taxCents={q.taxCents} taxRateBps={q.taxRateBps} totalCents={q.totalCents} />
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardContent className="grid gap-3 text-sm">
              <Detail label="Valid until" value={formatDate(q.validUntil)} />
              <Detail label="Currency" value={q.currency} />
              <Detail label="Last updated" value={formatDate(q.updatedAt)} />
              {q.notes && <Detail label="Notes" value={<span className="whitespace-pre-wrap">{q.notes}</span>} />}
            </CardContent>
          </Card>
          <QuoteEmailsCard quote={q}
            onEmailCurrent={canWrite && (q.status === 'draft' || q.status === 'sent') ? () => setEmailing(true) : undefined} />
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent>
              <StatusTimeline entries={quoteTimeline(q, me?.organization.timezone ?? 'UTC')} />
            </CardContent>
          </Card>
        </div>
      </div>

      {converting && <ConvertDialog quoteId={id} onClose={() => setConverting(false)} />}
      {emailing && <EmailQuoteDialog quote={q} onClose={() => setEmailing(false)} />}
    </>
  );
}

function ConvertDialog({ quoteId, onClose }: { quoteId: string; onClose: () => void }) {
  const { api } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [poNumber, setPoNumber] = useState('');
  const convert = useMutation({
    mutationFn: () => unwrap(api.POST('/quotes/{id}/convert', {
      params: { path: { id: quoteId } }, body: { poNumber: poNumber.trim() || null },
    })),
    onSuccess: (order) => {
      queryClient.invalidateQueries({ queryKey: ['quotes'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      toast.success(`Order ${order.number} created`);
      navigate(`/orders/${order.id}`);
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Convert to order</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Creates a pending order with this quote's line items and prices. A quote can only be converted once.</p>
        <div className="grid gap-1.5">
          <Label htmlFor="convert-po">Customer PO number (optional)</Label>
          <Input id="convert-po" value={poNumber} maxLength={100} onChange={(e) => setPoNumber(e.target.value)} autoFocus />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={convert.isPending} onClick={() => convert.mutate()}>{convert.isPending ? 'Creating…' : 'Create order'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
