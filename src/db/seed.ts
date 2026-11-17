/**
 * Seeds a demo organization into the database at DATABASE_URL.
 * Usage: npm run db:seed   (all demo users share the password "Password123!")
 */
import { config } from '../config';
import { createPgDatabase } from './client';
import { DEMO_PASSWORD, seedDemoData } from './demo-data';

async function seed() {
  const database = createPgDatabase(config.DATABASE_URL);
  await database.migrate();
  const inserted = await seedDemoData(database.db);
  console.log(inserted
    ? `Seeded demo data. Log in as admin@acme.example / ${DEMO_PASSWORD}`
    : 'Demo data already present, nothing to do.');
  await database.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
