import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics, exposed at GET /metrics.
 *
 * These are the numbers you actually want when a campaign misbehaves: how many
 * sends were deferred and why, how long SMTP took, and how much hourly quota is
 * left. Labels are deliberately low-cardinality (reason, status) -- recipient
 * email as a label would blow up the series count.
 */

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'outbox_' });

export const emailsSent = new Counter({
  name: 'outbox_emails_sent_total',
  help: 'Emails successfully handed to SMTP',
  labelNames: ['sender_id'] as const,
  registers: [registry],
});

export const emailsFailed = new Counter({
  name: 'outbox_emails_failed_total',
  help: 'Emails that failed permanently',
  labelNames: ['sender_id', 'permanent'] as const,
  registers: [registry],
});

export const emailsDeferred = new Counter({
  name: 'outbox_emails_deferred_total',
  help: 'Sends deferred by the rate limiter',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const emailsSkipped = new Counter({
  name: 'outbox_emails_skipped_total',
  help: 'Job executions that were no-ops (idempotency guards)',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const sendDuration = new Histogram({
  name: 'outbox_send_duration_seconds',
  help: 'SMTP send latency',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const reconcileRequeued = new Counter({
  name: 'outbox_reconcile_requeued_total',
  help: 'Durable jobs re-enqueued because Redis had no matching job',
  registers: [registry],
});

export const reconcileReclaimed = new Counter({
  name: 'outbox_reconcile_reclaimed_total',
  help: 'Jobs reclaimed from a worker that died mid-send (expired lease)',
  registers: [registry],
});

export const slackNotifications = new Counter({
  name: 'outbox_slack_notifications_total',
  help: 'Slack notification attempts by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'outbox_queue_depth',
  help: 'Jobs in the queue by BullMQ state',
  labelNames: ['state'] as const,
  registers: [registry],
});
