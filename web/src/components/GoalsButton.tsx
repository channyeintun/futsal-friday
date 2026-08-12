import { type Registration, didAttend } from '@futsal/shared';
import { useState } from 'react';
import { recordGoals } from '../api/sessions.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Button, Dialog, ErrorBanner } from './ui.js';

/** Nobody is scoring more than this in a friendly, and a bigger number is a typo. */
const MAX_GOALS = 12;

/**
 * "How many did you get?" — one row's worth of goals.
 *
 * Self-reported, like attendance, and for the same reason: nobody is keeping
 * score for fifteen people on a phone. An organizer can correct anybody,
 * because the person who claims six is not the person who will fix it.
 *
 * Shown only once the game has kicked off, and only to whoever may change it —
 * but the *number* is visible to everyone, because a goal tally that only its
 * owner can see is not much of a brag.
 */
export function GoalsButton({
  sessionId,
  registration,
  canRecordOthers,
  onChanged,
}: {
  sessionId: string;
  registration: Registration;
  canRecordOthers: boolean;
  onChanged(): void;
}) {
  const { identity, toast } = useApp();
  const { m } = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMe = registration.memberId === identity.memberId;
  const mayRecord = isMe || canRecordOthers;
  const goals = registration.goals ?? 0;

  // A no-show did not score. Offering the control there invites a number that
  // then has to be explained.
  if (!didAttend(registration)) return null;

  if (!mayRecord) {
    return goals > 0 ? <span className="badge paid">{m.goals.mine(goals)}</span> : null;
  }

  const save = async (next: number) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await recordGoals(sessionId, { memberId: isMe ? undefined : registration.memberId, goals: next });
      setOpen(false);
      onChanged();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : m.goals.failed;
      setError(message);
      toast(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`attend-toggle${goals > 0 ? '' : ' is-unmarked'}`}
        onClick={() => setOpen(true)}
        disabled={busy}
        aria-label={m.goals.title}
      >
        <span>⚽ {goals}</span>
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        headline={m.goals.title}
        actions={
          <Button variant="text" onClick={() => setOpen(false)}>
            {m.app.close}
          </Button>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          {m.goals.body}
        </p>
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        <div className="guest-choices">
          {Array.from({ length: MAX_GOALS + 1 }, (_, count) => (
            <button
              key={count}
              type="button"
              className={`guest-choice${count === goals ? ' is-chosen' : ''}`}
              aria-pressed={count === goals}
              onClick={() => void save(count)}
            >
              {count === 0 ? '—' : count}
            </button>
          ))}
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {goals === 0 ? m.goals.none : m.goals.mine(goals)}
        </p>
      </Dialog>
    </>
  );
}
