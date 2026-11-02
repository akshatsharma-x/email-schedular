import { Client } from '@elastic/elasticsearch';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ mod: 'elastic' });

/**
 * Elasticsearch client + index bootstrap.
 *
 * ES is treated as a *disposable* read optimisation: it is populated from
 * Postgres and can be rebuilt at any time with `npm run search:reindex`. Nothing
 * in the send path blocks on it, and `available` flips to false the moment it
 * stops answering so queries can fall back to Postgres (see ./search.ts).
 */

let client: Client | null = null;
let available = false;
let lastProbe = 0;
const PROBE_INTERVAL_MS = 15_000;

export function getClient(): Client | null {
  if (!env.ELASTICSEARCH_ENABLED) return null;
  client ??= new Client({
    node: env.ELASTICSEARCH_URL,
    auth:
      env.ELASTICSEARCH_USERNAME && env.ELASTICSEARCH_PASSWORD
        ? { username: env.ELASTICSEARCH_USERNAME, password: env.ELASTICSEARCH_PASSWORD }
        : undefined,
    // Short timeouts: a slow ES must not become a slow dashboard.
    requestTimeout: 5_000,
    maxRetries: 1,
  });
  return client;
}

export function isAvailable(): boolean {
  return available;
}

/** Cheap liveness check, throttled so the dashboard can call it freely. */
export async function probe(force = false): Promise<boolean> {
  const c = getClient();
  if (!c) {
    available = false;
    return false;
  }
  if (!force && Date.now() - lastProbe < PROBE_INTERVAL_MS) return available;
  lastProbe = Date.now();
  try {
    await c.ping();
    if (!available) log.info('elasticsearch available');
    available = true;
  } catch (err) {
    if (available) log.warn({ err: (err as Error).message }, 'elasticsearch became unavailable');
    available = false;
  }
  return available;
}

/**
 * Index mapping.
 *
 * `recipient_email` is indexed twice on purpose: as `keyword` for exact filters
 * and aggregations, and as `text` with an email-aware analyzer so searching
 * "zomato" finds "lead@zomato.in". Without the custom analyzer the standard one
 * keeps the whole address as one token and partial search silently fails.
 */
const INDEX_SETTINGS = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        email_analyzer: {
          type: 'custom' as const,
          tokenizer: 'uax_url_email',
          filter: ['lowercase', 'email_parts'],
        },
      },
      filter: {
        email_parts: {
          type: 'word_delimiter_graph' as const,
          split_on_numerics: false,
          preserve_original: true,
        },
      },
    },
  },
  mappings: {
    properties: {
      user_id: { type: 'keyword' as const },
      campaign_id: { type: 'keyword' as const },
      sender_id: { type: 'keyword' as const },
      sender_email: { type: 'keyword' as const },
      recipient_email: {
        type: 'text' as const,
        analyzer: 'email_analyzer',
        fields: { keyword: { type: 'keyword' as const } },
      },
      recipient_name: { type: 'text' as const },
      subject: { type: 'text' as const },
      body: { type: 'text' as const },
      status: { type: 'keyword' as const },
      scheduled_at: { type: 'date' as const },
      sent_at: { type: 'date' as const },
      defer_count: { type: 'integer' as const },
      created_at: { type: 'date' as const },
    },
  },
};

/** Idempotent: safe to call on every boot. */
export async function ensureIndex(): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    const exists = await c.indices.exists({ index: env.ELASTICSEARCH_INDEX });
    if (!exists) {
      await c.indices.create({ index: env.ELASTICSEARCH_INDEX, ...INDEX_SETTINGS });
      log.info({ index: env.ELASTICSEARCH_INDEX }, 'elasticsearch index created');
    }
    available = true;
    return true;
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'could not prepare elasticsearch index; search will fall back to postgres',
    );
    available = false;
    return false;
  }
}
