import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { env, slackOAuthConfigured, slackRedirectUri } from '../../config/env.js';
import { db } from '../../db/client.js';
import { slackIntegrations, type SlackIntegration } from '../../db/schema.js';
import { badRequest, failedDependency } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { signState, verifyState } from '../../auth/jwt.js';

const log = logger.child({ mod: 'slack:oauth' });

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const ACCESS_URL = 'https://slack.com/api/oauth.v2.access';

/**
 * Slack OAuth v2 ("Connect Slack" in the dashboard).
 *
 * The `state` parameter is a short-lived signed token carrying the user id
 * rather than an opaque value stored server-side. That makes the callback
 * stateless (no session affinity needed) while still being CSRF-proof: an
 * attacker cannot mint a state for someone else's account without the signing
 * key, and the token expires in 10 minutes.
 */

export function buildInstallUrl(userId: string): Promise<string> {
  if (!slackOAuthConfigured) {
    throw failedDependency(
      'Slack is not configured on the server. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.',
    );
  }
  return signState({ sub: userId, nonce: randomUUID() }, '10m').then((state) => {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', env.SLACK_CLIENT_ID!);
    // incoming-webhook gives us a channel to post into that the user picks
    // themselves during the install flow -- no channel-id configuration needed.
    url.searchParams.set('scope', env.SLACK_SCOPES);
    url.searchParams.set('redirect_uri', slackRedirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  });
}

interface SlackAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  scope?: string;
  bot_user_id?: string;
  team?: { id?: string; name?: string };
  incoming_webhook?: { url?: string; channel?: string; channel_id?: string };
}

/** Exchanges the authorization code and persists the connection for the tenant. */
export async function completeInstall(code: string, state: string): Promise<SlackIntegration> {
  const claims = await verifyState(state).catch(() => null);
  if (!claims?.sub) throw badRequest('Invalid or expired Slack OAuth state');
  const userId = claims.sub;

  const res = await fetch(ACCESS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID!,
      client_secret: env.SLACK_CLIENT_SECRET!,
      code,
      redirect_uri: slackRedirectUri,
    }),
  });

  const payload = (await res.json()) as SlackAccessResponse;
  if (!payload.ok) {
    log.warn({ error: payload.error }, 'slack oauth exchange rejected');
    throw badRequest(`Slack rejected the installation: ${payload.error ?? 'unknown_error'}`);
  }

  const values = {
    userId,
    teamId: payload.team?.id ?? null,
    teamName: payload.team?.name ?? null,
    channel: payload.incoming_webhook?.channel ?? null,
    channelId: payload.incoming_webhook?.channel_id ?? null,
    webhookUrl: payload.incoming_webhook?.url ?? null,
    accessToken: payload.access_token ?? null,
    botUserId: payload.bot_user_id ?? null,
    scope: payload.scope ?? null,
    connectedAt: new Date(),
    // Reconnecting clears a previous revocation -- notifications resume with no
    // redeploy and no restart.
    revokedAt: null,
    notifyFailures: 0,
  };

  const [row] = await db
    .insert(slackIntegrations)
    .values(values)
    .onConflictDoUpdate({ target: slackIntegrations.userId, set: values })
    .returning();

  if (!row) throw new Error('Failed to persist Slack integration');
  log.info({ userId, team: row.teamName, channel: row.channel }, 'slack connected');
  return row;
}

export async function getIntegration(userId: string): Promise<SlackIntegration | undefined> {
  const [row] = await db
    .select()
    .from(slackIntegrations)
    .where(eq(slackIntegrations.userId, userId))
    .limit(1);
  return row;
}

/** Soft disconnect: keeps the row for audit, stops all notification attempts. */
export async function disconnect(userId: string): Promise<void> {
  await db
    .update(slackIntegrations)
    .set({ revokedAt: new Date(), webhookUrl: null, accessToken: null })
    .where(eq(slackIntegrations.userId, userId));
  log.info({ userId }, 'slack disconnected');
}
