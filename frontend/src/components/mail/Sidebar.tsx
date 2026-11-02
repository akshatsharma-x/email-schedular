'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import {
  IconChevronDown,
  IconClock,
  IconLogout,
  IconSend,
  IconStar,
  IconUsers,
} from '@/components/ui/icons';
import type { AuthUser, MailFolder } from '@/types/api';

/**
 * Left rail: brand, account chip, Compose, and the mail folders.
 *
 * Folder counts come from the same stats call the rest of the app uses, so the
 * badge can never disagree with the list it links to.
 */
export function Sidebar({
  user,
  folder,
  onFolderChange,
  counts,
  onCompose,
  onLogout,
  loggingOut,
  onOpenSenders,
}: {
  user: AuthUser;
  folder: MailFolder;
  onFolderChange: (folder: MailFolder) => void;
  counts: { scheduled: number; sent: number; starred: number };
  onCompose: () => void;
  onLogout: () => void;
  loggingOut: boolean;
  onOpenSenders: () => void;
}): ReactNode {
  return (
    <aside className="flex w-full shrink-0 flex-col gap-3 border-b border-line bg-surface px-3 py-3 lg:h-dvh lg:w-[232px] lg:border-b-0 lg:border-r">
      {/* Wordmark, matching the design's heavy lowercase-height treatment. */}
      <div className="px-1.5 pt-0.5">
        <span className="text-[22px] font-extrabold tracking-tight text-ink">
          ON<span className="text-brand-strong">E</span>
        </span>
      </div>

      <AccountChip user={user} onLogout={onLogout} loggingOut={loggingOut} />

      <Button variant="soft" fullWidth onClick={onCompose}>
        Compose
      </Button>

      <nav className="flex flex-col gap-0.5" aria-label="Mail folders">
        <p className="px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
          Mail
        </p>

        <FolderLink
          icon={<IconClock className="size-4" />}
          label="Scheduled"
          count={counts.scheduled}
          active={folder === 'scheduled'}
          onClick={() => onFolderChange('scheduled')}
        />
        <FolderLink
          icon={<IconSend className="size-4" />}
          label="Sent"
          count={counts.sent}
          active={folder === 'sent'}
          onClick={() => onFolderChange('sent')}
        />
        <FolderLink
          icon={<IconStar className="size-4" />}
          label="Starred"
          count={counts.starred}
          active={folder === 'starred'}
          onClick={() => onFolderChange('starred')}
        />
      </nav>

      {/* Pushed to the bottom on desktop; inline on mobile. */}
      <div className="mt-auto hidden lg:block">
        <button
          onClick={onOpenSenders}
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
        >
          <IconUsers className="size-4" />
          Senders &amp; limits
        </button>
      </div>
    </aside>
  );
}

function FolderLink({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={[
        'flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-[13px] transition-colors',
        active
          ? 'bg-brand-soft font-medium text-brand-strong'
          : 'text-ink-secondary hover:bg-hover hover:text-ink',
      ].join(' ')}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {count > 0 && (
        <span className="tnum text-[11.5px] text-ink-muted">{count.toLocaleString()}</span>
      )}
    </button>
  );
}

/** Avatar + name + email, with a dropdown holding logout. */
function AccountChip({
  user,
  onLogout,
  loggingOut,
}: {
  user: AuthUser;
  onLogout: () => void;
  loggingOut: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click and on Escape -- a dropdown that only closes by
  // clicking itself again feels broken.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-hover"
      >
        <Avatar user={user} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium leading-tight text-ink">
            {user.name}
          </span>
          <span className="truncate text-[11px] leading-tight text-ink-muted">{user.email}</span>
        </span>
        <IconChevronDown className={`size-3.5 shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="animate-in absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          <div className="border-b border-line px-3 py-2">
            <p className="truncate text-[12px] font-medium text-ink">{user.name}</p>
            <p className="truncate text-[11px] text-ink-muted">{user.email}</p>
          </div>
          <button
            role="menuitem"
            onClick={onLogout}
            disabled={loggingOut}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-[13px] text-ink-secondary transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
          >
            <IconLogout className="size-4" />
            {loggingOut ? 'Signing out…' : 'Logout'}
          </button>
        </div>
      )}
    </div>
  );
}

export function Avatar({
  user,
  size = 'sm',
}: {
  user: { name: string; avatarUrl?: string | null };
  size?: 'sm' | 'lg';
}): ReactNode {
  // A failed avatar load degrades to initials rather than a broken-image icon.
  const [failed, setFailed] = useState(false);
  const dim = size === 'lg' ? 'size-9 text-[13px]' : 'size-7 text-[11px]';

  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  if (user.avatarUrl && !failed) {
    return (
      // Plain <img>: avatars come from Google's CDN, which next/image would
      // require whitelisting per host up front.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.avatarUrl}
        alt={user.name}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`${dim} shrink-0 rounded-full object-cover`}
      />
    );
  }

  return (
    <span
      className={`${dim} flex shrink-0 items-center justify-center rounded-full bg-brand-strong font-semibold text-white`}
      title={user.name}
    >
      {initials || '?'}
    </span>
  );
}
