import { type Member, type Venue, nextFridayKickoff, toDatetimeLocal, fromDatetimeLocal } from '@futsal/shared';
import { useState } from 'react';
import { createMember, listMembers, removeMember, updateMember } from '../api/members.js';
import { createSession } from '../api/sessions.js';
import { createVenue, listVenues, retireVenue, updateVenue } from '../api/venues.js';
import { Icon } from '../components/Icon.js';
import { ReminderSettings } from '../components/ReminderSettings.js';
import { Button, Dialog, ErrorBanner, Spinner, Switch, TextField } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { navigate } from '../router.js';
import { useApp } from '../state/app.js';
import { useLocale, useMessages } from '../state/locale.js';
import { LOCALES, LOCALE_LABELS } from '@futsal/shared';

/** Organizer tools: the roster, the venue list, and a manual session escape hatch. */
export function AdminPage() {
  const { identity, signOut } = useApp();
  const m = useMessages();

  const members = useAsync((signal) => listMembers(signal), []);
  const venues = useAsync((signal) => listVenues(true, signal), []);

  if (!identity.isOrganizer) {
    return (
      <>
        {/* Reminders are everyone's setting, not an organizer tool. */}
        <LanguageCard />
        <ReminderSettings />
        <div className="card">
          <h2 className="card-title">{m.admin.signedInAs(identity.name)}</h2>
          <p className="card-sub">{m.admin.organizersOnly}</p>
        </div>
        <Button variant="outlined" onClick={signOut}>
          <Icon name="logout" size={18} slot="icon" />
          {m.admin.signOut}
        </Button>
      </>
    );
  }

  return (
    <>
      <LanguageCard />
      <ReminderSettings />
      <MembersCard state={members} />
      <VenuesCard state={venues} />
      <ManualSessionCard />

      <Button variant="outlined" onClick={signOut}>
        <Icon name="logout" size={18} slot="icon" />
        {m.admin.signOutAs(identity.name)}
      </Button>
    </>
  );
}

/* ---------------------------------------------------------------- members */

function MembersCard({ state }: { state: ReturnType<typeof useAsync<Member[]>> }) {
  const { toast, refresh } = useApp();
  const m = useMessages();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createMember({ name: name.trim(), isOrganizer: false });
      toast(m.toast.memberAdded(name.trim()));
      setName('');
      setAdding(false);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.admin.couldNotAdd);
    } finally {
      setBusy(false);
    }
  };

  const toggleOrganizer = async (member: Member) => {
    try {
      await updateMember(member.id, { isOrganizer: !member.isOrganizer });
      state.reload();
      // The caller may have just changed their own role.
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.admin.couldNotChange);
    }
  };

  const remove = async (member: Member) => {
    try {
      await removeMember(member.id);
      toast(m.toast.memberRemoved(member.name));
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.admin.couldNotRemove);
    }
  };

  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">{m.admin.players(state.data?.length ?? 0)}</h2>
        <Button variant="text" onClick={() => setAdding(true)}>
          <Icon name="add" size={18} slot="icon" />
          {m.app.add}
        </Button>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {state.loading && !state.data ? <Spinner /> : null}

      {(state.data ?? []).map((member) => (
        <div key={member.id} className="player-row">
          <Icon name="person" size={18} />
          <span className="player-name truncate">{member.name}</span>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            {m.app.organizerSuffix}
          </span>
          <Switch selected={member.isOrganizer} onChange={() => toggleOrganizer(member)} />
          <Button variant="text" onClick={() => remove(member)}>
            <Icon name="close" size={16} />
          </Button>
        </div>
      ))}

      <p className="muted" style={{ margin: 0 }}>
        {m.admin.removeNote}
      </p>

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        headline={m.admin.addPlayer}
        actions={
          <>
            <Button variant="text" onClick={() => setAdding(false)}>
              {m.app.cancel}
            </Button>
            <Button onClick={add} disabled={busy || !name.trim()}>
              {m.app.add}
            </Button>
          </>
        }
      >
        <TextField label={m.admin.name} value={name} onChange={setName} autoFocus />
      </Dialog>
    </div>
  );
}

/* ----------------------------------------------------------------- venues */

