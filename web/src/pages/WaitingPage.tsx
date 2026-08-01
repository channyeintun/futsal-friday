import type { Identity } from '@futsal/shared';
import { LOCALES, LOCALE_LABELS } from '@futsal/shared';
import { useState } from 'react';
import { currentIdentity } from '../api/auth.js';
import { Icon } from '../components/Icon.js';
import { Button, ErrorBanner } from '../components/ui.js';
import { useLocale } from '../state/locale.js';

/**
 * The waiting room, for somebody who added themselves from the group link.
 *
 * Deliberately a dead end. It shows their own name and nothing else — not the
 * roster, not the fixture, not who is playing. A group link pasted into a chat
 * can be forwarded out of it, so until an organizer says otherwise the person
 * on the other side of this screen is a stranger.
 *
 * The server enforces the same thing; this screen exists so they are told
 * why, rather than meeting a wall of failed requests.
 */
export function WaitingPage({
  identity,
  onApproved,
}: {
  identity: Identity;
  onApproved(identity: Identity): void;
}) {
  const { m, locale, setLocale } = useLocale();
  const [checking, setChecking] = useState(false);
  const [stillWaiting, setStillWaiting] = useState(false);

  // A push notification tells the organizer, and another tells them when they
  // are let in — but a manual check costs one request and saves the anxious
  // from closing the app and wondering.
  const check = async () => {
    setChecking(true);
    setStillWaiting(false);
    try {
      const found = await currentIdentity();
      if (found?.approved) onApproved(found);
      else setStillWaiting(true);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="app">
      <div className="content" style={{ justifyContent: 'center', gap: 20 }}>
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 4 }}>
          <Icon name="clock" size={48} />
          <h1 style={{ margin: 0, fontSize: '1.6rem' }}>{m.waiting.title}</h1>
        </div>

        <div className="card">
          <p className="card-sub" style={{ margin: 0 }}>
            {m.waiting.body(identity.name)}
          </p>
          {stillWaiting ? <ErrorBanner>{m.waiting.stillWaiting}</ErrorBanner> : null}
          <Button variant="outlined" onClick={check} disabled={checking}>
            {checking ? m.app.working : m.waiting.check}
          </Button>
          <p className="muted" style={{ margin: 0 }}>
            {m.waiting.wrongName}
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
