/**
 * Compact signed tokens: `base64url(payload).base64url(HMAC-SHA256(payload))`.
 *
 * Not JWT — there is no algorithm field to confuse, and therefore no "alg: none"
 * class of bug. The payload is signed, not encrypted, so it is readable by the
 * client; nothing secret goes in it.
 */

export type TokenScope =
  /** Long-lived credential proving "I am this member". */
  | 'session'
  /** Very short-lived, single-purpose ticket for the SSE query string. */
  | 'sse';

export interface TokenClaims {
  scope: TokenScope;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Member id. */
  sub?: string;
  name?: string;
  org?: boolean;
  /**
   * Snapshot of `members.token_version` when this token was issued. Compared
   * on every request, so bumping the column signs out that member everywhere.
   */
  v?: number;
}

const encoder = new TextEncoder();

export async function signToken(
  secret: string,
  claims: Omit<TokenClaims, 'exp'>,
  ttlSeconds: number,
): Promise<string> {
  const payload: TokenClaims = {
    ...claims,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await hmac(secret, body);
  return `${body}.${signature}`;
}

/**
 * Verify signature, expiry and scope. Returns `null` on any failure — callers
 * cannot accidentally treat a bad token as merely expired.
 */
export async function verifyToken(
  secret: string,
  token: string | undefined | null,
  expectedScope: TokenScope,
): Promise<TokenClaims | null> {
  if (!token) return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const key = await importKey(secret);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(signature),
      encoder.encode(body),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let claims: TokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as TokenClaims;
  } catch {
    return null;
  }

  if (claims.scope !== expectedScope) return null;
  if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) return null;

  return claims;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return base64UrlEncode(new Uint8Array(signature));
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Constant-time string compare for the shared invite code, so a wrong guess
 * cannot be narrowed down by timing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  // Length alone is not secret enough to matter, but mixing it in keeps the
  // loop a fixed number of iterations regardless of where the mismatch is.
  let diff = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < max; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}
