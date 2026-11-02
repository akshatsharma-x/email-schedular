'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton, Spinner } from '@/components/ui/Button';
import {
  IconFilter,
  IconMoon,
  IconRefresh,
  IconSearch,
  IconSun,
  IconX,
} from '@/components/ui/icons';
import { useTheme } from '@/hooks/useTheme';

/**
 * Search bar + actions, matching the design's top row.
 *
 * The theme toggle lives here (as requested). It reports the *action* in its
 * label ("Switch to dark theme") rather than the current state, which is what a
 * screen-reader user needs in order to know what pressing it will do.
 */
export function Topbar({
  search,
  onSearchChange,
  onRefresh,
  refreshing,
  filterActive,
  onToggleFilter,
  searchSource,
  resultCount,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  filterActive: boolean;
  onToggleFilter: () => void;
  /** Which engine answered the current search, when searching. */
  searchSource?: 'elasticsearch' | 'postgres' | null;
  resultCount?: number;
}): ReactNode {
  const { theme, toggle } = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses search, Escape clears it -- the shortcut every mail client has.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el as HTMLElement | null)?.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape' && el === inputRef.current) {
        onSearchChange('');
        inputRef.current?.blur();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onSearchChange]);

  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2.5">
      <div className="relative min-w-0 flex-1">
        <IconSearch className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-muted" />
        <input
          ref={inputRef}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search"
          aria-label="Search emails"
          className="h-9 w-full rounded-lg border border-transparent bg-muted pl-9 pr-9 text-[13px] text-ink placeholder:text-ink-muted transition-colors hover:border-line focus:border-brand-border focus:bg-surface focus:outline-none"
        />
        {search && (
          <button
            onClick={() => onSearchChange('')}
            aria-label="Clear search"
            className="absolute right-2 top-2 cursor-pointer rounded p-1 text-ink-muted transition-colors hover:bg-hover hover:text-ink"
          >
            <IconX className="size-3.5" />
          </button>
        )}
      </div>

      {/* Naming the engine makes the Elasticsearch path verifiable rather than
          invisible -- and shows when it has fallen back to Postgres. */}
      {search && searchSource && (
        <span className="hidden shrink-0 items-center gap-1.5 rounded-md bg-chip px-2 py-1 text-[11px] text-ink-secondary sm:flex">
          <span className="tnum">{(resultCount ?? 0).toLocaleString()}</span>
          <span className="text-ink-muted">via {searchSource}</span>
        </span>
      )}

      <IconButton
        label={filterActive ? 'Show all emails' : 'Show starred only'}
        active={filterActive}
        onClick={onToggleFilter}
      >
        <IconFilter className="size-4" />
      </IconButton>

      <IconButton label="Refresh" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? <Spinner className="size-4" /> : <IconRefresh className="size-4" />}
      </IconButton>

      <IconButton
        label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={toggle}
      >
        {theme === 'dark' ? <IconSun className="size-4" /> : <IconMoon className="size-4" />}
      </IconButton>
    </header>
  );
}
