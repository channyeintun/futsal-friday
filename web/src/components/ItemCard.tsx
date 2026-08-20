import type { CSSProperties, ReactNode } from 'react';

/**
 * A player item: the card the whole app is shaped around.
 *
 * One component for both surfaces. A spot on the pitch and a card on the podium
 * had drifted into two hand-rolled shapes with two different aspect ratios,
 * which is why they never quite looked like the same object — and being the
 * same object is the point. What differs between them is how much detail
 * survives at their size, and that is a function of width alone: see `tierFor`.
 *
 * ## The silhouette
 *
 * Not a rounded rectangle, and not a shield. Traced off a real item: a sharp
 * spike at top centre, a flat-floored cusp either side of it, then a hump that
 * crests level with the spike, a long sweep out to a flat shoulder, dead
 * vertical sides for four fifths of the height, and a bottom that falls at a
 * shallow angle before kinking into a point. Every one of those is load-bearing
 * — take out the cusps and it reads as a zigzag, round the shoulders and it
 * reads as a rounded rectangle.
 *
 * The path is authored in a 100 x 127 box because that is the ratio the real
 * card has (0.787), and it is used twice: once at that scale to stroke the
 * frame, and once scaled into a 0..1 box so CSS can clip HTML to the same
 * outline. `ITEM_CARD_RATIO` is the same number, exported so the pitch can
 * budget its rows against it.
 *
 * ## Why the frame is three strokes of one path
 *
 * The rails have to stay parallel through the cusps and the point. Offsetting
 * by scaling a copy of the path does not: a scaled copy converges on the centre
 * and the two rails fuse into a smear through the crown. Stroking the *same*
 * path three times at different widths keeps them mathematically parallel
 * everywhere, and clipping the card to that path throws away the outer half of
 * every stroke, so each one paints exactly inward from the silhouette with a
 * hard outer edge.
 *
 * ## What is deliberately not here
 *
 * No flag, no league mark, no club crest. This app has no nationality — the one
 * language field is a UI preference — and one deployment is one group, so a
 * crest would be the same glyph on every card, carrying nothing. No overall
 * rating either: inventing a number out of streaks and goals and awards would
 * be weighting three unlike things, which is the same objection that keeps a
 * formation number off the pitch. The number a card wears is the one the board
 * it is on actually counts, with its code underneath saying what that is.
 */

/** 100 / 127, the ratio measured off the real item. */
export const ITEM_CARD_RATIO = 127 / 100;

/**
 * The outline, in a 100 x 127 box, symmetric about x = 50.
 *
 * Measured rather than drawn: every control point comes off a trace of the
 * silhouette, and the tolerances that matter are the flat cusp floor (2.3 units
 * wide — a V here is the difference between ornate and jagged), the flat hump
 * crest (4 units, cresting 0.3 below the centre spike), and the flat shoulder
 * (4.2 units, which is what makes it read as a card rather than a shield).
 */
export const OUTLINE =
  'M 50 0 ' +
  'C 51.4 1.6, 53.6 3.2, 55.9 4.3 L 58.2 4.3 ' +
  'C 60.2 3.4, 61.2 1.6, 62.5 0.3 L 66.5 0.3 ' +
  'C 69.5 1, 72.5 2.4, 76 3.2 C 80.5 3.6, 85 5.6, 89 8.2 ' +
  'C 91.5 9.3, 93 9.9, 94.8 9.9 L 99 9.9 ' +
  'C 99.6 10.2, 100 11, 100 12.3 L 100 113 ' +
  'C 100 116, 98.6 117.9, 95 118.7 ' +
  'C 82 120.4, 66 122.8, 50 127 ' +
  'C 34 122.8, 18 120.4, 5 118.7 ' +
  'C 1.4 117.9, 0 116, 0 113 L 0 12.3 ' +
  'C 0 11, 0.4 10.2, 1 9.9 L 5.2 9.9 ' +
  'C 7 9.9, 8.5 9.3, 11 8.2 C 15 5.6, 19.5 3.6, 24 3.2 ' +
  'C 27.5 2.4, 30.5 1, 33.5 0.3 L 37.5 0.3 ' +
  'C 38.8 1.6, 39.8 3.4, 41.8 4.3 L 44.1 4.3 ' +
  'C 46.4 3.2, 48.6 1.6, 50 0 Z';

