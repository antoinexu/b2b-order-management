import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discountViolation } from '../src/lib/pricing';
import { createUser, registerOrg, setupTestApp, type Session } from './helpers';

describe('discountViolation', () => {
  it('allows discounts and price cuts up to the limit, combined', () => {
    expect(discountViolation({ unitPriceCents: 1000, discountBps: 2000 }, 1000, 2000)).toBeNull();
    expect(discountViolation({ unitPriceCents: 800, discountBps: 0 }, 1000, 2000)).toBeNull();
    // 10% off a price already cut 10% is 19% overall.
    expect(discountViolation({ unitPriceCents: 900, discountBps: 1000 }, 1000, 2000)).toBeNull();
    // Pricing above the catalog is always fine, and offsets a discount.
    expect(discountViolation({ unitPriceCents: 2000, discountBps: 5000 }, 1000, 0)).toBeNull();
  });

  it('reports the effective discount when over the limit, never rounding down to the limit', () => {
    expect(discountViolation({ unitPriceCents: 800, discountBps: 1000 }, 1000, 2000))
      .toBe('effective discount of 28% off the catalog price exceeds the 20% limit');
    expect(discountViolation({ unitPriceCents: 1999, discountBps: 0 }, 2500, 2000))
      .toBe('effective discount of 20.04% off the catalog price exceeds the 20% limit');
    expect(discountViolation({ unitPriceCents: 299_999, discountBps: 0 }, 375_000, 2000))
      .toBe('effective discount of 20.01% off the catalog price exceeds the 20% limit');
  });

  it('forbids discounting custom lines but not pricing them', () => {
    expect(discountViolation({ unitPriceCents: 1, discountBps: 0 }, undefined, 2000)).toBeNull();
    expect(discountViolation({ unitPriceCents: 1000, discountBps: 1 }, undefined, 10_000)).toBe('custom lines cannot be discounted');
  });

  it('treats a free catalog product as impossible to undercut', () => {
    expect(discountViolation({ unitPriceCents: 0, discountBps: 10_000 }, 0, 0)).toBeNull();
  });
});

