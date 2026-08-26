import { type Registration, didAttend } from '@futsal/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { markAttendance } from '../api/sessions.js';
import { queryKeys } from '../hooks/queries.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Icon } from './Icon.js';
import { Button, Dialog, ErrorBanner } from './ui.js';

/**
 * "Did they play?" — one row's worth of attendance.
 *
 * The pill reports; it never writes. Its visible word is always a *state*, and
 * the only thing pressing it does is open the question — because the control
 * this replaced was a toggle whose visible label was its current state and
 * whose accessible label was the opposite action, so the only way to know what
 * a tap would do was to already know. A member read "played" as "I played",
 * tapped it, came off the bill, lost a streak, and could not find the way back.
 *
 * There is deliberately no `aria-label` and no `title`: the `<span>` is the
 * accessible name, so the two can never describe opposite things again.
 *
 * Only rendered once kickoff has passed. Before the whistle every row would
 * carry a control nobody can answer yet, which is noise on the screen people
 * look at most.
 *
 * Still quiet when the answer is the presumed one. A roster of twelve where
 * everybody turned up — the normal week — should look like a roster, not like
 * twelve unanswered questions; the tick only appears once somebody has actually
 * said something. That is the visible half of the same decision as the nullable
 * column: absence of a mark is not an error state to be nagged about.
 *
 * The organizer's bulk path is not here. It is `NoShowSheet`, above the list,
 * because a modal per person standing on a pitch is not a fix.
 */
