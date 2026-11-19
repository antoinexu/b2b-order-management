import { z } from 'zod';
import './env';

const DEV_SECRET = 'dev-only-secret-change-me-please-0123456789';

/** Hosts often pass optional settings left blank as empty strings; treat those as unset. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema);

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
  /** Public URL of the web app; invitation and password reset links point here. */
  APP_URL: optional(z.url().default('http://localhost:5173')).transform((url) => url.replace(/\/+$/, '')),
  /**
   * How email is delivered: `resend` (Resend HTTP API), `log` (printed to the log, never sent), `file` (one JSON
   * file per message in MAIL_OUTBOX_DIR, for end-to-end tests) or `none` (email features unavailable).
   * Defaults to `resend` when RESEND_API_KEY is set, otherwise `log` in development and `none` in production.
   */
  MAIL_TRANSPORT: optional(z.enum(['resend', 'log', 'file', 'none']).optional()),
  MAIL_FROM: optional(z.string().trim().min(3).default('B2B Orders <onboarding@resend.dev>')),
  RESEND_API_KEY: optional(z.string().trim().min(1).optional()),
  MAIL_OUTBOX_DIR: optional(z.string().trim().min(1).optional()),
});

const EXAMPLE_SECRETS = new Set([
  DEV_SECRET,
  'change-me-to-a-long-random-string-at-least-32-chars',
  'replace-with-a-long-random-string-of-at-least-32-characters',
]);

export function parseConfig(env: NodeJS.ProcessEnv) {
  const parsed = envSchema.parse(env);
  const production = parsed.NODE_ENV === 'production';
  if (production && EXAMPLE_SECRETS.has(parsed.JWT_SECRET)) {
    throw new Error('JWT_SECRET must be set to a unique secret in production');
  }
  const MAIL_TRANSPORT = parsed.MAIL_TRANSPORT ?? (parsed.RESEND_API_KEY ? 'resend' : production ? 'none' : 'log');
  if (MAIL_TRANSPORT === 'resend' && !parsed.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required when MAIL_TRANSPORT=resend');
  if (MAIL_TRANSPORT === 'file' && !parsed.MAIL_OUTBOX_DIR) throw new Error('MAIL_OUTBOX_DIR is required when MAIL_TRANSPORT=file');
  // Links in real emails must not point at a developer's machine.
  if (production && MAIL_TRANSPORT !== 'none' && !env.APP_URL) {
    throw new Error('APP_URL must be set in production so emailed links point at the web app');
  }
  return { ...parsed, MAIL_TRANSPORT };
}

export const config = parseConfig(process.env);
export type Config = typeof config;
