import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import type { DB } from '../src/db/client';
import { setupTestApp, uniqueEmail } from './helpers';

const register = (app: Parameters<typeof request>[0], email = uniqueEmail()) =>
  request(app).post('/api/v1/auth/register').send({ organizationName: 'Org', name: 'User', email, password: 'Password123!' });
const login = (app: Parameters<typeof request>[0], email: string, password: string) =>
  request(app).post('/api/v1/auth/login').send({ email, password });

describe('auth rate limiting', () => {
  let ctx: Awaited<ReturnType<typeof setupTestApp>>;
  beforeAll(async () => { ctx = await setupTestApp({ AUTH_RATE_LIMIT_MAX: 3 }); });
  afterAll(() => ctx.close());

  it('does not count successful logins against the limit', async () => {
    const email = uniqueEmail();
    await register(ctx.app, email).expect(201);
    for (let i = 0; i < 5; i++) await login(ctx.app, email, 'Password123!').expect(200);
  });

  it('blocks login after repeated failures with a 429 in the standard error shape', async () => {
    const email = uniqueEmail();
    for (let i = 0; i < 3; i++) await login(ctx.app, email, 'wrong-password').expect(401);
    const blocked = await login(ctx.app, email, 'wrong-password').expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers.ratelimit).toBeDefined();
    // Once blocked, even the correct password is refused until the window resets.
    await login(ctx.app, email, 'Password123!').expect(429);
  });

  it('limits registrations per IP', async () => {
    // One registration was already used by the first test in this app instance.
    await register(ctx.app).expect(201);
    await register(ctx.app).expect(201);
    const blocked = await register(ctx.app).expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('login timing', () => {
  let ctx: Awaited<ReturnType<typeof setupTestApp>>;
  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(() => ctx.close());

  const median = async (fn: () => Promise<unknown>, runs = 5) => {
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await fn();
      times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
  };

  it('takes comparable time for unknown emails and wrong passwords', async () => {
    const email = uniqueEmail();
    await register(ctx.app, email).expect(201);
    await login(ctx.app, uniqueEmail(), 'x').expect(401); // warm up the dummy hash

    const wrongPassword = await median(() => login(ctx.app, email, 'wrong-password').expect(401));
    const unknownEmail = await median(() => login(ctx.app, uniqueEmail(), 'wrong-password').expect(401));
    // Without the dummy hash, unknown emails skip scrypt and return several times faster.
    expect(unknownEmail).toBeGreaterThan(wrongPassword * 0.5);
  });
});

describe('health check', () => {
  it('returns 503 when the database is unreachable', async () => {
    const brokenDb = { execute: () => Promise.reject(new Error('connection refused')) } as unknown as DB;
    const app = createApp({ db: brokenDb, config: { ...config, NODE_ENV: 'test' } });
    const res = await request(app).get('/health').expect(503);
    expect(res.body).toEqual({ status: 'unavailable' });
  });
});
