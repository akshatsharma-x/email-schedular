'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

/**
 * Entry point: send the visitor wherever they belong.
 *
 * The session is an httpOnly cookie, so the client cannot read it directly --
 * asking the API who we are is the only way to know. Done client-side because
 * the cookie is scoped to the API's origin, not Next's.
 */
export default function Home(): ReactNode {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then(() => {
        if (!cancelled) router.replace('/dashboard');
      })
      .catch(() => {
        if (!cancelled) router.replace('/login');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas">
      <div className="flex flex-col items-center gap-3">
        <svg className="size-6 animate-spin text-ink-muted" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
          <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <p className="text-[13px] text-ink-muted">Loading…</p>
      </div>
    </main>
  );
}
