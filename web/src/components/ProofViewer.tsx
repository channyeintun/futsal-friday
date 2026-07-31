import { useEffect, useState } from 'react';
import { loadProofUrl } from '../api/payments.js';
import { platform } from '../platform/index.js';
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
  memberName,
  onClose,
}: {
  paymentId: string;
  memberName: string;
  onClose(): void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let created: string | null = null;

    loadProofUrl(paymentId, controller.signal)
      .then((objectUrl) => {
        created = objectUrl;
        setUrl(objectUrl);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Could not load that screenshot');
      });

    return () => {
      controller.abort();
      if (created) platform.objectUrl.revoke(created);
    };
  }, [paymentId]);

  return (
    <Dialog
      open
      onClose={onClose}
      headline={`${memberName}'s transfer`}
      actions={
        <Button variant="text" onClick={onClose}>
          Close
        </Button>
      }
    >
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {!error && !url ? <Spinner label="Loading…" /> : null}
      {url ? <img className="proof-image" src={url} alt={`Payment from ${memberName}`} /> : null}
    </Dialog>
  );
}
