import type { RealtimeEvent } from '@futsal/shared';
import { useEffect, useRef, useState } from 'react';
import { type ConnectionState, liveStateFor, subscribeLive } from '../api/realtime.js';

/**
 * Subscribe a component to realtime events for the given channels.
 *
 * The handlers are held in refs so a re-render never tears the connection down
 * and builds a new one — reconnecting on every keystroke would be both janky
 * and, given the keepalive cost of a stream, expensive.
 *
 * The stream itself is shared and lingers past unmount (see `subscribeLive`),
 * so moving between screens on the same channel neither drops the connection
 * nor makes the indicator claim it did.
 */
export function useLive(
  channels: string[],
  handlers: {
    onEvent(event: RealtimeEvent): void;
    onRefresh(): void;
  },
  enabled = true,
): ConnectionState {
  // Seeded from the shared stream rather than from 'connecting'. Navigating
  // back to a screen re-runs this hook, and starting from scratch is what made
  // the status flash "connecting" on every trip home even though the stream
  // underneath had never dropped.
  const [state, setState] = useState<ConnectionState>(() => liveStateFor(channels));

  const onEventRef = useRef(handlers.onEvent);
  const onRefreshRef = useRef(handlers.onRefresh);
  onEventRef.current = handlers.onEvent;
  onRefreshRef.current = handlers.onRefresh;

  // Join the channel list into a primitive so the effect compares by value
  // rather than by array identity.
  const key = channels.join('|');

  useEffect(() => {
    if (!enabled || channels.length === 0) return;

    const connection = subscribeLive({
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
