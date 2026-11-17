import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, pgErrorCode, PG_FK_VIOLATION, PG_RESTRICT_VIOLATION, PG_UNIQUE_VIOLATION } from '../lib/errors';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  // Malformed JSON body from express.json()
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } });
    return;
  }

  const pgCode = pgErrorCode(err);
  if (pgCode === PG_UNIQUE_VIOLATION) {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'A record with these values already exists' } });
    return;
  }
  if (pgCode === PG_FK_VIOLATION || pgCode === PG_RESTRICT_VIOLATION) {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Record is referenced by other records' } });
    return;
  }

  req.log?.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
};
