import { eq } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import type { Config } from '../config';
import type { DB } from '../db/client';
import { organizations, users, USER_ROLES } from '../db/schema';
import { conflict, notFound, unauthorized } from '../lib/errors';
import { doc } from '../lib/openapi';
import { hashPassword, verifyPassword } from '../lib/password';
import { ROLE_PERMISSIONS } from '../lib/permissions';
import { z } from '../lib/zod';
import { auth, signToken } from '../middleware/auth';

export const Email = z.email().transform((e) => e.toLowerCase());
export const Password = z.string().min(8, 'Password must be at least 8 characters').max(128);

export const PublicUser = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    email: z.string(),
    name: z.string(),
    role: z.enum(USER_ROLES),
    createdAt: z.date(),
  })
  .openapi('User');

export const toPublicUser = (u: typeof users.$inferSelect): z.infer<typeof PublicUser> => ({
  id: u.id,
  organizationId: u.organizationId,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.createdAt,
});

const RegisterBody = z
  .object({
    organizationName: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    email: Email,
    password: Password,
  })
  .openapi('RegisterRequest');

const LoginBody = z.object({ email: Email, password: z.string().min(1) }).openapi('LoginRequest');

const AuthResponse = z.object({ token: z.string(), user: PublicUser }).openapi('AuthResponse');
const MeResponse = z
  .object({ user: PublicUser, organization: z.object({ id: z.uuid(), name: z.string() }), permissions: z.array(z.string()) })
  .openapi('MeResponse');

doc({ method: 'post', path: '/auth/register', tag: 'Auth', summary: 'Create an organization and its first admin user', public: true, body: RegisterBody, response: AuthResponse, status: 201 });
doc({ method: 'post', path: '/auth/login', tag: 'Auth', summary: 'Exchange credentials for a JWT', public: true, body: LoginBody, response: AuthResponse });
doc({ method: 'get', path: '/auth/me', tag: 'Auth', summary: 'Current user, organization and effective permissions', response: MeResponse });

export function authRouter(db: DB, config: Config, authenticate: RequestHandler) {
  const router = Router();
  const issue = (u: typeof users.$inferSelect) => signToken(u, config.JWT_SECRET, config.JWT_EXPIRES_IN);

  router.post('/register', async (req, res) => {
    const body = RegisterBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);

    const user = await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, body.email));
      if (existing) throw conflict('Email is already registered');
      const [org] = await tx.insert(organizations).values({ name: body.organizationName }).returning();
      const [created] = await tx
        .insert(users)
        .values({ organizationId: org!.id, email: body.email, name: body.name, passwordHash, role: 'admin' })
        .returning();
      return created!;
    });

    res.status(201).json({ token: issue(user), user: toPublicUser(user) });
  });

  router.post('/login', async (req, res) => {
    const body = LoginBody.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    // Same error for unknown email and wrong password to avoid account enumeration.
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw unauthorized('Invalid email or password');
    }
    res.json({ token: issue(user), user: toPublicUser(user) });
  });

  router.get('/me', authenticate, async (req, res) => {
    const { userId, organizationId, role } = auth(req);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const [org] = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!user || !org) throw notFound('User');
    res.json({ user: toPublicUser(user), organization: org, permissions: [...ROLE_PERMISSIONS[role]] });
  });

  return router;
}
