/**
 * Display formatting.
 *
 * All of it lives here so a timestamp looks the same in every table, and so the
 * stat tiles can use compact notation ("12.9K") per the stat-tile contract while
 * table cells stay exact.
 */

/** Stat-tile values: compact above 10k, exact below. */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) < 10_000) return value.toLocaleString('en-US');
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

const dateTime = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const timeOnly = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

/** "Nov 1, 10:30 PM", or just the time when the date is today. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? timeOnly.format(d) : dateTime.format(d);
}

/** "in 4m", "2h ago" -- relative, with a sign. */
export function formatRelative(iso: string | null): string {
  if (!iso) return '--';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '--';
  const deltaMs = target - Date.now();
  const future = deltaMs > 0;
  const abs = Math.abs(deltaMs);

  let label: string;
  if (abs >= 86_400_000) label = `${Math.round(abs / 86_400_000)}d`;
  else if (abs >= 3_600_000) label = `${Math.round(abs / 3_600_000)}h`;
  else if (abs >= 60_000) label = `${Math.round(abs / 60_000)}m`;
  else if (abs >= 1000) label = `${Math.round(abs / 1000)}s`;
  else return future ? 'now' : 'just now';

  return future ? `in ${label}` : `${label} ago`;
}

/** "2s", "500ms", "1.5m" -- for the configured delay values. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  }
  const m = ms / 60_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
}

/** Shortens a long address for a narrow column without hiding the domain. */
export function truncateMiddle(value: string, max = 34): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/** Turns the limiter's reason codes into something a human can act on. */
export function describeDeferReason(reason: string | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case 'SENDER_HOURLY_LIMIT':
      return 'Hourly limit reached — moved to the next window';
    case 'TENANT_HOURLY_LIMIT':
      return 'Account hourly limit reached — moved to the next window';
    case 'MIN_DELAY':
      return 'Waiting out the minimum delay between sends';
    case 'NO_ACTIVE_SENDER':
      return 'No active sender available — retrying shortly';
    case 'WORKER_LEASE_EXPIRED':
      return 'Previous worker stopped mid-send — reclaimed';
    default:
      return reason;
  }
}

/**
 * List-row timestamp, in the design's style: a weekday plus a precise time for
 * anything within the week ("Tue 9:15:12 AM"), and a date beyond that.
 */
export function formatRowTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const withinWeek = Math.abs(d.getTime() - now.getTime()) < 6 * 86_400_000;

  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  if (sameDay) return time;
  if (withinWeek) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + time;
}

/**
 * The grey preview text after the subject. Falls back to a status sentence when
 * there is no body worth showing, so the row never ends in a dangling dash.
 */
export function previewText(row: {
  preview?: string | null;
  body?: string | null;
  lastError?: string | null;
  status: string;
  recipientEmail: string;
}): string {
  // A failed row's error is more useful than its body.
  if (row.status === 'FAILED' && row.lastError) return row.lastError;
  const text = (row.preview ?? row.body ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return `Queued for ${row.recipientEmail}`;
}

/** Human file size for attachment cards. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
