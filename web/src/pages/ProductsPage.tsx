import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, errorMessage, unwrap } from '@/api/client';
import type { Product } from '@/api/types';
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
import { centsToInput, formatMoney, parseMoneyToCents } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';

const PAGE_SIZE = 20;

export function ProductsPage() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const canWrite = can('products:write');

  const products = useQuery({
    queryKey: ['products', { page, q }],
    queryFn: () => unwrap(api.GET('/products', { params: { query: { page, pageSize: PAGE_SIZE, q: q || undefined } } })),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Products"
        description={canWrite ? 'Your catalog and list prices.' : 'Your catalog and list prices. Only managers and admins can change pricing.'}
        actions={canWrite && <Button onClick={() => setEditing('new')}><Plus /> New product</Button>}
      />

      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input className="pl-8" placeholder="Search SKU or name" aria-label="Search products" value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </div>

      {products.isPending ? <TableSkeleton /> : products.isError ? (
        <ErrorState error={products.error} onRetry={() => products.refetch()} />
      ) : products.data.data.length === 0 ? (
        <EmptyState title={q ? 'No matching products' : 'No products yet'} description={q ? 'Try a different search.' : 'Add products to quote from your catalog.'} />
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Unit</TableHead>
                  <TableHead className="text-right">Unit price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.data.data.map((p) => (
                  <TableRow key={p.id} className={canWrite ? 'cursor-pointer' : undefined} onClick={canWrite ? () => setEditing(p) : undefined}>
                    <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="hidden sm:table-cell">{p.unit}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(p.unitPriceCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={products.data.meta.total} onPageChange={setPage} />
        </>
      )}

      {editing && <ProductDialog product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ProductDialog({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    sku: product?.sku ?? '',
    name: product?.name ?? '',
    unit: product?.unit ?? 'each',
    price: product ? centsToInput(product.unitPriceCents) : '',
    description: product?.description ?? '',
  });
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const priceCents = parseMoneyToCents(form.price);

  const done = (message: string) => {
    queryClient.invalidateQueries({ queryKey: ['products'] });
    toast.success(message);
    onClose();
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        sku: form.sku.trim(),
        name: form.name.trim(),
        unit: form.unit.trim() || 'each',
        unitPriceCents: priceCents!,
        description: form.description.trim() || null,
      };
      return product
        ? unwrap(api.PATCH('/products/{id}', { params: { path: { id: product.id } }, body }))
        : unwrap(api.POST('/products', { body }));
    },
    onSuccess: () => done(product ? 'Product updated' : 'Product created'),
    meta: { inlineError: true },
  });

  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/products/{id}', { params: { path: { id: product!.id } } })),
    onSuccess: () => done('Product deleted'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (priceCents !== null) save.mutate();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{product ? 'Edit product' : 'New product'}</DialogTitle></DialogHeader>
        <form id="product-form" className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          <FormField id="sku" label="SKU" hint="Unique within your organization">
            <Input id="sku" required maxLength={64} value={form.sku} onChange={set('sku')} autoFocus className="font-mono" />
          </FormField>
          <FormField id="unit" label="Unit" hint="e.g. each, box, case">
            <Input id="unit" maxLength={20} value={form.unit} onChange={set('unit')} />
          </FormField>
          <FormField id="name" label="Name" className="sm:col-span-2">
            <Input id="name" required maxLength={200} value={form.name} onChange={set('name')} />
          </FormField>
          <FormField id="price" label="Unit price (USD)" error={form.price && priceCents === null ? 'Enter an amount like 24.50' : null}>
            <Input id="price" inputMode="decimal" required placeholder="0.00" value={form.price} onChange={set('price')}
              aria-invalid={!!form.price && priceCents === null} />
          </FormField>
          <FormField id="description" label="Description" className="sm:col-span-2">
            <Textarea id="description" rows={3} value={form.description} onChange={set('description')} />
          </FormField>
        </form>
        {save.error && <p role="alert" className="text-sm text-destructive">{errorMessage(save.error)}</p>}
        <DialogFooter className="sm:justify-between">
          {product ? (
            <ConfirmDialog
              trigger={<Button variant="destructive" type="button" disabled={remove.isPending}><Trash2 /> Delete</Button>}
              title="Delete this product?"
              description="Existing quotes and orders keep their copy of the line item. This can't be undone."
              confirmLabel="Delete product"
              destructive
              onConfirm={() => remove.mutate()}
            />
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
            <Button type="submit" form="product-form" disabled={save.isPending || priceCents === null}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
