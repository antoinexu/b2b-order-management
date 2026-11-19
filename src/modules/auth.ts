import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config';
import type { DB } from '../db/client';
import { organizations, users, USER_ROLES } from '../db/schema';
import { runInBackground } from '../lib/background';
import { badRequest, conflict, emailUnavailable, invalidLink, notFound, unauthorized } from '../lib/errors';
import { canonicalTimeZone, isValidTimeZone } from '../lib/dates';
import { passwordResetEmail } from '../lib/emails';
import type { Mailer } from '../lib/mailer';
import { doc, EMAIL_UNAVAILABLE } from '../lib/openapi';
import { hashPassword, verifyPassword } from '../lib/password';
import { ROLE_PERMISSIONS } from '../lib/permissions';
import { z } from '../lib/zod';
import { auth, signToken } from '../middleware/auth';
import { authRateLimiter } from '../middleware/rate-limit';
import { consumeUserToken, findUserToken, issueUserToken, liveTokenIssuedAt, LinkToken, PASSWORD_RESET_TTL_MINUTES } from './user-tokens';

/** Hash of a random throwaway password, verified against when the email is unknown. */
const dummyPasswordHash = hashPassword(randomBytes(32).toString('hex'));

export const Email = z.email().transform((e) => e.toLowerCase());
export const Password = z.string().min(8, 'Password must be at least 8 characters').max(128);
export const TimeZone = z
  .string()
  .trim()
  .max(64)
  .refine(isValidTimeZone, 'Must be an IANA time zone such as America/New_York')
  .transform(canonicalTimeZone)
  .openapi({ example: 'America/New_York', description: 'IANA time zone; quote validity dates end at midnight in this zone' });

export const MaxDiscountBps = z.number().int().min(0).max(10_000).openapi({
  description: 'Largest effective discount off the catalog price, in bps, for users without pricing:override. They cannot add or change custom lines at all.',
});

export const Organization = z
  .object({ id: z.uuid(), name: z.string(), timezone: z.string(), maxDiscountBps: z.number().int(), currency: z.string() })
  .openapi('Organization');

export const PublicUser = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    email: z.string(),
    name: z.string(),
    role: z.enum(USER_ROLES),
    status: z.enum(['active', 'invited']).openapi({ description: '`invited` until the user accepts their emailed invitation' }),
    createdAt: z.date(),
  })
  .openapi('User');

export const toPublicUser = (u: typeof users.$inferSelect): z.infer<typeof PublicUser> => ({
  id: u.id,
  organizationId: u.organizationId,
  email: u.email,
  name: u.name,
  role: u.role,
  status: u.passwordHash === null ? 'invited' : 'active',
  createdAt: u.createdAt,
});

const RegisterBody = z
  .object({
    organizationName: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    email: Email,
    password: Password,
    timezone: TimeZone.default('UTC'),
  })
  .openapi('RegisterRequest');

const LoginBody = z.object({ email: Email, password: z.string().min(1) }).openapi('LoginRequest');

const ChangePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: Password })
  .openapi('ChangePasswordRequest');

const ForgotPasswordBody = z.object({ email: Email }).openapi('ForgotPasswordRequest');
const ResetPasswordBody = z.object({ token: LinkToken, password: Password }).openapi('ResetPasswordRequest');
const InvitationLookupBody = z.object({ token: LinkToken }).openapi('InvitationLookupRequest');
const AcceptInvitationBody = z
  .object({ token: LinkToken, password: Password, name: z.string().trim().min(1).max(200).optional() })
  .openapi('AcceptInvitationRequest');
const Invitation = z
  .object({ email: z.string(), name: z.string(), role: z.enum(USER_ROLES), organizationName: z.string(), expiresAt: z.date() })
  .openapi('Invitation');
const Accepted = z.object({ message: z.string() }).openapi('AcceptedResponse');

const AuthResponse = z.object({ token: z.string(), user: PublicUser }).openapi('AuthResponse');
const MeResponse = z
  .object({ user: PublicUser, organization: Organization, permissions: z.array(z.string()) })
  .openapi('MeResponse');

