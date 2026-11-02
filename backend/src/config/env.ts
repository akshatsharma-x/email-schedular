import 'dotenv/config';
import { z } from 'zod';

/**
 * Single source of truth for configuration.
 *
 * Every throughput / rate-limit knob the assignment asks about lives here and is
 * read from the environment -- there are no hardcoded limits anywhere else in the
 * codebase. The process refuses to boot on an invalid config (fail fast, loudly)
 * rather than silently falling back to a default that would change send behaviour.
 */

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ---- HTTP ----
  PORT: int(4000, 1),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  // ---- Postgres ----
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: int(10, 1),

  // ---- Redis (BullMQ + rate-limit counters + pub/sub) ----
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  REDIS_PREFIX: z.string().default('outbox'),

  // ---- Elasticsearch ----
  ELASTICSEARCH_URL: z.string().default('http://localhost:9200'),
  ELASTICSEARCH_INDEX: z.string().default('outbox-emails'),
  ELASTICSEARCH_ENABLED: bool(true),
  ELASTICSEARCH_USERNAME: z.string().optional(),
  ELASTICSEARCH_PASSWORD: z.string().optional(),

  // ---- Throughput / concurrency ----
  /** How many email jobs a single worker process handles in parallel. */
  WORKER_CONCURRENCY: int(5, 1),
  /**
   * Minimum gap between two sends *for the same sender*, in milliseconds.
   * Enforced with a Redis CAS so it holds across every worker and instance.
   */
  MIN_DELAY_BETWEEN_EMAILS_MS: int(2000, 0),
  /**
   * How long a sender's send slot stays reserved while a send is in flight, on
   * top of the gap. Keeps one sender to a single concurrent SMTP conversation.
   * Should exceed the slowest realistic send (the SMTP socket timeout is 30s);
   * if a worker dies mid-send, the sender resumes after this long.
   */
  SEND_HOLD_MS: int(35_000, 0),
  /** Default per-sender hourly cap. A campaign may request a lower value. */
  MAX_EMAILS_PER_HOUR_PER_SENDER: int(200, 1),
  /** Tenant-wide hourly ceiling across all of that tenant's senders. 0 = disabled. */
  MAX_EMAILS_PER_HOUR: int(1000, 0),
  /** Safety valve: BullMQ-level cap on jobs pulled per interval, per worker. */
  QUEUE_LIMITER_MAX: int(50, 1),
  QUEUE_LIMITER_DURATION_MS: int(1000, 1),
  /** Retry policy for transient SMTP failures. */
  SEND_MAX_ATTEMPTS: int(3, 1),
  SEND_BACKOFF_MS: int(5000, 100),
  /**
   * How long a worker may hold a claimed job before the reconciler assumes the
   * worker died and makes the job eligible again.
   */
  JOB_LEASE_MS: int(120_000, 1000),

  // ---- Recovery ----
  /** Re-enqueue DB rows that have no live Redis job (e.g. Redis was flushed). */
  RECONCILE_ON_BOOT: bool(true),
  /** Periodic safety sweep interval. Not cron -- a setInterval inside the worker. */
  RECONCILE_INTERVAL_MS: int(60_000, 5000),

  // ---- Auth ----
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  SESSION_COOKIE_NAME: z.string().default('outbox_session'),
  SESSION_TTL_HOURS: int(168, 1),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /**
   * Dev-only: lets the dashboard be exercised without Google credentials.
   * Hard-disabled when NODE_ENV=production (see the refinement below).
   */
  DEV_AUTH_BYPASS: bool(false),

  // ---- Slack ----
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_REDIRECT_URI: z.string().optional(),
  SLACK_SCOPES: z.string().default('incoming-webhook,chat:write'),

  // ---- Admin ----
  BULLBOARD_PATH: z.string().default('/admin/queues'),
  BULLBOARD_ENABLED: bool(true),
});

const parsed = schema
  .refine((v) => !(v.NODE_ENV === 'production' && v.DEV_AUTH_BYPASS), {
    message: 'DEV_AUTH_BYPASS must be false in production',
    path: ['DEV_AUTH_BYPASS'],
  })
  .safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Intentionally console.error: the logger itself depends on this config.
  console.error(`\nInvalid environment configuration:\n${issues}\n\nSee .env.example.\n`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/** True when real Google OAuth can be performed. */
export const googleOAuthConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/** True when the Slack "Connect" flow can be performed. */
export const slackOAuthConfigured = Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET);

export const slackRedirectUri = env.SLACK_REDIRECT_URI ?? `${env.PUBLIC_API_URL}/api/slack/callback`;
export const googleRedirectUri = `${env.PUBLIC_API_URL}/api/auth/google/callback`;
