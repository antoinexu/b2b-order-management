import { and, asc, count, eq, isNull, ne } from 'drizzle-orm';
import { Router } from 'express';
import type { DB } from '../db/client';
import { organizations, users, USER_ROLES } from '../db/schema';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors';
import { doc } from '../lib/openapi';
import { hashPassword } from '../lib/password';
import { hasPermission } from '../lib/permissions';
import { IdParams, paginated, PaginationQuery, z } from '../lib/zod';
import { auth, requirePermission, type AuthContext } from '../middleware/auth';
import { Email, Password, PublicUser, toPublicUser } from './auth';

const Role = z.enum(USER_ROLES);
const CreateUserBody = z
  .object({ email: Email, name: z.string().trim().min(1).max(200), password: Password, role: Role })
  .openapi('CreateUserRequest');
const UpdateUserBody = z
  .object({ name: z.string().trim().min(1).max(200).optional(), role: Role.optional() })
  .refine((fields) => Object.values(fields).some((value) => value !== undefined), 'At least one update field is required')
  .openapi('UpdateUserRequest', { minProperties: 1, description: 'At least one recognized update field is required.' });

const T = 'Users';
doc({ method: 'get', path: '/users', tag: T, summary: 'List users in the organization', permission: 'users:read', query: PaginationQuery, response: paginated(PublicUser) });
doc({ method: 'post', path: '/users', tag: T, summary: 'Invite a user with a role', permission: 'users:write', body: CreateUserBody, response: PublicUser, status: 201 });
doc({ method: 'patch', path: '/users/{id}', tag: T, summary: "Update a user's name or role, preserving at least one active admin", permission: 'users:write', params: IdParams, body: UpdateUserBody, response: PublicUser });
doc({ method: 'delete', path: '/users/{id}', tag: T, summary: 'Deactivate a user, preserving business history, their email and at least one active admin', permission: 'users:write', params: IdParams, status: 204 });

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
// Rechecks must see commits made while waiting for the organization lock, even if the DB default differs.
const userWriteConfig = { isolationLevel: 'read committed' } as const;

/**
 * All user writes share this lock, so authorization and admin counts cannot race each other.
 * NO KEY UPDATE is enough to serialize user writes and, unlike FOR UPDATE, does not block
 * inserts elsewhere in the organization (their foreign keys take KEY SHARE locks on this row).
 */
async function lockUserManagement(tx: Tx, ctx: AuthContext) {
  const [org] = await tx.select({ id: organizations.id }).from(organizations)
    .where(eq(organizations.id, ctx.organizationId)).for('no key update');
  if (!org) throw notFound('Organization');

  // The middleware may have authenticated this request before another admin revoked its access.
  const [actor] = await tx.select({ role: users.role, deletedAt: users.deletedAt }).from(users)
    .where(and(eq(users.id, ctx.userId), eq(users.organizationId, ctx.organizationId)));
  if (!actor || actor.deletedAt) throw unauthorized('User no longer exists');
  if (!hasPermission(actor.role, 'users:write')) throw forbidden('Missing permission: users:write');
}

async function requireAnotherAdmin(tx: Tx, organizationId: string, excludedId: string) {
  const [other] = await tx.select({ id: users.id }).from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.role, 'admin'), isNull(users.deletedAt), ne(users.id, excludedId)))
    .limit(1);
  if (!other) throw conflict('An organization must retain at least one active admin');
}

export function usersRouter(db: DB) {
  const router = Router();

  router.get('/', requirePermission('users:read'), async (req, res) => {
    const { organizationId } = auth(req);
    const { page, pageSize } = PaginationQuery.parse(req.query);
    const where = and(eq(users.organizationId, organizationId), isNull(users.deletedAt));
    const [rows, [total]] = await Promise.all([
      db.select().from(users).where(where).orderBy(asc(users.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ n: count() }).from(users).where(where),
    ]);
    res.json({ data: rows.map(toPublicUser), meta: { page, pageSize, total: total?.n ?? 0 } });
  });

  router.post('/', requirePermission('users:write'), async (req, res) => {
    const ctx = auth(req);
    const body = CreateUserBody.parse(req.body);
    // Keep the expensive hash outside the organization lock, then recheck authorization inside it.
    const passwordHash = await hashPassword(body.password);
    const user = await db.transaction(async (tx) => {
      await lockUserManagement(tx, ctx);
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, body.email));
      if (existing) throw conflict('Email is already registered');
      const [created] = await tx.insert(users)
        .values({ organizationId: ctx.organizationId, email: body.email, name: body.name, role: body.role, passwordHash })
        .returning();
      return created!;
    }, userWriteConfig);
    res.status(201).json(toPublicUser(user));
  });

  router.patch('/:id', requirePermission('users:write'), async (req, res) => {
    const ctx = auth(req);
    const { organizationId, userId } = ctx;
    const { id } = IdParams.parse(req.params);
    const body = UpdateUserBody.parse(req.body);
    if (id === userId && body.role && body.role !== 'admin') {
      throw badRequest('You cannot remove your own admin role');
    }
    const user = await db.transaction(async (tx) => {
      await lockUserManagement(tx, ctx);
      const where = and(eq(users.id, id), eq(users.organizationId, organizationId), isNull(users.deletedAt));
      const [current] = await tx.select({ role: users.role }).from(users).where(where);
      if (!current) throw notFound('User');
      if (current.role === 'admin' && body.role && body.role !== 'admin') await requireAnotherAdmin(tx, organizationId, id);
      const [updated] = await tx.update(users).set(body).where(where).returning();
      return updated!;
    }, userWriteConfig);
    res.json(toPublicUser(user));
  });

  router.delete('/:id', requirePermission('users:write'), async (req, res) => {
    const ctx = auth(req);
    const { organizationId, userId } = ctx;
    const { id } = IdParams.parse(req.params);
    if (id === userId) throw badRequest('You cannot delete your own account');
    await db.transaction(async (tx) => {
      await lockUserManagement(tx, ctx);
      const where = and(eq(users.id, id), eq(users.organizationId, organizationId), isNull(users.deletedAt));
      const [current] = await tx.select({ role: users.role }).from(users).where(where);
      if (!current) throw notFound('User');
      if (current.role === 'admin') await requireAnotherAdmin(tx, organizationId, id);
      await tx.update(users).set({ deletedAt: new Date() }).where(where);
    }, userWriteConfig);
    res.status(204).end();
  });

  return router;
}
