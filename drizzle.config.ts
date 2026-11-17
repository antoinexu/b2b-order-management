import { defineConfig } from 'drizzle-kit';
import './src/env';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://b2b:b2b@localhost:5432/b2b' },
});
