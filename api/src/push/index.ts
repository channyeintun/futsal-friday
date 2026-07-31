import type { Env } from '../env.js';
import { type PushKeys, type VapidKeys, encryptPayload, vapidAuthorization } from './crypto.js';

/**
 * Web Push delivery.
 *
 * Kept behind an interface for the same reason as the realtime module: it is a
 * third-party dependency in the hot path of a cron job, and the day it needs to
 * become "post to a queue instead" should be a one-file change.
 */

export interface PushTarget {
  subscriptionId: string;
  endpoint: string;
  keys: PushKeys;
}

/** What the service worker receives and renders as a notification. */
export interface PushMessage {
  title: string;
  body: string;
  /** Deep link opened when the notification is tapped. */
  url?: string;
  /** Collapses earlier notifications with the same tag. */
  tag?: string;
  /** Seconds the push service should hold the message for an offline device. */
  ttl?: number;
}

export type PushOutcome =
  | { status: 'sent'; subscriptionId: string }
  /** The subscription is permanently gone — delete the row. */
  | { status: 'gone'; subscriptionId: string }
  /** Transient or unexpected; count the failure but keep the row. */
  | { status: 'failed'; subscriptionId: string; reason: string };

export interface PushSender {
  readonly enabled: boolean;
  send(target: PushTarget, message: PushMessage): Promise<PushOutcome>;
  /** The key browsers need to create a subscription. */
  publicKey(): string | null;
}

export function createPushSender(env: Env): PushSender {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;

  if (!publicKey || !privateKey) {
    return {
      enabled: false,
      publicKey: () => null,
      async send(target) {
        console.log(`[push disabled] would notify ${target.subscriptionId}`);
        return { status: 'failed', subscriptionId: target.subscriptionId, reason: 'disabled' };
      },
    };
  }

  const vapid: VapidKeys = {
    publicKey,
    privateKey,
    // RFC 8292 wants a contact the push service can reach if we misbehave.
    subject: env.VAPID_SUBJECT || 'mailto:futsal-friday@example.com',
  };

  return {
    enabled: true,
    publicKey: () => publicKey,

    async send(target, message) {
      try {
        const payload = JSON.stringify({
          title: message.title,
          body: message.body,
          url: message.url ?? '/',
          tag: message.tag,
        });

        const { body } = await encryptPayload(payload, target.keys);
        const authorization = await vapidAuthorization(target.endpoint, vapid);

        const response = await fetch(target.endpoint, {
          method: 'POST',
          headers: {
            Authorization: authorization,
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            // A reminder that arrives a day late is worse than none at all.
            TTL: String(message.ttl ?? 6 * 60 * 60),
            Urgency: 'normal',
            ...(message.tag ? { Topic: safeTopic(message.tag) } : {}),
          },
          body: body as BodyInit,
        });

        if (response.ok) {
          return { status: 'sent', subscriptionId: target.subscriptionId };
        }

        // 404/410 is the push service saying this endpoint will never work
        // again — the user cleared site data or uninstalled the app.
        if (response.status === 404 || response.status === 410) {
          return { status: 'gone', subscriptionId: target.subscriptionId };
        }

        const detail = await response.text().catch(() => '');
        return {
          status: 'failed',
          subscriptionId: target.subscriptionId,
          reason: `${response.status} ${detail.slice(0, 120)}`,
        };
      } catch (error) {
        return {
          status: 'failed',
          subscriptionId: target.subscriptionId,
          reason: error instanceof Error ? error.message : 'unknown',
        };
      }
    },
  };
}

/**
 * `Topic` must be a short base64url token; our tags contain `:` and ids.
 * Truncating keeps collapsing behaviour without risking a 400 from the service.
 */
function safeTopic(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
}
