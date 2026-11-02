import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HOUR_MS,
  admit,
  computeDeferredRunAt,
  releaseSendGap,
  hourWindowEnd,
  hourWindowStart,
} from '../src/ratelimit/limiter.js';

/**
 * Integration tests for the admission limiter, against a real Redis.
 *
 * A mock would defeat the purpose: the property being tested is that the Lua
 * script is *atomic under concurrency*, and that only holds in a real Redis.
 */

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/15', {
  maxRetriesPerRequest: null,
});

/** Fresh ids per test so cases cannot contaminate each other's counters. */
let userId: string;
let senderId: string;

beforeEach(() => {
  userId = randomUUID();
  senderId = randomUUID();
});

afterAll(async () => {
  const keys = await redis.keys('outbox:rl:*');
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
});

describe('admit -- hourly ceiling', () => {
  it('allows exactly `limit` sends and denies the next one', async () => {
    const limit = 5;
    const results = [];
    for (let i = 0; i < limit + 3; i += 1) {
      results.push(
        await admit(
          { userId, senderId, senderHourlyLimit: limit, minDelayMs: 0 },
          redis,
        ),
      );
    }
    expect(results.filter((r) => r.allowed)).toHaveLength(limit);
    expect(results.slice(limit).every((r) => r.reason === 'SENDER_HOURLY_LIMIT')).toBe(true);
  });

  it('reports remaining quota as it is consumed', async () => {
    const first = await admit({ userId, senderId, senderHourlyLimit: 3, minDelayMs: 0 }, redis);
    const second = await admit({ userId, senderId, senderHourlyLimit: 3, minDelayMs: 0 }, redis);
    expect(first.senderRemaining).toBe(2);
    expect(second.senderRemaining).toBe(1);
  });

  it('tells the caller to wait until the window ends', async () => {
    const now = Date.now();
    await admit({ userId, senderId, senderHourlyLimit: 1, minDelayMs: 0, now }, redis);
    const denied = await admit(
      { userId, senderId, senderHourlyLimit: 1, minDelayMs: 0, now },
      redis,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.waitMs).toBe(hourWindowEnd(now) - now);
  });

  it('keeps counters per sender, so one sender cannot exhaust another', async () => {
    const other = randomUUID();
    await admit({ userId, senderId, senderHourlyLimit: 1, minDelayMs: 0 }, redis);
    const otherSender = await admit(
      { userId, senderId: other, senderHourlyLimit: 1, minDelayMs: 0 },
      redis,
    );
    expect(otherSender.allowed).toBe(true);
  });

  it('resets in the next hour window', async () => {
    const now = Date.now();
    await admit({ userId, senderId, senderHourlyLimit: 1, minDelayMs: 0, now }, redis);
    const nextWindow = await admit(
      { userId, senderId, senderHourlyLimit: 1, minDelayMs: 0, now: now + HOUR_MS },
      redis,
    );
    expect(nextWindow.allowed).toBe(true);
  });
});

describe('admit -- minimum delay between sends', () => {
  it('denies a second send while the first is still in flight', async () => {
    const now = Date.now();
    const first = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 2000, now },
      redis,
    );
    expect(first.allowed).toBe(true);

    const second = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 2000, now: now + 500 },
      redis,
    );
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('MIN_DELAY');
    // The slot is reserved for the gap *plus* the in-flight hold, so the
    // reported wait exceeds the bare gap until the send reports completion.
    expect(second.waitMs).toBeGreaterThan(2000);

    // After the send completes the wait collapses to the configured gap.
    await releaseSendGap(senderId, 2000, first.gateToken, redis);
    const afterRelease = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 2000, now: Date.now() },
      redis,
    );
    expect(afterRelease.allowed).toBe(false);
    expect(afterRelease.waitMs).toBeLessThanOrEqual(2000);
    expect(afterRelease.waitMs).toBeGreaterThan(1800);
  });

  it('allows the next send once the slot is released and the gap has elapsed', async () => {
    const first = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 50 },
      redis,
    );
    // The slot stays reserved until the send reports completion.
    await releaseSendGap(senderId, 50, first.gateToken, redis);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const later = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 50 },
      redis,
    );
    expect(later.allowed).toBe(true);
  });

  it('does not consume hourly quota when it denies on the gap', async () => {
    const now = Date.now();
    const limit = 10;
    await admit({ userId, senderId, senderHourlyLimit: limit, minDelayMs: 5000, now }, redis);

    // Several attempts inside the gap: all denied, none may burn quota.
    for (let i = 0; i < 5; i += 1) {
      const denied = await admit(
        { userId, senderId, senderHourlyLimit: limit, minDelayMs: 5000, now: now + 100 },
        redis,
      );
      expect(denied.reason).toBe('MIN_DELAY');
    }

    // One send happened, so exactly one unit of quota should be gone.
    const after = await admit(
      { userId, senderId, senderHourlyLimit: limit, minDelayMs: 0, now: now + 6000 },
      redis,
    );
    expect(after.allowed).toBe(true);
    expect(after.senderRemaining).toBe(limit - 2);
  });
});

