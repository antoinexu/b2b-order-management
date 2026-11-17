import { Combobox } from '@base-ui/react/combobox';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { errorMessage, unwrap } from '@/api/client';
import type { Product } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { useDebounced } from '@/lib/use-debounced';

export const CUSTOM_ITEM = 'custom';
const PAGE_SIZE = 50;

export interface CatalogOption {
  id: string;
  label: string;
  product?: Product;
}

interface Props {
  resource: 'customers' | 'products';
  id?: string;
  label: string;
  value: string;
  selectedLabel?: string;
  onChange: (option: CatalogOption | null) => void;
}

export function CatalogPicker({ resource, id, label, value, selectedLabel, onChange }: Props) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const toProduct = (product: Product): CatalogOption => ({ id: product.id, label: `${product.sku} — ${product.name}`, product });
  const results = useInfiniteQuery({
    queryKey: [resource, 'lookup', q],
    initialPageParam: 1,
    queryFn: async ({ pageParam, signal }) => {
      const query = { page: pageParam, pageSize: PAGE_SIZE, q: q || undefined };
      if (resource === 'customers') {
        const response = await unwrap(api.GET('/customers', { params: { query }, signal }));
        return { ...response, data: response.data.map((c): CatalogOption => ({ id: c.id, label: c.companyName })) };
      }
      const response = await unwrap(api.GET('/products', { params: { query }, signal }));
      return { ...response, data: response.data.map(toProduct) };
    },
    getNextPageParam: (last) => last.meta.page * last.meta.pageSize < last.meta.total ? last.meta.page + 1 : undefined,
    enabled: open,
  });
  const selected = useQuery({
    queryKey: [resource, 'lookup', 'selected', value],
    queryFn: async ({ signal }): Promise<CatalogOption> => {
      if (resource === 'customers') {
        const customer = await unwrap(api.GET('/customers/{id}', { params: { path: { id: value } }, signal }));
        return { id: customer.id, label: customer.companyName };
      }
      return toProduct(await unwrap(api.GET('/products/{id}', { params: { path: { id: value } }, signal })));
    },
    enabled: !!value && value !== CUSTOM_ITEM,
  });
  const custom: CatalogOption = { id: CUSTOM_ITEM, label: 'Custom item' };
  const options = results.data?.pages.flatMap((p) => p.data) ?? [];
  if (resource === 'products') options.push(custom);
  const current = !value ? null : value === CUSTOM_ITEM ? custom : selected.data
    ?? options.find((option) => option.id === value) ?? { id: value, label: selectedLabel ?? value };

  return (
    <Combobox.Root<CatalogOption> items={options} filter={null} value={current}
      isItemEqualToValue={(a, b) => a.id === b.id}
      itemToStringLabel={(option) => option.label}
      onValueChange={(option) => {
        // The chosen option is already loaded; seed its lookup so selecting doesn't refetch it.
        if (option && option.id !== CUSTOM_ITEM) queryClient.setQueryData([resource, 'lookup', 'selected', option.id], option);
        onChange(option);
      }} open={open}
      onOpenChange={(next) => { setOpen(next); if (!next) setSearch(''); }}
      onInputValueChange={(text, details) => {
        if (details.reason === 'input-change' || details.reason === 'input-clear') setSearch(text);
      }}>
      <div className="relative">
        <Combobox.Input id={id} aria-label={label} placeholder={`Search ${resource}…`}
          className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />
        <Combobox.Trigger aria-label={`Show ${label} options`} className="absolute inset-y-0 right-0 px-2">
          <ChevronDown className="size-4" />
        </Combobox.Trigger>
      </div>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} className="z-50">
          <Combobox.Popup className="w-(--anchor-width) min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
            <Combobox.List className="max-h-60 overflow-y-auto">
              {(option: CatalogOption) => (
                <Combobox.Item key={option.id} value={option}
                  className="cursor-default rounded-md px-2 py-1.5 text-sm data-highlighted:bg-accent data-selected:font-medium">
                  {option.label}
                </Combobox.Item>
              )}
            </Combobox.List>
            {results.isFetching && <p role="status" className="p-2 text-xs text-muted-foreground">Loading…</p>}
            {!results.isFetching && !results.isError && options.length === 0 && <p className="p-2 text-sm">No matches</p>}
            {results.isError && <div role="alert" className="p-2 text-sm text-destructive">
              {errorMessage(results.error)}
              <Button type="button" size="sm" variant="ghost" onClick={() => results.refetch()}>Try again</Button>
            </div>}
            {results.hasNextPage && <Button type="button" variant="ghost" size="sm" className="w-full"
              disabled={results.isFetching} onClick={() => results.fetchNextPage()}>Load more {resource}</Button>}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
