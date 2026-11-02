/**
 * Types for every API response the dashboard consumes.
 *
 * These mirror the backend's serialisers. Keeping them in one file (rather than
 * inline `any` at each call site) is what lets the components be typed all the
 * way down to the table cells.
 */

export type EmailStatus = 'SCHEDULED' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED';

/** Sidebar folders. `starred` is a filter over the other two, not a status. */
export type MailFolder = 'scheduled' | 'sent' | 'starred';

export interface Lead {
  email: string;
  name: string | null;
}

export interface AttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Relative to the API origin. */
  url: string;
  isImage: boolean;
  createdAt: string;
}
export type CampaignStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface AuthConfig {
  googleEnabled: boolean;
  devBypassEnabled: boolean;
}

export interface EmailRow {
  id: string;
  campaignId: string;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  /** Short snippet shown after the subject in the list. */
  preview: string;
  status: EmailStatus;
  sequence: number;
  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;
  attemptCount: number;
  deferCount: number;
  lastDeferReason: string | null;
  lastError: string | null;
  previewUrl: string | null;
  senderEmail: string | null;
  senderLabel: string | null;
  starred: boolean;
}

/** Detail view payload: adds the body and attachments the list omits. */
export interface EmailDetail extends EmailRow {
  body: string;
  bodyHtml: string | null;
  senderName: string | null;
  campaignName: string | null;
  providerMessageId: string | null;
  attachments: AttachmentRef[];
}

export interface EmailListResponse {
  emails: EmailRow[];
  total: number;
  /** Which engine answered: proves Elasticsearch is really in the path. */
  source: 'elasticsearch' | 'postgres';
  tookMs?: number;
  limit: number;
  offset: number;
}

export interface EmailStats {
  starred: number;
  scheduled: number;
  sending: number;
  sent: number;
  failed: number;
  cancelled: number;
  deferred: number;
  nextSendAt: string | null;
}

export interface PlanSummary {
  totalEmails: number;
  senderCount: number;
  firstSendAt: string | null;
  lastSendAt: string | null;
  spanMinutes: number;
  windowsUsed: number;
  effectiveMinDelayMs: number;
  perSenderHourly: number;
}

export interface Campaign {
  id: string;
  name: string | null;
  subject: string;
  body: string;
  startAt: string;
  minDelayMs: number;
  maxPerHour: number;
  totalRecipients: number;
  status: CampaignStatus;
  createdAt: string;
  counts?: {
    scheduled: number;
    sending: number;
    sent: number;
    failed: number;
  };
}

export interface ScheduleResponse {
  campaign: Campaign;
  plan: PlanSummary;
  enqueued: number;
  deduplicated: boolean;
  recipients: {
    scheduled: number;
    invalid: number;
    duplicates: number;
    invalidSamples: string[];
  };
}

export interface ParsedLeadsResponse {
  detected: number;
  duplicates: number;
  invalid: number;
  invalidSamples: string[];
  totalRows: number;
  preview: { email: string; name: string | null }[];
  recipients: { email: string; name: string | null }[];
}

export interface SenderRow {
  id: string;
  label: string;
  fromName: string;
  fromEmail: string;
  smtpHost: string;
  smtpPort: number;
  isActive: boolean;
  disabledUntil: string | null;
  consecutiveFailures: number;
  hourlyLimit: number;
  hourlyUsed: number;
  hourlyRemaining: number;
  nextSendAllowedAt: string | null;
  createdAt: string;
}

export interface SendersResponse {
  senders: SenderRow[];
  limits: {
    perSenderHourlyDefault: number;
    tenantHourly: number;
    minDelayMs: number;
    workerConcurrency: number;
  };
}

export interface SlackStatus {
  configured: boolean;
  connected: boolean;
  teamName: string | null;
  channel: string | null;
  connectedAt: string | null;
  lastNotifiedAt: string | null;
  revokedAt: string | null;
}

export interface QueueStatus {
  counts: Record<string, number>;
  nextDelayedAt: string | null;
  bullBoardPath: string | null;
  config: {
    workerConcurrency: number;
    minDelayMs: number;
    perSenderHourly: number;
    tenantHourly: number;
    queueLimiter: string;
  };
}

/** Events pushed over SSE. Mirrors the backend's OutboxEvent union. */
export type OutboxEvent =
  | { type: 'campaign.scheduled'; campaignId: string; count: number }
  | { type: 'campaign.cancelled'; campaignId: string; count: number }
  | { type: 'email.sent'; emailJobId: string; recipient: string; previewUrl: string | null }
  | { type: 'email.failed'; emailJobId: string; recipient: string; error: string }
  | { type: 'email.deferred'; emailJobId: string; recipient: string; reason: string; runAt: string }
  | {
      type: 'ratelimit.hit';
      senderId: string;
      senderEmail: string;
      limit: number;
      resumesAt: string;
    }
  | { type: 'reconcile.done'; requeued: number; reclaimed: number };
