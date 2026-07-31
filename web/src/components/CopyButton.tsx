import { useState } from 'react';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useMessages } from '../state/locale.js';
import { Button, Dialog } from './ui.js';
import { Icon } from './Icon.js';

/**
 * "Copy summary" — the feature that replaces the organizer retyping the list
 * into the group chat.
 *
 * Chat webviews frequently refuse the async clipboard API, so a failed copy
 * falls back to showing the text in a dialog for a manual long-press-and-copy
 * rather than silently doing nothing.
 */
export function CopyButton({
  label,
  text,
  variant = 'tonal',
}: {
  label: string;
  text: string;
  variant?: 'filled' | 'tonal' | 'outlined' | 'text';
}) {
  const { toast } = useApp();
  const m = useMessages();
  const [showFallback, setShowFallback] = useState(false);

  const copy = async () => {
    const ok = await platform.clipboard.write(text);
    if (ok) toast(m.toast.copied);
    else setShowFallback(true);
  };

  return (
    <>
      <Button variant={variant} onClick={copy}>
        <Icon name="copy" size={18} slot="icon" />
        {label}
      </Button>

      <Dialog
        open={showFallback}
        onClose={() => setShowFallback(false)}
        headline={m.copy.fallbackTitle}
        actions={
          <Button variant="text" onClick={() => setShowFallback(false)}>
            {m.app.done}
          </Button>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          {m.copy.fallbackBody}
        </p>
        <pre className="summary-preview">{text}</pre>
      </Dialog>
    </>
  );
}
