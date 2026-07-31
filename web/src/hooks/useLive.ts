import type { RealtimeEvent } from '@futsal/shared';
import { useEffect, useRef, useState } from 'react';
import { type ConnectionState, connectLive } from '../api/realtime.js';

/**
 * Subscribe a component to realtime events for the given channels.
 *
 * The handlers are held in refs so a re-render never tears the connection down
 * and builds a new one — reconnecting on every keystroke would be both janky
 * and, given the keepalive cost of a stream, expensive.
 */
export function useLive(
  channels: string[],
  handlers: {
    onEvent(event: RealtimeEvent): void;
    onRefresh(): void;
  },
  enabled = true,
): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');

  const onEventRef = useRef(handlers.onEvent);
  const onRefreshRef = useRef(handlers.onRefresh);
  onEventRef.current = handlers.onEvent;
  onRefreshRef.current = handlers.onRefresh;

  // Join the channel list into a primitive so the effect compares by value
  // rather than by array identity.
  const key = channels.join('|');

  useEffect(() => {
    if (!enabled || channels.length === 0) return;

    const connection = connectLive({
      channels: key.split('|'),
      onEvent: (event) => onEventRef.current(event),
      onRefresh: () => onRefreshRef.current(),
      onStateChange: setState,
    });

    return () => connection.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return state;
}
