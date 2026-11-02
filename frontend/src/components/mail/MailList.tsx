'use client';

import type { ReactNode } from 'react';
import { IconAlert, IconClock, IconSearch, IconSend, IconStar } from '@/components/ui/icons';
import { formatRowTime, previewText } from '@/lib/format';
import type { EmailRow, MailFolder } from '@/types/api';

/**
 * The mail list.
 *
 * One row component serves every folder: the folder only decides which
 * timestamp is shown and what the empty state says. Two tables would drift
 * apart — one would get a skeleton and the other a bare "Loading…".
 *
 * Row anatomy follows the design: recipient, a status badge, then
 * "Subject - preview" on one truncating line, with the star on the right.
 *
 * Status is carried by an **icon and a word**, never hue alone. That matters
 * here beyond general good practice: green (sent) and amber (scheduled) are the
 * classic deuteranopia confusion, and this app needs both.
 */
export function MailList({
  rows,
  folder,
  loading,
  initialLoading,
  error,
  selectedId,
  onSelect,
  onToggleStar,
  onRetry,
  onCompose,
  searchTerm,
}: {
  rows: EmailRow[];
  folder: MailFolder;
  loading: boolean;
  initialLoading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleStar: (row: EmailRow) => void;
  onRetry: () => void;
  onCompose: () => void;
  searchTerm?: string;
}): ReactNode {
  if (error) {
    return (
      <Centered
        icon={<IconAlert className="size-5" />}
        tone="failed"
        title="Could not load this folder"
        description={error}
        action={
          <button
            onClick={onRetry}
            className="cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-hover"
          >
            Try again
          </button>
        }
      />
    );
  }

  if (initialLoading) return <ListSkeleton />;

  if (rows.length === 0) {
    if (searchTerm) {
      return (
        <Centered
          icon={<IconSearch className="size-5" />}
          title="No matches"
          description={`Nothing found for "${searchTerm}". Try a different address, subject or keyword.`}
        />
      );
    }
    if (folder === 'scheduled') {
      return (
        <Centered
          icon={<IconClock className="size-5" />}
          title="No scheduled emails"
          description="Compose an email, upload your leads and pick a start time. Everything queued shows up here with its predicted send time."
          action={
            <button
              onClick={onCompose}
              className="cursor-pointer rounded-lg bg-brand-strong px-3.5 py-2 text-[13px] font-medium text-white transition-all hover:brightness-110"
            >
              Compose
            </button>
          }
        />
      );
    }
    if (folder === 'starred') {
      return (
        <Centered
          icon={<IconStar className="size-5" />}
          title="Nothing starred"
          description="Star an email from the list to keep it here."
        />
      );
    }
    return (
      <Centered
        icon={<IconSend className="size-5" />}
        title="Nothing sent yet"
        description="Once the worker starts sending, every delivery lands here with its preview link."
      />
    );
  }

  return (
    <div className="relative flex flex-col">
      {/* A refetch dims the list instead of replacing it with a skeleton, so the
          reader does not lose their place. */}
      {loading && (
        <div className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-brand-soft">
          <div className="h-full w-1/3 animate-pulse bg-brand" />
        </div>
      )}
      <ul className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
        {rows.map((row) => (
          <MailRow
            key={row.id}
            row={row}
            folder={folder}
            selected={row.id === selectedId}
            onSelect={() => onSelect(row.id)}
            onToggleStar={() => onToggleStar(row)}
          />
        ))}
      </ul>
    </div>
  );
}

