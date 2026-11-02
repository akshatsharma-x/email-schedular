'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';

/**
 * Minimal typed data-fetching hook.
 *
 * Deliberately hand-rolled instead of pulling in a query library: the dashboard
 * needs exactly four behaviours -- loading, error, refetch, and "don't apply a
 * response that arrived after the component unmounted or after a newer request"
 * -- and all four fit in 60 lines. The last one is the bug that makes naive
 * `useEffect` + `fetch` code flicker stale data when a user types in the search
 * box, so it is handled explicitly with a request sequence number.
 */

export interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  /** True only for the very first load -- lets tables show a skeleton once. */
  initialLoading: boolean;
  refetch: () => void;
}

export function useResource<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[] = [],
  options?: { enabled?: boolean },
): ResourceState<T> {
  const enabled = options?.enabled ?? true;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [hasLoaded, setHasLoaded] = useState(false);

  const mounted = useRef(true);
  const sequence = useRef(0);
  // Keep the latest fetcher without making it a dependency, so callers can pass
  // an inline closure without triggering a refetch on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (!enabled) return;
    const id = ++sequence.current;
    setLoading(true);
    try {
      const result = await fetcherRef.current();
      // Discard a stale response: only the newest request may write state.
      if (!mounted.current || id !== sequence.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!mounted.current || id !== sequence.current) return;
      setError(
        err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', (err as Error).message),
      );
    } finally {
      if (mounted.current && id === sequence.current) {
        setLoading(false);
        setHasLoaded(true);
      }
    }
  }, [enabled]);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, ...deps]);

  return {
    data,
    loading,
    error,
    initialLoading: loading && !hasLoaded,
    refetch: () => void run(),
  };
}
