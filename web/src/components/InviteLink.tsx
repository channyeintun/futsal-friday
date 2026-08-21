import type { ClaimLink, GroupInvite, Member } from '@futsal/shared';
import { formatKickoff, wholeDaysUntil } from '@futsal/shared';
import { useEffect, useState } from 'react';
import {
  currentGroupInvite,
  memberClaimLink,
  myDeviceLink,
  revokeMemberClaim,
  rotateGroupInvite,
} from '../api/auth.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { ConfirmButton } from './ConfirmButton.js';
import { Icon } from './Icon.js';
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
  const { m, locale, hour12 } = useLocale();
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
        {m.invite.expires(formatKickoff(link.expiresAt, locale, hour12))}
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

      {/*
        Revoking your own access from the device you are using would lock you
        out; "add another device" is the right tool for moving yourself.

        A logout glyph, not a cross. This sits next to the roster's remove
        button, and two crosses side by side read as one control repeated —
        with nothing but a confirmation dialog to tell you which destructive
        thing you just chose.
      */}
      {member.claimedAt && member.id !== identity.memberId ? (
        <Button
          variant="text"
          danger
          ariaLabel={m.invite.removeAccess}
          onClick={() => setConfirmRemove(true)}
          disabled={busy}
        >
          <Icon name="logout" size={16} />
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
            <Button danger onClick={remove} disabled={busy}>
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

/* ------------------------------------------------------------- group link */

/**
 * The one link the organizer shares with the whole group.
 *
 * Per-person links still exist for the cases that need them — organizers, a
 * second device, re-inviting somebody after a revocation — but the bulk case
 * is one message, not fifteen.
 */
export function GroupInviteCard() {
  const { toast } = useApp();
  const { m, locale, hour12 } = useLocale();
  const [invite, setInvite] = useState<GroupInvite | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    currentGroupInvite()
      .then(setInvite)
      .catch(() => setInvite(null))
      .finally(() => setLoaded(true));
  }, []);

  const rotate = async () => {
    setBusy(true);
    setError(null);
    try {
      setInvite(await rotateGroupInvite());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.invite.couldNotRotate);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!invite) return;
    const ok = await platform.clipboard.write(invite.url);
    if (ok) toast(m.invite.groupLinkCopied);
    else setError(m.copy.fallbackBody);
  };

  if (!loaded) return null;

  /*
   * Read at render rather than held in state. The panel is opened, looked at
   * and left; there is nothing here worth a timer, and a count that ticks over
   * while somebody reads it would be motion for its own sake.
   */
  const daysLeft = invite ? wholeDaysUntil(invite.expiresAt) : 0;

  return (
    <div className="card">
      <h2 className="card-title">{m.invite.groupLink}</h2>
      <p className="card-sub">{m.invite.groupLinkBody}</p>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {invite ? (
        <>
          {/* Shown in full so it can be copied by hand where the clipboard
              API is blocked, which chat webviews often do. */}
          <pre className="summary-preview">{invite.url}</pre>
          <p className="muted" style={{ margin: 0 }}>
            {invite.unclaimed > 0
              ? m.invite.waitingToJoin(invite.unclaimed)
              : m.invite.everyoneJoined}
            {' · '}
            {/* The countdown is the line; the date it lands on is the title,
                for anyone who wants to know exactly when. A personal claim
                link still shows its date outright — that one is minted, read
                and used in the same minute, so a count would be noise. */}
            <span title={formatKickoff(invite.expiresAt, locale, hour12)}>
              {daysLeft === 0 ? m.invite.lessThanADay : m.invite.expiresInDays(daysLeft)}
            </span>
          </p>
          <Button onClick={copy}>{m.invite.copyGroupLink}</Button>
          <ConfirmButton
            headline={m.invite.confirmRotate}
            body={m.invite.confirmRotateBody}
            confirmLabel={m.invite.rotateGroupLink}
            onConfirm={rotate}
            disabled={busy}
          >
            {m.invite.rotateGroupLink}
          </ConfirmButton>
          <p className="muted" style={{ margin: 0 }}>
            {m.invite.rotateWarning}
          </p>
        </>
      ) : (
        <Button variant="outlined" onClick={rotate} disabled={busy}>
          {m.invite.createGroupLink}
        </Button>
      )}
    </div>
  );
}
