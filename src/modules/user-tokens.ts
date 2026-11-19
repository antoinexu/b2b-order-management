import { and, eq, gt, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { userTokens, type UserTokenPurpose } from '../db/schema';
import { z } from '../lib/zod';
import type { DbOrTx } from './line-items';

export const INVITE_TTL_DAYS = 7;
export const PASSWORD_RESET_TTL_MINUTES = 60;
const TTL_MS: Record<UserTokenPurpose, number> = {
  invite: INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
  password_reset: PASSWORD_RESET_TTL_MINUTES * 60 * 1000,
};

/** A token as it appears in an emailed link: 32 random bytes, base64url. */
export const LinkToken = z.string().min(32).max(128).openapi({ description: 'Token from the emailed link' });

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Creates a token for the user, replacing any earlier one with the same purpose, and returns it in plain text. */
export async function issueUserToken(db: DbOrTx, userId: string, purpose: UserTokenPurpose): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.delete(userTokens).where(and(eq(userTokens.userId, userId), eq(userTokens.purpose, purpose)));
  await db.insert(userTokens).values({ userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + TTL_MS[purpose]) });
  return token;
}

const live = (token: string, purpose: UserTokenPurpose) =>
  and(eq(userTokens.tokenHash, hashToken(token)), eq(userTokens.purpose, purpose), gt(userTokens.expiresAt, sql`now()`));

/** Looks a live token up without using it. */
export async function findUserToken(db: DbOrTx, token: string, purpose: UserTokenPurpose) {
  const [row] = await db.select({ userId: userTokens.userId, expiresAt: userTokens.expiresAt }).from(userTokens).where(live(token, purpose));
  return row ?? null;
}

/**
 * Uses up a live token and returns its user. Deleting the row is what makes the token single-use:
 * of two concurrent requests with the same token, only one gets the row back.
 */
export async function consumeUserToken(db: DbOrTx, token: string, purpose: UserTokenPurpose): Promise<string | null> {
  const [row] = await db.delete(userTokens).where(live(token, purpose)).returning({ userId: userTokens.userId });
  return row?.userId ?? null;
}

/** When the user's current token for this purpose was issued, if they have one that is still live. */
export async function liveTokenIssuedAt(db: DbOrTx, userId: string, purpose: UserTokenPurpose): Promise<Date | null> {
  const [row] = await db.select({ createdAt: userTokens.createdAt }).from(userTokens)
    .where(and(eq(userTokens.userId, userId), eq(userTokens.purpose, purpose), gt(userTokens.expiresAt, sql`now()`)));
  return row?.createdAt ?? null;
}

export async function revokeUserTokens(db: DbOrTx, userId: string) {
  await db.delete(userTokens).where(eq(userTokens.userId, userId));
}
