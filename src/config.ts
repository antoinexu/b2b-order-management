import { z } from 'zod';
import './env';

const DEV_SECRET = 'dev-only-secret-change-me-please-0123456789';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default('postgres://b2b:b2b@localhost:5432/b2b'),
  JWT_SECRET: z.string().trim().min(32, 'JWT_SECRET must be at least 32 characters').default(DEV_SECRET),
  JWT_EXPIRES_IN: z.string().default('8h'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGIN: z.string().default('*'),
  /** Max login failures / registrations per IP within the window. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  /** Number of reverse-proxy hops to trust for the client IP (0 = connect directly). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

const EXAMPLE_SECRETS = new Set([
  DEV_SECRET,
  'change-me-to-a-long-random-string-at-least-32-chars',
  'replace-with-a-long-random-string-of-at-least-32-characters',
]);

export function parseConfig(env: NodeJS.ProcessEnv) {
  const parsed = envSchema.parse(env);
  if (parsed.NODE_ENV === 'production' && EXAMPLE_SECRETS.has(parsed.JWT_SECRET)) {
    throw new Error('JWT_SECRET must be set to a unique secret in production');
  }
  return parsed;
}

export const config = parseConfig(process.env);
export type Config = typeof config;
