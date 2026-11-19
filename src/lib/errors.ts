export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (resource: string) => new AppError(404, 'NOT_FOUND', `${resource} not found`);
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
export const invalidState = (message: string) => new AppError(409, 'INVALID_STATE', message);
export const quoteChangedLink = () =>
  new AppError(410, 'QUOTE_CHANGED', 'This quote was changed after this email was sent, so its link no longer works. Ask the sender for the current version.');
export const invalidLink = () =>
  new AppError(400, 'INVALID_LINK', 'This link is invalid, has expired or was already used. Ask for a new one.');
export const emailUnavailable = (consequence: string) =>
  new AppError(503, 'EMAIL_UNAVAILABLE', `Email is not configured on this server, so ${consequence}`);
export const emailFailed = () =>
  new AppError(502, 'EMAIL_FAILED', 'The email could not be sent, so nothing was saved. Please try again.');

/** Extracts a Postgres SQLSTATE code from driver errors (node-postgres, PGlite, or Drizzle-wrapped). */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 3; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FK_VIOLATION = '23503';
export const PG_RESTRICT_VIOLATION = '23001';
