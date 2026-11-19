import { and, desc, eq, sql } from 'drizzle-orm';
import { Router, type Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import type { Config } from '../config';
import type { DB } from '../db/client';
import { customers, organizations, quoteDeliveries, quotes, users, QUOTE_DELIVERY_STATUSES } from '../db/schema';
import { todayIn } from '../lib/dates';
import { QUOTE_LINK_PLACEHOLDER, quoteEmail } from '../lib/emails';
import { badRequest, conflict, emailUnavailable, invalidState, notFound, pgErrorCode, PG_UNIQUE_VIOLATION } from '../lib/errors';
import type { Mailer } from '../lib/mailer';
import { doc, EMAIL_UNAVAILABLE } from '../lib/openapi';
import { formatAmount, formatCalendarDate, renderQuotePdf } from '../lib/quote-pdf';
import { z } from '../lib/zod';
import { auth, requirePermission, type AuthContext } from '../middleware/auth';
import { Email } from './auth';
import type { Tx } from './line-items';
import {
  assertNotBeingEmailed, effectiveStatus, isPastValidity, lockQuote, quotePdfData, recordStatus, SENDING_LEASE_MS,
} from './quotes';

const QuoteParams = z.object({ id: z.uuid() });
const DeliveryParams = z.object({ id: z.uuid(), deliveryId: z.uuid() });
const IdempotencyHeaders = z.object({
  'idempotency-key': z.string().trim().min(8).max(200).openapi({
    description: 'A unique value per send (e.g. a UUID). Repeating a request with the same key returns the original delivery instead of emailing again.',
  }),
});
const SendQuoteBody = z
  .object({
    recipientEmail: Email.optional().openapi({ description: "Defaults to the customer's email" }),
    recipientName: z.string().trim().min(1).max(200).optional().openapi({ description: "Defaults to the customer's contact name when sending to the customer's email" }),
    message: z.string().trim().min(1).max(2000).optional().openapi({ description: 'A personal note shown above the quote summary' }),
  })
  .openapi('SendQuoteRequest');

export const QuoteDelivery = z
  .object({
    id: z.uuid(),
    quoteId: z.uuid(),
    status: z.enum(QUOTE_DELIVERY_STATUSES).openapi({
      description: '`sending` until the mail provider accepts the email (`sent`) or refuses it (`failed`, see `lastError`)',
    }),
    recipientEmail: z.string(),
    recipientName: z.string().nullable(),
    message: z.string().nullable(),
    subject: z.string(),
    sentById: z.uuid(),
    sentByName: z.string(),
    attempts: z.number().int(),
    lastAttemptAt: z.date().nullable(),
    lastError: z.string().nullable(),
    sentAt: z.date().nullable(),
    outdated: z.boolean().openapi({
      description: "The quote changed after this email was prepared. Its link no longer works and it can't be retried; send the current version instead.",
    }),
    retryable: z.boolean().openapi({ description: 'Whether POST .../retry may be used now: a failed or stuck email of the current, still emailable version' }),
    createdAt: z.date(),
  })
  .openapi('QuoteDelivery');

const T = 'Quote emails';
doc({ method: 'post', path: '/quotes/{id}/deliveries', tag: T, summary: "Email the quote's PDF and a link to accept or decline online. A draft becomes sent once the email is accepted by the mail provider. Answers 201 for a new delivery (check `status`: `sent` or `failed`) and 200 when replaying an Idempotency-Key", permission: 'quotes:write', params: QuoteParams, headers: IdempotencyHeaders, body: SendQuoteBody, response: QuoteDelivery, status: 201, errors: { 503: EMAIL_UNAVAILABLE } });
doc({ method: 'get', path: '/quotes/{id}/deliveries', tag: T, summary: 'Emails of this quote, newest first, with their status, recipient, sender and any failure', permission: 'quotes:read', params: QuoteParams, response: z.object({ data: z.array(QuoteDelivery) }) });
doc({ method: 'post', path: '/quotes/{id}/deliveries/{deliveryId}/retry', tag: T, summary: 'Try a failed email again, with the same content and recipient', permission: 'quotes:write', params: DeliveryParams, response: QuoteDelivery, errors: { 503: EMAIL_UNAVAILABLE } });

type DeliveryRow = typeof quoteDeliveries.$inferSelect;

export const hashLinkToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newLinkToken = () => randomBytes(32).toString('base64url');
const MAX_ERROR_LENGTH = 500;

const isStale = (row: Pick<DeliveryRow, 'status' | 'lastAttemptAt'>) =>
  row.status === 'sending' && (!row.lastAttemptAt || Date.now() - row.lastAttemptAt.getTime() > SENDING_LEASE_MS);

type QuoteState = Pick<typeof quotes.$inferSelect, 'status' | 'validUntil' | 'revision'>;

/** Why a quote can't be emailed (or an email of it retried) right now, if it can't. */
function notEmailableReason(quote: QuoteState, timezone: string): string | null {
  const today = todayIn(timezone);
  const status = effectiveStatus(quote, today);
  if (status !== 'draft' && status !== 'sent') return `Only draft or sent quotes can be emailed; this quote is ${status}`;
  if (isPastValidity(quote.validUntil, today)) {
    return `validUntil is in the past (today is ${today} in ${timezone}); update it before emailing the quote`;
  }
  return null;
}

function toDelivery(row: DeliveryRow, sentByName: string, quote: QuoteState, timezone: string): z.infer<typeof QuoteDelivery> {
  const outdated = row.quoteRevision !== quote.revision;
  return {
    id: row.id,
    quoteId: row.quoteId,
    status: row.status,
    recipientEmail: row.recipientEmail,
    recipientName: row.recipientName,
    message: row.message,
    subject: row.subject,
    sentById: row.sentById,
    sentByName,
    attempts: row.attempts,
    lastAttemptAt: row.lastAttemptAt,
    lastError: row.lastError,
    sentAt: row.sentAt,
    outdated,
    retryable: (row.status === 'failed' || isStale(row)) && !outdated && notEmailableReason(quote, timezone) === null,
    createdAt: row.createdAt,
  };
}

const quoteState = { status: quotes.status, validUntil: quotes.validUntil, revision: quotes.revision };

async function loadDelivery(db: DB | Tx, ctx: Pick<AuthContext, 'organizationId' | 'timezone'>, quoteId: string, deliveryId: string) {
  const [row] = await db.select({ delivery: quoteDeliveries, sentByName: users.name, quote: quoteState }).from(quoteDeliveries)
    .innerJoin(users, eq(users.id, quoteDeliveries.sentById))
    .innerJoin(quotes, eq(quotes.id, quoteDeliveries.quoteId))
    .where(and(eq(quoteDeliveries.id, deliveryId), eq(quoteDeliveries.quoteId, quoteId), eq(quoteDeliveries.organizationId, ctx.organizationId)));
  if (!row) throw notFound('Delivery');
  return toDelivery(row.delivery, row.sentByName, row.quote, ctx.timezone);
}

async function findByKey(db: DB | Tx, organizationId: string, quoteId: string, key: string) {
  const [row] = await db.select().from(quoteDeliveries).where(and(
    eq(quoteDeliveries.organizationId, organizationId), eq(quoteDeliveries.quoteId, quoteId), eq(quoteDeliveries.idempotencyKey, key),
  ));
  return row;
}

/** A quote can be emailed while it is a draft or awaiting the customer, and not past its validity date. */
function assertEmailable(quote: QuoteState, ctx: Pick<AuthContext, 'timezone'>) {
  const reason = notEmailableReason(quote, ctx.timezone);
  if (reason) throw invalidState(reason);
}

interface Claim {
  delivery: DeliveryRow;
  /** The link token for this attempt; only its hash is stored. */
  token: string;
}

export function quoteDeliveriesRouter(db: DB, config: Config, mailer: Mailer) {
  const router = Router();

  /**
   * Sends a claimed delivery and records the outcome. Only the attempt that holds the claim (status `sending`
   * with this attempt number) can record it, so an attempt that outlived its lease can't overwrite a newer one.
   */
  async function attempt(req: Request, ctx: AuthContext, { delivery, token }: Claim) {
    const [[sender], [quote]] = await Promise.all([
      db.select({ email: users.email }).from(users).where(eq(users.id, delivery.sentById)),
      db.select({ number: quotes.number }).from(quotes).where(eq(quotes.id, delivery.quoteId)),
    ]);
    const url = `${config.APP_URL}/quote-response#token=${token}`;
    let outcome: { ok: true; providerId: string | null } | { ok: false; error: string };
    try {
      const sent = await mailer.send({
        to: delivery.recipientEmail,
        replyTo: sender?.email,
        subject: delivery.subject,
        text: delivery.bodyText.replaceAll(QUOTE_LINK_PLACEHOLDER, url),
        html: delivery.bodyHtml.replaceAll(QUOTE_LINK_PLACEHOLDER, url),
        attachments: [{ filename: `${quote!.number}.pdf`, content: delivery.pdf }],
      });
      outcome = { ok: true, providerId: sent.id ?? null };
    } catch (err) {
      req.log.warn({ err, deliveryId: delivery.id }, 'Quote email failed');
      outcome = { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH) };
    }

    const own = and(eq(quoteDeliveries.id, delivery.id), eq(quoteDeliveries.status, 'sending'), eq(quoteDeliveries.attempts, delivery.attempts));
    await db.transaction(async (tx) => {
      // Quote first, then delivery: the same lock order as claiming, so the two never deadlock.
      const quote = await lockQuote(tx, ctx.organizationId, delivery.quoteId);
      if (!outcome.ok) {
        // A failed attempt's link was never delivered, so it must never work.
        await tx.update(quoteDeliveries).set({ status: 'failed', lastError: outcome.error, accessTokenHash: null }).where(own);
        return;
      }
      // Edits wait while an attempt is in flight, but not forever: once its lease runs out (e.g. a hung provider
      // call) the draft may be edited and even emailed again. An attempt that finishes after that did send its
      // email, so it is recorded as sent, but the quote it showed no longer exists: it changes nothing about the
      // quote, and its link is refused because revisions only ever increase (see quote-responses).
      const current = quote.revision === delivery.quoteRevision;
      const [sent] = await tx.update(quoteDeliveries)
        .set({ status: 'sent', sentAt: sql`clock_timestamp()`, providerMessageId: outcome.providerId, lastError: null })
        .where(own)
        .returning();
      if (sent && current && quote.status === 'draft') {
        await tx.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, quote.id));
        await recordStatus(tx, quote.id, 'draft', 'sent', delivery.sentById);
      }
    });
    return loadDelivery(db, ctx, delivery.quoteId, delivery.id);
  }

  router.post('/:id/deliveries', requirePermission('quotes:write'), async (req, res) => {
    const ctx = auth(req);
    const { id } = QuoteParams.parse(req.params);
    const { 'idempotency-key': key } = IdempotencyHeaders.parse(req.headers);
    const body = SendQuoteBody.parse(req.body ?? {});
    if (!mailer.enabled) throw emailUnavailable('quotes cannot be emailed.');

    /** Answers a repeated request with the delivery it created, as long as it asked for the same thing. */
    const replay = async (row: DeliveryRow) => {
      const same = (body.recipientEmail === undefined || body.recipientEmail === row.recipientEmail)
        && (body.recipientName === undefined || body.recipientName === row.recipientName)
        && (body.message ?? null) === row.message;
      if (!same) throw conflict('This Idempotency-Key was already used to send a different email');
      res.set('Idempotent-Replayed', 'true').json(await loadDelivery(db, ctx, id, row.id));
    };

    const earlier = await findByKey(db, ctx.organizationId, id, key);
    if (earlier) return replay(earlier);

    let claim: Claim | DeliveryRow;
    try {
      claim = await db.transaction(async (tx): Promise<Claim | DeliveryRow> => {
        const quote = await lockQuote(tx, ctx.organizationId, id);
        // The same key may have been used by a request that held the lock before us.
        const raced = await findByKey(tx, ctx.organizationId, id, key);
        if (raced) return raced;
        assertEmailable(quote, ctx);
        // One email at a time per quote: a second send (e.g. from another tab) waits for the first to finish.
        await assertNotBeingEmailed(tx, id);

        const [customer] = await tx.select().from(customers).where(eq(customers.id, quote.customerId));
        const recipientEmail = body.recipientEmail ?? customer!.email?.toLowerCase();
        if (!recipientEmail) throw badRequest('This customer has no email address. Enter the recipient to send the quote to.');
        const recipientName = body.recipientName ?? (body.recipientEmail ? null : customer!.contactName);

        const pdfData = await quotePdfData(tx, ctx, id);
        const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.organizationId));
        const [sender] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ctx.userId));
        // The customer receives the quote as sent, so the attached copy carries no draft watermark.
        const pdf = await renderQuotePdf({ ...pdfData, quote: { ...pdfData.quote, status: 'sent' } });
        const content = quoteEmail({
          recipientName,
          organizationName: org!.name,
          senderName: sender!.name,
          quoteNumber: quote.number,
          total: formatAmount(quote.totalCents, quote.currency),
          validUntil: quote.validUntil ? formatCalendarDate(quote.validUntil) : null,
          message: body.message ?? null,
        });
        const token = newLinkToken();
        const [delivery] = await tx.insert(quoteDeliveries).values({
          organizationId: ctx.organizationId,
          quoteId: id,
          idempotencyKey: key,
          // Persisted as in flight before anything is sent; never `sent` until the provider accepts it.
          status: 'sending',
          recipientEmail,
          recipientName,
          message: body.message ?? null,
          subject: content.subject,
          bodyText: content.text,
          bodyHtml: content.html,
          pdf,
          quoteRevision: quote.revision,
          sentById: ctx.userId,
          attempts: 1,
          lastAttemptAt: sql`clock_timestamp()`,
          accessTokenHash: hashLinkToken(token),
        }).returning();
        return { delivery: delivery!, token };
      });
    } catch (err) {
      // Two requests with the same key raced past the lookup; the loser answers with the winner's delivery.
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        const winner = await findByKey(db, ctx.organizationId, id, key);
        if (winner) return replay(winner);
      }
      throw err;
    }
    if (!('token' in claim)) return replay(claim);
    res.status(201).json(await attempt(req, ctx, claim));
  });

  router.get('/:id/deliveries', requirePermission('quotes:read'), async (req, res) => {
    const { organizationId, timezone } = auth(req);
    const { id } = QuoteParams.parse(req.params);
    const [quote] = await db.select(quoteState).from(quotes).where(and(eq(quotes.id, id), eq(quotes.organizationId, organizationId)));
    if (!quote) throw notFound('Quote');
    const rows = await db.select({ delivery: quoteDeliveries, sentByName: users.name }).from(quoteDeliveries)
      .innerJoin(users, eq(users.id, quoteDeliveries.sentById))
      .where(eq(quoteDeliveries.quoteId, id))
      .orderBy(desc(quoteDeliveries.createdAt), desc(quoteDeliveries.id));
    res.json({ data: rows.map((r) => toDelivery(r.delivery, r.sentByName, quote, timezone)) });
  });

  router.post('/:id/deliveries/:deliveryId/retry', requirePermission('quotes:write'), async (req, res) => {
    const ctx = auth(req);
    const { id, deliveryId } = DeliveryParams.parse(req.params);
    if (!mailer.enabled) throw emailUnavailable('quotes cannot be emailed.');
    const claim = await db.transaction(async (tx): Promise<Claim> => {
      const quote = await lockQuote(tx, ctx.organizationId, id);
      const [delivery] = await tx.select().from(quoteDeliveries)
        .where(and(eq(quoteDeliveries.id, deliveryId), eq(quoteDeliveries.quoteId, id))).for('update');
      if (!delivery) throw notFound('Delivery');
      if (delivery.status === 'sent') throw invalidState('This email was already sent');
      if (delivery.status === 'sending' && !isStale(delivery)) throw invalidState('This email is being sent right now');
      if (quote.revision !== delivery.quoteRevision) {
        throw invalidState('The quote was edited after this email was prepared. Send it again to email the current version.');
      }
      assertEmailable(quote, ctx);
      const token = newLinkToken();
      const [claimed] = await tx.update(quoteDeliveries).set({
        status: 'sending',
        attempts: sql`${quoteDeliveries.attempts} + 1`,
        lastAttemptAt: sql`clock_timestamp()`,
        lastError: null,
        accessTokenHash: hashLinkToken(token),
      }).where(eq(quoteDeliveries.id, deliveryId)).returning();
      return { delivery: claimed!, token };
    });
    res.json(await attempt(req, ctx, claim));
  });

  return router;
}
