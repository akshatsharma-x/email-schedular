'use client';

import { useEffect, useRef, useState } from 'react';
import { API_URL } from '@/lib/api';
import type { OutboxEvent } from '@/types/api';

/**
 * Live updates over Server-Sent Events.
 *
 * The dashboard tables need to change as the worker sends -- without this they
 * would need polling, which means every open tab hits Postgres on a timer and
 * still shows stale data between ticks.
 *
 * `EventSource` reconnects on its own after a drop, so there is no retry logic
 * here; the only state tracked is whether the stream is currently open, which
 * the header shows as a live/offline dot.
 */
export function useEventStream(
  onEvent: (event: OutboxEvent) => void,
  enabled: boolean,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  // Held in a ref so a changing callback does not tear down the connection.
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) return;

    const source = new EventSource(`${API_URL}/api/events`, { withCredentials: true });

    const forward = (e: MessageEvent): void => {
      try {
        handler.current(JSON.parse(e.data) as OutboxEvent);
      } catch {
        // A malformed frame is ignored rather than breaking the stream.
      }
    };

    // Each event type is a named SSE event, so subscribe to them explicitly.
    const types: OutboxEvent['type'][] = [
      'campaign.scheduled',
      'campaign.cancelled',
      'email.sent',
      'email.failed',
      'email.deferred',
      'ratelimit.hit',
      'reconcile.done',
    ];
    for (const type of types) source.addEventListener(type, forward as EventListener);

    source.addEventListener('ready', () => setConnected(true));
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    return () => {
      for (const type of types) source.removeEventListener(type, forward as EventListener);
      source.close();
      setConnected(false);
    };
  }, [enabled]);

  return { connected };
}
