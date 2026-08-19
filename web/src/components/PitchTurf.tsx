/**
 * The field itself: turf, mown bands and the markings.
 *
 * Inline SVG in TSX for the same reason `Icon` is — an external file cannot
 * read `--md-sys-color-*` and would need one copy per theme. No `var()` in any
 * presentation attribute either: WebKit is unreliable there, and WebKit is most
 * of this group. Every colour arrives from a rule in `styles.css` matched on
 * these class names.
 *
 * `preserveAspectRatio="none"` because the box is whatever height the line
 * count produced, and the markings should frame it exactly rather than letterbox
 * inside it. The squash that permits is why the bands are horizontal — they are
 * the one element that would look wrong stretched the other way — and why every
 * stroked shape carries `vectorEffect="non-scaling-stroke"` individually, which
 * does not inherit from a wrapping group.
 *
 * It is a futsal pitch, not a football one. The 6m D struck from the posts,
 * rather than a rectangular box, is the single shape doing that work.
 */
export function PitchTurf() {
  return (
    <svg
      className="pitch-turf"
      viewBox="0 0 300 400"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="pitch-grass" width="300" height="400" />

      {/* The way a groundsman walks it. */}
      <rect className="pitch-mow" y="50" width="300" height="50" />
      <rect className="pitch-mow" y="150" width="300" height="50" />
      <rect className="pitch-mow" y="250" width="300" height="50" />
      <rect className="pitch-mow" y="350" width="300" height="50" />

      <rect
        className="pitch-line"
        x="7"
        y="7"
        width="286"
        height="386"
        rx="3"
        vectorEffect="non-scaling-stroke"
      />
      <path className="pitch-line" d="M7 200 H293" vectorEffect="non-scaling-stroke" />
      <circle className="pitch-line" cx="150" cy="200" r="42" vectorEffect="non-scaling-stroke" />

      {/* Two quarter-circles struck from the posts, joined by a straight run. */}
      <path
        className="pitch-line"
        d="M46 7 A82 82 0 0 0 128 89 H172 A82 82 0 0 0 254 7"
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="pitch-line"
        d="M46 393 A82 82 0 0 1 128 311 H172 A82 82 0 0 1 254 393"
        vectorEffect="non-scaling-stroke"
      />

      {/* Really 25cm, which disappears at this size, so drawn the way a
          broadcast camera flatters them. */}
      <path className="pitch-line" d="M7 16 A9 9 0 0 0 16 7" vectorEffect="non-scaling-stroke" />
      <path className="pitch-line" d="M284 7 A9 9 0 0 0 293 16" vectorEffect="non-scaling-stroke" />
      <path
        className="pitch-line"
        d="M293 384 A9 9 0 0 0 284 393"
        vectorEffect="non-scaling-stroke"
      />
      <path className="pitch-line" d="M16 393 A9 9 0 0 0 7 384" vectorEffect="non-scaling-stroke" />

      {/* Outside the goal line, where they are actually painted. */}
      <rect
        className="pitch-goal"
        x="129"
        y="1"
        width="42"
        height="6"
        rx="1"
        vectorEffect="non-scaling-stroke"
      />
      <rect
        className="pitch-goal"
        x="129"
        y="393"
        width="42"
        height="6"
        rx="1"
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="pitch-net"
        d="M136 1 V7 M143 1 V7 M150 1 V7 M157 1 V7 M164 1 V7
           M136 393 V399 M143 393 V399 M150 393 V399 M157 393 V399 M164 393 V399"
      />

      <circle className="pitch-mark" cx="150" cy="200" r="2.5" />
      <circle className="pitch-mark" cx="150" cy="89" r="2.5" />
      <circle className="pitch-mark" cx="150" cy="311" r="2.5" />
    </svg>
  );
}
