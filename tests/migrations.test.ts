import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/db/client';
import * as schema from '../src/db/schema';

it('upgrades an existing database without deleting users or reapplying migrations', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'b2b-migration-'));
  const metaDirectory = path.join(directory, 'meta');
  const sqlFile = path.join(directory, '0000_init.sql');
  const journalFile = path.join(metaDirectory, '_journal.json');
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'));
  mkdirSync(metaDirectory);
  writeFileSync(sqlFile, readFileSync(path.join(MIGRATIONS_DIR, '0000_init.sql')));
  writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  try {
    await migrate(db, { migrationsFolder: directory });
    const org = await client.query<{ id: string }>('INSERT INTO organizations (name) VALUES ($1) RETURNING id', ['Existing Org']);
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (organization_id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [org.rows[0]!.id, 'existing@example.com', 'Existing Admin', 'existing-hash', 'admin'],
    );
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    const migrated = await db.select().from(schema.users);
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ id: user.rows[0]!.id, email: 'existing@example.com', role: 'admin', deletedAt: null });
    const applied = await client.query('SELECT * FROM drizzle.__drizzle_migrations');
    expect(applied.rows).toHaveLength(journal.entries.length);
  } finally {
    await client.close();
    unlinkSync(sqlFile);
    unlinkSync(journalFile);
    rmdirSync(metaDirectory);
    rmdirSync(directory);
  }
});
