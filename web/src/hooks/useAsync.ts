import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.js';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Refetch. Safe to call from an event handler or an interval. */
  reload(): void;
  /** Replace the data locally, for optimistic updates and live events. */
  set(updater: T | ((current: T | null) => T | null)): void;
}

/**
 * Fetch-on-mount with cancellation, plus a `set` escape hatch so realtime
 * events can patch the result without a round-trip.
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // Keeps the effect from depending on a function identity that changes every
  // render, which would make it refetch forever.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setLoading(true);
    loaderRef
      .current(controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        // A dead token is already handled globally by the API client; showing
        // "Sign in first" over the top of the gate would just be noise.
        if (cause instanceof ApiError && cause.isAuthError) return;
        setError(cause instanceof Error ? cause.message : 'Something went wrong');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const set = useCallback((updater: T | ((current: T | null) => T | null)) => {
    setData((current) =>
      typeof updater === 'function' ? (updater as (c: T | null) => T | null)(current) : updater,
    );
  }, []);

  return { data, error, loading, reload, set };
}
