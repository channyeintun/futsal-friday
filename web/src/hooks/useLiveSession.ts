import {
  type Registration,
  type SessionDetail,
  type SessionMessage,
  sessionChannel,
} from '@futsal/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { ConnectionState } from '../api/realtime.js';
import { queryKeys, useSession } from './queries.js';
import { useLive } from './useLive.js';

export interface LiveSession {
  detail: SessionDetail | null;
  /** True only when there is nothing to show — never during a background refresh. */
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
 *
 * Those patches go into the *query cache* rather than component state, which
 * is what makes them survive a trip to another tab and back: the live update
 * somebody saw a moment ago is still there when they return, instead of being
 * thrown away with the component and fetched again.
 */
export function useLiveSession(sessionId: string | null, viewerId: string): LiveSession {
  const [recentlyChanged, setRecentlyChanged] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const query = useSession(sessionId);

  const patch = useCallback(
    (updater: (current: SessionDetail) => SessionDetail) => {
      if (!sessionId) return;
      queryClient.setQueryData<SessionDetail>(queryKeys.session(sessionId), (current) =>
        current ? updater(current) : current,
      );
    },
    [queryClient, sessionId],
  );

  const reload = useCallback(() => {
    if (!sessionId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
    // The thread too. This is also the polling fallback's only path — where
    // realtime is unavailable, `onRefresh` fires on a timer and is the sole
    // way somebody else's messages ever arrive.
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessionMessages(sessionId) });
  }, [queryClient, sessionId]);

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
            const { memberId, memberName, memberAvatarUpdatedAt, guests, slot, status, position, counts } =
              event.data;
            flash(memberId);
            patch((current) => {
              if (current.session.id !== event.data.sessionId) return current;
              // Guard against a duplicate arriving from the history replay.
              if (current.registrations.some((r) => r.memberId === memberId)) return current;

              const entry: Registration = {
                id: `live_${memberId}`,
                sessionId: event.data.sessionId,
                memberId,
                memberName,
                memberAvatarUpdatedAt,
                guests,
                slot,
                // Nobody has said whether they turned up — they only just
                // signed up. Unmarked reads as present for a player, which is
                // the same thing the server would send back.
                attended: null,
                guestsArrived: null,
                // Nobody has played yet, let alone scored.
                goals: 0,
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
            patch((current) => {
              if (current.session.id !== event.data.sessionId) return current;
              const registrations = current.registrations
                .filter((r) => r.memberId !== memberId)
                .map((r) =>
                  promoted && r.memberId === promoted.memberId
                    ? { ...r, status: 'in' as const }
                    : r,
                );
              /*
               * Being promoted has to reach `me`, not just the list.
               *
               * The map above flips the promoted registration to `in`, but
               * `me` is a separate copy of the viewer's own row — so somebody
               * who came off the waitlist because a player dropped out was
               * left holding `status: 'waitlist'` for as long as the screen
               * stayed open, while the list beside it said they were playing.
               * The button went on offering to leave a waitlist they were no
               * longer on, and a spot on the pitch would have had nothing
               * behind it.
               */
              const me =
                memberId === viewerId
                  ? null
                  : promoted && current.me && promoted.memberId === viewerId
                    ? { ...current.me, status: 'in' as const }
                    : current.me;

              return { ...current, registrations, counts, me };
            });
            return;
          }

          case 'player.moved': {
            // Nobody joined and nobody left, so there is no count to correct
            // and no promotion to worry about — one field on one row moves and
            // `placeOnPitch` redraws the field from it.
            const { memberId, slot } = event.data;
            flash(memberId);
            patch((current) => {
              if (current.session.id !== event.data.sessionId) return current;
              const registrations = current.registrations.map((r) =>
                r.memberId === memberId ? { ...r, slot } : r,
              );
              return {
                ...current,
                registrations,
                me: current.me?.memberId === memberId ? { ...current.me, slot } : current.me,
              };
            });
            return;
          }

          case 'player.attendance': {
            const { memberId, attended, guestsArrived } = event.data;
            flash(memberId);
            patch((current) => {
              if (current.session.id !== event.data.sessionId) return current;
              // Attendance never changes who is on the list or the counts —
              // those are about spots reserved, not heads that turned up — so
              // this is a field update and nothing more.
              const registrations = current.registrations.map((r) =>
                r.memberId === memberId ? { ...r, attended, guestsArrived } : r,
              );
              return {
                ...current,
                registrations,
                me: current.me?.memberId === memberId
                  ? { ...current.me, attended, guestsArrived }
                  : current.me,
              };
            });
            return;
          }

          case 'teams.changed': {
            // The board travels whole — teams, confirmation and scorelines —
            // so somebody else's shuffle deals out on every phone at the pitch
            // at the same moment rather than each going away to refetch it.
            // `drawnAt` changes on every draw, which is what the board keys
            // its animation off.
            const { draw } = event.data;
            patch((current) =>
              current.session.id === event.data.sessionId ? { ...current, teams: draw } : current,
            );
            return;
          }

          case 'message.posted': {
            // Appended straight onto the thread's own cache entry. Handled
            // here rather than in the banter component so the screen keeps one
            // stream: a second `useLive` on the same channel would double
            // every connection, and the keepalives are the Upstash budget.
            const { sessionId: forSession, id, memberId, memberName, memberAvatarUpdatedAt, body, at } =
              event.data;
            if (forSession !== sessionId) return;
            queryClient.setQueryData<SessionMessage[]>(
              queryKeys.sessionMessages(forSession),
              (current) => {
                if (!current) return current;
                // The poster gets their own message back over the stream as
                // well as in the response; whichever lands second is a no-op.
                if (current.some((message) => message.id === id)) return current;
                return [
                  ...current,
                  { id, sessionId: forSession, memberId, memberName, memberAvatarUpdatedAt, body, createdAt: at },
                ];
              },
            );
            return;
          }

          case 'message.deleted': {
            const { sessionId: forSession, id } = event.data;
            if (forSession !== sessionId) return;
            queryClient.setQueryData<SessionMessage[]>(
              queryKeys.sessionMessages(forSession),
              (current) => current?.filter((message) => message.id !== id),
            );
            return;
          }

          case 'mvp.changed': {
            // The only event here that cannot be patched from its payload: to
            // move a number locally it would have to name the nominee, and a
            // stream of those next to "somebody just voted" is the voter/
            // nominee pairing the API refuses to hand out. So this refetches
            // the counts instead.
            if (event.data.sessionId !== sessionId) return;
            void queryClient.invalidateQueries({ queryKey: queryKeys.mvp(sessionId) });
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
    detail: query.data ?? null,
    // `isPending`, not `isFetching`: a background refresh of data already on
    // screen must not put a spinner over the top of it.
    loading: sessionId !== null && query.isPending,
    error: query.error instanceof Error ? query.error.message : null,
    connection,
    reload,
    recentlyChanged,
    apply: (next) => {
      if (sessionId) queryClient.setQueryData(queryKeys.session(sessionId), next);
    },
  };
}
