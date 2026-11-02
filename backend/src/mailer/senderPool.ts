import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { senders, type Sender } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

const log = logger.child({ mod: 'senderPool' });

/**
 * Sender selection for multi-sender sending.
 *
 * Assignment of a sender happens at *schedule* time (round-robin across the
 * tenant's active senders) and is stored on the row, which gives three things:
 *   1. the per-sender hourly quota is spread evenly instead of hammering one
 *      identity until it is exhausted,
 *   2. the schedule is reproducible -- a restart re-sends from the same sender,
 *   3. the dashboard can show exactly who will send what, before it happens.
 *
 * At send time the worker re-validates the assignment; if that sender has been
 * deactivated or tripped its circuit breaker, it is swapped for a healthy one.
 */

/** Active senders for a tenant, with tripped breakers excluded. */
export async function listAvailableSenders(userId: string): Promise<Sender[]> {
  return db
    .select()
    .from(senders)
    .where(
      and(
        eq(senders.userId, userId),
        eq(senders.isActive, true),
        or(isNull(senders.disabledUntil), sql`${senders.disabledUntil} <= now()`),
      ),
    )
    .orderBy(asc(senders.createdAt));
}

export async function listAllSenders(userId: string): Promise<Sender[]> {
  return db
    .select()
    .from(senders)
    .where(eq(senders.userId, userId))
    .orderBy(asc(senders.createdAt));
}

export async function getSender(senderId: string): Promise<Sender | undefined> {
  const [row] = await db.select().from(senders).where(eq(senders.id, senderId)).limit(1);
  return row;
}

/**
 * Effective hourly cap for a sender: its own override, else the env default.
 * A campaign may request a *lower* value but never a higher one -- the sender's
 * configured ceiling is a hard bound.
 */
export function effectiveHourlyLimit(sender: Sender, campaignLimit?: number | null): number {
  const senderCap = sender.maxEmailsPerHour ?? env.MAX_EMAILS_PER_HOUR_PER_SENDER;
  if (campaignLimit && campaignLimit > 0) return Math.min(senderCap, campaignLimit);
  return senderCap;
}

/**
 * Deterministic round-robin assignment used when a campaign is scheduled.
 * Index by position so recipient N always lands on the same sender.
 */
export function assignSenderRoundRobin(pool: Sender[], index: number): Sender {
  const chosen = pool[index % pool.length];
  // pool is non-empty at every call site; this keeps noUncheckedIndexedAccess happy.
  if (!chosen) throw new Error('assignSenderRoundRobin called with an empty pool');
  return chosen;
}

/** Circuit breaker: three consecutive failures parks a sender for 15 minutes. */
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 15 * 60_000;

export async function recordSenderSuccess(senderId: string): Promise<void> {
  await db
    .update(senders)
    .set({ consecutiveFailures: 0, disabledUntil: null, updatedAt: new Date() })
    .where(eq(senders.id, senderId));
}

export async function recordSenderFailure(senderId: string): Promise<void> {
  const [updated] = await db
    .update(senders)
    .set({
      consecutiveFailures: sql`${senders.consecutiveFailures} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(senders.id, senderId))
    .returning({ failures: senders.consecutiveFailures });

  if (updated && updated.failures >= FAILURE_THRESHOLD) {
    await db
      .update(senders)
      .set({ disabledUntil: new Date(Date.now() + COOLDOWN_MS), consecutiveFailures: 0 })
      .where(eq(senders.id, senderId));
    log.warn({ senderId, cooldownMs: COOLDOWN_MS }, 'sender circuit breaker tripped');
  }
}