describe('sales discount limit', () => {
  let ctx: Awaited<ReturnType<typeof setupTestApp>>;
  let admin: Session, manager: Session, sales: Session;
  let customerId: string, productId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await registerOrg(ctx.app, 'Discount Org');
    manager = await createUser(ctx.app, admin, 'manager');
    sales = await createUser(ctx.app, admin, 'sales');
    customerId = (await admin.as('post', '/customers').send({ companyName: 'Bargain Hunter' }).expect(201)).body.id;
    productId = (await admin.as('post', '/products').send({ sku: 'PUMP', name: 'Pump', unitPriceCents: 10_000 }).expect(201)).body.id;
  });
  afterAll(() => ctx.close());

  const catalogLine = (extra: Record<string, number> = {}) => ({ productId, quantity: 1, ...extra });
  const customLine = (discountBps = 0) => ({ description: 'Freight', quantity: 1, unitPriceCents: 5000, discountBps });

  it('defaults to 20%, exposes the limit and keeps pricing:override from sales', async () => {
    const me = (await sales.as('get', '/auth/me').expect(200)).body;
    expect(me.organization.maxDiscountBps).toBe(2000);
    expect(me.permissions).not.toContain('pricing:override');
    expect((await manager.as('get', '/auth/me').expect(200)).body.permissions).toContain('pricing:override');
  });

  it('lets sales quote within the limit, including custom lines at their own price', async () => {
    await sales.as('post', '/quotes')
      .send({ customerId, items: [catalogLine({ discountBps: 2000 }), catalogLine({ unitPriceCents: 8000 }), customLine()] })
      .expect(201);
  });

  it('rejects sales discounts, price cuts and discounted custom lines beyond the limit', async () => {
    const overDiscount = await sales.as('post', '/quotes').send({ customerId, items: [catalogLine({ discountBps: 2500 })] }).expect(403);
    expect(overDiscount.body.error.message).toBe(
      'Line 1: effective discount of 25% off the catalog price exceeds the 20% limit. Ask a manager or admin to set this price.',
    );
    const priceCut = await sales.as('post', '/quotes')
      .send({ customerId, items: [customLine(), catalogLine({ unitPriceCents: 9000, discountBps: 1500 })] }).expect(403);
    expect(priceCut.body.error.message).toMatch(/^Line 2: effective discount of 23.5%/);
    const custom = await sales.as('post', '/quotes').send({ customerId, items: [customLine(500)] }).expect(403);
    expect(custom.body.error.message).toMatch(/^Line 1: custom lines cannot be discounted/);
  });

  it('applies the same limit to orders placed directly', async () => {
    await sales.as('post', '/orders').send({ customerId, items: [catalogLine({ discountBps: 5000 })] }).expect(403);
    await sales.as('post', '/orders').send({ customerId, items: [catalogLine({ discountBps: 1000 })] }).expect(201);
  });

  it('lets managers and admins set any price', async () => {
    await manager.as('post', '/quotes').send({ customerId, items: [catalogLine({ discountBps: 9000 }), customLine(5000)] }).expect(201);
    await admin.as('post', '/orders').send({ customerId, items: [catalogLine({ unitPriceCents: 1 })] }).expect(201);
  });

  it("lets sales edit a manager-priced draft while keeping the manager's lines unchanged", async () => {
    const quote = (await manager.as('post', '/quotes')
      .send({ customerId, items: [catalogLine({ discountBps: 5000 }), customLine(1000)] }).expect(201)).body;
    const keptLines = quote.items.map(({ productId: p, description, quantity, unitPriceCents, discountBps }: Record<string, unknown>) =>
      ({ ...(p ? { productId: p } : {}), description, quantity, unitPriceCents, discountBps }));

    // Resubmitting the same lines (as the editor does) plus a compliant new one is fine; so is a tax change alone.
    await sales.as('patch', `/quotes/${quote.id}`).send({ notes: 'Called the buyer', items: [...keptLines, customLine()] }).expect(200);
    await sales.as('patch', `/quotes/${quote.id}`).send({ taxRateBps: 500 }).expect(200);

    // Scaling up the discounted line, or duplicating it, is a new price decision.
    await sales.as('patch', `/quotes/${quote.id}`)
      .send({ items: [{ ...keptLines[0], quantity: 50 }, keptLines[1]] }).expect(403);
    await sales.as('patch', `/quotes/${quote.id}`)
      .send({ items: [keptLines[0], keptLines[0], keptLines[1]] }).expect(403);
  });

  it('rechecks a line the catalog has since undercut only if sales changes it', async () => {
    const product = (await admin.as('post', '/products').send({ sku: 'VALVE', name: 'Valve', unitPriceCents: 1000 }).expect(201)).body;
    const quote = (await sales.as('post', '/quotes').send({ customerId, items: [{ productId: product.id, quantity: 1, discountBps: 2000 }] }).expect(201)).body;
    await admin.as('patch', `/products/${product.id}`).send({ unitPriceCents: 2000 }).expect(200);
    const kept = { productId: product.id, quantity: 1, unitPriceCents: 1000, discountBps: 2000 };
    await sales.as('patch', `/quotes/${quote.id}`).send({ items: [kept] }).expect(200);
    await sales.as('patch', `/quotes/${quote.id}`).send({ items: [{ ...kept, discountBps: 1900 }] }).expect(403);
  });

  it('lets admins change the limit, and the new limit applies at once', async () => {
    await manager.as('patch', '/organization').send({ maxDiscountBps: 5000 }).expect(403);
    await admin.as('patch', '/organization').send({ maxDiscountBps: 10_001 }).expect(400);
    const res = await admin.as('patch', '/organization').send({ maxDiscountBps: 0 }).expect(200);
    expect(res.body.maxDiscountBps).toBe(0);
    await sales.as('post', '/quotes').send({ customerId, items: [catalogLine({ discountBps: 1 })] }).expect(403);
    await sales.as('post', '/quotes').send({ customerId, items: [catalogLine()] }).expect(201);
    await admin.as('patch', '/organization').send({ maxDiscountBps: 2000 }).expect(200);
  });

  it('rechecks every line when sales moves a draft to another customer, even without sending lines', async () => {
    const otherCustomer = (await admin.as('post', '/customers').send({ companyName: 'Other Buyer' }).expect(201)).body.id;
    const quote = (await manager.as('post', '/quotes').send({ customerId, items: [catalogLine({ discountBps: 6000 })] }).expect(201)).body;
    const kept = { productId, quantity: 1, unitPriceCents: 10_000, discountBps: 6000 };

    const moved = await sales.as('patch', `/quotes/${quote.id}`).send({ customerId: otherCustomer }).expect(403);
    expect(moved.body.error.message).toMatch(/^Line 1: effective discount of 60%/);
    await sales.as('patch', `/quotes/${quote.id}`).send({ customerId: otherCustomer, items: [kept] }).expect(403);
    // Naming the current customer again is not a move.
    await sales.as('patch', `/quotes/${quote.id}`).send({ customerId, items: [kept] }).expect(200);
    expect((await sales.as('get', `/quotes/${quote.id}`).expect(200)).body.customerId).toBe(customerId);
    await manager.as('patch', `/quotes/${quote.id}`).send({ customerId: otherCustomer }).expect(200);
  });

  it('lets sales price only in the base currency, which new documents default to', async () => {
    const quote = (await sales.as('post', '/quotes').send({ customerId, items: [catalogLine()] }).expect(201)).body;
    expect(quote.currency).toBe('USD');
    const create = await sales.as('post', '/quotes').send({ customerId, currency: 'GBP', items: [catalogLine()] }).expect(403);
    expect(create.body.error.message).toBe('Only a manager or admin can price in GBP; the catalog is priced in USD.');
    await sales.as('post', '/orders').send({ customerId, currency: 'EUR', items: [customLine()] }).expect(403);
    await sales.as('patch', `/quotes/${quote.id}`).send({ currency: 'GBP' }).expect(403);
    await manager.as('post', '/quotes').send({ customerId, currency: 'GBP', items: [catalogLine()] }).expect(201);
  });

  it('accepts only currencies that money in hundredths can represent', async () => {
    for (const currency of ['JPY', 'KRW', 'KWD', 'XYZ']) {
      const res = await manager.as('post', '/quotes').send({ customerId, currency, items: [catalogLine()] }).expect(400);
      expect(res.body.error.details[0].message).toBe('Must be a currency with two decimal places, such as USD, EUR or GBP');
      await admin.as('patch', '/organization').send({ currency }).expect(400);
    }
    await manager.as('post', '/orders').send({ customerId, currency: 'CNY', items: [catalogLine()] }).expect(201);
  });

  it("lets sales keep a manager's foreign-currency lines but not add to them", async () => {
    const quote = (await manager.as('post', '/quotes')
      .send({ customerId, currency: 'EUR', items: [catalogLine({ unitPriceCents: 9000 })] }).expect(201)).body;
    const kept = { productId, quantity: 1, unitPriceCents: 9000, discountBps: 0 };
    await sales.as('patch', `/quotes/${quote.id}`).send({ notes: 'Confirmed by phone', items: [kept] }).expect(200);
    await sales.as('patch', `/quotes/${quote.id}`).send({ items: [kept, customLine()] }).expect(403);
  });

  it('defaults new documents to a changed base currency and holds sales to it', async () => {
    const org = await registerOrg(ctx.app, 'Euro Org');
    const euroSales = await createUser(ctx.app, org, 'sales');
    const buyer = (await org.as('post', '/customers').send({ companyName: 'Euro Buyer' }).expect(201)).body.id;
    await org.as('patch', '/organization').send({ currency: 'usd' }).expect(400);
    expect((await org.as('patch', '/organization').send({ currency: 'EUR' }).expect(200)).body.currency).toBe('EUR');
    const order = (await euroSales.as('post', '/orders').send({ customerId: buyer, items: [customLine()] }).expect(201)).body;
    expect(order.currency).toBe('EUR');
    await euroSales.as('post', '/orders').send({ customerId: buyer, currency: 'USD', items: [customLine()] }).expect(403);
  });

  it('converts an accepted quote at its agreed prices without rechecking them', async () => {
    const quote = (await manager.as('post', '/quotes').send({ customerId, items: [catalogLine({ discountBps: 6000 })] }).expect(201)).body;
    await manager.as('post', `/quotes/${quote.id}/send`).expect(200);
    await manager.as('post', `/quotes/${quote.id}/accept`).expect(200);
    const order = (await sales.as('post', `/quotes/${quote.id}/convert`).send({}).expect(201)).body;
    expect(order.items[0].discountBps).toBe(6000);
  });
});
