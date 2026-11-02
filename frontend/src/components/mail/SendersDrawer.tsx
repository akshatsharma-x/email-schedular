'use client';

import { useState, type ReactNode } from 'react';
import { Button, IconButton } from '@/components/ui/Button';
import { IconExternal, IconSlack, IconX } from '@/components/ui/icons';
import { api, API_URL, ApiError } from '@/lib/api';
import { formatDuration, formatRelative, truncateMiddle } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import type { QueueStatus, SendersResponse, SlackStatus } from '@/types/api';

/**
 * Senders, throughput and integrations, in a slide-over.
 *
 * The scheduler's behaviour is invisible in a mail list, so it lives here: the
 * hourly figures are read from the same Redis counters the rate limiter itself
 * uses, which makes the limiter demonstrable — you can watch quota drain during
 * a campaign and see the window reset.
 */
export function SendersDrawer({
  open,
  onClose,
  senders,
  slack,
  queue,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  senders: SendersResponse | null;
  slack: SlackStatus | null;
  queue: QueueStatus | null;
  onChanged: () => void;
}): ReactNode {
  const { push } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  if (!open) return null;

  const run = async (key: string, fn: () => Promise<void>, errTitle: string): Promise<void> => {
    setBusy(key);
    try {
      await fn();
      onChanged();
    } catch (err) {
      push({
        tone: 'error',
        title: errTitle,
        description: err instanceof ApiError ? err.message : 'Unknown error',
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Senders and limits"
        className="animate-in flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-line bg-surface"
      >
        <header className="sticky top-0 flex items-center justify-between gap-2 border-b border-line bg-surface px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink">Senders &amp; limits</h2>
          <IconButton label="Close" onClick={onClose}>
            <IconX className="size-4" />
          </IconButton>
        </header>

        <div className="flex flex-col gap-5 px-4 py-4">
          {/* ---- throughput config ---- */}
          {queue && (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                Throughput
              </h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-line bg-muted px-3 py-2.5 text-[12px]">
                <Stat label="Worker slots" value={String(queue.config.workerConcurrency)} />
                <Stat label="Min delay" value={formatDuration(queue.config.minDelayMs)} />
                <Stat label="Per sender / hr" value={queue.config.perSenderHourly.toLocaleString()} />
                <Stat
                  label="Account / hr"
                  value={
                    queue.config.tenantHourly > 0
                      ? queue.config.tenantHourly.toLocaleString()
                      : 'off'
                  }
                />
                <Stat label="Queued" value={String(queue.counts.delayed ?? 0)} />
                <Stat label="Active" value={String(queue.counts.active ?? 0)} />
              </dl>
              {queue.bullBoardPath && (
                <a
                  href={`${API_URL}${queue.bullBoardPath}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brand-strong hover:underline"
                >
                  Open the live BullMQ board
                  <IconExternal className="size-3.5" />
                </a>
              )}
            </section>
          )}

          {/* ---- senders ---- */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                Senders
              </h3>
              <Button
                size="sm"
                variant="soft"
                loading={busy === 'add'}
                onClick={() =>
                  void run(
                    'add',
                    async () => {
                      const r = await api.createEtherealSender();
                      push({
                        tone: 'success',
                        title: 'Ethereal sender added',
                        description: `${r.sender.fromEmail} — sign in at ethereal.email to read its mail.`,
                        action: { label: 'Ethereal login', href: r.etherealLogin.url },
                      });
                    },
                    'Could not add a sender',
                  )
                }
              >
                Add sender
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              {!senders || senders.senders.length === 0 ? (
                <p className="rounded-lg border border-line bg-muted px-3 py-4 text-center text-[12.5px] text-ink-muted">
                  No senders yet. Scheduling is blocked until you add one.
                </p>
              ) : (
                senders.senders.map((s) => {
                  const ratio = s.hourlyLimit > 0 ? Math.min(1, s.hourlyUsed / s.hourlyLimit) : 0;
                  // Severity in the fill; the numbers beside it carry the same
                  // information without relying on colour.
                  const fill =
                    ratio >= 1 ? 'bg-failed' : ratio >= 0.8 ? 'bg-scheduled-dot' : 'bg-brand';
                  return (
                    <div key={s.id} className="rounded-lg border border-line px-3 py-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-[12.5px] font-medium text-ink" title={s.fromEmail}>
                            {truncateMiddle(s.fromEmail, 28)}
                          </p>
                          <p className="text-[11px] text-ink-muted">
                            {s.label}
                            {s.disabledUntil ? ' · cooling down' : s.isActive ? '' : ' · paused'}
                          </p>
                        </div>
                        <button
                          onClick={() =>
                            void run(
                              s.id,
                              () => api.updateSender(s.id, { isActive: !s.isActive }).then(() => undefined),
                              'Could not update the sender',
                            )
                          }
                          disabled={busy === s.id}
                          className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-ink-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
                        >
                          {s.isActive ? 'Pause' : 'Resume'}
                        </button>
                      </div>

                      <div className="mt-2 flex items-baseline justify-between text-[11px]">
                        <span className="text-ink-muted">This hour</span>
                        <span className="tnum text-ink-secondary">
                          {s.hourlyUsed.toLocaleString()} / {s.hourlyLimit.toLocaleString()}
                        </span>
                      </div>
                      <div
                        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-brand-soft"
                        role="meter"
                        aria-valuenow={s.hourlyUsed}
                        aria-valuemin={0}
                        aria-valuemax={s.hourlyLimit}
                        aria-label={`${s.fromEmail}: ${s.hourlyUsed} of ${s.hourlyLimit} used this hour`}
                      >
                        <div
                          className={`h-full rounded-full transition-[width] duration-500 ${fill}`}
                          style={{ width: `${Math.max(ratio > 0 ? 2 : 0, ratio * 100)}%` }}
                        />
                      </div>
                      {s.nextSendAllowedAt && (
                        <p className="mt-1 text-[11px] text-ink-muted">
                          Next send allowed {formatRelative(s.nextSendAllowedAt)}
                        </p>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* ---- slack ---- */}
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
              Slack alerts
            </h3>
            <div className="rounded-lg border border-line px-3 py-3">
              <div className="flex items-center gap-2">
                <IconSlack className="size-4 text-ink-secondary" />
                <p className="flex-1 text-[12.5px] font-medium text-ink">
                  {slack?.connected
                    ? `Connected${slack.channel ? ` · ${slack.channel}` : ''}`
                    : slack?.revokedAt
                      ? 'Disconnected in Slack'
                      : 'Not connected'}
                </p>
              </div>

              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">
                {!slack?.configured
                  ? 'Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in backend/.env to enable. Rate-limit hits are still handled normally — they just will not notify anyone.'
                  : slack.connected
                    ? 'You get one message per sender per hour when a sender hits its hourly limit.'
                    : slack.revokedAt
                      ? 'Your webhook stopped working. Reconnect to resume — no redeploy needed.'
                      : 'Connect a workspace and pick a channel to be told when a sender hits its limit.'}
              </p>

              {slack?.configured && (
                <div className="mt-2.5 flex gap-2">
                  {slack.connected ? (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy === 'test'}
                        onClick={() =>
                          void run(
                            'test',
                            async () => {
                              const { outcome } = await api.slackTest();
                              push({
                                tone: outcome === 'sent' ? 'success' : 'warning',
                                title:
                                  outcome === 'sent'
                                    ? 'Test message sent to Slack'
                                    : `Slack returned: ${outcome}`,
                              });
                            },
                            'Could not reach Slack',
                          )
                        }
                      >
                        Send test
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === 'disc'}
                        onClick={() =>
                          void run('disc', () => api.slackDisconnect().then(() => undefined), 'Could not disconnect')
                        }
                      >
                        Disconnect
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        // Full navigation: OAuth consent cannot be fetched.
                        window.location.href = api.slackInstallUrl();
                      }}
                    >
                      {slack.revokedAt ? 'Reconnect Slack' : 'Connect Slack'}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* ---- recovery ---- */}
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
              Recovery
            </h3>
            <div className="rounded-lg border border-line px-3 py-3">
              <p className="text-[12px] leading-relaxed text-ink-muted">
                Rebuilds the queue from Postgres and reclaims jobs from a worker that stopped
                mid-send. Runs automatically at boot and on a timer — this is just the manual
                trigger.
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2.5"
                loading={busy === 'rec'}
                onClick={() =>
                  void run(
                    'rec',
                    async () => {
                      const { report, skipped } = await api.reconcile();
                      push({
                        tone: 'info',
                        title: skipped
                          ? 'A sweep is already running'
                          : `Re-queued ${report?.requeued ?? 0}, reclaimed ${report?.reclaimed ?? 0}`,
                      });
                    },
                    'Could not run the sweep',
                  )
                }
              >
                Run recovery sweep
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tnum font-medium text-ink">{value}</dd>
    </div>
  );
}