doc({ method: 'post', path: '/auth/register', tag: 'Auth', summary: 'Create an organization and its first admin user', public: true, body: RegisterBody, response: AuthResponse, status: 201 });
doc({ method: 'post', path: '/auth/login', tag: 'Auth', summary: 'Exchange credentials for a JWT', public: true, body: LoginBody, response: AuthResponse });
doc({ method: 'post', path: '/auth/change-password', tag: 'Auth', summary: 'Change your password. Signs out every other session and returns a fresh token', body: ChangePasswordBody, response: AuthResponse });
doc({ method: 'post', path: '/auth/forgot-password', tag: 'Auth', summary: 'Email a password reset link. Always answers 202, whether or not the email belongs to an account', public: true, body: ForgotPasswordBody, response: Accepted, status: 202, errors: { 503: EMAIL_UNAVAILABLE } });
doc({ method: 'post', path: '/auth/reset-password', tag: 'Auth', summary: 'Set a new password with an emailed reset link. Signs out every session and returns a fresh token', public: true, body: ResetPasswordBody, response: AuthResponse });
doc({ method: 'post', path: '/auth/invitations/lookup', tag: 'Auth', summary: 'Show who an emailed invitation is for, without using it', public: true, body: InvitationLookupBody, response: Invitation });
doc({ method: 'post', path: '/auth/invitations/accept', tag: 'Auth', summary: 'Accept an emailed invitation by choosing a password; returns a token', public: true, body: AcceptInvitationBody, response: AuthResponse });
doc({ method: 'get', path: '/auth/me', tag: 'Auth', summary: 'Current user, organization and effective permissions', response: MeResponse });

/** A second reset request within this window reuses the link already sent instead of emailing another. */
const RESET_EMAIL_COOLDOWN_MS = 60_000;

