import { eq } from 'drizzle-orm';
import { hashPassword } from '../lib/password';
import { resolveLines, nextDocumentNumber, type Tx } from '../modules/line-items';
import { insertOrder } from '../modules/orders';
import type { DB } from './client';
import {
  customers, orders, orderStatusHistory, organizations, products, quoteItems, quotes, quoteStatusHistory, users,
  type OrderStatus, type QuoteStatus, type UserRole,
} from './schema';

export const DEMO_PASSWORD = 'Password123!';
const DEMO_ADMIN_EMAIL = 'admin@acme.example';

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Inserts a demo organization: one user per role, customers, products, and quotes/orders in
 * various lifecycle states. Idempotent: returns false if the demo admin already exists.
 */
export async function seedDemoData(db: DB): Promise<boolean> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_ADMIN_EMAIL));
  if (existing) return false;

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  await db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name: 'Acme Industrial Supply', timezone: 'America/Chicago' }).returning();
    const organizationId = org!.id;

    const roles: UserRole[] = ['admin', 'manager', 'sales', 'viewer'];
    const created = await tx
      .insert(users)
      .values(roles.map((role) => ({
        organizationId,
        email: `${role}@acme.example`,
        name: `Demo ${role[0]!.toUpperCase()}${role.slice(1)}`,
        role,
        passwordHash,
      })))
      .returning();
    const sales = created.find((u) => u.role === 'sales')!;
    const manager = created.find((u) => u.role === 'manager')!;

    const [summit, harbor, pinecrest] = await tx
      .insert(customers)
      .values([
        { organizationId, companyName: 'Summit Manufacturing Co.', contactName: 'Jane Cooper', email: 'jane@summit.example', phone: '+1 555 0100', paymentTermsDays: 30 },
        { organizationId, companyName: 'Harbor Logistics LLC', contactName: 'Marcus Reed', email: 'procurement@harbor.example', phone: '+1 555 0142', paymentTermsDays: 45 },
        { organizationId, companyName: 'Pinecrest Facilities', contactName: 'Priya Shah', email: 'priya@pinecrest.example', paymentTermsDays: 60 },
      ])
      .returning();

    const [bolt, nut, gloves, pallet, tape] = await tx
      .insert(products)
      .values([
        { organizationId, sku: 'BOLT-M8-50', name: 'Hex Bolt M8 x 50mm (box of 100)', unit: 'box', unitPriceCents: 2450 },
        { organizationId, sku: 'NUT-M8', name: 'Hex Nut M8 (box of 100)', unit: 'box', unitPriceCents: 980 },
        { organizationId, sku: 'GLOVE-NIT-L', name: 'Nitrile Gloves, Large (case of 1000)', unit: 'case', unitPriceCents: 8900 },
        { organizationId, sku: 'PALLET-STD', name: 'Standard Wooden Pallet 48x40', unit: 'each', unitPriceCents: 1500 },
        { organizationId, sku: 'TAPE-PKG-48', name: 'Packing Tape 48mm (case of 36)', unit: 'case', unitPriceCents: 6400 },
      ])
      .returning();

    const ctx = { userId: sales.id, organizationId, role: sales.role, timezone: org!.timezone, currency: org!.currency };

    async function demoQuote(customerId: string, status: QuoteStatus, items: Parameters<typeof resolveLines>[2], validInDays = 30) {
      const { lines, totals } = await resolveLines(tx, organizationId, items, 825);
      const [quote] = await tx
        .insert(quotes)
        .values({
          organizationId, number: await nextDocumentNumber(tx, organizationId, 'quote'), customerId, status,
          validUntil: daysFromNow(validInDays), taxRateBps: 825, ...totals, createdById: sales.id,
        })
        .returning();
      await tx.insert(quoteItems).values(lines.map((l) => ({ ...l, quoteId: quote!.id })));
      // Status history walks the quote to its seeded status, one step a day, ending an hour ago.
      const path: QuoteStatus[] = status === 'draft' ? ['draft'] : status === 'sent' ? ['draft', 'sent'] : ['draft', 'sent', status];
      await tx.insert(quoteStatusHistory).values(path.map((to, i) => ({
        quoteId: quote!.id,
        fromStatus: i === 0 ? null : path[i - 1]!,
        toStatus: to,
        changedById: sales.id,
        createdAt: new Date(Date.now() - 3_600_000 - (path.length - 1 - i) * 86_400_000),
      })));
      return { quote: quote!, lines, totals };
    }

    /**
     * Backdates an order to `daysAgo` and walks it through `path`, one step every few hours.
     * Explicit timestamps matter: now() is fixed for the whole transaction, so defaults would tie.
     */
    async function advance(t: Tx, orderId: string, daysAgo: number, path: OrderStatus[]) {
      const createdAt = new Date(Date.now() - daysAgo * 86_400_000);
      const at = (step: number) => new Date(createdAt.getTime() + step * 6 * 3_600_000);
      await t.update(orders).set({ createdAt, updatedAt: at(path.length) }).where(eq(orders.id, orderId));
      await t.update(orderStatusHistory).set({ createdAt }).where(eq(orderStatusHistory.orderId, orderId));
      let from: OrderStatus = 'pending';
      for (const [i, to] of path.entries()) {
        await t.update(orders).set({ status: to }).where(eq(orders.id, orderId));
        await t.insert(orderStatusHistory).values({ orderId, fromStatus: from, toStatus: to, changedById: manager.id, createdAt: at(i + 1) });
        from = to;
      }
    }

    await demoQuote(summit!.id, 'draft', [{ productId: bolt!.id, quantity: 40, discountBps: 500 }, { productId: nut!.id, quantity: 40, discountBps: 500 }]);
    await demoQuote(harbor!.id, 'sent', [{ productId: pallet!.id, quantity: 200, discountBps: 0 }, { productId: gloves!.id, quantity: 5, discountBps: 0 }], 14);
    await demoQuote(pinecrest!.id, 'rejected', [{ productId: gloves!.id, quantity: 20, discountBps: 1000 }]);

    const accepted = await demoQuote(summit!.id, 'accepted', [
      { productId: bolt!.id, quantity: 100, discountBps: 1000 },
      { description: 'Expedited freight', quantity: 1, unitPriceCents: 12_500, discountBps: 0 },
    ]);
    const converted = await insertOrder(tx, ctx, {
      customerId: summit!.id, quoteId: accepted.quote.id, poNumber: 'PO-77120', currency: 'USD',
      taxRateBps: 825, lines: accepted.lines, totals: accepted.totals,
    });
    await advance(tx, converted, 3, ['confirmed', 'shipped']);

    for (const [customer, items, daysAgo, path, po] of [
      [harbor!, [{ productId: tape!.id, quantity: 12, discountBps: 0 }], 9, ['confirmed', 'shipped', 'delivered'], 'HL-2291'],
      [pinecrest!, [{ productId: gloves!.id, quantity: 8, discountBps: 0 }], 2, ['confirmed'], null],
      [summit!, [{ productId: nut!.id, quantity: 25, discountBps: 0 }], 0, [], 'PO-77188'],
      [harbor!, [{ productId: pallet!.id, quantity: 50, discountBps: 0 }], 6, ['cancelled'], 'HL-2302'],
    ] as const) {
      const { lines, totals } = await resolveLines(tx, organizationId, [...items], 825);
      const id = await insertOrder(tx, ctx, { customerId: customer.id, poNumber: po, currency: 'USD', taxRateBps: 825, lines, totals });
      await advance(tx, id, daysAgo, [...path]);
    }
  });
  return true;
}
