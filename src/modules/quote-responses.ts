import { and, eq } from 'drizzle-orm';
import { Router, type Request } from 'express';
import type { Config } from '../config';
import type { DB } from '../db/client';
import { customers, organizations, quoteDeliveries, quotes, users, QUOTE_STATUSES } from '../db/schema';
import { runInBackground } from '../lib/background';
import { quoteResponseEmail } from '../lib/emails';
import { invalidLink, invalidState } from '../lib/errors';
import type { Mailer } from '../lib/mailer';
import { doc } from '../lib/openapi';
import { z } from '../lib/zod';
import { authRateLimiter } from '../middleware/rate-limit';
import { LineItem } from './line-items';
import { hashLinkToken } from './quote-deliveries';
import { effectiveStatus, isPastValidity, loadQuote, lockQuote, recordStatus, todayFor, type QuoteScope } from './quotes';
import { LinkToken } from './user-tokens';

const TokenBody = z.object({ token: LinkToken }).openapi('QuoteLinkRequest');
const RespondBody = z
  .object({
    token: LinkToken,
    decision: z.enum(['accept', 'reject']),
    name: z.string().trim().min(1).max(200).openapi({ description: 'Who is responding for the customer' }),
    note: z.string().trim().min(1).max(1000).optional().openapi({ description: 'E.g. why the quote is declined' }),
  })
  .openapi('QuoteResponseRequest');

const PublicQuote = z
  .object({
    organizationName: z.string(),
    customerName: z.string(),
    recipientEmail: z.string(),
    preparedBy: z.object({ name: z.string(), email: z.string() }),
    sentAt: z.date(),
    quote: z.object({
      number: z.string(),
      status: z.enum(QUOTE_STATUSES),
      validUntil: z.string().nullable(),
      currency: z.string(),
      notes: z.string().nullable(),
      taxRateBps: z.number().int(),
      subtotalCents: z.number().int(),
      taxCents: z.number().int(),
      totalCents: z.number().int(),
      items: z.array(LineItem.pick({ description: true, quantity: true, unitPriceCents: true, discountBps: true, lineTotalCents: true })),
    }),
    canRespond: z.boolean().openapi({ description: 'True while the quote awaits a response and is within its validity date' }),
    response: z
      .object({ status: z.enum(['accepted', 'rejected', 'expired']), at: z.date().nullable(), by: z.string().nullable(), note: z.string().nullable() })
      .nullable()
      .openapi({ description: 'The outcome, once the quote was accepted, rejected or expired' }),
  })
  .openapi('PublicQuote');

const T = 'Customer quote links';
doc({ method: 'post', path: '/public/quotes/view', tag: T, summary: 'The quote behind an emailed link, for the customer to review', public: true, body: TokenBody, response: PublicQuote });
doc({ method: 'post', path: '/public/quotes/pdf', tag: T, summary: 'The PDF exactly as it was attached to the email', public: true, body: TokenBody, file: 'application/pdf' });
doc({ method: 'post', path: '/public/quotes/respond', tag: T, summary: 'Accept or decline the quote. Fails with 409 once it was answered or has expired', public: true, body: RespondBody, response: PublicQuote });

/** The sent delivery a link belongs to. Links from failed attempts were never delivered and don't resolve. */
async function findDelivery(db: DB, token: string) {
  const [row] = await db.select({ delivery: quoteDeliveries, timezone: organizations.timezone, organizationName: organizations.name })
    .from(quoteDeliveries)
    .innerJoin(organizations, eq(organizations.id, quoteDeliveries.organizationId))
    .where(and(eq(quoteDeliveries.accessTokenHash, hashLinkToken(token)), eq(quoteDeliveries.status, 'sent')));
  if (!row) throw invalidLink();
  return { ...row, scope: { organizationId: row.delivery.organizationId, timezone: row.timezone } satisfies QuoteScope };
}

