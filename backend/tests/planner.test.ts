import { describe, expect, it } from 'vitest';
import { planSchedule, summarisePlan } from '../src/queue/planner.js';
import { HOUR_MS, hourWindowStart } from '../src/ratelimit/limiter.js';

/** Fixed base so assertions are not affected by where "now" falls in an hour. */
const BASE = Date.UTC(2026, 0, 1, 10, 0, 0);

describe('planSchedule', () => {
  it('spaces sends from one sender by at least the minimum delay', () => {
    const plan = planSchedule({
      recipientCount: 5,
      senderCount: 1,
      startAt: BASE,
      minDelayMs: 2000,
      perSenderHourly: 1000,
    });
    expect(plan.map((p) => p.runAt - BASE)).toEqual([0, 2000, 4000, 6000, 8000]);
  });

  it('round-robins across senders so each one keeps its own spacing', () => {
    const plan = planSchedule({
      recipientCount: 4,
      senderCount: 2,
      startAt: BASE,
      minDelayMs: 2000,
      perSenderHourly: 1000,
    });
    expect(plan.map((p) => p.senderIndex)).toEqual([0, 1, 0, 1]);
    // Two senders each send at t=0, then each again at t=2000: double throughput
    // without either sender violating its own gap.
    expect(plan.map((p) => p.runAt - BASE)).toEqual([0, 0, 2000, 2000]);
  });

  it('never exceeds the per-sender hourly cap within one window', () => {
    const perSenderHourly = 10;
    const plan = planSchedule({
      recipientCount: 35,
      senderCount: 1,
      startAt: BASE,
      minDelayMs: 1000,
      perSenderHourly,
    });

    const perWindow = new Map<number, number>();
    for (const slot of plan) {
      const w = hourWindowStart(slot.runAt);
      perWindow.set(w, (perWindow.get(w) ?? 0) + 1);
    }
    for (const count of perWindow.values()) {
      expect(count).toBeLessThanOrEqual(perSenderHourly);
    }
    expect(plan).toHaveLength(35);
  });

  it('rolls overflow into the following hour windows', () => {
    const plan = planSchedule({
      recipientCount: 25,
      senderCount: 1,
      startAt: BASE,
      minDelayMs: 1000,
      perSenderHourly: 10,
    });
    const windows = new Set(plan.map((p) => hourWindowStart(p.runAt)));
    // 25 emails at 10/hour needs three windows.
    expect(windows.size).toBe(3);
    // The first email of window 2 lands exactly at the window boundary.
    expect(plan[10]!.runAt).toBe(hourWindowStart(BASE) + HOUR_MS);
  });

  it('keeps run times non-decreasing, so campaign order is preserved per sender', () => {
    const plan = planSchedule({
      recipientCount: 50,
      senderCount: 3,
      startAt: BASE,
      minDelayMs: 1500,
      perSenderHourly: 7,
    });
    for (let s = 0; s < 3; s += 1) {
      const times = plan.filter((p) => p.senderIndex === s).map((p) => p.runAt);
      const sorted = [...times].sort((a, b) => a - b);
      expect(times).toEqual(sorted);
    }
  });

  it('handles the 1000-emails-at-once case without stacking them on one instant', () => {
    const plan = planSchedule({
      recipientCount: 1000,
      senderCount: 2,
      startAt: BASE,
      minDelayMs: 2000,
      perSenderHourly: 200,
    });
    const distinct = new Set(plan.map((p) => p.runAt));
    // The naive implementation would produce exactly one distinct time.
    expect(distinct.size).toBeGreaterThan(400);

    const summary = summarisePlan(plan, {
      recipientCount: 1000,
      senderCount: 2,
      startAt: BASE,
      minDelayMs: 2000,
      perSenderHourly: 200,
    });
    // 1000 emails / (2 senders x 200 per hour) = 2.5 hours of work.
    expect(summary.windowsUsed).toBe(3);
    expect(summary.totalEmails).toBe(1000);
  });

  it('treats a zero minimum delay as allowed', () => {
    const plan = planSchedule({
      recipientCount: 3,
      senderCount: 1,
      startAt: BASE,
      minDelayMs: 0,
      perSenderHourly: 100,
    });
    expect(plan.every((p) => p.runAt === BASE)).toBe(true);
  });

  it('returns an empty plan for no recipients', () => {
    expect(
      planSchedule({
        recipientCount: 0,
        senderCount: 2,
        startAt: BASE,
        minDelayMs: 1000,
        perSenderHourly: 10,
      }),
    ).toEqual([]);
  });
});
