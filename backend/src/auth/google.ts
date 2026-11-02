import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { env, googleOAuthConfigured, googleRedirectUri } from '../config/env.js';
import { db } from '../db/client.js';
import { users, type User } from '../db/schema.js';
import { badRequest, failedDependency } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { signState, verifyState } from './jwt.js';

const log = logger.child({ mod: 'auth:google' });

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * Real Google OAuth 2.0 authorization-code flow.
 *
 * The code exchange happens server-side so the client secret never reaches the
 * browser, and the resulting session is set as an httpOnly cookie rather than
 * handed to JavaScript. We request only `openid email profile` -- the minimum
 * needed to show name/email/avatar in the header.
 */

export async function buildAuthUrl(redirectAfter?: string): Promise<string> {
  if (!googleOAuthConfigured) {
    throw failedDependency(
      'Google login is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env.',
    );
  }
  const state = await signState({ nonce: randomUUID(), redirect: redirectAfter }, '10m');
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!);
  url.searchParams.set('redirect_uri', googleRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  // Keeps repeat logins friction-free while still returning a fresh id token.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

interface GoogleTokenResponse {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  picture?: string;
}

/** Exchanges the code, upserts the user, and returns the local user row. */
export async function completeLogin(
  code: string,
  state: string,
): Promise<{ user: User; redirect?: string }> {
  const claims = await verifyState(state).catch(() => null);
  if (!claims) throw badRequest('Invalid or expired OAuth state');

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: googleRedirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = (await tokenRes.json()) as GoogleTokenResponse;
  if (!tokenRes.ok || !tokens.access_token) {
    log.warn({ error: tokens.error, description: tokens.error_description }, 'token exchange failed');
    throw badRequest(`Google rejected the login: ${tokens.error ?? 'unknown_error'}`);
  }

  const infoRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) throw badRequest('Could not read the Google profile');
  const profile = (await infoRes.json()) as GoogleUserInfo;

  if (!profile.email) throw badRequest('Google account has no email address');
  if (profile.email_verified === false) throw badRequest('Google email is not verified');

  const user = await upsertUser({
    googleSub: profile.sub,
    email: profile.email.toLowerCase(),
    name: profile.name ?? profile.given_name ?? profile.email.split('@')[0]!,
    avatarUrl: profile.picture ?? null,
  });

  log.info({ userId: user.id, email: user.email }, 'google login succeeded');
  return { user, redirect: claims.redirect };
}

/**
 * Upsert keyed on email.
 *
 * Email is the natural identity here, and keying on it means a user who
 * previously existed (e.g. created by the sender-seed script) is adopted rather
 * than duplicated -- the unique constraint on email would otherwise reject the
 * insert outright.
 */
export async function upsertUser(input: {
  googleSub?: string | null;
  email: string;
  name: string;
  avatarUrl?: string | null;
}): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({
      googleSub: input.googleSub ?? null,
      email: input.email,
      name: input.name,
      avatarUrl: input.avatarUrl ?? null,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        name: input.name,
        avatarUrl: input.avatarUrl ?? null,
        googleSub: input.googleSub ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) throw new Error('user upsert returned no row');
  return row;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}
