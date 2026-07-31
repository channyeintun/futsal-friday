import type {
  CreateMemberInput,
  Member,
  MemberBalance,
  MemberHistoryEntry,
  UpdateMemberInput,
} from '@futsal/shared';
import { del, get, patch, post } from './client.js';

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
