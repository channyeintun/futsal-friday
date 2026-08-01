import type { SessionDetail } from '@futsal/shared';
import { sessionAnnouncement } from '@futsal/shared';
import { useCallback, useState } from 'react';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Button, Dialog, ErrorBanner } from './ui.js';
import { Icon } from './Icon.js';

/**
 * "Hype the group" — a random announcement to paste into the chat.
 *
 * The text is always shown in full, not just copied, for two reasons: chat
 * webviews often block the clipboard API, and nobody should post a joke to
 * fifteen friends without reading it first.
 */
export function AnnounceButton({ detail }: { detail: SessionDetail }) {
  const { toast } = useApp();
  const { m, locale } = useLocale();
  const [text, setText] = useState<string | null>(null);
  const [failedCopy, setFailedCopy] = useState(false);

  const write = useCallback(
    (previous: string | null) => {
      const next = () => sessionAnnouncement(detail, { locale, appUrl: platform.appUrl });
      // Shuffling and getting the same message back reads as a broken button,
      // and with eight openers that happens often enough to notice. A few
      // retries is plenty; give up rather than spin if the bank is tiny.
      let candidate = next();
      for (let i = 0; i < 8 && candidate === previous; i++) candidate = next();
      return candidate;
    },
    [detail, locale],
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
        <pre className="summary-preview">{text}</pre>
        {failedCopy ? <ErrorBanner>{m.copy.fallbackBody}</ErrorBanner> : null}
      </Dialog>
    </>
  );
}
