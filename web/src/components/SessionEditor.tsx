import {
  type Session,
  type Venue,
  formatVnd,
  fromDatetimeLocal,
  parseVnd,
  toDatetimeLocal,
} from '@futsal/shared';
import { useEffect, useState } from 'react';
import { updateSession } from '../api/sessions.js';
import { listVenues } from '../api/venues.js';
import { useApp } from '../state/app.js';
import { Button, Dialog, ErrorBanner, Select, TextField } from './ui.js';

/**
 * Organizer's edit sheet: time, venue, per-head estimate, cap and notes.
 *
 * Times are shown and typed in Asia/Ho_Chi_Minh — a `datetime-local` input
 * would otherwise silently use the phone's timezone, which for anyone
 * travelling would schedule the game at the wrong hour.
 */
export function SessionEditor({
  session,
  open,
  onClose,
  onSaved,
}: {
  session: Session;
  open: boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const { toast } = useApp();
  const [venues, setVenues] = useState<Venue[]>([]);
  const [startsAt, setStartsAt] = useState(() => toDatetimeLocal(session.startsAt));
  const [venueId, setVenueId] = useState(session.venueId ?? '');
  const [fee, setFee] = useState(session.feePerPerson == null ? '' : String(session.feePerPerson));
  const [maxPlayers, setMaxPlayers] = useState(
    session.maxPlayers == null ? '' : String(session.maxPlayers),
  );
  const [notes, setNotes] = useState(session.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-seed the form whenever it is reopened, so a cancelled edit does not
  // leave stale values behind.
  useEffect(() => {
    if (!open) return;
    setStartsAt(toDatetimeLocal(session.startsAt));
    setVenueId(session.venueId ?? '');
    setFee(session.feePerPerson == null ? '' : String(session.feePerPerson));
    setMaxPlayers(session.maxPlayers == null ? '' : String(session.maxPlayers));
    setNotes(session.notes ?? '');
    setError(null);
  }, [open, session]);

  useEffect(() => {
    if (!open) return;
    listVenues()
      .then(setVenues)
      .catch(() => setVenues([]));
  }, [open]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const parsedFee = fee.trim() ? parseVnd(fee) : null;
      if (fee.trim() && parsedFee === null) throw new Error('Fee should be a number, e.g. 70k');

      const parsedCap = maxPlayers.trim() ? Number.parseInt(maxPlayers, 10) : null;
      if (maxPlayers.trim() && (!Number.isFinite(parsedCap) || (parsedCap ?? 0) < 1)) {
        throw new Error('Max players should be a whole number');
      }

      await updateSession(session.id, {
        startsAt: fromDatetimeLocal(startsAt).toISOString(),
        venueId: venueId || null,
        feePerPerson: parsedFee,
        maxPlayers: parsedCap,
        notes: notes.trim() || null,
      });
      toast('Session updated');
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      headline="Edit session"
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <TextField
        label="Kickoff (Ho Chi Minh time)"
        type="datetime-local"
        value={startsAt}
        onChange={setStartsAt}
      />

      <Select
        label="Venue"
        value={venueId}
        onChange={setVenueId}
        options={[{ value: '', label: 'No venue yet' }, ...venues.map((v) => ({ value: v.id, label: v.name }))]}
      />

      <TextField
        label="Estimated fee per person"
        value={fee}
        onChange={setFee}
        inputMode="numeric"
        supportingText={
          fee.trim() && parseVnd(fee) !== null ? formatVnd(parseVnd(fee) ?? 0) : 'e.g. 70k'
        }
      />

      <TextField
        label="Max players"
        value={maxPlayers}
        onChange={setMaxPlayers}
        inputMode="numeric"
        supportingText="Leave empty for no cap. Extra players go on a waitlist."
      />

      <TextField label="Notes" type="textarea" value={notes} onChange={setNotes} />
    </Dialog>
  );
}
