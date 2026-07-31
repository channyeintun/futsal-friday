import { useCallback, useEffect, useState } from 'react';
import {
  disableNotifications,
  enableNotifications,
  pushStatus,
  resyncSubscription,
  sendTestNotification,
  updateNotificationPrefs,
} from '../api/push.js';
import { useAsync } from '../hooks/useAsync.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { Icon } from './Icon.js';
import { Button, ErrorBanner, Switch } from './ui.js';

/**
 * Reminder opt-in.
 *
 * Two separate things live here and are easy to confuse: whether *this device*
 * has a push subscription (a browser permission), and which reminders the
 * member wants (a server-side preference shared across their devices). The UI
 * keeps them visually distinct because turning the phone off should not stop
 * reminders reaching the laptop.
 */
export function ReminderSettings() {
  const { toast } = useApp();
  const status = useAsync((signal) => pushStatus(signal), []);

  const [deviceOn, setDeviceOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publicKey = status.data?.publicKey ?? null;

  // Reflect what this browser actually has, not what the server last saw.
  useEffect(() => {
    platform.notifications
      .current()
      .then((subscription) => setDeviceOn(subscription !== null))
      .catch(() => setDeviceOn(false));
  }, [status.data]);

  // The push service can rotate a subscription at any time.
  useEffect(() => {
    return platform.notifications.onSubscriptionChange(() => {
      void resyncSubscription(publicKey);
    });
  }, [publicKey]);

  const toggleDevice = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setError(null);
      try {
        if (next) {
          const result = await enableNotifications(publicKey);
          if (result.ok) {
            setDeviceOn(true);
            toast('Reminders on for this device');
            status.reload();
          } else {
            setDeviceOn(false);
            setError(explain(result.reason));
          }
        } else {
          await disableNotifications();
          setDeviceOn(false);
          toast('Reminders off for this device');
          status.reload();
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not change that');
      } finally {
        setBusy(false);
      }
    },
    [publicKey, status, toast],
  );

  const setPref = async (key: 'notifySession' | 'notifyPayment', value: boolean) => {
    try {
      await updateNotificationPrefs({ [key]: value });
      status.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that');
    }
  };

  if (!status.data) return null;

  // Nothing to offer if the server has no VAPID keys.
  if (!status.data.enabled) {
    return (
      <div className="card">
        <h2 className="card-title">Reminders</h2>
        <p className="card-sub">Not configured on this server yet.</p>
      </div>
    );
  }

  const needsInstall = platform.notifications.requiresInstall();
  const unsupported = !platform.notifications.supported() && !needsInstall;
  const blocked = platform.notifications.permission() === 'denied';

  return (
    <div className="card">
      <h2 className="card-title">Reminders</h2>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {needsInstall ? (
        <div className="install-hint">
          <strong>Add to Home Screen first.</strong>
          <p style={{ margin: '6px 0 0' }}>
            iPhone only delivers notifications to installed apps. Tap{' '}
            <Icon name="share" size={15} /> Share, then <em>Add to Home Screen</em>, and open
            Futsal Friday from there.
          </p>
        </div>
      ) : unsupported ? (
        <p className="card-sub">This browser cannot do notifications.</p>
      ) : (
        <>
          <div className="row between">
            <div className="grow">
              <div style={{ fontWeight: 500 }}>This device</div>
              <div className="muted">
                {blocked
                  ? 'Blocked in browser settings — allow notifications there first.'
                  : deviceOn
                    ? 'Notifications are on here.'
                    : 'Get a nudge before kickoff and when you owe money.'}
              </div>
            </div>
            <Switch
              selected={deviceOn}
              disabled={busy || blocked}
              onChange={(next) => void toggleDevice(next)}
            />
          </div>

          {status.data.devices > 1 ? (
            <p className="muted" style={{ margin: 0 }}>
              Reminders are on for {status.data.devices} devices.
            </p>
          ) : null}
        </>
      )}

      <hr
        style={{
          border: 0,
          borderTop: '1px solid var(--md-sys-color-outline-variant)',
          margin: '4px 0',
        }}
      />

      <div className="row between">
        <div className="grow">
          <div style={{ fontWeight: 500 }}>Before the match</div>
          <div className="muted">About 3 hours before kickoff, if you're playing.</div>
        </div>
        <Switch
          selected={status.data.notifySession}
          onChange={(next) => void setPref('notifySession', next)}
        />
      </div>

      <div className="row between">
        <div className="grow">
          <div style={{ fontWeight: 500 }}>Unpaid reminders</div>
          <div className="muted">A weekly nudge while you still owe for a session.</div>
        </div>
        <Switch
          selected={status.data.notifyPayment}
          onChange={(next) => void setPref('notifyPayment', next)}
        />
      </div>

      {deviceOn ? (
        <Button
          variant="text"
          disabled={busy}
          onClick={async () => {
            try {
              const result = await sendTestNotification();
              toast(
                result.sent > 0
                  ? 'Sent — check your notifications'
                  : 'No device could be reached',
              );
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'Could not send a test');
            }
          }}
        >
          Send a test notification
        </Button>
      ) : null}
    </div>
  );
}

function explain(reason: 'unsupported' | 'needs-install' | 'denied' | 'disabled' | 'failed'): string {
  switch (reason) {
    case 'needs-install':
      return 'Add the app to your Home Screen first, then turn this on from there.';
    case 'denied':
      return 'Notifications were blocked. Allow them for this site in your browser settings.';
    case 'unsupported':
      return 'This browser cannot do notifications.';
    case 'disabled':
      return 'Reminders are not configured on this server.';
    default:
      return 'Could not turn reminders on. Try again.';
  }
}
