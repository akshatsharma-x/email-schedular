import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { unauthorized } from '../lib/errors.js';
import { verifySession } from './jwt.js';

/**
 * Attaches the authenticated principal to the request.
 *
 * Every data route goes through `requireAuth`, and every query downstream is
 * scoped by `req.user.id`. Tenant isolation is enforced here and in the SQL --
 * never by trusting an id from the request body.
 */

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  picture?: string | undefined;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export async function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (!token) {
    next();
    return;
  }
  try {
    const claims = await verifySession(token);

    // A valid signature is not enough: the subject must still exist.
    //
    // Sessions are stateless JWTs, so a cookie outlives the row it points at --
    // after the account is deleted (or the database is reset between
    // environments) the token still verifies. Without this check the app looks
    // logged in and then fails every write with a foreign-key violation
    // surfaced as a 500, which is impossible for the user to act on. Returning
    // "not logged in" instead sends them to the login screen, which is the
    // thing that actually fixes it.
    if (!(await userExists(claims.sub))) {
      next();
      return;
    }

    req.user = {
      id: claims.sub,
      email: claims.email,
      name: claims.name,
      picture: claims.picture,
    };
  } catch {
    // An expired or tampered cookie is treated as "not logged in" rather than an
    // error, so a stale tab just gets redirected to the login screen.
  }
  next();
}

/**
 * Existence check with a short TTL cache.
 *
 * This runs on every authenticated request, so it is cached to keep the hot path
 * off the database. 30 seconds is the window in which a just-deleted account can
 * still act -- acceptable, because the check exists to stop a *stale* session
 * from producing 500s, not to be a revocation mechanism.
 */
const EXISTS_TTL_MS = 30_000;
const existsCache = new Map<string, number>();

async function userExists(userId: string): Promise<boolean> {
  const cachedAt = existsCache.get(userId);
  if (cachedAt && Date.now() - cachedAt < EXISTS_TTL_MS) return true;

  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    existsCache.delete(userId);
    return false;
  }
  existsCache.set(userId, Date.now());
  // Bound the cache so a long-running process cannot grow it without limit.
  if (existsCache.size > 10_000) existsCache.clear();
  return true;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(unauthorized());
    return;
  }
  next();
}

/** Narrowing helper for route handlers that run behind `requireAuth`. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
