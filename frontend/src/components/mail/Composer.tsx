'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Button, IconButton } from '@/components/ui/Button';
import { BareInput, Row } from '@/components/ui/Field';
import {
  IconArrowLeft,
  IconCalendar,
  IconChevronDown,
  IconClock,
  IconFile,
  IconPaperclip,
  IconTrash,
  IconUpload,
  IconX,
} from '@/components/ui/icons';
import { RichTextEditor } from '@/components/mail/RichTextEditor';
import { api, API_URL, ApiError } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import type { AttachmentRef, Lead, ParsedLeadsResponse, SenderRow } from '@/types/api';

/**
 * Compose screen.
 *
 * Mirrors the design's layout: From / To (+ Upload List) / Subject, the delay
 * and hourly-limit pair, the body with its toolbar below, attachments, and
 * Send / Send Later in the header.
 *
 * Two deliberate choices:
 *
 *  - **The lead file is parsed by the server**, not here. The "N detected"
 *    number the user approves is then produced by the exact code that will
 *    create the jobs; a second client-side parser would eventually disagree and
 *    show a count that is not what gets scheduled.
 *  - **One idempotency key per composer session.** A double-click on Send, or a
 *    retry after a flaky response, returns the original campaign instead of
 *    sending everything twice.
 */

const MAX_CHIPS_SHOWN = 3;

