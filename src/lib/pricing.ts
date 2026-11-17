/**
 * Money is stored as integer cents; rates/discounts as basis points (1 bp = 0.01%).
 * Integer math avoids floating-point rounding errors in totals.
 */
export interface LineInput {
  quantity: number;
  unitPriceCents: number;
  discountBps: number;
}

export interface Totals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

const BPS = 10_000;

export function lineTotalCents({ quantity, unitPriceCents, discountBps }: LineInput): number {
  return Math.round((quantity * unitPriceCents * (BPS - discountBps)) / BPS);
}

export function computeTotals(lineTotals: number[], taxRateBps: number): Totals {
  const subtotalCents = lineTotals.reduce((sum, n) => sum + n, 0);
  const taxCents = Math.round((subtotalCents * taxRateBps) / BPS);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export function formatDocumentNumber(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}
