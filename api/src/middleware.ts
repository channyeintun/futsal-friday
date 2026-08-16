import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { AppContext } from './env.js';
import { getMemberById } from './db.js';
import { forbidden, unauthorized } from './http.js';
import { tokenIdentityProvider } from './identity/index.js';
import { createPubSub } from './realtime/index.js';

/**
 * CORS for the Pages -> Workers cross-origin case.
 *
 * `credentials: true` forbids a wildcard origin, so the allowed origin is read
 * from config. Local dev ports are permitted unconditionally because they can
 * never be a real deployment.
 */
export function corsMiddleware(): MiddlewareHandler<AppContext> {
  return async (c, next) =>
    cors({
      origin: (origin) => {
        if (!origin) return undefined;
        if (origin === c.env.WEB_ORIGIN) return origin;
        if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
        return undefined;
      },
      // Every method the API actually serves has to be listed: a browser
      // refuses the *real* request when the preflight omits its method, and the
      // resulting failure reaches the app as an indistinguishable network
      // error. `PUT` is what profile pictures and payment details use.
      //
      // `QUERY` (RFC 10008) is here ahead of any route that serves it — a safe,
      // idempotent, cacheable read that carries a body, for the filters too
      // long or too structured to sit in a query string. Advertising it costs
      // nothing while no route answers it, and spares the next person this
      // same debugging.
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'QUERY', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Invite-Code'],
      credentials: true,
      maxAge: 86_400,
    })(c, next);
}

/** Builds the pub/sub client once per request and hands it to the routes. */
export function pubsubMiddleware(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    c.set('pubsub', createPubSub(c.env));
    await next();
  };
}

/**
 * Require a signed-in member.
 *
 * The token carries the member's name and role, but they are re-read from the
 * database on every request: a token is valid for 90 days, and someone removed
 * from the group — or demoted from organizer — must lose access now, not in
 * three months.
 */
export function requireMember(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const resolved = await tokenIdentityProvider.authenticate(c.req.raw, c.env);
    if (!resolved) throw unauthorized();

    const member = await getMemberById(c.env.DB, resolved.memberId);
    if (!member) throw unauthorized('Your account is no longer active');

    // Revocation. The row is already loaded to re-check membership, so cutting
    // off a lost phone costs nothing extra.
    const current = await c.env.DB.prepare(
      `SELECT token_version FROM members WHERE id = ?1`,
    )
      .bind(member.id)
      .first<{ token_version: number }>();
    if ((current?.token_version ?? 1) !== resolved.tokenVersion) {
      throw unauthorized('This device was signed out. Ask for a new link.');
    }

    c.set('identity', {
      memberId: member.id,
      name: member.name,
      isOrganizer: member.isOrganizer,
      language: member.language,
      hour12: member.hour12,
      approved: member.approvedAt !== null,
    });
    await next();
  };
}

/**
 * Everything except finding out that you are still waiting.
 *
 * Somebody who added themselves from the group link holds a real token — they
 * have to, or they could not be told anything — so the waiting room is a
 * server-side gate, not a screen the client politely shows. Re-read on every
 * request like membership and role, so approving somebody takes effect at once
 * and so does changing your mind before they have done anything.
 *
 * Must run after {@link requireMember}.
 */
export function requireApproved(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    if (!c.get('identity')?.approved) {
      throw forbidden('The organizer has not let you in yet.');
    }
    await next();
  };
}

/** Must run after {@link requireMember}. */
export function requireOrganizer(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    if (!c.get('identity')?.isOrganizer) throw forbidden();
    await next();
  };
}
