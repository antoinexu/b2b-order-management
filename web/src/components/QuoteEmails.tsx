import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, RotateCw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { errorMessage, unwrap } from '@/api/client';
import type { Quote, QuoteDelivery } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { FormField } from '@/components/FormField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUS: Record<QuoteDelivery['status'], { label: string; className: string }> = {
  sending: { label: 'Sending', className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  sent: { label: 'Sent', className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' },
  failed: { label: 'Failed', className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' },
};

export function DeliveryStatus({ status }: { status: QuoteDelivery['status'] }) {
  return <Badge className={cn('border-transparent', STATUS[status].className)}>{STATUS[status].label}</Badge>;
}

const deliveriesKey = (quoteId: string) => ['quotes', quoteId, 'deliveries'];

function useRetry(quoteId: string) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      unwrap(api.POST('/quotes/{id}/deliveries/{deliveryId}/retry', { params: { path: { id: quoteId, deliveryId } } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['quotes'] }),
  });
}

export function EmailQuoteDialog({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const customer = useQuery({
    queryKey: ['customers', quote.customerId],
    queryFn: () => unwrap(api.GET('/customers/{id}', { params: { path: { id: quote.customerId } } })),
  });
  const [form, setForm] = useState<{ recipientEmail: string; recipientName: string; message: string } | null>(null);
  const values = form ?? { recipientEmail: customer.data?.email ?? '', recipientName: customer.data?.contactName ?? '', message: '' };
  // One key per distinct email: a double click repeats the key (and is answered without sending again), while
  // changing the form after a failure makes it a new email.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<QuoteDelivery | null>(null);
  const update = (patch: Partial<typeof values>) => {
    setForm({ ...values, ...patch });
    setIdempotencyKey(crypto.randomUUID());
    setResult(null);
  };

  const done = (delivery: QuoteDelivery) => {
    setResult(delivery);
    queryClient.invalidateQueries({ queryKey: ['quotes'] });
    if (delivery.status === 'sent') {
      toast.success(`Quote emailed to ${delivery.recipientEmail}`);
      onClose();
    }
  };
  const send = useMutation({
    mutationFn: () => unwrap(api.POST('/quotes/{id}/deliveries', {
      params: { path: { id: quote.id }, header: { 'idempotency-key': idempotencyKey } },
      body: {
        recipientEmail: values.recipientEmail.trim(),
        recipientName: values.recipientName.trim() || undefined,
        message: values.message.trim() || undefined,
      },
    })),
    onSuccess: done,
    meta: { inlineError: true },
  });
  const retry = useRetry(quote.id);
  const busy = send.isPending || retry.isPending;
  const failed = result?.status === 'failed' ? result : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    // A failed email is retried as the same delivery rather than sent as a new one.
    if (failed) retry.mutate(failed.id, { onSuccess: done });
    else send.mutate();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Email {quote.number}</DialogTitle>
          <DialogDescription>
            The customer gets the PDF and a link to accept or decline online.
            {quote.status === 'draft' && ' The quote is marked as sent once the email goes out.'}
          </DialogDescription>
        </DialogHeader>
        <form id="email-quote-form" className="grid gap-4" onSubmit={submit}>
          <FormField id="email-to" label="To">
            <Input id="email-to" type="email" required value={values.recipientEmail} disabled={busy}
              placeholder={customer.isPending ? 'Loading customer…' : 'name@company.com'}
              onChange={(e) => update({ recipientEmail: e.target.value })} />
          </FormField>
          <FormField id="email-name" label="Recipient name (optional)">
            <Input id="email-name" maxLength={200} value={values.recipientName} disabled={busy}
              onChange={(e) => update({ recipientName: e.target.value })} />
          </FormField>
          <FormField id="email-message" label="Message (optional)" hint="Shown above the quote summary. Replies come to your email address.">
            <Textarea id="email-message" rows={3} maxLength={2000} value={values.message} disabled={busy}
              onChange={(e) => update({ message: e.target.value })} />
          </FormField>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Paperclip className="size-3.5" /> {quote.number}.pdf</p>
        </form>
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            The email could not be sent{failed.attempts > 1 ? ` (attempt ${failed.attempts})` : ''}: {failed.lastError}
          </p>
        )}
        {result?.status === 'sending' && <p role="status" className="text-sm text-muted-foreground">This email is already being sent.</p>}
        {(send.error || retry.error) && <p role="alert" className="text-sm text-destructive">{errorMessage(send.error ?? retry.error)}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>{failed ? 'Close' : 'Cancel'}</Button>
          <Button type="submit" form="email-quote-form" disabled={busy || !values.recipientEmail.trim()}>
            {busy ? 'Sending…' : failed ? 'Try again' : 'Send email'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Every email of the quote: who sent it to whom, when, and whether it went out. */
export function QuoteEmailsCard({ quote }: { quote: Quote }) {
  const { api, can } = useAuth();
  const deliveries = useQuery({
    queryKey: deliveriesKey(quote.id),
    queryFn: () => unwrap(api.GET('/quotes/{id}/deliveries', { params: { path: { id: quote.id } } })),
    // An attempt in flight resolves within seconds; poll until it does.
    refetchInterval: (query) => (query.state.data?.data.some((d) => d.status === 'sending') ? 3_000 : false),
  });
  const retry = useRetry(quote.id);
  const list = deliveries.data?.data ?? [];
  if (list.length === 0) return null;

  return (
    <Card>
      <CardHeader><CardTitle>Emails</CardTitle></CardHeader>
      <CardContent>
        <ul className="grid min-w-0 grid-cols-1 gap-3 text-sm">
          {list.map((d) => (
            <li key={d.id} className="grid min-w-0 gap-0.5" aria-label={`Email to ${d.recipientEmail}`}>
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium" title={d.recipientEmail}>{d.recipientEmail}</span>
                <DeliveryStatus status={d.status} />
              </div>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(d.sentAt ?? d.lastAttemptAt ?? d.createdAt)} · by {d.sentByName}
                {d.attempts > 1 && ` · ${d.attempts} attempts`}
              </p>
              {d.status === 'failed' && d.lastError && <p className="text-xs text-destructive">{d.lastError}</p>}
              {d.retryable && can('quotes:write') && (
                <Button variant="outline" size="sm" className="mt-1 justify-self-start" disabled={retry.isPending}
                  aria-label={`Retry email to ${d.recipientEmail}`}
                  onClick={() => retry.mutate(d.id, {
                    onSuccess: (r) => (r.status === 'sent' ? toast.success(`Quote emailed to ${r.recipientEmail}`)
                      : toast.error(`Still failing: ${r.lastError}`)),
                  })}>
                  <RotateCw /> Retry
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
