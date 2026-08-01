import type { Identity, JoinableMember } from '@futsal/shared';
import { LOCALES, LOCALE_LABELS } from '@futsal/shared';
import { useEffect, useState } from 'react';
import { groupClaim, groupRoster, groupSelfAdd } from '../api/auth.js';
import { Icon } from '../components/Icon.js';
import { Button, Dialog, ErrorBanner, Spinner, TextField } from '../components/ui.js';
import { platform } from '../platform/index.js';
import { useLocale } from '../state/locale.js';

/**
 * The group join screen — the one link everyone gets.
 *
 * Only names that are still unclaimed appear, and organizers never appear at
 * all. Both rules are enforced server-side; this screen just renders what it
 * is given, so a stale page cannot be used to claim something it should not.
 */
export function JoinPage({ onSignedIn }: { onSignedIn(identity: Identity): void }) {
  const { m, locale, setLocale } = useLocale();
  const [nonce] = useState(() => platform.navigation.hash());
  const [members, setMembers] = useState<JoinableMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [ownName, setOwnName] = useState('');

  useEffect(() => {
    if (!nonce) {
      setError(m.join.expired);
      setMembers([]);
      return;
    }

    groupRoster(nonce)
      .then(setMembers)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : m.join.expired);
        setMembers([]);
      });
  }, [nonce, m]);

  const pick = async (member: JoinableMember) => {
    if (busy) return;
    setBusy(member.id);
    setError(null);
    try {
      const identity = await groupClaim(nonce, member.id);
      // Only now. Unlike a personal claim link this one is meant to be shared
      // and reused, so it has to survive a reload while the picker is still on
      // screen — but once a name is taken there is no reason to keep carrying
      // the nonce around in history.
      platform.navigation.replace('/');
      onSignedIn(identity);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.join.failed);
      setBusy(null);
      // Somebody may have taken a name while this list was on screen.
      groupRoster(nonce).then(setMembers).catch(() => {});
    }
  };

  const addSelf = async () => {
    const name = ownName.trim();
    if (!name) return;
    setBusy('self');
    setError(null);
    try {
      const identity = await groupSelfAdd(nonce, name);
      platform.navigation.replace('/');
      onSignedIn(identity);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.join.couldNotAdd);
      setBusy(null);
      // The name may be one already on the list, in which case the refreshed
      // roster is where they should be tapping.
      groupRoster(nonce).then(setMembers).catch(() => {});
    }
  };

  return (
    <div className="app">
      <div className="content" style={{ justifyContent: 'center', gap: 20 }}>
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 4 }}>
          <Icon name="ball" size={48} />
          <h1 style={{ margin: 0, fontSize: '1.6rem' }}>{m.app.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {m.join.whichOne}
          </p>
        </div>

        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        {members === null ? (
          <Spinner label={m.join.loading} />
        ) : (
          <div className="card">
            <p className="card-sub" style={{ margin: 0 }}>
              {/* An empty list means one of two very different things, and
                  saying "everyone has joined" to the first person through the
                  door is nonsense. Only a dead link produces `error`. */}
              {error
                ? m.claim.askOrganizer
                : members.length === 0
                  ? m.join.nobodyListed
                  : m.join.tapYourName}
            </p>
            <div className="stack">
              {members.map((member) => (
                <Button
                  key={member.id}
                  variant="outlined"
                  disabled={busy !== null}
                  onClick={() => pick(member)}
                >
                  {busy === member.id ? m.app.working : member.name}
                </Button>
              ))}
            </div>
            {/* Offered whether or not the list has anything on it: the roster
                no longer has to be typed out before the link is worth
                sending. Hidden only when the link itself is dead. */}
            {!error ? (
              <Button variant="text" onClick={() => setAdding(true)} disabled={busy !== null}>
                {m.join.notListed}
              </Button>
            ) : null}
          </div>
        )}

        <Dialog
          open={adding}
          onClose={() => setAdding(false)}
          headline={m.join.addYourName}
          actions={
            <>
              <Button variant="text" onClick={() => setAdding(false)}>
                {m.app.cancel}
              </Button>
              <Button onClick={addSelf} disabled={busy !== null || !ownName.trim()}>
                {m.join.addYourName}
              </Button>
            </>
          }
        >
          <p className="muted" style={{ margin: 0 }}>
            {m.join.addYourNameBody}
          </p>
          <TextField label={m.join.yourName} value={ownName} onChange={setOwnName} autoFocus />
        </Dialog>

        <div className="row" style={{ justifyContent: 'center', gap: 4 }}>
          {LOCALES.map((code) => (
            <Button
              key={code}
              variant={code === locale ? 'tonal' : 'text'}
              onClick={() => setLocale(code)}
            >
              {LOCALE_LABELS[code]}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
