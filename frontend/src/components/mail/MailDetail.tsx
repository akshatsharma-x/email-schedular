'use client';

import type { ReactNode } from 'react';
import { IconButton, Spinner } from '@/components/ui/Button';
import {
  IconAlert,
  IconArrowLeft,
  IconClock,
  IconExternal,
  IconFile,
  IconSend,
  IconStar,
} from '@/components/ui/icons';
import { Avatar } from '@/components/mail/Sidebar';
import { API_URL } from '@/lib/api';
import { describeDeferReason, formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import type { EmailDetail } from '@/types/api';

/**
 * Reading pane.
 *
 * Follows the design: back arrow + subject, a sender block with avatar / name /
 * address / date, the body, then attachment cards.
 *
 * One addition the design does not show, because this app schedules rather than
 * just displays: a status strip explaining *why* an email is still pending.
 * Without it a rate-limited email looks indistinguishable from a stuck one.
 */
export function MailDetail({
  email,
  loading,
  error,
  onBack,
  onToggleStar,
  starBusy,
}: {
  email: EmailDetail | null;
  loading: boolean;
  error: string | null;
  onBack: () => void;
  onToggleStar: () => void;
  starBusy: boolean;
}): ReactNode {
  if (loading && !email) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <Spinner className="size-5 text-ink-muted" />
      </div>
    );
  }

  if (error || !email) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-20 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl border border-failed/30 bg-failed/10 text-failed">
          <IconAlert className="size-5" />
        </div>
        <p className="text-[14px] font-medium text-ink">Could not open this email</p>
        <p className="max-w-sm text-[13px] text-ink-muted">{error ?? 'It may have been removed.'}</p>
        <button
          onClick={onBack}
          className="cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-hover"
        >
          Back to list
        </button>
      </div>
    );
  }

  const deferNote = describeDeferReason(email.lastDeferReason);

  return (
    <article className="animate-in flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
        <IconButton label="Back to list" onClick={onBack}>
          <IconArrowLeft className="size-4" />
        </IconButton>
        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">
          {email.subject}
        </h1>
        <IconButton
          label={email.starred ? 'Remove star' : 'Add star'}
          active={email.starred}
          onClick={onToggleStar}
          disabled={starBusy}
          className={email.starred ? 'text-scheduled-dot' : ''}
        >
          <IconStar className="size-4" filled={email.starred} />
        </IconButton>
        {email.previewUrl && (
          <a
            href={email.previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open the delivered message"
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-brand-border bg-surface px-2.5 text-[12.5px] font-medium text-brand-strong transition-colors hover:bg-brand-soft"
          >
            View delivered
            <IconExternal className="size-3.5" />
          </a>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {/* ---- sender block ---- */}
        <div className="flex items-start gap-3">
          <Avatar
            user={{ name: email.senderName ?? email.senderEmail ?? 'Sender' }}
            size="lg"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[13.5px] font-semibold text-ink">
                {email.senderName ?? 'Sender'}
              </span>
              <span className="truncate text-[12.5px] text-ink-muted">
                &lt;{email.senderEmail ?? 'unknown'}&gt;
              </span>
            </div>
            <span className="text-[12px] text-ink-muted">
              to {email.recipientName ? `${email.recipientName} ` : ''}
              &lt;{email.recipientEmail}&gt;
            </span>
          </div>
          <div className="hidden shrink-0 flex-col items-end sm:flex">
            <span className="tnum text-[12px] text-ink-secondary">
              {formatDateTime(email.sentAt ?? email.scheduledAt)}
            </span>
            <span className="text-[11px] text-ink-muted">
              {email.sentAt ? 'sent' : 'scheduled'} {formatRelative(email.sentAt ?? email.scheduledAt)}
            </span>
          </div>
        </div>

        {/* ---- status strip ---- */}
        {email.status !== 'SENT' && (
          <div
            className={[
              'mt-4 flex items-start gap-2 rounded-lg border px-3 py-2.5',
              email.status === 'FAILED'
                ? 'border-failed/30 bg-failed/10'
                : 'border-line bg-muted',
            ].join(' ')}
          >
            {email.status === 'FAILED' ? (
              <IconAlert className="mt-0.5 size-4 shrink-0 text-failed" />
            ) : (
              <IconClock className="mt-0.5 size-4 shrink-0 text-scheduled" />
            )}
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-[12.5px] font-medium text-ink">
                {email.status === 'FAILED'
                  ? 'Delivery failed'
                  : email.status === 'SENDING'
                    ? 'Sending now'
                    : `Scheduled for ${formatDateTime(email.scheduledAt)}`}
              </p>
              {email.status === 'FAILED' && email.lastError && (
                <p className="break-words text-[12px] text-ink-secondary">{email.lastError}</p>
              )}
              {deferNote && email.status === 'SCHEDULED' && (
                <p className="text-[12px] text-ink-secondary">
                  {deferNote}
                  {email.deferCount > 0 && ` (${email.deferCount}×)`}
                </p>
              )}
              {email.attemptCount > 1 && (
                <p className="text-[12px] text-ink-muted">
                  {email.attemptCount} send attempts so far
                </p>
              )}
            </div>
          </div>
        )}

        {/* ---- body ---- */}
        <div className="mt-5 text-[13.5px] leading-relaxed text-ink">
          {email.bodyHtml ? (
            // The HTML came from this app's own composer (inline formatting
            // tags only), stored per campaign and rendered back for the author.
            <div
              className="prose-mail"
              dangerouslySetInnerHTML={{ __html: email.bodyHtml }}
            />
          ) : (
            <p className="whitespace-pre-wrap">{email.body}</p>
          )}
        </div>

        {/* ---- attachments ---- */}
        {email.attachments.length > 0 && (
          <div className="mt-6">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
              {email.attachments.length} attachment
              {email.attachments.length === 1 ? '' : 's'}
            </p>
            <div className="flex flex-wrap gap-2.5">
              {email.attachments.map((file) => (
                <a
                  key={file.id}
                  href={`${API_URL}${file.url}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group w-36 overflow-hidden rounded-lg border border-line bg-surface transition-colors hover:border-line-strong"
                >
                  <div className="flex h-24 items-center justify-center overflow-hidden bg-muted">
                    {file.isImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`${API_URL}${file.url}`}
                        alt={file.filename}
                        className="size-full object-cover"
                      />
                    ) : (
                      <IconFile className="size-7 text-ink-muted" />
                    )}
                  </div>
                  <div className="px-2 py-1.5">
                    <p className="truncate text-[11.5px] font-medium text-ink" title={file.filename}>
                      {file.filename}
                    </p>
                    <p className="tnum text-[10.5px] text-ink-muted">
                      {formatBytes(file.sizeBytes)}
                    </p>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* ---- footer meta ---- */}
        <dl className="mt-8 grid gap-x-6 gap-y-1.5 border-t border-line pt-4 text-[11.5px] sm:grid-cols-2">
          <Meta label="Status">
            <span className="inline-flex items-center gap-1">
              {email.status === 'SENT' ? (
                <IconSend className="size-3 text-sent" />
              ) : email.status === 'FAILED' ? (
                <IconAlert className="size-3 text-failed" />
              ) : (
                <IconClock className="size-3 text-scheduled" />
              )}
              {email.status}
            </span>
          </Meta>
          <Meta label="Sender">{email.senderEmail ?? '—'}</Meta>
          {email.campaignName && <Meta label="Campaign">{email.campaignName}</Meta>}
          {email.providerMessageId && (
            <Meta label="Message ID">
              <span className="break-all">{email.providerMessageId}</span>
            </Meta>
          )}
        </dl>
      </div>
    </article>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-ink-secondary">{children}</dd>
    </div>
  );
}
