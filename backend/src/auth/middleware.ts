import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
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
