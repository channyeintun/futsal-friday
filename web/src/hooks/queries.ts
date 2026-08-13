import type { SessionDetail } from '@futsal/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  listBalances,
  listMembers,
  listForm,
  listLeaderboard,
  membersCount,
  memberAvatar,
  memberHistory,
  memberProfile,
  pendingMembers,
} from '../api/members.js';
import { getPaymentDetails } from '../api/payment-details.js';
import { getPayments } from '../api/payments.js';
import { pushStatus } from '../api/push.js';
import {
  getSession,
  listPastSessions,
  listSessionMessages,
  listSessions,
} from '../api/sessions.js';
import { listVenues } from '../api/venues.js';

/**
 * Every cached read in the app.
 *
 * TanStack Query sits *above* the transport: everything under `src/api` is
 * still plain `fetch` behind the platform seam, and these hooks only decide
 * when to call it. That keeps the data layer portable — a different shell can
 * reuse `src/api` without React Query coming along.
 *
 * ## Why this replaced fetch-on-mount
 *
 * The old hook started every mount with `loading: true` and no data, so
 * switching tabs meant a spinner every single time even though the answer had
 * been on screen a second earlier. The fix is two things together: a cache
 * that outlives the component, and rendering the spinner on `isPending` — "we
 * have nothing to show" — rather than on `isFetching`, which is also true
 * during the background refresh of data already on screen.
 *
 * `staleTime` is then just "how long before a revisit bothers to refetch",
 * chosen per query by how fast the thing actually changes. Anything realtime
 * touches can afford a long one, because the stream corrects it sooner than a
 * refetch would.
 */

/* ------------------------------------------------------------------- keys */

export const queryKeys = {
  sessions: ['sessions'] as const,
  session: (id: string) => ['session', id] as const,
  payments: (sessionId: string) => ['payments', sessionId] as const,
  members: ['members'] as const,
  pendingMembers: ['members', 'pending'] as const,
  venues: (includeRetired: boolean) => ['venues', includeRetired] as const,
  history: (memberId: string) => ['history', memberId] as const,
  balances: ['balances'] as const,
  profile: (memberId: string) => ['profile', memberId] as const,
  avatar: (memberId: string, updatedAt: string | null) =>
    ['avatar', memberId, updatedAt] as const,
  pushStatus: ['push-status'] as const,
  paymentDetails: ['payment-details'] as const,
  sessionMessages: (sessionId: string) => ['session', sessionId, 'messages'] as const,
};

/** Kept for the call sites that still spell it out. */
export const profileKey = queryKeys.profile;
export const avatarKey = queryKeys.avatar;

/* ---------------------------------------------------------------- session */

export function useSessions() {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: ({ signal }) => listSessions(signal),
    // The lobby channel announces new and changed fixtures, and the home
    // screen is the most re-visited in the app.
    staleTime: 60_000,
  });
}

export function useSession(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.session(sessionId ?? ''),
    queryFn: ({ signal }) => getSession(sessionId as string, signal),
    enabled: sessionId !== null,
    // Registrations arrive over SSE and patch this entry directly, so a
    // refetch is the fallback rather than the mechanism.
    staleTime: 60_000,
  });
}

export function usePayments(sessionId: string) {
  return useQuery({
    queryKey: queryKeys.payments(sessionId),
    queryFn: ({ signal }) => getPayments(sessionId, signal),
    staleTime: 30_000,
  });
}

/**
 * The banter on a session.
 *
 * Its own query rather than a field on the session detail, for the same reason
 * the form squares are: the roster has to paint the moment the screen opens,
 * and the thread is the part you scroll to. Posts and deletions arrive over
 * the session's existing stream and patch this cache directly — see
 * `useLiveSession` — so a five-message exchange costs one request, not ten.
 */
export function useSessionMessages(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.sessionMessages(sessionId),
    queryFn: ({ signal }) => listSessionMessages(sessionId, signal),
    enabled,
    staleTime: 60_000,
  });
}

/* ---------------------------------------------------------------- members */

/**
 * The roster, a page at a time.
 *
 * `useInfiniteQuery` rather than a plain one because the list is unbounded in
 * principle — the app has no idea whether a group is twelve people or two
 * hundred — and a screen that quietly stops at whatever the server felt like
 * returning is worse than one that keeps asking.
 */
export function useMembersInfinite(pageSize = 50) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.members, 'infinite', pageSize] as const,
    queryFn: ({ pageParam, signal }) =>
      listMembers({ cursor: pageParam, limit: pageSize }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // A roster changes when somebody is added or approved, both of which
    // invalidate it explicitly.
    staleTime: 5 * 60_000,
  });
}

/**
 * How many players there are, without downloading them.
 *
 * The Setup screen wants a number and an Add button; fetching the whole roster
 * to render "23 players" is the entire list on the wire to print two
 * characters, on a screen most people open to do something else entirely.
 */
export function useMembersCount() {
  return useQuery({
    queryKey: [...queryKeys.members, 'count'] as const,
    queryFn: ({ signal }) => membersCount(signal),
    staleTime: 5 * 60_000,
  });
}

