import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, errorMessage, unwrap } from '@/api/client';
import type { Customer } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormField } from '@/components/FormField';
import { PageHeader } from '@/components/PageHeader';
import { Pagination } from '@/components/Pagination';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/States';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useDebounced } from '@/lib/use-debounced';

const PAGE_SIZE = 20;

export function CustomersPage() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);

  const customers = useQuery({
    queryKey: ['customers', { page, q }],
    queryFn: () => unwrap(api.GET('/customers', { params: { query: { page, pageSize: PAGE_SIZE, q: q || undefined } } })),
    placeholderData: keepPreviousData,
  });

  const canWrite = can('customers:write');

  return (
    <>
      <PageHeader
        title="Customers"
        description="Companies you sell to."
        actions={canWrite && <Button onClick={() => setEditing('new')}><Plus /> New customer</Button>}
      />

      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          className="pl-8"
          placeholder="Search company, contact or email"
          aria-label="Search customers"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      {customers.isPending ? <TableSkeleton /> : customers.isError ? (
        <ErrorState error={customers.error} onRetry={() => customers.refetch()} />
      ) : customers.data.data.length === 0 ? (
        <EmptyState
          title={q ? 'No matching customers' : 'No customers yet'}
          description={q ? 'Try a different search.' : 'Add your first customer to start quoting.'}
        />
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead className="hidden md:table-cell">Email</TableHead>
                  <TableHead className="hidden sm:table-cell">Phone</TableHead>
                  <TableHead className="text-right">Terms</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.data.data.map((c) => (
                  <TableRow
                    key={c.id}
                    className={canWrite ? 'cursor-pointer' : undefined}
                    onClick={canWrite ? () => setEditing(c) : undefined}
                  >
                    <TableCell className="font-medium">{c.companyName}</TableCell>
                    <TableCell>{c.contactName ?? '—'}</TableCell>
                    <TableCell className="hidden md:table-cell">{c.email ?? '—'}</TableCell>
                    <TableCell className="hidden sm:table-cell">{c.phone ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">Net {c.paymentTermsDays}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={customers.data.meta.total} onPageChange={setPage} />
        </>
      )}

      {editing && (
        <CustomerDialog
          customer={editing === 'new' ? null : editing}
          canDelete={can('customers:delete')}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

const empty = { companyName: '', contactName: '', email: '', phone: '', billingAddress: '', shippingAddress: '', paymentTermsDays: '30', notes: '' };

function CustomerDialog({ customer, canDelete, onClose }: { customer: Customer | null; canDelete: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => customer ? {
    companyName: customer.companyName,
    contactName: customer.contactName ?? '',
    email: customer.email ?? '',
    phone: customer.phone ?? '',
    billingAddress: customer.billingAddress ?? '',
    shippingAddress: customer.shippingAddress ?? '',
    paymentTermsDays: String(customer.paymentTermsDays),
    notes: customer.notes ?? '',
  } : empty);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const done = (message: string) => {
    queryClient.invalidateQueries({ queryKey: ['customers'] });
    toast.success(message);
    onClose();
  };

  const save = useMutation({
    mutationFn: () => {
      // Empty optional fields are sent as null so clearing a field actually clears it.
      const nullable = (v: string) => (v.trim() === '' ? null : v.trim());
      const body = {
        companyName: form.companyName.trim(),
        contactName: nullable(form.contactName),
        email: nullable(form.email),
        phone: nullable(form.phone),
        billingAddress: nullable(form.billingAddress),
        shippingAddress: nullable(form.shippingAddress),
        paymentTermsDays: Number(form.paymentTermsDays),
        notes: nullable(form.notes),
      };
      return customer
        ? unwrap(api.PATCH('/customers/{id}', { params: { path: { id: customer.id } }, body }))
        : unwrap(api.POST('/customers', { body }));
    },
    onSuccess: () => done(customer ? 'Customer updated' : 'Customer created'),
    meta: { inlineError: true },
  });

  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/customers/{id}', { params: { path: { id: customer!.id } } })),
    onSuccess: () => done('Customer deleted'),
  });

  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{customer ? 'Edit customer' : 'New customer'}</DialogTitle>
        </DialogHeader>
        <form id="customer-form" className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          <FormField id="companyName" label="Company name" className="sm:col-span-2">
            <Input id="companyName" required maxLength={200} value={form.companyName} onChange={set('companyName')} autoFocus />
          </FormField>
          <FormField id="contactName" label="Contact name">
            <Input id="contactName" value={form.contactName} onChange={set('contactName')} />
          </FormField>
          <FormField id="email" label="Email">
            <Input id="email" type="email" value={form.email} onChange={set('email')} />
          </FormField>
          <FormField id="phone" label="Phone">
            <Input id="phone" type="tel" value={form.phone} onChange={set('phone')} />
          </FormField>
          <FormField id="paymentTermsDays" label="Payment terms (days)">
            <Input id="paymentTermsDays" type="number" min={0} max={365} required value={form.paymentTermsDays} onChange={set('paymentTermsDays')} />
          </FormField>
          <FormField id="billingAddress" label="Billing address" className="sm:col-span-2">
            <Textarea id="billingAddress" rows={2} value={form.billingAddress} onChange={set('billingAddress')} />
          </FormField>
          <FormField id="shippingAddress" label="Shipping address" className="sm:col-span-2">
            <Textarea id="shippingAddress" rows={2} value={form.shippingAddress} onChange={set('shippingAddress')} />
          </FormField>
          <FormField id="notes" label="Notes" className="sm:col-span-2">
            <Textarea id="notes" rows={2} value={form.notes} onChange={set('notes')} />
          </FormField>
        </form>
        {save.error && <p role="alert" className="text-sm text-destructive">{errorMessage(save.error)}</p>}
        <DialogFooter className="sm:justify-between">
          {customer && canDelete ? (
            <ConfirmDialog
              trigger={<Button variant="destructive" type="button" disabled={remove.isPending}><Trash2 /> Delete</Button>}
              title="Delete this customer?"
              description="Customers with quotes or orders can't be deleted. This can't be undone."
              confirmLabel="Delete customer"
              destructive
              onConfirm={() => remove.mutate()}
            />
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
            <Button type="submit" form="customer-form" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
