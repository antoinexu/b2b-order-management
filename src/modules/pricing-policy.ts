import { eq } from 'drizzle-orm';
import { organizations } from '../db/schema';
import { forbidden } from '../lib/errors';
import { hasPermission } from '../lib/permissions';
import { discountViolation } from '../lib/pricing';
import type { AuthContext } from '../middleware/auth';
import type { Tx } from './line-items';

interface PricedLine {
  productId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountBps: number;
}

interface PricingCheck {
  lines: PricedLine[];
  /** Current catalog prices of the products referenced by `lines`. */
  catalogPrices: Map<string, number>;
  /** Currency the document is priced in. */
  currency: string;
  /**
   * Lines already on the document. Identical lines (same product, description, quantity, price and discount) were
   * agreed earlier and are not rechecked, so a sales rep can still edit a draft a manager priced. Pass none when the
   * customer or currency changes: an agreed price applies only to the customer and currency it was given for.
   */
  existing?: PricedLine[];
}

// JSON keeps free-text descriptions from colliding with the other fields.
const lineKey = (l: PricedLine) => JSON.stringify([l.productId, l.description, l.quantity, l.unitPriceCents, l.discountBps]);

/**
 * Enforces the organization's pricing policy for users without `pricing:override`:
 * new or changed lines must be priced in the catalog's currency, refer to a catalog product and stay within the
 * discount limit. Custom lines have no catalog price to hold them to, so only a manager or admin can add or change them.
 */
export async function enforcePricingPolicy(tx: Tx, ctx: AuthContext, { lines, catalogPrices, currency, existing = [] }: PricingCheck) {
  if (hasPermission(ctx.role, 'pricing:override')) return;
  const [org] = await tx
    .select({ maxDiscountBps: organizations.maxDiscountBps, currency: organizations.currency })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId));

  const unchanged = new Map<string, number>();
  for (const line of existing) unchanged.set(lineKey(line), (unchanged.get(lineKey(line)) ?? 0) + 1);
  const checked = lines.flatMap((line, index) => {
    const key = lineKey(line);
    const remaining = unchanged.get(key) ?? 0;
    if (remaining > 0) {
      unchanged.set(key, remaining - 1);
      return [];
    }
    return [{ line, index }];
  });
  if (checked.length === 0) return;

  // Catalog prices carry no currency of their own, so they only mean something in the organization's currency.
  if (currency !== org!.currency) {
    throw forbidden(`Only a manager or admin can price in ${currency}; the catalog is priced in ${org!.currency}.`);
  }
  for (const { line, index } of checked) {
    if (!line.productId) {
      throw forbidden(`Line ${index + 1}: only a manager or admin can add or change custom lines.`);
    }
    const violation = discountViolation(line, catalogPrices.get(line.productId)!, org!.maxDiscountBps);
    if (violation) {
      throw forbidden(`Line ${index + 1}: ${violation}. Ask a manager or admin to set this price.`);
    }
  }
}
