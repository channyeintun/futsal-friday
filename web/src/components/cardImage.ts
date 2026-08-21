import { initialsOf } from '@futsal/shared';
import { METAL_RAMPS, OUTLINE, RAMP_STOPS, type ItemMetal } from './ItemCard.js';

/**
 * The card again, as a picture somebody can send.
 *
 * A second drawing of the same object, and that needs justifying. The card on
 * screen is HTML text over an SVG frame, and neither half survives being turned
 * into an image: there is no way to rasterise a live DOM subtree without
 * shipping a library that reimplements layout, and the half that *is* already
 * SVG cannot reach the HTML sitting on top of it. So this draws the whole card
 * as one self-contained SVG, from the same outline and the same metal ramps the
 * component uses — imported rather than copied, because two nine-stop gradients
 * would drift the first time one of them moved.
 *
 * ## Self-contained is not a nicety here
 *
 * An SVG rasterised through an `<img>` runs in a mode with no network at all:
 * no stylesheet, no web font, no remote image. Everything has to be inline —
 * which is why the portrait is read out of the blob the app already has and
 * embedded as a data URL, and why the type is asked for by generic family
 * rather than by the app's token. The families named are the ones the app's own
 * stack resolves to on a phone, so a shared card looks like the card it came
 * from rather than like Times New Roman.
 *
 * ## Burmese
 *
 * A name in Myanmar script rasterises with whatever the device has, which on
 * both Android and iOS is a real Burmese face. It cannot be measured here the
 * way the DOM measures it, so the name is given a generous box and centred
 * rather than fitted — a long name comes out smaller, not clipped.
 */

/** The card's own coordinate box, shared with `ItemCard`. */
const W = 100;
const H = 127;

/**
 * Where the picture stops, as a share of the card's height.
 *
 * 73%, which is the same fraction the live card crops at — so the band the
 * figures sit on is the same band in both drawings rather than two numbers that
 * happen to look similar today.
 */
const PORTRAIT_H = H * 0.73;

/*
 * The scene the card is standing in, and where it stands.
 *
 * A card alone on transparency arrives in a chat thread sitting on whatever
 * that app's background happens to be — usually white, which is the one colour
 * this card was never designed against, and it reads as a sticker somebody
 * cut out. Giving it its own night gives the share a picture rather than an
 * asset, and it costs nothing: every part of it is a gradient, so there is
 * still no file to fetch.
 */
const SCENE_W = 140;
const SCENE_H = 182;
const CARD_X = 20;
const CARD_Y = 24;

/** Above the top edge, so the beams' vertex is out of shot. */
const BEAM_Y = -46;

/** Angle from vertical, and half-width where the beam leaves the frame. */
const BEAMS: readonly (readonly [number, number])[] = [
  [-42, 18],
  [-16, 11],
  [15, 22],
  [39, 9],
];

/**
 * How many device pixels per card unit.
 *
 * Six over the scene gives 840x1092: big enough to look sharp when a chat app
 * blows it up, small enough that the PNG stays a few hundred kilobytes on a
 * phone uploading over whatever network there is at a futsal pitch.
 */
const SCALE = 6;

/*
 * Drawn this many times over and averaged down.
 *
 * The frame is a stroke clipped to its own outline, and a clip is rasterised
 * into a bitmap as a one-bit mask — a pixel is in or it is out, with nothing in
 * between. Every curve on the silhouette therefore came out as a visible
 * staircase however large the image was: more pixels only made smaller steps,
 * never softer ones.
 *
 * Rendering at twice the final size and letting the browser filter it down
 * gives each edge pixel four samples to average, which is what turns the
 * staircase back into an edge. Two rather than three because the intermediate
 * bitmap is the constraint: at 2x this is 1680x2184, a shade under four
 * megapixels, and older iPhones refuse a canvas much past five.
 */
const SUPERSAMPLE = 2;

export interface CardImage {
  name: string;
  /** The app's own name, along the foot. Passed in so it stays translatable. */
  footer: string;
  rating: number | string;
  code: string;
  metal: ItemMetal;
  stats: readonly { label: string; value: number | string }[];
  /** The member's picture, straight from the query cache. */
  portrait: Blob | null;
}

/**
 * Draw the card and hand back a PNG.
 *
 * Resolves null rather than throwing on any failure — a share that cannot be
 * prepared is a toast, not a broken screen.
 */