/** Which metal the frame is struck in. Rank on the podium, standing on the pitch. */
export type ItemMetal = 'gold' | 'silver' | 'bronze' | 'steel' | 'warm';

/**
 * How much of the card survives at this size.
 *
 * Chosen by width rather than by which screen it is on, because the constraint
 * is legibility and legibility is a question about pixels. The real game makes
 * the same reduction: its podium cards carry a rating, a position and a
 * portrait, and drop the name and the six stats entirely.
 */
export type ItemTier = 'pitch' | 'podium' | 'full';

export function tierFor(width: number): ItemTier {
  if (width >= 180) return 'full';
  return width >= 80 ? 'podium' : 'pitch';
}

/**
 * Where the highlight sits down the rail.
 *
 * Nine stops rather than two, because a real rail does not ramp — it
 * oscillates: bright at the shoulder, falling to a trough through the middle,
 * brightening again into the point. Two stops of the same two colours read as
 * grey plastic, which is how the first attempt at these cards looked.
 *
 * Exported with the outline because the shareable PNG is drawn from the same
 * numbers. Two copies of a nine-stop ramp would drift the first time one moved.
 */
export const RAMP_STOPS = [0, 0.1, 0.22, 0.36, 0.5, 0.66, 0.78, 0.9, 1] as const;

export const METAL_RAMPS: Record<ItemMetal, readonly string[]> = {
  gold: ['#e8cf8a', '#f7e6ae', '#e0c274', '#c39a3c', '#a87e21', '#b98b2b', '#d9b45f', '#f2dfa2', '#fbf0c8'],
  silver: ['#dfe4ea', '#f2f5f9', '#ccd3dd', '#a6aeba', '#8f96a4', '#99a1af', '#bcc4d0', '#e4e9f0', '#f4f7fb'],
  bronze: ['#e2b48c', '#f2cfae', '#d09b6c', '#a97246', '#8d5b34', '#9c6740', '#c08a5c', '#e7c19c', '#f5ddc0'],
  steel: ['#cfe4f6', '#d9eefc', '#b7d2e6', '#86aecb', '#6a9bb8', '#6497b1', '#8ab4cf', '#c6dbef', '#e6f2fb'],
  warm: ['#ffd9d1', '#ffe6e0', '#f0b3a6', '#d98470', '#c25a48', '#cd6a56', '#e79c8a', '#ffd2cb', '#ffeae5'],
};

const METALS: Record<ItemMetal, string> = {
  gold: 'ff-ic-gold',
  silver: 'ff-ic-silver',
  bronze: 'ff-ic-bronze',
  steel: 'ff-ic-steel',
  warm: 'ff-ic-warm',
};

