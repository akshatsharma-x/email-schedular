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
    //
    // The same lookup supplies the profile. The token proves *who* this is, but
    // its name/email claims are frozen at sign-in, so reading them made a
    // renamed account keep showing its old name until the session expired.
    const profile = await loadProfile(claims.sub);
    if (!profile) {
      next();
      return;
    }

    req.user = profile;
  } catch {
    // An expired or tampered cookie is treated as "not logged in" rather than an
    // error, so a stale tab just gets redirected to the login screen.
  }
  next();
}

/**
 * Profile lookup with a short TTL cache.
 *
 * This runs on every authenticated request, so it is cached to keep the hot path
 * off the database. 30 seconds is how long a just-deleted account can still act,
 * or a renamed one still shows its old name -- acceptable, because this exists to
 * stop a stale session producing 500s and stale headers, not to be a revocation
 * mechanism.
 */
const PROFILE_TTL_MS = 30_000;
const profileCache = new Map<string, { user: AuthUser; at: number }>();

async function loadProfile(userId: string): Promise<AuthUser | null> {
  const cached = profileCache.get(userId);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.user;

  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    profileCache.delete(userId);
    return null;
  }

  const user: AuthUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.avatarUrl ?? undefined,
  };
  // Bound the cache so a long-running process cannot grow it without limit.
  if (profileCache.size > 10_000) profileCache.clear();
  profileCache.set(userId, { user, at: Date.now() });
  return user;
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
