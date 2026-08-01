import type { Identity } from '@futsal/shared';
import type { Env } from '../env.js';
import { signToken, verifyToken } from './tokens.js';

/**
 * The identity seam.
 *
 * Everything else in the Worker asks for an `Identity` and never learns how it
 * was obtained. Adding real authentication later — an OAuth provider, a magic
 * link — means writing a second `IdentityProvider` and mapping it to
 * `members.external_id`, with no route or query changes.
 */
export interface IdentityProvider {
  readonly name: string;

  /**
   * Identify the caller from the raw request, or return `null` for anonymous.
   * Must not touch the database; membership is re-checked by the caller so a
   * removed member loses access immediately.
   */
  authenticate(
    request: Request,
    env: Env,
  ): Promise<{ memberId: string; tokenVersion: number } | null>;

  /** Mint a credential for a member who has just redeemed a claim link. */
  issue(identity: Identity, tokenVersion: number, env: Env): Promise<IssuedCredential>;

  /** Header value that clears any stored credential. */
  revoke(): { setCookie?: string };
}

export interface IssuedCredential {
  /** Bearer token. The client stores this and sends it on every request. */
  token: string;
  /** Optional `Set-Cookie`, used when API and app share an origin. */
  setCookie?: string;
}

const COOKIE_NAME = 'ff_token';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
const SSE_TICKET_TTL_SECONDS = 120;
/** A link is useful for a week; long enough to be seen, short enough to rot. */
export const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The group link lives in a chat thread, so it needs to still work for the
 * friend who reads the message a fortnight late. Longer is tolerable because
 * of what it can do rather than how long it lasts: once everybody has claimed
 * a name it can claim nothing, and the organizer can rotate it at any time.
 */
export const GROUP_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Web provider: a signed bearer token, mirrored into an HttpOnly cookie.
 *
 * The bearer token is the primary credential because it survives the shape this
 * app is actually deployed in: Pages and Workers on different origins, where
 * Safari blocks third-party cookies outright. The cookie is a bonus for
 * same-origin deployments — there it carries the credential out of reach of XSS.
 */
export const tokenIdentityProvider: IdentityProvider = {
  name: 'token',

  async authenticate(request, env) {
    const header = request.headers.get('Authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const token = bearer ?? readCookie(request, COOKIE_NAME);

    const claims = await verifyToken(env.AUTH_SECRET, token, 'session');
    if (!claims?.sub) return null;
    // Tokens minted before revocation existed have no version; treat them as
    // version 1, which is the column default.
    return { memberId: claims.sub, tokenVersion: claims.v ?? 1 };
  },

  async issue(identity, tokenVersion, env) {
    const token = await signToken(
      env.AUTH_SECRET,
      {
        scope: 'session',
        sub: identity.memberId,
        name: identity.name,
        org: identity.isOrganizer,
        v: tokenVersion,
      },
      SESSION_TTL_SECONDS,
    );
    return { token, setCookie: buildCookie(token, SESSION_TTL_SECONDS) };
  },

  revoke() {
    return { setCookie: buildCookie('', 0) };
  },
};

/* ----------------------------------------------------------- claim nonces */

/**
 * A claim link's secret.
 *
 * 256 bits of randomness, looked up directly in the database. Not a signed
 * token on purpose: the DB row *is* the proof, so spending a link is a delete
 * rather than a revocation list, and the bootstrap path can mint one with a
 * single SQL statement without needing `AUTH_SECRET`.
 */
export function newClaimNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/* ------------------------------------------------------------ SSE tickets */

/**
 * `EventSource` cannot set an `Authorization` header, so the SSE endpoint takes
 * its credential from the query string. Rather than putting the 90-day session
 * token somewhere it could be logged by a proxy, the client trades it for a
 * two-minute, stream-only ticket.
 */
export function issueSseTicket(env: Env, identity: Identity): Promise<string> {
  return signToken(
    env.AUTH_SECRET,
    { scope: 'sse', sub: identity.memberId, name: identity.name, org: identity.isOrganizer },
    SSE_TICKET_TTL_SECONDS,
  );
}

export async function verifySseTicket(env: Env, ticket: string | null): Promise<Identity | null> {
  const claims = await verifyToken(env.AUTH_SECRET, ticket, 'sse');
  if (!claims?.sub) return null;
  return {
    memberId: claims.sub,
    name: claims.name ?? '',
    isOrganizer: claims.org === true,
    // Not carried in the ticket: the stream endpoint sends no prose.
    language: 'en',
    // A ticket is only ever minted for an approved member, and the stream
    // route re-checks nothing else; carrying the flag would only let a stale
    // ticket assert it.
    approved: true,
  };
}

/* ---------------------------------------------------------------- helpers */

function buildCookie(value: string, maxAge: number): string {
  // SameSite=None is required for the cross-origin Pages -> Workers case; it
  // implies Secure, which browsers accept on http://localhost for dev.
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}
