'use client';

import { Suspense, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { IconGoogle } from '@/components/ui/icons';
import { api, ApiError } from '@/lib/api';
import { useResource } from '@/hooks/useResource';
import { useToast } from '@/hooks/useToast';

/**
 * Login.
 *
 * Google OAuth is a full-page navigation to the backend, which owns the whole
 * exchange and sets an httpOnly session cookie -- the client secret and the
 * token never touch the browser.
 *
 * The screen asks the API which methods are actually available first, so a
 * reviewer without Google credentials gets an explanation and the dev-login
 * path rather than a button that fails when clicked.
 */
export default function LoginPage(): ReactNode {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-canvas" />}>
      <LoginScreen />
    </Suspense>
  );
}

/** `adyasha.singh@…` -> "Adyasha Singh", so the header shows a real name. */
function prettyName(email: string): string {
  const local = email.split('@')[0] ?? '';
  return (
    local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || email
  );
}

function LoginScreen(): ReactNode {
  const router = useRouter();
  const params = useSearchParams();
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const oauthError = params.get('error');
  const { data: config, initialLoading } = useResource(() => api.authConfig(), []);

  async function devLogin(): Promise<void> {
    setBusy(true);
    try {
      await api.devLogin({
        email: email.trim() || 'adyasha.singh@outbox.local',
        name: email.trim() ? prettyName(email) : 'Adyasha Singh',
      });
      router.replace('/dashboard');
    } catch (err) {
      push({
        tone: 'error',
        title: 'Could not sign in',
        description: err instanceof ApiError ? err.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-[22rem]">
        <div className="rounded-2xl border border-line bg-surface px-6 py-7 shadow-sm">
          <h1 className="mb-5 text-center text-[22px] font-semibold text-ink">Login</h1>

          {oauthError && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-failed/30 bg-failed/10 px-3 py-2 text-[12px] leading-snug text-ink-secondary"
            >
              {oauthError}
            </div>
          )}

          {initialLoading ? (
            <div className="h-10 animate-pulse rounded-lg bg-chip" />
          ) : config?.googleEnabled ? (
            <Button
              variant="soft"
              size="lg"
              fullWidth
              icon={<IconGoogle className="size-4" />}
              onClick={() => {
                // Full navigation: the consent screen is a page, not a fetch.
                window.location.href = api.googleLoginUrl();
              }}
            >
              Login with Google
            </Button>
          ) : (
            <div className="rounded-lg border border-scheduled/30 bg-highlight px-3 py-2.5">
              <p className="text-[12px] font-medium text-ink">Google sign-in is not configured</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
                Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to{' '}
                <code>backend/.env</code> with the redirect URI{' '}
                <code>http://localhost:4000/api/auth/google/callback</code>, then restart the API.
              </p>
            </div>
          )}

          {config?.devBypassEnabled && (
            <>
              <div className="my-4 flex items-center gap-3">
                <span className="h-px flex-1 bg-line" />
                <span className="text-[11px] text-ink-muted">or sign up through email</span>
                <span className="h-px flex-1 bg-line" />
              </div>

              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void devLogin();
                }}
              >
                <Field label="Email ID">
                  {(id) => (
                    <Input
                      id={id}
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="adyasha.singh@outbox.local"
                      autoComplete="email"
                    />
                  )}
                </Field>
                <Field
                  label="Password"
                  hint="Local development only — any value is accepted."
                >
                  {(id) => (
                    <Input
                      id={id}
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="current-password"
                    />
                  )}
                </Field>
                <Button type="submit" variant="primary" size="lg" fullWidth loading={busy}>
                  Login
                </Button>
              </form>
            </>
          )}
        </div>

        <p className="mt-4 text-center text-[11px] text-ink-muted">
          Dev login is refused entirely when <code>NODE_ENV=production</code>.
        </p>
      </div>
    </main>
  );
}
