import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { customers, organizations, products } from '../db/schema';
import { isSupportedCurrency } from '../lib/currency';
import { badRequest, notFound } from '../lib/errors';
import { computeTotals, formatDocumentNumber, lineTotalCents, type Totals } from '../lib/pricing';
import { MoneyCents, z } from '../lib/zod';

export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type DbOrTx = DB | Tx;

export const LineItemInput = z
  .object({
    productId: z.uuid().optional().openapi({ description: 'Catalog product; description and price default from it' }),
    description: z.string().trim().min(1).max(500).optional(),
    quantity: z.number().int().min(1).max(1_000_000),
    unitPriceCents: MoneyCents.optional().openapi({ description: 'Overrides the catalog price' }),
    discountBps: z.number().int().min(0).max(10_000).default(0).openapi({ description: 'Line discount, 100 = 1%' }),
  })
  .openapi('LineItemInput');

export const LineItem = z
  .object({
    id: z.uuid(),
    productId: z.uuid().nullable(),
    description: z.string(),
    quantity: z.number().int(),
    unitPriceCents: z.number().int(),
    discountBps: z.number().int(),
    lineTotalCents: z.number().int(),
    position: z.number().int(),
  })
  .openapi('LineItem');

export const TaxRateBps = z.number().int().min(0).max(10_000).openapi({ description: 'Tax rate, 825 = 8.25%' });
export const Currency = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 code like USD')
  .refine(isSupportedCurrency, 'Must be a currency with two decimal places, such as USD, EUR or GBP');
/** Document currency on create; omitted means the organization's base currency. */
export const DocumentCurrency = Currency.optional().openapi({ description: "Defaults to the organization's base currency" });

export interface ResolvedLine {
  productId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountBps: number;
  lineTotalCents: number;
  position: number;
}

/**
 * Turns line-item input into priced lines. Catalog products supply default description and price;
 * prices are snapshotted so later catalog changes never alter existing quotes or orders.
 */
export async function resolveLines(
  db: DbOrTx,
  organizationId: string,
  items: z.infer<typeof LineItemInput>[],
  taxRateBps: number,
): Promise<{ lines: ResolvedLine[]; totals: Totals; catalogPrices: Map<string, number> }> {
  const productIds = [...new Set(items.flatMap((i) => (i.productId ? [i.productId] : [])))];
  const catalog = productIds.length
    ? await db
        .select()
        .from(products)
        .where(and(eq(products.organizationId, organizationId), inArray(products.id, productIds)))
    : [];
  const byId = new Map(catalog.map((p) => [p.id, p]));

  const lines = items.map((item, index): ResolvedLine => {
    const product = item.productId ? byId.get(item.productId) : undefined;
    if (item.productId && !product) throw badRequest(`items[${index}].productId does not exist`);
    const description = item.description ?? product?.name;
    const unitPriceCents = item.unitPriceCents ?? product?.unitPriceCents;
    if (!description) throw badRequest(`items[${index}].description is required when no productId is given`);
    if (unitPriceCents === undefined) {
      throw badRequest(`items[${index}].unitPriceCents is required when no productId is given`);
    }
    const priced = { quantity: item.quantity, unitPriceCents, discountBps: item.discountBps };
    return {
      productId: product?.id ?? null,
      description,
      ...priced,
      lineTotalCents: lineTotalCents(priced),
      position: index + 1,
    };
  });

  return {
    lines,
    totals: computeTotals(lines.map((l) => l.lineTotalCents), taxRateBps),
    catalogPrices: new Map(catalog.map((p) => [p.id, p.unitPriceCents])),
  };
}

export async function assertCustomer(db: DbOrTx, organizationId: string, customerId: string) {
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.organizationId, organizationId)));
  if (!row) throw notFound('Customer');
}

/** Allocates the next per-tenant document number atomically (row lock on the organization). */
export async function nextDocumentNumber(tx: Tx, organizationId: string, kind: 'quote' | 'order'): Promise<string> {
  const where = eq(organizations.id, organizationId);
  if (kind === 'quote') {
    const [row] = await tx
      .update(organizations)
      .set({ quoteSeq: sql`${organizations.quoteSeq} + 1` })
      .where(where)
      .returning({ seq: organizations.quoteSeq });
    return formatDocumentNumber('Q', row!.seq);
  }
  const [row] = await tx
    .update(organizations)
    .set({ orderSeq: sql`${organizations.orderSeq} + 1` })
    .where(where)
    .returning({ seq: organizations.orderSeq });
  return formatDocumentNumber('SO', row!.seq);
}