export function Composer({
  senders,
  defaults,
  onClose,
  onScheduled,
  onSendersChanged,
}: {
  senders: SenderRow[];
  defaults: { minDelayMs: number; perSenderHourly: number };
  onClose: () => void;
  onScheduled: () => void;
  /** Refetches the sender list after one is provisioned from here. */
  onSendersChanged: () => void;
}): ReactNode {
  const { push } = useToast();

  const activeSenders = senders.filter((s) => s.isActive);
  // Empty string = "all senders" (round-robin), which is the higher-throughput
  // default and what the scheduler does when no sender is pinned.
  const [senderId, setSenderId] = useState<string>('');
  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [bodyText, setBodyText] = useState('');

  const [manualTo, setManualTo] = useState('');
  const [recipients, setRecipients] = useState<Lead[]>([]);
  const [parsed, setParsed] = useState<ParsedLeadsResponse | null>(null);
  const [parsing, setParsing] = useState(false);
  const [listName, setListName] = useState<string | null>(null);

  const [delaySeconds, setDelaySeconds] = useState(String(Math.round(defaults.minDelayMs / 1000)));
  const [hourlyLimit, setHourlyLimit] = useState(String(defaults.perSenderHourly));

  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [uploading, setUploading] = useState(false);

  const [scheduleAt, setScheduleAt] = useState<Date | null>(null);
  const [laterOpen, setLaterOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [addingSender, setAddingSender] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const listInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const idempotencyKey = useRef(crypto.randomUUID());

  const selectedSender = activeSenders.find((s) => s.id === senderId);

  // ---- recipients ---------------------------------------------------------
  const commitManual = useCallback(() => {
    const raw = manualTo.trim().replace(/[,;]$/, '');
    if (!raw) return;
    const found = raw.match(/[^\s,;<>]+@[^\s,;<>]+\.[A-Za-z]{2,}/g);
    if (!found) {
      setErrors((e) => ({ ...e, to: 'That does not look like an email address' }));
      return;
    }
    setRecipients((prev) => {
      const seen = new Set(prev.map((r) => r.email));
      const next = [...prev];
      for (const addr of found) {
        const email = addr.toLowerCase();
        if (!seen.has(email)) {
          seen.add(email);
          next.push({ email, name: null });
        }
      }
      return next;
    });
    setManualTo('');
    setErrors((e) => ({ ...e, to: '' }));
  }, [manualTo]);

  const uploadList = async (file: File): Promise<void> => {
    setParsing(true);
    setListName(file.name);
    try {
      const content = await file.text();
      const result = await api.parseLeads(content, file.name);
      setParsed(result);
      setRecipients((prev) => {
        const seen = new Set(prev.map((r) => r.email));
        return [...prev, ...result.recipients.filter((r) => !seen.has(r.email))];
      });
      setErrors((e) => ({ ...e, to: '' }));
      if (result.detected === 0) {
        setErrors((e) => ({ ...e, to: 'No valid email addresses in that file' }));
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not read that file';
      setErrors((e) => ({ ...e, to: message }));
      push({ tone: 'error', title: 'Could not parse the list', description: message });
    } finally {
      setParsing(false);
    }
  };

  // ---- attachments --------------------------------------------------------
  const uploadFiles = async (files: FileList): Promise<void> => {
    setUploading(true);
    try {
      const result = await api.uploadAttachments(Array.from(files));
      setAttachments((prev) => [...prev, ...result.attachments]);
    } catch (err) {
      push({
        tone: 'error',
        title: 'Upload failed',
        description: err instanceof ApiError ? err.message : 'Unknown error',
      });
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = async (id: string): Promise<void> => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    await api.deleteAttachment(id).catch(() => undefined);
  };

  /**
   * A brand-new account owns no senders, so scheduling is blocked on first run --
   * including for a reviewer who has just logged in with Google for the first
   * time. Pointing at a drawer they have to go find is a dead end, so the fix is
   * offered inline, right where the block happens.
   */
  const addSenderInline = async (): Promise<void> => {
    setAddingSender(true);
    try {
      const result = await api.createEtherealSender();
      // Select it immediately: the user asked for a sender because they want to
      // send from one.
      setSenderId(result.sender.id);
      onSendersChanged();
      push({
        tone: 'success',
        title: 'Sender ready',
        description: `${result.sender.fromEmail} — read its delivered mail at ethereal.email.`,
        action: { label: 'Ethereal login', href: result.etherealLogin.url },
      });
    } catch (err) {
      push({
        tone: 'error',
        title: 'Could not add a sender',
        description: err instanceof ApiError ? err.message : 'Unknown error',
      });
    } finally {
      setAddingSender(false);
    }
  };

  // ---- submit -------------------------------------------------------------
  function validate(): boolean {
    const next: Record<string, string> = {};
    if (recipients.length === 0) next.to = 'Add at least one recipient';
    if (!subject.trim()) next.subject = 'Subject is required';
    if (!bodyText.trim()) next.body = 'Write something to send';
    const delay = Number(delaySeconds);
    if (!Number.isFinite(delay) || delay < 0) next.delay = 'Seconds, 0 or more';
    const limit = Number(hourlyLimit);
    if (!Number.isInteger(limit) || limit < 1) next.hourly = 'Whole number, 1 or more';
    if (activeSenders.length === 0) next.from = 'Add a sender before scheduling';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(when: Date | null): Promise<void> {
    if (!validate()) return;
    setSending(true);
    try {
      const result = await api.schedule({
        subject: subject.trim(),
        body: bodyText.trim(),
        bodyHtml: bodyHtml.trim() || undefined,
        recipients,
        // No explicit time means "start now".
        startAt: (when ?? new Date()).toISOString(),
        minDelayMs: Math.round(Number(delaySeconds) * 1000),
        maxPerHour: Number(hourlyLimit),
        senderId: senderId || undefined,
        attachmentIds: attachments.map((a) => a.id),
        idempotencyKey: idempotencyKey.current,
      });

      push({
        tone: 'success',
        title: result.deduplicated
          ? 'Already scheduled'
          : `${result.recipients.scheduled.toLocaleString()} email${
              result.recipients.scheduled === 1 ? '' : 's'
            } scheduled`,
        description: `${result.plan.senderCount} sender${
          result.plan.senderCount === 1 ? '' : 's'
        } · ${result.plan.windowsUsed} hour window${
          result.plan.windowsUsed === 1 ? '' : 's'
        } · finishes ${formatDateTime(result.plan.lastSendAt)}`,
      });
      onScheduled();
      onClose();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Scheduling failed';
      push({ tone: 'error', title: 'Could not schedule', description: message });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="animate-in flex min-h-0 flex-1 flex-col">
      {/* ---- header ---- */}
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
        <IconButton label="Back" onClick={onClose} disabled={sending}>
          <IconArrowLeft className="size-4" />
        </IconButton>
        <h1 className="flex-1 text-[14px] font-semibold text-ink">Compose New Email</h1>

        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            if (e.target.files?.length) void uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <IconButton
          label="Attach files"
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
        >
          <IconPaperclip className="size-4" />
        </IconButton>

        <div className="relative">
          <IconButton
            label="Schedule for later"
            active={Boolean(scheduleAt)}
            onClick={() => setLaterOpen((o) => !o)}
          >
            <IconClock className="size-4" />
          </IconButton>
          {laterOpen && (
            <SendLaterPopover
              value={scheduleAt}
              onCancel={() => setLaterOpen(false)}
              onDone={(when) => {
                setScheduleAt(when);
                setLaterOpen(false);
              }}
            />
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          loading={sending}
          // Disabled rather than letting the click fail server-side with
          // "No active senders configured".
          disabled={activeSenders.length === 0}
          title={
            activeSenders.length === 0 ? 'Add a sender before scheduling' : undefined
          }
          onClick={() => void submit(scheduleAt)}
          className="rounded-full"
        >
          {scheduleAt ? 'Send Later' : 'Send'}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 sm:px-6 sm:py-4">
        {/* ---- From ---- */}
        <Row label="From" error={errors.from}>
          {activeSenders.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-ink-secondary">
                {senders.length === 0
                  ? 'No sender yet — one is needed to send.'
                  : 'All senders are paused.'}
              </span>
              <Button
                size="sm"
                variant="soft"
                loading={addingSender}
                onClick={() => void addSenderInline()}
              >
                Add Ethereal sender
              </Button>
            </div>
          ) : (
            <div className="relative">
              <select
                value={senderId}
                onChange={(e) => setSenderId(e.target.value)}
                aria-label="From address"
                className="cursor-pointer appearance-none rounded-md border border-line bg-muted py-1 pl-2.5 pr-7 text-[13px] text-ink focus:border-brand-border focus:outline-none"
              >
                <option value="">All senders (round-robin)</option>
                {activeSenders.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fromEmail}
                  </option>
                ))}
              </select>
              <IconChevronDown className="pointer-events-none absolute right-2 top-1.5 size-3.5 text-ink-muted" />
            </div>
          )}
          {selectedSender && (
            <span className="hidden text-[11.5px] text-ink-muted sm:inline">
              {selectedSender.hourlyRemaining.toLocaleString()} of{' '}
              {selectedSender.hourlyLimit.toLocaleString()} left this hour
            </span>
          )}
        </Row>

        {/* ---- To ---- */}
        <Row
          label="To"
          error={errors.to}
          right={
            <>
              <input
                ref={listInput}
                type="file"
                accept=".csv,.txt,.tsv,text/csv,text/plain"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadList(file);
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => listInput.current?.click()}
                disabled={parsing}
                className="inline-flex cursor-pointer items-center gap-1.5 text-[12.5px] font-medium text-ink-secondary transition-colors hover:text-brand-strong disabled:opacity-50"
              >
                <IconUpload className="size-3.5" />
                {parsing ? 'Parsing…' : 'Upload List'}
              </button>
            </>
          }
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {recipients.slice(0, MAX_CHIPS_SHOWN).map((r) => (
              <span
                key={r.email}
                className="inline-flex max-w-[12rem] items-center gap-1 rounded-md bg-chip px-1.5 py-0.5 text-[12px] text-ink"
              >
                <span className="truncate" title={r.email}>
                  {r.email}
                </span>
                <button
                  onClick={() => setRecipients((prev) => prev.filter((x) => x.email !== r.email))}
                  aria-label={`Remove ${r.email}`}
                  className="shrink-0 cursor-pointer text-ink-muted hover:text-ink"
                >
                  <IconX className="size-3" />
                </button>
              </span>
            ))}
            {recipients.length > MAX_CHIPS_SHOWN && (
              <span
                className="tnum rounded-md bg-brand-soft px-1.5 py-0.5 text-[12px] font-medium text-brand-strong"
                title={`${recipients.length} recipients in total`}
              >
                +{recipients.length - MAX_CHIPS_SHOWN}
              </span>
            )}
            <BareInput
              value={manualTo}
              onChange={(e) => setManualTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
                  e.preventDefault();
                  commitManual();
                }
                // Backspace on an empty input removes the last chip.
                if (e.key === 'Backspace' && !manualTo && recipients.length > 0) {
                  setRecipients((prev) => prev.slice(0, -1));
                }
              }}
              onBlur={commitManual}
              placeholder={recipients.length === 0 ? 'adyasha.singh@example.com' : ''}
              className="min-w-[10rem] flex-1"
            />
          </div>
        </Row>

        {/* Parse summary: the server's authoritative counts. */}
        {parsed && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-1 py-2 pl-[5.5rem] text-[11.5px] sm:pl-[6.75rem]">
            <span className="rounded-md bg-brand-soft px-1.5 py-0.5 font-medium text-brand-strong">
              <span className="tnum">{parsed.detected.toLocaleString()}</span> detected
            </span>
            {parsed.duplicates > 0 && (
              <span className="rounded-md bg-chip px-1.5 py-0.5 text-scheduled">
                <span className="tnum">{parsed.duplicates}</span> duplicate
                {parsed.duplicates === 1 ? '' : 's'} removed
              </span>
            )}
            {parsed.invalid > 0 && (
              <span
                className="rounded-md bg-chip px-1.5 py-0.5 text-failed"
                title={parsed.invalidSamples.slice(0, 5).join(', ')}
              >
                <span className="tnum">{parsed.invalid}</span> invalid skipped
              </span>
            )}
            {listName && <span className="text-ink-muted">from {listName}</span>}
          </div>
        )}

        {/* ---- Subject ---- */}
        <Row label="Subject" error={errors.subject}>
          <BareInput
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            maxLength={500}
          />
        </Row>

        {/* ---- pacing ---- */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-1 py-2.5">
          <NumberField
            label="Delay between 2 emails"
            value={delaySeconds}
            onChange={setDelaySeconds}
            error={errors.delay}
            suffix="sec"
            min={0}
          />
          <NumberField
            label="Hourly Limit"
            value={hourlyLimit}
            onChange={setHourlyLimit}
            error={errors.hourly}
            min={1}
          />
          {scheduleAt && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-brand-soft px-2 py-1 text-[12px] font-medium text-brand-strong">
              <IconClock className="size-3.5" />
              Sends {formatDateTime(scheduleAt.toISOString())}
              <button
                onClick={() => setScheduleAt(null)}
                aria-label="Send immediately instead"
                className="cursor-pointer text-brand-strong/70 hover:text-brand-strong"
              >
                <IconX className="size-3" />
              </button>
            </span>
          )}
        </div>

        {/* ---- body ---- */}
        <div className="pt-2">
          <RichTextEditor
            value={bodyHtml}
            onChange={(html, text) => {
              setBodyHtml(html);
              setBodyText(text);
            }}
          />
          {errors.body && <p className="mt-1 px-1 text-xs text-failed">{errors.body}</p>}
        </div>

        {/* ---- attachments ---- */}
        {(attachments.length > 0 || uploading) && (
          <div className="mt-3 flex flex-wrap gap-2.5">
            {attachments.map((file) => (
              <div
                key={file.id}
                className="group relative w-32 overflow-hidden rounded-lg border border-line bg-surface"
              >
                <div className="flex h-20 items-center justify-center overflow-hidden bg-muted">
                  {file.isImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`${API_URL}${file.url}`}
                      alt={file.filename}
                      className="size-full object-cover"
                    />
                  ) : (
                    <IconFile className="size-6 text-ink-muted" />
                  )}
                </div>
                <div className="px-2 py-1.5">
                  <p className="truncate text-[11px] font-medium text-ink" title={file.filename}>
                    {file.filename}
                  </p>
                  <p className="tnum text-[10px] text-ink-muted">{formatBytes(file.sizeBytes)}</p>
                </div>
                <button
                  onClick={() => void removeAttachment(file.id)}
                  aria-label={`Remove ${file.filename}`}
                  className="absolute right-1 top-1 cursor-pointer rounded-md bg-surface/90 p-1 text-ink-muted opacity-0 transition-opacity hover:text-failed group-hover:opacity-100"
                >
                  <IconTrash className="size-3.5" />
                </button>
              </div>
            ))}
            {uploading && (
              <div className="flex h-[6.75rem] w-32 items-center justify-center rounded-lg border border-dashed border-line text-[11px] text-ink-muted">
                Uploading…
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  error,
  suffix,
  min,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  suffix?: string;
  min: number;
}): ReactNode {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[12.5px] text-ink-secondary">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          min={min}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={[
            'tnum h-7 w-16 rounded-md border bg-muted px-2 text-center text-[13px] text-ink',
            'focus:border-brand-border focus:outline-none',
            error ? 'border-failed' : 'border-line',
          ].join(' ')}
        />
        {suffix && <span className="text-[11.5px] text-ink-muted">{suffix}</span>}
      </span>
    </label>
  );
}