export function AttendanceMark({
  sessionId,
  registration,
  canMarkOthers,
  onChanged,
}: {
  sessionId: string;
  registration: Registration;
  /** Organizers may answer for anybody; everyone else only for themselves. */
  canMarkOthers: boolean;
  onChanged(): void;
}) {
  const { identity, toast } = useApp();
  const { m } = useLocale();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMe = registration.memberId === identity.memberId;
  const mayMark = isMe || canMarkOthers;
  /** The tri-state, verbatim. Never collapsed through `didAttend` for display. */
  const answer: boolean | null = registration.attended ?? null;
  /** The presumption applied — only ever used for the guests question. */
  const present = didAttend(registration);
  const registeredGuests = registration.guests ?? 0;
  const guestsCame = registration.guestsArrived ?? (present ? registeredGuests : 0);

  const send = async (body: {
    attended?: boolean | null;
    guestsArrived?: number | null;
  }): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await markAttendance(sessionId, {
        memberId: isMe ? undefined : registration.memberId,
        ...body,
      });
      onChanged();
      // `onChanged` is `live.reload()`, which invalidates the session and its
      // thread and nothing else. The form squares and the streak are separate
      // queries with their own staleTime, so without these the row somebody has
      // just fixed keeps reading broken for minutes — which is exactly the
      // evidence that teaches them the fix did not take.
      void queryClient.invalidateQueries({ queryKey: queryKeys.form });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.profile(registration.memberId),
      });
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : m.session.attendanceFailed;
      setError(message);
      toast(message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const choose = async (next: boolean | null) => {
    // Re-picking the answer already on the row would rewrite
    // `attendance_marked_at` / `attendance_marked_by` for nothing.
    if (next === answer) {
      setAskOpen(false);
      return;
    }
    // A failure leaves the dialog open with its banner up: pressing a choice
    // again is the retry, and the question is still on screen to retry from.
    if (!(await send({ attended: next }))) return;
    setAskOpen(false);
    toast(m.toast.attendanceSaved);
  };

  if (!mayMark) {
    // A reader's row states only what somebody actually said. Unmarked renders
    // nothing, which is what keeps twelve rows from reading as twelve
    // questions; an explicit answer renders both ways, because after a
    // correction the group needs to be able to see that it landed.
    if (registration.status !== 'in') return null;
    if (answer === false) return <span className="badge unpaid">{m.session.didNotPlay}</span>;
    if (answer === true) return <span className="badge paid">{m.session.played}</span>;
    return null;
  }

  const stateLabel =
    answer === null ? m.session.countedIn : answer ? m.session.played : m.session.didNotPlay;

  return (
    <>
      {/* Before the answer, not after it: on a `flex-end` line the last child
          is the one that never moves, and the answer is the thing being aimed
          at. This chip disappears the moment somebody is marked absent. */}
      {present && registeredGuests > 0 ? (
        <button
          type="button"
          className={`attend-guests${guestsCame === registeredGuests ? '' : ' is-changed'}`}
          onClick={() => {
            setError(null);
            setGuestsOpen(true);
          }}
          disabled={busy}
        >
          {m.session.guestsArrivedChip(guestsCame, registeredGuests)}
        </button>
      ) : null}

      {/* The word is the state; pressing only ever opens the question. Same
          contract as the goals pill beside it. No `aria-label`, so the
          accessible name is the word you can see. */}
      <button
        type="button"
        className={`attend-toggle${answer === false ? ' is-absent' : ''}${
          answer === null ? ' is-unmarked' : ''
        }`}
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={askOpen}
        onClick={() => {
          setError(null);
          setAskOpen(true);
        }}
      >
        {answer === null ? null : <Icon name={answer ? 'check' : 'close'} size={16} />}
        <span>{stateLabel}</span>
      </button>

      <Dialog
        open={askOpen}
        onClose={() => setAskOpen(false)}
        headline={
          isMe
            ? m.session.attendanceAskSelf
            : m.session.attendanceAskOther(registration.memberName)
        }
        actions={
          <Button variant="text" onClick={() => setAskOpen(false)}>
            {m.app.close}
          </Button>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          {m.session.attendanceAskBody}
        </p>
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        <div className="guest-choices is-stacked">
          <button
            type="button"
            className={`guest-choice${answer === true ? ' is-chosen' : ''}`}
            aria-pressed={answer === true}
            disabled={busy}
            onClick={() => void choose(true)}
          >
            <Icon name="check" size={18} />
            <span>{isMe ? m.session.iWasThere : m.session.markPresent}</span>
          </button>
          <button
            type="button"
            className={`guest-choice${answer === false ? ' is-chosen' : ''}`}
            aria-pressed={answer === false}
            disabled={busy}
            // The one answer that takes something away — a share of the bill
            // and a run of games. Same clip as arming a withdrawal on the pitch.
            data-sound="tap-out"
            onClick={() => void choose(false)}
          >
            <Icon name="close" size={18} />
            <span>{isMe ? m.session.iMissedIt : m.session.markAbsent}</span>
          </button>
          <button
            type="button"
            className={`guest-choice${answer === null ? ' is-chosen' : ''}`}
            aria-pressed={answer === null}
            disabled={busy}
            onClick={() => void choose(null)}
          >
            <span className="choice-dash" aria-hidden="true">
              —
            </span>
            <span>{m.session.unmark}</span>
          </button>
        </div>
        {/* The sentence that would have ended the incident before it started:
            he did not need to touch anything. Only shown where it is true. */}
        {answer === null ? (
          <p className="muted" style={{ margin: 0 }}>
            {m.session.attendancePresumed}
          </p>
        ) : null}
      </Dialog>

      {/* Only worth asking when there are guests to be wrong about. */}
      <Dialog
        open={guestsOpen}
        onClose={() => setGuestsOpen(false)}
        headline={m.session.guestsArrivedTitle}
        actions={
          <Button variant="text" onClick={() => setGuestsOpen(false)}>
            {m.app.close}
          </Button>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          {m.session.guestsArrivedBody(registeredGuests)}
        </p>
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        <div className="guest-choices">
          {Array.from({ length: registeredGuests + 1 }, (_, count) => (
            <button
              key={count}
              type="button"
              className={`guest-choice${count === guestsCame ? ' is-chosen' : ''}`}
              aria-pressed={count === guestsCame}
              disabled={busy}
              onClick={async () => {
                // `null` rather than the registered number when nothing
                // changed, so "as registered" stays distinguishable from
                // "somebody counted and it happened to match".
                //
                // Closing only on success, so the banner above survives a
                // failure long enough to be read.
                if (await send({ guestsArrived: count === registeredGuests ? null : count })) {
                  setGuestsOpen(false);
                }
              }}
            >
              {count === 0 ? '—' : count}
            </button>
          ))}
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {guestsCame === 0
            ? m.session.guestsArrivedNone
            : m.session.guestsArrivedCount(guestsCame)}
        </p>
      </Dialog>
    </>
  );
}
