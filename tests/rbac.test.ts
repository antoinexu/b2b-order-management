import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, registerOrg, setupTestApp, type Session } from './helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Session, manager: Session, sales: Session, viewer: Session;
let customerId: string;

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await registerOrg(ctx.app, 'RBAC Org');
  [manager, sales, viewer] = await Promise.all([
    createUser(ctx.app, admin, 'manager'),
    createUser(ctx.app, admin, 'sales'),
    createUser(ctx.app, admin, 'viewer'),
  ]);
  customerId = (await admin.as('post', '/customers').send({ companyName: 'Shared Customer' }).expect(201)).body.id;
});
afterAll(() => ctx.close());

describe('role-based access control', () => {
  it('lets every role read business data', async () => {
    for (const s of [admin, manager, sales, viewer]) {
      await s.as('get', '/customers').expect(200);
      await s.as('get', '/orders').expect(200);
    }
  });

  it('blocks viewers from any write', async () => {
    const res = await viewer.as('post', '/customers').send({ companyName: 'X' }).expect(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Missing permission: customers:write' });
    await viewer.as('post', '/quotes').send({}).expect(403);
  });

  it('lets sales manage customers but not the catalog, deletions or fulfilment', async () => {
    await sales.as('post', '/customers').send({ companyName: 'Sales Lead' }).expect(201);
    await sales.as('post', '/products').send({ sku: 'X', name: 'X', unitPriceCents: 1 }).expect(403);
    await sales.as('delete', `/customers/${customerId}`).expect(403);
    await sales.as('post', `/orders/00000000-0000-4000-8000-000000000000/status`).send({ status: 'confirmed' }).expect(403);
  });

  it('restricts user management to admins', async () => {
    await manager.as('get', '/users').expect(200);
    await manager.as('post', '/users').send({}).expect(403);
    await sales.as('get', '/users').expect(403);
  });

  it('applies role changes immediately without re-login', async () => {
    const user = await createUser(ctx.app, admin, 'viewer');
    await user.as('post', '/customers').send({ companyName: 'Before' }).expect(403);
    await admin.as('patch', `/users/${user.userId}`).send({ role: 'sales' }).expect(200);
    await user.as('post', '/customers').send({ companyName: 'After' }).expect(201);
  });

  it('prevents admins from locking themselves out', async () => {
    await admin.as('patch', `/users/${admin.userId}`).send({ role: 'viewer' }).expect(400);
    await admin.as('delete', `/users/${admin.userId}`).expect(400);
  });
});

describe('tenant isolation', () => {
  it('hides other organizations\' records and treats them as not found', async () => {
    const other = await registerOrg(ctx.app, 'Other Org');

    const list = await other.as('get', '/customers').expect(200);
    expect(list.body.meta.total).toBe(0);

    await other.as('get', `/customers/${customerId}`).expect(404);
    await other.as('patch', `/customers/${customerId}`).send({ companyName: 'Hijacked' }).expect(404);
    await other.as('delete', `/customers/${customerId}`).expect(404);
    await other.as('patch', `/users/${sales.userId}`).send({ role: 'admin' }).expect(404);

    const stillThere = await admin.as('get', `/customers/${customerId}`).expect(200);
    expect(stillThere.body.companyName).toBe('Shared Customer');
  });

  it('refuses to quote another organization\'s customer or product', async () => {
    const other = await registerOrg(ctx.app, 'Other Org 2');
    await other.as('post', '/quotes')
      .send({ customerId, items: [{ description: 'X', quantity: 1, unitPriceCents: 100 }] })
      .expect(404);

    const product = (await admin.as('post', '/products').send({ sku: 'ISO-1', name: 'Iso', unitPriceCents: 100 }).expect(201)).body;
    const otherCustomer = (await other.as('post', '/customers').send({ companyName: 'Mine' }).expect(201)).body;
    const res = await other.as('post', '/quotes')
      .send({ customerId: otherCustomer.id, items: [{ productId: product.id, quantity: 1 }] })
      .expect(400);
    expect(res.body.error.message).toContain('productId does not exist');
  });
});
