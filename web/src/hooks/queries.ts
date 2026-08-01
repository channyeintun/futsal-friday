import { useQuery } from '@tanstack/react-query';
import { memberAvatar, memberProfile } from '../api/members.js';

/**
 * The cached reads.
 *
 * TanStack Query sits *above* the transport: everything under `src/api` is
 * still plain `fetch` behind the platform seam, and these hooks only decide
 * when to call it. That keeps the data layer portable — a different shell can
 * reuse `src/api` without React Query coming along.
 *
 * The rest of the app still uses `useAsync`, which is fine for a screen that
 * loads once. These two are different: an avatar is asked for by every row in
 * every list, so deduplication and a real cache are the whole point.
 */

export const avatarKey = (memberId: string, updatedAt: string | null) =>
  ['avatar', memberId, updatedAt] as const;

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
    queryKey: avatarKey(memberId, updatedAt),
    queryFn: ({ signal }) => memberAvatar(memberId, signal),
    // No picture, nothing to fetch — the initials stand in.
    enabled: updatedAt !== null,
    // A picture at a given `updatedAt` is immutable, so it never goes stale and
    // never needs refetching. Only eviction ends its life.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60 * 60 * 1000,
    retry: false,
  });
}

export const profileKey = (memberId: string) => ['profile', memberId] as const;

export function useProfile(memberId: string) {
  return useQuery({
    queryKey: profileKey(memberId),
    queryFn: ({ signal }) => memberProfile(memberId, signal),
    // A streak only moves when a session completes, so a minute is plenty and
    // stops a back-and-forth between tabs re-querying every time.
    staleTime: 60_000,
  });
}
