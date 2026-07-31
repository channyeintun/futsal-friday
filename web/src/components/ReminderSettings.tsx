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
import { useMessages } from '../state/locale.js';
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
  const m = useMessages();
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
            toast(m.toast.remindersOn);
            status.reload();
          } else {
            setDeviceOn(false);
            setError(explain(result.reason, m));
          }
        } else {
          await disableNotifications();
          setDeviceOn(false);
          toast(m.toast.remindersOff);
          status.reload();
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : m.reminders.couldNotChange);
      } finally {
        setBusy(false);
      }
    },
    [publicKey, status, toast, m],
  );

  const setPref = async (key: 'notifySession' | 'notifyPayment', value: boolean) => {
    try {
      await updateNotificationPrefs({ [key]: value });
      status.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.reminders.couldNotSave);
    }
  };

  if (!status.data) return null;

  // Nothing to offer if the server has no VAPID keys.
  if (!status.data.enabled) {
    return (
      <div className="card">
        <h2 className="card-title">{m.reminders.title}</h2>
        <p className="card-sub">{m.reminders.notConfigured}</p>
      </div>
    );
  }

  const needsInstall = platform.notifications.requiresInstall();
  const unsupported = !platform.notifications.supported() && !needsInstall;
  const blocked = platform.notifications.permission() === 'denied';

  return (
    <div className="card">
      <h2 className="card-title">{m.reminders.title}</h2>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {needsInstall ? (
        <div className="install-hint">
          <strong>{m.reminders.installFirst}</strong>
          <p style={{ margin: '6px 0 0' }}>
            <Icon name="share" size={15} /> {m.reminders.installBody}
          </p>
        </div>
      ) : unsupported ? (
        <p className="card-sub">{m.reminders.unsupported}</p>
      ) : (
        <>
          <div className="row between">
            <div className="grow">
              <div style={{ fontWeight: 500 }}>{m.reminders.thisDevice}</div>
              <div className="muted">
                {blocked
                  ? m.reminders.blocked
                  : deviceOn
                    ? m.reminders.onHere
                    : m.reminders.offHere}
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
              {m.reminders.deviceCount(status.data.devices)}
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
          <div style={{ fontWeight: 500 }}>{m.reminders.beforeMatch}</div>
          <div className="muted">{m.reminders.beforeMatchBody}</div>
        </div>
        <Switch
          selected={status.data.notifySession}
          onChange={(next) => void setPref('notifySession', next)}
        />
      </div>

      <div className="row between">
        <div className="grow">
          <div style={{ fontWeight: 500 }}>{m.reminders.unpaidTitle}</div>
          <div className="muted">{m.reminders.unpaidBody}</div>
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
              toast(result.sent > 0 ? m.toast.testSent : m.toast.testNoDevice);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : m.reminders.couldNotTest);
            }
          }}
        >
          {m.reminders.sendTest}
        </Button>
      ) : null}
    </div>
  );
}

function explain(
  reason: 'unsupported' | 'needs-install' | 'denied' | 'disabled' | 'failed',
  m: ReturnType<typeof useMessages>,
): string {
  switch (reason) {
    case 'needs-install':
      return m.reminders.needsInstall;
    case 'denied':
      return m.reminders.denied;
    case 'unsupported':
      return m.reminders.unsupported;
    case 'disabled':
      return m.reminders.disabled;
    default:
      return m.reminders.failed;
  }
}
