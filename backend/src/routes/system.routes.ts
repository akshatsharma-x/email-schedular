import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { db } from '../db/client.js';
import { asyncHandler } from '../lib/errors.js';
import { queueDepth, registry } from '../lib/metrics.js';
import { redis } from '../lib/redis.js';
import { emailQueue } from '../queue/queues.js';
import { reconcile } from '../queue/reconciler.js';
import { probe } from '../search/elastic.js';
import { onEvent } from '../realtime/events.js';

export const systemRouter = Router();

/** GET /health -- liveness. Deliberately dependency-free so it never flaps. */
systemRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), now: new Date().toISOString() });
});

/**
 * GET /ready -- readiness. Reports each dependency separately.
 *
 * Postgres and Redis are required (a failure means 503). Elasticsearch is
 * explicitly *not* required: search degrades to Postgres, so an ES outage must
 * not take the service out of the load balancer.
 */
systemRouter.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    const [database, redisOk, elasticsearch] = await Promise.all([
      db.execute(sql`select 1`).then(() => true).catch(() => false),
      redis.ping().then(() => true).catch(() => false),
      probe(true),
    ]);

    const required = database && redisOk;
    res.status(required ? 200 : 503).json({
      status: required ? 'ready' : 'degraded',
      dependencies: {
        database,
        redis: redisOk,
        elasticsearch,
      },
      elasticsearchRequired: false,
    });
  }),
);

/** GET /metrics -- Prometheus scrape endpoint. */
systemRouter.get(
  '/metrics',
  asyncHandler(async (_req, res) => {
    // Refresh queue gauges at scrape time rather than polling continuously.
    const counts = await emailQueue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
      'paused',
    );
    for (const [state, value] of Object.entries(counts)) {
      queueDepth.set({ state }, Number(value ?? 0));
    }
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }),
);

/**
 * GET /api/system/queue -- queue depth for the dashboard's throughput panel.
 * The full BullMQ board lives at BULLBOARD_PATH; this is the compact version
 * the UI embeds.
 */
systemRouter.get(
  '/api/system/queue',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const counts = await emailQueue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
      'paused',
    );
    const next = await emailQueue.getDelayed(0, 0);
    res.json({
      counts,
      nextDelayedAt:
        next[0]?.opts.delay && next[0].timestamp
          ? new Date(next[0].timestamp + next[0].opts.delay).toISOString()
          : null,
      bullBoardPath: env.BULLBOARD_ENABLED ? env.BULLBOARD_PATH : null,
      config: {
        workerConcurrency: env.WORKER_CONCURRENCY,
        minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
        perSenderHourly: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
        tenantHourly: env.MAX_EMAILS_PER_HOUR,
        queueLimiter: `${env.QUEUE_LIMITER_MAX}/${env.QUEUE_LIMITER_DURATION_MS}ms`,
      },
    });
  }),
);

/**
 * POST /api/system/reconcile -- run the recovery sweep on demand.
 * Lets the restart-persistence scenario be demonstrated without waiting for the
 * periodic interval, and is handy after deliberately flushing Redis.
 */
systemRouter.post(
  '/api/system/reconcile',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const report = await reconcile();
    res.json({ report, skipped: report === null });
  }),
);

/**
 * GET /api/events -- Server-Sent Events stream for live dashboard updates.
 *
 * SSE rather than WebSockets: the data flows one way (server to browser), it
 * rides on plain HTTP so no extra infrastructure is needed, and the browser
 * reconnects on its own. The alternative -- polling every second -- would hammer
 * Postgres for every open tab.
 */
systemRouter.get('/api/events', requireAuth, (req, res) => {
  const user = currentUser(req);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Defeats proxy buffering, which otherwise holds events until the buffer fills.
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ userId: user.id })}\n\n`);

  const unsubscribe = onEvent((userId, event) => {
    // Tenant isolation: only this user's events reach this socket.
    if (userId !== user.id) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  // Comment frames keep intermediaries from closing an idle connection.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});
