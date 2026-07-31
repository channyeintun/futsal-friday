import type { Identity } from '@futsal/shared';
import { LOCALES, LOCALE_LABELS } from '@futsal/shared';
import { useEffect, useRef, useState } from 'react';
import { claim } from '../api/auth.js';
import { Icon } from '../components/Icon.js';
import { Button, ErrorBanner, Spinner } from '../components/ui.js';
import { platform } from '../platform/index.js';
import { useLocale } from '../state/locale.js';

/**
 * The only way in: open the link somebody sent you.
 *
 * There is no name picker and no shared password, so this screen has exactly
 * two states — redeeming, or explaining that you need a link. Nothing here
 * reveals who is in the group, which is the point: before this change, anyone
 * with the group code could read the roster and pick any name on it.
 */
export function ClaimPage({ onSignedIn }: { onSignedIn(identity: Identity): void }) {
  const { m, locale, setLocale } = useLocale();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [hash, setHash] = useState(() => platform.navigation.hash());

  // Opening a second link in a tab that is already here changes only the
  // fragment, which does not reload the page.
  useEffect(() => platform.navigation.subscribe(() => setHash(platform.navigation.hash())), []);

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

/** Shown when someone opens the app without ever having claimed an identity. */
export function SignInNeeded() {
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
      </div>
    </div>
  );
}
