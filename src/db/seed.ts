/**
 * Seeds a demo organization with one user per role, customers and products.
 * Usage: npm run db:seed   (all demo users share the password "Password123!")
 */
import { config } from '../config';
import { hashPassword } from '../lib/password';
import { createPgDatabase } from './client';
import { customers, organizations, products, users, type UserRole } from './schema';

async function seed() {
  const database = createPgDatabase(config.DATABASE_URL);
  await database.migrate();
  const { db } = database;

  const passwordHash = await hashPassword('Password123!');
  await db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name: 'Acme Industrial Supply' }).returning();
    const orgId = org!.id;

    const roles: UserRole[] = ['admin', 'manager', 'sales', 'viewer'];
    await tx.insert(users).values(
      roles.map((role) => ({
        organizationId: orgId,
        email: `${role}@acme.example`,
        name: `Demo ${role[0]!.toUpperCase()}${role.slice(1)}`,
        role,
        passwordHash,
      })),
    );

    await tx.insert(customers).values([
      { organizationId: orgId, companyName: 'Summit Manufacturing Co.', contactName: 'Jane Cooper', email: 'jane@summit.example', paymentTermsDays: 30 },
      { organizationId: orgId, companyName: 'Harbor Logistics LLC', contactName: 'Marcus Reed', email: 'procurement@harbor.example', paymentTermsDays: 45 },
      { organizationId: orgId, companyName: 'Pinecrest Facilities', contactName: 'Priya Shah', email: 'priya@pinecrest.example', paymentTermsDays: 60 },
    ]);

    await tx.insert(products).values([
      { organizationId: orgId, sku: 'BOLT-M8-50', name: 'Hex Bolt M8 x 50mm (box of 100)', unit: 'box', unitPriceCents: 2450 },
      { organizationId: orgId, sku: 'NUT-M8', name: 'Hex Nut M8 (box of 100)', unit: 'box', unitPriceCents: 980 },
      { organizationId: orgId, sku: 'GLOVE-NIT-L', name: 'Nitrile Gloves, Large (case of 1000)', unit: 'case', unitPriceCents: 8900 },
      { organizationId: orgId, sku: 'PALLET-STD', name: 'Standard Wooden Pallet 48x40', unit: 'each', unitPriceCents: 1500 },
    ]);
  });

  console.log('Seeded demo data. Log in as admin@acme.example / Password123!');
  await database.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
