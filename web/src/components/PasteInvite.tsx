import type { InviteKind } from '@futsal/shared';
import { parseInvite } from '@futsal/shared';
import { useState } from 'react';
import { groupRoster } from '../api/auth.js';
import { platform } from '../platform/index.js';
import { useLocale } from '../state/locale.js';
import { Button, ErrorBanner, TextField } from './ui.js';

/**
 * The way in when there is no address bar.
 *
 * An installed PWA cannot have a link "opened" in it, and on iOS a link tapped
 * inside a chat opens the in-app webview instead — separate storage, so
 * somebody signs in there and their home-screen icon stays signed out with no
 * way to fix it. This is that way.
 *
 * A field, not just a clipboard button: reading the clipboard is refused by
 * Firefox entirely, by Safari outside a gesture, and by most chat webviews.
 * The button is an accelerator on top of the thing that always works.
 */
export function PasteInvite({
  onInvite,
}: {
  onInvite(kind: InviteKind, nonce: string): void;
}) {
  const { m } = useLocale();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (raw: string) => {
    const parsed = parseInvite(raw);
    if (!parsed) {
      setError(m.paste.notALink);
      return;
    }
    if (parsed.kind) {
      onInvite(parsed.kind, parsed.nonce);
      return;
    }

    // A bare code with no path to say which sort it is. Try the group link
    // first: reading the roster is harmless if it is the wrong guess, whereas
    // a personal link is single-use and a wrong guess would spend it.
    setBusy(true);
    setError(null);
    try {
      await groupRoster(parsed.nonce);
      onInvite('join', parsed.nonce);
    } catch {
      onInvite('claim', parsed.nonce);
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    const clip = await platform.clipboard.read();
    if (clip === null) {
      setError(m.paste.pasteBlocked);
      return;
    }
    setText(clip);
    await submit(clip);
  };

  return (
    <div className="card">
      <h2 className="card-title">{m.paste.title}</h2>
      <p className="card-sub">{m.paste.body}</p>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <TextField
        label={m.paste.label}
        value={text}
        onChange={(value) => {
          setText(value);
          setError(null);
        }}
      />
      <Button onClick={() => submit(text)} disabled={busy || !text.trim()}>
        {busy ? m.app.working : m.paste.go}
      </Button>
      <Button variant="text" onClick={paste} disabled={busy}>
        {m.paste.fromClipboard}
      </Button>
    </div>
  );
}
