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

/** Organizer tools: the roster, the venue list, and a manual session escape hatch. */
export function AdminPage() {
  const { identity, signOut } = useApp();

  const members = useAsync((signal) => listMembers(signal), []);
  const venues = useAsync((signal) => listVenues(true, signal), []);

  if (!identity.isOrganizer) {
    return (
      <>
        {/* Reminders are everyone's setting, not an organizer tool. */}
        <ReminderSettings />
        <div className="card">
          <h2 className="card-title">Signed in as {identity.name}</h2>
          <p className="card-sub">Only organizers can edit the roster and venues.</p>
        </div>
        <Button variant="outlined" onClick={signOut}>
          <Icon name="logout" size={18} slot="icon" />
          Sign out
        </Button>
      </>
    );
  }

  return (
    <>
      <ReminderSettings />
      <MembersCard state={members} />
      <VenuesCard state={venues} />
      <ManualSessionCard />

      <Button variant="outlined" onClick={signOut}>
        <Icon name="logout" size={18} slot="icon" />
        Sign out ({identity.name})
      </Button>
    </>
  );
}

/* ---------------------------------------------------------------- members */

function MembersCard({ state }: { state: ReturnType<typeof useAsync<Member[]>> }) {
  const { toast, refresh } = useApp();
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
      toast(`${name.trim()} added`);
      setName('');
      setAdding(false);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add that person');
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
      setError(cause instanceof Error ? cause.message : 'Could not change that');
    }
  };

  const remove = async (member: Member) => {
    try {
      await removeMember(member.id);
      toast(`${member.name} removed`);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove that person');
    }
  };

  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">Players ({state.data?.length ?? 0})</h2>
        <Button variant="text" onClick={() => setAdding(true)}>
          <Icon name="add" size={18} slot="icon" />
          Add
        </Button>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {state.loading && !state.data ? <Spinner /> : null}

      {(state.data ?? []).map((member) => (
        <div key={member.id} className="player-row">
          <Icon name="person" size={18} />
          <span className="player-name truncate">{member.name}</span>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            organizer
          </span>
          <Switch selected={member.isOrganizer} onChange={() => toggleOrganizer(member)} />
          <Button variant="text" onClick={() => remove(member)}>
            <Icon name="close" size={16} />
          </Button>
        </div>
      ))}

      <p className="muted" style={{ margin: 0 }}>
        Removing someone keeps their past sessions and payments — they just stop appearing on the
        sign-in list.
      </p>

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        headline="Add a player"
        actions={
          <>
            <Button variant="text" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button onClick={add} disabled={busy || !name.trim()}>
              Add
            </Button>
          </>
        }
      >
        <TextField label="Name" value={name} onChange={setName} autoFocus />
      </Dialog>
    </div>
  );
}

/* ----------------------------------------------------------------- venues */

function VenuesCard({ state }: { state: ReturnType<typeof useAsync<Venue[]>> }) {
  const { toast } = useApp();
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
      toast('Venue saved');
      setEditing(null);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that venue');
    } finally {
      setBusy(false);
    }
  };

  const retire = async (venue: Venue) => {
    try {
      await retireVenue(venue.id);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not retire that venue');
    }
  };

  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">Venues</h2>
        <Button variant="text" onClick={() => openEditor('new')}>
          <Icon name="add" size={18} slot="icon" />
          Add
        </Button>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {(state.data ?? []).map((venue) => (
        <div key={venue.id} className="player-row">
          <Icon name="place" size={18} />
          <span className="grow" style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 500 }} className="truncate">
              {venue.name}
              {!venue.active ? ' (retired)' : ''}
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
        headline={editing === 'new' ? 'New venue' : 'Edit venue'}
        actions={
          <>
            <Button variant="text" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || !name.trim()}>
              Save
            </Button>
          </>
        }
      >
        <TextField label="Name" value={name} onChange={setName} autoFocus />
        <TextField label="Address" value={address} onChange={setAddress} />
        <TextField label="Map link" value={mapUrl} onChange={setMapUrl} type="url" />
        <TextField
          label="Price note"
          value={priceNote}
          onChange={setPriceNote}
          supportingText="e.g. 600.000d/hour"
        />
      </Dialog>
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
  const [open, setOpen] = useState(false);
  const [startsAt, setStartsAt] = useState(() => toDatetimeLocal(nextFridayKickoff()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await createSession({ startsAt: fromDatetimeLocal(startsAt).toISOString() });
      toast('Session created');
      setOpen(false);
      navigate({ name: 'session', id: result.session.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create that session');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 className="card-title">Extra session</h2>
      <p className="card-sub">
        The next Friday at 19:30 is created automatically every week. Use this for a one-off.
      </p>
      <Button variant="outlined" onClick={() => setOpen(true)}>
        <Icon name="add" size={18} slot="icon" />
        Create a session
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        headline="New session"
        actions={
          <>
            <Button variant="text" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={busy}>
              Create
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
        <p className="muted" style={{ margin: 0 }}>
          Venue, fee and cap can be set once it exists.
        </p>
      </Dialog>
    </div>
  );
}
