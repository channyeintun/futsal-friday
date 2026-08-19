import {
  type Member,
  type Venue,
  formatTime,
  nextFridayKickoff,
  toDatetimeLocal,
  fromDatetimeLocal,
} from '@futsal/shared';
import { useState } from 'react';
import { createMember, removeMember, updateMember } from '../api/members.js';
import { createSession } from '../api/sessions.js';
import { createVenue, retireVenue, updateVenue } from '../api/venues.js';
import { Avatar } from '../components/Avatar.js';
import { ConfirmButton } from '../components/ConfirmButton.js';
import { Icon } from '../components/Icon.js';
import { GroupInviteCard, MemberInviteControls, MyDeviceCard } from '../components/InviteLink.js';
import { PaymentDetailsCard } from '../components/PaymentDetailsCard.js';
import { PendingApprovals } from '../components/PendingApprovals.js';
import { platform } from '../platform/index.js';
import { ReminderSettings } from '../components/ReminderSettings.js';
import { Button, Dialog, ErrorBanner, Spinner, Switch, TextField } from '../components/ui.js';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, useMembersCount, useVenues } from '../hooks/queries.js';
import { navigate } from '../router.js';
import { useApp } from '../state/app.js';
import { useLocale, useMessages } from '../state/locale.js';
import { LOCALES, LOCALE_LABELS } from '@futsal/shared';

/** Organizer tools: the roster, the venue list, and a manual session escape hatch. */
export function AdminPage() {
  const { identity, signOut } = useApp();
  const m = useMessages();

  // Retired venues are only of interest on this screen.
  const venues = useVenues(true, identity.isOrganizer);
  const queryClient = useQueryClient();

  if (!identity.isOrganizer) {
    return (
      <>
        {/* Reminders are everyone's setting, not an organizer tool. */}
        <LanguageCard />
        <ClockCard />
        <SoundCard />
        <MyDeviceCard />
        <ReminderSettings />
        <div className="card">
          <h2 className="card-title">{m.admin.signedInAs(identity.name)}</h2>
          <p className="card-sub">{m.admin.organizersOnly}</p>
        </div>
        <ConfirmButton
          variant="outlined"
          headline={m.admin.confirmSignOut}
          body={m.admin.confirmSignOutBody}
          confirmLabel={m.admin.signOut}
          onConfirm={signOut}
        >
          <Icon name="logout" size={18} slot="icon" />
          {m.admin.signOut}
        </ConfirmButton>
      </>
    );
  }

  return (
    <>
      {/* First on the screen when it has anything to show: somebody is stuck
          on a waiting screen until this gets a tap. */}
      <PendingApprovals onChanged={() => void queryClient.invalidateQueries({ queryKey: queryKeys.members })} />
      <LanguageCard />
      <ClockCard />
      <SoundCard />
      <MyDeviceCard />
      <ReminderSettings />
      {/* Above the roster: sharing one link is the normal way to onboard, and
          the per-person controls below are for the exceptions. */}
      <GroupInviteCard />
      {/* Next to the invite link: both are things the organizer sets once and
          the group then reads without asking. */}
      <PaymentDetailsCard />
      <MembersCard />
      <VenuesCard state={venues} />
      <ManualSessionCard />

      <ConfirmButton
        variant="outlined"
        headline={m.admin.confirmSignOut}
        body={m.admin.confirmSignOutBody}
        confirmLabel={m.admin.signOut}
        onConfirm={signOut}
      >
        <Icon name="logout" size={18} slot="icon" />
        {m.admin.signOutAs(identity.name)}
      </ConfirmButton>
    </>
  );
}

/* ---------------------------------------------------------------- members */

/**
 * A count and a way in — deliberately not the roster.
 *
 * Every player used to be rendered here, which pushed "add a midweek session"
 * and "sign out" below however many people are in the group: on a screen you
 * open to change a setting, you first scrolled past everybody. It also meant
 * the whole roster on the wire to print one number. The list has a page of its
 * own now.
 */