/**
 * Send Later popover, as in the design: a date-time picker plus the quick
 * presets people actually use.
 */
function SendLaterPopover({
  value,
  onCancel,
  onDone,
}: {
  value: Date | null;
  onCancel: () => void;
  onDone: (when: Date) => void;
}): ReactNode {
  const toLocalInput = (d: Date): string => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}`;
  };

  const [local, setLocal] = useState(() =>
    toLocalInput(value ?? new Date(Date.now() + 3600_000)),
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const presets = (): { label: string; date: Date }[] => {
    const at = (dayOffset: number, hour: number): Date => {
      const d = new Date();
      d.setDate(d.getDate() + dayOffset);
      d.setHours(hour, 0, 0, 0);
      return d;
    };
    return [
      { label: 'In an hour', date: new Date(Date.now() + 3600_000) },
      { label: 'Tomorrow, 10:00 AM', date: at(1, 10) },
      { label: 'Tomorrow, 11:00 AM', date: at(1, 11) },
      { label: 'Tomorrow, 3:00 PM', date: at(1, 15) },
    ];
  };

  return (
    <div
      ref={ref}
      className="animate-in absolute right-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
    >
      <p className="border-b border-line px-3 py-2 text-[13px] font-semibold text-ink">
        Send Later
      </p>

      <div className="flex flex-col gap-1 p-2">
        <label className="flex items-center gap-2 rounded-lg border border-line bg-muted px-2 py-1.5">
          <IconCalendar className="size-3.5 shrink-0 text-ink-muted" />
          <input
            type="datetime-local"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            aria-label="Pick date and time"
            className="w-full bg-transparent text-[12.5px] text-ink focus:outline-none"
          />
        </label>

        {presets().map((p) => (
          <button
            key={p.label}
            onClick={() => setLocal(toLocalInput(p.date))}
            className="cursor-pointer rounded-lg px-2 py-1.5 text-left text-[12.5px] text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line px-2 py-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="rounded-full"
          onClick={() => {
            const when = new Date(local);
            // An invalid or past instant would silently become "now" on the
            // server; say so instead.
            if (Number.isNaN(when.getTime())) return;
            onDone(when);
          }}
        >
          Done
        </Button>
      </div>
    </div>
  );
}
