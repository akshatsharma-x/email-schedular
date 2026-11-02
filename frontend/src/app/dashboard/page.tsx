'use client';

import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Composer } from '@/components/mail/Composer';
import { MailDetail } from '@/components/mail/MailDetail';
import { MailList } from '@/components/mail/MailList';
import { SendersDrawer } from '@/components/mail/SendersDrawer';
import { Sidebar } from '@/components/mail/Sidebar';
import { Topbar } from '@/components/mail/Topbar';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useEventStream } from '@/hooks/useEventStream';
import { useResource } from '@/hooks/useResource';
import { useToast } from '@/hooks/useToast';
import type { EmailRow, EmailStatus, MailFolder, OutboxEvent } from '@/types/api';

/**
 * The mail client.
 *
 * One page holds three mutually exclusive panes — list, reading, composing —
 * because that is how the design works and it keeps all the shared state
 * (folder, search, selection, counts) in one place rather than threading it
 * through routes.
 */

const FOLDER_STATUSES: Record<MailFolder, EmailStatus[]> = {
  scheduled: ['SCHEDULED', 'SENDING'],
  // A failed send belongs in Sent: it was attempted, and the design's list
  // carries a sent/failed status either way.
  sent: ['SENT', 'FAILED'],
  starred: [],
};

type Pane = 'list' | 'detail' | 'compose';

export default function DashboardPage(): ReactNode {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-canvas" />}>
      <Mail />
    </Suspense>
  );
}

