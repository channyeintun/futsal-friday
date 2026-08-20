import { useEffect, useRef, useState } from 'react';

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
 * It also made the recession switchable for free, which a CSS rotation could
 * not have been: with the plane already a function of depth, drawing the field
 * flat is the same drawing with the far end as wide as the near one. Nothing
 * else in this file knows which of the two it is producing — see `flat`.
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

/*
 * Flat is the same field with the taper taken out, not a different drawing.
 *
 * Both ends at the near width rather than at the far one: a flat pitch that
 * shrank to the far end would waste the card's width and look like the same
 * pitch further away, which is the opposite of what switching this off is for.
 */
const halves = (flat: boolean) => ({
  far: flat ? NEAR_HALF : FAR_HALF,
  near: NEAR_HALF,
});

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
const x = (across: number, depth: number, flat: boolean) => {
  const { far, near } = halves(flat);
  const half = far + (near - far) * depth;
  return Number((MID_X + across * half).toFixed(2));
};

/** The y for a depth, so the two always move together. */
const y = (depth: number) => Number((FAR_Y + (NEAR_Y - FAR_Y) * depth).toFixed(2));

/** The touchlines and both goal lines, as one closed shape. */
const edge = (flat: boolean) =>
  `M${x(-1, 0, flat)} ${FAR_Y} H${x(1, 0, flat)} L${x(1, 1, flat)} ${NEAR_Y} H${x(-1, 1, flat)} Z`;

/*
 * Mown stripes, running goal to goal and converging with the field.
 *
 * Vertical rather than the horizontal bands this had before, because that is
 * the direction a groundsman actually walks it and the direction the reference
 * shows. Eight bands across the field, every other one drawn: each is a slice
 * of the same trapezoid, so they meet the touchlines exactly.
 */
