import type { MemberProfile } from '@futsal/shared';
import { formatVnd } from '@futsal/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { removeMyAvatar, uploadMyAvatar } from '../api/members.js';
import { profileKey } from '../hooks/queries.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Avatar } from './Avatar.js';
import { Icon } from './Icon.js';
import { Button, Dialog, ErrorBanner } from './ui.js';

/**
 * Who somebody is: their face, their run, and what they owe.
 *
 * Shown for yourself at the top of History, and for anyone else on their own
 * screen — the streak is a bragging right, so it is no use if only you can see
 * it.
 */
export function ProfileCard({ profile }: { profile: MemberProfile }) {
  const { identity, toast, refresh } = useApp();
  const { m } = useLocale();
  const queryClient = useQueryClient();

  const isMe = profile.member.id === identity.memberId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Both paths end the same way: the row moved, so the profile query is stale.
  // The picture itself is keyed on `avatarUpdatedAt`, so a new one is a new
  // cache entry and needs no explicit image invalidation.
  const settle = async () => {
    await queryClient.invalidateQueries({ queryKey: profileKey(profile.member.id) });
    await refresh();
  };

  const pick = async () => {
    if (busy) return;
    setError(null);
    const file = await platform.pickImage();
    if (!file) return;

    setBusy(true);
    try {
      await uploadMyAvatar(file);
      toast(m.profile.pictureUpdated);
      await settle();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.profile.couldNotUpload);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeMyAvatar();
      setConfirmRemove(false);
      await settle();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.profile.couldNotUpload);
    } finally {
      setBusy(false);
    }
  };

  const face = (
    <Avatar
      memberId={profile.member.id}
      name={profile.member.name}
      avatarUpdatedAt={profile.member.avatarUpdatedAt}
      size={64}
    />
  );

  return (
    <div className="card">
      {/* Strictly two things on this row. Anything else — the remove action,
          an error — goes below, or it squeezes the name into a wrap. */}
      <div className="row" style={{ gap: 14, alignItems: 'center' }}>
        {isMe ? (
          <button
            type="button"
            className="avatar-edit"
            onClick={pick}
            disabled={busy}
            aria-label={m.profile.changePicture}
          >
            {face}
            <span className="avatar-pencil">
              <Icon name={busy ? 'clock' : 'camera'} size={14} />
            </span>
          </button>
        ) : (
          face
        )}

        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="card-title truncate" style={{ margin: 0 }}>
            {profile.member.name}
          </h2>
          <p className="card-sub" style={{ margin: 0 }}>
            {m.profile.playedOf(profile.streak.played, profile.streak.total)}
          </p>
          {profile.outstanding > 0 ? (
            <p className="card-sub" style={{ margin: 0, color: 'var(--md-sys-color-error)' }}>
              {m.profile.owes(formatVnd(profile.outstanding))}
            </p>
          ) : null}
        </div>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <StreakRow profile={profile} />

      {isMe && profile.member.avatarUpdatedAt ? (
        <Button variant="text" danger onClick={() => setConfirmRemove(true)} disabled={busy}>
          {m.profile.removePicture}
        </Button>
      ) : null}

      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        headline={m.profile.removePicture}
        actions={
          <>
            <Button variant="text" onClick={() => setConfirmRemove(false)}>
              {m.app.cancel}
            </Button>
            <Button onClick={remove} disabled={busy}>
              {m.app.remove}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{m.profile.removePictureBody}</p>
      </Dialog>
    </div>
  );
}

function StreakRow({ profile }: { profile: MemberProfile }) {
  const { m } = useLocale();
  const { current, best } = profile.streak;

  return (
    <>
      <div className="streak">
        <div className={`streak-cell${current > 0 ? ' is-live' : ''}`}>
          <div className="streak-value">{current}</div>
          <div className="streak-label">{m.profile.currentStreak}</div>
        </div>
        <div className="streak-cell">
          <div className="streak-value">{best}</div>
          <div className="streak-label">{m.profile.bestStreak}</div>
        </div>
        <div className="streak-cell">
          <div className="streak-value">{profile.streak.played}</div>
          <div className="streak-label">{m.profile.played}</div>
        </div>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {current > 0 ? m.profile.keepItUp(current) : m.profile.noStreak}
      </p>
    </>
  );
}