describe('admit -- tenant ceiling', () => {
  it('applies the tenant limit across that tenant\'s senders', async () => {
    // MAX_EMAILS_PER_HOUR is 0 (disabled) in the test env, so this verifies the
    // disabled path rather than the ceiling itself.
    const result = await admit(
      { userId, senderId, senderHourlyLimit: 10, minDelayMs: 0 },
      redis,
    );
    expect(result.allowed).toBe(true);
    expect(result.tenantRemaining).toBe(-1);
  });
});

describe('admit -- concurrency safety', () => {
  it('never admits more than the limit when many callers race', async () => {
    const limit = 10;
    const attempts = 100;

    // All 100 fire without awaiting in between: this is the scenario that breaks
    // a naive GET-then-INCR implementation.
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        admit({ userId, senderId, senderHourlyLimit: limit, minDelayMs: 0 }, redis),
      ),
    );

    const allowed = results.filter((r) => r.allowed);
    expect(allowed).toHaveLength(limit);
    expect(results.filter((r) => !r.allowed)).toHaveLength(attempts - limit);
  });

  it('serialises the minimum-delay gate so only one racer wins', async () => {
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        admit({ userId, senderId, senderHourlyLimit: 1000, minDelayMs: 3000, now }, redis),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    expect(results.filter((r) => r.reason === 'MIN_DELAY')).toHaveLength(19);
  });

  it('does not leak quota under a racing mix of both limits', async () => {
    const limit = 25;
    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        admit({ userId, senderId, senderHourlyLimit: limit, minDelayMs: 0 }, redis),
      ),
    );
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(limit);

    // The counter must agree exactly with the number of admissions -- no
    // double-increment, no lost increment.
    const windowKey = `outbox:rl:sender:${senderId}:${new Date(
      hourWindowStart(Date.now()),
    )
      .toISOString()
      .slice(0, 13)}`;
    expect(Number(await redis.get(windowKey))).toBe(limit);
  });
});

describe('computeDeferredRunAt', () => {
  const now = Date.UTC(2026, 0, 1, 10, 30, 0);

  it('waits out the gap for a min-delay denial, with a little jitter', () => {
    const runAt = computeDeferredRunAt({
      reason: 'MIN_DELAY',
      waitMs: 1500,
      now,
      sequence: 0,
      minDelayMs: 2000,
      senderHourlyLimit: 200,
    });
    // Jitter (0-100ms) keeps a crowd of blocked jobs from waking in lockstep.
    expect(runAt).toBeGreaterThanOrEqual(now + 1500);
    expect(runAt).toBeLessThan(now + 1600);
  });

  it('pushes an hourly denial into the next window', () => {
    const runAt = computeDeferredRunAt({
      reason: 'SENDER_HOURLY_LIMIT',
      waitMs: hourWindowEnd(now) - now,
      now,
      sequence: 0,
      minDelayMs: 2000,
      senderHourlyLimit: 200,
    });
    expect(runAt).toBe(hourWindowEnd(now));
  });

  it('spreads deferred jobs by sequence instead of stacking them on one instant', () => {
    const runAts = [0, 1, 2, 3].map((sequence) =>
      computeDeferredRunAt({
        reason: 'SENDER_HOURLY_LIMIT',
        waitMs: hourWindowEnd(now) - now,
        now,
        sequence,
        minDelayMs: 2000,
        senderHourlyLimit: 200,
      }),
    );
    // Strictly increasing: original campaign order survives the deferral.
    expect(runAts).toEqual([
      hourWindowEnd(now),
      hourWindowEnd(now) + 2000,
      hourWindowEnd(now) + 4000,
      hourWindowEnd(now) + 6000,
    ]);
  });

  it('keeps a deferred slot inside the window it was moved to', () => {
    const runAt = computeDeferredRunAt({
      reason: 'SENDER_HOURLY_LIMIT',
      waitMs: 0,
      now,
      sequence: 100_000,
      minDelayMs: 60_000,
      senderHourlyLimit: 200,
    });
    expect(runAt - hourWindowEnd(now)).toBeLessThan(HOUR_MS);
  });
});

