import { and, asc, count, eq, ilike, or } from 'drizzle-orm';
import { Router } from 'express';
import type { DB } from '../db/client';
import { products } from '../db/schema';
import { notFound } from '../lib/errors';
import { doc } from '../lib/openapi';
import { IdParams, paginated, PaginationQuery, z } from '../lib/zod';
import { auth, requirePermission } from '../middleware/auth';

const ProductFields = {
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  unit: z.string().trim().min(1).max(20).optional(),
  unitPriceCents: z.number().int().min(0),
};

const CreateProductBody = z.object(ProductFields).openapi('CreateProductRequest');
const UpdateProductBody = z.object(ProductFields).partial().openapi('UpdateProductRequest');
const ProductListQuery = PaginationQuery.extend({ q: z.string().trim().min(1).optional() });

const Product = z
  .object({
    id: z.uuid(),
    sku: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    unit: z.string(),
    unitPriceCents: z.number().int(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .openapi('Product');

const T = 'Products';
doc({ method: 'get', path: '/products', tag: T, summary: 'List catalog products (search by SKU or name with `q`)', permission: 'products:read', query: ProductListQuery, response: paginated(Product) });
doc({ method: 'post', path: '/products', tag: T, summary: 'Create a product', permission: 'products:write', body: CreateProductBody, response: Product, status: 201 });
doc({ method: 'get', path: '/products/{id}', tag: T, summary: 'Get a product', permission: 'products:read', params: IdParams, response: Product });
doc({ method: 'patch', path: '/products/{id}', tag: T, summary: 'Update a product', permission: 'products:write', params: IdParams, body: UpdateProductBody, response: Product });
doc({ method: 'delete', path: '/products/{id}', tag: T, summary: 'Delete a product (existing line items keep their snapshot)', permission: 'products:write', params: IdParams, status: 204 });

const strip = ({ organizationId: _o, ...rest }: typeof products.$inferSelect) => rest;

export function productsRouter(db: DB) {
  const router = Router();
  const byId = (orgId: string, id: string) => and(eq(products.id, id), eq(products.organizationId, orgId));

  router.get('/', requirePermission('products:read'), async (req, res) => {
    const { organizationId } = auth(req);
    const { page, pageSize, q } = ProductListQuery.parse(req.query);
    const term = q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : undefined;
    const where = and(
      eq(products.organizationId, organizationId),
      term ? or(ilike(products.sku, term), ilike(products.name, term)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db.select().from(products).where(where).orderBy(asc(products.sku)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ n: count() }).from(products).where(where),
    ]);
    res.json({ data: rows.map(strip), meta: { page, pageSize, total: total?.n ?? 0 } });
  });

  router.post('/', requirePermission('products:write'), async (req, res) => {
    const { organizationId } = auth(req);
    const body = CreateProductBody.parse(req.body);
    const [row] = await db.insert(products).values({ ...body, organizationId }).returning();
    res.status(201).json(strip(row!));
  });

  router.get('/:id', requirePermission('products:read'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    const [row] = await db.select().from(products).where(byId(organizationId, id));
    if (!row) throw notFound('Product');
    res.json(strip(row));
  });

  router.patch('/:id', requirePermission('products:write'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    const body = UpdateProductBody.parse(req.body);
    const [row] = await db.update(products).set(body).where(byId(organizationId, id)).returning();
    if (!row) throw notFound('Product');
    res.json(strip(row));
  });

  router.delete('/:id', requirePermission('products:write'), async (req, res) => {
    const { organizationId } = auth(req);
    const { id } = IdParams.parse(req.params);
    const deleted = await db.delete(products).where(byId(organizationId, id)).returning({ id: products.id });
    if (deleted.length === 0) throw notFound('Product');
    res.status(204).end();
  });

  return router;
}
