import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { quotes } from '../src/db/schema';
import { todayIn } from '../src/lib/dates';
import { createUser, registerOrg, sessionFor, setupTestApp, uniqueEmail, type Session } from './helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
  ctx = await setupTestApp();
});
afterAll(() => ctx.close());

describe('change password', () => {
  async function newUser() {
    const email = uniqueEmail('pw');
    const res = await request(ctx.app).post('/api/v1/auth/register')
      .send({ organizationName: 'Password Org', name: 'Pat', email, password: 'Password123!' }).expect(201);
    return { email, session: sessionFor(ctx.app, res.body.token, res.body.user.id, res.body.user.organizationId) };
  }

  it('rejects a wrong current password without signing the user out', async () => {
    const { session } = await newUser();
    const res = await session.as('post', '/auth/change-password')
      .send({ currentPassword: 'wrong-password', newPassword: 'NewPassword456!' }).expect(400);
    expect(res.body.error.message).toBe('Current password is incorrect');
    await session.as('get', '/auth/me').expect(200);
  });

  it('validates the new password', async () => {
    const { session } = await newUser();
    await session.as('post', '/auth/change-password').send({ currentPassword: 'Password123!', newPassword: 'short' }).expect(400);
  });

  it('changes the password, revokes every existing token and returns a working one', async () => {
    const { email, session } = await newUser();
    const otherDevice = (await request(ctx.app).post('/api/v1/auth/login').send({ email, password: 'Password123!' }).expect(200)).body.token;

    const res = await session.as('post', '/auth/change-password')
      .send({ currentPassword: 'Password123!', newPassword: 'NewPassword456!' }).expect(200);
    expect(res.body.user.email).toBe(email);

    const revoked = await session.as('get', '/auth/me').expect(401);
    expect(revoked.body.error.message).toMatch(/revoked/);
    await request(ctx.app).get('/api/v1/auth/me').set('Authorization', `Bearer ${otherDevice}`).expect(401);
    await request(ctx.app).get('/api/v1/auth/me').set('Authorization', `Bearer ${res.body.token}`).expect(200);

    await request(ctx.app).post('/api/v1/auth/login').send({ email, password: 'Password123!' }).expect(401);
    await request(ctx.app).post('/api/v1/auth/login').send({ email, password: 'NewPassword456!' }).expect(200);
  });

  it('accepts tokens issued before token versions existed until the password changes', async () => {
    const { session } = await newUser();
    const legacy = jwt.sign({ sub: session.userId, org: session.organizationId }, config.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    await request(ctx.app).get('/api/v1/auth/me').set('Authorization', `Bearer ${legacy}`).expect(200);
    await session.as('post', '/auth/change-password').send({ currentPassword: 'Password123!', newPassword: 'NewPassword456!' }).expect(200);
    await request(ctx.app).get('/api/v1/auth/me').set('Authorization', `Bearer ${legacy}`).expect(401);
  });

  it('requires authentication', async () => {
    await request(ctx.app).post('/api/v1/auth/change-password')
      .send({ currentPassword: 'Password123!', newPassword: 'NewPassword456!' }).expect(401);
  });
});

describe('quote status history', () => {
  let admin: Session, sales: Session, customerId: string;

  beforeAll(async () => {
    admin = await registerOrg(ctx.app, 'History Org');
    sales = await createUser(ctx.app, admin, 'sales');
    customerId = (await admin.as('post', '/customers').send({ companyName: 'Audit Buyer' }).expect(201)).body.id;
  });

  const draft = async () => (await sales.as('post', '/quotes')
    .send({ customerId, items: [{ description: 'Widget', quantity: 1, unitPriceCents: 1000 }] }).expect(201)).body;

  it('records who created, sent and accepted a quote, in order', async () => {
    const quote = await draft();
    expect(quote.history).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'draft', changedById: sales.userId, changedByName: 'Test sales' }),
    ]);
    await sales.as('post', `/quotes/${quote.id}/send`).expect(200);
    const accepted = (await admin.as('post', `/quotes/${quote.id}/accept`).expect(200)).body;
    expect(accepted.history.map((h: { fromStatus: string | null; toStatus: string; changedById: string }) =>
      [h.fromStatus, h.toStatus, h.changedById])).toEqual([
      [null, 'draft', sales.userId],
      ['draft', 'sent', sales.userId],
      ['sent', 'accepted', admin.userId],
    ]);
  });

  it('records rejections', async () => {
    const quote = await draft();
    await sales.as('post', `/quotes/${quote.id}/send`).expect(200);
    const rejected = (await sales.as('post', `/quotes/${quote.id}/reject`).expect(200)).body;
    expect(rejected.history.at(-1)).toMatchObject({ fromStatus: 'sent', toStatus: 'rejected' });
  });

  it('records the expiry committed by a late acceptance', async () => {
    const quote = await draft();
    await sales.as('post', `/quotes/${quote.id}/send`).expect(200);
    await ctx.db.update(quotes).set({ validUntil: '2000-01-01' }).where(eq(quotes.id, quote.id));
    await sales.as('post', `/quotes/${quote.id}/accept`).expect(409);
    const after = (await sales.as('get', `/quotes/${quote.id}`).expect(200)).body;
    expect(after.history.at(-1)).toMatchObject({ fromStatus: 'sent', toStatus: 'expired', changedById: sales.userId });
  });

  it('does not record failed transitions or edits', async () => {
    const quote = await draft();
    await sales.as('patch', `/quotes/${quote.id}`).send({ notes: 'edited' }).expect(200);
    await sales.as('post', `/quotes/${quote.id}/accept`).expect(409);
    expect((await sales.as('get', `/quotes/${quote.id}`).expect(200)).body.history).toHaveLength(1);
  });
});

