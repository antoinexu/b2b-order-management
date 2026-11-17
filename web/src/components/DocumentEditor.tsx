import { Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '@/api/client';
import type { LineItemInput, Quote } from '@/api/types';
import { CatalogPicker, CUSTOM_ITEM, type CatalogOption } from '@/components/CatalogPicker';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { centsToInput, formatMoney, parseMoneyToCents, parsePercentToBps } from '@/lib/format';
import { computeTotals, lineTotalCents, MAX_LINE_ITEMS, MAX_MONEY_CENTS, MAX_QUANTITY } from '@/lib/pricing';


interface LineDraft {
  key: number;
  productId: string; // CUSTOM_ITEM for free-text lines
  description: string;
  quantity: string;
  price: string;
  discount: string; // percent
}

export interface DocumentDraft {
  customerId: string;
  currency: string;
  taxRateBps: number;
  notes: string | null;
  items: LineItemInput[];
  validUntil: string | null;
  poNumber: string | null;
}

interface Props {
  kind: 'quote' | 'order';
  initial?: Quote;
  submitLabel: string;
  isSubmitting: boolean;
  error: unknown;
  onSubmit: (draft: DocumentDraft) => void;
  onCancel: () => void;
}

let nextKey = 1;
const blankLine = (): LineDraft => ({ key: nextKey++, productId: '', description: '', quantity: '1', price: '', discount: '0' });

function parseLine(line: LineDraft) {
  const quantity = Number(line.quantity);
  const unitPriceCents = parseMoneyToCents(line.price);
  const discountBps = parsePercentToBps(line.discount);
  const valid = Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_QUANTITY && unitPriceCents !== null && discountBps !== null
    && line.productId !== '' && line.description.trim() !== '';
  return { quantity, unitPriceCents, discountBps, valid };
}

export function DocumentEditor({ kind, initial, submitLabel, isSubmitting, error, onSubmit, onCancel }: Props) {
  const [customerId, setCustomerId] = useState(initial?.customerId ?? '');
  const [taxRate, setTaxRate] = useState(initial ? String(initial.taxRateBps / 100) : '0');
  const [validUntil, setValidUntil] = useState(initial?.validUntil ?? '');
  const [poNumber, setPoNumber] = useState('');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [lines, setLines] = useState<LineDraft[]>(() =>
    initial
      ? initial.items.map((item) => ({
          key: nextKey++,
          productId: item.productId ?? CUSTOM_ITEM,
          description: item.description,
          quantity: String(item.quantity),
          price: centsToInput(item.unitPriceCents),
          discount: String(item.discountBps / 100),
        }))
      : [blankLine()],
  );

  const updateLine = (key: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const pickProduct = (key: number, option: CatalogOption | null) => {
    const product = option?.product;
    updateLine(key, product
      ? { productId: product.id, description: product.name, price: centsToInput(product.unitPriceCents) }
      : { productId: option?.id ?? '' });
  };

  const currency = initial?.currency ?? 'USD';
  const money = (cents: number | null | undefined) => cents == null ? '—' : formatMoney(cents, currency);
  const taxRateBps = parsePercentToBps(taxRate);
  const parsed = lines.map(parseLine);
  const lineTotals = parsed.map((p) => (p.valid ? lineTotalCents(p.quantity, p.unitPriceCents!, p.discountBps!) : null));
  const totals = lineTotals.every((total) => total !== null) && taxRateBps !== null
    ? computeTotals(lineTotals as number[], taxRateBps) : null;
  const canSubmit = customerId !== '' && totals !== null && lines.length > 0 && lines.length <= MAX_LINE_ITEMS && parsed.every((p) => p.valid);
  const pricingError = parsed.every((p) => p.valid) && taxRateBps !== null && !totals
    ? `Line amounts and the total including tax must not exceed ${money(MAX_MONEY_CENTS)}.` : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      customerId,
      currency,
      taxRateBps: taxRateBps!,
      notes: notes.trim() || null,
      validUntil: validUntil || null,
      poNumber: poNumber.trim() || null,
      items: lines.map((line, i) => ({
        productId: line.productId === CUSTOM_ITEM ? undefined : line.productId,
        description: line.description.trim(),
        quantity: parsed[i]!.quantity,
        unitPriceCents: parsed[i]!.unitPriceCents!,
        discountBps: parsed[i]!.discountBps!,
      })),
    });
  };

  return (
    <form onSubmit={submit} className="grid gap-6">
      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FormField id="customer" label="Customer" className="sm:col-span-2 lg:col-span-1">
            <CatalogPicker resource="customers" id="customer" label="Customer" value={customerId}
              selectedLabel={initial?.customerName} onChange={(option) => setCustomerId(option?.id ?? '')} />
          </FormField>
          {kind === 'quote' ? (
            <FormField id="validUntil" label="Valid until">
              <Input id="validUntil" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </FormField>
          ) : (
            <FormField id="poNumber" label="Customer PO number">
              <Input id="poNumber" maxLength={100} value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
            </FormField>
          )}
          <FormField id="taxRate" label="Tax rate (%)" error={taxRateBps === null ? 'Enter a percentage between 0 and 100' : null}>
            <Input id="taxRate" inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} aria-invalid={taxRateBps === null} />
          </FormField>
          <FormField id="notes" label="Notes" className="sm:col-span-2 lg:col-span-3">
            <Textarea id="notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Line items</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          <div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,2fr)_5rem_7rem_5.5rem_7rem_2rem] gap-2 px-1 text-xs font-medium text-muted-foreground lg:grid">
            <span>Product</span><span>Description</span><span>Qty</span><span>Unit price</span><span>Discount %</span><span className="text-right">Line total</span><span />
          </div>
          {lines.map((line, i) => (
            <div key={line.key} className="grid grid-cols-2 gap-2 rounded-md border p-3 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,2fr)_5rem_7rem_5.5rem_7rem_2rem] lg:items-center lg:border-0 lg:p-1">
              <div className="col-span-2 lg:col-span-1">
                <CatalogPicker resource="products" label={`Line ${i + 1} product`} value={line.productId}
                  selectedLabel={line.description} onChange={(option) => pickProduct(line.key, option)} />
              </div>
              <Input className="col-span-2 lg:col-span-1" aria-label={`Line ${i + 1} description`} placeholder="Description" maxLength={500}
                value={line.description} onChange={(e) => updateLine(line.key, { description: e.target.value })} />
              <Input aria-label={`Line ${i + 1} quantity`} type="number" min={1} max={MAX_QUANTITY} step={1} value={line.quantity}
                onChange={(e) => updateLine(line.key, { quantity: e.target.value })} />
              <Input aria-label={`Line ${i + 1} unit price`} inputMode="decimal" placeholder="0.00" value={line.price}
                aria-invalid={line.price !== '' && parseMoneyToCents(line.price) === null}
                onChange={(e) => updateLine(line.key, { price: e.target.value })} />
              <Input aria-label={`Line ${i + 1} discount percent`} inputMode="decimal" value={line.discount}
                aria-invalid={parsePercentToBps(line.discount) === null}
                onChange={(e) => updateLine(line.key, { discount: e.target.value })} />
              <span className="self-center text-right text-sm tabular-nums">{money(lineTotals[i])}</span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1}
                onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}>
                <Trash2 />
              </Button>
              {line.price !== '' && parsed[i]!.unitPriceCents === null && <p role="alert" className="col-span-full text-xs text-destructive">
                Enter a unit price between {money(0)} and {money(MAX_MONEY_CENTS)}, with at most two decimal places.
              </p>}
              {(!Number.isInteger(parsed[i]!.quantity) || parsed[i]!.quantity < 1 || parsed[i]!.quantity > MAX_QUANTITY)
                && <p role="alert" className="col-span-full text-xs text-destructive">Quantity must be a whole number between 1 and {MAX_QUANTITY}.</p>}
            </div>
          ))}
          <div>
            <Button type="button" variant="outline" size="sm" disabled={lines.length >= MAX_LINE_ITEMS} onClick={() => setLines((ls) => [...ls, blankLine()])}><Plus /> Add line</Button>
          </div>

          <dl className="ml-auto grid w-full max-w-xs grid-cols-2 gap-y-1 border-t pt-4 text-sm">
            <dt className="text-muted-foreground">Subtotal</dt><dd className="text-right tabular-nums">{money(totals?.subtotalCents)}</dd>
            <dt className="text-muted-foreground">Tax</dt><dd className="text-right tabular-nums">{money(totals?.taxCents)}</dd>
            <dt className="font-medium">Total</dt><dd className="text-right font-semibold tabular-nums">{money(totals?.totalCents)}</dd>
          </dl>
        </CardContent>
      </Card>

      {pricingError && <p role="alert" className="text-sm text-destructive">{pricingError}</p>}
      {error ? <p role="alert" className="text-sm text-destructive">{errorMessage(error)}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={!canSubmit || isSubmitting}>{isSubmitting ? 'Saving…' : submitLabel}</Button>
      </div>
    </form>
  );
}
