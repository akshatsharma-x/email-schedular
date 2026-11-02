import { and, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { campaigns, emailJobs, type Campaign, type EmailJob } from '../db/schema.js';
import { badRequest, conflict } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { Lead } from '../lib/leads.js';
import {
  assignSenderRoundRobin,
  effectiveHourlyLimit,
  listAvailableSenders,
} from '../mailer/senderPool.js';
import { indexEmailsBulk } from '../search/indexer.js';
import { linkAttachmentsToCampaign } from '../routes/attachments.routes.js';
import { planSchedule, summarisePlan, type PlanSummary } from './planner.js';
import { emailQueue } from './queues.js';
import { publishEvent } from '../realtime/events.js';

const log = logger.child({ mod: 'scheduler' });

export interface ScheduleRequest {
  userId: string;
  subject: string;
  body: string;
  leads: Lead[];
  /** ISO string or Date. Defaults to "now". */
  startAt: Date;
  /** Per-campaign override of MIN_DELAY_BETWEEN_EMAILS_MS. */
  minDelayMs?: number | null;
  /** Per-campaign override of MAX_EMAILS_PER_HOUR_PER_SENDER (capped by sender). */
  maxPerHour?: number | null;
  name?: string | null;
  /** Optional rich-text body; `body` stays the plain-text alternative. */
  bodyHtml?: string | null;
  /**
   * Explicit "From" sender, chosen in the composer. When omitted, recipients are
   * round-robined across every active sender (higher aggregate throughput).
   */
  senderId?: string | null;
  /** Pending uploads to attach to this campaign. */
  attachmentIds?: string[];
  /** Makes a retried POST return the original campaign instead of duplicating it. */
  idempotencyKey?: string | null;
}

export interface ScheduleResult {
  campaign: Campaign;
  plan: PlanSummary;
  enqueued: number;
  /** True when an existing campaign was returned for a repeated idempotency key. */
  deduplicated: boolean;
}

/**
 * Create a campaign and schedule one delayed job per recipient.
 *
 * Write ordering is deliberate: **Postgres commits first, Redis second.**
 *
 * If the process dies between the two, the database holds SCHEDULED rows with no
 * Redis counterpart -- and the reconciler (see ./reconciler.ts) re-enqueues them
 * on the next boot or sweep. The reverse order would be unrecoverable: a job in
 * Redis with no durable row cannot be reconstructed, and would either send an
 * email we have no record of or vanish silently. This is the transactional
 * outbox pattern, and it is why Redis is treated as a rebuildable index rather
 * than the system of record.
 */
export async function scheduleCampaign(req: ScheduleRequest): Promise<ScheduleResult> {
  if (req.leads.length === 0) throw badRequest('No valid email addresses to schedule');

  // Idempotent create: a client retry (or a double-click) must not double-send.
  if (req.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(campaigns)
      .where(
        and(eq(campaigns.userId, req.userId), eq(campaigns.idempotencyKey, req.idempotencyKey)),
      )
      .limit(1);
    if (existing) {
      log.info({ campaignId: existing.id }, 'returning existing campaign for idempotency key');
      return {
        campaign: existing,
        plan: await describeExistingPlan(existing),
        enqueued: 0,
        deduplicated: true,
      };
    }
  }

  const available = await listAvailableSenders(req.userId);
  if (available.length === 0) {
    throw badRequest(
      'No active senders configured. Run `npm run senders:create` to provision Ethereal senders.',
    );
  }

  // An explicit From narrows the pool to that one sender, which also means the
  // campaign is paced by that sender's hourly ceiling alone.
  const pool = req.senderId
    ? available.filter((s) => s.id === req.senderId)
    : available;
  if (pool.length === 0) {
    throw badRequest('The selected sender is not active. Pick another From address.');
  }

  const minDelayMs = Math.max(0, req.minDelayMs ?? env.MIN_DELAY_BETWEEN_EMAILS_MS);
  // The tightest per-sender ceiling in the pool bounds the plan, so the plan can
  // never promise throughput the limiter will refuse.
  const perSenderHourly = Math.min(
    ...pool.map((s) => effectiveHourlyLimit(s, req.maxPerHour ?? null)),
  );

  const planInput = {
    recipientCount: req.leads.length,
    senderCount: pool.length,
    startAt: req.startAt.getTime(),
    minDelayMs,
    perSenderHourly,
  };
  const plan = planSchedule(planInput);
  const summary = summarisePlan(plan, planInput);

  // ---- 1. durable write (single transaction) --------------------------------
  const { campaign, jobs } = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(campaigns)
      .values({
        userId: req.userId,
        name: req.name ?? null,
        subject: req.subject,
        body: req.body,
        bodyHtml: req.bodyHtml ?? null,
        startAt: req.startAt,
        minDelayMs,
        maxPerHour: perSenderHourly,
        totalRecipients: req.leads.length,
        status: 'ACTIVE',
        idempotencyKey: req.idempotencyKey ?? null,
      })
      .returning();

    if (!created) throw new Error('campaign insert returned no row');

    const rows = req.leads.map((lead, i) => {
      const slot = plan[i]!;
      const sender = assignSenderRoundRobin(pool, slot.senderIndex);
      return {
        userId: req.userId,
        campaignId: created.id,
        senderId: sender.id,
        recipientEmail: lead.email,
        recipientName: lead.name,
        subject: req.subject,
        body: req.body,
        bodyHtml: req.bodyHtml ?? null,
        status: 'SCHEDULED' as const,
        sequence: i,
        scheduledAt: new Date(slot.runAt),
        maxAttempts: env.SEND_MAX_ATTEMPTS,
        // Unique per (campaign, recipient): the DB rejects a duplicate recipient
        // within a campaign, and this same value becomes the BullMQ job id.
        dedupeKey: `${created.id}:${lead.email}`,
      };
    });

    // Chunked insert: a single 100k-row INSERT exceeds Postgres' parameter limit.
    const inserted: EmailJob[] = [];
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = await tx.insert(emailJobs).values(rows.slice(i, i + CHUNK)).returning();
      inserted.push(...batch);
    }

    return { campaign: created, jobs: inserted };
  });

  // Link pending uploads now that the campaign row exists.
  await linkAttachmentsToCampaign(req.userId, campaign.id, req.attachmentIds ?? []);

  // ---- 2. derive the Redis schedule from the committed rows ------------------
  const enqueued = await enqueueJobs(jobs);

  // ---- 3. best-effort search indexing (never blocks scheduling) -------------
  void indexEmailsBulk(jobs).catch(() => undefined);

  void publishEvent(req.userId, {
    type: 'campaign.scheduled',
    campaignId: campaign.id,
    count: jobs.length,
  });

  log.info(
    {
      campaignId: campaign.id,
      recipients: jobs.length,
      enqueued,
      senders: pool.length,
      perSenderHourly,
      minDelayMs,
      windows: summary.windowsUsed,
    },
    'campaign scheduled',
  );

  return { campaign, plan: summary, enqueued, deduplicated: false };
}