const BANDS = 8;
const mow = (flat: boolean) =>
  Array.from({ length: BANDS }, (_, band) => band)
    .filter((band) => band % 2 === 1)
    .map((band) => {
      const left = -1 + (2 / BANDS) * band;
      const right = left + 2 / BANDS;
      return (
        `M${x(left, 0, flat)} ${FAR_Y} H${x(right, 0, flat)} ` +
        `L${x(right, 1, flat)} ${NEAR_Y} H${x(left, 1, flat)} Z`
      );
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

/*
 * Flat uses the near figure at both ends, and the reason is the paragraph
 * above.
 *
 * These are fractions of the half-width at the end they sit on, and in
 * perspective those half-widths differ — so `0.561` of the narrow far end and
 * `0.4085` of the wide near one come out at 58.3 and 59.6, near enough the same
 * six metres. Take the taper away and both ends measure against the near width,
 * where the same two fractions come out at 81.9 and 59.6: the D at the top of a
 * flat pitch was drawn a third wider than the one at the bottom, and the goal
 * and its net with it.
 *
 * The near figure is the one to keep. It is already measured against the width
 * both ends now have, so the bottom of the field does not move and only the top
 * is corrected — and a pitch seen from above has one D, drawn twice.
 */
const ends = (flat: boolean) => ({
  farD: flat ? NEAR_D : FAR_D,
  nearD: NEAR_D,
  farGoal: flat ? NEAR_GOAL : FAR_GOAL,
  nearGoal: NEAR_GOAL,
  farNet: flat ? NEAR_NET : FAR_NET,
  nearNet: NEAR_NET,
});

/*
 * The round markings, one set of numbers per mode.
 *
 * Perspective keeps the hand-drawn figures verbatim — 26, 30, 34, and two
 * penalty spots that are not symmetric about the halfway line — for the same
 * reason the two D widths above are not made consistent: they were tuned by eye
 * and this is a switch for the taper, not licence to redraw a field somebody
 * already looked at.
 *
 * Flat derives its radii instead, because there is nothing to preserve there:
 * with the taper gone the markings should be round, and round means a fixed
 * fraction of their own width. `preserveAspectRatio="none"` stretches this
 * viewBox to fill the card, so equal radii would still draw an oval; the
 * fraction is measured off the card as it actually renders. Its spots are
 * symmetric, because on a flat field there is no reason for them not to be.
 */
const MARKS = {
  perspective: { centreRy: 26, farDRy: 30, nearDRy: 34, farSpot: 52, nearSpot: 342 },
};

/*
 * What a circle's vertical radius has to be, as a fraction of its horizontal
 * one, to come back out round — measured, because it cannot be a constant.
 *
 * `preserveAspectRatio="none"` maps 300 viewBox units onto the card's width and
 * 400 onto its height, so the two axes are scaled by different amounts and a
 * circle drawn with equal radii renders as an oval. The correction is the ratio
 * between those scales, and the card's shape is not fixed: it is as wide as the
 * screen allows and as tall as the formation needs, so a twelve-a-side pitch is
 * a different shape from a six-a-side one on the same phone.
 *
 * This is the starting guess for the first paint only; the real figure arrives
 * from the element itself a frame later.
 */
const FLAT_SQUASH = 1.14;
/** Six metres from the goal line, as a depth rather than another y. */
const FLAT_SPOT = 0.1146;

/** Five posts across each goal mouth, spaced in field widths like everything else. */
const net = (goal: number, depth: number, from: number, to: number, flat: boolean) =>
  Array.from({ length: 5 }, (_, post) => {
    const across = -goal + (goal * 2 * post) / 4;
    return `M${x(across, depth, flat)} ${from} V${to}`;
  }).join(' ');

export function PitchTurf({ flat = false }: { flat?: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const [squash, setSquash] = useState(FLAT_SQUASH);

  /*
   * Ask the element what shape it turned out to be.
   *
   * Only while flat: in perspective the round markings are hand-tuned figures
   * that must not move, and measuring would be a licence to move them.
   */
  useEffect(() => {
    const element = ref.current;
    if (!flat || !element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) setSquash((400 * box.width) / (300 * box.height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [flat]);

  const EDGE = edge(flat);
  const at = (across: number, depth: number) => x(across, depth, flat);
  /*
   * How far the round markings are squashed.
   *
   * In perspective they are ellipses because a circle on a receding plane is
   * not a circle on the screen. Flat, they should be circles — but the viewBox
   * is stretched to the card with `preserveAspectRatio="none"`, so equal radii
   * here would still draw an oval. `FLAT_SQUASH` is the ratio that comes back
   * out round at the size this card actually renders; it is a measured number,
   * like the two half-widths above.
   */
  const round = (value: number) => Number(value.toFixed(2));
  // Subtracting two rounded numbers is not a rounded number — `0.4643 * 125`
  // came back out of the arithmetic as 67.78999999999999 and went into the
  // attribute that way.
  const centreRx = round(at(CENTRE_CIRCLE, 0.5) - MID_X);
  const mark = ends(flat);
  const farDRx = round(at(mark.farD, 0) - MID_X);
  const nearDRx = round(at(mark.nearD, 1) - MID_X);
  const marks = flat
    ? {
        centreRy: round(centreRx * squash),
        farDRy: round(farDRx * squash),
        nearDRy: round(nearDRx * squash),
        farSpot: y(FLAT_SPOT),
        nearSpot: y(1 - FLAT_SPOT),
      }
    : MARKS.perspective;

  return (
    <svg
      ref={ref}
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

      {/* Every marking below is drawn to the same taper — none at all, when
          this device has asked for a flat field — so it reads as one plane. */}
      <path className="pitch-grass" d={EDGE} />

      <g clipPath="url(#ff-pitch-edge)">
        {mow(flat).map((stripe) => (
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

      {/* Halfway, and the centre circle. */}
      <path
        className="pitch-line"
        d={`M${at(-1, 0.5)} ${y(0.5)} H${at(1, 0.5)}`}
        vectorEffect="non-scaling-stroke"
      />
      <ellipse
        className="pitch-line"
        cx={MID_X}
        cy={y(0.5)}
        rx={centreRx}
        ry={marks.centreRy}
        vectorEffect="non-scaling-stroke"
      />
      <circle className="pitch-mark" cx={MID_X} cy={y(0.5)} r="2.5" />

      {/* Futsal's 6m D at each end, flattened by the same amount as the circle.
          This single shape is what stops the drawing reading as soccer. */}
      <path
        className="pitch-line"
        d={`M${at(-mark.farD, 0)} ${FAR_Y} A${farDRx} ${marks.farDRy} 0 0 0 ${at(mark.farD, 0)} ${FAR_Y}`}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="pitch-line"
        d={`M${at(-mark.nearD, 1)} ${NEAR_Y} A${nearDRx} ${marks.nearDRy} 0 0 1 ${at(mark.nearD, 1)} ${NEAR_Y}`}
        vectorEffect="non-scaling-stroke"
      />
      <circle className="pitch-mark" cx={MID_X} cy={marks.farSpot} r="2" />
      <circle className="pitch-mark" cx={MID_X} cy={marks.nearSpot} r="2" />

      {/* Goals, on the goal lines, narrowing with the field. */}
      <path
        className="pitch-goal"
        d={`M${at(-mark.farGoal, 0)} ${FAR_Y} H${at(mark.farGoal, 0)}`}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="pitch-goal"
        d={`M${at(-mark.nearGoal, 1)} ${NEAR_Y} H${at(mark.nearGoal, 1)}`}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="pitch-net"
        d={`${net(mark.farNet, 0, FAR_Y, 2, flat)} ${net(mark.nearNet, 1, NEAR_Y, 399, flat)}`}
      />
    </svg>
  );
}
