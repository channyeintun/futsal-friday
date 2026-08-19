/**
 * The field, drawn in perspective.
 *
 * A trapezoid rather than a rectangle put through `rotateX`, and that is a
 * decision rather than a shortcut. A CSS 3D rotation tilts everything inside it
 * — cards included — and a card in a perspective is projected whether or not it
 * has been counter-rotated upright, which is what made the first attempt look
 * skewed. Worse, the tilted box and the flat rows stop agreeing about how tall
 * they are, so the rows spill out of the pitch.
 *
 * Drawing the recession into the geometry instead keeps every card square to
 * the screen and keeps one number — the box height — describing both layers.
 *
 * Inline SVG for the same reason as `Icon`: an external file cannot read
 * `--md-sys-color-*`, and no `var()` appears in a presentation attribute here
 * because WebKit is unreliable with those. Every colour arrives from a rule in
 * `styles.css` matched on these class names.
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
      {/* The far edge is narrower than the near one; every marking below is
          drawn to that same taper so the field reads as one plane. */}
      <path className="pitch-grass" d="M68 8 H232 L292 392 H8 Z" />

      {/* Mown bands, each one a slice of the same trapezoid. */}
      <path className="pitch-mow" d="M79.5 82 H220.5 L232 158 H68 Z" />
      <path className="pitch-mow" d="M91 234 H209 L220.5 310 H79.5 Z" />

      <path className="pitch-line" d="M68 8 H232 L292 392 H8 Z" vectorEffect="non-scaling-stroke" />

      {/* Halfway, and the centre circle as an ellipse — a circle on a receding
          plane is not a circle on the screen. */}
      <path className="pitch-line" d="M38 200 H262" vectorEffect="non-scaling-stroke" />
      <ellipse
        className="pitch-line"
        cx="150"
        cy="200"
        rx="52"
        ry="26"
        vectorEffect="non-scaling-stroke"
      />
      <circle className="pitch-mark" cx="150" cy="200" r="2.5" />

      {/* Futsal's 6m D at each end, flattened by the same amount as the circle.
          This single shape is what stops the drawing reading as soccer. */}
      <path
        className="pitch-line"
        d="M104 8 A46 30 0 0 0 196 8"
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="pitch-line"
        d="M92 392 A58 34 0 0 1 208 392"
        vectorEffect="non-scaling-stroke"
      />
      <circle className="pitch-mark" cx="150" cy="52" r="2" />
      <circle className="pitch-mark" cx="150" cy="342" r="2" />

      {/* Goals, on the goal lines, narrowing with the field. */}
      <path className="pitch-goal" d="M132 8 H168" vectorEffect="non-scaling-stroke" />
      <path className="pitch-goal" d="M122 392 H178" vectorEffect="non-scaling-stroke" />
      <path
        className="pitch-net"
        d="M138 8 V2 M144 8 V2 M150 8 V2 M156 8 V2 M162 8 V2
           M132 392 V399 M141 392 V399 M150 392 V399 M159 392 V399 M168 392 V399"
      />
    </svg>
  );
}