function MembersCard() {
  const { toast } = useApp();
  const m = useMessages();
  const count = useMembersCount();
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
      void count.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.admin.couldNotAdd);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">{m.admin.players(count.data ?? 0)}</h2>
        <Button variant="text" onClick={() => setAdding(true)}>
          <Icon name="add" size={18} slot="icon" />
          {m.app.add}
        </Button>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <Button variant="outlined" onClick={() => navigate({ name: 'players' })}>
        <Icon name="person" size={18} slot="icon" />
        {m.admin.managePlayers}
      </Button>

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
        <p className="muted" style={{ margin: 0 }}>
          {m.admin.addPlayerBody}
        </p>
        <TextField label={m.admin.playerName} value={name} onChange={setName} />
      </Dialog>
    </div>
  );
}

/* ----------------------------------------------------------------- venues */

function VenuesCard({ state }: { state: ReturnType<typeof useVenues> }) {
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
      void state.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.admin.couldNotSaveVenue);
    } finally {
      setBusy(false);
    }
  };

  const retire = async (venue: Venue) => {
    try {
      await retireVenue(venue.id);
      void state.refetch();
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
            <ConfirmButton
              ariaLabel={m.admin.retireVenue}
              headline={m.admin.confirmRetireVenue(venue.name)}
              body={m.admin.confirmRetireVenueBody}
              confirmLabel={m.app.remove}
              onConfirm={() => retire(venue)}
            >
              <Icon name="close" size={16} />
            </ConfirmButton>
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
      {/* Adjacent pills, not two half-width columns: a Material button keeps
          its intrinsic width, so stretching the wrapper only pushes the two
          apart and leaves a gap in the middle. */}
      <div className="row wrap" style={{ gap: 8 }}>
        {LOCALES.map((code) => (
          <Button
            key={code}
            lang={code}
            variant={code === locale ? 'filled' : 'outlined'}
            onClick={() => setLocale(code)}
          >
            {LOCALE_LABELS[code]}
          </Button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ clock format */

/** Also personal, and also follows them onto a new phone. */
function ClockCard() {
  const { m, hour12, setHour12 } = useLocale();
  // A real kickoff rather than a made-up one, so the sample reads like the
  // thing it is about to change.
  const sample = nextFridayKickoff();

  return (
    <div className="card">
      <h2 className="card-title">{m.admin.clock}</h2>
      <p className="card-sub">{m.admin.clockBody}</p>
      <div className="row wrap" style={{ gap: 8 }}>
        {([false, true] as const).map((choice) => (
          <Button
            key={String(choice)}
            variant={choice === hour12 ? 'filled' : 'outlined'}
            onClick={() => setHour12(choice)}
          >
            {formatTime(sample, choice)}
          </Button>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- sound */

/**
 * The buttons make a noise. This is the way out of it.
 *
 * Next to the language and the clock because it is the same kind of setting —
 * about this device rather than about the group — and it is stored the same
 * way, for the same reason: somebody who wants a silent phone in a meeting
 * wants that phone silent, not their laptop too.
 */
function SoundCard() {
  const m = useMessages();
  // `platform.sound.enabled()` reads a stored string, and nothing tells React
  // when it changes, so this keeps its own copy of the answer.
  const [on, setOn] = useState(platform.sound.enabled());

  // Nothing to offer where the browser cannot make a noise in the first place.
  if (!platform.sound.supported()) return null;

  return (
    <div className="card">
      <h2 className="card-title">{m.admin.sound}</h2>
      <p className="card-sub">{m.admin.soundBody}</p>
      <div className="row wrap" style={{ gap: 8 }}>
        {([true, false] as const).map((choice) => (
          <Button
            key={String(choice)}
            variant={choice === on ? 'filled' : 'outlined'}
            /* Nothing here asks for `data-sound`, and the ordering works out on
               its own: turning it off still clicks on the way down, which is
               the right last word, and turning it on is answered by
               `setEnabled` playing the clip. The guard is what stops a press
               that changes nothing from doing both. */
            onClick={() => {
              if (choice === on) return;
              platform.sound.setEnabled(choice);
              setOn(choice);
            }}
          >
            {choice ? m.admin.soundOn : m.admin.soundOff}
          </Button>
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
