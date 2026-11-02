import { Router } from 'express';
import { z } from 'zod';
import { env, googleOAuthConfigured } from '../config/env.js';
import { buildAuthUrl, completeLogin, upsertUser } from '../auth/google.js';
import { sessionCookieOptions, signSession } from '../auth/jwt.js';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { asyncHandler, badRequest, forbidden } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ mod: 'routes:auth' });

export const authRouter = Router();

/**
 * GET /api/auth/config
 * Lets the login screen render the right thing (real Google button vs. a notice
 * that credentials are missing) instead of failing at click time.
 */
authRouter.get('/config', (_req, res) => {
  res.json({
    googleEnabled: googleOAuthConfigured,
    devBypassEnabled: env.DEV_AUTH_BYPASS,
  });
});

/** GET /api/auth/google -- kicks off the real OAuth consent flow. */
authRouter.get(
  '/google',
  asyncHandler(async (req, res) => {
    const redirect = typeof req.query.redirect === 'string' ? req.query.redirect : undefined;
    res.redirect(await buildAuthUrl(redirect));
  }),
);

const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});

/**
 * GET /api/auth/google/callback
 *
 * Ends with a browser redirect (not JSON) because the user arrives here by
 * navigation. Failures redirect back to the login screen with a readable
 * message rather than dumping a stack trace in the address bar.
 */
authRouter.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    const parsed = callbackQuery.parse(req.query);

    if (parsed.error) {
      res.redirect(`${env.FRONTEND_URL}/login?error=${encodeURIComponent(parsed.error)}`);
      return;
    }
    if (!parsed.code || !parsed.state) {
      res.redirect(`${env.FRONTEND_URL}/login?error=missing_code`);
      return;
    }

    try {
      const { user, redirect } = await completeLogin(parsed.code, parsed.state);
      const token = await signSession({
        sub: user.id,
        email: user.email,
        name: user.name,
        picture: user.avatarUrl,
      });
      res.cookie(env.SESSION_COOKIE_NAME, token, sessionCookieOptions);
      const target = redirect?.startsWith('/') ? redirect : '/dashboard';
      res.redirect(`${env.FRONTEND_URL}${target}`);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'google callback failed');
      res.redirect(
        `${env.FRONTEND_URL}/login?error=${encodeURIComponent((err as Error).message)}`,
      );
    }
  }),
);

/**
 * POST /api/auth/dev-login
 *
 * Development affordance so the dashboard, scheduler and rate limiter can be
 * exercised before Google credentials exist. Refuses to run unless
 * DEV_AUTH_BYPASS=true, and env validation refuses to let that be true in
 * production -- so this cannot become an authentication bypass by accident.
 */
const devLoginBody = z.object({
  email: z.string().email().default('adyasha.singh@outbox.local'),
  name: z.string().min(1).default('Adyasha Singh'),
});

authRouter.post(
  '/dev-login',
  asyncHandler(async (req, res) => {
    if (!env.DEV_AUTH_BYPASS) {
      throw forbidden('Dev login is disabled. Set DEV_AUTH_BYPASS=true to enable it locally.');
    }
    const body = devLoginBody.parse(req.body ?? {});
    const user = await upsertUser({
      email: body.email.toLowerCase(),
      name: body.name,
      avatarUrl: null,
    });
    const token = await signSession({
      sub: user.id,
      email: user.email,
      name: user.name,
      picture: user.avatarUrl,
    });
    res.cookie(env.SESSION_COOKIE_NAME, token, sessionCookieOptions);
    log.warn({ email: user.email }, 'dev login used (DEV_AUTH_BYPASS is on)');
    res.json({ user: toPublicUser(user) });
  }),
);

/** GET /api/auth/me -- used by the frontend to hydrate the header. */
authRouter.get('/me', requireAuth, (req, res) => {
  const user = currentUser(req);
  res.json({
    user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.picture ?? null },
  });
});

/** POST /api/auth/logout */
authRouter.post('/logout', (_req, res) => {
  res.clearCookie(env.SESSION_COOKIE_NAME, { ...sessionCookieOptions, maxAge: undefined });
  res.json({ ok: true });
});

function toPublicUser(user: {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}) {
  if (!user.id) throw badRequest('invalid user');
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl };
}