export function authRouter(db: DB, config: Config, authenticate: RequestHandler, mailer: Mailer) {
  const router = Router();
  const issue = (u: typeof users.$inferSelect) => signToken(u, config.JWT_SECRET, config.JWT_EXPIRES_IN);

  router.post('/register', authRateLimiter(config, { countSuccessful: true }), async (req, res) => {
    const body = RegisterBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);

    const user = await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, body.email));
      if (existing) throw conflict('Email is already registered');
      const [org] = await tx.insert(organizations).values({ name: body.organizationName, timezone: body.timezone }).returning();
      const [created] = await tx
        .insert(users)
        .values({ organizationId: org!.id, email: body.email, name: body.name, passwordHash, role: 'admin' })
        .returning();
      return created!;
    });

    res.status(201).json({ token: issue(user), user: toPublicUser(user) });
  });

  router.post('/login', authRateLimiter(config, { countSuccessful: false }), async (req, res) => {
    const body = LoginBody.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    // Always run scrypt, even for unknown emails, so response time doesn't reveal which emails exist.
    // Combined with the identical error message, this prevents account enumeration.
    // Invited users have no password yet and verify against the dummy hash too.
    const passwordOk = await verifyPassword(body.password, user?.passwordHash ?? (await dummyPasswordHash));
    if (!user || user.deletedAt || !user.passwordHash || !passwordOk) {
      throw unauthorized('Invalid email or password');
    }
    res.json({ token: issue(user), user: toPublicUser(user) });
  });

  // Failed attempts count against the same per-IP limit as logins, so a stolen token can't brute-force the password.
  router.post('/change-password', authRateLimiter(config, { countSuccessful: false }), authenticate, async (req, res) => {
    const { userId } = auth(req);
    const body = ChangePasswordBody.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user?.passwordHash || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
      throw badRequest('Current password is incorrect');
    }
    const passwordHash = await hashPassword(body.newPassword);
    // Bumping the version revokes all existing tokens. Matching the old version makes concurrent changes fail cleanly.
    const [updated] = await db
      .update(users)
      .set({ passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(and(eq(users.id, userId), eq(users.tokenVersion, user.tokenVersion)))
      .returning();
    if (!updated) throw conflict('Your password was changed by another request; please sign in again');
    res.json({ token: issue(updated), user: toPublicUser(updated) });
  });

  // Every request counts, so the endpoint can't be used to flood an inbox from one IP.
  router.post('/forgot-password', authRateLimiter(config, { countSuccessful: true }), async (req, res) => {
    const { email } = ForgotPasswordBody.parse(req.body);
    if (!mailer.enabled) throw emailUnavailable('password reset links cannot be sent. Ask an admin to help you sign in.');
    // Answer before looking the email up, so neither the response nor its timing reveals whether an account exists.
    res.status(202).json({ message: 'If an account exists for that email, we have sent a link to reset its password.' });
    runInBackground(req.log, 'password reset email', async () => {
      const [user] = await db.select().from(users).where(eq(users.email, email));
      // Invited users haven't chosen a password yet; their invitation link is the way in.
      if (!user || user.deletedAt || !user.passwordHash) return;
      const issuedAt = await liveTokenIssuedAt(db, user.id, 'password_reset');
      if (issuedAt && Date.now() - issuedAt.getTime() < RESET_EMAIL_COOLDOWN_MS) return;
      const token = await db.transaction((tx) => issueUserToken(tx, user.id, 'password_reset'));
      await mailer.send(passwordResetEmail({
        to: user.email,
        name: user.name,
        url: `${config.APP_URL}/reset-password#token=${token}`,
        expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
      }));
    });
  });

  router.post('/reset-password', authRateLimiter(config, { countSuccessful: false }), async (req, res) => {
    const body = ResetPasswordBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const user = await db.transaction(async (tx) => {
      const userId = await consumeUserToken(tx, body.token, 'password_reset');
      if (!userId) throw invalidLink();
      // A new password revokes every existing session, including one an attacker may hold.
      const [updated] = await tx.update(users)
        .set({ passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(and(eq(users.id, userId), isNull(users.deletedAt), isNotNull(users.passwordHash)))
        .returning();
      if (!updated) throw invalidLink();
      return updated;
    });
    res.json({ token: issue(user), user: toPublicUser(user) });
  });

  router.post('/invitations/lookup', authRateLimiter(config, { countSuccessful: false }), async (req, res) => {
    const { token } = InvitationLookupBody.parse(req.body);
    const found = await findUserToken(db, token, 'invite');
    if (!found) throw invalidLink();
    const [invitation] = await db
      .select({ email: users.email, name: users.name, role: users.role, organizationName: organizations.name })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(and(eq(users.id, found.userId), isNull(users.deletedAt), isNull(users.passwordHash)));
    if (!invitation) throw invalidLink();
    res.json({ ...invitation, expiresAt: found.expiresAt });
  });

  router.post('/invitations/accept', authRateLimiter(config, { countSuccessful: false }), async (req, res) => {
    const body = AcceptInvitationBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const user = await db.transaction(async (tx) => {
      const userId = await consumeUserToken(tx, body.token, 'invite');
      if (!userId) throw invalidLink();
      // Only a pending invitation can be accepted: not one for a deactivated user or one already accepted.
      const [updated] = await tx.update(users)
        .set({ passwordHash, ...(body.name ? { name: body.name } : {}) })
        .where(and(eq(users.id, userId), isNull(users.deletedAt), isNull(users.passwordHash)))
        .returning();
      if (!updated) throw invalidLink();
      return updated;
    });
    res.json({ token: issue(user), user: toPublicUser(user) });
  });

  router.get('/me', authenticate, async (req, res) => {
    const { userId, organizationId, role } = auth(req);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const [org] = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        timezone: organizations.timezone,
        maxDiscountBps: organizations.maxDiscountBps,
        currency: organizations.currency,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!user || !org) throw notFound('User');
    res.json({ user: toPublicUser(user), organization: org, permissions: [...ROLE_PERMISSIONS[role]] });
  });

  return router;
}
