import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env.js';

/**
 * Session tokens and OAuth state tokens, both HMAC-signed with JWT_SECRET.
 *
 * Sessions are stateless JWTs delivered in an httpOnly cookie: the token is
 * never readable from JavaScript, so an XSS bug cannot exfiltrate it. The
 * trade-off is that logout is client-side only (the cookie is cleared) -- with a
 * 7-day default TTL that is an acceptable shape for this service; a revocation
 * list would be the next step for a real deployment.
 */

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = 'outbox-scheduler';
const SESSION_AUDIENCE = 'session';
const STATE_AUDIENCE = 'oauth-state';

export interface SessionClaims extends JWTPayload {
  sub: string;
  email: string;
  name: string;
  picture?: string | undefined;
}

export async function signSession(claims: {
  sub: string;
  email: string;
  name: string;
  picture?: string | null;
}): Promise<string> {
  return new SignJWT({
    email: claims.email,
    name: claims.name,
    picture: claims.picture ?? undefined,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.SESSION_TTL_HOURS}h`)
    .sign(secret);
}

export async function verifySession(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: SESSION_AUDIENCE,
  });
  if (!payload.sub) throw new Error('session token has no subject');
  return payload as SessionClaims;
}

/**
 * Short-lived signed token used as the OAuth `state` parameter, for both Google
 * and Slack. Signing it means the callback needs no server-side session store
 * while still being CSRF-resistant.
 */
export async function signState(
  claims: { sub?: string; nonce: string; redirect?: string },
  ttl: string,
): Promise<string> {
  const jwt = new SignJWT({ nonce: claims.nonce, redirect: claims.redirect })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(STATE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ttl);
  if (claims.sub) jwt.setSubject(claims.sub);
  return jwt.sign(secret);
}

export async function verifyState(
  token: string,
): Promise<{ sub?: string; nonce: string; redirect?: string }> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: STATE_AUDIENCE,
  });
  return {
    sub: payload.sub,
    nonce: String(payload.nonce),
    redirect: payload.redirect ? String(payload.redirect) : undefined,
  };
}

export const sessionCookieOptions = {
  httpOnly: true,
  // Lax still sends the cookie on same-site XHR; localhost:3000 -> localhost:4000
  // is same-site (ports are not part of the site definition), so dev works.
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
  path: '/',
  maxAge: env.SESSION_TTL_HOURS * 3600 * 1000,
};
