import { eq } from 'drizzle-orm';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { DB } from '../db/client';
import { users, type UserRole } from '../db/schema';
import { forbidden, unauthorized } from '../lib/errors';
import { hasPermission, type Permission } from '../lib/permissions';

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: UserRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

interface TokenPayload {
  sub: string;
  org: string;
}

export function signToken(user: { id: string; organizationId: string }, secret: string, expiresIn: string): string {
  const payload: TokenPayload = { sub: user.id, org: user.organizationId };
  return jwt.sign(payload, secret, { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });
}

/**
 * Verifies the bearer token and loads the user's *current* role from the database,
 * so role changes and user removal take effect immediately rather than at token expiry.
 */
export function authenticate(db: DB, secret: string): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw unauthorized();

    let payload: TokenPayload;
    try {
      payload = jwt.verify(header.slice(7), secret) as TokenPayload;
    } catch {
      throw unauthorized('Invalid or expired token');
    }

    const [user] = await db
      .select({ id: users.id, organizationId: users.organizationId, role: users.role })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);
    if (!user || user.organizationId !== payload.org) throw unauthorized('User no longer exists');

    req.auth = { userId: user.id, organizationId: user.organizationId, role: user.role };
    next();
  };
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw unauthorized();
    if (!hasPermission(req.auth.role, permission)) throw forbidden(`Missing permission: ${permission}`);
    next();
  };
}

/** Returns the auth context; only call from routes mounted behind `authenticate`. */
export function auth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
