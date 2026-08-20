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
 * How many device pixels per card unit.
 *
 * Six gives a 600x762 image: big enough to look sharp when a chat app blows it
 * up, small enough that the PNG stays a couple of hundred kilobytes on a phone
 * that has to upload it over the network it has at a futsal pitch.
 */
const SCALE = 6;

export interface CardImage {
  name: string;
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
    const image = new Image();
    image.width = W * SCALE;
    image.height = H * SCALE;
    // `charset` matters: a Burmese name is multi-byte and the default for a
    // data URL is US-ASCII, which turns it into mojibake.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();

    const canvas = document.createElement('canvas');
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
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

  const face = portrait
    ? `<image href="${portrait}" x="0" y="0" width="${W}" height="${W}" preserveAspectRatio="xMidYMid slice"/>`
    : `<text x="${W / 2}" y="${W * 0.56}" text-anchor="middle" fill="#fff"
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

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}">
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
  </defs>
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
  <text x="${W / 2}" y="95" text-anchor="middle" fill="#fff" font-family="${FONT}"
    font-size="8.8" font-weight="700">${escapeXml(card.name)}</text>
  ${stats}
</svg>`;
}
