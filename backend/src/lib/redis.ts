import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'redis' });

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it blocks on,
 * otherwise long-lived BRPOPLPUSH calls get torn down and the worker stalls.
 * Everything else (rate-limit counters, pub/sub) uses its own connection so a
 * blocking read can never starve an atomic limiter call.
 */
function build(role: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    // Reconnect on the Redis failover error rather than erroring out.
    reconnectOnError: (err) => err.message.includes('READONLY'),
  });
  client.on('error', (err) => log.error({ role, err: err.message }, 'redis error'));
  client.on('reconnecting', () => log.warn({ role }, 'redis reconnecting'));
  client.on('ready', () => log.debug({ role }, 'redis ready'));
  return client;
}

/** Connection handed to BullMQ Queue/Worker instances. */
export const queueRedis = build('queue');

/** General-purpose commands: rate limiting, idempotency keys, caches. */
export const redis = build('commands');

/** Dedicated publisher for realtime dashboard events. */
export const publisher = build('publisher');

/** A subscriber must not issue normal commands, so it gets its own socket. */
export function createSubscriber(): Redis {
  return build('subscriber');
}

/** Namespaced key helper -- keeps every key under one prefix for safe FLUSH/scan. */
export const key = (...parts: (string | number)[]) => [env.REDIS_PREFIX, ...parts].join(':');

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([queueRedis.quit(), redis.quit(), publisher.quit()]);
}
