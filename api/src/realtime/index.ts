import type { EventName, EventPayload } from '@futsal/shared';
import type { Env } from '../env.js';
import { createUpstashPubSub } from './upstash.js';
import { createDisabledPubSub } from './disabled.js';

/**
 * The realtime seam.
 *
 * Routes only ever call `emit`. Swapping Upstash for Durable Object WebSockets
 * later means writing one more implementation of this interface and changing
 * the factory below — no route touches a Redis client or an SSE frame.
 */
export interface PubSub {
  /** False when realtime is unavailable; clients then rely on polling alone. */
  readonly enabled: boolean;

  /**
   * Publish one event to one or more channels.
   *
   * Never throws: a realtime hiccup must not fail the mutation that triggered
   * it. The write already committed, and every client polls as a backstop.
   */
  emit<K extends EventName>(
    channels: string | readonly string[],
    event: K,
    data: EventPayload<K>,
  ): Promise<void>;

  /** Serve an SSE subscription for the given channels. */
  subscribe(request: Request, channels: readonly string[]): Promise<Response>;
}

export function createPubSub(env: Env): PubSub {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return createUpstashPubSub(env);
  }
  return createDisabledPubSub();
}
