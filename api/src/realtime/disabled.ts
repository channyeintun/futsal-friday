import type { PubSub } from './index.js';

/**
 * Stand-in used when no Upstash credentials are configured — the default for
 * local development, so `wrangler dev` works without an Upstash account.
 *
 * Emits become no-ops and the SSE endpoint reports 503, which the client reads
 * as "go straight to polling" rather than as a transient failure to retry.
 */
export function createDisabledPubSub(): PubSub {
  return {
    enabled: false,

    async emit(channels, event) {
      console.log(
        `[realtime disabled] would emit ${event} to ${[channels].flat().join(', ')}`,
      );
    },

    async subscribe() {
      return Response.json(
        {
          error: {
            code: 'realtime_disabled',
            message: 'Realtime is not configured; poll instead.',
          },
        },
        { status: 503 },
      );
    },
  };
}
