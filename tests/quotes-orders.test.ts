import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quotes } from '../src/db/schema';
import { createUser, registerOrg, setupTestApp, type Session } from './helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Session, sales: Session;
let customerId: string, boltId: string, nutId: string;

const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await registerOrg(ctx.app, 'Quote Org');
  sales = await createUser(ctx.app, admin, 'sales');
  customerId = (await admin.as('post', '/customers').send({ companyName: 'Buyer Co' }).expect(201)).body.id;
  boltId = (await admin.as('post', '/products').send({ sku: 'BOLT', name: 'Hex Bolt (box)', unitPriceCents: 2450 }).expect(201)).body.id;
  nutId = (await admin.as('post', '/products').send({ sku: 'NUT', name: 'Hex Nut (box)', unitPriceCents: 980 }).expect(201)).body.id;
});
afterAll(() => ctx.close());

async function sentQuote(validUntil?: string) {
  const q = await sales.as('post', '/quotes')
    .send({ customerId, validUntil, items: [{ productId: boltId, quantity: 2 }] })
    .expect(201);
  return q.body;
}

describe('quotes', () => {
  it('creates a draft quote priced from the catalog with discounts and tax', async () => {
    const res = await sales.as('post', '/quotes')
      .send({
        customerId,
        taxRateBps: 825,
        validUntil: isoDate(30),
        items: [
          { productId: boltId, quantity: 10, discountBps: 1000 },        // 10 x 24.50 - 10% = 220.50
          { productId: nutId, quantity: 5, unitPriceCents: 900 },       // custom price: 45.00
          { description: 'Expedited shipping', quantity: 1, unitPriceCents: 2500 }, // 25.00
        ],
      })
      .expect(201);

    const q = res.body;
    expect(q).toMatchObject({ status: 'draft', number: 'Q-000001', currency: 'USD' });
    expect(q.items.map((i: { lineTotalCents: number }) => i.lineTotalCents)).toEqual([22_050, 4_500, 2_500]);
    expect(q.items[0]).toMatchObject({ description: 'Hex Bolt (box)', unitPriceCents: 2450, position: 1 });
    expect(q).toMatchObject({ subtotalCents: 29_050, taxCents: 2_397, totalCents: 31_447 });
  });

  it('assigns sequential numbers per organization', async () => {
    const a = await sentQuote();
    const b = await sentQuote();
    expect(Number(b.number.slice(2))).toBe(Number(a.number.slice(2)) + 1);

    const other = await registerOrg(ctx.app);
    const c = (await other.as('post', '/customers').send({ companyName: 'C' }).expect(201)).body;
    const q = await other.as('post', '/quotes')
      .send({ customerId: c.id, items: [{ description: 'X', quantity: 1, unitPriceCents: 1 }] }).expect(201);
    expect(q.body.number).toBe('Q-000001');
  });

  it('validates line items', async () => {
    await sales.as('post', '/quotes').send({ customerId, items: [] }).expect(400);
    await sales.as('post', '/quotes').send({ customerId, items: [{ quantity: 0, description: 'x', unitPriceCents: 1 }] }).expect(400);
    const res = await sales.as('post', '/quotes').send({ customerId, items: [{ quantity: 1, description: 'No price' }] }).expect(400);
    expect(res.body.error.message).toContain('unitPriceCents is required');
  });

  it('snapshots prices so catalog changes do not alter existing quotes', async () => {
    const product = (await admin.as('post', '/products').send({ sku: 'SNAP', name: 'Snap', unitPriceCents: 1000 }).expect(201)).body;
    const q = (await sales.as('post', '/quotes').send({ customerId, items: [{ productId: product.id, quantity: 1 }] }).expect(201)).body;
    await admin.as('patch', `/products/${product.id}`).send({ unitPriceCents: 9999 }).expect(200);
    const after = await sales.as('get', `/quotes/${q.id}`).expect(200);
    expect(after.body.totalCents).toBe(1000);
  });

  it('edits drafts: replaces items and re-prices when tax changes', async () => {
    const q = await sentQuote();
    const edited = await sales.as('patch', `/quotes/${q.id}`)
      .send({ notes: 'Revised', items: [{ productId: nutId, quantity: 10 }] }).expect(200);
    expect(edited.body).toMatchObject({ notes: 'Revised', subtotalCents: 9_800, totalCents: 9_800 });
    expect(edited.body.items).toHaveLength(1);

    const taxed = await sales.as('patch', `/quotes/${q.id}`).send({ taxRateBps: 1000 }).expect(200);
    expect(taxed.body).toMatchObject({ subtotalCents: 9_800, taxCents: 980, totalCents: 10_780 });
    expect(taxed.body.items[0].productId).toBe(nutId);
  });

  it('enforces the quote lifecycle', async () => {
    const q = await sentQuote();
    await sales.as('post', `/quotes/${q.id}/accept`).expect(409);   // not sent yet
    await sales.as('post', `/quotes/${q.id}/send`).expect(200);
    await sales.as('patch', `/quotes/${q.id}`).send({ notes: 'late edit' }).expect(409);
    await sales.as('delete', `/quotes/${q.id}`).expect(409);
    await sales.as('post', `/quotes/${q.id}/send`).expect(409);

    const rejected = await sales.as('post', `/quotes/${q.id}/reject`).expect(200);
    expect(rejected.body.status).toBe('rejected');
    await sales.as('post', `/quotes/${q.id}/accept`).expect(409);
    await sales.as('post', `/quotes/${q.id}/convert`).expect(409);
  });

  it('deletes drafts', async () => {
    const q = await sentQuote();
    await sales.as('delete', `/quotes/${q.id}`).expect(204);
    await sales.as('get', `/quotes/${q.id}`).expect(404);
  });

  it('refuses to send a quote whose validity date has passed', async () => {
    const q = await sentQuote(isoDate(-1));
    const res = await sales.as('post', `/quotes/${q.id}/send`).expect(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });

  it('filters quotes by status', async () => {
    const q = await sentQuote();
    await sales.as('post', `/quotes/${q.id}/send`).expect(200);
    const res = await sales.as('get', `/quotes?status=sent&customerId=${customerId}`).expect(200);
    expect(res.body.data.every((x: { status: string }) => x.status === 'sent')).toBe(true);
    expect(res.body.data.some((x: { id: string }) => x.id === q.id)).toBe(true);
  });
});

describe('quote to order conversion', () => {
  it('converts an accepted quote into a pending order exactly once', async () => {
    const q = await sentQuote(isoDate(7));
    await sales.as('post', `/quotes/${q.id}/send`).expect(200);
    await sales.as('post', `/quotes/${q.id}/accept`).expect(200);

    const order = await sales.as('post', `/quotes/${q.id}/convert`).send({ poNumber: 'PO-4471' }).expect(201);
    expect(order.body).toMatchObject({
      quoteId: q.id, customerId, status: 'pending', poNumber: 'PO-4471', totalCents: q.totalCents,
    });
    expect(order.body.number).toMatch(/^SO-\d{6}$/);
    expect(order.body.items).toHaveLength(q.items.length);
    expect(order.body.history).toEqual([expect.objectContaining({ fromStatus: null, toStatus: 'pending' })]);

    const again = await sales.as('post', `/quotes/${q.id}/convert`).expect(409);
    expect(again.body.error.message).toContain(order.body.number);
  });
});

describe('orders', () => {
  async function directOrder() {
    const res = await sales.as('post', '/orders')
      .send({ customerId, taxRateBps: 500, items: [{ productId: boltId, quantity: 4 }] })
      .expect(201);
    return res.body;
  }

  it('creates orders directly with computed totals', async () => {
    const order = await directOrder();
    expect(order).toMatchObject({ status: 'pending', quoteId: null, subtotalCents: 9_800, taxCents: 490, totalCents: 10_290 });
  });

  it('walks the fulfilment lifecycle and records history', async () => {
    const order = await directOrder();
    await admin.as('post', `/orders/${order.id}/status`).send({ status: 'confirmed' }).expect(200);
    await admin.as('post', `/orders/${order.id}/status`).send({ status: 'shipped', note: 'UPS 1Z999' }).expect(200);
    const delivered = await admin.as('post', `/orders/${order.id}/status`).send({ status: 'delivered' }).expect(200);

    expect(delivered.body.status).toBe('delivered');
    expect(delivered.body.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['pending', 'confirmed', 'shipped', 'delivered']);
    expect(delivered.body.history[2]).toMatchObject({ fromStatus: 'confirmed', note: 'UPS 1Z999', changedById: admin.userId });
  });

  it('rejects invalid transitions', async () => {
    const order = await directOrder();
    const skip = await admin.as('post', `/orders/${order.id}/status`).send({ status: 'delivered' }).expect(409);
    expect(skip.body.error.message).toBe("Cannot change order status from 'pending' to 'delivered'");

    await admin.as('post', `/orders/${order.id}/status`).send({ status: 'cancelled' }).expect(200);
    await admin.as('post', `/orders/${order.id}/status`).send({ status: 'confirmed' }).expect(409);
    await admin.as('post', `/orders/${order.id}/status`).send({ status: 'bogus' }).expect(400);
  });

  it('cannot cancel a shipped order', async () => {
    const order = await directOrder();
    await admin.as('post', `/orders/${order.id}/status`).send({ status: 'confirmed' }).expect(200);
    await admin.as('post', `/orders/${order.id}/status`).send({ status: 'shipped' }).expect(200);
    await admin.as('post', `/orders/${order.id}/status`).send({ status: 'cancelled' }).expect(409);
  });

  it('filters orders by status', async () => {
    const order = await directOrder();
    await admin.as('post', `/orders/${order.id}/status`).send({ status: 'confirmed' }).expect(200);
    const res = await sales.as('get', '/orders?status=confirmed').expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((o: { status: string }) => o.status === 'confirmed')).toBe(true);
    expect(res.body.data[0].items).toBeUndefined();
  });

  it('returns 404 for unknown orders', async () => {
    await sales.as('get', '/orders/00000000-0000-4000-8000-000000000000').expect(404);
  });
});

