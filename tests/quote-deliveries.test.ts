import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { quoteDeliveries, quotes, quoteStatusHistory } from '../src/db/schema';
import { settleBackgroundTasks } from '../src/lib/background';
import type { OutgoingEmail, SentEmail } from '../src/lib/mailer';
import { createUser, linkToken, registerOrg, setupTestApp, uniqueEmail, type Session } from './helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Session, sales: Session, viewer: Session;
let customerId: string, productId: string;
let keySeq = 0;

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await registerOrg(ctx.app, 'Sender Org');
  sales = await createUser(ctx.app, admin, 'sales');
  viewer = await createUser(ctx.app, admin, 'viewer');
  customerId = (await admin.as('post', '/customers')
    .send({ companyName: 'Pinecrest Facilities', contactName: 'Dana Lee', email: 'Dana@Pinecrest.example' }).expect(201)).body.id;
  productId = (await admin.as('post', '/products').send({ sku: 'PUMP', name: 'Pump', unitPriceCents: 10_000 }).expect(201)).body.id;
});
afterAll(() => ctx.close());
beforeEach(() => {
  ctx.outbox.length = 0;
  ctx.mail.failWith = null;
});

const key = () => `test-key-${Date.now()}-${++keySeq}`;
const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
async function draft(extra: Record<string, unknown> = {}) {
  return (await sales.as('post', '/quotes').send({ customerId, validUntil: isoDate(30), items: [{ productId, quantity: 2 }], ...extra }).expect(201)).body;
}
const send = (quoteId: string, idempotencyKey = key(), body: Record<string, unknown> = {}, session = sales) =>
  session.as('post', `/quotes/${quoteId}/deliveries`).set('Idempotency-Key', idempotencyKey).send(body);
const retry = (quoteId: string, deliveryId: string) => sales.as('post', `/quotes/${quoteId}/deliveries/${deliveryId}/retry`);
const getQuote = async (id: string) => (await sales.as('get', `/quotes/${id}`).expect(200)).body;
const deliveryRows = (quoteId: string) => ctx.db.select().from(quoteDeliveries).where(eq(quoteDeliveries.quoteId, quoteId));
const publicApi = (path: string, body: Record<string, unknown>) => request(ctx.app).post(`/api/v1/public/quotes/${path}`).send(body);

