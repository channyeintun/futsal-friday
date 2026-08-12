import { type ReactNode, useState } from 'react';
import { useLocale } from '../state/locale.js';
import { Button, Dialog } from './ui.js';

/**
 * A button that asks first.
 *
 * Every destructive action in the app should go through this rather than
 * hand-rolling a dialog beside it. Three of them did, three did not, and the
 * inconsistency was the actual hazard: the roster put a remove control
 * immediately next to a sign-out control, one of which asked and one of which
 * did not, so there was no way to learn from the interface which taps were
 * safe to explore.
 *
 * Nothing here is undoable from inside the app — a removed member has to be
 * re-invited, a replaced group link has to be re-shared with everybody — so
 * the confirmation is the only recovery there is.
 */
export function ConfirmButton({
  headline,
  body,
  confirmLabel,
  onConfirm,
  children,
  variant = 'text',
  danger = true,
  ariaLabel,
  disabled,
}: {
  headline: string;
  /** What actually happens, in plain terms. Not a restatement of the button. */
  body: string;
  confirmLabel: string;
  onConfirm(): void | Promise<void>;
  children: ReactNode;
  variant?: 'filled' | 'tonal' | 'outlined' | 'text';
  danger?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const { m } = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant={variant}
        danger={danger}
        ariaLabel={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {children}
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        headline={headline}
        actions={
          <>
            <Button variant="text" onClick={() => setOpen(false)}>
              {m.app.cancel}
            </Button>
            {/* The affirmative button carries the destructive wording, so the
                last thing read before committing names the consequence. */}
            <Button danger={danger} onClick={confirm} disabled={busy}>
              {busy ? m.app.working : confirmLabel}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{body}</p>
      </Dialog>
    </>
  );
}