/**
 * Push jobs onto the queue as BullMQ delayed jobs.
 *
 * `jobId` is the email_jobs primary key, which makes `add` idempotent: BullMQ
 * silently ignores a job whose id already exists. Re-running this for the same
 * rows (reconciler, manual replay) therefore cannot create a second send.
 */
export async function enqueueJobs(jobs: EmailJob[], now = Date.now()): Promise<number> {
  if (jobs.length === 0) return 0;

  const entries = jobs.map((job) => ({
    name: 'send-email',
    data: {
      emailJobId: job.id,
      userId: job.userId,
      campaignId: job.campaignId,
      sequence: job.sequence,
    },
    opts: {
      jobId: job.id,
      // Negative delays are clamped: a job whose time already passed runs now.
      delay: Math.max(0, job.scheduledAt.getTime() - now),
      attempts: job.maxAttempts,
      backoff: { type: 'exponential' as const, delay: env.SEND_BACKOFF_MS },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  }));

  // addBulk is one Redis pipeline instead of N round-trips; chunked so a huge
  // campaign does not build one giant command.
  let added = 0;
  const CHUNK = 1000;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const batch = await emailQueue.addBulk(entries.slice(i, i + CHUNK));
    added += batch.length;
  }
  return added;
}

/** Re-derives a plan summary for an already-persisted campaign. */
async function describeExistingPlan(campaign: Campaign): Promise<PlanSummary> {
  const rows = await db
    .select({ scheduledAt: emailJobs.scheduledAt, senderId: emailJobs.senderId })
    .from(emailJobs)
    .where(eq(emailJobs.campaignId, campaign.id));

  const senderIds = new Set(rows.map((r) => r.senderId));
  return summarisePlan(
    rows.map((r) => ({ senderIndex: 0, runAt: r.scheduledAt.getTime() })),
    {
      recipientCount: rows.length,
      senderCount: Math.max(1, senderIds.size),
      startAt: campaign.startAt.getTime(),
      minDelayMs: campaign.minDelayMs,
      perSenderHourly: campaign.maxPerHour,
    },
  );
}

/**
 * Cancel every not-yet-sent email in a campaign: remove the Redis jobs first so
 * no worker can pick one up, then mark the rows CANCELLED.
 */
export async function cancelCampaign(userId: string, campaignId: string): Promise<number> {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);
  if (!campaign) throw conflict('Campaign not found');

  const pending = await db
    .select({ id: emailJobs.id })
    .from(emailJobs)
    .where(and(eq(emailJobs.campaignId, campaignId), eq(emailJobs.status, 'SCHEDULED')));

  await Promise.allSettled(
    pending.map(async (row) => {
      const job = await emailQueue.getJob(row.id);
      await job?.remove();
    }),
  );

  await db
    .update(emailJobs)
    .set({ status: 'CANCELLED', updatedAt: new Date() })
    .where(and(eq(emailJobs.campaignId, campaignId), eq(emailJobs.status, 'SCHEDULED')));

  await db
    .update(campaigns)
    .set({ status: 'CANCELLED', updatedAt: new Date() })
    .where(eq(campaigns.id, campaignId));

  void publishEvent(userId, { type: 'campaign.cancelled', campaignId, count: pending.length });
  log.info({ campaignId, cancelled: pending.length }, 'campaign cancelled');
  return pending.length;
}
