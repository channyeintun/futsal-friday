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
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
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
    });
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
