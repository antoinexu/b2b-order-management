import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import path from 'node:path';
import { Pool } from 'pg';
import * as schema from './schema';

/** Driver-agnostic database handle: node-postgres at runtime, PGlite in tests. */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

export function createPgDatabase(connectionString: string) {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return {
    db: db as unknown as DB,
    migrate: () => migrate(db, { migrationsFolder: MIGRATIONS_DIR }),
    close: () => pool.end(),
  };
}
