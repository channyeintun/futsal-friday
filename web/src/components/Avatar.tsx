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
}: {
  memberId: string;
  name: string;
  avatarUpdatedAt: string | null;
  size?: number;
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
    fontSize: Math.round(size * 0.4),
    // Kept even behind a photo: PNGs with transparency are common, and without
    // something underneath they show the card through and the circle looks
    // broken rather than round.
    background: tintFor(memberId),
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
