import { HOUR_MS, hourWindowStart } from '../ratelimit/limiter.js';

/**
 * Schedule planning.
 *
 * This answers the assignment's "what happens when 1000+ emails are scheduled
 * for roughly the same time?" question at *schedule* time rather than leaving it
 * to the limiter at send time.
 *
 * The naive approach gives every recipient the same `startAt`. 1000 jobs then
 * become runnable simultaneously, the workers pull them, and the limiter denies
 * all but a handful -- so 990 jobs get re-delayed, wake up together again, and
 * thrash. It converges, but it burns Redis round-trips, loses ordering, and the
 * dashboard cannot tell the user when anything will actually be sent.
 *
 * Instead the planner precomputes a plan that already satisfies both the
 * minimum-gap and per-sender-hourly constraints, spreading work across senders
 * and across hour windows. Two useful consequences:
 *
 *   - 1000 emails at 200/hour across 2 senders is laid out over ~2.5 hours, and
 *     the UI can show each recipient's real predicted send time immediately.
 *   - the runtime limiter becomes a *safety net* (for competing campaigns,
 *     restarts, clock drift) rather than the primary pacing mechanism. Both
 *     layers enforce the same rule, which is what makes the guarantee hold even
 *     if the plan turns out to be optimistic.
 */

export interface PlanInput {
  recipientCount: number;
  /** Senders to round-robin across; must be >= 1. */
  senderCount: number;
  /** Epoch ms at which the campaign may begin. */
  startAt: number;
  /** Minimum gap between two sends from the same sender. */
  minDelayMs: number;
  /** Per-sender hourly ceiling. */
  perSenderHourly: number;
}

export interface PlannedSlot {
  /** Index into the sender pool (round-robin). */
  senderIndex: number;
  /** Epoch ms this email should be sent at. */
  runAt: number;
}

export function planSchedule(input: PlanInput): PlannedSlot[] {
  const { recipientCount, startAt, minDelayMs } = input;
  const senderCount = Math.max(1, input.senderCount);
  const perSenderHourly = Math.max(1, input.perSenderHourly);
  const gap = Math.max(0, minDelayMs);

  // Per-sender cursor: earliest moment that sender may send again.
  const nextFreeAt = new Array<number>(senderCount).fill(startAt);
  // Per-sender usage of the hour window the cursor currently sits in. Only the
  // current window needs tracking, because the cursor only ever moves forward.
  const windowStart = new Array<number>(senderCount).fill(hourWindowStart(startAt));
  const windowUsed = new Array<number>(senderCount).fill(0);

  const plan: PlannedSlot[] = [];

  for (let i = 0; i < recipientCount; i += 1) {
    const s = i % senderCount;
    let candidate = nextFreeAt[s]!;

    // Roll forward until the candidate instant sits in a window with capacity.
    for (;;) {
      const w = hourWindowStart(candidate);
      if (w !== windowStart[s]!) {
        // Cursor crossed into a new window: its quota resets.
        windowStart[s] = w;
        windowUsed[s] = 0;
      }
      if (windowUsed[s]! < perSenderHourly) break;
      // Window is full -- jump to the start of the next one.
      candidate = windowStart[s]! + HOUR_MS;
    }

    plan.push({ senderIndex: s, runAt: candidate });
    windowUsed[s] = windowUsed[s]! + 1;
    nextFreeAt[s] = candidate + gap;
  }

  return plan;
}

/**
 * Human-readable summary of a plan, returned by the schedule API so the UI can
 * say "1,000 emails across 2 senders, finishing at 01:30" before anything sends.
 */
export interface PlanSummary {
  totalEmails: number;
  senderCount: number;
  firstSendAt: string | null;
  lastSendAt: string | null;
  /** Wall-clock span of the campaign in minutes. */
  spanMinutes: number;
  /** Number of distinct hour windows the campaign occupies. */
  windowsUsed: number;
  effectiveMinDelayMs: number;
  perSenderHourly: number;
}

export function summarisePlan(plan: PlannedSlot[], input: PlanInput): PlanSummary {
  if (plan.length === 0) {
    return {
      totalEmails: 0,
      senderCount: input.senderCount,
      firstSendAt: null,
      lastSendAt: null,
      spanMinutes: 0,
      windowsUsed: 0,
      effectiveMinDelayMs: input.minDelayMs,
      perSenderHourly: input.perSenderHourly,
    };
  }

  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  const windows = new Set<number>();
  for (const slot of plan) {
    if (slot.runAt < first) first = slot.runAt;
    if (slot.runAt > last) last = slot.runAt;
    windows.add(hourWindowStart(slot.runAt));
  }

  return {
    totalEmails: plan.length,
    senderCount: Math.max(1, input.senderCount),
    firstSendAt: new Date(first).toISOString(),
    lastSendAt: new Date(last).toISOString(),
    spanMinutes: Math.round(((last - first) / 60_000) * 10) / 10,
    windowsUsed: windows.size,
    effectiveMinDelayMs: input.minDelayMs,
    perSenderHourly: input.perSenderHourly,
  };
}
