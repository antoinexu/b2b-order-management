import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import { MAX_MONEY_CENTS } from '../src/lib/pricing';
import { createUser, registerOrg, setupTestApp, uniqueEmail, type Session } from './helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Session;
let customerId: string, productId: string;

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await registerOrg(ctx.app);
  customerId = (await admin.as('post', '/customers').send({ companyName: 'Boundary Buyer' }).expect(201)).body.id;
  productId = (await admin.as('post', '/products').send({ sku: 'BOUNDARY', name: 'Boundary Product', unitPriceCents: 100 }).expect(201)).body.id;
});
afterAll(() => ctx.close());

describe('account deactivation', () => {
  it('revokes access and login while preserving quotes, orders and status history', async () => {
    const email = uniqueEmail('departing-manager');
    const user = (await admin.as('post', '/users').send({ email, name: 'Departing Manager', role: 'manager', password: 'Password123!' }).expect(201)).body;
    const login = await request(ctx.app).post('/api/v1/auth/login').send({ email, password: 'Password123!' }).expect(200);
    const token = login.body.token;
    const asUser = (path: string) => request(ctx.app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
    const body = { customerId, items: [{ productId, quantity: 1 }] };
    const quote = (await asUser('/quotes').send(body).expect(201)).body;
    const order = (await asUser('/orders').send(body).expect(201)).body;
    await asUser(`/orders/${order.id}/status`).send({ status: 'confirmed' }).expect(200);

    await admin.as('delete', `/users/${user.id}`).expect(204);
    for (const path of ['/customers', '/auth/me']) {
      await request(ctx.app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).expect(401);
    }
    await request(ctx.app).post('/api/v1/auth/login').send({ email, password: 'Password123!' }).expect(401);
    const stored = await ctx.db.select().from(users).where(eq(users.id, user.id));
    expect(stored[0]?.deletedAt).toBeInstanceOf(Date);
    expect((await admin.as('get', `/quotes/${quote.id}`).expect(200)).body.createdById).toBe(user.id);
    const history = (await admin.as('get', `/orders/${order.id}`).expect(200)).body.history;
    expect(history).toHaveLength(2);
    expect(history.every((entry: { changedById: string }) => entry.changedById === user.id)).toBe(true);
    const listed = (await admin.as('get', '/users').expect(200)).body;
    expect(listed.data.some((entry: { id: string }) => entry.id === user.id)).toBe(false);
    expect(listed.meta.total).toBe(1);
    await admin.as('patch', `/users/${user.id}`).send({ role: 'admin' }).expect(404);
    await admin.as('delete', `/users/${user.id}`).expect(404);
    await admin.as('post', '/users').send({ email, name: 'Replacement', role: 'viewer', password: 'Password123!' }).expect(409);
  });

  it('does not let another tenant deactivate a user', async () => {
    const other = await registerOrg(ctx.app);
    const sales = await createUser(ctx.app, admin, 'sales');
    await other.as('delete', `/users/${sales.userId}`).expect(404);
    await sales.as('get', '/customers').expect(200);
  });
});

describe('empty updates', () => {
  it.each(['customers', 'products', 'users'] as const)('rejects empty and unknown-only %s patches', async (resource) => {
    const id = { customers: customerId, products: productId, users: admin.userId }[resource];
    for (const body of [{}, { misspelledField: 'value' }]) {
      const response = await admin.as('patch', `/${resource}/${id}`).send(body).expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('stored money limits', () => {
  it('rejects prices outside int32 and accepts the largest supported catalog price', async () => {
    await admin.as('post', '/products').send({ sku: 'OVERFLOW', name: 'Large', unitPriceCents: MAX_MONEY_CENTS + 1 }).expect(400);
    await admin.as('patch', `/products/${productId}`).send({ unitPriceCents: MAX_MONEY_CENTS + 1 }).expect(400);
    const product = await admin.as('post', '/products').send({ sku: 'MAXIMUM', name: 'Maximum', unitPriceCents: MAX_MONEY_CENTS }).expect(201);
    expect(product.body.unitPriceCents).toBe(MAX_MONEY_CENTS);
  });

  it.each(['quotes', 'orders'] as const)('validates %s prices, lines, subtotals and tax before writing', async (resource) => {
    const line = (unitPriceCents: number, quantity = 1, discountBps = 0) => ({ description: 'Batch', unitPriceCents, quantity, discountBps });
    const payloads = [
      { items: [line(MAX_MONEY_CENTS + 1)] },
      { items: [line(3000, 1_000_000)] },
      { items: [line(1_500_000_000), line(1_500_000_000)] },
      { items: [line(2_000_000_000)], taxRateBps: 1000 },
    ];
    const previousCount = (await admin.as('get', `/${resource}?customerId=${customerId}`).expect(200)).body.meta.total;
    for (const payload of payloads) {
      await admin.as('post', `/${resource}`).send({ customerId, ...payload }).expect(400);
    }
    expect((await admin.as('get', `/${resource}?customerId=${customerId}`).expect(200)).body.meta.total).toBe(previousCount);
    const maximum = await admin.as('post', `/${resource}`).send({ customerId, items: [line(MAX_MONEY_CENTS)] }).expect(201);
    expect(maximum.body.totalCents).toBe(MAX_MONEY_CENTS);
    // A large gross amount is still valid when the discounted amount fits.
    const discounted = await admin.as('post', `/${resource}`).send({ customerId, items: [line(3000, 1_000_000, 5000)] }).expect(201);
    expect(discounted.body.totalCents).toBe(1_500_000_000);
    expect((await admin.as('get', `/${resource}?customerId=${customerId}`).expect(200)).body.meta.total).toBe(previousCount + 2);
  });

  it('rolls back an edit when revised lines or tax exceed the limit', async () => {
    const original = { customerId, items: [{ description: 'Original', quantity: 1, unitPriceCents: 2_000_000_000 }] };
    const quote = (await admin.as('post', '/quotes').send(original).expect(201)).body;
    await admin.as('patch', `/quotes/${quote.id}`).send({ notes: 'Must roll back', taxRateBps: 1000 }).expect(400);
    await admin.as('patch', `/quotes/${quote.id}`).send({ items: [{ description: 'Too much', quantity: 1_000_000, unitPriceCents: 3000 }] }).expect(400);
    const after = (await admin.as('get', `/quotes/${quote.id}`).expect(200)).body;
    expect(after).toEqual(quote);
  });
});
