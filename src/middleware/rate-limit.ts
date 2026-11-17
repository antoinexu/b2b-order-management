import { rateLimit } from 'express-rate-limit';
import type { Config } from '../config';

type RateLimitConfig = Pick<Config, 'AUTH_RATE_LIMIT_MAX' | 'AUTH_RATE_LIMIT_WINDOW_MS'>;

/**
 * Per-IP limiter for unauthenticated credential endpoints (brute force / signup abuse).
 * In-memory store: fine for a single instance; use a shared store (e.g. Redis) when scaling out.
 */
export function authRateLimiter(config: RateLimitConfig, options: { countSuccessful: boolean }) {
  return rateLimit({
    windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
    limit: config.AUTH_RATE_LIMIT_MAX,
    // For login, only failed attempts count, so legitimate users are never locked out by their own sign-ins.
    skipSuccessfulRequests: !options.countSuccessful,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res, _next, opts) => {
      res.status(opts.statusCode).json({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts, please try again later' },
      });
    },
  });
}