export async function cardToPng(card: CardImage): Promise<Blob | null> {
  try {
    const href = card.portrait ? await dataUrl(card.portrait) : null;
    const svg = cardSvg(card, href);
    const width = SCENE_W * SCALE;
    const height = SCENE_H * SCALE;

    const image = new Image();
    image.width = width * SUPERSAMPLE;
    image.height = height * SUPERSAMPLE;
    // `charset` matters: a Burmese name is multi-byte and the default for a
    // data URL is US-ASCII, which turns it into mojibake.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    // The averaging step. Without asking for it explicitly some browsers pick
    // a nearest-neighbour path for large reductions, which would throw away
    // exactly the samples this was rendered oversized to collect.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null;
  }
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** XML, so a name with an ampersand in it does not end the document. */
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    character === '&'
      ? '&amp;'
      : character === '<'
        ? '&lt;'
        : character === '>'
          ? '&gt;'
          : character === '"'
            ? '&quot;'
            : '&apos;',
  );
}

const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans Myanmar',sans-serif";

/**
 * Where to centre the code under the number above it.
 *
 * The DOM centres the two on each other with a flex column; SVG has no layout,
 * so the number's width has to be estimated. Digits in this weight run about
 * six tenths of the em, which is close enough that a one-digit and a two-digit
 * rating both sit right — and being a little off is invisible, where letting it
 * anchor at a fixed x put the code half over the left rail.
 */
function codeCentre(rating: number | string): number {
  return 9.5 + (String(rating).length * 18.5 * 0.6) / 2;
}