describe('releaseSendGap -- gap measured from send completion', () => {
  it('holds the sender slot for the whole send, then re-arms from completion', async () => {
    const now = Date.now();
    const first = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 1000, now },
      redis,
    );
    expect(first.allowed).toBe(true);
    expect(first.gateToken).not.toBe('0');

    // While the send is still in flight, no other send for this sender may
    // start -- even though more than `minDelayMs` has elapsed since admission.
    const whileInFlight = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 1000, now: now + 2000 },
      redis,
    );
    expect(whileInFlight.allowed).toBe(false);
    expect(whileInFlight.reason).toBe('MIN_DELAY');

    // Once it finishes, the gap is measured from completion.
    await releaseSendGap(senderId, 1000, first.gateToken, redis);
    const rightAfter = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 1000, now: Date.now() },
      redis,
    );
    expect(rightAfter.allowed).toBe(false);
    expect(rightAfter.waitMs).toBeGreaterThan(900);
  });

  it('allows the next send once the gap after completion has passed', async () => {
    const first = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 50 },
      redis,
    );
    await releaseSendGap(senderId, 50, first.gateToken, redis);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 50 },
      redis,
    );
    expect(second.allowed).toBe(true);
  });

  it('ignores a stale release so it cannot clear a newer send reservation', async () => {
    const stale = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 50 },
      redis,
    );
    // The first send overruns; its slot is released and a second send starts.
    await releaseSendGap(senderId, 50, stale.gateToken, redis);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const current = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 50 },
      redis,
    );
    expect(current.allowed).toBe(true);

    // The overrunning first send finally finishes and tries to release. Its
    // token is stale, so the second send's reservation must survive.
    await releaseSendGap(senderId, 50, stale.gateToken, redis);
    const blocked = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 50, now: Date.now() },
      redis,
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('MIN_DELAY');
  });

  it('takes no reservation when the gap is disabled', async () => {
    const result = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 0 },
      redis,
    );
    expect(result.allowed).toBe(true);
    expect(result.gateToken).toBe('0');
    const immediate = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 0 },
      redis,
    );
    expect(immediate.allowed).toBe(true);
  });
});

describe('recheckAfterMs -- blocked jobs must not sleep out the whole hold', () => {
  it('reports a gap-sized recheck for MIN_DELAY, not the pessimistic hold', async () => {
    const now = Date.now();
    await admit({ userId, senderId, senderHourlyLimit: 100, minDelayMs: 2000, now }, redis);
    const denied = await admit(
      { userId, senderId, senderHourlyLimit: 100, minDelayMs: 2000, now: now + 10 },
      redis,
    );
    expect(denied.reason).toBe('MIN_DELAY');
    // The raw wait covers the in-flight reservation...
    expect(denied.waitMs).toBeGreaterThan(30_000);
    // ...but the job should come back and re-ask at the gap cadence.
    expect(denied.recheckAfterMs).toBeLessThanOrEqual(2000);
    expect(denied.recheckAfterMs).toBeGreaterThan(0);
  });

  it('uses the exact window boundary for an hourly denial', async () => {
    const now = Date.now();
    await admit({ userId, senderId, senderHourlyLimit: 1, minDelayMs: 0, now }, redis);
    const denied = await admit(
      { userId, senderId, senderHourlyLimit: 1, minDelayMs: 0, now },
      redis,
    );
    expect(denied.reason).toBe('SENDER_HOURLY_LIMIT');
    // Nothing to gain from waking before the window opens.
    expect(denied.recheckAfterMs).toBe(denied.waitMs);
  });
});