function Mail(): ReactNode {
  const router = useRouter();
  const params = useSearchParams();
  const { push } = useToast();

  const [folder, setFolder] = useState<MailFolder>('scheduled');
  const [pane, setPane] = useState<Pane>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [sendersOpen, setSendersOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [starBusy, setStarBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const me = useResource(() => api.me(), []);

  useEffect(() => {
    if (me.error?.isAuthError) router.replace('/login');
  }, [me.error, router]);

  // Debounced so typing does not fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const enabled = Boolean(me.data);

  const stats = useResource(() => api.stats(), [refreshKey], { enabled });
  const senders = useResource(() => api.senders(), [refreshKey], { enabled });
  const slack = useResource(() => api.slackStatus(), [refreshKey], { enabled });
  const queue = useResource(() => api.queue(), [refreshKey], { enabled });

  const emails = useResource(
    () =>
      api.emails({
        status: FOLDER_STATUSES[folder],
        q: debounced || undefined,
        limit: 60,
        sort: folder === 'sent' ? 'sent_desc' : 'scheduled_asc',
      }),
    [folder, debounced, refreshKey],
    { enabled },
  );

  const detail = useResource(() => api.email(selectedId!), [selectedId], {
    enabled: enabled && pane === 'detail' && Boolean(selectedId),
  });

  // The starred folder and the filter toggle are both client-side filters over
  // the fetched page, so they never need their own request.
  const allRows = emails.data?.emails ?? [];
  const rows = (folder === 'starred' || starredOnly
    ? allRows.filter((r) => r.starred)
    : allRows) as EmailRow[];

  // For the starred folder, fetch across both statuses instead of none.
  const starredSource = useResource(
    () => api.emails({ limit: 100, sort: 'scheduled_desc' }),
    [refreshKey],
    { enabled: enabled && folder === 'starred' },
  );
  const visibleRows =
    folder === 'starred' ? (starredSource.data?.emails ?? []).filter((r) => r.starred) : rows;

  // ---- live updates -------------------------------------------------------
  const pending = useRef<number | null>(null);
  const scheduleRefresh = useCallback(() => {
    // Events can arrive faster than it is useful to refetch; coalesce to 1/sec.
    if (pending.current !== null) return;
    pending.current = window.setTimeout(() => {
      pending.current = null;
      refresh();
    }, 1000);
  }, [refresh]);

  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );

  const onEvent = useCallback(
    (event: OutboxEvent) => {
      scheduleRefresh();
      // Only interrupt for things a user would act on.
      if (event.type === 'ratelimit.hit') {
        push({
          tone: 'warning',
          title: `Hourly limit reached for ${event.senderEmail}`,
          description: `Remaining emails moved to the next window, which opens ${formatRelative(
            event.resumesAt,
          )}. Nothing was dropped.`,
        });
      } else if (event.type === 'email.failed') {
        push({ tone: 'error', title: `Delivery failed: ${event.recipient}`, description: event.error });
      } else if (event.type === 'reconcile.done' && (event.requeued > 0 || event.reclaimed > 0)) {
        push({
          tone: 'info',
          title: 'Queue recovered',
          description: `${event.requeued} re-queued from the database, ${event.reclaimed} reclaimed from a stopped worker.`,
        });
      }
    },
    [push, scheduleRefresh],
  );

  const { connected } = useEventStream(onEvent, enabled);

  // ---- Slack OAuth return -------------------------------------------------
  useEffect(() => {
    const slackParam = params.get('slack');
    if (!slackParam) return;
    push(
      slackParam === 'connected'
        ? {
            tone: 'success',
            title: 'Slack connected',
            description: params.get('detail') ? `Alerts post to ${params.get('detail')}.` : undefined,
          }
        : {
            tone: 'error',
            title: 'Slack connection failed',
            description: params.get('detail') ?? undefined,
          },
    );
    refresh();
    // Clear the query string so a reload does not re-toast.
    router.replace('/dashboard');
  }, [params, push, refresh, router]);

  // ---- actions ------------------------------------------------------------
  async function logout(): Promise<void> {
    setLoggingOut(true);
    try {
      await api.logout();
      router.replace('/login');
    } catch {
      setLoggingOut(false);
    }
  }

  const toggleStar = useCallback(
    async (row: { id: string; starred: boolean }) => {
      setStarBusy(true);
      try {
        await api.setStarred(row.id, !row.starred);
        refresh();
        if (pane === 'detail') detail.refetch();
      } catch {
        push({ tone: 'error', title: 'Could not update the star' });
      } finally {
        setStarBusy(false);
      }
    },
    [refresh, pane, detail, push],
  );

  if (me.initialLoading || !me.data) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas">
        <p className="text-[13px] text-ink-muted">Loading…</p>
      </main>
    );
  }

  const s = stats.data?.stats;

  return (
    <div className="flex min-h-dvh flex-col bg-canvas lg:h-dvh lg:flex-row lg:overflow-hidden">
      <Sidebar
        user={me.data.user}
        folder={folder}
        onFolderChange={(f) => {
          setFolder(f);
          setPane('list');
          setSelectedId(null);
        }}
        counts={{
          scheduled: (s?.scheduled ?? 0) + (s?.sending ?? 0),
          sent: (s?.sent ?? 0) + (s?.failed ?? 0),
          starred: s?.starred ?? 0,
        }}
        onCompose={() => setPane('compose')}
        onLogout={() => void logout()}
        loggingOut={loggingOut}
        onOpenSenders={() => setSendersOpen(true)}
      />

      <main className="flex min-h-0 flex-1 flex-col bg-surface lg:overflow-hidden">
        {pane === 'compose' ? (
          <Composer
            senders={senders.data?.senders ?? []}
            defaults={{
              minDelayMs: senders.data?.limits.minDelayMs ?? 2000,
              perSenderHourly: senders.data?.limits.perSenderHourlyDefault ?? 200,
            }}
            onClose={() => setPane('list')}
            onScheduled={() => {
              setFolder('scheduled');
              refresh();
            }}
            onSendersChanged={refresh}
          />
        ) : pane === 'detail' ? (
          <MailDetail
            email={detail.data?.email ?? null}
            loading={detail.loading}
            error={detail.error ? detail.error.message : null}
            onBack={() => {
              setPane('list');
              setSelectedId(null);
            }}
            onToggleStar={() => {
              const e = detail.data?.email;
              if (e) void toggleStar(e);
            }}
            starBusy={starBusy}
          />
        ) : (
          <>
            <Topbar
              search={search}
              onSearchChange={setSearch}
              onRefresh={refresh}
              refreshing={emails.loading}
              filterActive={starredOnly}
              onToggleFilter={() => setStarredOnly((v) => !v)}
              searchSource={emails.data?.source ?? null}
              resultCount={emails.data?.total}
            />

            {/* A live SSE connection is the difference between the list
                updating itself and the user wondering if it is stuck. */}
            <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
              <span
                className={`size-1.5 rounded-full ${
                  connected ? 'animate-pulse-dot bg-brand' : 'bg-ink-muted'
                }`}
                aria-hidden="true"
              />
              <span className="text-[11px] text-ink-muted">
                {connected ? 'Live' : 'Offline'}
                {s?.nextSendAt && ` · next send ${formatRelative(s.nextSendAt)}`}
                {s && s.deferred > 0 && ` · ${s.deferred} rate-limited`}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <MailList
                rows={visibleRows}
                folder={folder}
                loading={
                  folder === 'starred' ? starredSource.loading : emails.loading
                }
                initialLoading={
                  folder === 'starred' ? starredSource.initialLoading : emails.initialLoading
                }
                error={emails.error ? emails.error.message : null}
                selectedId={selectedId}
                onSelect={(id) => {
                  setSelectedId(id);
                  setPane('detail');
                }}
                onToggleStar={(row) => void toggleStar(row)}
                onRetry={emails.refetch}
                onCompose={() => setPane('compose')}
                searchTerm={debounced || undefined}
              />
            </div>
          </>
        )}
      </main>

      <SendersDrawer
        open={sendersOpen}
        onClose={() => setSendersOpen(false)}
        senders={senders.data}
        slack={slack.data}
        queue={queue.data}
        onChanged={refresh}
      />
    </div>
  );
}
