import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { reconcileReclaimed, reconcileRequeued } from '../lib/metrics.js';
import { key, redis } from '../lib/redis.js';
import { publishEvent } from '../realtime/events.js';
import { enqueueJobs } from './scheduler.js';
import { emailQueue } from './queues.js';
import { findAbandonedJobs, findSchedulableJobs, reclaimAbandoned } from './repository.js';

const log = logger.child({ mod: 'reconciler' });

/**
 * Restart recovery.
 *
 * BullMQ's delayed set lives in Redis, and Redis with AOF/RDB persistence
 * survives an ordinary restart on its own -- so the baseline requirement ("stop
 * the server, start it again, future emails still send at the right time") is
 * already met by the delayed-job design alone.
 *
 * This reconciler covers the cases that persistence does *not*:
 *
 *   a) Redis lost data -- it was flushed, started without AOF, failed over to an
 *      empty replica, or runs in a container with no volume. Postgres still has
 *      every SCHEDULED row, so the queue is rebuilt from it. Without this, those
 *      emails would never send and nothing would report an error.
 *   b) A worker died mid-send. Its row is stuck in SENDING with a lease nobody
 *      owns. The lease expiry distinguishes "in flight right now" from
 *      "abandoned", so the job becomes eligible again instead of being stranded.
 *   c) The service was down *over* a send time. Those rows are already due, get
 *      re-enqueued with zero delay, and go out immediately -- rate-limited on
 *      the way out, so a long outage does not turn into a burst that trips the
 *      provider.
 *
 * Crucially this is not a cron and not a scheduler: it never decides *when* an
 * email sends (that is always `scheduled_at` + a BullMQ delayed job). It only
 * repairs divergence between the durable ledger and the queue. Re-enqueueing is
 * safe to run as often as you like because `jobId` is the row id, so adding an
 * existing job is a no-op.
 */

const BATCH_SIZE = 1000;
const LOCK_KEY = key('lock', 'reconcile');
const LOCK_TTL_SECONDS = 120;

export interface ReconcileReport {
  checked: number;
  requeued: number;
  reclaimed: number;
  skippedAlreadyQueued: number;
  tookMs: number;
}

/**
 * A Redis lock keeps concurrent workers from doing the same sweep. Correctness
 * does not depend on it (every operation is idempotent) -- it just avoids N
 * workers doing identical work on boot.
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const acquired = await redis.set(LOCK_KEY, process.pid.toString(), 'EX', LOCK_TTL_SECONDS, 'NX');
  if (!acquired) {
    log.debug('reconcile already running elsewhere; skipping');
    return null;
  }
  try {
    return await fn();
  } finally {
    await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

export async function reconcile(): Promise<ReconcileReport | null> {
  return withLock(async () => {
    const started = Date.now();
    const report: ReconcileReport = {
      checked: 0,
      requeued: 0,
      reclaimed: 0,
      skippedAlreadyQueued: 0,
      tookMs: 0,
    };

    // ---- (b) reclaim jobs abandoned by a dead worker ----------------------
    const abandoned = await findAbandonedJobs(BATCH_SIZE);
    if (abandoned.length > 0) {
      report.reclaimed = await reclaimAbandoned(abandoned.map((j) => j.id));
      reconcileReclaimed.inc(report.reclaimed);
      log.warn({ reclaimed: report.reclaimed }, 'reclaimed jobs with expired leases');
    }

    // ---- (a) + (c) rebuild the queue from the durable ledger --------------
    const pending = await findSchedulableJobs(BATCH_SIZE);
    report.checked = pending.length;

    if (pending.length > 0) {
      // One pipeline instead of N round-trips to ask "does this job exist?".
      // `toKey` is BullMQ's own key builder -- hand-assembling the key would
      // break silently if the library changes its prefix layout.
      const pipeline = redis.pipeline();
      for (const row of pending) {
        pipeline.exists(emailQueue.toKey(row.id));
      }
      const results = await pipeline.exec();

      const missing = pending.filter((_row, i) => {
        const [err, exists] = results?.[i] ?? [null, 0];
        // On a Redis error, assume missing: re-adding is a harmless no-op,
        // whereas wrongly assuming present would lose the email.
        if (err) return true;
        return Number(exists) === 0;
      });

      report.skippedAlreadyQueued = pending.length - missing.length;

      if (missing.length > 0) {
        report.requeued = await enqueueJobs(missing);
        reconcileRequeued.inc(report.requeued);
        const overdue = missing.filter((j) => j.scheduledAt.getTime() <= Date.now()).length;
        log.warn(
          { requeued: report.requeued, overdue },
          're-enqueued durable jobs that were missing from redis',
        );
      }
    }

    report.tookMs = Date.now() - started;

    if (report.requeued > 0 || report.reclaimed > 0) {
      // Tell every connected dashboard so the tables refresh themselves.
      const userIds = new Set([...pending, ...abandoned].map((j) => j.userId));
      for (const userId of userIds) {
        void publishEvent(userId, {
          type: 'reconcile.done',
          requeued: report.requeued,
          reclaimed: report.reclaimed,
        });
      }
    }

    log.info(report, 'reconcile sweep complete');
    return report;
  });
}

let timer: NodeJS.Timeout | null = null;

/**
 * Periodic sweep.
 *
 * This is a `setInterval` inside the worker process -- explicitly *not* a cron
 * job and not an OS timer, and it does not schedule any email. Its only job is
 * to detect divergence between Postgres and Redis (which can appear at any time,
 * not just at boot) and repair it.
 */
export function startReconciler(): void {
  if (env.RECONCILE_ON_BOOT) {
    void reconcile().catch((err) => log.error({ err }, 'boot reconcile failed'));
  }
  timer = setInterval(() => {
    void reconcile().catch((err) => log.error({ err }, 'periodic reconcile failed'));
  }, env.RECONCILE_INTERVAL_MS);
  // Don't hold the event loop open on shutdown.
  timer.unref();
  log.info({ intervalMs: env.RECONCILE_INTERVAL_MS }, 'reconciler started');
}

export function stopReconciler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