export function usePendingMembers(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.pendingMembers,
    queryFn: ({ signal }) => pendingMembers(signal),
    enabled,
    // Somebody is sitting on a waiting screen; this is the one roster read
    // worth keeping fresh.
    staleTime: 30_000,
  });
}

export function useVenues(includeRetired: boolean, enabled = true) {
  return useQuery({
    queryKey: queryKeys.venues(includeRetired),
    queryFn: ({ signal }) => listVenues(includeRetired, signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/**
 * The most recent page of somebody's history.
 *
 * For the screens that only want a glimpse — the profile shows ten games and
 * stops. Anything that scrolls wants {@link useHistoryInfinite} instead.
 */
export function useHistory(memberId: string, enabled = true, pageSize = 20) {
  return useQuery({
    queryKey: [...queryKeys.history(memberId), pageSize] as const,
    queryFn: ({ signal }) => memberHistory(memberId, { limit: pageSize }, signal),
    select: (page) => page.history,
    enabled,
    staleTime: 60_000,
  });
}

/** The same list, all of it, a page at a time. */
export function useHistoryInfinite(memberId: string, enabled = true, pageSize = 20) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.history(memberId), 'infinite', pageSize] as const,
    queryFn: ({ pageParam, signal }) =>
      memberHistory(memberId, { cursor: pageParam, limit: pageSize }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 60_000,
  });
}

/**
 * The debt list, paged. Ordered by the server — sorting "debtors first" in the
 * browser would only sort the pages fetched so far, which with paging is not
 * an order at all.
 */
export function useBalancesInfinite(enabled: boolean, pageSize = 50) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.balances, 'infinite', pageSize] as const,
    queryFn: ({ pageParam, signal }) =>
      listBalances({ cursor: pageParam, limit: pageSize }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 60_000,
  });
}

/** Everything already played, newest first. */
export function usePastSessions(pageSize = 20) {
  return useInfiniteQuery({
    queryKey: ['sessions', 'past', pageSize] as const,
    queryFn: ({ pageParam, signal }) =>
      listPastSessions({ cursor: pageParam, limit: pageSize }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 60_000,
  });
}

export function useProfile(memberId: string) {
  return useQuery({
    queryKey: queryKeys.profile(memberId),
    queryFn: ({ signal }) => memberProfile(memberId, signal),
    // A streak only moves when a session completes.
    staleTime: 60_000,
  });
}

/**
 * Recent form for everybody, for the squares beside each name.
 *
 * Its own query rather than part of the session detail: the home screen has to
 * paint before this matters, and bundling it would make the hero wait on a
 * roster-wide history read.
 */
export function useRecentForm(enabled = true) {
  return useQuery({
    queryKey: ['members', 'form'] as const,
    queryFn: ({ signal }) => listForm(signal),
    enabled,
    // Only moves when a game finishes and somebody marks attendance.
    staleTime: 5 * 60_000,
  });
}

export function useLeaderboard(board: 'streak' | 'goals', pageSize = 25) {
  return useInfiniteQuery({
    queryKey: ['leaderboard', board, pageSize] as const,
    queryFn: ({ pageParam, signal }) =>
      listLeaderboard({ board, cursor: pageParam, limit: pageSize }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 60_000,
  });
}

/* ---------------------------------------------------------------- devices */

export function usePushStatus() {
  return useQuery({
    queryKey: queryKeys.pushStatus,
    queryFn: ({ signal }) => pushStatus(signal),
    // Device state, not group state: it changes only through this screen, and
    // every path that changes it invalidates.
    staleTime: 5 * 60_000,
  });
}

/**
 * Where the group sends money. Changes about once a year, and every payments
 * screen wants it, so it is cached hard.
 */
export function usePaymentDetails() {
  return useQuery({
    queryKey: queryKeys.paymentDetails,
    queryFn: ({ signal }) => getPaymentDetails(signal),
    staleTime: 10 * 60_000,
  });
}

/* ---------------------------------------------------------------- avatars */

/**
 * A member's picture, as a Blob.
 *
 * Keyed on `updatedAt`, so changing your photo is a new cache entry rather
 * than a stale one — and never changing it means never re-fetching.
 *
 * The Blob is cached, not an object URL: a URL has to be revoked to avoid
 * leaking, and the cache has no lifecycle hook to do that on eviction. Each
 * component mints its own URL from the shared Blob and revokes it on unmount,
 * which costs nothing and cannot leak.
 */
export function useAvatar(memberId: string, updatedAt: string | null) {
  return useQuery({
    queryKey: queryKeys.avatar(memberId, updatedAt),
    queryFn: ({ signal }) => memberAvatar(memberId, signal),
    // No picture, nothing to fetch — the initials stand in.
    enabled: updatedAt !== null,
    // A picture at a given `updatedAt` is immutable, so it never goes stale
    // and never needs refetching. Only eviction ends its life.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60 * 60 * 1000,
    retry: false,
  });
}

/* ------------------------------------------------------------------ types */

export type SessionQuery = ReturnType<typeof useSession>;
export type { SessionDetail };