async function publicView(db: DB, found: Awaited<ReturnType<typeof findDelivery>>): Promise<z.infer<typeof PublicQuote>> {
  const { delivery, scope, organizationName } = found;
  const quote = await loadQuote(db, scope, delivery.quoteId);
  const [[creator], [customer]] = await Promise.all([
    db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, quote.createdById)),
    db.select({ companyName: customers.companyName }).from(customers).where(eq(customers.id, quote.customerId)),
  ]);
  const last = quote.history.at(-1);
  const outcome = quote.status === 'accepted' || quote.status === 'rejected' || quote.status === 'expired' ? quote.status : null;
  return {
    organizationName,
    customerName: customer!.companyName,
    recipientEmail: delivery.recipientEmail,
    preparedBy: creator!,
    sentAt: delivery.sentAt!,
    quote: {
      number: quote.number,
      status: quote.status,
      validUntil: quote.validUntil,
      currency: quote.currency,
      notes: quote.notes,
      taxRateBps: quote.taxRateBps,
      subtotalCents: quote.subtotalCents,
      taxCents: quote.taxCents,
      totalCents: quote.totalCents,
      items: quote.items.map(({ description, quantity, unitPriceCents, discountBps, lineTotalCents }) =>
        ({ description, quantity, unitPriceCents, discountBps, lineTotalCents })),
    },
    canRespond: quote.status === 'sent',
    response: outcome
      ? {
          status: outcome,
          // Expiry that nobody acted on isn't recorded, so it has no moment or actor.
          at: last?.toStatus === outcome ? last.createdAt : null,
          by: last?.toStatus === outcome ? (last.changedByCustomer ?? last.changedByName) : null,
          note: last?.toStatus === outcome ? last.note : null,
        }
      : null,
  };
}

export function quoteResponsesRouter(db: DB, config: Config, mailer: Mailer) {
  const router = Router();
  // Links are long random tokens, but failed lookups still count against the per-IP limit.
  const limiter = authRateLimiter(config, { countSuccessful: false });

  router.post('/quotes/view', limiter, async (req, res) => {
    const { token } = TokenBody.parse(req.body);
    res.set('Cache-Control', 'private, no-store').json(await publicView(db, await findDelivery(db, token)));
  });

  router.post('/quotes/pdf', limiter, async (req, res) => {
    const { token } = TokenBody.parse(req.body);
    const { delivery } = await findDelivery(db, token);
    const [quote] = await db.select({ number: quotes.number }).from(quotes).where(eq(quotes.id, delivery.quoteId));
    res.set('Cache-Control', 'private, no-store').type('application/pdf').attachment(`${quote!.number}.pdf`).send(delivery.pdf);
  });

  router.post('/quotes/respond', limiter, async (req: Request, res) => {
    const body = RespondBody.parse(req.body);
    const found = await findDelivery(db, body.token);
    const { delivery, scope } = found;
    const respondent = `${body.name} <${delivery.recipientEmail}>`;
    const outcome = await db.transaction(async (tx) => {
      const quote = await lockQuote(tx, scope.organizationId, delivery.quoteId);
      if (quote.status === 'sent' && isPastValidity(quote.validUntil, todayFor(scope))) {
        // Same rule as staff acceptance: the expiry is committed, then the request fails.
        await tx.update(quotes).set({ status: 'expired' }).where(eq(quotes.id, quote.id));
        await recordStatus(tx, quote.id, 'sent', 'expired', { customer: respondent, note: null });
        return { refused: `This quote has expired and can no longer be ${body.decision === 'accept' ? 'accepted' : 'declined'}` };
      }
      const status = effectiveStatus(quote, todayFor(scope));
      if (status !== 'sent') return { refused: `This quote was already ${status}` };
      const next = body.decision === 'accept' ? 'accepted' : 'rejected';
      await tx.update(quotes).set({ status: next }).where(eq(quotes.id, quote.id));
      await recordStatus(tx, quote.id, 'sent', next, { customer: respondent, note: body.note ?? null });
      return { decided: next } as const;
    });
    if ('refused' in outcome) throw invalidState(outcome.refused!);

    // Let the salesperson know. Best effort: the customer's response is already saved.
    if (mailer.enabled) {
      runInBackground(req.log, 'quote response notification', async () => {
        const [[sender], [quote]] = await Promise.all([
          db.select({ email: users.email }).from(users).where(eq(users.id, delivery.sentById)),
          db.select({ number: quotes.number, customerName: customers.companyName }).from(quotes)
            .innerJoin(customers, eq(customers.id, quotes.customerId)).where(eq(quotes.id, delivery.quoteId)),
        ]);
        await mailer.send(quoteResponseEmail({
          to: sender!.email,
          quoteNumber: quote!.number,
          customerName: quote!.customerName,
          decision: outcome.decided,
          respondent: body.name,
          note: body.note ?? null,
          url: `${config.APP_URL}/quotes/${delivery.quoteId}`,
        }));
      });
    }
    res.json(await publicView(db, found));
  });

  return router;
}
