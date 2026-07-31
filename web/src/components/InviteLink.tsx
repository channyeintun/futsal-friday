import type { ClaimLink, Member } from '@futsal/shared';
import { formatKickoff } from '@futsal/shared';
import { useState } from 'react';
import { memberClaimLink, myDeviceLink, revokeMemberClaim } from '../api/auth.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Button, Dialog, ErrorBanner } from './ui.js';

/**
 * Handing out identities.
 *
 * The link is shown once, in a dialog, with a copy button — it is a bearer
 * credential, so it is treated like one rather than being left sitting in the
 * roster where a shoulder-surfer or a screenshot would capture it.
 */
export function InviteLinkDialog({
  link,
  onClose,
}: {
  link: ClaimLink | null;
  onClose(): void;
}) {
  const { toast } = useApp();
  const { m, locale } = useLocale();
  const [failedCopy, setFailedCopy] = useState(false);

  if (!link) return null;

  const copy = async () => {
    const ok = await platform.clipboard.write(link.url);
    if (ok) {
      toast(m.invite.copied);
      onClose();
    } else {
      setFailedCopy(true);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      headline={m.invite.linkReady(link.memberName)}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {m.app.close}
          </Button>
          <Button onClick={copy}>{m.invite.copyLink}</Button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        {m.invite.linkBody}
      </p>
      {/* Shown so it can be copied by hand where the clipboard API is blocked. */}
      <pre className="summary-preview">{link.url}</pre>
      <p className="muted" style={{ margin: 0 }}>
        {m.invite.expires(formatKickoff(link.expiresAt, locale))}
      </p>
      {failedCopy ? <ErrorBanner>{m.copy.fallbackBody}</ErrorBanner> : null}
    </Dialog>
  );
}

/** Per-member controls on the roster: invite, re-invite, or cut off. */
export function MemberInviteControls({
  member,
  onChanged,
}: {
  member: Member;
  onChanged(): void;
}) {
  const { toast, identity } = useApp();
  const { m } = useLocale();
  const [link, setLink] = useState<ClaimLink | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      setLink(await memberClaimLink(member.id));
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.invite.couldNotMint);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await revokeMemberClaim(member.id);
      toast(m.invite.removed(member.name));
      setConfirmRemove(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.invite.couldNotRemove);
    } finally {
      setBusy(false);
    }
  };

  const status = member.claimedAt
    ? { label: m.invite.claimed, className: 'badge paid' }
    : member.hasPendingLink
      ? { label: m.invite.pending, className: 'badge pending' }
      : { label: m.invite.notYet, className: 'badge waitlist' };

  return (
    <>
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <span className={status.className}>{status.label}</span>

      <Button variant="text" onClick={mint} disabled={busy}>
        {member.claimedAt || member.hasPendingLink ? m.invite.reissue : m.invite.copyLink}
      </Button>

      {/* Revoking your own access from the device you are using would lock you
          out; "add another device" is the right tool for moving yourself. */}
      {member.claimedAt && member.id !== identity.memberId ? (
        <Button variant="text" onClick={() => setConfirmRemove(true)} disabled={busy}>
          ×
        </Button>
      ) : null}

      <InviteLinkDialog link={link} onClose={() => setLink(null)} />

      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        headline={m.invite.confirmRemove(member.name)}
        actions={
          <>
            <Button variant="text" onClick={() => setConfirmRemove(false)}>
              {m.app.cancel}
            </Button>
            <Button onClick={remove} disabled={busy}>
              {m.invite.removeAccess}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{m.invite.removeAccessBody}</p>
      </Dialog>
    </>
  );
}

/** "Add another device" — available to everyone, for their own account. */
export function MyDeviceCard() {
  const { m } = useLocale();
  const [link, setLink] = useState<ClaimLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      setLink(await myDeviceLink());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.invite.couldNotMint);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 className="card-title">{m.invite.myDevice}</h2>
      <p className="card-sub">{m.invite.myDeviceBody}</p>
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      <Button variant="outlined" onClick={mint} disabled={busy}>
        {m.invite.myDevice}
      </Button>
      <InviteLinkDialog link={link} onClose={() => setLink(null)} />
    </div>
  );
}
