import type { EventCatalogueIsConsistent, EventName, EventPayload } from '@futsal/shared';
import { realtimeSchema } from '@futsal/shared';
import { Realtime, handle } from '@upstash/realtime';
import { Redis } from '@upstash/redis';
import { type Env, sseMaxDurationSecs } from '../env.js';
import type { PubSub } from './index.js';

type RealtimeClient = ReturnType<typeof createRealtime>;

/**
 * The one cast in the realtime path.
 *
 * `@upstash/realtime` derives `emit`'s payload type by walking the schema
 * object along the dotted event path. That is equivalent to our
 * `EventPayload<K>` lookup for every concrete event name, but TypeScript cannot
 * prove it while `K` is still generic, so it rejects the forwarding call.
 *
 * The equivalence is verified instead by `EventCatalogueIsConsistent` in
 * /shared — referenced here so this cast and its proof cannot drift apart.
 */
function emitTo<K extends EventName>(
  realtime: RealtimeClient,
  channel: string,
  event: K,
  data: EventPayload<K>,
): Promise<void> {
  const _proof: EventCatalogueIsConsistent = true;
  void _proof;

  const emit = realtime.channel(channel).emit as unknown as (
    event: string,
    data: unknown,
  ) => Promise<void>;
  return emit(event, data);
}

/**
 * Upstash-backed pub/sub.
 *
 * Publishing goes through `@upstash/realtime`, which validates each payload
 * against the shared zod schema and then pipelines `XADD` + `PUBLISH` over the
 * Redis REST API. Subscribing reuses the library's `handle()` — despite the
 * Next.js framing in its docs it is a plain `(Request) => Promise<Response>`,
 * so it mounts directly on a Hono route with no adapter.
 *
 * ## Free-tier arithmetic
 *
 * Upstash's free plan allows 500k commands/month. Two things spend them:
 *
 *   * **Emits** — 3 commands each (`XADD` + `EXPIRE` + `PUBLISH`). Even a busy
 *     week is under 200 emits, so this is rounding error.
 *   * **Keepalives** — `handle()` publishes a ping every 10s for every open
 *     connection: 360 commands per connection-hour. *This* is the budget, and
 *     it is not configurable from out here.
 *
 * At 360/hour a single browser tab left open around the clock would burn
 * ~260k commands a month by itself. Hanging up is therefore the client's job:
 * it closes the stream when the page is hidden and after a few minutes without
 * interaction, dropping back to a 30s poll (see `web/src/api/realtime.ts`).
 * With that in place a normal week costs a few thousand commands — around 2%
 * of the monthly allowance.
 */
function createRealtime(env: Env) {
  const redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL!,
    token: env.UPSTASH_REDIS_REST_TOKEN!,
    // The REST client retries generously by default. A realtime event is not
    // worth stalling the mutation response that triggered it.
    retry: { retries: 1, backoff: () => 100 },
  });

  return new Realtime({
    schema: realtimeSchema,
    redis,
    // Recycle long-lived streams so connections (and their keepalives) cannot
    // accumulate indefinitely. The client reconnects transparently.
    maxDurationSecs: sseMaxDurationSecs(env),
    // A short replay buffer closes the gap between "page rendered" and "stream
    // connected", so a join landing in that window still shows up. Trim +
    // expiry keep Redis storage flat with no cleanup job.
    history: { maxLength: 100, expireAfterSecs: 60 * 60 * 24 * 7 },
  });
}

export function createUpstashPubSub(env: Env): PubSub {
  const realtime = createRealtime(env);

  return {
    enabled: true,

    async emit(channels, event, data) {
      const targets = typeof channels === 'string' ? [channels] : channels;
      // Best-effort by design: the D1 write has already committed and clients
      // poll as a backstop, so a Redis failure must never surface as a 500.
      await Promise.all(
        targets.map((channel) =>
          emitTo(realtime, channel, event, data).catch((error: unknown) => {
            console.error(`realtime emit failed (${event} -> ${channel})`, error);
          }),
        ),
      );
    },

    async subscribe(request, channels) {
      const allowed = new Set(channels);

      const handler = handle({
        realtime,
        // The route has already authorized `channels` against the caller's
        // identity. Re-checking what the library actually parsed out of the
        // query string means a future change to its parsing fails closed
        // rather than silently widening access.
        middleware: ({ channels: requested }) => {
          const denied = requested.filter((channel) => !allowed.has(channel));
          if (denied.length > 0) {
            return Response.json(
              {
                error: {
                  code: 'forbidden',
                  message: `Not subscribable: ${denied.join(', ')}`,
                },
              },
              { status: 403 },
            );
          }
        },
      });

      // Deliberately passing the *original* request rather than a rebuilt one:
      // `handle()` hangs its cleanup off `request.signal`, and reconstructing
      // the Request risks losing that, which would leak Redis subscriptions
      // every time a client navigates away.
      const response = await handler(request);
      return (
        response ??
        Response.json(
          { error: { code: 'internal', message: 'Realtime handler produced no response' } },
          { status: 500 },
        )
      );
    },
  };
}
