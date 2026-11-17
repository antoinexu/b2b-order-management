import { z } from 'zod';

const DEV_SECRET = 'dev-only-secret-change-me-please-0123456789';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default('postgres://b2b:b2b@localhost:5432/b2b'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters').default(DEV_SECRET),
  JWT_EXPIRES_IN: z.string().default('8h'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGIN: z.string().default('*'),
});

const parsed = envSchema.parse(process.env);

if (parsed.NODE_ENV === 'production' && parsed.JWT_SECRET === DEV_SECRET) {
  throw new Error('JWT_SECRET must be set explicitly in production');
}

export const config = parsed;
export type Config = typeof config;
