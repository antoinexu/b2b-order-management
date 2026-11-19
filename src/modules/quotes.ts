import { and, asc, count, desc, eq, gte, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import type { DB } from '../db/client';
import { customers, orders, organizations, quoteDeliveries, quoteItems, quotes, quoteStatusHistory, users, QUOTE_STATUSES, type QuoteStatus } from '../db/schema';
import { todayIn } from '../lib/dates';
import { invalidState, notFound } from '../lib/errors';
import { doc } from '../lib/openapi';
import { renderQuotePdf, type QuotePdfData } from '../lib/quote-pdf';
import { IdParams, paginated, PaginationQuery, z } from '../lib/zod';
import { auth, requirePermission, type AuthContext } from '../middleware/auth';
import { assertCustomer, Currency, DocumentCurrency, LineItem, LineItemInput, nextDocumentNumber, resolveLines, TaxRateBps, type Tx } from './line-items';
import { insertOrder, loadOrder, Order } from './orders';
import { enforcePricingPolicy } from './pricing-policy';

const Status = z.enum(QUOTE_STATUSES);
const IsoDate = z.iso.date().openapi({ example: '2026-12-31' });

const CreateQuoteBody = z
  .object({
    customerId: z.uuid(),
    validUntil: IsoDate.nullish(),
    currency: DocumentCurrency,
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
    customerName: z.string(),
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

const QuoteStatusChange = z
  .object({
    fromStatus: Status.nullable(),
    toStatus: Status,
    changedById: z.uuid().nullable().openapi({ description: 'The staff member, or null when the customer responded online' }),
    changedByName: z.string().nullable(),
    changedByCustomer: z.string().nullable().openapi({ description: 'The customer who responded online, as "Name <email>"' }),
    note: z.string().nullable(),
    createdAt: z.date(),
  })
  .openapi('QuoteStatusChange');

const Quote = QuoteSummary.extend({
  items: z.array(LineItem),
  history: z.array(QuoteStatusChange).openapi({
    description: 'Recorded status changes, oldest first. Lazy expiry (a sent quote passing validUntil) is not recorded here.',
  }),
}).openapi('Quote');

const T = 'Quotes';
doc({ method: 'get', path: '/quotes', tag: T, summary: "List quotes (filter by status or customer). Sent quotes past validUntil (in the organization's time zone) are reported as expired", permission: 'quotes:read', query: QuoteListQuery, response: paginated(QuoteSummary) });
doc({ method: 'post', path: '/quotes', tag: T, summary: 'Create a draft quote', permission: 'quotes:write', body: CreateQuoteBody, response: Quote, status: 201 });
doc({ method: 'get', path: '/quotes/{id}', tag: T, summary: 'Get a quote with line items', permission: 'quotes:read', params: IdParams, response: Quote });
doc({ method: 'get', path: '/quotes/{id}/pdf', tag: T, summary: 'Download the quote as a PDF. Drafts, expired and rejected quotes carry a watermark', permission: 'quotes:read', params: IdParams, file: 'application/pdf' });
doc({ method: 'patch', path: '/quotes/{id}', tag: T, summary: 'Edit a draft quote (not while it is being emailed)', permission: 'quotes:write', params: IdParams, body: UpdateQuoteBody, response: Quote });
doc({ method: 'delete', path: '/quotes/{id}', tag: T, summary: 'Delete a draft quote (not while it is being emailed)', permission: 'quotes:write', params: IdParams, status: 204 });
doc({ method: 'post', path: '/quotes/{id}/send', tag: T, summary: 'Mark a draft quote as sent to the customer', permission: 'quotes:write', params: IdParams, response: Quote });
doc({ method: 'post', path: '/quotes/{id}/accept', tag: T, summary: 'Record customer acceptance (fails and expires the quote if past validUntil)', permission: 'quotes:write', params: IdParams, response: Quote });
doc({ method: 'post', path: '/quotes/{id}/reject', tag: T, summary: 'Record customer rejection (not allowed once the quote is past validUntil)', permission: 'quotes:write', params: IdParams, response: Quote });
doc({ method: 'post', path: '/quotes/{id}/convert', tag: T, summary: 'Convert an accepted quote into an order (once per quote)', permission: 'orders:write', params: IdParams, body: ConvertQuoteBody, response: Order, status: 201 });

const stripQuote = ({ organizationId: _o, ...rest }: typeof quotes.$inferSelect) => rest;
/**
 * A quote is valid through the end of its `validUntil` day in the organization's time zone.
 * `today` is the current calendar date in that zone (see `todayIn`).
 */
export const isPastValidity = (validUntil: string | null, today: string) => !!validUntil && validUntil < today;
/** The organization a quote is read for: its id, and its time zone, which decides expiry. */
export type QuoteScope = Pick<AuthContext, 'organizationId' | 'timezone'>;
export const todayFor = (scope: QuoteScope) => todayIn(scope.timezone);

/**
 * A sent quote past its validUntil date is expired, even if nobody has tried to accept it yet.
 * Reads report the effective status, so lists, filters and dashboards never show stale "sent" quotes.
 */
export const effectiveStatus = (quote: { status: QuoteStatus; validUntil: string | null }, today: string): QuoteStatus =>
  quote.status === 'sent' && isPastValidity(quote.validUntil, today) ? 'expired' : quote.status;

function statusFilter(status: QuoteStatus, today: string): SQL | undefined {
  if (status === 'sent') return and(eq(quotes.status, 'sent'), or(isNull(quotes.validUntil), gte(quotes.validUntil, today)));
  if (status === 'expired') return or(eq(quotes.status, 'expired'), and(eq(quotes.status, 'sent'), lt(quotes.validUntil, today)));
  return eq(quotes.status, status);
}

export async function loadQuote(db: DB | Tx, ctx: QuoteScope, id: string) {
  const row = await db.query.quotes.findFirst({
    where: and(eq(quotes.id, id), eq(quotes.organizationId, ctx.organizationId)),
    with: {
      items: { orderBy: asc(quoteItems.position), columns: { quoteId: false } },
      customer: { columns: { companyName: true } },
      history: {
        orderBy: [asc(quoteStatusHistory.createdAt), asc(quoteStatusHistory.id)],
        columns: { fromStatus: true, toStatus: true, changedById: true, changedByCustomer: true, note: true, createdAt: true },
        with: { changedBy: { columns: { name: true } } },
      },
    },
  });
  if (!row) throw notFound('Quote');
  const { organizationId: _o, customer, history, ...rest } = row;
  return {
    ...rest,
    status: effectiveStatus(rest, todayFor(ctx)),
    customerName: customer.companyName,
    history: history.map(({ changedBy, ...h }) => ({ ...h, changedByName: changedBy?.name ?? null })),
  };
}

/** Everything the quote PDF shows, read in one place so the download and the emailed copy are identical. */
export async function quotePdfData(db: DB | Tx, ctx: QuoteScope, id: string): Promise<QuotePdfData> {
  const quote = await loadQuote(db, ctx, id);
  const [[customer], [organization], [creator]] = await Promise.all([
    db.select().from(customers).where(eq(customers.id, quote.customerId)),
    db.select({ name: organizations.name, timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, ctx.organizationId)),
    db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, quote.createdById)),
  ]);
  return { organization: organization!, quote, customer: customer!, items: quote.items, preparedBy: creator! };
}

/** Who changed a quote's status: a staff member's id, or a customer responding through an emailed link. */
export type StatusActor = string | { customer: string; note: string | null };

/** Appends an audit entry for a status change. Must run in the same transaction as the change. */
export async function recordStatus(tx: Tx, quoteId: string, from: QuoteStatus | null, to: QuoteStatus, actor: StatusActor) {
  const who = typeof actor === 'string'
    ? { changedById: actor }
    : { changedByCustomer: actor.customer, note: actor.note };
  // clock_timestamp(), not now(): now() is the transaction start, which can predate a change made while waiting for a lock.
  await tx.insert(quoteStatusHistory).values({ quoteId, fromStatus: from, toStatus: to, ...who, createdAt: sql`clock_timestamp()` });
}

/** An attempt still in `sending` after this long is presumed dead (e.g. the process crashed) and may be retried. */
export const SENDING_LEASE_MS = 5 * 60_000;

/**
 * Refuses changes while an email of this quote is in flight, so a customer never receives something other than
 * what the quote says. Callers hold the quote's row lock, which delivery attempts also take before sending.
 */
export async function assertNotBeingEmailed(tx: Tx, quoteId: string) {
  const [inFlight] = await tx.select({ id: quoteDeliveries.id }).from(quoteDeliveries).where(and(
    eq(quoteDeliveries.quoteId, quoteId),
    eq(quoteDeliveries.status, 'sending'),
    gte(quoteDeliveries.lastAttemptAt, sql`now() - make_interval(secs => ${SENDING_LEASE_MS / 1000})`),
  )).limit(1);
  if (inFlight) throw invalidState('This quote is being emailed right now. Try again in a moment.');
}

/** Locks the quote row for the rest of the transaction and returns it. */
export async function lockQuote(tx: Tx, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(quotes)
    .where(and(eq(quotes.id, id), eq(quotes.organizationId, organizationId)))
    .for('update');
  if (!row) throw notFound('Quote');
  return row;
}

export function requireStatus(current: QuoteStatus, allowed: QuoteStatus, action: string) {
  if (current !== allowed) throw invalidState(`Cannot ${action} a quote in '${current}' status (must be '${allowed}')`);
}

export function quotesRouter(db: DB) {
  const router = Router();

  router.get('/', requirePermission('quotes:read'), async (req, res) => {
    const ctx = auth(req);
    const today = todayFor(ctx);
    const { page, pageSize, status, customerId } = QuoteListQuery.parse(req.query);
    const where = and(
      eq(quotes.organizationId, ctx.organizationId),
      status ? statusFilter(status, today) : undefined,
      customerId ? eq(quotes.customerId, customerId) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select({ quote: quotes, customerName: customers.companyName })
        .from(quotes)
        .innerJoin(customers, eq(customers.id, quotes.customerId))
        .where(where)
        .orderBy(desc(quotes.createdAt), desc(quotes.number))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ n: count() }).from(quotes).where(where),
    ]);
    const data = rows.map(({ quote, customerName }) => ({ ...stripQuote(quote), status: effectiveStatus(quote, today), customerName }));
    res.json({ data, meta: { page, pageSize, total: total?.n ?? 0 } });
  });

  router.post('/', requirePermission('quotes:write'), async (req, res) => {
    const ctx = auth(req);
    const body = CreateQuoteBody.parse(req.body);
    const quote = await db.transaction(async (tx) => {
      await assertCustomer(tx, ctx.organizationId, body.customerId);
      const currency = body.currency ?? ctx.currency;
      const { lines, totals, catalogPrices } = await resolveLines(tx, ctx.organizationId, body.items, body.taxRateBps);
      await enforcePricingPolicy(tx, ctx, { lines, catalogPrices, currency });
      const number = await nextDocumentNumber(tx, ctx.organizationId, 'quote');
      const [row] = await tx
        .insert(quotes)
        .values({
          organizationId: ctx.organizationId,
          number,
          customerId: body.customerId,
          validUntil: body.validUntil ?? null,
          currency,
          taxRateBps: body.taxRateBps,
          notes: body.notes ?? null,
          ...totals,
          createdById: ctx.userId,
        })
        .returning({ id: quotes.id });
      await tx.insert(quoteItems).values(lines.map((l) => ({ ...l, quoteId: row!.id })));
      await recordStatus(tx, row!.id, null, 'draft', ctx.userId);
      return loadQuote(tx, ctx, row!.id);
    });
    res.status(201).json(quote);
  });

  router.get('/:id', requirePermission('quotes:read'), async (req, res) => {
    const ctx = auth(req);
    const { id } = IdParams.parse(req.params);
    res.json(await loadQuote(db, ctx, id));
  });

  router.get('/:id/pdf', requirePermission('quotes:read'), async (req, res) => {
    const ctx = auth(req);
    const { id } = IdParams.parse(req.params);
    const data = await quotePdfData(db, ctx, id);
    const pdf = await renderQuotePdf(data);
    // Quotes are confidential: keep them out of shared caches.
    res.set('Cache-Control', 'private, no-store').type('application/pdf').attachment(`${data.quote.number}.pdf`).send(pdf);
  });

  router.patch('/:id', requirePermission('quotes:write'), async (req, res) => {
    const ctx = auth(req);
    const { organizationId } = ctx;
    const { id } = IdParams.parse(req.params);
    const { items, ...fields } = UpdateQuoteBody.parse(req.body);

    const quote = await db.transaction(async (tx) => {
      const current = await lockQuote(tx, organizationId, id);
      requireStatus(current.status, 'draft', 'edit');
      await assertNotBeingEmailed(tx, id);
      if (fields.customerId) await assertCustomer(tx, organizationId, fields.customerId);

      // Agreed prices hold only for the customer and currency they were given for.
      const retargeted = (fields.customerId !== undefined && fields.customerId !== current.customerId)
        || (fields.currency !== undefined && fields.currency !== current.currency);
      if (items || fields.taxRateBps !== undefined || retargeted) {
        // Re-price whenever lines or tax change. Without new items, existing lines are kept as-is.
        const existing = await tx.select().from(quoteItems).where(eq(quoteItems.quoteId, id)).orderBy(asc(quoteItems.position));
        const lineInputs =
          items ??
          existing.map((l) => ({
            productId: l.productId ?? undefined,
            description: l.description,
            quantity: l.quantity,
            unitPriceCents: l.unitPriceCents,
            discountBps: l.discountBps,
          }));
        const taxRateBps = fields.taxRateBps ?? current.taxRateBps;
        const { lines, totals, catalogPrices } = await resolveLines(tx, organizationId, lineInputs, taxRateBps);
        // A tax change alone keeps agreed prices. New or changed lines, or a new customer or currency, are checked.
        if (items || retargeted) {
          await enforcePricingPolicy(tx, ctx, {
            lines, catalogPrices, currency: fields.currency ?? current.currency, existing: retargeted ? [] : existing,
          });
        }
        await tx.delete(quoteItems).where(eq(quoteItems.quoteId, id));
        await tx.insert(quoteItems).values(lines.map((l) => ({ ...l, quoteId: id })));
        await tx.update(quotes).set({ ...fields, ...totals }).where(eq(quotes.id, id));
      } else if (Object.keys(fields).length > 0) {
        await tx.update(quotes).set(fields).where(eq(quotes.id, id));
      }
      // Emails prepared from the previous version can no longer be sent (see quote deliveries).
      await tx.update(quotes).set({ revision: sql`${quotes.revision} + 1` }).where(eq(quotes.id, id));
      return loadQuote(tx, ctx, id);
    });
    res.json(quote);
  });

  router.delete('/:id', requirePermission('quotes:write'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    await db.transaction(async (tx) => {
      const current = await lockQuote(tx, organizationId, id);
      requireStatus(current.status, 'draft', 'delete');
      await assertNotBeingEmailed(tx, id);
      await tx.delete(quotes).where(eq(quotes.id, id));
    });
    res.status(204).end();
  });

  router.post('/:id/send', requirePermission('quotes:write'), async (req, res) => {
    const ctx = auth(req);
    const { id } = IdParams.parse(req.params);
    const quote = await db.transaction(async (tx) => {
      const current = await lockQuote(tx, ctx.organizationId, id);
      requireStatus(current.status, 'draft', 'send');
      if (isPastValidity(current.validUntil, todayFor(ctx))) {
        throw invalidState(`validUntil is in the past (today is ${todayFor(ctx)} in ${ctx.timezone}); update it before sending`);
      }
      await tx.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, id));
      await recordStatus(tx, id, 'draft', 'sent', ctx.userId);
      return loadQuote(tx, ctx, id);
    });
    res.json(quote);
  });

  router.post('/:id/accept', requirePermission('quotes:write'), async (req, res) => {
    const ctx = auth(req);
    const { id } = IdParams.parse(req.params);
    const outcome = await db.transaction(async (tx) => {
      const current = await lockQuote(tx, ctx.organizationId, id);
      requireStatus(current.status, 'sent', 'accept');
      const expired = isPastValidity(current.validUntil, todayFor(ctx));
      const next = expired ? 'expired' : 'accepted';
      await tx.update(quotes).set({ status: next }).where(eq(quotes.id, id));
      await recordStatus(tx, id, 'sent', next, ctx.userId);
      return expired;
    });
    // Expiry is committed before reporting the failure, so the quote's state reflects reality.
    if (outcome) throw invalidState('Quote has expired and can no longer be accepted');
    res.json(await loadQuote(db, ctx, id));
  });

  router.post('/:id/reject', requirePermission('quotes:write'), async (req, res) => {
    const ctx = auth(req);
    const { id } = IdParams.parse(req.params);
    const quote = await db.transaction(async (tx) => {
      const current = await lockQuote(tx, ctx.organizationId, id);
      requireStatus(effectiveStatus(current, todayFor(ctx)), 'sent', 'reject');
      await tx.update(quotes).set({ status: 'rejected' }).where(eq(quotes.id, id));
      await recordStatus(tx, id, 'sent', 'rejected', ctx.userId);
      return loadQuote(tx, ctx, id);
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
