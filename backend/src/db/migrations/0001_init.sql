-- ============================================================================
-- 0001_init: users, Slack integrations, senders, campaigns, email jobs
-- ============================================================================
-- Durable state lives here. Redis/BullMQ is treated as a *derived* index of
-- this table (it tells us "when to wake up"), never as the source of truth.
-- That inversion is what makes restart-recovery and idempotency tractable:
-- if Redis is wiped, the reconciler can rebuild every pending job from Postgres.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------- users ------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub    TEXT UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------- slack_integrations ------
-- One Slack workspace connection per user (tenant). Tokens are stored so that
-- connect/disconnect/reconnect works at runtime with no redeploy.
CREATE TABLE IF NOT EXISTS slack_integrations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id        TEXT,
  team_name      TEXT,
  channel        TEXT,
  channel_id     TEXT,
  webhook_url    TEXT,
  access_token   TEXT,
  bot_user_id    TEXT,
  scope          TEXT,
  connected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ,
  last_notified_at TIMESTAMPTZ,
  notify_failures  INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT slack_integrations_user_unique UNIQUE (user_id)
);

-- -------------------------------------------------------------- senders ------
-- Multiple Ethereal SMTP identities per user. Rate limiting is primarily
-- per-sender, so this is the unit the limiter keys on.
CREATE TABLE IF NOT EXISTS senders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  from_name           TEXT NOT NULL,
  from_email          TEXT NOT NULL,
  smtp_host           TEXT NOT NULL,
  smtp_port           INTEGER NOT NULL,
  smtp_secure         BOOLEAN NOT NULL DEFAULT false,
  smtp_user           TEXT NOT NULL,
  smtp_pass           TEXT NOT NULL,
  -- NULL => inherit MAX_EMAILS_PER_HOUR_PER_SENDER from env.
  max_emails_per_hour INTEGER,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  -- Simple circuit breaker so one dead SMTP identity cannot sink a campaign.
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  disabled_until       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT senders_user_email_unique UNIQUE (user_id, from_email)
);

CREATE INDEX IF NOT EXISTS senders_user_active_idx ON senders (user_id, is_active);

-- ------------------------------------------------------------ campaigns ------
CREATE TABLE IF NOT EXISTS campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT,
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  start_at         TIMESTAMPTZ NOT NULL,
  -- Per-campaign overrides of the global throughput knobs.
  min_delay_ms     INTEGER NOT NULL,
  max_per_hour     INTEGER NOT NULL,
  total_recipients INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  -- Client-supplied key makes POST /api/campaigns safe to retry.
  idempotency_key  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_status_check
    CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS campaigns_user_idempotency_key_uniq
  ON campaigns (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS campaigns_user_created_idx ON campaigns (user_id, created_at DESC);

-- ----------------------------------------------------------- email_jobs ------
-- One row per recipient per campaign. This is the durable job ledger.
CREATE TABLE IF NOT EXISTS email_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id         UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  sender_id           UUID REFERENCES senders(id) ON DELETE SET NULL,

  recipient_email     TEXT NOT NULL,
  recipient_name      TEXT,
  subject             TEXT NOT NULL,
  body                TEXT NOT NULL,

  status              TEXT NOT NULL DEFAULT 'SCHEDULED',
  -- Position within the campaign. Used to rebuild ordering after a rate-limit
  -- deferral so the queue does not shuffle.
  sequence            INTEGER NOT NULL DEFAULT 0,

  scheduled_at        TIMESTAMPTZ NOT NULL,
  sent_at             TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,

  attempt_count       INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 3,
  -- Held by the worker that claimed the row; the reconciler reclaims it if the
  -- worker dies mid-send.
  lease_expires_at    TIMESTAMPTZ,
  lease_owner         TEXT,

  defer_count         INTEGER NOT NULL DEFAULT 0,
  last_defer_reason   TEXT,

  last_error          TEXT,
  provider_message_id TEXT,
  preview_url         TEXT,

  -- Idempotency anchor: a campaign can never contain the same recipient twice,
  -- and it doubles as the BullMQ job id so re-enqueueing is a no-op.
  dedupe_key          TEXT NOT NULL,

  indexed_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT email_jobs_status_check
    CHECK (status IN ('SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED')),
  CONSTRAINT email_jobs_dedupe_key_uniq UNIQUE (dedupe_key)
);

-- Drives the reconciler sweep ("what should be in Redis right now?").
CREATE INDEX IF NOT EXISTS email_jobs_status_scheduled_idx
  ON email_jobs (status, scheduled_at);

-- Drives the dashboard tables.
CREATE INDEX IF NOT EXISTS email_jobs_user_status_scheduled_idx
  ON email_jobs (user_id, status, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS email_jobs_user_status_sent_idx
  ON email_jobs (user_id, status, sent_at DESC);

-- Lease reclaim lookup.
CREATE INDEX IF NOT EXISTS email_jobs_lease_idx
  ON email_jobs (status, lease_expires_at)
  WHERE status = 'SENDING';

CREATE INDEX IF NOT EXISTS email_jobs_campaign_idx ON email_jobs (campaign_id, sequence);

-- Postgres-side search fallback for when Elasticsearch is unavailable.
CREATE INDEX IF NOT EXISTS email_jobs_recipient_trgm_idx ON email_jobs (user_id, recipient_email);
