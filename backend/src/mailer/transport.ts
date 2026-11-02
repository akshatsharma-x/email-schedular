import nodemailer, { type Transporter } from 'nodemailer';
import type { Sender } from '../db/schema.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ mod: 'mailer' });

/**
 * SMTP transports, one per sender, cached for the life of the process.
 *
 * Building a Transporter per email would open a fresh TCP+TLS connection for
 * every send -- slow, and it trips Ethereal's connection limits under
 * concurrency. `pool: true` keeps a small set of connections warm and nodemailer
 * serialises sends over them, which pairs well with the worker's concurrency
 * setting.
 */
const cache = new Map<string, Transporter>();

/** Cache key includes credentials so rotating a sender's password invalidates it. */
const cacheKey = (s: Sender) => `${s.id}:${s.smtpHost}:${s.smtpPort}:${s.smtpUser}:${s.smtpPass}`;

export function getTransport(sender: Sender): Transporter {
  const k = cacheKey(sender);
  const existing = cache.get(k);
  if (existing) return existing;

  const transport = nodemailer.createTransport({
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    auth: { user: sender.smtpUser, pass: sender.smtpPass },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    // Don't let a hung SMTP dialogue pin a worker slot forever.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  // Evict any stale entry for this sender id (credential change).
  for (const existingKey of cache.keys()) {
    if (existingKey.startsWith(`${sender.id}:`)) {
      cache.get(existingKey)?.close();
      cache.delete(existingKey);
    }
  }

  cache.set(k, transport);
  log.debug({ senderId: sender.id, host: sender.smtpHost }, 'smtp transport created');
  return transport;
}

export interface SendResult {
  messageId: string;
  /** Ethereal's human-viewable message URL, surfaced in the dashboard. */
  previewUrl: string | null;
  accepted: string[];
  rejected: string[];
}

export interface OutgoingAttachment {
  filename: string;
  path: string;
  contentType: string;
}

export async function sendMail(opts: {
  sender: Sender;
  to: string;
  toName?: string | null;
  subject: string;
  body: string;
  /** Rich-text alternative. When absent, the plain text is auto-formatted. */
  bodyHtml?: string | null;
  attachments?: OutgoingAttachment[];
  /** Stable header so a duplicate delivery is detectable at the provider. */
  idempotencyKey: string;
}): Promise<SendResult> {
  const transport = getTransport(opts.sender);
  const info = await transport.sendMail({
    from: { name: opts.sender.fromName, address: opts.sender.fromEmail },
    to: opts.toName ? { name: opts.toName, address: opts.to } : opts.to,
    subject: opts.subject,
    // Both parts are always sent: `text` is the plain-text alternative for
    // clients that refuse HTML, and is also what spam filters read.
    text: opts.body,
    html: opts.bodyHtml?.trim() ? wrapHtml(opts.bodyHtml) : renderHtml(opts.body),
    attachments: opts.attachments?.map((a) => ({
      filename: a.filename,
      path: a.path,
      contentType: a.contentType,
    })),
    headers: {
      // Lets a human (or the provider) spot a double-send after the fact.
      'X-Outbox-Idempotency-Key': opts.idempotencyKey,
    },
  });

  return {
    messageId: info.messageId,
    previewUrl: nodemailer.getTestMessageUrl(info) || null,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  };
}

/**
 * Wraps composer HTML in a mail-safe shell.
 *
 * The composer only ever emits inline formatting tags (b/i/u/a/ul/ol/li/div),
 * so this adds the font stack mail clients need rather than attempting to
 * sanitise: the HTML originates from our own editor, under the sender's own
 * account, and goes out as their message.
 */
function wrapHtml(html: string): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.6;color:#111">${html}</div>`;
}

/** Escapes the plain-text body and preserves line breaks for the HTML part. */
function renderHtml(body: string): string {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.6;color:#111">${escaped.replace(
    /\n/g,
    '<br/>',
  )}</div>`;
}

/**
 * SMTP errors split into "try again later" and "this will never work".
 * Permanent failures must not consume retry attempts.
 */
export function isPermanentSmtpError(err: unknown): boolean {
  const e = err as { responseCode?: number; code?: string } | null;
  if (!e) return false;
  // 5xx is a permanent SMTP rejection (bad mailbox, rejected content, ...).
  if (typeof e.responseCode === 'number' && e.responseCode >= 500 && e.responseCode < 600) {
    return true;
  }
  return e.code === 'EENVELOPE';
}

export async function closeTransports(): Promise<void> {
  for (const t of cache.values()) t.close();
  cache.clear();
}
