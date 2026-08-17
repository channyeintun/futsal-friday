import { useEffect, useState } from 'react';
import { loadProofUrl } from '../api/payments.js';
import { platform } from '../platform/index.js';
import { useMessages } from '../state/locale.js';
import { Button, Dialog, ErrorBanner, Spinner } from './ui.js';

/**
 * Shows a payment screenshot.
 *
 * The image sits behind an authorized route, so it cannot simply be an `<img
 * src>` — it is fetched with the session credential and turned into an object
 * URL, which is revoked again when the dialog closes.
 */
export function ProofViewer({
  paymentId,
  version,
  memberName,
  onClose,
}: {
  paymentId: string;
  /** The payment's `updatedAt`; versions the URL so a replaced screenshot is
   * not answered out of the browser's cache. See `loadProofUrl`. */
  version: string;
  memberName: string;
  onClose(): void;
}) {
  const m = useMessages();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let created: string | null = null;

    loadProofUrl(paymentId, version, controller.signal)
      .then((objectUrl) => {
        created = objectUrl;
        setUrl(objectUrl);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : m.payments.couldNotLoadImage);
      });

    return () => {
      controller.abort();
      if (created) platform.objectUrl.revoke(created);
    };
  }, [paymentId, version]);

  return (
    <Dialog
      open
      onClose={onClose}
      headline={m.payments.transferOf(memberName)}
      actions={
        <Button variant="text" onClick={onClose}>
          {m.app.close}
        </Button>
      }
    >
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {!error && !url ? <Spinner label={m.home.loading} /> : null}
      {url ? <img className="proof-image" src={url} alt={`Payment from ${memberName}`} /> : null}
    </Dialog>
  );
}
