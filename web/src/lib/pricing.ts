/**
 * Client-side price preview. Uses the same integer math and rounding as the backend
 * (src/lib/pricing.ts) so the totals shown while editing match what the server stores.
 */
const BPS = 10_000n;
const roundBps = (value: bigint) => (value + BPS / 2n) / BPS;

export function lineTotalCents(quantity: number, unitPriceCents: number, discountBps: number): number {
  return Number(roundBps(BigInt(quantity) * BigInt(unitPriceCents) * (BPS - BigInt(discountBps))));
}

export function computeTotals(lineTotals: number[], taxRateBps: number) {
  const subtotal = lineTotals.reduce((sum, n) => sum + BigInt(n), 0n);
  const tax = roundBps(subtotal * BigInt(taxRateBps));
  return { subtotalCents: Number(subtotal), taxCents: Number(tax), totalCents: Number(subtotal + tax) };
}
