import { and, asc, count, desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import type { DB } from '../db/client';
import { orders, quoteItems, quotes, QUOTE_STATUSES, type QuoteStatus } from '../db/schema';
import { invalidState, notFound } from '../lib/errors';
import { doc } from '../lib/openapi';
import { IdParams, paginated, PaginationQuery, z } from '../lib/zod';
import { auth, requirePermission } from '../middleware/auth';
import { assertCustomer, Currency, LineItem, LineItemInput, nextDocumentNumber, resolveLines, TaxRateBps, type Tx } from './line-items';
import { insertOrder, loadOrder } from './orders';

const Status = z.enum(QUOTE_STATUSES);
const IsoDate = z.iso.date().openapi({ example: '2026-12-31' });

const CreateQuoteBody = z
  .object({
    customerId: z.uuid(),
    validUntil: IsoDate.nullish(),
    currency: Currency.default('USD'),
    taxRateBps: TaxRateBps.default(0),
    notes: z.string().trim().max(2000).nullish(),
    items: z.array(LineItemInput).min(1).max(200),
  })
  .openapi('CreateQuoteRequest');

const UpdateQuoteBody = z
  .object({
    customerId: z.uuid(),
    validUntil: IsoDate.nullable(),
    currency: Currency,
    taxRateBps: TaxRateBps,
    notes: z.string().trim().max(2000).nullable(),
    items: z.array(LineItemInput).min(1).max(200).openapi({ description: 'Replaces all line items' }),
  })
  .partial()
  .openapi('UpdateQuoteRequest');

const ConvertQuoteBody = z
  .object({ poNumber: z.string().trim().max(100).nullish() })
  .openapi('ConvertQuoteRequest');

const QuoteListQuery = PaginationQuery.extend({ status: Status.optional(), customerId: z.uuid().optional() });

const QuoteSummary = z
  .object({
    id: z.uuid(),
    number: z.string(),
    customerId: z.uuid(),
    status: Status,
    validUntil: z.string().nullable(),
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
  .openapi('QuoteSummary');

const Quote = QuoteSummary.extend({ items: z.array(LineItem) }).openapi('Quote');

const T = 'Quotes';
doc({ method: 'get', path: '/quotes', tag: T, summary: 'List quotes (filter by status or customer)', permission: 'quotes:read', query: QuoteListQuery, response: paginated(QuoteSummary) });
doc({ method: 'post', path: '/quotes', tag: T, summary: 'Create a draft quote', permission: 'quotes:write', body: CreateQuoteBody, response: Quote, status: 201 });
doc({ method: 'get', path: '/quotes/{id}', tag: T, summary: 'Get a quote with line items', permission: 'quotes:read', params: IdParams, response: Quote });
doc({ method: 'patch', path: '/quotes/{id}', tag: T, summary: 'Edit a draft quote', permission: 'quotes:write', params: IdParams, body: UpdateQuoteBody, response: Quote });
doc({ method: 'delete', path: '/quotes/{id}', tag: T, summary: 'Delete a draft quote', permission: 'quotes:write', params: IdParams, status: 204 });
doc({ method: 'post', path: '/quotes/{id}/send', tag: T, summary: 'Mark a draft quote as sent to the customer', permission: 'quotes:write', params: IdParams, response: Quote });
doc({ method: 'post', path: '/quotes/{id}/accept', tag: T, summary: 'Record customer acceptance (fails and expires the quote if past validUntil)', permission: 'quotes:write', params: IdParams, response: Quote });
doc({ method: 'post', path: '/quotes/{id}/reject', tag: T, summary: 'Record customer rejection', permission: 'quotes:write', params: IdParams, response: Quote });
doc({ method: 'post', path: '/quotes/{id}/convert', tag: T, summary: 'Convert an accepted quote into an order (once per quote)', permission: 'orders:write', params: IdParams, body: ConvertQuoteBody, status: 201 });

const stripQuote = ({ organizationId: _o, ...rest }: typeof quotes.$inferSelect) => rest;
const today = () => new Date().toISOString().slice(0, 10);

async function loadQuote(db: DB | Tx, organizationId: string, id: string) {
  const row = await db.query.quotes.findFirst({
    where: and(eq(quotes.id, id), eq(quotes.organizationId, organizationId)),
    with: { items: { orderBy: asc(quoteItems.position), columns: { quoteId: false } } },
  });
  if (!row) throw notFound('Quote');
  const { organizationId: _o, ...rest } = row;
  return rest;
}

/** Locks the quote row for the rest of the transaction and returns it. */
async function lockQuote(tx: Tx, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(quotes)
    .where(and(eq(quotes.id, id), eq(quotes.organizationId, organizationId)))
    .for('update');
  if (!row) throw notFound('Quote');
  return row;
}

function requireStatus(current: QuoteStatus, allowed: QuoteStatus, action: string) {
  if (current !== allowed) throw invalidState(`Cannot ${action} a quote in '${current}' status (must be '${allowed}')`);
}

export function quotesRouter(db: DB) {
  const router = Router();

  router.get('/', requirePermission('quotes:read'), async (req, res) => {
    const { organizationId } = auth(req);
    const { page, pageSize, status, customerId } = QuoteListQuery.parse(req.query);
    const where = and(
      eq(quotes.organizationId, organizationId),
      status ? eq(quotes.status, status) : undefined,
      customerId ? eq(quotes.customerId, customerId) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db.select().from(quotes).where(where).orderBy(desc(quotes.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ n: count() }).from(quotes).where(where),
    ]);
    res.json({ data: rows.map(stripQuote), meta: { page, pageSize, total: total?.n ?? 0 } });
  });

  router.post('/', requirePermission('quotes:write'), async (req, res) => {
    const ctx = auth(req);
    const body = CreateQuoteBody.parse(req.body);
    const quote = await db.transaction(async (tx) => {
      await assertCustomer(tx, ctx.organizationId, body.customerId);
      const { lines, totals } = await resolveLines(tx, ctx.organizationId, body.items, body.taxRateBps);
      const number = await nextDocumentNumber(tx, ctx.organizationId, 'quote');
      const [row] = await tx
        .insert(quotes)
        .values({
          organizationId: ctx.organizationId,
          number,
          customerId: body.customerId,
          validUntil: body.validUntil ?? null,
          currency: body.currency,
          taxRateBps: body.taxRateBps,
          notes: body.notes ?? null,
          ...totals,
          createdById: ctx.userId,
        })
        .returning({ id: quotes.id });
      await tx.insert(quoteItems).values(lines.map((l) => ({ ...l, quoteId: row!.id })));
      return loadQuote(tx, ctx.organizationId, row!.id);
    });
    res.status(201).json(quote);
  });

  router.get('/:id', requirePermission('quotes:read'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    res.json(await loadQuote(db, organizationId, id));
  });

  router.patch('/:id', requirePermission('quotes:write'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    const { items, ...fields } = UpdateQuoteBody.parse(req.body);

    const quote = await db.transaction(async (tx) => {
      const current = await lockQuote(tx, organizationId, id);
      requireStatus(current.status, 'draft', 'edit');
      if (fields.customerId) await assertCustomer(tx, organizationId, fields.customerId);

      if (items || fields.taxRateBps !== undefined) {
        // Re-price whenever lines or tax change. Without new items, existing lines are kept as-is.
        const lineInputs =
          items ??
          (await tx.select().from(quoteItems).where(eq(quoteItems.quoteId, id)).orderBy(asc(quoteItems.position))).map((l) => ({
            productId: l.productId ?? undefined,
            description: l.description,
            quantity: l.quantity,
            unitPriceCents: l.unitPriceCents,
            discountBps: l.discountBps,
          }));
        const taxRateBps = fields.taxRateBps ?? current.taxRateBps;
        const { lines, totals } = await resolveLines(tx, organizationId, lineInputs, taxRateBps);
        await tx.delete(quoteItems).where(eq(quoteItems.quoteId, id));
        await tx.insert(quoteItems).values(lines.map((l) => ({ ...l, quoteId: id })));
        await tx.update(quotes).set({ ...fields, ...totals }).where(eq(quotes.id, id));
      } else if (Object.keys(fields).length > 0) {
        await tx.update(quotes).set(fields).where(eq(quotes.id, id));
      }
      return loadQuote(tx, organizationId, id);
    });
    res.json(quote);
  });

  router.delete('/:id', requirePermission('quotes:write'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    await db.transaction(async (tx) => {
      const current = await lockQuote(tx, organizationId, id);
      requireStatus(current.status, 'draft', 'delete');
      await tx.delete(quotes).where(eq(quotes.id, id));
    });
    res.status(204).end();
  });

  router.post('/:id/send', requirePermission('quotes:write'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    const quote = await db.transaction(async (tx) => {
      const current = await lockQuote(tx, organizationId, id);
      requireStatus(current.status, 'draft', 'send');
      if (current.validUntil && current.validUntil < today()) {
        throw invalidState('validUntil is in the past; update it before sending');
      }
      await tx.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, id));
      return loadQuote(tx, organizationId, id);
    });
    res.json(quote);
  });

  router.post('/:id/accept', requirePermission('quotes:write'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    const outcome = await db.transaction(async (tx) => {
      const current = await lockQuote(tx, organizationId, id);
      requireStatus(current.status, 'sent', 'accept');
      const expired = !!current.validUntil && current.validUntil < today();
      await tx.update(quotes).set({ status: expired ? 'expired' : 'accepted' }).where(eq(quotes.id, id));
      return expired;
    });
    // Expiry is committed before reporting the failure, so the quote's state reflects reality.
    if (outcome) throw invalidState('Quote has expired and can no longer be accepted');
    res.json(await loadQuote(db, organizationId, id));
  });

  router.post('/:id/reject', requirePermission('quotes:write'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    const quote = await db.transaction(async (tx) => {
      const current = await lockQuote(tx, organizationId, id);
      requireStatus(current.status, 'sent', 'reject');
      await tx.update(quotes).set({ status: 'rejected' }).where(eq(quotes.id, id));
      return loadQuote(tx, organizationId, id);
    });
    res.json(quote);
  });

  router.post('/:id/convert', requirePermission('orders:write'), async (req, res) => {
    const ctx = auth(req);
    const { id } = IdParams.parse(req.params);
    const { poNumber } = ConvertQuoteBody.parse(req.body ?? {});

    const order = await db.transaction(async (tx) => {
      const current = await lockQuote(tx, ctx.organizationId, id);
      requireStatus(current.status, 'accepted', 'convert');
      const [existing] = await tx.select({ number: orders.number }).from(orders).where(eq(orders.quoteId, id));
      if (existing) throw invalidState(`Quote was already converted to order ${existing.number}`);

      const items = await tx.select().from(quoteItems).where(eq(quoteItems.quoteId, id)).orderBy(asc(quoteItems.position));
      const orderId = await insertOrder(tx, ctx, {
        customerId: current.customerId,
        quoteId: id,
        poNumber,
        currency: current.currency,
        taxRateBps: current.taxRateBps,
        notes: current.notes,
        lines: items.map(({ id: _i, quoteId: _q, ...line }) => line),
        totals: { subtotalCents: current.subtotalCents, taxCents: current.taxCents, totalCents: current.totalCents },
      });
      return loadOrder(tx, ctx.organizationId, orderId);
    });
    res.status(201).json(order);
  });

  return router;
}
