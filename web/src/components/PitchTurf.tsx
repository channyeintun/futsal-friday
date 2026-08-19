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
      <defs>
        {/*
          Floodlight falloff.

          Sampled off the real thing: the middle of the pitch sits around
          #2e3d2a and the touchlines drop to #1e271a — a much heavier vignette
          than a flat fill suggests, and most of why a photograph of a pitch
          does not look like a green rectangle.
        */}
        <radialGradient id="ff-pitch-lighting" cx="50%" cy="44%" r="66%">
          <stop className="pitch-vignette-in" offset="0%" />
          <stop className="pitch-vignette-mid" offset="55%" />
          <stop className="pitch-vignette-out" offset="100%" />
        </radialGradient>
        <clipPath id="ff-pitch-edge">
          <path d="M68 8 H232 L292 392 H8 Z" />
        </clipPath>
      </defs>

      {/* The far edge is narrower than the near one; every marking below is
          drawn to that same taper so the field reads as one plane. */}
      <path className="pitch-grass" d="M68 8 H232 L292 392 H8 Z" />

      {/*
        Mown stripes, running goal to goal and converging with the field.

        Vertical rather than the horizontal bands this had before, because that
        is the direction a groundsman actually walks it and the direction the
        reference shows. Each one is a slice of the same trapezoid, so they meet
        the touchlines exactly.
      */}
      <g clipPath="url(#ff-pitch-edge)">
      <path className="pitch-mow" d="M88.5 8 H109.0 L79.0 392 H43.5 Z" />
      <path className="pitch-mow" d="M129.5 8 H150.0 L150.0 392 H114.5 Z" />
      <path className="pitch-mow" d="M170.5 8 H191.0 L221.0 392 H185.5 Z" />
      <path className="pitch-mow" d="M211.5 8 H232.0 L292.0 392 H256.5 Z" />
      </g>

      {/* Over the grass and under the markings, so the lines stay crisp at the
          edges where the light has fallen away. */}
      <rect
        className="pitch-vignette"
        width="300"
        height="400"
        fill="url(#ff-pitch-lighting)"
        clipPath="url(#ff-pitch-edge)"
      />

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
