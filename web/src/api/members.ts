import type {
  CreateMemberInput,
  Member,
  MemberBalance,
  MemberHistoryEntry,
  MemberProfile,
  UpdateMemberInput,
} from '@futsal/shared';
import { platform } from '../platform/index.js';
import { del, get, getBlob, patch, post, request } from './client.js';

export const listMembers = (signal?: AbortSignal) =>
  get<{ members: Member[] }>('/members', signal).then((r) => r.members);

export const listBalances = (signal?: AbortSignal) =>
  get<{ balances: MemberBalance[] }>('/members/balances', signal).then((r) => r.balances);

export const memberHistory = (memberId: string, signal?: AbortSignal) =>
  get<{ history: MemberHistoryEntry[] }>(`/members/${memberId}/history`, signal).then(
    (r) => r.history,
  );

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
 * A face at 40px in a list needs far less than a payment screenshot does, so
 * this compresses harder — square-ish, short edge, low target — and the Worker
 * caps it again at 200 KB.
 */
export async function uploadMyAvatar(file: Blob): Promise<Member> {
  const compressed = await platform.compressImage(file, {
    maxDimension: 256,
    targetBytes: 30_000,
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
 */
export const memberAvatar = (memberId: string, signal?: AbortSignal) =>
  getBlob(`/members/${memberId}/avatar`, signal);
