import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DEMO_PASSWORD, seedDemoData } from '../src/db/demo-data';
import { setupTestApp } from './helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(() => ctx.close());

it('seeds a consistent demo organization exactly once', async () => {
  expect(await seedDemoData(ctx.db)).toBe(true);
  expect(await seedDemoData(ctx.db)).toBe(false);

  const login = await request(ctx.app).post('/api/v1/auth/login')
    .send({ email: 'viewer@acme.example', password: DEMO_PASSWORD }).expect(200);
  const as = (path: string) => request(ctx.app).get(`/api/v1${path}`).set('Authorization', `Bearer ${login.body.token}`);

  expect((await as('/customers').expect(200)).body.meta.total).toBe(3);
  expect((await as('/products').expect(200)).body.meta.total).toBe(5);
  const quoteStatuses = (await as('/quotes').expect(200)).body.data.map((q: { status: string }) => q.status).sort();
  expect(quoteStatuses).toEqual(['accepted', 'draft', 'rejected', 'sent']);
  const orders = (await as('/orders').expect(200)).body.data;
  expect(orders.map((o: { status: string }) => o.status).sort()).toEqual(['cancelled', 'confirmed', 'delivered', 'pending', 'shipped']);

  const delivered = orders.find((o: { status: string }) => o.status === 'delivered');
  const detail = (await as(`/orders/${delivered.id}`).expect(200)).body;
  expect(detail.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['pending', 'confirmed', 'shipped', 'delivered']);

  // List and detail responses carry the customer's company name (joined server-side).
  expect(delivered.customerName).toBe('Harbor Logistics LLC');
  expect(detail.customerName).toBe('Harbor Logistics LLC');
  const quote = (await as('/quotes?status=draft').expect(200)).body.data[0];
  expect(quote.customerName).toBe('Summit Manufacturing Co.');
  expect((await as(`/quotes/${quote.id}`).expect(200)).body.customerName).toBe('Summit Manufacturing Co.');
});
