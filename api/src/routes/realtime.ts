import { LOBBY_CHANNEL } from '@futsal/shared';
import { Hono } from 'hono';
import type { AppContext } from '../env.js';
import { badRequest, unauthorized } from '../http.js';
import { issueSseTicket, verifySseTicket } from '../identity/index.js';
import { requireMember } from '../middleware.js';
import { createPubSub } from '../realtime/index.js';

/** Only these shapes may be subscribed to; anything else is rejected outright. */
const CHANNEL_PATTERN = /^session:[A-Za-z0-9_-]{1,64}$/;

function isSubscribable(channel: string): boolean {
  return channel === LOBBY_CHANNEL || CHANNEL_PATTERN.test(channel);
}

export const realtimeRoutes = new Hono<AppContext>()

  /**
   * Trade the long-lived session token for a two-minute stream ticket.
   *
   * `EventSource` cannot send an `Authorization` header, so the credential has
   * to travel in the query string, where it may end up in logs. A ticket that
   * expires in two minutes and can do nothing but open a stream is a much
   * safer thing to leave lying around than a 90-day token.
   */
  .post('/ticket', requireMember(), async (c) => {
    const pubsub = c.get('pubsub');
    return c.json({
      ticket: await issueSseTicket(c.env, c.get('identity')),
      enabled: pubsub.enabled,
    });
  })

  /**
   * The SSE stream itself. Authenticated by ticket rather than by the usual
   * middleware, and therefore mounted outside the protected router.
   */
  .get('/stream', async (c) => {
    const identity = await verifySseTicket(c.env, c.req.query('ticket') ?? null);
    if (!identity) throw unauthorized('Stream ticket is missing or expired');

    const channels = c.req.queries('channels') ?? [];
    if (channels.length === 0) throw badRequest('Subscribe to at least one channel');
    if (channels.length > 4) throw badRequest('Too many channels');

    const denied = channels.filter((channel) => !isSubscribable(channel));
    if (denied.length > 0) throw badRequest(`Not subscribable: ${denied.join(', ')}`);

    // Every member can see every session, so passing the format check is the
    // whole authorization story today. The check stays because it is what
    // stops a crafted `channels` value from reaching arbitrary Redis keys.
    const pubsub = createPubSub(c.env);
    return pubsub.subscribe(c.req.raw, channels);
  });
