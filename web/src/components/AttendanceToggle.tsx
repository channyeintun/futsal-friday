import { type Registration, didAttend } from '@futsal/shared';
import { useState } from 'react';
import { markAttendance } from '../api/sessions.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Icon } from './Icon.js';
import { Button, Dialog, ErrorBanner } from './ui.js';

/**
 * "Did they play?" — one row's worth of attendance.
 *
 * Only rendered once kickoff has passed. Before the whistle every row would
 * carry a control nobody can answer yet, which is noise on the screen people
 * look at most.
 *
 * The button is deliberately quiet when the answer is the presumed one. A
 * roster of twelve where everybody turned up — the normal week — should look
 * like a roster, not like twelve unanswered questions; the tick only appears
 * once somebody has actually said something. That is the visible half of the
 * same decision as the nullable column: absence of a mark is not an error
 * state to be nagged about.
 */
export function AttendanceToggle({
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
  const [busy, setBusy] = useState(false);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMe = registration.memberId === identity.memberId;
  const mayMark = isMe || canMarkOthers;
  const present = didAttend(registration);
  const registeredGuests = registration.guests ?? 0;
  const guestsCame = registration.guestsArrived ?? (present ? registeredGuests : 0);

  const send = async (body: { attended?: boolean | null; guestsArrived?: number | null }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await markAttendance(sessionId, { memberId: isMe ? undefined : registration.memberId, ...body });
      onChanged();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : m.session.attendanceFailed;
      setError(message);
      toast(message);
    } finally {
      setBusy(false);
    }
  };

  if (!mayMark) {
    // Everyone can see the answer even where they cannot change it — the point
    // of marking a no-show is that the rest of the group sees why the split
    // moved.
    return registration.attended === false ? (
      <span className="badge unpaid">{m.session.didNotPlay}</span>
    ) : null;
  }

  return (
    <>
      <button
        type="button"
        className={`attend-toggle${present ? '' : ' is-absent'}${
          registration.attended == null ? ' is-unmarked' : ''
        }`}
        disabled={busy}
        onClick={() => send({ attended: !present })}
        aria-pressed={present}
        aria-label={present ? m.session.markAbsent : m.session.markPresent}
        title={present ? m.session.markAbsent : m.session.markPresent}
      >
        <Icon name={present ? 'check' : 'close'} size={16} />
        <span>{present ? m.session.played : m.session.didNotPlay}</span>
      </button>

      {/* Only worth asking when there are guests to be wrong about. */}
      {present && registeredGuests > 0 ? (
        <button
          type="button"
          className={`attend-guests${guestsCame === registeredGuests ? '' : ' is-changed'}`}
          onClick={() => setGuestsOpen(true)}
          disabled={busy}
        >
          {m.session.guestsArrivedChip(guestsCame, registeredGuests)}
        </button>
      ) : null}

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
              onClick={async () => {
                // `null` rather than the registered number when nothing
                // changed, so "as registered" stays distinguishable from
                // "somebody counted and it happened to match".
                await send({ guestsArrived: count === registeredGuests ? null : count });
                setGuestsOpen(false);
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
