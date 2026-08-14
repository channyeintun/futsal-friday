import type { Locale, SessionDetail } from '@futsal/shared';
import { sessionAnnouncement } from '@futsal/shared';
import { useCallback, useState } from 'react';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Button, Dialog, ErrorBanner, TextField } from './ui.js';
import { Icon } from './Icon.js';
import { LanguageToggle } from './LanguageToggle.js';

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
  const { m, locale, hour12 } = useLocale();
  // Starts at whatever the app is in, which is the right guess most of the
  // time; it is only a starting point, and it never touches the app's own
  // language.
  const [writeIn, setWriteIn] = useState<Locale>(locale);
  const [text, setText] = useState<string | null>(null);
  const [failedCopy, setFailedCopy] = useState(false);
  /** The organizer's own jab. Empty means "use the joke bank". */
  const [tease, setTease] = useState('');

  /**
   * Which roll of the dice the message is on.
   *
   * The jokes are re-picked on every rebuild, and the message is rebuilt on
   * every keystroke in the jab field — so without this, typing made the opener
   * and the sign-off flicker through the bank one character at a time. Holding
   * the seed means only what you typed changes while you type, and the dice
   * are rolled again only when you actually ask: the shuffle button, or
   * switching the language.
   */
  const [roll, setRoll] = useState(() => Math.floor(Math.random() * 2 ** 31));

  const write = useCallback(
    (seed: number, inLocale: Locale = writeIn, ownJab = tease) =>
      sessionAnnouncement(detail, {
        locale: inLocale,
        appUrl: platform.appUrl,
        tease: ownJab,
        // Their clock, not the message's language: see `AnnounceOptions`.
        hour12,
        // Small deterministic PRNG (mulberry32): a seed reproduces a message.
        random: () => {
          seed = (seed + 0x6d2b79f5) >>> 0;
          let t = seed;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
        },
      }),
    [detail, writeIn, tease, hour12],
  );

  /**
   * Roll again, and do not hand back the message already on screen.
   *
   * Shuffling and getting the same thing back reads as a broken button, and
   * with eight of each line that happens often enough to notice. A few tries
   * is plenty; give up rather than spin if the bank is tiny — and a written
   * jab pins that line, so the tries are only ever working on the opener and
   * the sign-off.
   */
  const reroll = (previous: string | null, inLocale: Locale = writeIn) => {
    let candidate = previous;
    for (let i = 0; i < 8; i++) {
      const seed = Math.floor(Math.random() * 2 ** 31);
      candidate = write(seed, inLocale);
      if (candidate !== previous) {
        setRoll(seed);
        break;
      }
    }
    return candidate;
  };

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
      <Button variant="text" onClick={() => { setFailedCopy(false); setText(reroll(null)); }}>
        <Icon name="share" size={18} slot="icon" />
        {m.announce.open}
      </Button>

      <Dialog
        open={text !== null}
        onClose={() => setText(null)}
        headline={m.announce.title}
        actions={
          <>
            <Button variant="text" onClick={() => setText((current) => reroll(current))}>
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
        <LanguageToggle
          value={writeIn}
          label={m.announce.writeIn}
          onChange={(code) => {
            setWriteIn(code);
            setText(reroll(null, code));
          }}
        />

        {/* Your own jab, when the week has something the joke bank cannot
            know about — who went missing, who has been talking. Left empty
            it shuffles like it always did, so this costs nothing to ignore. */}
        <TextField
          label={m.announce.teaseLabel}
          value={tease}
          onChange={(value) => {
            setTease(value);
            // The same roll, so only the line being typed moves.
            setText(write(roll, writeIn, value));
          }}
          supportingText={m.announce.teaseHint}
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
