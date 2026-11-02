import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { key, redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import {
  ADMIT_SCRIPT,
  NOTIFY_ONCE_SCRIPT,
  PEEK_SCRIPT,
  RELEASE_GAP_SCRIPT,
} from './scripts.js';

const log = logger.child({ mod: 'ratelimit' });

export const HOUR_MS = 3_600_000;

export type DenyReason = 'SENDER_HOURLY_LIMIT' | 'TENANT_HOURLY_LIMIT' | 'MIN_DELAY';
export type AdmitReason = 'OK' | DenyReason;

export interface AdmitRequest {
  userId: string;
  senderId: string;
  /** Per-campaign override; falls back to the sender's own cap, then to env. */
  senderHourlyLimit?: number | null;
  /** Per-campaign override of the inter-send gap. */
  minDelayMs?: number | null;
  now?: number;
}

export interface AdmitResult {
  allowed: boolean;
  /** How long to wait before this email becomes sendable. 0 when allowed. */
  waitMs: number;
  /**
   * When to *re-ask*, which is not always the same as `waitMs`.
   *
   * A MIN_DELAY denial reports the remaining in-flight reservation, which is a
   * deliberately pessimistic upper bound (gap + SEND_HOLD_MS). Sleeping for that
   * long would turn a 1.5-second send into a 37-second stall for every blocked
   * job. The reservation is released as soon as the send finishes, so the right
   * move is to re-check at roughly the gap cadence instead.
   *
   * An hourly denial is different: the window boundary is an exact instant, so
   * there is nothing to gain by waking earlier and `recheckAfterMs == waitMs`.
   */
  recheckAfterMs: number;
  reason: AdmitReason;
  senderRemaining: number;
  /** -1 when the tenant ceiling is disabled. */
  tenantRemaining: number;
  /** Which hour bucket the decision was made against. */
  windowStart: number;
  windowEnd: number;
  /**
   * Fencing token for the in-flight reservation. Pass it to `releaseSendGap`
   * when the send finishes. '0' when no reservation was taken (gap disabled or
   * admission denied).
   */
  gateToken: string;
}

/** Fixed hour buckets, aligned to the epoch. */
export const hourWindowStart = (now: number) => Math.floor(now / HOUR_MS) * HOUR_MS;
export const hourWindowEnd = (now: number) => hourWindowStart(now) + HOUR_MS;
/** Stable, human-greppable bucket id, e.g. 2026-11-01T22. */
export const windowLabel = (now: number) => new Date(hourWindowStart(now)).toISOString().slice(0, 13);

const senderKey = (senderId: string, now: number) =>
  key('rl', 'sender', senderId, windowLabel(now));
const tenantKey = (userId: string, now: number) => key('rl', 'tenant', userId, windowLabel(now));
const gapKey = (senderId: string) => key('rl', 'gap', senderId);
const gapTokenKey = (senderId: string) => key('rl', 'gaptok', senderId);

interface LimiterCommands extends Redis {
  outboxAdmit(
    k1: string,
    k2: string,
    k3: string,
    k4: string,
    now: string,
    senderLimit: string,
    tenantLimit: string,
    minGapMs: string,
    windowEndsAt: string,
    ttl: string,
    holdMs: string,
  ): Promise<[number, number, string, number, number, string]>;
  outboxNotifyOnce(k1: string, ttl: string): Promise<number>;
  outboxPeek(k1: string, k2: string, k3: string): Promise<[number, number, number]>;
  outboxReleaseGap(k1: string, k2: string, now: string, gapMs: string, token: string): Promise<number>;
}

let defined = false;

/**
 * ioredis caches the script by SHA after the first EVAL, so subsequent calls are
 * EVALSHA round-trips. Defining lazily keeps module import side-effect free
 * (important for tests that point at a different Redis).
 */
function commands(client: Redis = redis): LimiterCommands {
  const c = client as LimiterCommands;
  if (!defined || client !== redis) {
    if (!(c as unknown as Record<string, unknown>).outboxAdmit) {
      client.defineCommand('outboxAdmit', { numberOfKeys: 4, lua: ADMIT_SCRIPT });
      client.defineCommand('outboxNotifyOnce', { numberOfKeys: 1, lua: NOTIFY_ONCE_SCRIPT });
      client.defineCommand('outboxPeek', { numberOfKeys: 3, lua: PEEK_SCRIPT });
      client.defineCommand('outboxReleaseGap', { numberOfKeys: 2, lua: RELEASE_GAP_SCRIPT });
    }
    if (client === redis) defined = true;
  }
  return c;
}

/**
 * Ask permission to send one email, reserving capacity if granted.
 *
 * This is the only place in the codebase allowed to decide "may this send
 * happen now?". The worker treats the answer as final.
 */
export async function admit(req: AdmitRequest, client?: Redis): Promise<AdmitResult> {
  const now = req.now ?? Date.now();
  const senderLimit = Math.max(
    1,
    req.senderHourlyLimit ?? env.MAX_EMAILS_PER_HOUR_PER_SENDER,
  );
  const tenantLimit = env.MAX_EMAILS_PER_HOUR;
  const minGapMs = Math.max(0, req.minDelayMs ?? env.MIN_DELAY_BETWEEN_EMAILS_MS);
  const windowEnd = hourWindowEnd(now);

  const [allowed, waitMs, reason, senderRemaining, tenantRemaining, gateToken] = await commands(
    client,
  ).outboxAdmit(
    senderKey(req.senderId, now),
    tenantKey(req.userId, now),
    gapKey(req.senderId),
    gapTokenKey(req.senderId),
    String(now),
    String(senderLimit),
    String(tenantLimit),
    String(minGapMs),
    String(windowEnd),
    // Two hours of TTL: long enough that a clock skew near the boundary cannot
    // drop a live counter, short enough that keys self-expire.
    String(Math.ceil((HOUR_MS * 2) / 1000)),
    String(env.SEND_HOLD_MS),
  );

  const resolvedReason = reason as AdmitReason;
  const resolvedWait = Number(waitMs);

  const result: AdmitResult = {
    allowed: allowed === 1,
    waitMs: resolvedWait,
    recheckAfterMs:
      resolvedReason === 'MIN_DELAY'
        ? // Poll at the gap cadence (never longer than the real wait, never a
          // tight spin) so a blocked job starts promptly once the slot frees.
          Math.min(resolvedWait, Math.max(minGapMs, 250))
        : resolvedWait,
    reason: resolvedReason,
    senderRemaining: Number(senderRemaining),
    tenantRemaining: Number(tenantRemaining),
    windowStart: hourWindowStart(now),
    windowEnd,
    gateToken: String(gateToken),
  };

  if (!result.allowed) {
    log.debug(
      { senderId: req.senderId, reason: result.reason, waitMs: result.waitMs },
      'send denied by limiter',
    );
  }
  return result;
}

/**
 * End the in-flight reservation taken by `admit` and re-arm the delay from now.
 *
 * Must be called once per admitted attempt, on success *and* on failure: a
 * failed send still occupied the provider connection, so the next one waits the
 * full gap too. Skipping it would leave the sender blocked until the hold TTL
 * expires. See RELEASE_GAP_SCRIPT for the fencing-token rationale.
 */
export async function releaseSendGap(
  senderId: string,
  minDelayMs: number | null | undefined,
  gateToken: string,
  client?: Redis,
): Promise<void> {
  const gap = Math.max(0, minDelayMs ?? env.MIN_DELAY_BETWEEN_EMAILS_MS);
  if (gap === 0 || gateToken === '0') return;
  await commands(client).outboxReleaseGap(
    gapKey(senderId),
    gapTokenKey(senderId),
    String(Date.now()),
    String(gap),
    gateToken,
  );
}

/**
 * Read-only snapshot of a sender's current hour usage, for the dashboard.
 */
export async function peek(
  userId: string,
  senderId: string,
  now = Date.now(),
): Promise<{ senderUsed: number; tenantUsed: number; nextSendAllowedAt: number }> {
  const [senderUsed, tenantUsed, nextAllowed] = await commands().outboxPeek(
    senderKey(senderId, now),
    tenantKey(userId, now),
    gapKey(senderId),
  );
  return {
    senderUsed: Number(senderUsed),
    tenantUsed: Number(tenantUsed),
    nextSendAllowedAt: Number(nextAllowed),
  };
}

/**
 * Returns true at most once per `ttlSeconds` for a given key. Used to collapse a
 * storm of rate-limit hits into a single Slack message.
 */
export async function claimNotificationSlot(
  scope: string,
  ttlSeconds: number,
): Promise<boolean> {
  const claimed = await commands().outboxNotifyOnce(key('notify', scope), String(ttlSeconds));
  return claimed === 1;
}

/**
 * Where to put a deferred email.
 *
 * A naive implementation re-delays every blocked job to the same instant, which
 * means 800 jobs wake up simultaneously at the top of the hour, stampede the
 * limiter, and get re-deferred in random order -- destroying campaign ordering.
 *
 * Instead each job is placed at `windowStart + sequence * gap`, so the original
 * campaign order is reconstructed inside the new window and jobs wake up spread
 * out rather than all at once. The slot is clamped to stay inside the window;
 * anything that overflows lands at the end and rolls into the following hour on
 * its next evaluation.
 */
export function computeDeferredRunAt(opts: {
  reason: DenyReason;
  /** Use the limiter's `recheckAfterMs`, not `waitMs` -- see AdmitResult. */
  waitMs: number;
  now: number;
  /** 0-based position of this email within its campaign. */
  sequence: number;
  minDelayMs: number;
  senderHourlyLimit: number;
}): number {
  const { reason, waitMs, now, sequence, minDelayMs, senderHourlyLimit } = opts;

  // A min-delay denial means "someone else holds the slot". Come back at the
  // gap cadence with a little jitter, so a crowd of blocked jobs does not wake
  // in lockstep and re-contend on the same millisecond.
  if (reason === 'MIN_DELAY') {
    const base = Math.max(waitMs, 50);
    return now + base + Math.floor(Math.random() * 100);
  }

  // An hourly denial means "not until the next window opens".
  const nextWindowStart = hourWindowEnd(now);
  // Position within the next window, preserving campaign order. Jobs beyond the
  // window's capacity are spread across subsequent windows by the same formula.
  const slot = sequence % Math.max(1, senderHourlyLimit);
  const offset = Math.min(slot * Math.max(minDelayMs, 1), HOUR_MS - 1000);
  return nextWindowStart + offset;
}
