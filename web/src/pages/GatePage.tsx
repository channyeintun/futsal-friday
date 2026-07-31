import type { Identity, Member } from '@futsal/shared';
import { useState } from 'react';
import { join, openGate } from '../api/auth.js';
import { Button, ErrorBanner, TextField } from '../components/ui.js';
import { Icon } from '../components/Icon.js';
import { useLocale } from '../state/locale.js';
import { LOCALES, LOCALE_LABELS } from '@futsal/shared';

/**
 * The way in.
 *
 * Two steps and no passwords: prove you know the group's invite code, then say
 * which of the names on the list is you. The code is what keeps strangers out;
 * picking a name is on the honour system, which is the correct amount of
 * ceremony for fifteen friends splitting a pitch fee.
 */
export function GatePage({ onSignedIn }: { onSignedIn(identity: Identity): void }) {
  const { m, locale, setLocale } = useLocale();
  const [code, setCode] = useState('');
  const [gateToken, setGateToken] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitCode = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await openGate(code.trim());
      setGateToken(result.gateToken);
      setMembers(result.members);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.gate.couldNotCheck);
    } finally {
      setBusy(false);
    }
  };

  const pickName = async (member: Member) => {
    if (!gateToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await join(gateToken, member.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.gate.couldNotSignIn);
      // A rejected gate token means the 15-minute window lapsed; start over.
      setGateToken(null);
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <div className="content" style={{ justifyContent: 'center', gap: 20 }}>
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 4 }}>
          <Icon name="ball" size={48} />
          <h1 style={{ margin: 0, fontSize: '1.6rem' }}>{m.app.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {gateToken ? m.gate.whichOne : m.gate.tagline}
          </p>
        </div>

        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        {!gateToken ? (
          <div className="card">
            <TextField
              label={m.gate.inviteCode}
              value={code}
              onChange={setCode}
              autoFocus
              supportingText={m.gate.inviteHint}
            />
            <Button onClick={submitCode} disabled={busy || code.trim().length === 0}>
              {busy ? m.gate.checking : m.gate.continue}
            </Button>
          </div>
        ) : (
          <div className="card">
            {members.length === 0 ? (
              <p className="empty">{m.gate.emptyRoster}</p>
            ) : (
              <div className="stack">
                {members.map((member) => (
                  <Button key={member.id} variant="outlined" onClick={() => pickName(member)}>
                    {member.name}
                    {member.isOrganizer ? ` · ${m.app.organizerSuffix}` : ''}
                  </Button>
                ))}
              </div>
            )}
            <Button
              variant="text"
              onClick={() => {
                setGateToken(null);
                setMembers([]);
              }}
            >
              {m.app.back}
            </Button>
          </div>
        )}
        {/* Offered before sign-in too, so a Burmese speaker is never made to
            read an English screen to find the language switch. */}
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
