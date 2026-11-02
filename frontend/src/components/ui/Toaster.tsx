'use client';

import type { ReactNode } from 'react';
import { useToast, type ToastTone } from '@/hooks/useToast';

/**
 * Toast viewport.
 *
 * Each tone pairs a reserved status color with its own icon and text, so the
 * meaning of a toast never rests on hue alone. `aria-live="polite"` means a
 * screen reader announces new toasts without interrupting whatever the user is
 * doing.
 */

const TONE: Record<ToastTone, { ring: string; icon: ReactNode; iconColor: string }> = {
  success: {
    ring: 'border-sent/35',
    iconColor: 'text-sent',
    icon: (
      <path d="M7.5 10.5l2 2 4.5-4.5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  error: {
    ring: 'border-failed/40',
    iconColor: 'text-failed',
    icon: <path d="M7 7l6 6M13 7l-6 6" strokeWidth="2" strokeLinecap="round" />,
  },
  warning: {
    ring: 'border-scheduled/40',
    iconColor: 'text-scheduled',
    icon: <path d="M10 6.5v4M10 13.3v.2" strokeWidth="2" strokeLinecap="round" />,
  },
  info: {
    ring: 'border-brand-border/40',
    iconColor: 'text-brand-strong',
    icon: <path d="M10 9v4.5M10 6.6v.2" strokeWidth="2" strokeLinecap="round" />,
  },
};

export function Toaster(): ReactNode {
  const { toasts, dismiss } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => {
        const tone = TONE[toast.tone];
        return (
          <div
            key={toast.id}
            className={`animate-toast pointer-events-auto flex items-start gap-3 rounded-xl border bg-surface px-3.5 py-3 shadow-xl ${tone.ring}`}
          >
            <svg
              viewBox="0 0 20 20"
              className={`mt-0.5 size-4 shrink-0 ${tone.iconColor}`}
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <circle cx="10" cy="10" r="8.25" strokeWidth="1.5" strokeOpacity="0.4" />
              {tone.icon}
            </svg>

            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-[13px] font-medium leading-snug text-ink">{toast.title}</p>
              {toast.description && (
                <p className="text-[12px] leading-snug text-ink-muted">{toast.description}</p>
              )}
              {toast.action && (
                <a
                  href={toast.action.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 w-fit text-[12px] font-medium text-brand-strong hover:underline"
                >
                  {toast.action.label} →
                </a>
              )}
            </div>

            <button
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
              className="ml-auto -mr-1 -mt-0.5 cursor-pointer rounded-md p-1 text-ink-muted transition-colors hover:bg-raised hover:text-ink"
            >
              <svg viewBox="0 0 20 20" className="size-3.5" fill="currentColor" aria-hidden="true">
                <path d="M6.3 5A.9.9 0 005 6.3L8.7 10 5 13.7A.9.9 0 006.3 15L10 11.3 13.7 15a.9.9 0 001.3-1.3L11.3 10 15 6.3A.9.9 0 0013.7 5L10 8.7 6.3 5z" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
