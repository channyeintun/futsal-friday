import {
  type SessionDetail,
  attendanceChecked,
  formatKickoff,
  formatVnd,
  registrationSummary,
  relativeToNow,
  totalArrivedHeads,
} from '@futsal/shared';
import { useState } from 'react';
import type { ConnectionState } from '../api/realtime.js';
import { cancelSession, registerForSession, withdrawFromSession } from '../api/sessions.js';
import { platform } from '../platform/index.js';
import { navigate } from '../router.js';
import { useApp } from '../state/app.js';
import { useLocale, useMessages } from '../state/locale.js';
import { useRecentForm } from '../hooks/queries.js';
import { AnnounceButton } from './AnnounceButton.js';
import { AttendanceToggle } from './AttendanceToggle.js';
import { FormSquares } from './FormSquares.js';
import { GoalsButton } from './GoalsButton.js';
import { Avatar } from './Avatar.js';
import { GuestPicker } from './GuestPicker.js';
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
  const { m, locale, hour12 } = useLocale();
  const { session, registrations, counts, registrationOpen, me } = detail;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const playing = registrations.filter((r) => r.status === 'in');
  const waiting = registrations.filter((r) => r.status === 'waitlist');

  /**
   * Attendance is only offered once the game has kicked off.
   *
   * Asking beforehand would be asking people to predict themselves, and the
   * answer they gave at lunchtime is exactly the one that goes stale. The
   * server accepts a mark at any time — a correction days later still has to
   * work — but the screen only raises the question when it can be answered.
   */
  // Loaded alongside rather than inside the session read, so the hero paints
  // without waiting on a roster-wide history query.
  const form = useRecentForm();
  const formFor = (memberId: string) =>
    form.data?.form.find((entry) => entry.memberId === memberId)?.recent ?? [];

  const kickedOff = new Date(session.startsAt).getTime() <= Date.now();
  const showAttendance = kickedOff && session.status !== 'cancelled';
  const arrived = totalArrivedHeads(registrations);
  const checked = attendanceChecked(registrations);

  const toggleRegistration = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (me) {
        const result = await withdrawFromSession(session.id);
        toast(
          result.promoted
            ? m.toast.youreOutPromoted(result.promoted.memberName)
            : m.toast.youreOut,
        );
      } else {
        const result = await registerForSession(session.id);
        toast(
          result.registration.status === 'waitlist' ? m.toast.youreOnWaitlist : m.toast.youreIn,
        );
      }
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.session.thatDidNotWork);
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    setBusy(true);
    try {
      await cancelSession(session.id);
      toast(m.toast.sessionCancelled);
      setConfirmCancel(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.session.thatDidNotWork);
    } finally {
      setBusy(false);
    }
  };

  const summary = registrationSummary(detail, { appUrl: platform.appUrl, locale });

  return (
    <>
      <section className="hero">
        <span className="countdown">
          {session.status === 'cancelled'
            ? m.session.cancelled
            : session.status === 'completed'
              ? m.session.finished
              : relativeToNow(session.startsAt, new Date(), locale)}
        </span>
        <span className="when">{formatKickoff(session.startsAt, locale, hour12)}</span>

        {session.venue ? (
          <span className="where row" style={{ gap: 6 }}>
            <Icon name="place" size={16} />
            <span className="truncate">{session.venue.name}</span>
          </span>
        ) : (
          <span className="where">{m.session.noVenue}</span>
        )}

        {/* The pitch's hourly rate, not a per-person guess. What a head costs
            depends on how long they book and how many turn up, neither of
            which is known yet — see the note in `announce.ts`. */}
        {session.venue?.priceNote ? (
          <span className="where">{session.venue.priceNote}</span>
        ) : null}
      </section>

      {session.venue?.mapUrl ? (
        <Button variant="text" onClick={() => platform.openExternal(session.venue!.mapUrl!)}>
          <Icon name="place" size={18} slot="icon" />
          {m.session.openMap}
        </Button>
      ) : null}

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {session.status === 'cancelled' ? (
        <div className="error-banner">{m.session.wasCancelled}</div>
      ) : registrationOpen ? (
        <>
          <Button
            variant={me ? 'outlined' : 'filled'}
            onClick={toggleRegistration}
            disabled={busy}
          >
            {busy
              ? m.app.working
              : me
                ? me.status === 'waitlist'
                  ? m.session.leaveWaitlist
                  : m.session.cantMakeIt
                : m.session.imIn}
          </Button>
          {/* Only once you are in. Bringing friends to a session you are not
              playing in is not a thing, and the cap check needs a spot to
              measure against. */}
          {me ? (
            <GuestPicker
              sessionId={session.id}
              guests={me.guests}
              onChanged={onChanged}
            />
          ) : null}
        </>
      ) : (
        <div className="muted" style={{ textAlign: 'center' }}>
          {m.session.registrationClosed}
        </div>
      )}

      <div className="card">
        <div className="row between">
          <h2 className="card-title">
            {m.session.playing(counts.in, session.maxPlayers)}
            {counts.guests > 0 ? (
              <span className="muted" style={{ fontSize: '0.8rem', marginLeft: 6 }}>
                {m.session.guestChip(counts.guests)}
              </span>
            ) : null}
          </h2>
          <ConnectionDot state={connection} />
        </div>

        {/* Said once, above the list, rather than as a hint on every row. */}
        {showAttendance && playing.length > 0 ? (
          <div className="attend-note">
            <div className="row between" style={{ gap: 8 }}>
              <strong>{m.session.attendanceTitle}</strong>
              <span className={checked ? 'badge paid' : 'badge waitlist'}>
                {checked ? m.session.attendanceCount(arrived) : m.session.attendanceUnchecked}
              </span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {m.session.attendanceBody}
            </p>
          </div>
        ) : null}

        {playing.length === 0 ? (
          <p className="empty">{m.session.nobodyYet}</p>
        ) : (
          <div>
            {playing.map((registration, index) => (
              <div
                key={registration.memberId}
                className={[
                  'player-row',
                  'wrap',
                  registration.memberId === identity.memberId ? 'is-me' : '',
                  recentlyChanged.has(registration.memberId) ? 'flash' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span className="player-index">{index + 1}</span>
                <Avatar
                  memberId={registration.memberId}
                  name={registration.memberName}
                  avatarUpdatedAt={registration.memberAvatarUpdatedAt}
                  size={32}
                />
                {/* The name is the way through to a streak, so it is the
                    control rather than the row — a whole-row tap would fight
                    the list's own scrolling on a phone. */}
                <button
                  type="button"
                  className="player-name truncate link"
                  onClick={() => navigate({ name: 'profile', id: registration.memberId })}
                >
                  {registration.memberName}
                </button>
                {registration.guests > 0 ? (
                  <span className="badge waitlist">{m.session.guestChip(registration.guests)}</span>
                ) : null}
                {registration.memberId === identity.memberId ? (
                  <span className="badge paid">{m.session.you}</span>
                ) : null}
                {/* Their recent form, at the end of the name. */}
                <FormSquares recent={formFor(registration.memberId)} />

                {/*
                  The post-match controls go on their own line.
                  
                  A name, eight squares, a goal count and an attendance toggle
                  do not fit across a phone: measured at 414px the name was
                  being truncated to two characters. Wrapping costs a line on
                  the one screen where the row has anything to do, and keeps
                  the name — the thing the row is actually about — readable.
                */}
                {showAttendance ? (
                  <div
                    className="row wrap"
                    style={{ width: '100%', gap: 6, justifyContent: 'flex-end' }}
                  >
                    <GoalsButton
                      sessionId={session.id}
                      registration={registration}
                      canRecordOthers={identity.isOrganizer}
                      onChanged={onChanged}
                    />
                    <AttendanceToggle
                      sessionId={session.id}
                      registration={registration}
                      canMarkOthers={identity.isOrganizer}
                      onChanged={onChanged}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {waiting.length > 0 ? (
          <>
            <h3 className="card-sub" style={{ fontWeight: 600 }}>
              {m.session.waitlistHeading(counts.waitlist)}
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
                  <Avatar
                    memberId={registration.memberId}
                    name={registration.memberName}
                    avatarUpdatedAt={registration.memberAvatarUpdatedAt}
                    size={32}
                  />
                  <button
                    type="button"
                    className="player-name truncate link"
                    onClick={() => navigate({ name: 'profile', id: registration.memberId })}
                  >
                    {registration.memberName}
                  </button>
                  <span className="badge waitlist">{m.session.waiting}</span>
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

      <CopyButton label={m.session.copyList} text={summary} />

      {/* The list is for "here is who is coming"; this is for "come". Only
          worth offering while there is still a game to talk anyone into. */}
      {session.status === 'scheduled' ? <AnnounceButton detail={detail} /> : null}

      {(session.status === 'completed' || session.totalCharge != null) ? (
        <Button variant="outlined" onClick={() => navigate({ name: 'payments', id: session.id })}>
          <Icon name="money" size={18} slot="icon" />
          {session.totalCharge == null ? m.session.splitTheBill : m.nav.payments}
        </Button>
      ) : null}

      {identity.isOrganizer && session.status !== 'cancelled' ? (
        <div className="row" style={{ gap: 8 }}>
          <div className="grow">
            <Button variant="tonal" onClick={() => setEditing(true)}>
              <Icon name="edit" size={18} slot="icon" />
              {m.session.edit}
            </Button>
          </div>
          <Button variant="text" onClick={() => setConfirmCancel(true)}>
            {m.session.cancelSession}
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
        headline={m.session.confirmCancelTitle}
        actions={
          <>
            <Button variant="text" onClick={() => setConfirmCancel(false)}>
              {m.session.keepIt}
            </Button>
            <Button variant="filled" onClick={doCancel} disabled={busy}>
              {m.session.cancelSession}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{m.session.confirmCancelBody}</p>
      </Dialog>
    </>
  );
}

/** Quiet indicator so people can tell "live" from "might be a bit behind". */
function ConnectionDot({ state }: { state: ConnectionState }) {
  const m = useMessages();
  const label =
    state === 'live'
      ? m.connection.live
      : state === 'polling'
        ? m.connection.polling
        : state === 'connecting'
          ? m.connection.connecting
          : m.connection.idle;

  return (
    <span className={`conn ${state}`} title={label}>
      <span className="dot" />
      {label}
    </span>
  );
}
