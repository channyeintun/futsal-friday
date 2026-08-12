import type { Member } from '@futsal/shared';
import { useState } from 'react';
import { approveMember, rejectMember } from '../api/members.js';
import { usePendingMembers } from '../hooks/queries.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Avatar } from './Avatar.js';
import { Button, Dialog, ErrorBanner } from './ui.js';

/**
 * The waiting room, from the organizer's side.
 *
 * Renders nothing at all when it is empty — an always-present "0 waiting"
 * card is noise on a screen the organizer opens for other reasons, and this
 * one needs to be noticed when it does appear.
 */
export function PendingApprovals({ onChanged }: { onChanged(): void }) {
  const { m } = useLocale();
  const { toast } = useApp();
  const state = usePendingMembers(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Member | null>(null);

  const waiting = state.data ?? [];
  if (waiting.length === 0) return null;

  const settle = () => {
    void state.refetch();
    // The roster and every count above it just changed too.
    onChanged();
  };

  const approve = async (member: Member) => {
    setBusy(member.id);
    setError(null);
    try {
      await approveMember(member.id);
      toast(m.approvals.approved(member.name));
      settle();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.approvals.couldNotApprove);
    } finally {
      setBusy(null);
    }
  };

  const reject = async (member: Member) => {
    setBusy(member.id);
    setError(null);
    try {
      await rejectMember(member.id);
      toast(m.approvals.rejected(member.name));
      setConfirm(null);
      settle();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.approvals.couldNotApprove);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card pending-card">
      <h2 className="card-title">{m.approvals.heading(waiting.length)}</h2>
      <p className="card-sub">{m.approvals.body}</p>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {waiting.map((member) => (
        <div key={member.id} className="member-row">
          <div className="row" style={{ gap: 8 }}>
            <Avatar
              memberId={member.id}
              name={member.name}
              avatarUpdatedAt={member.avatarUpdatedAt}
              size={32}
            />
            <span className="player-name truncate grow">{member.name}</span>
          </div>
          <div className="row wrap" style={{ gap: 4, justifyContent: 'flex-end' }}>
            <Button variant="text" danger onClick={() => setConfirm(member)} disabled={busy !== null}>
              {m.approvals.reject}
            </Button>
            <Button onClick={() => approve(member)} disabled={busy !== null}>
              {busy === member.id ? m.app.working : m.approvals.approve}
            </Button>
          </div>
        </div>
      ))}

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        headline={confirm ? m.approvals.confirmReject(confirm.name) : ''}
        actions={
          <>
            <Button variant="text" onClick={() => setConfirm(null)}>
              {m.app.cancel}
            </Button>
            <Button onClick={() => confirm && reject(confirm)} disabled={busy !== null}>
              {m.approvals.reject}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{m.approvals.confirmRejectBody}</p>
      </Dialog>
    </div>
  );
}
