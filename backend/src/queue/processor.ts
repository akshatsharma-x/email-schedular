import { hostname } from 'node:os';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { campaigns, type Campaign, type Sender } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import {
  emailsDeferred,
  emailsFailed,
  emailsSent,
  emailsSkipped,
  sendDuration,
  slackNotifications,
} from '../lib/metrics.js';
import {
  effectiveHourlyLimit,
  getSender,
  listAvailableSenders,
  recordSenderFailure,
  recordSenderSuccess,
} from '../mailer/senderPool.js';
import { isPermanentSmtpError, sendMail, type OutgoingAttachment } from '../mailer/transport.js';
import { listCampaignAttachments } from '../routes/attachments.routes.js';
import {
  admit,
  computeDeferredRunAt,
  releaseSendGap,
  type DenyReason,
} from '../ratelimit/limiter.js';
import { notifyRateLimitHit } from '../integrations/slack/notify.js';
import { indexEmail } from '../search/indexer.js';
import { publishEvent } from '../realtime/events.js';
import {
  claimForSend,
  getEmailJob,
  markAttemptStarted,
  markFailed,
  markSent,
  reassignSender,
  releaseToScheduled,
} from './repository.js';
import type { EmailJobPayload } from './queues.js';

const log = logger.child({ mod: 'processor' });

/** Identifies this worker in lease ownership, for debugging a stuck job. */
const WORKER_ID = `${hostname()}:${process.pid}`;

export type ProcessOutcome =
  | { status: 'sent'; previewUrl: string | null }
  | { status: 'deferred'; reason: DenyReason; runAt: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; permanent: boolean; error: string };

/**
 * Process one email job.
 *
 * The order of operations below is the whole design, so it is worth stating:
 *
 *   1. load the durable row            -- Postgres, not the job payload, decides
 *   2. short-circuit terminal states   -- idempotency for duplicate delivery
 *   3. resolve a healthy sender        -- swap out a tripped/disabled identity
 *   4. CLAIM the row (atomic UPDATE)   -- exactly one worker proceeds
 *   5. ask the limiter for admission   -- after the claim, so a denial cannot
 *                                         leak reserved quota to a lost race
 *   6. send, then record the outcome
 *
 * Steps 4 and 5 are in this order on purpose. Reserving quota *before* winning
 * the claim would burn an hourly token and the min-delay gate on a job this
 * worker then discovers it does not own -- quota silently lost, every time two
 * workers race. Claiming first means a denial just hands the row back.
 */
