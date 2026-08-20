import type {
  CreateMemberInput,
  Member,
  MemberBalance,
  MemberHistoryEntry,
  MemberProfile,
  UpdateMemberInput,
  LeaderboardBoard,
} from '@futsal/shared';
import { platform } from '../platform/index.js';
import { del, get, getBlob, patch, post, request } from './client.js';

export interface MemberPage {
  members: Member[];
  /** Hand back verbatim to fetch the next page; null at the end of the list. */
  nextCursor: string | null;
}

/** One page of the roster, ordered by name. */
export const listMembers = (
  opts: { cursor?: string | null; limit?: number } = {},
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams();
  if (opts.cursor) query.set('cursor', opts.cursor);
  if (opts.limit) query.set('limit', String(opts.limit));
  const suffix = query.size > 0 ? `?${query}` : '';
  return get<MemberPage>(`/members${suffix}`, signal);
};

/** Just the number, for screens that only need to say how many there are. */
export const membersCount = (signal?: AbortSignal) =>
  get<{ total: number }>('/members/count', signal).then((r) => r.total);

export interface BalancePage {
  balances: MemberBalance[];
  nextCursor: string | null;
}

/** Who owes what, biggest debt first. Ordered by the server so paging holds. */
export const listBalances = (
  opts: { cursor?: string | null; limit?: number } = {},
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams();
  if (opts.cursor) query.set('cursor', opts.cursor);
  if (opts.limit) query.set('limit', String(opts.limit));
  return get<BalancePage>(`/members/balances${query.size ? `?${query}` : ''}`, signal);
};

export interface FormEntry {
  memberId: string;
  recent: ('in' | 'missed' | 'waitlist' | 'none')[];
}

/** Recent form for the whole roster, in one call. */
export const listForm = (signal?: AbortSignal) =>
  get<{ window: number; form: FormEntry[] }>('/members/form', signal);

export interface LeaderboardRow {
  member: Member;
  streak: { current: number; best: number; played: number; total: number };
  goals: number;
  /** Sessions the group voted them the best in; a shared win counts for each. */
  mvps: number;
  rank: number;
}

export const listLeaderboard = (
  opts: { board: LeaderboardBoard; cursor?: string | null; limit?: number },
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams({ board: opts.board });
  if (opts.cursor) query.set('cursor', opts.cursor);
  if (opts.limit) query.set('limit', String(opts.limit));
  return get<{ board: string; entries: LeaderboardRow[]; nextCursor: string | null }>(
    `/members/leaderboard?${query}`,
    signal,
  );
};

export interface HistoryPage {
  history: MemberHistoryEntry[];
  nextCursor: string | null;
}

/**
 * One member's season, a page at a time.
 *
 * Paged for the same reason the debt list is: a group that has been playing
 * for two years has a hundred Fridays behind it, and a screen that quietly
 * stops at whatever the server felt like returning is worse than one that
 * keeps asking.
 */
export const memberHistory = (
  memberId: string,
  opts: { cursor?: string | null; limit?: number } = {},
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams();
  if (opts.cursor) query.set('cursor', opts.cursor);
  if (opts.limit) query.set('limit', String(opts.limit));
  return get<HistoryPage>(
    `/members/${memberId}/history${query.size ? `?${query}` : ''}`,
    signal,
  );
};

export const createMember = (input: CreateMemberInput) =>
  post<{ member: Member }>('/members', input).then((r) => r.member);

export const updateMember = (id: string, input: UpdateMemberInput) =>
  patch<{ member: Member }>(`/members/${id}`, input).then((r) => r.member);

/** Deactivates rather than deletes — payment history has to survive. */
export const removeMember = (id: string) => del<{ ok: true }>(`/members/${id}`);

/** The waiting room: people who added themselves and need a decision. */
export const pendingMembers = (signal?: AbortSignal) =>
  get<{ members: Member[] }>('/members/pending', signal).then((r) => r.members);

export const approveMember = (id: string) =>
  post<{ member: Member }>(`/members/${id}/approve`, {}).then((r) => r.member);

/** Turns them away and frees the name, unlike removing a settled member. */
export const rejectMember = (id: string) => del<{ ok: true }>(`/members/${id}/approve`);

export const memberProfile = (memberId: string, signal?: AbortSignal) =>
  get<{ profile: MemberProfile }>(`/members/${memberId}/profile`, signal).then((r) => r.profile);

/**
 * Profile pictures.
 *
 * Still compressed harder than a payment screenshot, but no longer nearly as
 * hard as it was. 256px was sized when the largest a face ever got was a 40px
 * circle in a list; a picture is now the top of a player item, and the two
 * places that draw it biggest are the card on a profile — 200 CSS pixels, so
 * 600 on a three-times screen — and the shareable PNG, which rasterises the
 * portrait at 500. Against either of those a 256px original is a two-times
 * upscale, which is exactly what "the photos look blurry" was.
 *
 * 512 covers both with a little to spare. It costs about three times the bytes
 * per face, which is a real cost on a pitch screen holding a dozen of them —
 * but only once each: the cache key carries `avatarUpdatedAt`, so a picture at
 * a given version is immutable and is fetched exactly once per device. The
 * Worker caps it again at 200 KB regardless.
 */
export async function uploadMyAvatar(file: Blob): Promise<Member> {
  const compressed = await platform.compressImage(file, {
    maxDimension: 512,
    targetBytes: 90_000,
  });
  const result = await request<{ member: Member }>('PUT', '/members/me/avatar', {
    raw: compressed.blob,
    contentType: compressed.contentType,
  });
  return result.member;
}

export const removeMyAvatar = () =>
  del<{ member: Member }>('/members/me/avatar').then((r) => r.member);

/**
 * The bytes, not a URL — an `<img src>` cannot carry a bearer token.
 *
 * Callers cache the Blob (see `useAvatar`) and mint the object URL locally, so
 * the same picture is fetched once no matter how many rows show it.
 *
 * `updatedAt` rides along in the query string for one reason: to version the
 * URL. The response is cached for a day, and a day-old picture is exactly what
 * the browser hands back when a new upload asks for the same address again — a
 * fresh React Query key starts a refetch, but refetching an unchanged URL is
 * precisely what an HTTP cache exists to answer. Each version needs its own
 * address, or the old face survives the upload that replaced it.
 */
export const memberAvatar = (memberId: string, updatedAt: string | null, signal?: AbortSignal) =>
  getBlob(
    `/members/${memberId}/avatar${updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : ''}`,
    signal,
  );
