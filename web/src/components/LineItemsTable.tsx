import type { LineItem } from '@/api/types';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBps, formatMoney } from '@/lib/format';

interface Props {
  items: Pick<LineItem, 'description' | 'quantity' | 'unitPriceCents' | 'discountBps' | 'lineTotalCents'>[];
  currency: string;
  subtotalCents: number;
  taxCents: number;
  taxRateBps: number;
  totalCents: number;
}

export function LineItemsTable({ items, currency, subtotalCents, taxCents, taxRateBps, totalCents }: Props) {
  const money = (cents: number) => formatMoney(cents, currency);
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Unit price</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Discount</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item, i) => (
            <TableRow key={i}>
              <TableCell className="whitespace-normal">{item.description}</TableCell>
              <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{money(item.unitPriceCents)}</TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{item.discountBps ? formatBps(item.discountBps) : '—'}</TableCell>
              <TableCell className="text-right tabular-nums">{money(item.lineTotalCents)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={4} className="hidden text-right text-muted-foreground sm:table-cell">Subtotal</TableCell>
            <TableCell colSpan={2} className="text-right text-muted-foreground sm:hidden">Subtotal</TableCell>
            <TableCell className="text-right tabular-nums">{money(subtotalCents)}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell colSpan={4} className="hidden text-right text-muted-foreground sm:table-cell">Tax ({formatBps(taxRateBps)})</TableCell>
            <TableCell colSpan={2} className="text-right text-muted-foreground sm:hidden">Tax ({formatBps(taxRateBps)})</TableCell>
            <TableCell className="text-right tabular-nums">{money(taxCents)}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell colSpan={4} className="hidden text-right font-semibold sm:table-cell">Total</TableCell>
            <TableCell colSpan={2} className="text-right font-semibold sm:hidden">Total</TableCell>
            <TableCell className="text-right font-semibold tabular-nums">{money(totalCents)}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}
