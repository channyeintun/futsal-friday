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

/*
 * The taper, as two numbers rather than nineteen.
 *
 * Every marking on this field sits on the same receding plane, so every x in
 * the drawing is the same function of two things: how far across the field a
 * point is, and how far away. Those were hand-solved coordinates, which meant
 * widening the pitch was nineteen edits that had to agree with each other or
 * the mow stripes stopped meeting the touchlines.
 *
 * Now the plane is `x()` and these two half-widths are the whole shape of it.
 */
const FAR_HALF = 104;
const NEAR_HALF = 146;

/** Where the goal lines sit in the viewBox, and the centre of the field. */
const FAR_Y = 8;
const NEAR_Y = 392;
const MID_X = 150;

/**
 * A point on the plane.
 *
 * `across` runs -1 (left touchline) to 1 (right touchline) and is a real
 * position on the field, not on the screen: a thing that keeps the same
 * `across` at both ends of the pitch is the same number of metres wide at both
 * ends, and is drawn narrower at the far end for free.
 *
 * `depth` runs 0 (far goal line) to 1 (near one).
 */
const x = (across: number, depth: number) => {
  const half = FAR_HALF + (NEAR_HALF - FAR_HALF) * depth;
  return Number((MID_X + across * half).toFixed(2));
};

/** The y for a depth, so the two always move together. */
const y = (depth: number) => Number((FAR_Y + (NEAR_Y - FAR_Y) * depth).toFixed(2));

/** The touchlines and both goal lines, as one closed shape. */
const EDGE = `M${x(-1, 0)} ${FAR_Y} H${x(1, 0)} L${x(1, 1)} ${NEAR_Y} H${x(-1, 1)} Z`;

/*
 * Mown stripes, running goal to goal and converging with the field.
 *
 * Vertical rather than the horizontal bands this had before, because that is
 * the direction a groundsman actually walks it and the direction the reference
 * shows. Eight bands across the field, every other one drawn: each is a slice
 * of the same trapezoid, so they meet the touchlines exactly.
 */
const BANDS = 8;
const MOW = Array.from({ length: BANDS }, (_, band) => band)
  .filter((band) => band % 2 === 1)
  .map((band) => {
    const left = -1 + (2 / BANDS) * band;
    const right = left + 2 / BANDS;
    return `M${x(left, 0)} ${FAR_Y} H${x(right, 0)} L${x(right, 1)} ${NEAR_Y} H${x(left, 1)} Z`;
  });

/*
 * How wide each marking is in field widths, measured off the drawing this
 * replaces so the field is the same field, only wider.
 *
 * The two D's and the two goals do not share a number, and that is the
 * hand-drawn original showing through: strictly, a fixed six metres is one
 * `across` at both ends. They were tuned by eye to look right rather than to
 * measure right, and reading them back out preserves that judgement instead of
 * quietly redrawing the field while widening it.
 */
const FAR_D = 0.561;
const NEAR_D = 0.4085;
const FAR_GOAL = 0.2195;
const NEAR_GOAL = 0.1972;
const FAR_NET = 0.1463;
const NEAR_NET = 0.1268;
const CENTRE_CIRCLE = 0.4643;

/** Five posts across each goal mouth, spaced in field widths like everything else. */
const net = (goal: number, depth: number, from: number, to: number) =>
  Array.from({ length: 5 }, (_, post) => {
    const across = -goal + (goal * 2 * post) / 4;
    return `M${x(across, depth)} ${from} V${to}`;
  }).join(' ');

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
          <path d={EDGE} />
        </clipPath>
      </defs>

      {/* The far edge is narrower than the near one; every marking below is
          drawn to that same taper so the field reads as one plane. */}
      <path className="pitch-grass" d={EDGE} />

      <g clipPath="url(#ff-pitch-edge)">
        {MOW.map((stripe) => (
          <path className="pitch-mow" d={stripe} key={stripe} />
        ))}
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

      <path className="pitch-line" d={EDGE} vectorEffect="non-scaling-stroke" />

      {/* Halfway, and the centre circle as an ellipse — a circle on a receding
          plane is not a circle on the screen. */}
      <path
        className="pitch-line"
        d={`M${x(-1, 0.5)} ${y(0.5)} H${x(1, 0.5)}`}
        vectorEffect="non-scaling-stroke"
      />
      <ellipse
        className="pitch-line"
        cx={MID_X}
        cy={y(0.5)}
        rx={x(CENTRE_CIRCLE, 0.5) - MID_X}
        ry="26"
        vectorEffect="non-scaling-stroke"
      />
      <circle className="pitch-mark" cx={MID_X} cy={y(0.5)} r="2.5" />

      {/* Futsal's 6m D at each end, flattened by the same amount as the circle.
          This single shape is what stops the drawing reading as soccer. */}
      <path
        className="pitch-line"
        d={`M${x(-FAR_D, 0)} ${FAR_Y} A${x(FAR_D, 0) - MID_X} 30 0 0 0 ${x(FAR_D, 0)} ${FAR_Y}`}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="pitch-line"
        d={`M${x(-NEAR_D, 1)} ${NEAR_Y} A${x(NEAR_D, 1) - MID_X} 34 0 0 1 ${x(NEAR_D, 1)} ${NEAR_Y}`}
        vectorEffect="non-scaling-stroke"
      />
      <circle className="pitch-mark" cx={MID_X} cy="52" r="2" />
      <circle className="pitch-mark" cx={MID_X} cy="342" r="2" />

      {/* Goals, on the goal lines, narrowing with the field. */}
      <path
        className="pitch-goal"
        d={`M${x(-FAR_GOAL, 0)} ${FAR_Y} H${x(FAR_GOAL, 0)}`}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="pitch-goal"
        d={`M${x(-NEAR_GOAL, 1)} ${NEAR_Y} H${x(NEAR_GOAL, 1)}`}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="pitch-net"
        d={`${net(FAR_NET, 0, FAR_Y, 2)} ${net(NEAR_NET, 1, NEAR_Y, 399)}`}
      />
    </svg>
  );
}
