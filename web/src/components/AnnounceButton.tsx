import type { Locale, SessionDetail } from '@futsal/shared';
import { LOCALE_LABELS, LOCALES, sessionAnnouncement } from '@futsal/shared';
import { useCallback, useState } from 'react';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Button, Dialog, ErrorBanner, TextField } from './ui.js';
import { Icon } from './Icon.js';

/**
 * "Hype the group" — a random announcement to paste into the chat.
 *
 * The text is always shown in full, not just copied, for two reasons: chat
 * webviews often block the clipboard API, and nobody should post a joke to
 * fifteen friends without reading it first.
 *
 * The language of the *message* is chosen here rather than inherited from the
 * app, because the two are genuinely different questions. The group chat is in
 * Burmese; the organizer may well be reading the app in English. Making them
 * switch the whole interface to Burmese and back just to paste one line — and
 * silently changing the language of their push notifications on the way, since
 * that preference is shared — is a bad trade for a joke.
 */
export function AnnounceButton({ detail }: { detail: SessionDetail }) {
  const { toast } = useApp();
  const { m, locale } = useLocale();
  // Starts at whatever the app is in, which is the right guess most of the
  // time; it is only a starting point, and it never touches the app's own
  // language.
  const [writeIn, setWriteIn] = useState<Locale>(locale);
  const [text, setText] = useState<string | null>(null);
  const [failedCopy, setFailedCopy] = useState(false);
  /** The organizer's own first line. Empty means "use the joke bank". */
  const [opener, setOpener] = useState('');

  const write = useCallback(
    (previous: string | null, inLocale: Locale = writeIn, firstLine = opener) => {
      const next = () =>
        sessionAnnouncement(detail, {
          locale: inLocale,
          appUrl: platform.appUrl,
          opener: firstLine,
        });
      // Shuffling and getting the same message back reads as a broken button,
      // and with eight openers that happens often enough to notice. A few
      // retries is plenty; give up rather than spin if the bank is tiny — and
      // a written opener pins the first line, so the retries are only ever
      // working on the tease and the sign-off.
      let candidate = next();
      for (let i = 0; i < 8 && candidate === previous; i++) candidate = next();
      return candidate;
    },
    [detail, writeIn, opener],
  );

  const copy = async () => {
    if (!text) return;
    const ok = await platform.clipboard.write(text);
    if (ok) {
      toast(m.toast.copied);
      setText(null);
    } else {
      setFailedCopy(true);
    }
  };

  return (
    <>
      <Button variant="text" onClick={() => { setFailedCopy(false); setText(write(null)); }}>
        <Icon name="share" size={18} slot="icon" />
        {m.announce.open}
      </Button>

      <Dialog
        open={text !== null}
        onClose={() => setText(null)}
        headline={m.announce.title}
        actions={
          <>
            <Button variant="text" onClick={() => setText((current) => write(current))}>
              {m.announce.shuffle}
            </Button>
            <Button onClick={copy}>{m.announce.copy}</Button>
          </>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          {m.announce.body}
        </p>

        {/* Which language the *message* is in — not the app. */}
        <div className="row wrap" style={{ gap: 8 }}>
          {LOCALES.map((code) => (
            <Button
              key={code}
              lang={code}
              variant={code === writeIn ? 'filled' : 'outlined'}
              onClick={() => {
                setWriteIn(code);
                setText(write(null, code));
              }}
            >
              {LOCALE_LABELS[code]}
            </Button>
          ))}
        </div>

        {/* Your own first line, when the week has something the joke bank
            cannot know about. Left empty it shuffles like it always did, so
            this costs nothing to ignore. */}
        <TextField
          label={m.announce.openerLabel}
          value={opener}
          onChange={(value) => {
            setOpener(value);
            setText((current) => write(current, writeIn, value));
          }}
          supportingText={m.announce.openerHint}
        />

        {/* Tagged with the message's own language, so Burmese gets Burmese
            line-height even while the app is running in English. */}
        <pre className="summary-preview" lang={writeIn}>
          {text}
        </pre>
        {failedCopy ? <ErrorBanner>{m.copy.fallbackBody}</ErrorBanner> : null}
      </Dialog>
    </>
  );
}
