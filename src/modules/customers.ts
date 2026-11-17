import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { Router } from 'express';
import type { DB } from '../db/client';
import { customers } from '../db/schema';
import { notFound } from '../lib/errors';
import { doc } from '../lib/openapi';
import { IdParams, paginated, PaginationQuery, z } from '../lib/zod';
import { auth, requirePermission } from '../middleware/auth';

const optionalText = (max = 500) => z.string().trim().max(max).nullish();

const CustomerFields = {
  companyName: z.string().trim().min(1).max(200),
  contactName: optionalText(200),
  email: z.email().nullish(),
  phone: optionalText(50),
  billingAddress: optionalText(),
  shippingAddress: optionalText(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  notes: optionalText(2000),
};

const CreateCustomerBody = z.object(CustomerFields).openapi('CreateCustomerRequest');
const UpdateCustomerBody = z.object(CustomerFields).partial().openapi('UpdateCustomerRequest');
const CustomerListQuery = PaginationQuery.extend({ q: z.string().trim().min(1).optional() });

export const Customer = z
  .object({
    id: z.uuid(),
    companyName: z.string(),
    contactName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    billingAddress: z.string().nullable(),
    shippingAddress: z.string().nullable(),
    paymentTermsDays: z.number().int(),
    notes: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .openapi('Customer');

const T = 'Customers';
doc({ method: 'get', path: '/customers', tag: T, summary: 'List customers (search by company, contact or email with `q`)', permission: 'customers:read', query: CustomerListQuery, response: paginated(Customer) });
doc({ method: 'post', path: '/customers', tag: T, summary: 'Create a customer', permission: 'customers:write', body: CreateCustomerBody, response: Customer, status: 201 });
doc({ method: 'get', path: '/customers/{id}', tag: T, summary: 'Get a customer', permission: 'customers:read', params: IdParams, response: Customer });
doc({ method: 'patch', path: '/customers/{id}', tag: T, summary: 'Update a customer', permission: 'customers:write', params: IdParams, body: UpdateCustomerBody, response: Customer });
doc({ method: 'delete', path: '/customers/{id}', tag: T, summary: 'Delete a customer with no quotes or orders', permission: 'customers:delete', params: IdParams, status: 204 });

const strip = ({ organizationId: _o, ...rest }: typeof customers.$inferSelect) => rest;

export function customersRouter(db: DB) {
  const router = Router();
  const byId = (orgId: string, id: string) => and(eq(customers.id, id), eq(customers.organizationId, orgId));

  router.get('/', requirePermission('customers:read'), async (req, res) => {
    const { organizationId } = auth(req);
    const { page, pageSize, q } = CustomerListQuery.parse(req.query);
    const term = q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : undefined;
    const where = and(
      eq(customers.organizationId, organizationId),
      term ? or(ilike(customers.companyName, term), ilike(customers.contactName, term), ilike(customers.email, term)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db.select().from(customers).where(where).orderBy(desc(customers.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ n: count() }).from(customers).where(where),
    ]);
    res.json({ data: rows.map(strip), meta: { page, pageSize, total: total?.n ?? 0 } });
  });

  router.post('/', requirePermission('customers:write'), async (req, res) => {
    const { organizationId } = auth(req);
    const body = CreateCustomerBody.parse(req.body);
    const [row] = await db.insert(customers).values({ ...body, organizationId }).returning();
    res.status(201).json(strip(row!));
  });

  router.get('/:id', requirePermission('customers:read'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    const [row] = await db.select().from(customers).where(byId(organizationId, id));
    if (!row) throw notFound('Customer');
    res.json(strip(row));
  });

  router.patch('/:id', requirePermission('customers:write'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    const body = UpdateCustomerBody.parse(req.body);
    const [row] = await db.update(customers).set(body).where(byId(organizationId, id)).returning();
    if (!row) throw notFound('Customer');
    res.json(strip(row));
  });

  // FK `restrict` on quotes/orders turns deletion of an active customer into a 409.
  router.delete('/:id', requirePermission('customers:delete'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    const deleted = await db.delete(customers).where(byId(organizationId, id)).returning({ id: customers.id });
    if (deleted.length === 0) throw notFound('Customer');
    res.status(204).end();
  });

  return router;
}
