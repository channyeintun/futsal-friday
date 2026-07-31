import {
  type SessionDetail,
  formatKickoff,
  formatVnd,
  registrationSummary,
  relativeToNow,
} from '@futsal/shared';
import { useState } from 'react';
import type { ConnectionState } from '../api/realtime.js';
import { cancelSession, registerForSession, withdrawFromSession } from '../api/sessions.js';
import { platform } from '../platform/index.js';
import { navigate } from '../router.js';
import { useApp } from '../state/app.js';
import { CopyButton } from './CopyButton.js';
import { Icon } from './Icon.js';
import { SessionEditor } from './SessionEditor.js';
import { Button, Dialog, ErrorBanner } from './ui.js';

/**
 * The main screen: when and where, who is in, and the one button that matters.
 */
export function SessionView({
  detail,
  connection,
  recentlyChanged,
  onChanged,
}: {
  detail: SessionDetail;
  connection: ConnectionState;
  recentlyChanged: Set<string>;
  onChanged(): void;
}) {
  const { identity, toast } = useApp();
  const { session, registrations, counts, registrationOpen, me } = detail;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const playing = registrations.filter((r) => r.status === 'in');
  const waiting = registrations.filter((r) => r.status === 'waitlist');

  const toggleRegistration = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (me) {
        const result = await withdrawFromSession(session.id);
        toast(
          result.promoted
            ? `You're out — ${result.promoted.memberName} moves up`
            : "You're out",
        );
      } else {
        const result = await registerForSession(session.id);
        toast(result.registration.status === 'waitlist' ? "You're on the waitlist" : "You're in");
      }
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    setBusy(true);
    try {
      await cancelSession(session.id);
      toast('Session cancelled');
      setConfirmCancel(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not cancel');
    } finally {
      setBusy(false);
    }
  };

  const summary = registrationSummary(detail, { appUrl: platform.appUrl });

  return (
    <>
      <section className="hero">
        <span className="countdown">
          {session.status === 'cancelled'
            ? 'Cancelled'
            : session.status === 'completed'
              ? 'Finished'
              : relativeToNow(session.startsAt)}
        </span>
        <span className="when">{formatKickoff(session.startsAt)}</span>

        {session.venue ? (
          <span className="where row" style={{ gap: 6 }}>
            <Icon name="place" size={16} />
            <span className="truncate">{session.venue.name}</span>
          </span>
        ) : (
          <span className="where">Venue not decided yet</span>
        )}

        {session.feePerPerson != null ? (
          <span className="where">~{formatVnd(session.feePerPerson)} each</span>
        ) : null}
      </section>

      {session.venue?.mapUrl ? (
        <Button variant="text" onClick={() => platform.openExternal(session.venue!.mapUrl!)}>
          <Icon name="place" size={18} slot="icon" />
          Open map
        </Button>
      ) : null}

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {session.status === 'cancelled' ? (
        <div className="error-banner">This session was cancelled.</div>
      ) : registrationOpen ? (
        <Button
          variant={me ? 'outlined' : 'filled'}
          onClick={toggleRegistration}
          disabled={busy}
        >
          {busy
            ? 'One sec…'
            : me
              ? me.status === 'waitlist'
                ? 'Leave the waitlist'
                : "Can't make it"
              : "I'm in"}
        </Button>
      ) : (
        <div className="muted" style={{ textAlign: 'center' }}>
          Registration is closed for this session.
        </div>
      )}

      <div className="card">
        <div className="row between">
          <h2 className="card-title">
            Playing {counts.in}
            {session.maxPlayers ? ` / ${session.maxPlayers}` : ''}
          </h2>
          <ConnectionDot state={connection} />
        </div>

        {playing.length === 0 ? (
          <p className="empty">Nobody yet. Be the first.</p>
        ) : (
          <div>
            {playing.map((registration, index) => (
              <div
                key={registration.memberId}
                className={[
                  'player-row',
                  registration.memberId === identity.memberId ? 'is-me' : '',
                  recentlyChanged.has(registration.memberId) ? 'flash' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span className="player-index">{index + 1}</span>
                <span className="player-name truncate">{registration.memberName}</span>
                {registration.memberId === identity.memberId ? (
                  <span className="badge paid">you</span>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {waiting.length > 0 ? (
          <>
            <h3 className="card-sub" style={{ fontWeight: 600 }}>
              Waitlist ({counts.waitlist})
            </h3>
            <div>
              {waiting.map((registration, index) => (
                <div
                  key={registration.memberId}
                  className={[
                    'player-row',
                    registration.memberId === identity.memberId ? 'is-me' : '',
                    recentlyChanged.has(registration.memberId) ? 'flash' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className="player-index">{index + 1}</span>
                  <span className="player-name truncate">{registration.memberName}</span>
                  <span className="badge waitlist">waiting</span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {session.notes ? (
        <div className="card">
          <p className="card-sub" style={{ margin: 0 }}>
            {session.notes}
          </p>
        </div>
      ) : null}

      <CopyButton label="Copy list for chat" text={summary} />

      {(session.status === 'completed' || session.totalCharge != null) ? (
        <Button variant="outlined" onClick={() => navigate({ name: 'payments', id: session.id })}>
          <Icon name="money" size={18} slot="icon" />
          {session.totalCharge == null ? 'Split the bill' : 'Payments'}
        </Button>
      ) : null}

      {identity.isOrganizer && session.status !== 'cancelled' ? (
        <div className="row" style={{ gap: 8 }}>
          <div className="grow">
            <Button variant="tonal" onClick={() => setEditing(true)}>
              <Icon name="edit" size={18} slot="icon" />
              Edit
            </Button>
          </div>
          <Button variant="text" onClick={() => setConfirmCancel(true)}>
            Cancel session
          </Button>
        </div>
      ) : null}

      {identity.isOrganizer ? (
        <SessionEditor
          session={session}
          open={editing}
          onClose={() => setEditing(false)}
          onSaved={onChanged}
        />
      ) : null}

      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        headline="Cancel this session?"
        actions={
          <>
            <Button variant="text" onClick={() => setConfirmCancel(false)}>
              Keep it
            </Button>
            <Button variant="filled" onClick={doCancel} disabled={busy}>
              Cancel session
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Everyone registered will see it as cancelled. This cannot be undone from the app.
        </p>
      </Dialog>
    </>
  );
}

/** Quiet indicator so people can tell "live" from "might be a bit behind". */
function ConnectionDot({ state }: { state: ConnectionState }) {
  const label =
    state === 'live'
      ? 'Live'
      : state === 'polling'
        ? 'Updating every 30s'
        : state === 'connecting'
          ? 'Connecting…'
          : 'Paused';

  return (
    <span className={`conn ${state}`} title={label}>
      <span className="dot" />
      {label}
    </span>
  );
}
