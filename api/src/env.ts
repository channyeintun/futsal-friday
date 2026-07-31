import type { Identity } from '@futsal/shared';
import type { PubSub } from './realtime/index.js';

export interface Env {
  DB: D1Database;
  PROOFS: R2Bucket;

  /** Origin allowed to call the API with credentials. */
  WEB_ORIGIN: string;
  /** Public app URL, embedded in shareable summaries. */
  APP_URL: string;
  SSE_MAX_DURATION_SECS: string;

  /** Shared code that gates the entire app. */
  GROUP_INVITE_CODE: string;
  /** HMAC key for identity tokens. */
  AUTH_SECRET: string;

  /** Optional: realtime falls back to polling when these are unset. */
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}

/** Per-request state that middleware hangs off the Hono context. */
export interface Variables {
  identity: Identity;
  pubsub: PubSub;
}

export type AppContext = { Bindings: Env; Variables: Variables };

export function sseMaxDurationSecs(env: Env): number {
  const parsed = Number.parseInt(env.SSE_MAX_DURATION_SECS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
}
