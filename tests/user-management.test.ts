import { and, eq, isNull } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { users } from '../src/db/schema';
import { createUser, registerOrg, setupTestApp, uniqueEmail, type Session } from './helpers';

const authGate = vi.hoisted(() => ({
  wait: undefined as ((userId: string) => Promise<void>) | undefined,
  release: undefined as (() => void) | undefined,
}));

// Only delay continuation after the real middleware has authenticated the user. No auth result,
// database read or transaction is mocked: this forces the original race on single-connection PGlite.
vi.mock('../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/auth')>();
  return {
    ...actual,
    authenticate: (...args: Parameters<typeof actual.authenticate>): RequestHandler => {
      const authenticate = actual.authenticate(...args);
      return (req, res, next) => authenticate(req, res, (error?: unknown) => {
        if (error) return next(error);
        if (!authGate.wait) return next();
        void authGate.wait(req.auth!.userId).then(() => next(), next);
      });
    },
  };
});

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(() => ctx.close());
afterEach(() => {
  authGate.release?.();
  authGate.wait = undefined;
  authGate.release = undefined;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function activeAdmins(organizationId: string) {
  return ctx.db.select().from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.role, 'admin'), isNull(users.deletedAt)));
}

describe('administrator preservation', () => {
  it('still allows an admin to demote or deactivate another admin', async () => {
    const first = await registerOrg(ctx.app);
    const second = await createUser(ctx.app, first, 'admin');
    await first.as('patch', `/users/${second.userId}`).send({ role: 'viewer' }).expect(200);
    expect(await activeAdmins(first.organizationId)).toHaveLength(1);
    await first.as('patch', `/users/${second.userId}`).send({ role: 'admin' }).expect(200);
    await first.as('delete', `/users/${second.userId}`).expect(204);
    expect((await activeAdmins(first.organizationId))[0]?.id).toBe(first.userId);
  });

  it.each([
    ['demote', 'demote'],
    ['deactivate', 'deactivate'],
    ['demote', 'deactivate'],
  ] as const)('retains an admin when %s and %s requests both pass initial authentication', async (firstAction, secondAction) => {
    const first = await registerOrg(ctx.app);
    const second = await createUser(ctx.app, first, 'admin');
    const ready = new Set<string>();
    const proceed = deferred();
    authGate.release = proceed.resolve;
    authGate.wait = async (id) => {
      if (id !== first.userId && id !== second.userId) return;
      ready.add(id);
      if (ready.size === 2) proceed.resolve();
      await proceed.promise;
    };
    const change = (actor: Session, target: Session, action: 'demote' | 'deactivate') => action === 'demote'
      ? actor.as('patch', `/users/${target.userId}`).send({ role: 'viewer' })
      : actor.as('delete', `/users/${target.userId}`);
    const responses = await Promise.all([change(first, second, firstAction), change(second, first, secondAction)]);
    expect(responses.filter((r) => r.status === 200 || r.status === 204)).toHaveLength(1);
    const rejected = responses.find((r) => r.status !== 200 && r.status !== 204)!;
    expect([401, 403]).toContain(rejected.status);
    const remaining = await activeAdmins(first.organizationId);
    expect(remaining).toHaveLength(1);
    const survivor = remaining[0]!.id === first.userId ? first : second;
    await survivor.as('post', '/users').send({ email: uniqueEmail('survivor'), name: 'Still manageable', password: 'Password123!', role: 'viewer' }).expect(201);
  });
});

for (const revocation of ['demote', 'deactivate'] as const) {
  describe(`requests authenticated before their actor is ${revocation === 'demote' ? 'demoted' : 'deactivated'}`, () => {
    it.each(['post', 'patch', 'delete'] as const)('rejects a queued %s user mutation without writing', async (method) => {
      const first = await registerOrg(ctx.app);
      const second = await createUser(ctx.app, first, 'admin');
      const target = await createUser(ctx.app, first, 'viewer');
      const authenticated = deferred();
      const proceed = deferred();
      authGate.release = proceed.resolve;
      authGate.wait = async (id) => {
        if (id !== first.userId) return;
        authenticated.resolve();
        await proceed.promise;
      };
      const pending = (method === 'post'
        ? first.as('post', '/users').send({ email: uniqueEmail('queued'), name: 'Must not be created', password: 'Password123!', role: 'admin' })
        : method === 'patch'
          ? first.as('patch', `/users/${target.userId}`).send({ name: 'Must not change', role: 'admin' })
          : first.as('delete', `/users/${target.userId}`)
      ).then((response) => response);
      await authenticated.promise;
      if (revocation === 'demote') await second.as('patch', `/users/${first.userId}`).send({ role: 'viewer' }).expect(200);
      else await second.as('delete', `/users/${first.userId}`).expect(204);
      proceed.resolve();
      expect((await pending).status).toBe(revocation === 'demote' ? 403 : 401);
      const stored = await ctx.db.select().from(users).where(eq(users.organizationId, first.organizationId));
      expect(stored).toHaveLength(3);
      expect(stored.find((u) => u.id === target.userId)).toMatchObject({ name: 'Test viewer', role: 'viewer', deletedAt: null });
      expect((await activeAdmins(first.organizationId))[0]?.id).toBe(second.userId);
    });
  });
}
