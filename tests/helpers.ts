import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createApp } from '../src/app';
import { config, type Config } from '../src/config';
import { MIGRATIONS_DIR, type DB } from '../src/db/client';
import * as schema from '../src/db/schema';
import type { UserRole } from '../src/db/schema';

/** Spins up a fresh in-memory Postgres (PGlite), applies real migrations and builds the app. */
export async function setupTestApp(overrides: Partial<Config> = {}) {
  const client = new PGlite();
  const pglite = drizzle(client, { schema });
  await migrate(pglite, { migrationsFolder: MIGRATIONS_DIR });
  const db = pglite as unknown as DB;
  // Suites register many organizations from one IP, so auth rate limiting is relaxed unless a test overrides it.
  const app = createApp({ db, config: { ...config, NODE_ENV: 'test', AUTH_RATE_LIMIT_MAX: 10_000, ...overrides } });
  return { app, db, close: () => client.close() };
}

let seq = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}.${Date.now()}.${++seq}@test.example`;

export interface Session {
  token: string;
  userId: string;
  organizationId: string;
  as: (method: 'get' | 'post' | 'patch' | 'delete', path: string) => request.Test;
}

export function sessionFor(app: App, token: string, userId: string, organizationId: string): Session {
  return {
    token,
    userId,
    organizationId,
    as: (method, path) => request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`),
  };
}

/** Registers a new organization and returns an admin session for it. */
export async function registerOrg(app: App, organizationName = 'Test Org'): Promise<Session> {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ organizationName, name: 'Org Admin', email: uniqueEmail('admin'), password: 'Password123!' })
    .expect(201);
  return sessionFor(app, res.body.token, res.body.user.id, res.body.user.organizationId);
}

/** Creates a user with the given role in the admin's organization and logs them in. */
export async function createUser(app: App, admin: Session, role: UserRole): Promise<Session> {
  const email = uniqueEmail(role);
  await admin.as('post', '/users').send({ email, name: `Test ${role}`, password: 'Password123!', role }).expect(201);
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: 'Password123!' }).expect(200);
  return sessionFor(app, res.body.token, res.body.user.id, res.body.user.organizationId);
}