function cardSvg(card: CardImage, portrait: string | null): string {
  const ramp = METAL_RAMPS[card.metal];
  const stops = RAMP_STOPS.map(
    (offset, index) => `<stop offset="${offset}" stop-color="${ramp[index]}"/>`,
  ).join('');

  // Six columns, centred on the same closed form the DOM grid produces.
  const columns = card.stats.map((_, index) => 6 + ((W - 12) / 6) * (index + 0.5));

  /*
   * The picture stops short of the figures, as it does on the live card.
   *
   * A square crop ends in a hard horizontal edge, and running it down to its
   * full width would put that edge directly behind the first row of stat
   * labels. `slice` still fills the box and crops what does not fit, so the
   * face stays the same size — only the bottom of the frame moves up.
   */
  const face = portrait
    ? `<image href="${portrait}" x="0" y="0" width="${W}" height="${PORTRAIT_H}" preserveAspectRatio="xMidYMid slice"/>`
    : `<text x="${W / 2}" y="${PORTRAIT_H * 0.6}" text-anchor="middle" fill="#fff"
         font-family="${FONT}" font-size="${W * 0.26}" font-weight="700"
         >${escapeXml(initialsOf(card.name))}</text>`;

  const stats = card.stats
    .map(
      (stat, index) => `
      <text x="${columns[index]}" y="105.5" text-anchor="middle" fill="#fff" fill-opacity="0.85"
        font-family="${FONT}" font-size="3.8" font-weight="700">${escapeXml(stat.label)}</text>
      <text x="${columns[index]}" y="111.5" text-anchor="middle" fill="#fff"
        font-family="${FONT}" font-size="5.2" font-weight="800">${escapeXml(String(stat.value))}</text>`,
    )
    .join('');

  /*
   * Light coming from behind the card, the way a pack lands.
   *
   * Four beams of uneven angle and width, because an even fan reads as a clock
   * face. They converge well above the top edge rather than on it: a vertex
   * inside the picture is a starburst, and what this wants is shafts that were
   * already going when the frame caught them. Drawn under the card, so it is
   * lit from behind rather than washed over.
   */
  const beams = BEAMS
    .map(
      ([angle, spread]) =>
        `<polygon points="${SCENE_W / 2},${BEAM_Y} ${SCENE_W / 2 - spread},${SCENE_H} ${SCENE_W / 2 + spread},${SCENE_H}"
           fill="url(#beam)" transform="rotate(${angle} ${SCENE_W / 2} ${BEAM_Y})"/>`,
    )
    .join('');

  /* Out-of-focus floodlights. Radial stops rather than a blur filter, which is
     slow to rasterise and unevenly supported inside an `<img>`. */
  const bokeh = [
    [26, 40, 13],
    [116, 30, 9],
    [22, 132, 11],
    [122, 118, 15],
    [70, 168, 10],
  ]
    .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#bok)"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SCENE_W * SCALE * SUPERSAMPLE}" height="${SCENE_H * SCALE * SUPERSAMPLE}" viewBox="0 0 ${SCENE_W} ${SCENE_H}">
  <defs>
    <path id="o" d="${OUTLINE}"/>
    <clipPath id="c"><use href="#o"/></clipPath>
    <linearGradient id="m" x1="0" y1="0" x2="0.35" y2="1">${stops}</linearGradient>
    <radialGradient id="ink" cx="50%" cy="28%" r="78%">
      <stop offset="0" stop-color="#16305c"/>
      <stop offset="0.55" stop-color="#0b1e3d"/>
      <stop offset="1" stop-color="#04091f"/>
    </radialGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.52" stop-color="#040a20" stop-opacity="0"/>
      <stop offset="0.74" stop-color="#040a20" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#040a20" stop-opacity="0.7"/>
    </linearGradient>
    <radialGradient id="night" cx="50%" cy="26%" r="86%">
      <stop offset="0" stop-color="#1b4470"/>
      <stop offset="0.45" stop-color="#0d2244"/>
      <stop offset="1" stop-color="#04070f"/>
    </radialGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#bfe4ff" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="#8ec8ff" stop-opacity="0.07"/>
      <stop offset="1" stop-color="#8ec8ff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="bok">
      <stop offset="0" stop-color="#9fd4ff" stop-opacity="0.30"/>
      <stop offset="0.6" stop-color="#9fd4ff" stop-opacity="0.09"/>
      <stop offset="1" stop-color="#9fd4ff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="halo">
      <stop offset="0" stop-color="${ramp[1]}" stop-opacity="0.55"/>
      <stop offset="0.55" stop-color="${ramp[4]}" stop-opacity="0.18"/>
      <stop offset="1" stop-color="${ramp[4]}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vig" cx="50%" cy="45%" r="72%">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.55"/>
    </radialGradient>
  </defs>

  <rect width="${SCENE_W}" height="${SCENE_H}" fill="url(#night)"/>
  ${beams}
  ${bokeh}
  {/* The card's own metal, thrown onto the air behind it. */}
  <ellipse cx="${SCENE_W / 2}" cy="${CARD_Y + H * 0.45}" rx="${W * 0.82}" ry="${H * 0.6}" fill="url(#halo)"/>
  <rect width="${SCENE_W}" height="${SCENE_H}" fill="url(#vig)"/>

  <g transform="translate(${CARD_X} ${CARD_Y})">
    <g clip-path="url(#c)">
      <rect width="${W}" height="${H}" fill="url(#ink)"/>
      ${face}
      <rect width="${W}" height="${H}" fill="url(#scrim)"/>
      <use href="#o" fill="none" stroke="rgba(2,6,20,0.55)" stroke-width="11" stroke-linejoin="round"/>
      <use href="#o" fill="none" stroke="url(#m)" stroke-width="8.4" stroke-linejoin="round"/>
      <use href="#o" fill="none" stroke="#0b1e3d" stroke-width="4.9" stroke-linejoin="round"/>
      <use href="#o" fill="none" stroke="url(#m)" stroke-width="3.5" stroke-linejoin="round"/>
    </g>
    <text x="9.5" y="24" fill="#fff" font-family="${FONT}" font-size="18.5" font-weight="800"
      >${escapeXml(String(card.rating))}</text>
    <text x="${codeCentre(card.rating)}" y="31.5" text-anchor="middle" fill="#fff"
      font-family="${FONT}" font-size="7" font-weight="700">${escapeXml(card.code)}</text>
    <text x="${W / 2}" y="90" text-anchor="middle" fill="#fff" font-family="${FONT}"
      font-size="8.8" font-weight="700">${escapeXml(card.name)}</text>
    ${stats}
  </g>

  <text x="${SCENE_W / 2}" y="${SCENE_H - 8}" text-anchor="middle" fill="#fff" fill-opacity="0.5"
    font-family="${FONT}" font-size="5.6" font-weight="700"
    letter-spacing="0.9">${escapeXml(card.footer)}</text>
</svg>`;
}