describe('emailing a quote', () => {
  it('emails the PDF with a link, records who sent what to whom, and marks the draft sent', async () => {
    const quote = await draft({ notes: 'Freight included' });
    const res = await send(quote.id, key(), { message: 'Thanks for your time on the call.' }).expect(201);
    expect(res.body).toMatchObject({
      status: 'sent', recipientEmail: 'dana@pinecrest.example', recipientName: 'Dana Lee', message: 'Thanks for your time on the call.',
      subject: 'Quote Q-000001 from Sender Org', sentById: sales.userId, sentByName: 'Test sales', attempts: 1, lastError: null, retryable: false,
    });
    expect(res.body.sentAt).toBeTruthy();

    expect(ctx.outbox).toHaveLength(1);
    const [email] = ctx.outbox;
    expect(email).toMatchObject({ to: 'dana@pinecrest.example', subject: 'Quote Q-000001 from Sender Org' });
    expect(email!.replyTo).toMatch(/^sales\./);
    expect(email!.text).toContain('Hi Dana Lee,');
    expect(email!.text).toContain('Test sales at Sender Org sent you quote Q-000001 for $200.00. The PDF is attached.');
    expect(email!.text).toContain('Thanks for your time on the call.');
    expect(email!.text).toMatch(/http:\/\/app\.test\/quote-response#token=[\w-]{43}/);
    expect(email!.text).not.toContain('quote-link.invalid');
    expect(email!.attachments).toHaveLength(1);
    expect(email!.attachments![0]!.filename).toBe('Q-000001.pdf');
    expect(email!.attachments![0]!.content.subarray(0, 5).toString()).toBe('%PDF-');

    const after = await getQuote(quote.id);
    expect(after.status).toBe('sent');
    expect(after.history.at(-1)).toMatchObject({ fromStatus: 'draft', toStatus: 'sent', changedById: sales.userId, changedByName: 'Test sales' });

    // The attachment is stored as sent, and the list shows the delivery to anyone who can read quotes.
    const [row] = await deliveryRows(quote.id);
    expect(row!.pdf.equals(email!.attachments![0]!.content)).toBe(true);
    expect(row!.providerMessageId).toBe('memory-1');
    const list = await viewer.as('get', `/quotes/${quote.id}/deliveries`).expect(200);
    expect(list.body.data).toEqual([expect.objectContaining({ id: res.body.id, status: 'sent' })]);
  });

  it('keeps a snapshot of the recipient and content, unaffected by later changes', async () => {
    const quote = await draft();
    await send(quote.id, key(), { recipientEmail: 'buyer@pinecrest.example', recipientName: 'Buyer' }).expect(201);
    const { token } = { token: linkToken(ctx.outbox[0]!.text) };
    const attached = ctx.outbox[0]!.attachments![0]!.content;
    await admin.as('patch', `/customers/${customerId}`).send({ email: 'new@pinecrest.example', companyName: 'Pinecrest Renamed' }).expect(200);

    const [row] = await deliveryRows(quote.id);
    expect(row).toMatchObject({ recipientEmail: 'buyer@pinecrest.example', recipientName: 'Buyer', subject: 'Quote Q-000002 from Sender Org' });
    expect(row!.bodyText).toContain('Hi Buyer,');
    // The customer downloads exactly the PDF that was attached.
    const pdf = await publicApi('pdf', { token }).buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((pdf.body as Buffer).equals(attached)).toBe(true);
    await admin.as('patch', `/customers/${customerId}`).send({ email: 'Dana@Pinecrest.example', companyName: 'Pinecrest Facilities' }).expect(200);
  });

  it('attaches a clean copy of a draft, without the draft watermark', async () => {
    const quote = await draft();
    await send(quote.id).expect(201);
    const [row] = await deliveryRows(quote.id);
    expect(row!.pdf.toString('latin1')).not.toContain('DRAFT');
  });

  it('can email a sent quote again, e.g. to another contact, without changing its status', async () => {
    const quote = await draft();
    await send(quote.id).expect(201);
    await send(quote.id, key(), { recipientEmail: 'cfo@pinecrest.example' }).expect(201);
    expect(ctx.outbox.map((e) => e.to)).toEqual(['dana@pinecrest.example', 'cfo@pinecrest.example']);
    expect((await getQuote(quote.id)).history.filter((h: { toStatus: string }) => h.toStatus === 'sent')).toHaveLength(1);
  });
});

describe('duplicate requests', () => {
  it('replays a repeated key instead of emailing again', async () => {
    const quote = await draft();
    const k = key();
    const first = await send(quote.id, k).expect(201);
    const second = await send(quote.id, k).expect(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(ctx.outbox).toHaveLength(1);
    expect(await deliveryRows(quote.id)).toHaveLength(1);
  });

  it('sends once when the same request arrives several times at once', async () => {
    const quote = await draft();
    const k = key();
    const responses = await Promise.all(Array.from({ length: 5 }, () => send(quote.id, k)));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(ctx.outbox).toHaveLength(1);
  });

  it('refuses to reuse a key for a different email', async () => {
    const quote = await draft();
    const k = key();
    await send(quote.id, k).expect(201);
    const res = await send(quote.id, k, { recipientEmail: 'other@pinecrest.example' }).expect(409);
    expect(res.body.error.message).toBe('This Idempotency-Key was already used to send a different email');
    await send(quote.id, k, { message: 'changed' }).expect(409);
    expect(ctx.outbox).toHaveLength(1);
  });

  it('requires a key', async () => {
    const quote = await draft();
    await sales.as('post', `/quotes/${quote.id}/deliveries`).send({}).expect(400);
    expect(ctx.outbox).toHaveLength(0);
  });
});

describe('failures and retries', () => {
  it('records a failure without marking anything sent, and a retry sends the same email', async () => {
    const quote = await draft();
    ctx.mail.failWith = new Error('Resend rejected the email (422): invalid recipient');
    const failed = await send(quote.id).expect(201);
    expect(failed.body).toMatchObject({
      status: 'failed', attempts: 1, sentAt: null, retryable: true, lastError: 'Resend rejected the email (422): invalid recipient',
    });
    expect(ctx.outbox).toHaveLength(0);
    const stillDraft = await getQuote(quote.id);
    expect(stillDraft.status).toBe('draft');
    expect(stillDraft.history).toHaveLength(1);

    ctx.mail.failWith = null;
    const sent = await retry(quote.id, failed.body.id).expect(200);
    expect(sent.body).toMatchObject({ id: failed.body.id, status: 'sent', attempts: 2, lastError: null, retryable: false });
    expect(ctx.outbox).toHaveLength(1);
    expect(ctx.outbox[0]!.subject).toBe(failed.body.subject);
    expect((await getQuote(quote.id)).status).toBe('sent');

    const again = await retry(quote.id, failed.body.id).expect(409);
    expect(again.body.error.message).toBe('This email was already sent');
    expect(ctx.outbox).toHaveLength(1);
  });

  it('a link minted for a failed attempt never works, even if the email somehow arrived', async () => {
    const quote = await draft();
    // The provider accepted the message but the request timed out from our side.
    ctx.mail.failWith = new Error('timeout');
    const failed = await send(quote.id).expect(201);
    const [row] = await deliveryRows(quote.id);
    expect(row!.accessTokenHash).toBeNull();
    expect(failed.body.status).toBe('failed');
  });

  it('sends once when retries arrive at the same time', async () => {
    const quote = await draft();
    ctx.mail.failWith = new Error('down');
    const failed = await send(quote.id).expect(201);
    ctx.mail.failWith = null;
    const results = await Promise.all(Array.from({ length: 4 }, () => retry(quote.id, failed.body.id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(ctx.outbox).toHaveLength(1);
  });

  it("won't retry an email prepared from a version of the draft that was since edited", async () => {
    const quote = await draft();
    ctx.mail.failWith = new Error('down');
    const failed = await send(quote.id).expect(201);
    ctx.mail.failWith = null;
    await sales.as('patch', `/quotes/${quote.id}`).send({ notes: 'Updated terms' }).expect(200);
    const res = await retry(quote.id, failed.body.id).expect(409);
    expect(res.body.error.message).toBe('The quote was edited after this email was prepared. Send it again to email the current version.');
    expect(ctx.outbox).toHaveLength(0);
    await send(quote.id).expect(201);
    expect(ctx.outbox[0]!.attachments![0]!.content.length).toBeGreaterThan(0);
  });

  it('blocks edits and other sends while an email is in flight, and lets a stuck attempt be retried later', async () => {
    const quote = await draft();
    ctx.mail.failWith = new Error('down');
    const failed = await send(quote.id).expect(201);
    // Simulate an attempt in progress (or one whose process died mid-send).
    await ctx.db.update(quoteDeliveries).set({ status: 'sending', lastAttemptAt: new Date() }).where(eq(quoteDeliveries.id, failed.body.id));
    ctx.mail.failWith = null;

    expect((await sales.as('patch', `/quotes/${quote.id}`).send({ notes: 'x' }).expect(409)).body.error.message)
      .toBe('This quote is being emailed right now. Try again in a moment.');
    await sales.as('delete', `/quotes/${quote.id}`).expect(409);
    await send(quote.id).expect(409);
    expect((await retry(quote.id, failed.body.id).expect(409)).body.error.message).toBe('This email is being sent right now');
    expect((await sales.as('get', `/quotes/${quote.id}/deliveries`).expect(200)).body.data[0]).toMatchObject({ status: 'sending', retryable: false });

    // After the lease runs out, the attempt is presumed dead and can be retried.
    await ctx.db.update(quoteDeliveries).set({ lastAttemptAt: new Date(Date.now() - 6 * 60_000) }).where(eq(quoteDeliveries.id, failed.body.id));
    expect((await sales.as('get', `/quotes/${quote.id}/deliveries`).expect(200)).body.data[0].retryable).toBe(true);
    await sales.as('patch', `/quotes/${quote.id}`).send({ notes: 'x' }).expect(200);
    // ...but not once the quote has changed since.
    await retry(quote.id, failed.body.id).expect(409);
    expect(ctx.outbox).toHaveLength(0);
  });

  it("doesn't let a stale attempt overwrite the outcome of a newer one", async () => {
    const quote = await draft();
    ctx.mail.failWith = new Error('down');
    const failed = await send(quote.id).expect(201);
    ctx.mail.failWith = null;
    await retry(quote.id, failed.body.id).expect(200);
    const [row] = await deliveryRows(quote.id);
    // Recording an outcome requires the claimed attempt number; attempt 1's late failure would not match attempt 2.
    const late = await ctx.db.update(quoteDeliveries).set({ status: 'failed' })
      .where(and(eq(quoteDeliveries.id, row!.id), eq(quoteDeliveries.status, 'sending'), eq(quoteDeliveries.attempts, 1))).returning();
    expect(late).toHaveLength(0);
    expect((await deliveryRows(quote.id))[0]!.status).toBe('sent');
  });
});

describe('what can be emailed, by whom', () => {
  it('needs a recipient, a sendable quote, permission and the same organization', async () => {
    const noEmail = (await admin.as('post', '/customers').send({ companyName: 'No Email Co' }).expect(201)).body.id;
    const quote = await draft({ customerId: noEmail });
    expect((await send(quote.id).expect(400)).body.error.message).toBe('This customer has no email address. Enter the recipient to send the quote to.');
    await send(quote.id, key(), { recipientEmail: 'not-an-email' }).expect(400);
    await send(quote.id, key(), {}, viewer).expect(403);
    const other = await registerOrg(ctx.app, 'Other Org');
    await send(quote.id, key(), { recipientEmail: 'x@example.com' }, other).expect(404);
    await other.as('get', `/quotes/${quote.id}/deliveries`).expect(404);

    const expired = await draft({ validUntil: isoDate(-2) });
    expect((await send(expired.id).expect(409)).body.error.message).toMatch(/^validUntil is in the past/);
    const accepted = await draft();
    await sales.as('post', `/quotes/${accepted.id}/send`).expect(200);
    await sales.as('post', `/quotes/${accepted.id}/accept`).expect(200);
    expect((await send(accepted.id).expect(409)).body.error.message).toBe('Only draft or sent quotes can be emailed; this quote is accepted');
    expect(ctx.outbox).toHaveLength(0);
  });

  it('refuses up front when email is not configured', async () => {
    const off = await setupTestApp({}, { mailer: { enabled: false, send: async () => { throw new Error('unreachable'); } } });
    try {
      const owner = await registerOrg(off.app, 'Offline Org');
      const customer = (await owner.as('post', '/customers').send({ companyName: 'C', email: 'c@example.com' }).expect(201)).body.id;
      const quote = (await owner.as('post', '/quotes').send({ customerId: customer, items: [{ description: 'Service', quantity: 1, unitPriceCents: 100 }] }).expect(201)).body;
      await owner.as('post', `/quotes/${quote.id}/deliveries`).set('Idempotency-Key', key()).send({}).expect(503);
    } finally {
      await off.close();
    }
  });
});

describe('customer response', () => {
  async function sentWithLink(extra: Record<string, unknown> = {}) {
    const quote = await draft(extra);
    await send(quote.id).expect(201);
    return { quote, token: linkToken(ctx.outbox.at(-1)!.text) };
  }

  it('shows the quote to the customer and records their acceptance by name', async () => {
    const { quote, token } = await sentWithLink();
    const view = await publicApi('view', { token }).expect(200);
    expect(view.body).toMatchObject({
      organizationName: 'Sender Org', customerName: 'Pinecrest Facilities', recipientEmail: 'dana@pinecrest.example',
      preparedBy: { name: 'Test sales' }, canRespond: true, response: null,
      quote: { number: quote.number, status: 'sent', totalCents: 20_000, items: [{ description: 'Pump', quantity: 2, lineTotalCents: 20_000 }] },
    });
    expect(view.body.quote).not.toHaveProperty('organizationId');

    ctx.outbox.length = 0;
    const accepted = await publicApi('respond', { token, decision: 'accept', name: 'Dana Lee' }).expect(200);
    expect(accepted.body).toMatchObject({ canRespond: false, quote: { status: 'accepted' }, response: { status: 'accepted', by: 'Dana Lee <dana@pinecrest.example>' } });
    const staffView = await getQuote(quote.id);
    expect(staffView.status).toBe('accepted');
    expect(staffView.history.at(-1)).toMatchObject({
      fromStatus: 'sent', toStatus: 'accepted', changedById: null, changedByName: null, changedByCustomer: 'Dana Lee <dana@pinecrest.example>',
    });

    // The salesperson hears about it.
    await settleBackgroundTasks();
    expect(ctx.outbox).toHaveLength(1);
    expect(ctx.outbox[0]!.subject).toBe(`Quote ${quote.number} accepted by Pinecrest Facilities`);
    expect(ctx.outbox[0]!.text).toContain(`http://app.test/quotes/${quote.id}`);

    // Answered once only; staff can now convert it.
    const twice = await publicApi('respond', { token, decision: 'reject', name: 'Someone' }).expect(409);
    expect(twice.body.error.message).toBe('This quote was already accepted');
    await sales.as('post', `/quotes/${quote.id}/convert`).send({}).expect(201);
  });

  it('records a rejection with its reason', async () => {
    const { quote, token } = await sentWithLink();
    await publicApi('respond', { token, decision: 'reject', name: 'Dana Lee', note: 'Budget moved to next quarter' }).expect(200);
    const history = (await getQuote(quote.id)).history.at(-1);
    expect(history).toMatchObject({ toStatus: 'rejected', note: 'Budget moved to next quarter', changedByCustomer: 'Dana Lee <dana@pinecrest.example>' });
    const view = await publicApi('view', { token }).expect(200);
    expect(view.body.response).toMatchObject({ status: 'rejected', note: 'Budget moved to next quarter' });
  });

  it("can't accept once the validity date has passed; the expiry is recorded", async () => {
    const { quote, token } = await sentWithLink();
    await ctx.db.update(quotes).set({ validUntil: isoDate(-1) }).where(eq(quotes.id, quote.id));
    expect((await publicApi('view', { token }).expect(200)).body).toMatchObject({ canRespond: false, quote: { status: 'expired' } });
    const res = await publicApi('respond', { token, decision: 'accept', name: 'Dana Lee' }).expect(409);
    expect(res.body.error.message).toBe('This quote has expired and can no longer be accepted');
    const [row] = await ctx.db.select().from(quotes).where(eq(quotes.id, quote.id));
    expect(row!.status).toBe('expired');
    const history = await ctx.db.select().from(quoteStatusHistory).where(eq(quoteStatusHistory.quoteId, quote.id));
    expect(history.at(-1)).toMatchObject({ toStatus: 'expired', changedById: null });
  });

  it('accepts once when the customer clicks twice at the same time', async () => {
    const { quote, token } = await sentWithLink();
    const results = await Promise.all([1, 2, 3].map(() => publicApi('respond', { token, decision: 'accept', name: 'Dana Lee' })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const accepted = (await getQuote(quote.id)).history.filter((h: { toStatus: string }) => h.toStatus === 'accepted');
    expect(accepted).toHaveLength(1);
  });

  it('rejects unknown links and validates the response', async () => {
    const bogus = 'x'.repeat(43);
    expect((await publicApi('view', { token: bogus }).expect(400)).body.error.code).toBe('INVALID_LINK');
    await publicApi('pdf', { token: bogus }).expect(400);
    await publicApi('respond', { token: bogus, decision: 'accept', name: 'X' }).expect(400);
    const { token } = await sentWithLink();
    await publicApi('respond', { token, decision: 'maybe', name: 'X' }).expect(400);
    await publicApi('respond', { token, decision: 'accept', name: '' }).expect(400);
  });

  it('keeps earlier links working when the quote is emailed again', async () => {
    const { quote, token: first } = await sentWithLink();
    await send(quote.id, key(), { recipientEmail: uniqueEmail('cfo') }).expect(201);
    await publicApi('view', { token: first }).expect(200);
    await publicApi('view', { token: linkToken(ctx.outbox.at(-1)!.text) }).expect(200);
  });
});

/** A mailer that holds emails to chosen recipients until released, like a provider call that hangs. */
function gatedMailer() {
  const outbox: OutgoingEmail[] = [];
  const gates = new Map<string, { opened: Promise<void>; open: () => void }>();
  return {
    enabled: true,
    outbox,
    hold(to: string) {
      let open!: () => void;
      gates.set(to, { opened: new Promise<void>((resolve) => { open = resolve; }), open });
    },
    release(to: string) { gates.get(to)?.open(); },
    async send(email: OutgoingEmail): Promise<SentEmail> {
      await gates.get(email.to)?.opened;
      outbox.push(email);
      return { id: `gated-${outbox.length}` };
    },
  };
}

describe('an email that finishes after the quote changed', () => {
  it("can't be used to view or accept the new version, which may be for another customer", async () => {
    const mailer = gatedMailer();
    const app = await setupTestApp({}, { mailer });
    try {
      const owner = await registerOrg(app.app, 'Lease Org');
      const customerA = (await owner.as('post', '/customers').send({ companyName: 'Customer A', email: 'a@a.example' }).expect(201)).body.id;
      const customerB = (await owner.as('post', '/customers').send({ companyName: 'Customer B', email: 'b@b.example' }).expect(201)).body.id;
      const quote = (await owner.as('post', '/quotes').send({
        customerId: customerA, notes: 'Terms for A', items: [{ description: 'Widget', quantity: 1, unitPriceCents: 10_000 }],
      }).expect(201)).body;
      const sendTo = (k: string) => owner.as('post', `/quotes/${quote.id}/deliveries`).set('Idempotency-Key', k).send({});

      // The email to A hangs at the provider...
      mailer.hold('a@a.example');
      const emailToA = sendTo('lease-key-a').then((r) => r);
      await vi.waitFor(async () => {
        expect(await app.db.select().from(quoteDeliveries).where(eq(quoteDeliveries.quoteId, quote.id))).toHaveLength(1);
      });
      // ...long enough for its lease to run out, so the draft can be changed: now for B, with B's private terms.
      await app.db.update(quoteDeliveries).set({ lastAttemptAt: new Date(Date.now() - 6 * 60_000) }).where(eq(quoteDeliveries.quoteId, quote.id));
      await owner.as('patch', `/quotes/${quote.id}`).send({
        customerId: customerB, notes: 'Private terms for B', items: [{ description: 'Widget', quantity: 3, unitPriceCents: 9_000 }],
      }).expect(200);
      const toB = await sendTo('lease-key-b').expect(201);
      expect(toB.body).toMatchObject({ status: 'sent', outdated: false });

      // A's email finally goes out. It did send, so it is recorded as sent, but it describes a version that is gone.
      mailer.release('a@a.example');
      const toA = await emailToA;
      expect(toA.status).toBe(201);
      expect(toA.body).toMatchObject({ status: 'sent', outdated: true, retryable: false });

      const tokenA = linkToken(mailer.outbox.find((e) => e.to === 'a@a.example')!.text);
      const publicCall = (path: string, body: Record<string, unknown>) => request(app.app).post(`/api/v1/public/quotes/${path}`).send(body);
      for (const [path, body] of [
        ['view', { token: tokenA }],
        ['pdf', { token: tokenA }],
        ['respond', { token: tokenA, decision: 'accept', name: 'Someone at A' }],
        ['respond', { token: tokenA, decision: 'reject', name: 'Someone at A' }],
      ] as const) {
        const res = await publicCall(path, body).expect(410);
        expect(res.body.error).toMatchObject({ code: 'QUOTE_CHANGED' });
        expect(JSON.stringify(res.body)).not.toMatch(/Private terms|Customer B|270/);
      }

      // The quote is untouched by A's link; B's link shows B's version and works.
      const staff = (await owner.as('get', `/quotes/${quote.id}`).expect(200)).body;
      expect(staff.status).toBe('sent');
      expect(staff.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['draft', 'sent']);
      const tokenB = linkToken(mailer.outbox.find((e) => e.to === 'b@b.example')!.text);
      expect((await publicCall('view', { token: tokenB }).expect(200)).body).toMatchObject({ customerName: 'Customer B', quote: { notes: 'Private terms for B', totalCents: 27_000 } });
      await publicCall('respond', { token: tokenB, decision: 'accept', name: 'Bea at B' }).expect(200);

      // The API contract documents this answer on every link endpoint.
      const contract = (await request(app.app).get('/openapi.json').expect(200)).body;
      for (const path of ['view', 'pdf', 'respond']) {
        expect(contract.paths[`/public/quotes/${path}`].post.responses['410'].description).toMatch(/^`QUOTE_CHANGED`/);
      }

      // The staff list tells the two apart.
      const list = (await owner.as('get', `/quotes/${quote.id}/deliveries`).expect(200)).body.data;
      expect(list.map((d: { recipientEmail: string; outdated: boolean }) => [d.recipientEmail, d.outdated]))
        .toEqual([['b@b.example', false], ['a@a.example', true]]);
    } finally {
      await app.close();
    }
  });
});

describe('which emails can be retried', () => {
  it('not an email of a version that was since edited: it is outdated, and the current version must be sent instead', async () => {
    const quote = await draft();
    ctx.mail.failWith = new Error('down');
    const failed = await send(quote.id).expect(201);
    expect(failed.body).toMatchObject({ retryable: true, outdated: false });
    await sales.as('patch', `/quotes/${quote.id}`).send({ notes: 'Edited' }).expect(200);
    const [listed] = (await sales.as('get', `/quotes/${quote.id}/deliveries`).expect(200)).body.data;
    expect(listed).toMatchObject({ id: failed.body.id, status: 'failed', outdated: true, retryable: false });
    await retry(quote.id, failed.body.id).expect(409);
  });

  it('not once the quote can no longer be emailed', async () => {
    const accepted = await draft();
    ctx.mail.failWith = new Error('down');
    const failedAccepted = await send(accepted.id).expect(201);
    await sales.as('post', `/quotes/${accepted.id}/send`).expect(200);
    await sales.as('post', `/quotes/${accepted.id}/accept`).expect(200);
    expect((await sales.as('get', `/quotes/${accepted.id}/deliveries`).expect(200)).body.data[0]).toMatchObject({ outdated: false, retryable: false });
    await retry(accepted.id, failedAccepted.body.id).expect(409);

    const lapsed = await draft();
    const failedLapsed = await send(lapsed.id).expect(201);
    await ctx.db.update(quotes).set({ validUntil: isoDate(-1) }).where(eq(quotes.id, lapsed.id));
    expect((await sales.as('get', `/quotes/${lapsed.id}/deliveries`).expect(200)).body.data[0]).toMatchObject({ retryable: false });
    await retry(lapsed.id, failedLapsed.body.id).expect(409);
  });
});
