import { Worker } from 'bullmq';
import { env } from './config/env.js';
import { closeDb } from './db/client.js';
import { logger } from './lib/logger.js';
import { closeRedis, queueRedis } from './lib/redis.js';
import { closeTransports } from './mailer/transport.js';
import { processEmailJob } from './queue/processor.js';
import { EMAIL_QUEUE_NAME, closeQueues, type EmailJobPayload } from './queue/queues.js';
import { markExhausted } from './queue/repository.js';
import { startReconciler, stopReconciler } from './queue/reconciler.js';
import { closeEvents } from './realtime/events.js';
import { ensureIndex } from './search/elastic.js';

const log = logger.child({ proc: 'worker' });

/**
 * Worker process.
 *
 * Runs separately from the API so a traffic spike on the dashboard cannot starve
 * sending, and so workers scale independently (start N of these; the limiter and
 * the claim are both cross-process safe, so they cooperate without coordination).
 */
async function main(): Promise<void> {
  await ensureIndex();

  const worker = new Worker<EmailJobPayload>(EMAIL_QUEUE_NAME, processEmailJob, {
    connection: queueRedis,
    prefix: env.REDIS_PREFIX,
    // Jobs handled in parallel by this process. The per-send guarantees do not
    // depend on this being 1: ordering and pacing come from the limiter and the
    // atomic claim, not from serialising the worker.
    concurrency: env.WORKER_CONCURRENCY,
    // Coarse safety valve in front of the precise Redis limiter, so a backlog
    // cannot slam SMTP in the instant a window opens.
    limiter: { max: env.QUEUE_LIMITER_MAX, duration: env.QUEUE_LIMITER_DURATION_MS },
    // A send that outlives its lock is assumed stalled and is retried. Kept
    // under JOB_LEASE_MS so BullMQ and the DB lease agree on what "stuck" means.
    lockDuration: Math.min(env.JOB_LEASE_MS, 60_000),
    stalledInterval: 30_000,
    maxStalledCount: 2,
  });

  worker.on('ready', () =>
    log.info(
      {
        concurrency: env.WORKER_CONCURRENCY,
        minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
        perSenderHourly: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
        tenantHourly: env.MAX_EMAILS_PER_HOUR || 'disabled',
      },
      'worker ready',
    ),
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? env.SEND_MAX_ATTEMPTS;
    // Last attempt lost: write the terminal state so the dashboard stops showing
    // it as pending forever.
    if (job.attemptsMade >= attempts) {
      void markExhausted(job.data.emailJobId, err.message).catch((e) =>
        log.error({ err: e }, 'failed to mark job exhausted'),
      );
      log.error(
        { emailJobId: job.data.emailJobId, attempts: job.attemptsMade, err: err.message },
        'job exhausted all retries',
      );
    }
  });

  worker.on('error', (err) => log.error({ err: err.message }, 'worker error'));

  // Repairs Postgres/Redis divergence. See queue/reconciler.ts -- not a cron.
  startReconciler();

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down worker');
    stopReconciler();
    // `close()` waits for in-flight jobs to finish rather than killing them
    // mid-send, which is what keeps "no duplicate, no lost email" true across a
    // deploy or a restart.
    await worker.close();
    await closeQueues();
    await closeTransports();
    await closeEvents();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
