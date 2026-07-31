import type { Identity, Member } from '@futsal/shared';
import { clearToken, get, post, setToken } from './client.js';

export interface GateResponse {
  gateToken: string;
  members: Member[];
}

/** Step 1: prove you know the group's invite code, and get the name list. */
export function openGate(code: string): Promise<GateResponse> {
  return post<GateResponse>('/auth/gate', { code });
}

/** Step 2: say which of those people you are. Stores the returned token. */
export async function join(gateToken: string, memberId: string): Promise<Identity> {
  const result = await post<{ token: string; identity: Identity }>('/auth/join', {
    gateToken,
    memberId,
  });
  setToken(result.token);
  return result.identity;
}

/** Resolves null when there is no usable credential. */
export async function currentIdentity(): Promise<Identity | null> {
  try {
    const result = await get<{ identity: Identity }>('/auth/me');
    return result.identity;
  } catch {
    // `request()` has already cleared a rejected token; anything else here
    // (offline, server down) is equally "we do not know who you are yet".
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await post('/auth/logout');
  } finally {
    clearToken();
  }
}