function MailRow({
  row,
  folder,
  selected,
  onSelect,
  onToggleStar,
}: {
  row: EmailRow;
  folder: MailFolder;
  selected: boolean;
  onSelect: () => void;
  onToggleStar: () => void;
}): ReactNode {
  const showSentTime = folder === 'sent' || row.status === 'SENT' || row.status === 'FAILED';
  const when = showSentTime ? (row.sentAt ?? row.failedAt) : row.scheduledAt;

  return (
    <li className="border-b border-line last:border-b-0">
      <div
        className={[
          'group flex items-center gap-3 px-3 py-2.5 transition-colors',
          selected ? 'bg-brand-soft' : 'hover:bg-hover',
        ].join(' ')}
      >
        {/* The row is a button so Enter/Space open it; the star is a sibling
            control, not nested inside it (nested interactives break keyboard
            navigation and are invalid HTML). */}
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
        >
          <span className="w-[8.5rem] shrink-0 truncate text-[13px] text-ink sm:w-44">
            <span className="text-ink-muted">To: </span>
            {row.recipientName || row.recipientEmail}
          </span>

          <StatusBadge row={row} when={when} showSentTime={showSentTime} />

          <span className="min-w-0 flex-1 truncate text-[13px]">
            <span className="font-medium text-ink">{row.subject}</span>
            <span className="text-ink-muted"> - {previewText(row)}</span>
          </span>
        </button>

        <button
          onClick={onToggleStar}
          aria-label={row.starred ? 'Remove star' : 'Add star'}
          aria-pressed={row.starred}
          className={[
            'shrink-0 cursor-pointer rounded p-1 transition-colors',
            row.starred
              ? 'text-scheduled-dot'
              : 'text-ink-muted opacity-0 hover:text-ink group-hover:opacity-100 focus-visible:opacity-100',
          ].join(' ')}
        >
          <IconStar className="size-4" filled={row.starred} />
        </button>
      </div>
    </li>
  );
}

/**
 * Status badge. Each state ships an icon *and* a word, so meaning survives
 * without colour.
 */
function StatusBadge({
  row,
  when,
  showSentTime,
}: {
  row: EmailRow;
  when: string | null;
  showSentTime: boolean;
}): ReactNode {
  if (row.status === 'FAILED') {
    return (
      <Badge tone="failed" icon={<IconAlert className="size-3" />}>
        Failed
      </Badge>
    );
  }
  if (row.status === 'SENT') {
    return (
      <Badge tone="sent" icon={<IconSend className="size-3" />}>
        Sent
        {showSentTime && when && <Time value={when} />}
      </Badge>
    );
  }
  if (row.status === 'SENDING') {
    return (
      <Badge tone="scheduled" icon={<IconSend className="size-3 animate-pulse-dot" />}>
        Sending
      </Badge>
    );
  }
  if (row.status === 'CANCELLED') {
    return <Badge tone="muted">Cancelled</Badge>;
  }
  // Scheduled: the design shows the send time inline with a clock.
  return (
    <Badge tone="scheduled" icon={<IconClock className="size-3" />}>
      {when ? formatRowTime(when) : 'Scheduled'}
      {row.deferCount > 0 && (
        <span
          className="tnum"
          title={`Deferred ${row.deferCount}× by the rate limiter — moved to a later window`}
        >
          ·{row.deferCount}×
        </span>
      )}
    </Badge>
  );
}

function Time({ value }: { value: string }): ReactNode {
  return <span className="tnum hidden text-ink-muted sm:inline">{formatRowTime(value)}</span>;
}

function Badge({
  tone,
  icon,
  children,
}: {
  tone: 'sent' | 'scheduled' | 'failed' | 'muted';
  icon?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const tones = {
    sent: 'text-sent',
    scheduled: 'text-scheduled',
    failed: 'text-failed',
    muted: 'text-ink-muted',
  } as const;

  return (
    <span
      className={`hidden shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-chip px-1.5 py-0.5 text-[11.5px] font-medium sm:flex ${tones[tone]}`}
    >
      {icon}
      {children}
    </span>
  );
}

function ListSkeleton(): ReactNode {
  return (
    <ul>
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="border-b border-line px-3 py-3">
          <div className="flex items-center gap-3">
            {/* Shaped like a real row so nothing shifts when data lands. */}
            <div className="h-3.5 w-32 shrink-0 animate-pulse rounded bg-chip sm:w-40" />
            <div className="h-3.5 w-16 shrink-0 animate-pulse rounded bg-chip" />
            <div
              className="h-3.5 animate-pulse rounded bg-chip"
              style={{ width: `${[45, 60, 38, 52, 66, 41, 58, 48][i]}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Centered({
  icon,
  title,
  description,
  action,
  tone = 'muted',
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: 'muted' | 'failed';
}): ReactNode {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      <div
        className={[
          'flex size-11 items-center justify-center rounded-xl border',
          tone === 'failed'
            ? 'border-failed/30 bg-failed/10 text-failed'
            : 'border-line bg-muted text-ink-muted',
        ].join(' ')}
      >
        {icon}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-[14px] font-medium text-ink">{title}</p>
        {description && (
          <p className="max-w-sm text-[13px] leading-relaxed text-ink-muted">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
