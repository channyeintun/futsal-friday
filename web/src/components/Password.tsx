import { type Identity, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@futsal/shared';
import { type FormEvent, useRef, useState } from 'react';
import { changePassword, signInWithPassword } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { navigate } from '../router.js';
import { useApp } from '../state/app.js';
import { useLocale, useMessages } from '../state/locale.js';
import { Button, ErrorBanner, TextField } from './ui.js';

/**
 * Name and password, on the signed-out screen.
 *
 * Links stayed the only way in until the week most of the group's tokens ran
 * out together, the organizer's among them, and nobody was left to send one.
 * Until somebody chooses their own password the group's shared one works,
 * which is why the body says where to find it.
 *
 * A typed name rather than a list to pick from: this screen is public, and a
 * list would hand the roster to anybody who opened the address.
 */
export function PasswordSignIn({ onSignedIn }: { onSignedIn(identity: Identity): void }) {
  const m = useMessages();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `busy` is state, so two Enters in a row both read it as false; this is not.
  const inFlight = useRef(false);

  const submit = async () => {
    if (inFlight.current || !name.trim() || !password) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await signInWithPassword(name.trim(), password));
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 401
          ? m.password.wrong
          : cause instanceof Error
            ? cause.message
            : m.password.failed,
      );
      setBusy(false);
    } finally {
      inFlight.current = false;
    }
  };

  return (
    // A form for password managers, which look for one. It never submits:
    // Enter is handled per field, and the button calls `submit` itself.
    <form className="card" onSubmit={preventSubmit}>
      <h2 className="card-title">{m.password.signInTitle}</h2>
      <p className="card-sub">{m.password.signInBody}</p>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <TextField
        label={m.password.name}
        value={name}
        autoComplete="username"
        onEnter={() => void submit()}
        onChange={(value) => {
          setName(value);
          setError(null);
        }}
      />
      <TextField
        label={m.password.password}
        type="password"
        value={password}
        autoComplete="current-password"
        onEnter={() => void submit()}
        onChange={(value) => {
          setPassword(value);
          setError(null);
        }}
      />
      <Button onClick={() => void submit()} disabled={busy || !name.trim() || !password}>
        {busy ? m.password.signingIn : m.password.signIn}
      </Button>
    </form>
  );
}

/**
 * Choose a password, or change it, on Setup.
 *
 * The first time there is no "current password" field: they are signed in,
 * which already proves who they are, and they may have come in by a link and
 * never known the shared one. After that it is asked for, so a phone left
 * unlocked on the bench cannot be used to lock its owner out.
 */
export function PasswordCard() {
  const { identity, adopt, toast } = useApp();
  const m = useMessages();
  // Strictly false: an identity from an API that predates passwords has no
  // field at all, and it should not be told to choose one it cannot save.
  const choosing = identity.hasPassword === false;

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const ready = (choosing || current !== '') && next !== '' && again !== '';

  const submit = async () => {
    if (inFlight.current || !ready) return;
    const length = [...next].length;
    if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
      setError(m.password.tooShort(PASSWORD_MIN_LENGTH));
      return;
    }
    if (next !== again) {
      setError(m.password.mismatch);
      return;
    }

    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // The fresh token is installed before this resolves. The identity it
      // answers with is what turns the nudge off — used as is, because a second
      // round trip to read it back could fail and leave the card asking them
      // to choose a password they already have.
      adopt(await changePassword(current, next));
      setCurrent('');
      setNext('');
      setAgain('');
      toast(m.password.saved);
    } catch (cause) {
      setError(describeChangeError(cause, m));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const clear = (set: (value: string) => void) => (value: string) => {
    set(value);
    setError(null);
  };

  return (
    <form className="card" onSubmit={preventSubmit}>
      <h2 className="card-title">{choosing ? m.password.setTitle : m.password.changeTitle}</h2>
      <p className="card-sub">{choosing ? m.password.setBody : m.password.changeBody}</p>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {/* Password managers want the username beside the password they save. */}
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={identity.name}
        readOnly
        hidden
      />
      {choosing ? null : (
        <TextField
          label={m.password.current}
          type="password"
          value={current}
          autoComplete="current-password"
          onEnter={() => void submit()}
          onChange={clear(setCurrent)}
        />
      )}
      <TextField
        label={m.password.new}
        type="password"
        value={next}
        autoComplete="new-password"
        supportingText={m.password.tooShort(PASSWORD_MIN_LENGTH)}
        onEnter={() => void submit()}
        onChange={clear(setNext)}
      />
      <TextField
        label={m.password.confirm}
        type="password"
        value={again}
        autoComplete="new-password"
        onEnter={() => void submit()}
        onChange={clear(setAgain)}
      />
      <Button onClick={() => void submit()} disabled={busy || !ready}>
        {busy ? m.app.saving : m.password.save}
      </Button>
    </form>
  );
}

function preventSubmit(event: FormEvent) {
  event.preventDefault();
}

function describeChangeError(cause: unknown, m: ReturnType<typeof useMessages>): string {
  if (cause instanceof ApiError) {
    if (cause.status === 403) return m.password.wrongCurrent;
    if (cause.code === 'password_is_default') return m.password.isDefault;
    if (cause.code === 'password_length') return m.password.tooShort(PASSWORD_MIN_LENGTH);
  }
  return cause instanceof Error ? cause.message : m.password.couldNotSave;
}

/**
 * Home, for as long as they are still on the shared password.
 *
 * Not dismissible. Anybody in the chat can be them until they do this, and it
 * takes less time than closing the card would have.
 */
export function PasswordNudge() {
  const { identity } = useApp();
  const { m } = useLocale();
  if (identity.hasPassword !== false) return null;

  return (
    <div className="card">
      <h2 className="card-title">{m.password.nudgeTitle}</h2>
      <p className="card-sub">{m.password.nudgeBody}</p>
      <Button variant="tonal" onClick={() => navigate({ name: 'admin' })}>
        {m.password.nudgeAction}
      </Button>
    </div>
  );
}
