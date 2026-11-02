import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { emailJobs, type EmailJob } from '../db/schema.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ mod: 'repository' });

/**
 * All mutations of the email_jobs ledger.
 *
 * Centralising them is what makes the idempotency argument auditable: there is
 * exactly one place that moves a row into SENDING, and exactly one that moves it
 * to SENT.
 */

export async function getEmailJob(id: string): Promise<EmailJob | undefined> {
  const [row] = await db.select().from(emailJobs).where(eq(emailJobs.id, id)).limit(1);
  return row;
}

/**
 * The idempotency barrier.
 *
 * A single conditional UPDATE claims the row: the `status = 'SCHEDULED'`
 * predicate is evaluated under Postgres' row lock, so of N concurrent workers
 * racing on the same job, exactly one gets a row back and the rest get nothing.
 * That is what guarantees "the same email is never sent twice" even if BullMQ
 * delivers a job twice (duplicate delivery is possible after a worker crash, a
 * stalled-job recovery, or a manual retry from the dashboard).
 *
 * A lease is taken at the same time: if this worker dies mid-send, the
 * reconciler can tell the difference between "in flight" and "abandoned".
 */
export async function claimForSend(
  id: string,
  owner: string,
  leaseMs: number,
): Promise<EmailJob | null> {
  const now = new Date();
  const [row] = await db
    .update(emailJobs)
    .set({
      status: 'SENDING',
      leaseOwner: owner,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    })
    .where(
      and(
        eq(emailJobs.id, id),
        // Claimable from SCHEDULED, or from a SENDING row whose lease expired
        // (the previous owner is gone).
        or(
          eq(emailJobs.status, 'SCHEDULED'),
          and(eq(emailJobs.status, 'SENDING'), lt(emailJobs.leaseExpiresAt, now)),
        ),
      ),
    )
    .returning();

  return row ?? null;
}

/** Hands a claimed row back when the limiter defers it. Not a failed attempt. */
export async function releaseToScheduled(
  id: string,
  runAt: Date,
  reason: string,
): Promise<void> {
  await db
    .update(emailJobs)
    .set({
      status: 'SCHEDULED',
      scheduledAt: runAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      deferCount: sql`${emailJobs.deferCount} + 1`,
      lastDeferReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(emailJobs.id, id), eq(emailJobs.status, 'SENDING')));
}

export async function markAttemptStarted(id: string): Promise<void> {
  await db
    .update(emailJobs)
    .set({ attemptCount: sql`${emailJobs.attemptCount} + 1`, updatedAt: new Date() })
    .where(eq(emailJobs.id, id));
}

export async function markSent(
  id: string,
  result: { providerMessageId: string; previewUrl: string | null; senderId: string },
): Promise<EmailJob | undefined> {
  const now = new Date();
  const [row] = await db
    .update(emailJobs)
    .set({
      status: 'SENT',
      sentAt: now,
      providerMessageId: result.providerMessageId,
      previewUrl: result.previewUrl,
      senderId: result.senderId,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(emailJobs.id, id))
    .returning();
  return row;
}

export async function markFailed(
  id: string,
  error: string,
  permanent: boolean,
): Promise<EmailJob | undefined> {
  const now = new Date();
  const [row] = await db
    .update(emailJobs)
    .set({
      // A retryable failure goes back to SCHEDULED so the dashboard shows it as
      // still pending; BullMQ owns the retry timing.
      status: permanent ? 'FAILED' : 'SCHEDULED',
      failedAt: permanent ? now : null,
      lastError: error.slice(0, 1000),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(eq(emailJobs.id, id))
    .returning();
  return row;
}

/** Terminal failure after BullMQ exhausted its retries. */
export async function markExhausted(id: string, error: string): Promise<void> {
  const now = new Date();
  await db
    .update(emailJobs)
    .set({
      status: 'FAILED',
      failedAt: now,
      lastError: error.slice(0, 1000),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(emailJobs.id, id), inArray(emailJobs.status, ['SCHEDULED', 'SENDING'])));
}

export async function reassignSender(id: string, senderId: string): Promise<void> {
  await db
    .update(emailJobs)
    .set({ senderId, updatedAt: new Date() })
    .where(eq(emailJobs.id, id));
  log.debug({ emailJobId: id, senderId }, 'sender reassigned');
}

export async function markIndexed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(emailJobs)
    .set({ indexedAt: new Date() })
    .where(inArray(emailJobs.id, ids));
}

/**
 * Rows that should have a live Redis job but might not -- the input to the
 * restart reconciler. Includes already-due rows (scheduled_at in the past),
 * which is exactly the "server was down over the send time" case.
 */
export async function findSchedulableJobs(limit: number): Promise<EmailJob[]> {
  return db
    .select()
    .from(emailJobs)
    .where(eq(emailJobs.status, 'SCHEDULED'))
    .orderBy(emailJobs.scheduledAt)
    .limit(limit);
}

/** SENDING rows whose lease expired: the owning worker died mid-send. */
export async function findAbandonedJobs(limit: number): Promise<EmailJob[]> {
  return db
    .select()
    .from(emailJobs)
    .where(and(eq(emailJobs.status, 'SENDING'), lt(emailJobs.leaseExpiresAt, new Date())))
    .limit(limit);
}

export async function reclaimAbandoned(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(emailJobs)
    .set({
      status: 'SCHEDULED',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastDeferReason: 'WORKER_LEASE_EXPIRED',
      updatedAt: new Date(),
    })
    .where(and(inArray(emailJobs.id, ids), eq(emailJobs.status, 'SENDING')))
    .returning({ id: emailJobs.id });
  return rows.length;
}
