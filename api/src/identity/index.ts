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
  authenticate(request: Request, env: Env): Promise<{ memberId: string } | null>;

  /** Mint a credential for a member who has just picked their name. */
  issue(identity: Identity, env: Env): Promise<IssuedCredential>;

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
const GATE_TTL_SECONDS = 60 * 15;
const SSE_TICKET_TTL_SECONDS = 120;

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
    return { memberId: claims.sub };
  },

  async issue(identity, env) {
    const token = await signToken(
      env.AUTH_SECRET,
      { scope: 'session', sub: identity.memberId, name: identity.name, org: identity.isOrganizer },
      SESSION_TTL_SECONDS,
    );
    return { token, setCookie: buildCookie(token, SESSION_TTL_SECONDS) };
  },

  revoke() {
    return { setCookie: buildCookie('', 0) };
  },
};

/* ------------------------------------------------------------ invite gate */

/** Proof that the group invite code was entered, issued before identification. */
export function issueGateToken(env: Env): Promise<string> {
  return signToken(env.AUTH_SECRET, { scope: 'gate' }, GATE_TTL_SECONDS);
}

export async function verifyGateToken(env: Env, token: string | null): Promise<boolean> {
  return (await verifyToken(env.AUTH_SECRET, token, 'gate')) !== null;
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
