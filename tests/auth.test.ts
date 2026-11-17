import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { createUser, registerOrg, setupTestApp, uniqueEmail } from './helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(() => ctx.close());

describe('auth', () => {
  it('registers an organization with an admin user', async () => {
    const email = uniqueEmail();
    const res = await request(ctx.app)
      .post('/api/v1/auth/register')
      .send({ organizationName: 'Acme', name: 'Ada', email, password: 'Password123!' })
      .expect(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ email, role: 'admin' });
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('normalizes email case and rejects duplicate registration', async () => {
    const email = uniqueEmail();
    await request(ctx.app).post('/api/v1/auth/register')
      .send({ organizationName: 'A', name: 'A', email, password: 'Password123!' }).expect(201);
    const res = await request(ctx.app).post('/api/v1/auth/register')
      .send({ organizationName: 'B', name: 'B', email: email.toUpperCase(), password: 'Password123!' }).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('validates registration input', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/register')
      .send({ organizationName: '', name: 'A', email: 'not-an-email', password: 'short' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['organizationName', 'email', 'password']));
  });

  it('logs in with valid credentials and returns the same error for bad email or password', async () => {
    const email = uniqueEmail();
    await request(ctx.app).post('/api/v1/auth/register')
      .send({ organizationName: 'A', name: 'A', email, password: 'Password123!' }).expect(201);

    await request(ctx.app).post('/api/v1/auth/login').send({ email, password: 'Password123!' }).expect(200);
    const wrongPw = await request(ctx.app).post('/api/v1/auth/login').send({ email, password: 'nope' }).expect(401);
    const noUser = await request(ctx.app).post('/api/v1/auth/login')
      .send({ email: uniqueEmail(), password: 'nope' }).expect(401);
    expect(wrongPw.body.error.message).toBe(noUser.body.error.message);
  });

  it('returns current user, organization and permissions from /me', async () => {
    const admin = await registerOrg(ctx.app, 'Me Corp');
    const res = await admin.as('get', '/auth/me').expect(200);
    expect(res.body.organization.name).toBe('Me Corp');
    expect(res.body.permissions).toContain('users:write');
  });

  it('only accepts HS256 tokens, even when signed with the right secret', async () => {
    const admin = await registerOrg(ctx.app);
    const claims = { sub: admin.userId, org: admin.organizationId };
    await admin.as('get', '/customers').expect(200);
    const hs512 = jwt.sign(claims, config.JWT_SECRET, { algorithm: 'HS512', expiresIn: '1h' });
    await request(ctx.app).get('/api/v1/customers').set('Authorization', `Bearer ${hs512}`).expect(401);
    const unsigned = jwt.sign(claims, null, { algorithm: 'none' });
    await request(ctx.app).get('/api/v1/customers').set('Authorization', `Bearer ${unsigned}`).expect(401);
  });

  it('rejects missing, malformed and tampered tokens', async () => {
    await request(ctx.app).get('/api/v1/customers').expect(401);
    await request(ctx.app).get('/api/v1/customers').set('Authorization', 'Bearer garbage').expect(401);
    const admin = await registerOrg(ctx.app);
    const tampered = `${admin.token.slice(0, -2)}xx`;
    await request(ctx.app).get('/api/v1/customers').set('Authorization', `Bearer ${tampered}`).expect(401);
  });

  it('invalidates tokens of deleted users immediately', async () => {
    const admin = await registerOrg(ctx.app);
    const sales = await createUser(ctx.app, admin, 'sales');
    await sales.as('get', '/customers').expect(200);
    await admin.as('delete', `/users/${sales.userId}`).expect(204);
    await sales.as('get', '/customers').expect(401);
  });
});

describe('platform', () => {
  it('serves health and the OpenAPI document', async () => {
    await request(ctx.app).get('/health').expect(200, { status: 'ok' });
    await request(ctx.app).get('/docs/').expect(200).expect('Content-Type', /html/);
    const res = await request(ctx.app).get('/openapi.json').expect(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/auth/login', '/customers', '/quotes/{id}/convert', '/orders/{id}/status']),
    );
  });

  it('returns JSON 404 for unknown routes and 400 for malformed JSON', async () => {
    const notFound = await request(ctx.app).get('/api/v1/nope').expect(404);
    expect(notFound.body.error.code).toBe('NOT_FOUND');
    const bad = await request(ctx.app).post('/api/v1/auth/login')
      .set('Content-Type', 'application/json').send('{"email":').expect(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
  });
});