describe('quote expiry without user action', () => {
  it('reports a sent quote past validUntil as expired in lists, filters and details', async () => {
    const quote = await sentQuote(isoDate(10));
    await sales.as('post', `/quotes/${quote.id}/send`).expect(200);
    // Time passes: the stored row still says 'sent', but the validity date is now in the past.
    await ctx.db.update(quotes).set({ validUntil: isoDate(-1) }).where(eq(quotes.id, quote.id));

    expect((await sales.as('get', `/quotes/${quote.id}`).expect(200)).body.status).toBe('expired');
    const sent = (await sales.as('get', '/quotes?status=sent&pageSize=100').expect(200)).body;
    expect(sent.data.map((q: { id: string }) => q.id)).not.toContain(quote.id);
    const expired = (await sales.as('get', '/quotes?status=expired&pageSize=100').expect(200)).body;
    const listed = expired.data.find((q: { id: string }) => q.id === quote.id);
    expect(listed?.status).toBe('expired');
    expect(expired.meta.total).toBe(expired.data.length);

    const reject = await sales.as('post', `/quotes/${quote.id}/reject`).expect(409);
    expect(reject.body.error.code).toBe('INVALID_STATE');
  });

  it('keeps a quote valid through the last day of validUntil', async () => {
    const quote = await sentQuote(isoDate(10));
    await sales.as('post', `/quotes/${quote.id}/send`).expect(200);
    await ctx.db.update(quotes).set({ validUntil: isoDate(0) }).where(eq(quotes.id, quote.id));
    expect((await sales.as('get', `/quotes/${quote.id}`).expect(200)).body.status).toBe('sent');
    const sent = (await sales.as('get', '/quotes?status=sent&pageSize=100').expect(200)).body;
    expect(sent.data.map((q: { id: string }) => q.id)).toContain(quote.id);
  });
});
