import { createSubscriber, key, publisher } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ mod: 'events' });

/**
 * Realtime dashboard updates.
 *
 * The worker and the API are separate processes, so the worker cannot push to a
 * browser directly. It publishes to Redis pub/sub; every API instance subscribes
 * and fans out to its own SSE clients. That keeps the dashboard live with any
 * number of API replicas, and costs nothing when nobody is watching.
 *
 * Events are per-tenant (channel includes the user id) so one tenant can never
 * observe another's activity.
 */

export type OutboxEvent =
  | { type: 'campaign.scheduled'; campaignId: string; count: number }
  | { type: 'campaign.cancelled'; campaignId: string; count: number }
  | { type: 'email.sent'; emailJobId: string; recipient: string; previewUrl: string | null }
  | { type: 'email.failed'; emailJobId: string; recipient: string; error: string }
  | {
      type: 'email.deferred';
      emailJobId: string;
      recipient: string;
      reason: string;
      runAt: string;
    }
  | { type: 'ratelimit.hit'; senderId: string; senderEmail: string; limit: number; resumesAt: string }
  | { type: 'reconcile.done'; requeued: number; reclaimed: number };

const channel = (userId: string) => key('events', userId);
const PATTERN = key('events', '*');

export async function publishEvent(userId: string, event: OutboxEvent): Promise<void> {
  try {
    await publisher.publish(channel(userId), JSON.stringify(event));
  } catch (err) {
    // Telemetry must never break the operation that produced it.
    log.debug({ err: (err as Error).message }, 'event publish failed (non-fatal)');
  }
}

type Listener = (userId: string, event: OutboxEvent) => void;

const listeners = new Set<Listener>();
let subscriber: ReturnType<typeof createSubscriber> | null = null;

/**
 * Subscribes once per process (pattern subscription), then multiplexes to every
 * registered SSE connection in-process. Returns an unsubscribe function.
 */
export function onEvent(listener: Listener): () => void {
  listeners.add(listener);

  if (!subscriber) {
    subscriber = createSubscriber();
    subscriber.psubscribe(PATTERN).catch((err) => {
      log.error({ err: err.message }, 'failed to subscribe to event channel');
    });
    subscriber.on('pmessage', (_pattern, ch, message) => {
      const userId = ch.split(':').pop();
      if (!userId) return;
      let parsed: OutboxEvent;
      try {
        parsed = JSON.parse(message) as OutboxEvent;
      } catch {
        return;
      }
      for (const l of listeners) {
        try {
          l(userId, parsed);
        } catch (err) {
          log.debug({ err: (err as Error).message }, 'event listener threw');
        }
      }
    });
  }

  return () => {
    listeners.delete(listener);
  };
}

export async function closeEvents(): Promise<void> {
  listeners.clear();
  await subscriber?.quit().catch(() => undefined);
  subscriber = null;
}
