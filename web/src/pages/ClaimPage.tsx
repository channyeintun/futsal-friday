import type { Identity, InviteKind } from '@futsal/shared';
import { LOCALES, LOCALE_LABELS } from '@futsal/shared';
import { useEffect, useRef, useState } from 'react';
import { claim } from '../api/auth.js';
import { Icon } from '../components/Icon.js';
import { PasswordSignIn } from '../components/Password.js';
import { PasteInvite } from '../components/PasteInvite.js';
import { Button, ErrorBanner, Spinner } from '../components/ui.js';
import { platform } from '../platform/index.js';
import { useLocale } from '../state/locale.js';

/**
 * Opening the link somebody sent you.
 *
 * Two states — redeeming, or saying the link did not work and offering the
 * password instead. Nothing here reveals who is in the group, which is the
 * point: before links, anyone with the group code could read the roster and
 * pick any name on it.
 */
export function ClaimPage({
  onSignedIn,
  nonce,
}: {
  onSignedIn(identity: Identity): void;
  /** Set when the link was pasted in rather than opened. */
  nonce?: string;
}) {
  const { m, locale, setLocale } = useLocale();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  // `nonce` wins when the link was pasted rather than opened — an installed
  // PWA has no address bar to carry a fragment.
  const [hash, setHash] = useState(() => nonce ?? platform.navigation.hash());

  // Opening a second link in a tab that is already here changes only the
  // fragment, which does not reload the page.
  useEffect(() => {
    if (nonce) return;
    return platform.navigation.subscribe(() => setHash(platform.navigation.hash()));
  }, [nonce]);

  // Keyed on the nonce rather than a boolean: Strict mode double-invokes
  // effects and a link is single-use, so the second attempt would spend
  // nothing and report "invalid" — but a *different* link should be tried.
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    if (!hash) {
      // An empty fragment here is usually *us*, having just stripped the secret
      // out of the address bar — not a visitor arriving without a link. Only
      // the latter deserves an error, so say nothing if a claim is in flight.
      if (attempted.current === null) {
        setError(m.claim.noLink);
        setBusy(false);
      }
      return;
    }

    const nonce = hash;
    if (attempted.current === nonce) return;
    attempted.current = nonce;

    setBusy(true);
    setError(null);
    // Drop the secret from the address bar before anything else can read it
    // back out of history or a shared screenshot.
    platform.navigation.replace('/claim');

    claim(nonce)
      .then(onSignedIn)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : m.claim.failed);
        setBusy(false);
      });
  }, [hash, m, onSignedIn]);

  return (
    <div className="app">
      <div className="content" style={{ justifyContent: 'center', gap: 20 }}>
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 4 }}>
          <Icon name="ball" size={48} />
          <h1 style={{ margin: 0, fontSize: '1.6rem' }}>{m.app.name}</h1>
        </div>

        {busy ? (
          <Spinner label={m.claim.signingIn} />
        ) : (
          <>
            {error ? <ErrorBanner>{error}</ErrorBanner> : null}
            {/* A spent link is usually an old one; the password still works. */}
            <PasswordSignIn onSignedIn={onSignedIn} />
            <div className="card">
              <p className="card-sub" style={{ margin: 0 }}>
                {m.claim.askOrganizer}
              </p>
            </div>
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
          </>
        )}
      </div>
    </div>
  );
}

/** Shown whenever nobody is signed in: a password, or a link. */
export function SignInNeeded({
  onInvite,
  onSignedIn,
}: {
  onInvite(kind: InviteKind, nonce: string): void;
  onSignedIn(identity: Identity): void;
}) {
  const { m, locale, setLocale } = useLocale();

  return (
    <div className="app">
      <div className="content" style={{ justifyContent: 'center', gap: 20 }}>
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 4 }}>
          <Icon name="ball" size={48} />
          <h1 style={{ margin: 0, fontSize: '1.6rem' }}>{m.app.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {m.claim.tagline}
          </p>
        </div>

        <PasswordSignIn onSignedIn={onSignedIn} />

        <PasteInvite onInvite={onInvite} />

        <div className="card">
          <p className="card-sub" style={{ margin: 0 }}>
            {m.claim.askOrganizer}
          </p>
        </div>

        <div className="row" style={{ justifyContent: 'center', gap: 4 }}>
          {LOCALES.map((code) => (
            <Button
              key={code}
              lang={code}
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
