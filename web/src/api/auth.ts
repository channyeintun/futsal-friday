import type { ClaimLink, Identity } from '@futsal/shared';
import { clearToken, del, get, post, setToken } from './client.js';

/**
 * Redeem a claim link. The nonce comes from the URL fragment, never the query
 * string, so it does not reach any server log on the way in.
 */
export async function claim(nonce: string): Promise<Identity> {
  const result = await post<{ token: string; identity: Identity }>('/auth/claim', { nonce });
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

/** A link for one of your own other devices. */
export const myDeviceLink = () => post<ClaimLink>('/auth/my-device-link');

/** Organizer: a link inviting one person to claim their identity. */
export const memberClaimLink = (memberId: string) =>
  post<ClaimLink>(`/members/${memberId}/claim-link`);

/** Organizer: sign out all of a member's devices and require a fresh link. */
export const revokeMemberClaim = (memberId: string) =>
  del<{ ok: true }>(`/members/${memberId}/claim`);

export async function logout(): Promise<void> {
  try {
    await post('/auth/logout');
  } finally {
    clearToken();
  }
}
