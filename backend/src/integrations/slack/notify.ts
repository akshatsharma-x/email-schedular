import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { slackIntegrations } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { claimNotificationSlot } from '../../ratelimit/limiter.js';
import { getIntegration } from './oauth.js';

const log = logger.child({ mod: 'slack:notify' });

/**
 * Slack delivery for rate-limit events.
 *
 * Three properties matter here, and each one is a failure mode seen in real
 * systems:
 *
 *  1. Not connected must be a no-op, never an exception. A tenant without Slack
 *     still has to be able to send email, so every path returns a status object
 *     instead of throwing.
 *  2. One alert, not a thousand. Hitting an hourly cap denies every remaining
 *     job in the campaign, so the raw event fires hundreds of times. A Redis
 *     SET NX claim collapses that to one message per sender per hour window.
 *  3. A revoked webhook self-heals. Slack answers 403/404/410 for a webhook the
 *     user removed; that marks the integration revoked so we stop hammering a
 *     dead URL, and reconnecting clears the flag at runtime.
 */

export type NotifyOutcome =
  | 'sent'
  | 'not_connected'
  | 'suppressed_duplicate'
  | 'revoked'
  | 'failed';

export interface RateLimitAlert {
  userId: string;
  senderEmail: string;
  senderId: string;
  limit: number;
  windowEndsAt: number;
  /** Jobs pushed into the next window by this event. */
  deferredCount?: number;
  campaignSubject?: string;
}

/** How long one sender's rate-limit alert suppresses repeats. */
const ALERT_TTL_SECONDS = 3600;

export async function notifyRateLimitHit(alert: RateLimitAlert): Promise<NotifyOutcome> {
  const integration = await getIntegration(alert.userId);

  // (1) Silently skip when the user has not connected Slack.
  if (!integration || integration.revokedAt || !integration.webhookUrl) {
    return 'not_connected';
  }

  // (2) Collapse the storm: first caller in this hour window wins.
  const windowLabel = new Date(alert.windowEndsAt).toISOString().slice(0, 13);
  const claimed = await claimNotificationSlot(
    `slack:ratelimit:${alert.userId}:${alert.senderId}:${windowLabel}`,
    ALERT_TTL_SECONDS,
  );
  if (!claimed) return 'suppressed_duplicate';

  const resumesAt = new Date(alert.windowEndsAt);
  const message = {
    text: `Hourly send limit reached for ${alert.senderEmail}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '⏳ Hourly send limit reached', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Sender*\n${alert.senderEmail}` },
          { type: 'mrkdwn', text: `*Limit*\n${alert.limit} emails/hour` },
          {
            type: 'mrkdwn',
            text: `*Queue resumes*\n<!date^${Math.floor(
              resumesAt.getTime() / 1000,
            )}^{time}|${resumesAt.toISOString()}>`,
          },
          {
            type: 'mrkdwn',
            text: `*Deferred*\n${alert.deferredCount ?? 'remaining'} email(s)`,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: alert.campaignSubject
              ? `Campaign: _${alert.campaignSubject}_ · Nothing was dropped — jobs were rescheduled into the next window.`
              : 'Nothing was dropped — jobs were rescheduled into the next window.',
          },
        ],
      },
    ],
  };

  return postWebhook(alert.userId, integration.webhookUrl, message);
}

/** Used by the dashboard's "Send test message" button to prove the wiring works. */
export async function sendTestMessage(userId: string): Promise<NotifyOutcome> {
  const integration = await getIntegration(userId);
  if (!integration || integration.revokedAt || !integration.webhookUrl) return 'not_connected';

  return postWebhook(userId, integration.webhookUrl, {
    text: 'Outbox scheduler connected',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '✅ *Outbox scheduler connected.*\nYou will get a message here the moment a sender hits its hourly limit.',
        },
      },
    ],
  });
}

async function postWebhook(
  userId: string,
  webhookUrl: string,
  body: unknown,
): Promise<NotifyOutcome> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      await db
        .update(slackIntegrations)
        .set({ lastNotifiedAt: new Date(), notifyFailures: 0 })
        .where(eq(slackIntegrations.userId, userId));
      log.info({ userId }, 'slack notification delivered');
      return 'sent';
    }

    // (3) The user removed the webhook in Slack -- stop trying until they reconnect.
    if ([403, 404, 410].includes(res.status)) {
      await db
        .update(slackIntegrations)
        .set({ revokedAt: new Date() })
        .where(eq(slackIntegrations.userId, userId));
      log.warn({ userId, status: res.status }, 'slack webhook revoked; marking disconnected');
      return 'revoked';
    }

    await recordFailure(userId);
    log.warn({ userId, status: res.status }, 'slack webhook returned an error');
    return 'failed';
  } catch (err) {
    // Network/timeout: a Slack outage must never fail an email send.
    await recordFailure(userId);
    log.warn({ userId, err: (err as Error).message }, 'slack webhook request failed');
    return 'failed';
  }
}

async function recordFailure(userId: string): Promise<void> {
  await db
    .update(slackIntegrations)
    .set({ notifyFailures: sql`${slackIntegrations.notifyFailures} + 1` })
    .where(eq(slackIntegrations.userId, userId))
    .catch(() => undefined);
}
