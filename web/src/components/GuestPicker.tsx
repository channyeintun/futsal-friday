import { useState } from 'react';
import { setSessionGuests } from '../api/sessions.js';
import { useLocale } from '../state/locale.js';
import { Icon } from './Icon.js';
import { Button, Dialog, ErrorBanner } from './ui.js';

/** A party larger than this is a different booking, not a couple of mates. */
const MAX_GUESTS = 5;

/**
 * "Bringing anyone?" — how a member signs their friends in.
 *
 * Guests are a *number*, not people: they have no account, no name in the app
 * and no history. The member who brought them holds their spots and pays their
 * share, which is the only relationship the app needs to model. Asking for
 * names would imply a record that nobody is going to keep accurate for
 * somebody who turns up twice a year.
 */
export function GuestPicker({
  sessionId,
  guests,
  onChanged,
}: {
  sessionId: string;
  guests: number;
  onChanged(): void;
}) {
  const { m } = useLocale();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(guests);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setChoice(guests);
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    if (choice === guests) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setSessionGuests(sessionId, choice);
      setOpen(false);
      onChanged();
    } catch (cause) {
      // The cap is the usual reason, and the server says how much room is left.
      setError(cause instanceof Error ? cause.message : m.session.guestsFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="text" onClick={start}>
        <Icon name="person" size={16} slot="icon" />
        {guests > 0 ? m.session.bringingGuests(guests) : m.session.guestsTitle}
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        headline={m.session.guestsTitle}
        actions={
          <>
            <Button variant="text" onClick={() => setOpen(false)}>
              {m.app.cancel}
            </Button>
            <Button onClick={save} disabled={busy}>
              {busy ? m.app.working : m.session.guestsSave}
            </Button>
          </>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          {m.session.guestsBody}
        </p>
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        {/* Buttons rather than a numeric field: the range is tiny, and a
            phone keyboard for a number between 0 and 5 is a nuisance. */}
        <div className="guest-choices">
          {Array.from({ length: MAX_GUESTS + 1 }, (_, count) => (
            <button
              key={count}
              type="button"
              className={`guest-choice${count === choice ? ' is-chosen' : ''}`}
              onClick={() => setChoice(count)}
              aria-pressed={count === choice}
            >
              {count === 0 ? '—' : `+${count}`}
            </button>
          ))}
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {choice === 0 ? m.session.guestsNone : m.session.guestsCount(choice)}
        </p>
      </Dialog>
    </>
  );
}
