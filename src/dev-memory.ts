/**
 * Development server backed by an in-memory Postgres (PGlite) preloaded with demo data.
 * No Docker or local Postgres required; all data is lost when the process exits.
 * Usage: npm run dev:memory
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createApp } from './app';
import { config } from './config';
import { MIGRATIONS_DIR, type DB } from './db/client';
import { DEMO_PASSWORD, seedDemoData } from './db/demo-data';
import * as schema from './db/schema';

async function main() {
  const client = new PGlite();
  const pglite = drizzle(client, { schema });
  await migrate(pglite, { migrationsFolder: MIGRATIONS_DIR });
  const db = pglite as unknown as DB;
  await seedDemoData(db);

  createApp({ db, config }).listen(config.PORT, () => {
    console.log(`In-memory API on http://localhost:${config.PORT} (docs: /docs)`);
    console.log(`Demo login: admin@acme.example / ${DEMO_PASSWORD} (also manager@, sales@, viewer@)`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
