import { initialsOf } from '@futsal/shared';
import { useEffect, useState } from 'react';
import { useAvatar } from '../hooks/queries.js';
import { platform } from '../platform/index.js';

/**
 * A member's face, or their initials.
 *
 * The initials are not a placeholder waiting to be replaced — most people will
 * never upload a picture, so they have to look deliberate. The colour is
 * derived from the member id, which keeps it stable for a person across every
 * screen and device without storing anything.
 */
export function Avatar({
  memberId,
  name,
  avatarUpdatedAt,
  size = 40,
  tinted = true,
  initialsScale = 0.4,
}: {
  memberId: string;
  name: string;
  avatarUpdatedAt: string | null;
  size?: number;
  /**
   * Whether to paint the member's own colour behind the face.
   *
   * On by default, and wanted almost everywhere. The exception is a surface
   * that already carries a meaning in its own colour — a gold, silver or bronze
   * item on the podium — where a full-bleed tint over the top of it says
   * "somebody" at the cost of saying "first". There the initials sit on the
   * tier instead, which is also what a real player item does with a cut-out.
   */
  tinted?: boolean;
  /**
   * Initials as a fraction of the box, when there is no photograph.
   *
   * Four tenths is right for a disc, where the letters are the whole object. It
   * is far too much on a player item, where the box is the full width of the
   * card and two capitals at that size run past the frame — there the letters
   * stand in for a face that would have filled the space, not for the card.
   */
  initialsScale?: number;
}) {
  const { data: blob } = useAvatar(memberId, avatarUpdatedAt);
  const [url, setUrl] = useState<string | null>(null);

  // The Blob is shared out of the query cache; the URL is this component's own,
  // so it is created and revoked here rather than being cached anywhere.
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const created = platform.objectUrl.create(blob);
    setUrl(created);
    return () => platform.objectUrl.revoke(created);
  }, [blob]);

  const style = {
    width: size,
    height: size,
    fontSize: Math.round(size * initialsScale),
    // Kept even behind a photo: PNGs with transparency are common, and without
    // something underneath they show the card through and the circle looks
    // broken rather than round. Switched off only where what shows through is
    // the point — see `tinted`.
    background: tinted ? tintFor(memberId) : undefined,
  };

  return (
    <span className="avatar" style={style} aria-hidden={url ? undefined : true}>
      {url ? (
        <img src={url} alt={name} width={size} height={size} />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}

/** A stable, muted tint per member. Hue only, so contrast stays predictable. */
function tintFor(memberId: string): string {
  let hash = 0;
  for (let i = 0; i < memberId.length; i++) hash = (hash * 31 + memberId.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 45% 38%)`;
}
