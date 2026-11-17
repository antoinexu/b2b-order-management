import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { Router } from 'express';
import type { DB } from '../db/client';
import { users, USER_ROLES } from '../db/schema';
import { badRequest, conflict, notFound } from '../lib/errors';
import { doc } from '../lib/openapi';
import { hashPassword } from '../lib/password';
import { IdParams, paginated, PaginationQuery, z } from '../lib/zod';
import { auth, requirePermission } from '../middleware/auth';
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
doc({ method: 'patch', path: '/users/{id}', tag: T, summary: "Update a user's name or role", permission: 'users:write', params: IdParams, body: UpdateUserBody, response: PublicUser });
doc({ method: 'delete', path: '/users/{id}', tag: T, summary: 'Deactivate a user and revoke access, preserving business history and reserving their email', permission: 'users:write', params: IdParams, status: 204 });

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
    const { organizationId } = auth(req);
    const body = CreateUserBody.parse(req.body);
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (existing) throw conflict('Email is already registered');
    const [user] = await db
      .insert(users)
      .values({ organizationId, email: body.email, name: body.name, role: body.role, passwordHash: await hashPassword(body.password) })
      .returning();
    res.status(201).json(toPublicUser(user!));
  });

  router.patch('/:id', requirePermission('users:write'), async (req, res) => {
    const { organizationId, userId } = auth(req);
    const { id } = IdParams.parse(req.params);
    const body = UpdateUserBody.parse(req.body);
    if (id === userId && body.role && body.role !== 'admin') {
      throw badRequest('You cannot remove your own admin role');
    }
    const [user] = await db
      .update(users)
      .set(body)
      .where(and(eq(users.id, id), eq(users.organizationId, organizationId), isNull(users.deletedAt)))
      .returning();
    if (!user) throw notFound('User');
    res.json(toPublicUser(user));
  });

  router.delete('/:id', requirePermission('users:write'), async (req, res) => {
    const { organizationId, userId } = auth(req);
    const { id } = IdParams.parse(req.params);
    if (id === userId) throw badRequest('You cannot delete your own account');
    const deleted = await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(and(eq(users.id, id), eq(users.organizationId, organizationId), isNull(users.deletedAt)))
      .returning({ id: users.id });
    if (deleted.length === 0) throw notFound('User');
    res.status(204).end();
  });

  return router;
}
