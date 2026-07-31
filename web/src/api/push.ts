import type { NotificationPrefsInput, PushStatus } from '@futsal/shared';
import { platform } from '../platform/index.js';
import { get, patch, post } from './client.js';

export const pushStatus = (signal?: AbortSignal) => get<PushStatus>('/push/status', signal);

export const updateNotificationPrefs = (input: NotificationPrefsInput) =>
  patch<{ notifySession: boolean; notifyPayment: boolean }>('/push/preferences', input);

export const sendTestNotification = () =>
  post<{ sent: number; removed: number; failed: number }>('/push/test');

export type EnableResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'needs-install' | 'denied' | 'disabled' | 'failed' };

/**
 * Turn reminders on for *this device*.
 *
 * Order matters: the permission prompt must be triggered by the user gesture
 * that called this, so it goes first, before any awaits that would break the
 * gesture chain on Safari.
 */
export async function enableNotifications(publicKey: string | null): Promise<EnableResult> {
  if (!publicKey) return { ok: false, reason: 'disabled' };
  if (platform.notifications.requiresInstall()) return { ok: false, reason: 'needs-install' };
  if (!platform.notifications.supported()) return { ok: false, reason: 'unsupported' };

  const permission = await platform.notifications.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  try {
    const subscription = await platform.notifications.subscribe(publicKey);
    if (!subscription) return { ok: false, reason: 'failed' };
    await post('/push/subscribe', subscription);
    return { ok: true };
  } catch (error) {
    console.warn('Could not subscribe to push', error);
    return { ok: false, reason: 'failed' };
  }
}

/** Turn reminders off for this device, both locally and on the server. */
export async function disableNotifications(): Promise<void> {
  const current = await platform.notifications.current();
  await platform.notifications.unsubscribe();
  await post('/push/unsubscribe', current ? { endpoint: current.endpoint } : {});
}

/**
 * Re-register after the push service rotates a subscription. Without this a
 * device quietly stops receiving reminders and nobody finds out until they
 * miss a game.
 */
export async function resyncSubscription(publicKey: string | null): Promise<void> {
  if (!publicKey || platform.notifications.permission() !== 'granted') return;
  const subscription = await platform.notifications.subscribe(publicKey);
  if (subscription) await post('/push/subscribe', subscription);
}
