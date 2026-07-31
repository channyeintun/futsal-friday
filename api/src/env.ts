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

  /**
   * Optional: Web Push. Without these the app still works, it just cannot send
   * reminders — the UI hides the toggle rather than offering a dead switch.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;

  /** Hours before kickoff to send the match reminder. Defaults to 3. */
  REMINDER_LEAD_HOURS?: string;
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

export function reminderLeadHours(env: Env): number {
  const parsed = Number.parseFloat(env.REMINDER_LEAD_HOURS ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}
