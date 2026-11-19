import { badRequest } from './errors';

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

export const MAX_MONEY_CENTS = 2_147_483_647;
const BPS = 10_000n;

function checkedMoney(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(MAX_MONEY_CENTS)) {
    throw badRequest(`${field} must be between 0 and ${MAX_MONEY_CENTS} cents`);
  }
  return Number(value);
}

const roundBps = (value: bigint) => (value + BPS / 2n) / BPS;

export function lineTotalCents({ quantity, unitPriceCents, discountBps }: LineInput): number {
  const amount = BigInt(quantity) * BigInt(unitPriceCents) * (BPS - BigInt(discountBps));
  return checkedMoney(roundBps(amount), 'Line total');
}

export function computeTotals(lineTotals: number[], taxRateBps: number): Totals {
  const subtotal = lineTotals.reduce((sum, n) => sum + BigInt(n), 0n);
  const tax = roundBps(subtotal * BigInt(taxRateBps));
  return {
    subtotalCents: checkedMoney(subtotal, 'Subtotal'),
    taxCents: checkedMoney(tax, 'Tax'),
    totalCents: checkedMoney(subtotal + tax, 'Total'),
  };
}

const formatPercent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/**
 * Checks one line against a discount limit. The effective discount compares the net unit price
 * (after the line discount) with the catalog price, so a manual price cut counts the same as a discount.
 * Returns a human-readable violation, or null when the line is within the limit.
 */
export function discountViolation(
  line: Pick<LineInput, 'unitPriceCents' | 'discountBps'>,
  catalogPriceCents: number,
  maxDiscountBps: number,
): string | null {
  const net = BigInt(line.unitPriceCents) * (BPS - BigInt(line.discountBps));
  const floor = BigInt(catalogPriceCents) * (BPS - BigInt(maxDiscountBps));
  if (net >= floor) return null;
  // Integer division rounds the remaining price down, so the reported discount never reads as equal to the limit.
  const effectiveBps = Number(BPS - net / BigInt(catalogPriceCents));
  return `effective discount of ${formatPercent(effectiveBps)} off the catalog price exceeds the ${formatPercent(maxDiscountBps)} limit`;
}

export function formatDocumentNumber(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}