describe('organization time zone', () => {
  // UTC+14 and UTC-12 are 26 hours apart, so their calendar dates always differ.
  const AHEAD = 'Pacific/Kiritimati';
  const BEHIND = 'Etc/GMT+12';

  it('defaults to UTC, accepts a zone at registration and canonicalizes it', async () => {
    const plain = await registerOrg(ctx.app, 'Plain Org');
    expect((await plain.as('get', '/auth/me').expect(200)).body.organization.timezone).toBe('UTC');

    const res = await request(ctx.app).post('/api/v1/auth/register')
      .send({ organizationName: 'Zoned', name: 'Z', email: uniqueEmail('tz'), password: 'Password123!', timezone: 'america/new_york' })
      .expect(201);
    const me = await request(ctx.app).get('/api/v1/auth/me').set('Authorization', `Bearer ${res.body.token}`).expect(200);
    expect(me.body.organization.timezone).toBe('America/New_York');
  });

  it('rejects unknown zones', async () => {
    await request(ctx.app).post('/api/v1/auth/register')
      .send({ organizationName: 'Bad', name: 'B', email: uniqueEmail('tz'), password: 'Password123!', timezone: 'Mars/Olympus' })
      .expect(400);
    const admin = await registerOrg(ctx.app, 'Bad Zone Org');
    await admin.as('patch', '/organization').send({ timezone: 'Not/AZone' }).expect(400);
    await admin.as('patch', '/organization').send({}).expect(400);
  });

  it('lets only admins change organization settings', async () => {
    const admin = await registerOrg(ctx.app, 'Settings Org');
    const manager = await createUser(ctx.app, admin, 'manager');
    await manager.as('patch', '/organization').send({ timezone: 'Europe/Paris' }).expect(403);
    const res = await admin.as('patch', '/organization').send({ timezone: 'Europe/Paris', name: 'Renamed Org' }).expect(200);
    expect(res.body).toMatchObject({ id: admin.organizationId, name: 'Renamed Org', timezone: 'Europe/Paris' });
    expect((await manager.as('get', '/auth/me').expect(200)).body.permissions).not.toContain('organization:write');
  });

  it("ends a quote's validity at midnight in the organization's zone", async () => {
    const admin = await registerOrg(ctx.app, 'Zone Quote Org');
    const customerId = (await admin.as('post', '/customers').send({ companyName: 'Zone Buyer' }).expect(201)).body.id;
    // The latest date that has already ended somewhere: past in the ahead zone, still today in the behind zone.
    const validUntil = todayIn(BEHIND);
    const quote = (await admin.as('post', '/quotes')
      .send({ customerId, validUntil, items: [{ description: 'Widget', quantity: 1, unitPriceCents: 1000 }] }).expect(201)).body;

    await admin.as('patch', '/organization').send({ timezone: AHEAD }).expect(200);
    const blocked = await admin.as('post', `/quotes/${quote.id}/send`).expect(409);
    expect(blocked.body.error.message).toContain(AHEAD);

    await admin.as('patch', '/organization').send({ timezone: BEHIND }).expect(200);
    expect((await admin.as('post', `/quotes/${quote.id}/send`).expect(200)).body.status).toBe('sent');
    const sent = (await admin.as('get', '/quotes?status=sent').expect(200)).body;
    expect(sent.data.map((q: { id: string }) => q.id)).toContain(quote.id);

    await admin.as('patch', '/organization').send({ timezone: AHEAD }).expect(200);
    expect((await admin.as('get', `/quotes/${quote.id}`).expect(200)).body.status).toBe('expired');
    const expired = (await admin.as('get', '/quotes?status=expired').expect(200)).body;
    expect(expired.data.map((q: { id: string }) => q.id)).toContain(quote.id);
  });
});

describe('todayIn', () => {
  it('returns the calendar date in the given zone', () => {
    const instant = new Date('2026-03-01T02:30:00Z');
    expect(todayIn('UTC', instant)).toBe('2026-03-01');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-02-28');
    expect(todayIn('Asia/Shanghai', instant)).toBe('2026-03-01');
  });
});