export function ItemCard({
  width,
  metal,
  rating,
  code,
  name,
  portrait,
  isMe,
  open,
  stats,
  tier: forced,
}: {
  /** The card's width in px. Everything else is derived from it. */
  width: number;
  metal: ItemMetal;
  /** The number the card wears, or null for a spot with nobody on it. */
  rating?: ReactNode;
  /** What that number counts — three letters under it. Podium and up. */
  code?: string;
  name?: string;
  /** The face, already sized by the caller. Clipped to the card. */
  portrait: ReactNode;
  isMe?: boolean;
  /**
   * Nobody here yet: the same silhouette, drawn as an outline waiting to be
   * filled rather than as a card with nothing on it. It keeps the shape so a
   * gap on the pitch is visibly a place for one of these, which a dashed
   * rectangle never was.
   */
  open?: boolean;
  /**
   * The six figures across the foot of the card, on the `full` tier only.
   *
   * Six because that is what an item wears, and because this app happens to
   * have exactly six numbers about a person that are true without being
   * derived from a formula. There is no seventh worth inventing.
   */
  stats?: readonly { label: string; value: number | string }[];
  /** Override the size ladder. Only for a caller that knows better. */
  tier?: ItemTier;
}) {
  const tier = forced ?? tierFor(width);
  const showCode = tier !== 'pitch' && code;
  // Below this the name is four characters of mush and the space is better
  // given to the face. Measured against the existing clamp floor, not guessed.
  const showName = name && (tier !== 'pitch' || width >= 40);

  return (
    <span
      className={`ic is-${tier}${isMe ? ' is-me' : ''}${open ? ' is-open' : ''}`}
      style={{ '--ic-w': `${width}px`, '--ic-metal': `url(#${METALS[metal]})` } as CSSProperties}
    >
      <span className="ic-portrait">{portrait}</span>
      {open ? null : <span className="ic-scrim" />}
      {/*
        The frame, over the portrait and under the text.

        `preserveAspectRatio="none"` is safe here and nowhere else in this app:
        the box is exactly 100 x 127 and the card is exactly `width` by
        `width * ITEM_CARD_RATIO`, so the scale is uniform and the strokes keep
        their weight in both directions.
      */}
      <svg
        className="ic-frame"
        viewBox="0 0 100 127"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {open ? null : <use href="#ff-ic-outline" className="ic-rail is-edge" />}
        <use href="#ff-ic-outline" className="ic-rail is-outer" />
        {!open && tier !== 'pitch' ? (
          <>
            <use href="#ff-ic-outline" className="ic-rail is-gap" />
            <use href="#ff-ic-outline" className="ic-rail is-inner" />
          </>
        ) : null}
        {/* Yours, said on the shape itself rather than with a box around it.
            Corner brackets have nowhere to sit on a silhouette with a spike at
            the top and a point at the bottom — they float off both ends. */}
        {isMe ? <use href="#ff-ic-outline" className="ic-rail is-mine" /> : null}
      </svg>

      {rating !== undefined && rating !== null ? (
        <span className="ic-rating">
          <strong>{rating}</strong>
          {showCode ? <small>{code}</small> : null}
        </span>
      ) : null}

      {showName ? <span className="ic-name truncate">{name}</span> : null}

      {tier === 'full' && stats?.length ? (
        <span className="ic-stats">
          {stats.map((stat) => (
            <span className="ic-stat" key={stat.label}>
              <small>{stat.label}</small>
              <strong>{stat.value}</strong>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The shared defs, rendered once for the whole app.
 *
 * Hoisted because `clipPath` defaults to `clipPathUnits="userSpaceOnUse"` and
 * every card shares one coordinate box, and because six nodes per card beats
 * twenty-two when a full pitch can hold sixty of them.
 *
 * Hidden with width/height 0 and `position: absolute`. NOT with `display: none`
 * — that silently breaks both the `clipPath` and every `<use>` that references
 * it, and the failure looks like blank cards rather than like a mistake. This
 * is a magnet for tidying; the comment is the guard.
 */
export function ItemCardDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <path id="ff-ic-outline" d={OUTLINE} />
        <clipPath id="ff-ic-clip" clipPathUnits="objectBoundingBox">
          {/* The same outline in a unit box, so CSS can clip HTML to it. */}
          <path d={OUTLINE} transform="scale(0.01, 0.0078740157)" />
        </clipPath>

        {/*
          The metal ramps.

          Nine stops rather than two, because a real rail does not ramp — it
          oscillates. Measured down the left edge of the reference: bright at
          the shoulder, falling to a trough through the middle two quarters,
          brightening again into the point. A two-stop gradient of the same two
          colours reads as grey plastic, which is exactly how the first attempt
          at these cards looked.
        */}
        {(Object.entries(METAL_RAMPS) as [ItemMetal, readonly string[]][]).map(([metal, ramp]) => (
          <linearGradient key={metal} id={METALS[metal]} x1="0" y1="0" x2="0.35" y2="1">
            {RAMP_STOPS.map((offset, index) => (
              <stop key={offset} offset={offset} stopColor={ramp[index]} />
            ))}
          </linearGradient>
        ))}

        {/* The interior. Navy on both themes — it is the item's own background,
            not the page's, and the rank is carried by the metal instead. */}
        <radialGradient id="ff-ic-ink" cx="50%" cy="28%" r="78%">
          <stop offset="0" stopColor="#16305c" />
          <stop offset="0.55" stopColor="#0b1e3d" />
          <stop offset="1" stopColor="#04091f" />
        </radialGradient>
      </defs>
    </svg>
  );
}
