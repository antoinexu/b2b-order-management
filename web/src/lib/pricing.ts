/**
 * Client-side price preview. Uses the same integer math and rounding as the backend
 * (src/lib/pricing.ts) so the totals shown while editing match what the server stores.
 */
const BPS = 10_000n;
export const MAX_MONEY_CENTS = 2_147_483_647;
export const MAX_QUANTITY = 1_000_000;
export const MAX_LINE_ITEMS = 200;
export const isMoneyCents = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_MONEY_CENTS;
const isRate = (value: number) => Number.isInteger(value) && value >= 0 && value <= 10_000;
const roundBps = (value: bigint) => (value + BPS / 2n) / BPS;
const checkedMoney = (value: bigint): number | null => value >= 0n && value <= BigInt(MAX_MONEY_CENTS) ? Number(value) : null;

export function lineTotalCents(quantity: number, unitPriceCents: number, discountBps: number): number | null {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY || !isMoneyCents(unitPriceCents) || !isRate(discountBps)) return null;
  return checkedMoney(roundBps(BigInt(quantity) * BigInt(unitPriceCents) * (BPS - BigInt(discountBps))));
}

/**
 * Mirrors the API's discount limit for users without `pricing:override` (src/lib/pricing.ts there):
 * the net unit price may not fall more than `maxDiscountBps` below the catalog price. (Custom lines, which
 * have no catalog price, are off limits to them entirely.) Returns a message, or null when the line is allowed.
 */
export function discountViolation(unitPriceCents: number, discountBps: number, catalogPriceCents: number, maxDiscountBps: number): string | null {
  const net = BigInt(unitPriceCents) * (BPS - BigInt(discountBps));
  if (net >= BigInt(catalogPriceCents) * (BPS - BigInt(maxDiscountBps))) return null;
  const effectiveBps = Number(BPS - net / BigInt(catalogPriceCents));
  return `${Number((effectiveBps / 100).toFixed(2))}% off the catalog price exceeds your ${Number((maxDiscountBps / 100).toFixed(2))}% limit.`;
}

export function computeTotals(lineTotals: number[], taxRateBps: number) {
  if (!lineTotals.every(isMoneyCents) || !isRate(taxRateBps)) return null;
  const subtotal = lineTotals.reduce((sum, n) => sum + BigInt(n), 0n);
  const tax = roundBps(subtotal * BigInt(taxRateBps));
  if (checkedMoney(subtotal) === null || checkedMoney(tax) === null || checkedMoney(subtotal + tax) === null) return null;
  return { subtotalCents: Number(subtotal), taxCents: Number(tax), totalCents: Number(subtotal + tax) };
}
