import { eq } from 'drizzle-orm';
import { Router } from 'express';
import type { DB } from '../db/client';
import { organizations } from '../db/schema';
import { notFound } from '../lib/errors';
import { doc } from '../lib/openapi';
import { z } from '../lib/zod';
import { auth, requirePermission } from '../middleware/auth';
import { MaxDiscountBps, Organization, TimeZone } from './auth';
import { Currency } from './line-items';

const UpdateOrganizationBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    timezone: TimeZone.optional(),
    maxDiscountBps: MaxDiscountBps.optional(),
    currency: Currency.optional().openapi({
      description: 'Base currency the catalog is priced in. Changing it does not convert existing prices.',
    }),
  })
  .refine((fields) => Object.values(fields).some((value) => value !== undefined), 'At least one update field is required')
  .openapi('UpdateOrganizationRequest', { minProperties: 1, description: 'At least one recognized update field is required.' });

doc({ method: 'patch', path: '/organization', tag: 'Organization', summary: "Update the organization's name, time zone, sales discount limit or base currency", permission: 'organization:write', body: UpdateOrganizationBody, response: Organization });

export function organizationRouter(db: DB) {
  const router = Router();

  router.patch('/', requirePermission('organization:write'), async (req, res) => {
    const { organizationId } = auth(req);
    const body = UpdateOrganizationBody.parse(req.body);
    const [org] = await db
      .update(organizations)
      .set(body)
      .where(eq(organizations.id, organizationId))
      .returning({
        id: organizations.id,
        name: organizations.name,
        timezone: organizations.timezone,
        maxDiscountBps: organizations.maxDiscountBps,
        currency: organizations.currency,
      });
    if (!org) throw notFound('Organization');
    res.json(org);
  });

  return router;
}
