import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerOrg, setupTestApp, type Session } from './helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Session;

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await registerOrg(ctx.app);
});
afterAll(() => ctx.close());

describe('customers', () => {
  it('supports create, read, update and delete', async () => {
    const created = await admin.as('post', '/customers')
      .send({ companyName: 'Summit Manufacturing', contactName: 'Jane', email: 'jane@summit.example', paymentTermsDays: 45 })
      .expect(201);
    expect(created.body).toMatchObject({ companyName: 'Summit Manufacturing', paymentTermsDays: 45, phone: null });
    expect(created.body.organizationId).toBeUndefined();

    const id = created.body.id;
    await admin.as('get', `/customers/${id}`).expect(200);
    const updated = await admin.as('patch', `/customers/${id}`).send({ phone: '+1 555 0100' }).expect(200);
    expect(updated.body).toMatchObject({ phone: '+1 555 0100', companyName: 'Summit Manufacturing' });

    await admin.as('delete', `/customers/${id}`).expect(204);
    await admin.as('get', `/customers/${id}`).expect(404);
  });

  it('defaults payment terms to 30 days and validates fields', async () => {
    const res = await admin.as('post', '/customers').send({ companyName: 'Defaults Inc' }).expect(201);
    expect(res.body.paymentTermsDays).toBe(30);
    await admin.as('post', '/customers').send({ companyName: 'Bad', email: 'nope' }).expect(400);
    await admin.as('post', '/customers').send({ companyName: 'Bad', paymentTermsDays: -1 }).expect(400);
    await admin.as('get', '/customers/not-a-uuid').expect(400);
  });

  it('searches and paginates', async () => {
    const org = await registerOrg(ctx.app);
    for (const name of ['Harbor Logistics', 'Harbor Freight Partners', 'Pinecrest Facilities']) {
      await org.as('post', '/customers').send({ companyName: name }).expect(201);
    }
    const search = await org.as('get', '/customers?q=harbor').expect(200);
    expect(search.body.meta.total).toBe(2);

    const page = await org.as('get', '/customers?page=2&pageSize=2').expect(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toEqual({ page: 2, pageSize: 2, total: 3 });

    const literal = await org.as('get', '/customers?q=%25').expect(200);
    expect(literal.body.meta.total).toBe(0);
  });

  it('refuses to delete a customer that has quotes', async () => {
    const customer = (await admin.as('post', '/customers').send({ companyName: 'Has Quotes' }).expect(201)).body;
    await admin.as('post', '/quotes')
      .send({ customerId: customer.id, items: [{ description: 'Service', quantity: 1, unitPriceCents: 1000 }] })
      .expect(201);
    const res = await admin.as('delete', `/customers/${customer.id}`).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

describe('products', () => {
  it('enforces unique SKUs per organization only', async () => {
    await admin.as('post', '/products').send({ sku: 'SKU-1', name: 'Widget', unitPriceCents: 1000 }).expect(201);
    await admin.as('post', '/products').send({ sku: 'SKU-1', name: 'Dup', unitPriceCents: 1000 }).expect(409);

    const other = await registerOrg(ctx.app);
    await other.as('post', '/products').send({ sku: 'SKU-1', name: 'Widget', unitPriceCents: 1000 }).expect(201);
  });

  it('rejects negative or fractional prices', async () => {
    await admin.as('post', '/products').send({ sku: 'NEG', name: 'Neg', unitPriceCents: -1 }).expect(400);
    await admin.as('post', '/products').send({ sku: 'FRAC', name: 'Frac', unitPriceCents: 10.5 }).expect(400);
  });

  it('updates, lists and deletes products', async () => {
    const p = (await admin.as('post', '/products').send({ sku: 'UPD', name: 'Old', unitPriceCents: 500 }).expect(201)).body;
    expect(p.unit).toBe('each');
    const updated = await admin.as('patch', `/products/${p.id}`).send({ name: 'New', unitPriceCents: 750 }).expect(200);
    expect(updated.body).toMatchObject({ name: 'New', unitPriceCents: 750 });
    const list = await admin.as('get', '/products?q=UPD').expect(200);
    expect(list.body.data[0].id).toBe(p.id);
    await admin.as('delete', `/products/${p.id}`).expect(204);
    await admin.as('get', `/products/${p.id}`).expect(404);
  });
});
