import { and, asc, count, desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import type { DB } from '../db/client';
import { orderItems, orders, orderStatusHistory, ORDER_STATUSES, type OrderStatus } from '../db/schema';
import { invalidState, notFound } from '../lib/errors';
import { doc } from '../lib/openapi';
import { IdParams, paginated, PaginationQuery, z } from '../lib/zod';
import { auth, requirePermission, type AuthContext } from '../middleware/auth';
import {
  assertCustomer, Currency, LineItem, LineItemInput, nextDocumentNumber, resolveLines, TaxRateBps,
  type ResolvedLine, type Tx,
} from './line-items';
import type { Totals } from '../lib/pricing';

/** Allowed order lifecycle transitions. Terminal states: delivered, cancelled. */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

const Status = z.enum(ORDER_STATUSES);

const CreateOrderBody = z
  .object({
    customerId: z.uuid(),
    poNumber: z.string().trim().max(100).nullish().openapi({ description: "Customer's purchase order number" }),
    currency: Currency.default('USD'),
    taxRateBps: TaxRateBps.default(0),
    notes: z.string().trim().max(2000).nullish(),
    items: z.array(LineItemInput).min(1).max(200),
  })
  .openapi('CreateOrderRequest');

const ChangeStatusBody = z
  .object({ status: Status, note: z.string().trim().max(1000).optional() })
  .openapi('ChangeOrderStatusRequest');

const OrderListQuery = PaginationQuery.extend({ status: Status.optional(), customerId: z.uuid().optional() });

const OrderSummary = z
  .object({
    id: z.uuid(),
    number: z.string(),
    customerId: z.uuid(),
    quoteId: z.uuid().nullable(),
    status: Status,
    poNumber: z.string().nullable(),
    currency: z.string(),
    notes: z.string().nullable(),
    taxRateBps: z.number().int(),
    subtotalCents: z.number().int(),
    taxCents: z.number().int(),
    totalCents: z.number().int(),
    createdById: z.uuid(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .openapi('OrderSummary');

const StatusChange = z.object({
  fromStatus: Status.nullable(),
  toStatus: Status,
  changedById: z.uuid(),
  note: z.string().nullable(),
  createdAt: z.date(),
});

const Order = OrderSummary.extend({ items: z.array(LineItem), history: z.array(StatusChange) }).openapi('Order');

const T = 'Orders';
doc({ method: 'get', path: '/orders', tag: T, summary: 'List orders (filter by status or customer)', permission: 'orders:read', query: OrderListQuery, response: paginated(OrderSummary) });
doc({ method: 'post', path: '/orders', tag: T, summary: 'Create an order directly (without a quote)', permission: 'orders:write', body: CreateOrderBody, response: Order, status: 201 });
doc({ method: 'get', path: '/orders/{id}', tag: T, summary: 'Get an order with line items and status history', permission: 'orders:read', params: IdParams, response: Order });
doc({ method: 'post', path: '/orders/{id}/status', tag: T, summary: 'Move an order through its lifecycle: pending → confirmed → shipped → delivered (or cancelled)', permission: 'orders:status', params: IdParams, body: ChangeStatusBody, response: Order });

const stripOrder = ({ organizationId: _o, ...rest }: typeof orders.$inferSelect) => rest;

export async function loadOrder(db: DB | Tx, organizationId: string, id: string) {
  const row = await db.query.orders.findFirst({
    where: and(eq(orders.id, id), eq(orders.organizationId, organizationId)),
    with: {
      items: { orderBy: asc(orderItems.position), columns: { orderId: false } },
      history: { orderBy: asc(orderStatusHistory.createdAt), columns: { id: false, orderId: false } },
    },
  });
  if (!row) throw notFound('Order');
  const { organizationId: _o, ...rest } = row;
  return rest;
}

interface NewOrder {
  customerId: string;
  quoteId?: string | null;
  poNumber?: string | null;
  currency: string;
  taxRateBps: number;
  notes?: string | null;
  lines: ResolvedLine[];
  totals: Totals;
}

/** Inserts an order, its line items and the initial status-history entry. Must run inside a transaction. */
export async function insertOrder(tx: Tx, ctx: AuthContext, input: NewOrder): Promise<string> {
  const number = await nextDocumentNumber(tx, ctx.organizationId, 'order');
  const [order] = await tx
    .insert(orders)
    .values({
      organizationId: ctx.organizationId,
      number,
      customerId: input.customerId,
      quoteId: input.quoteId ?? null,
      poNumber: input.poNumber ?? null,
      currency: input.currency,
      taxRateBps: input.taxRateBps,
      notes: input.notes ?? null,
      ...input.totals,
      createdById: ctx.userId,
    })
    .returning({ id: orders.id });
  await tx.insert(orderItems).values(input.lines.map((l) => ({ ...l, orderId: order!.id })));
  await tx.insert(orderStatusHistory).values({ orderId: order!.id, fromStatus: null, toStatus: 'pending', changedById: ctx.userId });
  return order!.id;
}

export function ordersRouter(db: DB) {
  const router = Router();

  router.get('/', requirePermission('orders:read'), async (req, res) => {
    const { organizationId } = auth(req);
    const { page, pageSize, status, customerId } = OrderListQuery.parse(req.query);
    const where = and(
      eq(orders.organizationId, organizationId),
      status ? eq(orders.status, status) : undefined,
      customerId ? eq(orders.customerId, customerId) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db.select().from(orders).where(where).orderBy(desc(orders.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ n: count() }).from(orders).where(where),
    ]);
    res.json({ data: rows.map(stripOrder), meta: { page, pageSize, total: total?.n ?? 0 } });
  });

  router.post('/', requirePermission('orders:write'), async (req, res) => {
    const ctx = auth(req);
    const body = CreateOrderBody.parse(req.body);
    const order = await db.transaction(async (tx) => {
      await assertCustomer(tx, ctx.organizationId, body.customerId);
      const { lines, totals } = await resolveLines(tx, ctx.organizationId, body.items, body.taxRateBps);
      const id = await insertOrder(tx, ctx, { ...body, lines, totals });
      return loadOrder(tx, ctx.organizationId, id);
    });
    res.status(201).json(order);
  });

  router.get('/:id', requirePermission('orders:read'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    res.json(await loadOrder(db, organizationId, id));
  });

  router.post('/:id/status', requirePermission('orders:status'), async (req, res) => {
    const ctx = auth(req);
    const { id } = IdParams.parse(req.params);
    const { status: next, note } = ChangeStatusBody.parse(req.body);

    const order = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ status: orders.status })
        .from(orders)
        .where(and(eq(orders.id, id), eq(orders.organizationId, ctx.organizationId)))
        .for('update');
      if (!current) throw notFound('Order');
      if (!ORDER_TRANSITIONS[current.status].includes(next)) {
        throw invalidState(`Cannot change order status from '${current.status}' to '${next}'`);
      }
      await tx.update(orders).set({ status: next }).where(eq(orders.id, id));
      await tx.insert(orderStatusHistory).values({
        orderId: id, fromStatus: current.status, toStatus: next, changedById: ctx.userId, note: note ?? null,
      });
      return loadOrder(tx, ctx.organizationId, id);
    });
    res.json(order);
  });

  return router;
}
