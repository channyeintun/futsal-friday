import {
  type Registration,
  type SessionDetail,
  sessionChannel,
} from '@futsal/shared';
import { useCallback, useState } from 'react';
import { getSession } from '../api/sessions.js';
import type { ConnectionState } from '../api/realtime.js';
import { useAsync } from './useAsync.js';
import { useLive } from './useLive.js';

export interface LiveSession {
  detail: SessionDetail | null;
  loading: boolean;
  error: string | null;
  connection: ConnectionState;
  reload(): void;
  /** Member ids whose row changed in the last moment, for a highlight flash. */
  recentlyChanged: Set<string>;
  apply(next: SessionDetail): void;
}

/**
 * A session's detail, kept current.
 *
 * `player.joined` and `player.left` carry everything needed to patch the list
 * and the counter locally, so an ordinary "someone else joined" costs zero
 * requests for every other viewer. Anything structural (`session.updated`)
 * falls back to a refetch, which is rare enough not to matter.
 */
export function useLiveSession(sessionId: string | null, viewerId: string): LiveSession {
  const [recentlyChanged, setRecentlyChanged] = useState<Set<string>>(new Set());

  const state = useAsync<SessionDetail | null>(
    (signal) => (sessionId ? getSession(sessionId, signal) : Promise.resolve(null)),
    [sessionId],
  );

  const { set, reload } = state;

  const flash = useCallback((memberId: string) => {
    setRecentlyChanged((current) => new Set(current).add(memberId));
    window.setTimeout(() => {
      setRecentlyChanged((current) => {
        const next = new Set(current);
        next.delete(memberId);
        return next;
      });
    }, 1400);
  }, []);

  const connection = useLive(
    sessionId ? [sessionChannel(sessionId)] : [],
    {
      onRefresh: reload,
      onEvent: (event) => {
        switch (event.name) {
          case 'player.joined': {
            const { memberId, memberName, status, position, counts } = event.data;
            flash(memberId);
            set((current) => {
              if (!current || current.session.id !== event.data.sessionId) return current;
              // Guard against a duplicate arriving from the history replay.
              if (current.registrations.some((r) => r.memberId === memberId)) return current;

              const entry: Registration = {
                id: `live_${memberId}`,
                sessionId: event.data.sessionId,
                memberId,
                memberName,
                status,
                position,
                createdAt: event.data.at,
              };
              const registrations = [...current.registrations, entry].sort(
                (a, b) => a.position - b.position,
              );
              return {
                ...current,
                registrations,
                counts,
                me: memberId === viewerId ? entry : current.me,
              };
            });
            return;
          }

          case 'player.left': {
            const { memberId, promoted, counts } = event.data;
            flash(memberId);
            if (promoted) flash(promoted.memberId);
            set((current) => {
              if (!current || current.session.id !== event.data.sessionId) return current;
              const registrations = current.registrations
                .filter((r) => r.memberId !== memberId)
                .map((r) =>
                  promoted && r.memberId === promoted.memberId
                    ? { ...r, status: 'in' as const }
                    : r,
                );
              return {
                ...current,
                registrations,
                counts,
                me: memberId === viewerId ? null : current.me,
              };
            });
            return;
          }

          case 'session.updated':
            // Time, venue, cap or status changed — too structural to patch.
            reload();
            return;

          default:
            // Payment events travel on the same channel but belong to the
            // payments screen.
            return;
        }
      },
    },
    sessionId !== null,
  );

  return {
    detail: state.data,
    loading: state.loading,
    error: state.error,
    connection,
    reload,
    recentlyChanged,
    apply: (next) => set(next),
  };
}