export async function processEmailJob(
  job: Job<EmailJobPayload>,
  token?: string,
): Promise<ProcessOutcome> {
  const { emailJobId } = job.data;
  const jobLog = log.child({ emailJobId, bullJobId: job.id, attempt: job.attemptsMade + 1 });

  // ---- 1 + 2. durable state is the source of truth -------------------------
  const row = await getEmailJob(emailJobId);
  if (!row) {
    // The campaign was deleted, or Redis outlived the database. Nothing to do.
    emailsSkipped.inc({ reason: 'row_missing' });
    return { status: 'skipped', reason: 'row_missing' };
  }
  if (row.status === 'SENT') {
    jobLog.info('job already sent; skipping (idempotent no-op)');
    emailsSkipped.inc({ reason: 'already_sent' });
    return { status: 'skipped', reason: 'already_sent' };
  }
  if (row.status === 'CANCELLED') {
    emailsSkipped.inc({ reason: 'cancelled' });
    return { status: 'skipped', reason: 'cancelled' };
  }
  if (row.status === 'FAILED') {
    emailsSkipped.inc({ reason: 'already_failed' });
    return { status: 'skipped', reason: 'already_failed' };
  }

  const campaign = await loadCampaign(row.campaignId);
  if (campaign?.status === 'CANCELLED' || campaign?.status === 'PAUSED') {
    emailsSkipped.inc({ reason: 'campaign_inactive' });
    return { status: 'skipped', reason: `campaign_${campaign.status.toLowerCase()}` };
  }

  // ---- 3. resolve a healthy sender -----------------------------------------
  const sender = await resolveSender(row.senderId, row.userId, row.sequence);
  if (!sender) {
    // No usable sender right now (all disabled / breaker tripped). Back off
    // rather than failing the email -- the user can re-enable a sender.
    const runAt = Date.now() + 60_000;
    await releaseToScheduled(emailJobId, new Date(runAt), 'NO_ACTIVE_SENDER');
    await job.moveToDelayed(runAt, token);
    emailsDeferred.inc({ reason: 'NO_ACTIVE_SENDER' });
    jobLog.warn('no active sender available; deferring 60s');
    throw new DelayedError();
  }
  if (sender.id !== row.senderId) await reassignSender(emailJobId, sender.id);

  // ---- 4. claim: exactly one worker gets past this line ---------------------
  const claimed = await claimForSend(emailJobId, WORKER_ID, env.JOB_LEASE_MS);
  if (!claimed) {
    jobLog.info('could not claim job (another worker owns it); skipping');
    emailsSkipped.inc({ reason: 'claim_lost' });
    return { status: 'skipped', reason: 'claim_lost' };
  }

  // ---- 5. admission control ------------------------------------------------
  const hourlyLimit = effectiveHourlyLimit(sender, campaign?.maxPerHour ?? null);
  const decision = await admit({
    userId: row.userId,
    senderId: sender.id,
    senderHourlyLimit: hourlyLimit,
    minDelayMs: campaign?.minDelayMs ?? env.MIN_DELAY_BETWEEN_EMAILS_MS,
  });

  if (!decision.allowed) {
    const reason = decision.reason as DenyReason;
    const runAtMs = computeDeferredRunAt({
      reason,
      // recheckAfterMs, not waitMs: a MIN_DELAY wait is a pessimistic upper
      // bound on an in-flight send, so sleeping it out would stall the queue.
      waitMs: decision.recheckAfterMs,
      now: Date.now(),
      sequence: row.sequence,
      minDelayMs: campaign?.minDelayMs ?? env.MIN_DELAY_BETWEEN_EMAILS_MS,
      senderHourlyLimit: hourlyLimit,
    });
    const runAt = new Date(runAtMs);

    // Hand the row back to SCHEDULED with its new time. Nothing is dropped and
    // no retry attempt is consumed -- a deferral is not a failure.
    await releaseToScheduled(emailJobId, runAt, reason);

    // Re-delay the *same* BullMQ job rather than creating a new one, so the job
    // id (and therefore the dedupe guarantee) is preserved.
    await job.moveToDelayed(runAtMs, token);

    emailsDeferred.inc({ reason });
    void publishEvent(row.userId, {
      type: 'email.deferred',
      emailJobId,
      recipient: row.recipientEmail,
      reason,
      runAt: runAt.toISOString(),
    });

    // Only an *hourly* ceiling is worth telling a human about; a min-delay
    // deferral is normal pacing and happens constantly.
    if (reason === 'SENDER_HOURLY_LIMIT' || reason === 'TENANT_HOURLY_LIMIT') {
      void publishEvent(row.userId, {
        type: 'ratelimit.hit',
        senderId: sender.id,
        senderEmail: sender.fromEmail,
        limit: hourlyLimit,
        resumesAt: new Date(decision.windowEnd).toISOString(),
      });
      // Fire-and-forget: Slack must never delay or fail the queue.
      void notifyRateLimitHit({
        userId: row.userId,
        senderId: sender.id,
        senderEmail: sender.fromEmail,
        limit: hourlyLimit,
        windowEndsAt: decision.windowEnd,
        campaignSubject: campaign?.subject,
      })
        .then((outcome) => slackNotifications.inc({ outcome }))
        .catch(() => slackNotifications.inc({ outcome: 'failed' }));
    }

    jobLog.info({ reason, runAt: runAt.toISOString() }, 'send deferred by limiter');
    throw new DelayedError();
  }

  // ---- 6. send -------------------------------------------------------------
  await markAttemptStarted(emailJobId);
  const timer = sendDuration.startTimer();
  const campaignGapMs = campaign?.minDelayMs ?? env.MIN_DELAY_BETWEEN_EMAILS_MS;

  // Resolved per send so an attachment removed between scheduling and sending
  // does not break the message.
  let outgoing: OutgoingAttachment[] = [];
  try {
    const files = await listCampaignAttachments(row.campaignId);
    outgoing = files.map((f) => ({
      filename: f.filename,
      path: f.storagePath,
      contentType: f.mimeType,
    }));
  } catch (err) {
    jobLog.warn({ err: (err as Error).message }, 'could not load attachments; sending without');
  }

  try {
    const result = await sendMail({
      sender,
      to: row.recipientEmail,
      toName: row.recipientName,
      subject: row.subject,
      body: row.body,
      bodyHtml: row.bodyHtml,
      attachments: outgoing,
      // The dedupe key travels as a header so a duplicate is detectable
      // downstream, not just in our own database.
      idempotencyKey: row.dedupeKey,
    });
    timer();
    // Release the in-flight reservation and re-arm the delay from *now* (send
    // finished), so the configured gap is observed between sends rather than
    // between submissions. Done before the DB write so a slow write cannot let
    // the next send slip through early.
    await releaseSendGap(sender.id, campaignGapMs, decision.gateToken);

    if (result.rejected.length > 0) {
      throw new Error(`SMTP rejected recipient: ${result.rejected.join(', ')}`);
    }

    const updated = await markSent(emailJobId, {
      providerMessageId: result.messageId,
      previewUrl: result.previewUrl,
      senderId: sender.id,
    });

    await recordSenderSuccess(sender.id);
    emailsSent.inc({ sender_id: sender.id });

    if (updated) void indexEmail(updated).catch(() => undefined);
    void publishEvent(row.userId, {
      type: 'email.sent',
      emailJobId,
      recipient: row.recipientEmail,
      previewUrl: result.previewUrl,
    });

    jobLog.info(
      { to: row.recipientEmail, sender: sender.fromEmail, previewUrl: result.previewUrl },
      'email sent',
    );
    return { status: 'sent', previewUrl: result.previewUrl };
  } catch (err) {
    timer();
    // A failed attempt still used the provider connection, so the next send
    // waits out the full gap too. Releasing here also stops a failure from
    // parking this sender until the hold TTL expires.
    await releaseSendGap(sender.id, campaignGapMs, decision.gateToken).catch(() => undefined);

    const message = err instanceof Error ? err.message : String(err);
    const permanent = isPermanentSmtpError(err);
    const attemptsLeft = job.attemptsMade + 1 < (job.opts.attempts ?? env.SEND_MAX_ATTEMPTS);

    await recordSenderFailure(sender.id);
    const updated = await markFailed(emailJobId, message, permanent || !attemptsLeft);
    emailsFailed.inc({ sender_id: sender.id, permanent: String(permanent) });

    if (permanent || !attemptsLeft) {
      if (updated) void indexEmail(updated).catch(() => undefined);
      void publishEvent(row.userId, {
        type: 'email.failed',
        emailJobId,
        recipient: row.recipientEmail,
        error: message,
      });
    }

    if (permanent) {
      // Don't waste retries on a 5xx rejection -- it will never succeed.
      jobLog.warn({ err: message }, 'permanent SMTP failure; not retrying');
      throw new UnrecoverableError(message);
    }

    // Transient: let BullMQ retry with exponential backoff.
    jobLog.warn({ err: message, attemptsLeft }, 'transient send failure; will retry');
    throw err;
  }
}

async function loadCampaign(campaignId: string): Promise<Campaign | undefined> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  return row;
}

/**
 * Returns the assigned sender if it is still healthy, otherwise a replacement
 * from the tenant's pool, otherwise null.
 *
 * Re-validating at send time matters because a campaign can be scheduled hours
 * before it runs -- the sender may have been deactivated or had its circuit
 * breaker tripped in the meantime.
 */
async function resolveSender(
  senderId: string | null,
  userId: string,
  sequence: number,
): Promise<Sender | null> {
  const isHealthy = (s: Sender): boolean =>
    s.isActive && (!s.disabledUntil || s.disabledUntil.getTime() <= Date.now());

  if (senderId) {
    const assigned = await getSender(senderId);
    if (assigned && isHealthy(assigned)) return assigned;
  }

  const pool = await listAvailableSenders(userId);
  if (pool.length === 0) return null;
  // Keep the round-robin shape when substituting, so load stays spread.
  return pool[sequence % pool.length] ?? null;
}
