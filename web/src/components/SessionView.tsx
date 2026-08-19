import {
  type SessionDetail,
  attendanceChecked,
  formatKickoff,
  formatVnd,
  registrationSummary,
  relativeToNow,
  teamBoardLive,
  totalArrivedHeads,
} from '@futsal/shared';
import { useState } from 'react';
import type { ConnectionState } from '../api/realtime.js';
import { cancelSession } from '../api/sessions.js';
import { platform } from '../platform/index.js';
import { navigate } from '../router.js';
import { useApp } from '../state/app.js';
import { useLocale, useMessages } from '../state/locale.js';
import { useRecentForm } from '../hooks/queries.js';
import { useExpandPin } from '../hooks/useExpandPin.js';
import { AnnounceButton } from './AnnounceButton.js';
import { AttendanceToggle } from './AttendanceToggle.js';
import { FormSquares } from './FormSquares.js';
import { GoalsButton } from './GoalsButton.js';
import { Avatar } from './Avatar.js';
import { CopyButton } from './CopyButton.js';
import { Icon } from './Icon.js';
import { Pitch } from './Pitch.js';
import { ExpandHandle } from './ExpandHandle.js';
import { SessionEditor } from './SessionEditor.js';
import { TeamBoards } from './TeamBoards.js';
import { MvpVote } from './MvpVote.js';
import { TrashTalk } from './TrashTalk.js';
import { VirtualList } from './VirtualList.js';
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
  const { session, registrations, counts, registrationOpen } = detail;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [rosterExpanded, setRosterExpanded] = useState(false);
  const rosterRef = useExpandPin<HTMLDivElement>(rosterExpanded);

  const playing = registrations.filter((r) => r.status === 'in');
  const waiting = registrations.filter((r) => r.status === 'waitlist');
  // Worth offering only when there is something below the fold. Kept on while
  // expanded regardless, so a roster that shrinks under it — somebody drops
  // out — cannot strand the screen in the tall state.
  const canExpandRoster = playing.length > 5 || rosterExpanded;

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
  // The board is open for the whole life of the fixture, unlike the attendance
  // controls above it. Those ask a question that has no answer until the game
  // has been played; the teams are a thing the group argues about all week.
  //
  // It stops being a control two hours after kickoff and becomes a record —
  // see `teamBoardLive`. A finished session keeps the board only if there is
  // one to keep, and a cancelled one never shows it: teams for a game that did
  // not happen are not a record of anything.
  const teamsLive = teamBoardLive(session);
  const showTeams = session.status !== 'cancelled' && (teamsLive || detail.teams !== null);
  const arrived = totalArrivedHeads(registrations);
  const checked = attendanceChecked(registrations);

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

  const summary = registrationSummary(detail, { appUrl: platform.appUrl, locale, hour12 });

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
        /* The pitch replaces the button and, above the roster, answers "who is
           coming?" faster than the list can — you count the gaps. It is only
           here while there is something to sign up to: the server refuses both
           joining and leaving once the whistle has gone, so after kickoff the
           list below is the screen, which is also when it grows attendance
           toggles and goal counts and has work to do. */
        <Pitch detail={detail} recentlyChanged={recentlyChanged} onChanged={onChanged} />
      ) : (
        <div className="muted" style={{ textAlign: 'center' }}>
          {m.session.registrationClosed}
        </div>
      )}

      <div
        ref={rosterRef}
        className={`card list-card${rosterExpanded ? ' is-expanded' : ''}`}
      >
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

        {/*
          Windowed, not paged.

          The roster arrives whole with the session and has to stay whole: the
          team draw deals from `arrivedSlots(registrations)` and the settle
          screen counts heads from the same array, so handing either a page
          would quietly draw teams from a subset. What was actually too long
          was the *card* — twenty wrapped rows with attendance controls push
          everything under them off the screen — so this caps the height and
          renders a window, and the cap lifts on the grab bar below.
        */}
        <VirtualList
          items={playing}
          // A plain row is about 56px; one carrying goals and an attendance
          // toggle wraps to a second line. Rows re-measure, so this only has
          // to be close enough to stop the first paint jumping.
          estimateSize={showAttendance ? 104 : 58}
          itemKey={(registration) => registration.memberId}
          empty={<p className="empty">{m.session.nobodyYet}</p>}
          renderItem={(registration, index) => (
              <div
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
          )}
        />

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

        {/* Below the waitlist, so it is the last thing in the card — the same
            place it sits on the history lists. Offered only when the roster is
            long enough that there is something under the fold to reveal. */}
        {canExpandRoster ? (
          <ExpandHandle
            expanded={rosterExpanded}
            onToggle={() => setRosterExpanded((open) => !open)}
          />
        ) : null}
      </div>

      {/* Directly under the roster: the list of who is here is what the board
          is dealt from, and picking sides is the next thing that happens. */}
      {showTeams ? (
        <TeamBoards
          detail={detail}
          live={teamsLive}
          kickedOff={kickedOff}
          onChanged={onChanged}
        />
      ) : null}

      {/* Only once there is a game to judge. Asking who played best before
          anybody has played is the same mistake as asking who turned up. */}
      {showAttendance ? <MvpVote sessionId={session.id} /> : null}

      {/* Under the teams, because most of what gets said is about them. Open
          on any session that still exists — the winding up starts days before
          and the gloating runs for a week after. */}
      {session.status !== 'cancelled' ? (
        <TrashTalk sessionId={session.id} canPost />
      ) : null}

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
