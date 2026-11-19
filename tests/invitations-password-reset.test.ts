import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { users, userTokens } from '../src/db/schema';
import { settleBackgroundTasks } from '../src/lib/background';
import type { Mailer } from '../src/lib/mailer';
import { createUser, linkToken, registerOrg, setupTestApp, uniqueEmail, type Session } from './helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Session;

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await registerOrg(ctx.app, 'Invite Org');
});
afterAll(() => ctx.close());
beforeEach(() => { ctx.outbox.length = 0; });

const api = () => request(ctx.app);
const login = (email: string, password: string) => api().post('/api/v1/auth/login').send({ email, password });
const lastEmailTo = (to: string) => {
  const email = ctx.outbox.filter((e) => e.to === to).at(-1);
  if (!email) throw new Error(`No email to ${to}`);
  return email;
};
async function invite(role = 'sales', session = admin) {
  const email = uniqueEmail('invitee');
  const res = await session.as('post', '/users').send({ email, name: 'New Teammate', role }).expect(201);
  return { email, id: res.body.id as string, user: res.body, token: linkToken(lastEmailTo(email).text) };
}
async function forgot(email: string) {
  await api().post('/api/v1/auth/forgot-password').send({ email }).expect(202);
  await settleBackgroundTasks();
}

describe('invitations', () => {
  it('emails an invitation link and keeps the account pending until it is accepted', async () => {
    const { email, user, token } = await invite('manager');
    expect(user).toMatchObject({ email, role: 'manager', status: 'invited' });
    const message = lastEmailTo(email);
    expect(message.subject).toBe('Join Invite Org on B2B Order Management');
    expect(message.text).toContain('Org Admin invited you to join Invite Org on B2B Order Management as manager.');
    expect(message.text).toContain(`http://app.test/accept-invitation#token=${token}`);
    expect(message.html).toContain('Accept invitation');

    // Nobody can sign in to a pending account, whatever password they try.
    expect((await login(email, 'Password123!').expect(401)).body.error.message).toBe('Invalid email or password');
    const listed = (await admin.as('get', '/users').expect(200)).body.data.find((u: { email: string }) => u.email === email);
    expect(listed.status).toBe('invited');

    const lookup = await api().post('/api/v1/auth/invitations/lookup').send({ token }).expect(200);
    expect(lookup.body).toMatchObject({ email, name: 'New Teammate', role: 'manager', organizationName: 'Invite Org' });
    expect(new Date(lookup.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    const accepted = await api().post('/api/v1/auth/invitations/accept')
      .send({ token, password: 'Chosen-pass-1', name: 'Nova Teammate' }).expect(200);
    expect(accepted.body.user).toMatchObject({ email, name: 'Nova Teammate', status: 'active' });
    const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${accepted.body.token}`).expect(200);
    expect(me.body.permissions).toContain('pricing:override');
    await login(email, 'Chosen-pass-1').expect(200);
  });

  it('uses each link once, and only for its own purpose', async () => {
    const { token } = await invite();
    // An invitation link is not a password reset link.
    await api().post('/api/v1/auth/reset-password').send({ token, password: 'Another-pass-1' }).expect(400);
    await api().post('/api/v1/auth/invitations/accept').send({ token, password: 'Chosen-pass-1' }).expect(200);
    const again = await api().post('/api/v1/auth/invitations/accept').send({ token, password: 'Hijack-pass-1' }).expect(400);
    expect(again.body.error.code).toBe('INVALID_LINK');
    await api().post('/api/v1/auth/invitations/lookup').send({ token }).expect(400);
    await api().post('/api/v1/auth/invitations/accept').send({ token: 'x'.repeat(43), password: 'Chosen-pass-1' }).expect(400);
  });

  it('stores only a hash of the link token', async () => {
    const { id, token } = await invite();
    const [row] = await ctx.db.select().from(userTokens).where(eq(userTokens.userId, id));
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tokenHash).not.toContain(token);
  });

  it('rejects expired invitations', async () => {
    const { id, token } = await invite();
    await ctx.db.update(userTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(userTokens.userId, id));
    await api().post('/api/v1/auth/invitations/lookup').send({ token }).expect(400);
    await api().post('/api/v1/auth/invitations/accept').send({ token, password: 'Chosen-pass-1' }).expect(400);
  });

  it('resends an invitation with a new link that replaces the old one', async () => {
    const { email, id, token: first } = await invite();
    const resent = await admin.as('post', `/users/${id}/resend-invitation`).expect(200);
    expect(resent.body.status).toBe('invited');
    const second = linkToken(lastEmailTo(email).text);
    expect(second).not.toBe(first);
    await api().post('/api/v1/auth/invitations/accept').send({ token: first, password: 'Chosen-pass-1' }).expect(400);
    await api().post('/api/v1/auth/invitations/accept').send({ token: second, password: 'Chosen-pass-1' }).expect(200);
    const done = await admin.as('post', `/users/${id}/resend-invitation`).expect(409);
    expect(done.body.error.message).toBe('This user has already accepted their invitation');
  });

  it('lets only admins invite or resend, and keeps other organizations out', async () => {
    const manager = await createUser(ctx.app, admin, 'manager');
    const { id } = await invite();
    await manager.as('post', '/users').send({ email: uniqueEmail(), name: 'Nope', role: 'viewer' }).expect(403);
    await manager.as('post', `/users/${id}/resend-invitation`).expect(403);
    const otherAdmin = await registerOrg(ctx.app, 'Other Org');
    await otherAdmin.as('post', `/users/${id}/resend-invitation`).expect(404);
  });

  it('refuses an email that is already registered without sending anything', async () => {
    const { email } = await invite();
    ctx.outbox.length = 0;
    await admin.as('post', '/users').send({ email, name: 'Duplicate', role: 'viewer' }).expect(409);
    expect(ctx.outbox).toHaveLength(0);
  });

  it('cancelling an invitation kills its link and frees the email to be invited again', async () => {
    const { email, id, token } = await invite('admin');
    await admin.as('delete', `/users/${id}`).expect(204);
    await api().post('/api/v1/auth/invitations/accept').send({ token, password: 'Chosen-pass-1' }).expect(400);
    expect(await ctx.db.select().from(users).where(eq(users.id, id))).toHaveLength(0);
    expect(await ctx.db.select().from(userTokens).where(eq(userTokens.userId, id))).toHaveLength(0);

    const again = await admin.as('post', '/users').send({ email, name: 'Fixed Name', role: 'viewer' }).expect(201);
    expect(again.body).toMatchObject({ name: 'Fixed Name', role: 'viewer', status: 'invited' });
    await api().post('/api/v1/auth/invitations/accept').send({ token: linkToken(lastEmailTo(email).text), password: 'Chosen-pass-1' }).expect(200);
  });

  it('kills outstanding reset links when an active user is deactivated, and keeps their email reserved', async () => {
    const member = await createUser(ctx.app, admin, 'viewer');
    const email = (await member.as('get', '/auth/me').expect(200)).body.user.email;
    await forgot(email);
    const token = linkToken(lastEmailTo(email).text);
    await admin.as('delete', `/users/${member.userId}`).expect(204);
    await api().post('/api/v1/auth/reset-password').send({ token, password: 'Recovered-pass-1' }).expect(400);
    await admin.as('post', '/users').send({ email, name: 'Reuse', role: 'viewer' }).expect(409);
  });

  it('still lets admins set an initial password instead of inviting', async () => {
    const email = uniqueEmail('direct');
    const res = await admin.as('post', '/users').send({ email, name: 'Direct', role: 'viewer', password: 'Initial-pass-1' }).expect(201);
    expect(res.body.status).toBe('active');
    expect(ctx.outbox).toHaveLength(0);
    await login(email, 'Initial-pass-1').expect(200);
  });
});

describe('when email fails or is not configured', () => {
  it('documents these answers on every endpoint that sends email', async () => {
    const { paths } = (await request(ctx.app).get('/openapi.json').expect(200)).body;
    const documented = (path: string) => Object.keys(paths[path].post.responses).filter((code) => code === '502' || code === '503');
    expect(documented('/auth/forgot-password')).toEqual(['503']);
    expect(documented('/users')).toEqual(['502', '503']);
    expect(documented('/users/{id}/resend-invitation')).toEqual(['502', '503']);
    // Quote emails record a provider failure on the delivery (status `failed`) instead of answering 502.
    expect(documented('/quotes/{id}/deliveries')).toEqual(['503']);
    expect(documented('/quotes/{id}/deliveries/{deliveryId}/retry')).toEqual(['503']);
    expect(paths['/users'].post.responses['502'].description).toMatch(/^`EMAIL_FAILED`/);
    expect(paths['/users'].post.responses['503'].description).toMatch(/^`EMAIL_UNAVAILABLE`/);
  });

  it('saves nothing if the invitation email cannot be sent, so the admin can simply retry', async () => {
    const failing: Mailer = { enabled: true, send: async () => { throw new Error('SMTP down'); } };
    const broken = await setupTestApp({}, { mailer: failing });
    try {
      const owner = await registerOrg(broken.app, 'Broken Mail Org');
      const email = uniqueEmail('retry');
      const res = await owner.as('post', '/users').send({ email, name: 'Retry', role: 'viewer' }).expect(502);
      expect(res.body.error.code).toBe('EMAIL_FAILED');
      expect(await broken.db.select().from(users).where(eq(users.email, email))).toHaveLength(0);
    } finally {
      await broken.close();
    }
  });

  it('refuses email features up front and still allows initial passwords', async () => {
    const disabled = await setupTestApp({}, { mailer: { enabled: false, send: async () => { throw new Error('unreachable'); } } });
    try {
      const owner = await registerOrg(disabled.app, 'No Mail Org');
      const res = await owner.as('post', '/users').send({ email: uniqueEmail(), name: 'Invitee', role: 'viewer' }).expect(503);
      expect(res.body.error.message).toBe('Email is not configured on this server, so invitations cannot be sent. Set an initial password instead.');
      await owner.as('post', '/users').send({ email: uniqueEmail(), name: 'Direct', role: 'viewer', password: 'Initial-pass-1' }).expect(201);
      await request(disabled.app).post('/api/v1/auth/forgot-password').send({ email: 'someone@example.com' }).expect(503);
    } finally {
      await disabled.close();
    }
  });
});

describe('password reset', () => {
  let email: string;
  let user: Session;

  beforeAll(async () => {
    email = uniqueEmail('forgetful');
    await admin.as('post', '/users').send({ email, name: 'Forgetful', role: 'sales', password: 'Original-pass-1' }).expect(201);
    const res = await login(email, 'Original-pass-1').expect(200);
    user = { ...admin, token: res.body.token, userId: res.body.user.id };
  });

  it('answers the same for unknown, invited and deactivated accounts, and emails none of them', async () => {
    const { email: invited } = await invite();
    const gone = await createUser(ctx.app, admin, 'viewer');
    const goneEmail = (await gone.as('get', '/auth/me').expect(200)).body.user.email;
    await admin.as('delete', `/users/${gone.userId}`).expect(204);
    ctx.outbox.length = 0;

    for (const address of ['nobody@test.example', invited, goneEmail, 'NOBODY@TEST.EXAMPLE']) {
      const res = await api().post('/api/v1/auth/forgot-password').send({ email: address }).expect(202);
      expect(res.body.message).toBe('If an account exists for that email, we have sent a link to reset its password.');
    }
    await settleBackgroundTasks();
    expect(ctx.outbox).toHaveLength(0);
  });

  it('emails a single-use link that sets a new password and signs out every other session', async () => {
    await forgot(email.toUpperCase());
    const message = lastEmailTo(email);
    expect(message.subject).toBe('Reset your B2B Order Management password');
    expect(message.text).toContain('http://app.test/reset-password#token=');
    expect(message.text).toContain('expires in 60 minutes');
    const token = linkToken(message.text);

    const res = await api().post('/api/v1/auth/reset-password').send({ token, password: 'Recovered-pass-1' }).expect(200);
    expect(res.body.user.email).toBe(email);
    await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${res.body.token}`).expect(200);
    const old = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${user.token}`).expect(401);
    expect(old.body.error.message).toBe('Session has been revoked; please sign in again');
    await login(email, 'Original-pass-1').expect(401);
    await login(email, 'Recovered-pass-1').expect(200);

    const reused = await api().post('/api/v1/auth/reset-password').send({ token, password: 'Attacker-pass-1' }).expect(400);
    expect(reused.body.error.code).toBe('INVALID_LINK');
  });

  it("doesn't email a second link within a minute, and the first one keeps working", async () => {
    const address = uniqueEmail('impatient');
    await admin.as('post', '/users').send({ email: address, name: 'Impatient', role: 'viewer', password: 'Original-pass-1' }).expect(201);
    await forgot(address);
    await forgot(address);
    expect(ctx.outbox.filter((e) => e.to === address)).toHaveLength(1);
    const token = linkToken(lastEmailTo(address).text);
    await api().post('/api/v1/auth/reset-password').send({ token, password: 'Recovered-pass-1' }).expect(200);
  });

  it('replaces an older link when a new one is sent, and rejects expired links', async () => {
    const address = uniqueEmail('twice');
    const created = await admin.as('post', '/users').send({ email: address, name: 'Twice', role: 'viewer', password: 'Original-pass-1' }).expect(201);
    await forgot(address);
    const first = linkToken(lastEmailTo(address).text);
    // Age the first link past the resend cooldown.
    await ctx.db.update(userTokens).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(userTokens.userId, created.body.id));
    await forgot(address);
    const second = linkToken(lastEmailTo(address).text);
    expect(second).not.toBe(first);
    await api().post('/api/v1/auth/reset-password').send({ token: first, password: 'Recovered-pass-1' }).expect(400);

    await ctx.db.update(userTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(userTokens.userId, created.body.id));
    await api().post('/api/v1/auth/reset-password').send({ token: second, password: 'Recovered-pass-1' }).expect(400);
  });

  it('validates the new password', async () => {
    const res = await api().post('/api/v1/auth/reset-password').send({ token: 'x'.repeat(43), password: 'short' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('rate limiting', () => {
  it('limits reset requests per IP, counting every request', async () => {
    const limited = await setupTestApp({ AUTH_RATE_LIMIT_MAX: 2 });
    try {
      for (let i = 0; i < 2; i++) await request(limited.app).post('/api/v1/auth/forgot-password').send({ email: 'a@test.example' }).expect(202);
      await request(limited.app).post('/api/v1/auth/forgot-password').send({ email: 'a@test.example' }).expect(429);
      await settleBackgroundTasks();
    } finally {
      await limited.close();
    }
  });
});
