import type { MemberProfile } from '@futsal/shared';
import { formatVnd } from '@futsal/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { removeMyAvatar, uploadMyAvatar } from '../api/members.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Avatar } from './Avatar.js';
import { ItemCard } from './ItemCard.js';
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

  // Both paths end the same way: the row moved, so anything holding it is
  // stale. Wider than it looks like it needs to be, deliberately — every screen
  // that draws a face carries its own copy of `avatarUpdatedAt` in its own
  // payload, and the picture's cache key is built from that timestamp. Refresh
  // this card alone and the roster, the leaderboard, the debt list, tonight's
  // teams and the chat stay keyed to the old one, holding the old face; on
  // History that is the row immediately below this card. Somebody changes their
  // picture about once a season, so the extra refetches cost nothing anyone
  // will ever feel.
  //
  // The pictures themselves are exempt: their key already carries the
  // timestamp, which makes every entry immutable, so re-requesting one could
  // only ever return the bytes it already has.
  const settle = async () => {
    await queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] !== 'avatar',
    });
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
      {/*
        The card, at the one size that can carry everything it wears.
        
        This is the item's proper home: the pitch and the podium are too small
        for the six figures across the foot, and this screen is the only place
        that already knows all six. The number it wears is appearances, because
        that is the one figure about a person here that only ever goes up and
        needs no formula — the rest are the six below it.
      */}
      <div className="item-hero">
        <ItemCard
          width={HERO_WIDTH}
          metal="steel"
          rating={profile.streak.played}
          code={m.board.codeApps}
          name={profile.member.name}
          isMe={isMe}
          stats={[
            { label: m.board.codeStreak, value: profile.streak.current },
            { label: m.board.codeBest, value: profile.streak.best },
            { label: m.board.codeGoals, value: profile.goals },
            { label: m.board.codeMvp, value: profile.mvps },
            { label: m.board.codeAttendance, value: attendance(profile) },
            { label: m.board.codeTotal, value: profile.streak.total },
          ]}
          portrait={
            <Avatar
              memberId={profile.member.id}
              name={profile.member.name}
              avatarUpdatedAt={profile.member.avatarUpdatedAt}
              size={HERO_WIDTH}
              tinted={false}
              initialsScale={0.22}
            />
          }
        />
      </div>

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
        {/* Goals sit with the streak because they answer the same question in
            the other direction: turning up, and what you did once there. */}
        <div className="streak-cell">
          <div className="streak-value">{profile.goals}</div>
          <div className="streak-label">{m.goals.total}</div>
        </div>
        {/* Only once there is one. A row of five cells with a zero on the end
            makes the award look like a stat nobody has rather than one nobody
            has *yet*, and it costs the other four their width on a phone. */}
        {profile.mvps > 0 ? (
          <div className="streak-cell is-live">
            <div className="streak-value">{profile.mvps}</div>
            <div className="streak-label">{m.board.mvps}</div>
          </div>
        ) : null}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {current > 0 ? m.profile.keepItUp(current) : m.profile.noStreak}
      </p>
    </>
  );
}

/**
 * Wide enough for six figures across the foot.
 *
 * `tierFor` puts the full card at 180 and up, which is where a six-across row
 * stops being 5px type. 200 fits inside the narrowest phone the app supports
 * with its card padding either side.
 */
const HERO_WIDTH = 200;

/** Turned up, as a whole percentage. Nought sessions is nought, not a divide. */
function attendance(profile: MemberProfile): number {
  return profile.streak.total === 0
    ? 0
    : Math.round((profile.streak.played / profile.streak.total) * 100);
}
