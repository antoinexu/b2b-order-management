import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import { errorMessage, unwrap } from '@/api/client';
import type { PublicQuote } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { FormField } from '@/components/FormField';
import { LineItemsTable } from '@/components/LineItemsTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { saveFile } from '@/lib/download';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';

const OUTCOME: Record<NonNullable<PublicQuote['response']>['status'], string> = {
  accepted: 'Accepted',
  rejected: 'Declined',
  expired: 'Expired',
};

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-svh bg-muted/40 px-4 py-10"><div className="mx-auto grid max-w-3xl gap-6">{children}</div></div>;
}

/**
 * The page a customer reaches from an emailed quote. It needs no account: the link's token (in the URL
 * fragment, which browsers never send to servers) is what grants access to this one quote.
 */
export function QuoteResponsePage() {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const token = new URLSearchParams(useLocation().hash.slice(1)).get('token');
  const [name, setName] = useState('');
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');

  const view = useQuery({
    queryKey: ['public-quote', token],
    queryFn: () => unwrap(api.POST('/public/quotes/view', { body: { token: token! } })),
    enabled: !!token,
    retry: false,
  });
  const respond = useMutation({
    mutationFn: (decision: 'accept' | 'reject') => unwrap(api.POST('/public/quotes/respond', {
      body: { token: token!, decision, name: name.trim(), note: decision === 'reject' ? note.trim() || undefined : undefined },
    })),
    onSuccess: (data) => queryClient.setQueryData(['public-quote', token], data),
    // A conflict means someone answered first or the quote lapsed: show the current state.
    onError: () => queryClient.invalidateQueries({ queryKey: ['public-quote', token] }),
    meta: { inlineError: true },
  });
  const pdf = useMutation({
    mutationFn: () => unwrap(api.POST('/public/quotes/pdf', { body: { token: token! }, parseAs: 'blob' })),
    onSuccess: (blob) => saveFile(blob, `${view.data?.quote.number ?? 'quote'}.pdf`),
    meta: { inlineError: true },
  });

  if (!token || view.isError) {
    return (
      <Shell>
        <Card>
          <CardHeader><CardTitle><h1 className="text-xl">We couldn't open this quote</h1></CardTitle></CardHeader>
          <CardContent role="alert" className="grid gap-2 text-sm">
            <p className="text-destructive">{token ? errorMessage(view.error) : 'This link is incomplete.'}</p>
            <p className="text-muted-foreground">Open the link from your email again, or reply to that email to reach the sender.</p>
          </CardContent>
        </Card>
      </Shell>
    );
  }
  if (view.isPending) return <Shell><Skeleton className="h-10 w-64" /><Skeleton className="h-64 w-full" /></Shell>;

  const { quote, organizationName, customerName, preparedBy, response, canRespond } = view.data;
  const submit = (e: FormEvent) => { e.preventDefault(); respond.mutate(declining ? 'reject' : 'accept'); };

  return (
    <Shell>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{organizationName}</p>
          <h1 className="text-2xl font-semibold">Quote {quote.number}</h1>
          <p className="text-sm text-muted-foreground">
            For {customerName} · {quote.validUntil ? `Valid through ${formatDate(quote.validUntil)}` : 'No expiry date'}
          </p>
        </div>
        <Button variant="outline" disabled={pdf.isPending} onClick={() => pdf.mutate()}><Download /> Download PDF</Button>
      </header>
      {pdf.error && <p role="alert" className="text-sm text-destructive">{errorMessage(pdf.error)}</p>}

      <LineItemsTable items={quote.items} currency={quote.currency} subtotalCents={quote.subtotalCents}
        taxCents={quote.taxCents} taxRateBps={quote.taxRateBps} totalCents={quote.totalCents} />
      {quote.notes && <p className="whitespace-pre-wrap text-sm"><span className="font-medium">Notes:</span> {quote.notes}</p>}

      {response ? (
        <Card role="status">
          <CardHeader>
            <CardTitle><h2>{OUTCOME[response.status]}</h2></CardTitle>
            <CardDescription>
              {response.status === 'expired' && !response.by
                ? 'This quote passed its validity date before it was answered.'
                : `${response.by ?? 'Recorded'}${response.at ? ` · ${formatDateTime(response.at)}` : ''}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {response.note && <p>"{response.note}"</p>}
            <p className="text-muted-foreground">
              {response.status === 'accepted'
                ? `Thank you. ${preparedBy.name} will be in touch about next steps.`
                : `Questions? Contact ${preparedBy.name} at ${preparedBy.email}.`}
            </p>
          </CardContent>
        </Card>
      ) : canRespond ? (
        <Card>
          <CardHeader>
            <CardTitle><h2>{declining ? 'Decline this quote' : 'Accept this quote'}</h2></CardTitle>
            <CardDescription>
              {declining
                ? `Let ${preparedBy.name} know why, if you like.`
                : `Accepting confirms the order of the items above for ${formatMoney(quote.totalCents, quote.currency)}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4" onSubmit={submit}>
              <FormField id="respondent" label="Your name">
                <Input id="respondent" required maxLength={200} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
              </FormField>
              {declining && (
                <FormField id="decline-note" label="Reason (optional)">
                  <Textarea id="decline-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
                </FormField>
              )}
              {respond.error && <p role="alert" className="text-sm text-destructive">{errorMessage(respond.error)}</p>}
              <div className="flex flex-wrap gap-2">
                {declining ? (
                  <>
                    <Button type="submit" variant="destructive" disabled={respond.isPending}><X /> Decline quote</Button>
                    <Button type="button" variant="ghost" onClick={() => setDeclining(false)}>Back</Button>
                  </>
                ) : (
                  <>
                    <Button type="submit" disabled={respond.isPending}><Check /> {respond.isPending ? 'Accepting…' : `Accept quote ${quote.number}`}</Button>
                    <Button type="button" variant="ghost" onClick={() => setDeclining(true)}>Decline…</Button>
                  </>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <p className="text-center text-xs text-muted-foreground">
        Sent by {preparedBy.name} ({preparedBy.email}) on {formatDateTime(view.data.sentAt)}.
      </p>
    </Shell>
  );
}
