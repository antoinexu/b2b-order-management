/**
 * Concurrency tests against a real PostgreSQL server.
 *
 * PGlite has a single connection, so transactions in the other suites run one after another and
 * cannot prove that row locks work. These tests use a connection pool, so requests really overlap.
 * They run when TEST_DATABASE_URL is set (CI provides a Postgres service) and are skipped otherwise.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { createPgDatabase } from '../src/db/client';
import { registerOrg, type Session } from './helpers';

const url = process.env.TEST_DATABASE_URL;
const PARALLEL = 8;

describe.skipIf(!url)('concurrency on real Postgres', () => {
  let pg: ReturnType<typeof createPgDatabase>;
  let app: ReturnType<typeof createApp>;
  let admin: Session;
  let customerId: string;

  beforeAll(async () => {
    pg = createPgDatabase(url!);
    await pg.migrate();
    app = createApp({ db: pg.db, config: { ...config, NODE_ENV: 'test', AUTH_RATE_LIMIT_MAX: 10_000 } });
    // Each run registers a fresh organization, so leftover rows from earlier runs don't matter.
    admin = await registerOrg(app, 'Concurrency Org');
    customerId = (await admin.as('post', '/customers').send({ companyName: 'Parallel Buyer' }).expect(201)).body.id;
  });
  afterAll(() => pg?.close());

  const newQuote = () =>
    admin.as('post', '/quotes').send({ customerId, items: [{ description: 'Widget', quantity: 1, unitPriceCents: 1000 }] });

  async function acceptedQuote() {
    const { id } = (await newQuote().expect(201)).body;
    await admin.as('post', `/quotes/${id}/send`).expect(200);
    await admin.as('post', `/quotes/${id}/accept`).expect(200);
    return id as string;
  }

  it('allocates unique, gapless document numbers to simultaneous creates', async () => {
    const before = (await admin.as('get', '/quotes?pageSize=1').expect(200)).body.meta.total as number;
    const results = await Promise.all(Array.from({ length: PARALLEL }, () => newQuote()));
    expect(results.map((r) => r.status)).toEqual(Array(PARALLEL).fill(201));
    const numbers = results.map((r) => r.body.number as string).sort();
    const expected = Array.from({ length: PARALLEL }, (_, i) => `Q-${String(before + i + 1).padStart(6, '0')}`);
    expect(numbers).toEqual(expected);
  });

  it('converts a quote into exactly one order when converts race', async () => {
    const quoteId = await acceptedQuote();
    const results = await Promise.all(Array.from({ length: PARALLEL }, () => admin.as('post', `/quotes/${quoteId}/convert`).send({})));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, ...Array(PARALLEL - 1).fill(409)]);
    const orders = (await admin.as('get', '/orders?pageSize=100').expect(200)).body.data as { quoteId: string | null }[];
    expect(orders.filter((o) => o.quoteId === quoteId)).toHaveLength(1);
  });

  it('applies one of several simultaneous status changes and records it once', async () => {
    const quoteId = await acceptedQuote();
    const orderId = (await admin.as('post', `/quotes/${quoteId}/convert`).send({}).expect(201)).body.id as string;
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => admin.as('post', `/orders/${orderId}/status`).send({ status: 'confirmed' })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((r) => r.status !== 200)) expect(r.body.error.code).toBe('INVALID_STATE');
    const order = (await admin.as('get', `/orders/${orderId}`).expect(200)).body;
    expect(order.status).toBe('confirmed');
    expect(order.history.filter((h: { toStatus: string }) => h.toStatus === 'confirmed')).toHaveLength(1);
  });

  it('keeps the pool usable for plain requests afterwards', async () => {
    await request(app).get('/health').expect(200);
  });
});
