import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Typed mirror of ./migrations/*.sql.
 *
 * The SQL files remain authoritative for DDL; this file exists so queries are
 * type-checked. `npm run typecheck` plus the integration tests catch drift
 * between the two.
 */

export const EMAIL_STATUSES = ['SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const CAMPAIGN_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleSub: text('google_sub').unique(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const slackIntegrations = pgTable('slack_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  teamId: text('team_id'),
  teamName: text('team_name'),
  channel: text('channel'),
  channelId: text('channel_id'),
  webhookUrl: text('webhook_url'),
  accessToken: text('access_token'),
  botUserId: text('bot_user_id'),
  scope: text('scope'),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
  notifyFailures: integer('notify_failures').notNull().default(0),
});

export const senders = pgTable(
  'senders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    fromName: text('from_name').notNull(),
    fromEmail: text('from_email').notNull(),
    smtpHost: text('smtp_host').notNull(),
    smtpPort: integer('smtp_port').notNull(),
    smtpSecure: boolean('smtp_secure').notNull().default(false),
    smtpUser: text('smtp_user').notNull(),
    smtpPass: text('smtp_pass').notNull(),
    /** NULL => inherit the env default. */
    maxEmailsPerHour: integer('max_emails_per_hour'),
    isActive: boolean('is_active').notNull().default(true),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    disabledUntil: timestamp('disabled_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userEmailUnique: unique('senders_user_email_unique').on(t.userId, t.fromEmail),
    userActiveIdx: index('senders_user_active_idx').on(t.userId, t.isActive),
  }),
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    bodyHtml: text('body_html'),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    minDelayMs: integer('min_delay_ms').notNull(),
    maxPerHour: integer('max_per_hour').notNull(),
    totalRecipients: integer('total_recipients').notNull().default(0),
    status: text('status').$type<CampaignStatus>().notNull().default('ACTIVE'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('campaigns_user_created_idx').on(t.userId, t.createdAt),
  }),
);

export const emailJobs = pgTable(
  'email_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id').references(() => senders.id, { onDelete: 'set null' }),

    recipientEmail: text('recipient_email').notNull(),
    recipientName: text('recipient_name'),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    bodyHtml: text('body_html'),
    starred: boolean('starred').notNull().default(false),

    status: text('status').$type<EmailStatus>().notNull().default('SCHEDULED'),
    sequence: integer('sequence').notNull().default(0),

    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),

    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    leaseOwner: text('lease_owner'),

    deferCount: integer('defer_count').notNull().default(0),
    lastDeferReason: text('last_defer_reason'),

    lastError: text('last_error'),
    providerMessageId: text('provider_message_id'),
    previewUrl: text('preview_url'),

    dedupeKey: text('dedupe_key').notNull(),

    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dedupeKeyUnique: unique('email_jobs_dedupe_key_uniq').on(t.dedupeKey),
    statusScheduledIdx: index('email_jobs_status_scheduled_idx').on(t.status, t.scheduledAt),
    userStatusScheduledIdx: index('email_jobs_user_status_scheduled_idx').on(
      t.userId,
      t.status,
      t.scheduledAt,
    ),
    campaignIdx: index('email_jobs_campaign_idx').on(t.campaignId, t.sequence),
  }),
);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null until the upload is linked to a scheduled campaign. */
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storagePath: text('storage_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignIdx: index('attachments_campaign_idx').on(t.campaignId),
  }),
);

export type Attachment = typeof attachments.$inferSelect;
export type User = typeof users.$inferSelect;
export type Sender = typeof senders.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type EmailJob = typeof emailJobs.$inferSelect;
export type SlackIntegration = typeof slackIntegrations.$inferSelect;