function VenuesCard({ state }: { state: ReturnType<typeof useAsync<Venue[]>> }) {
  const { toast } = useApp();
  const m = useMessages();
  const [editing, setEditing] = useState<Venue | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [mapUrl, setMapUrl] = useState('');
  const [priceNote, setPriceNote] = useState('');
  const [busy, setBusy] = useState(false);

  const openEditor = (venue: Venue | 'new') => {
    setEditing(venue);
    setError(null);
    setName(venue === 'new' ? '' : venue.name);
    setAddress(venue === 'new' ? '' : (venue.address ?? ''));
    setMapUrl(venue === 'new' ? '' : (venue.mapUrl ?? ''));
    setPriceNote(venue === 'new' ? '' : (venue.priceNote ?? ''));
  };

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const input = {
      name: name.trim(),
      address: address.trim() || null,
      mapUrl: mapUrl.trim() || null,
      priceNote: priceNote.trim() || null,
    };
    try {
      if (editing === 'new') await createVenue(input);
      else if (editing) await updateVenue(editing.id, input);
      toast(m.toast.venueSaved);
      setEditing(null);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.admin.couldNotSaveVenue);
    } finally {
      setBusy(false);
    }
  };

  const retire = async (venue: Venue) => {
    try {
      await retireVenue(venue.id);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.admin.couldNotRetireVenue);
    }
  };

  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">{m.admin.venues}</h2>
        <Button variant="text" onClick={() => openEditor('new')}>
          <Icon name="add" size={18} slot="icon" />
          {m.app.add}
        </Button>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {(state.data ?? []).map((venue) => (
        <div key={venue.id} className="player-row">
          <Icon name="place" size={18} />
          <span className="grow" style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 500 }} className="truncate">
              {venue.name}
              {!venue.active ? ` ${m.admin.retired}` : ''}
            </span>
            <span className="muted truncate" style={{ display: 'block' }}>
              {venue.address ?? '—'}
              {venue.priceNote ? ` · ${venue.priceNote}` : ''}
            </span>
          </span>
          <Button variant="text" onClick={() => openEditor(venue)}>
            <Icon name="edit" size={16} />
          </Button>
          {venue.active ? (
            <Button variant="text" onClick={() => retire(venue)}>
              <Icon name="close" size={16} />
            </Button>
          ) : null}
        </div>
      ))}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        headline={editing === 'new' ? m.admin.newVenue : m.admin.editVenue}
        actions={
          <>
            <Button variant="text" onClick={() => setEditing(null)}>
              {m.app.cancel}
            </Button>
            <Button onClick={save} disabled={busy || !name.trim()}>
              {m.app.save}
            </Button>
          </>
        }
      >
        <TextField label={m.admin.name} value={name} onChange={setName} autoFocus />
        <TextField label={m.admin.address} value={address} onChange={setAddress} />
        <TextField label={m.admin.mapLink} value={mapUrl} onChange={setMapUrl} type="url" />
        <TextField
          label={m.admin.priceNote}
          value={priceNote}
          onChange={setPriceNote}
          supportingText={m.admin.priceNoteHint}
        />
      </Dialog>
    </div>
  );
}

/* --------------------------------------------------------------- language */

/** Available to everyone, not just organizers — it is a personal preference. */
function LanguageCard() {
  const { m, locale, setLocale } = useLocale();

  return (
    <div className="card">
      <h2 className="card-title">{m.admin.language}</h2>
      <p className="card-sub">{m.admin.languageBody}</p>
      <div className="row" style={{ gap: 8 }}>
        {LOCALES.map((code) => (
          <div key={code} className="grow">
            <Button
              variant={code === locale ? 'filled' : 'outlined'}
              onClick={() => setLocale(code)}
            >
              {LOCALE_LABELS[code]}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------- manual session */

/**
 * The cron creates the upcoming Friday automatically. This exists for the
 * exceptions: a midweek game, or a fixture the organizer wants early.
 */
function ManualSessionCard() {
  const { toast } = useApp();
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const [startsAt, setStartsAt] = useState(() => toDatetimeLocal(nextFridayKickoff()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await createSession({ startsAt: fromDatetimeLocal(startsAt).toISOString() });
      toast(m.toast.sessionCreated);
      setOpen(false);
      navigate({ name: 'session', id: result.session.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.admin.couldNotCreateSession);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 className="card-title">{m.admin.extraSession}</h2>
      <p className="card-sub">{m.admin.extraSessionBody}</p>
      <Button variant="outlined" onClick={() => setOpen(true)}>
        <Icon name="add" size={18} slot="icon" />
        {m.admin.createSession}
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        headline={m.admin.newSession}
        actions={
          <>
            <Button variant="text" onClick={() => setOpen(false)}>
              {m.app.cancel}
            </Button>
            <Button onClick={create} disabled={busy}>
              {m.app.create}
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
        <p className="muted" style={{ margin: 0 }}>
          {m.admin.newSessionHint}
        </p>
      </Dialog>
    </div>
  );
}
