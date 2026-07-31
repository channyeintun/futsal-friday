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
import { useMessages } from '../state/locale.js';
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
  const m = useMessages();
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
      if (fee.trim() && parsedFee === null) throw new Error(m.editor.feeNotANumber);

      const parsedCap = maxPlayers.trim() ? Number.parseInt(maxPlayers, 10) : null;
      if (maxPlayers.trim() && (!Number.isFinite(parsedCap) || (parsedCap ?? 0) < 1)) {
        throw new Error(m.editor.capNotANumber);
      }

      await updateSession(session.id, {
        startsAt: fromDatetimeLocal(startsAt).toISOString(),
        venueId: venueId || null,
        feePerPerson: parsedFee,
        maxPlayers: parsedCap,
        notes: notes.trim() || null,
      });
      toast(m.toast.sessionUpdated);
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.editor.couldNotSave);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      headline={m.editor.title}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {m.app.cancel}
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? m.app.saving : m.app.save}
          </Button>
        </>
      }
    >
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <TextField
        label={m.admin.kickoffLabel}
        type="datetime-local"
        value={startsAt}
        onChange={setStartsAt}
      />

      <Select
        label={m.editor.venue}
        value={venueId}
        onChange={setVenueId}
        options={[
          { value: '', label: m.editor.noVenueOption },
          ...venues.map((v) => ({ value: v.id, label: v.name })),
        ]}
      />

      <TextField
        label={m.editor.feeLabel}
        value={fee}
        onChange={setFee}
        inputMode="numeric"
        supportingText={
          fee.trim() && parseVnd(fee) !== null ? formatVnd(parseVnd(fee) ?? 0) : m.editor.feeHint
        }
      />

      <TextField
        label={m.editor.maxPlayers}
        value={maxPlayers}
        onChange={setMaxPlayers}
        inputMode="numeric"
        supportingText={m.editor.maxPlayersHint}
      />

      <TextField label={m.editor.notes} type="textarea" value={notes} onChange={setNotes} />
    </Dialog>
  );
}
