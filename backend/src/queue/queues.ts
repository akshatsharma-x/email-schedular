import { Queue, QueueEvents } from 'bullmq';
import { env } from '../config/env.js';
import { queueRedis } from '../lib/redis.js';

/**
 * Queue definitions.
 *
 * There is exactly one queue. Scheduling is expressed purely as BullMQ *delayed
 * jobs* -- a job carries a `delay` and Redis's sorted set of delayed jobs is what
 * wakes it. No cron, no polling loop over the database, no `node-cron`.
 */

export const EMAIL_QUEUE_NAME = 'email-send';

export interface EmailJobPayload {
  /** Primary key of the email_jobs row. Also used as the BullMQ job id. */
  emailJobId: string;
  userId: string;
  campaignId: string;
  /** Position in the campaign, carried so a deferral can rebuild ordering. */
  sequence: number;
}

/**
 * Shared job options.
 *
 * `removeOnComplete`/`removeOnFail` keep a bounded history so the BullMQ board
 * stays useful without letting Redis grow without limit.
 */
export const defaultJobOptions = {
  attempts: env.SEND_MAX_ATTEMPTS,
  backoff: { type: 'exponential' as const, delay: env.SEND_BACKOFF_MS },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export const emailQueue = new Queue<EmailJobPayload>(EMAIL_QUEUE_NAME, {
  connection: queueRedis,
  prefix: env.REDIS_PREFIX,
  defaultJobOptions,
});

/**
 * QueueEvents gives the API process a live feed of job transitions so the
 * dashboard can push updates over SSE. Created lazily -- the worker process does
 * not need it.
 */
let queueEvents: QueueEvents | null = null;
export function getQueueEvents(): QueueEvents {
  queueEvents ??= new QueueEvents(EMAIL_QUEUE_NAME, {
    connection: queueRedis.duplicate(),
    prefix: env.REDIS_PREFIX,
  });
  return queueEvents;
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([emailQueue.close(), queueEvents?.close()]);
}
