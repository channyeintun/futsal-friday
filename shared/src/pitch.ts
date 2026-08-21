import type { RegistrationStatus, TeamSlot } from './models.js';

/**
 * The pitch: who is down to play, drawn as spots on a field.
 *
 * The registration screen used to be a button and a list, which answered "who
 * is coming?" and nothing else. A field of spots answers the same question
 * faster — you count the gaps, not the names — and it makes the one thing the
 * screen is for into a target rather than a sentence: an empty spot is a place
 * to stand, and standing in it is the whole of signing up.
 *
 * Everything here is pure arithmetic over the roster, kept beside the team
 * draw rather than in the component, because the two have to agree about what
 * a "spot" is. They already do: this deals guests out as bodies of their own,
 * exactly as `arrivedSlots` does, and counts heads the way the server's cap
 * check counts them — `SUM(1 + guests)`.
 */

/** What a spot needs to know about a registration. Anything wider is noise. */
export interface PitchCandidate {
  memberId: string;
  memberName: string;
  memberAvatarUpdatedAt?: string | null;
  /** Friends they are bringing. Each one takes a spot of its own. */
  guests?: number | null;
  status: RegistrationStatus;
}

/**
 * Every body that is down to play, one spot each.
 *
 * The registration-time twin of `arrivedSlots`. That one asks who turned up
 * and is what the bill and the draw are built on; this one asks who is *in*,
 * which is the question the pitch draws days before anybody kicks anything.
 *
 * Waitlisted parties are deliberately absent. Having no spot on the pitch is
 * the entire meaning of the waitlist, and a bench that showed them standing on
 * it would be the screen contradicting the button.
 */
export function registeredSlots(candidates: readonly PitchCandidate[]): TeamSlot[] {
  return slotsWithStatus(candidates, 'in');
}

/**
 * Everybody waiting, one spot each.
 *
 * The same bodies-not-rows expansion, for the touchline. This exists because
 * the pitch is now the only way in or out: with no button beside it, somebody
 * on the waitlist would have nothing to press to leave, and somebody arriving
 * at a full pitch would have nothing to press at all.
 */
export function waitingSlots(candidates: readonly PitchCandidate[]): TeamSlot[] {
  return slotsWithStatus(candidates, 'waitlist');
}

function slotsWithStatus(
  candidates: readonly PitchCandidate[],
  status: RegistrationStatus,
): TeamSlot[] {
  const slots: TeamSlot[] = [];

  for (const candidate of candidates) {
    if (candidate.status !== status) continue;
    const base = {
      memberId: candidate.memberId,
      memberName: candidate.memberName,
      memberAvatarUpdatedAt: candidate.memberAvatarUpdatedAt ?? null,
    };
    slots.push({ ...base, guestIndex: 0 });
    for (let guest = 1; guest <= Math.max(0, candidate.guests ?? 0); guest++) {
      slots.push({ ...base, guestIndex: guest });
    }
  }

  return slots;
}

/**
 * How many spots to draw on the field.
 *
 * Three cases, and the middle one is the reason this is a function rather than
 * `session.maxPlayers`:
 *
 * 1. **A cap, room to spare.** The cap is the number of spots. The unfilled
 *    ones are what makes the screen worth looking at.
 * 2. **A cap the roster has outgrown.** The organizer may lower the cap at any
 *    time and the server only ever *promotes* — nothing demotes — so twelve
 *    people can be `in` against a cap of eight. Drawing eight spots would hide
 *    four people who are genuinely playing, so the roster wins.
 * 3. **No cap**, which is most weeks. There is no number to draw ghosts up to,
 *    so the field is exactly the people on it plus the single open spot that
 *    says you can still join.
 *
 * And over all three, one rule: an empty spot is an offer, so once registration
 * has closed there are none. The pitch stays on the screen for every session,
 * including ones played months ago — it is the clearest record of a Friday the
 * app holds — but a game that has finished draws the people who signed up and
 * nothing else. Four unclaimed circles under a cap nobody reached are not four
 * places going spare any more; they are holes in a record, offering something
 * the server would refuse.
 */
export function pitchSlotCount(
  headsIn: number,
  maxPlayers: number | null | undefined,
  registrationOpen: boolean,
): number {
  if (!registrationOpen) return headsIn;
  if (maxPlayers != null) return Math.max(headsIn, maxPlayers);
  return headsIn + 1;
}

/**
 * Whether tapping an empty spot signs you up or puts you on the waitlist.
 *
 * The server decides this in the same statement that does the insert, and it
 * decides it for the *whole party*: `heads + 1 + guests <= cap`. Three people
 * cannot half-fit into two spots, so a party that does not fit goes to the
 * waitlist entire — and the two spots it did not fit into stay visibly empty.
 * That is the case this exists for. A screen that reads "2 spots left" and
 * then quietly benches somebody who taps one is the screen lying, so the
 * button has to be able to say which it is about to do.
 */
export function partyFits(
  headsIn: number,
  maxPlayers: number | null | undefined,
  guests = 0,
): boolean {
  if (maxPlayers == null) return true;
  return headsIn + 1 + Math.max(0, guests) <= maxPlayers;
}

/* ----------------------------------------------------------- the formation */

/** Five 44px discs and four gaps is 244px; the narrowest card tested has 252. */
const MAX_PER_LINE = 5;
/** More lines than this and it is a crowd photo whatever you do to it. */
const MAX_OUTFIELD_LINES = 8;
/**
 * The tallest the layout box may be, in px, before the tilt.
 *
 * The far rows are drawn smaller than the box they were budgeted, so the field
 * comes out shorter than this — the number is the ceiling, not the answer.
 */
export const PITCH_MAX_HEIGHT = 470;

/**
 * A player card is taller than it is wide, like the item it is copying — a
 * face above a name. The width is what the line arithmetic solves for; this
 * turns that into the height it costs.
 */
/*
 * The shape of a player item, measured off a real one rather than chosen.
 *
 * 127/100. It was 1.34, which was near enough to look deliberate and far
 * enough that a spot on the pitch and a card on the podium were visibly not the
 * same object. Both surfaces draw the same silhouette now, so both take this
 * number — see `ITEM_CARD_RATIO` in the web package, which is the same figure
 * on the other side of the seam.
 *
 * Shorter cards mean the height budget buys more of them, so every roster's
 * spots get the same size or larger; nothing shrinks.
 */
export const PITCH_CARD_RATIO = 1.27;
/** Between one line and the next. Shared with the stylesheet. */
export const PITCH_LINE_GAP = 8;
const PITCH_PAD = 24;
/*
 * Raised from 44, which was too small to be a card.
 *
 * At 44 there was no room for a portrait and a number side by side, and the
 * portrait ended up a shrunken circle pushed off centre to clear the corner.
 * The width budget always allowed more — three across a 320px phone leaves 80
 * each — it was the height ceiling doing the squeezing.
 */
const SPOT_MAX = 52;
const SPOT_MIN = 24;
/**
 * What a line has to fit into on the narrowest phone anybody drives this on:
 * 320 − 24 (`.content`) − 32 (`.card`) − 12 (`.pitch`) = 252.
 *
 * Sized from the worst case rather than from a measurement, deliberately. A
 * `ResizeObserver` would buy a rounding error's worth of accuracy for a layout
 * pass per frame, and on a wider screen the extra room simply becomes slack
 * around a centred line — which is where it should go.
 */
const NARROW_WIDTH = 252;

/**
 * How the spots are dealt into lines, goal to goal.
 *
 * Symmetric about halfway with a keeper at each end, because that is the shape
 * that makes a screenful of circles read as a game rather than a queue. Ten
 * comes out 1-3-2-3-1 — a back three each way and two meeting on the centre
 * spot — which is the count this group actually plays, and so the one that has
 * to look right.
 *
 * Worth saying plainly: this is a drawing, not a line-up. Both sides are on
 * this pitch and nobody has been picked yet, so standing in the front line
 * means nothing at all. The one thing that *is* deliberate is that the empty
 * spots sort last and therefore land near the bottom, which is where a thumb
 * already is.
 */
export function pitchLines(count: number): number[] {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];
  // Too few to have a shape. One in the middle, two facing each other, three
  // in a line — each of those is a picture on its own.
  if (n <= 3) return new Array<number>(n).fill(1);
  if (n === 4) return [1, 2, 1];
  // Five is one team, so there is no second keeper to draw: 2-2 is the
  // standard futsal shape and it fills the field on its own.
  if (n === 5) return [1, 2, 2];

  const outfield = n - 2;
  /*
   * Roughly the square root, tilted by the field being taller than it is wide,
   * so lines and bodies-per-line stay in the same proportion as the box. Then
   * floored by however many lines the width forces, and capped — past eight the
   * discs shrink instead, which is the honest thing to do about a session of
   * sixty being a crowd rather than a formation.
   */
  const lines = Math.min(
    MAX_OUTFIELD_LINES,
    Math.max(2, Math.round(Math.sqrt(outfield * 1.25)), Math.ceil(outfield / MAX_PER_LINE)),
  );
  return [1, ...spread(outfield, lines), 1];
}

/** As even as it goes, and mirrored — the remainder goes out towards the ends. */
function spread(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const sizes = new Array<number>(parts).fill(base);
  let rest = total - base * parts;

  for (let i = 0; rest >= 2 && i < Math.floor(parts / 2); i++) {
    sizes[i]! += 1;
    sizes[parts - 1 - i]! += 1;
    rest -= 2;
  }
  if (rest === 1) {
    sizes[Math.floor((parts - 1) / 2)]! += 1;
    rest -= 1;
  }
  for (let i = 0; rest > 0; i = (i + 1) % parts) {
    sizes[i]! += 1;
    rest -= 1;
  }
  return sizes;
}

/** Between one spot and the next along a line. Tightens once a line is long. */
export function pitchSpotGap(lines: readonly number[]): number {
  return lines.length > 0 && Math.max(...lines) >= 6 ? 4 : 6;
}

/**
 * How big one spot is drawn, in px.
 *
 * Both constraints at once: the widest line has to fit across the narrowest
 * phone, and the whole field has to stay under `PITCH_MAX_HEIGHT` so that a
 * session of sixty is a pitch rather than a scroll.
 *
 * Px and not `em`, for the reason `.form-squares` already gives — this is a
 * graphic, and it has to be the same size in Burmese, which sets taller at the
 * same font-size.
 *
 * A big roster does push the discs under 44px, and that is fine here rather
 * than a compromise: only one spot on the whole pitch is ever pressable, and it
 * carries its own 44px target as a pseudo-element that may overhang its cell
 * freely, because nothing beside it can be pressed.
 */
export function pitchSlotSize(lines: readonly number[]): number {
  if (lines.length === 0) return SPOT_MAX;
  const widest = Math.max(...lines);
  const gap = pitchSpotGap(lines);
  const byWidth = (NARROW_WIDTH - (widest - 1) * gap) / widest;
  // A card costs its own height, not its width, so the vertical budget is
  // divided by the ratio before it is compared with the horizontal one.
  const byHeight =
    (PITCH_MAX_HEIGHT - (lines.length - 1) * PITCH_LINE_GAP - PITCH_PAD) /
    (lines.length * PITCH_CARD_RATIO);
  return Math.max(SPOT_MIN, Math.min(SPOT_MAX, Math.floor(Math.min(byWidth, byHeight))));
}

/* ------------------------------------------------------------- placement */

/** A registration as the pitch needs it, including the spot they pressed. */
export interface PitchParty extends PitchCandidate {
  /**
   * The spot they pressed, if they pressed one. Null is the ordinary case and
   * means no preference — every registration made before the pitch existed,
   * anybody promoted off the waitlist, and any client that does not draw a
   * field.
   */
  slot?: number | null;
}

/**
 * Put everybody where they stood, and fill the rest of the field around them.
 *
 * Signing up used to be a button, so the circles could be filled in the order
 * the names arrived and nobody could tell. Once pressing a *particular* spot is
 * how you sign up, that order becomes a lie you can watch happen: you aim at
 * the empty circle near your thumb, and your face appears somewhere near the
 * halfway line because that gap came first in the array.
 *
 * So a chosen spot is honoured wherever it still exists and is free. It might
 * not: the organizer can change the cap, which redraws the whole formation
 * underneath everybody, and two people can press the same circle within a
 * moment of each other. Neither is an error — the loser simply takes a gap, the
 * same as somebody who never expressed a preference at all. A preference the
 * screen cannot keep is dropped quietly, because the alternative is refusing a
 * registration over where a picture goes.
 *
 * Guests follow whoever brought them: they fill forward from that person's
 * spot, so a party of three reads as a party rather than as three strangers
 * scattered across the pitch.
 *
 * Returns one entry per spot on the field — a body, or null for an open spot.
 */
export function placeOnPitch(
  parties: readonly PitchParty[],
  total: number,
): (TeamSlot | null)[] {
  const size = Math.max(0, Math.floor(total));
  const placed: (TeamSlot | null)[] = new Array<TeamSlot | null>(size).fill(null);
  const playing = parties.filter((party) => party.status === 'in');

  const bodyOf = (party: PitchParty, guestIndex: number): TeamSlot => ({
    memberId: party.memberId,
    memberName: party.memberName,
    memberAvatarUpdatedAt: party.memberAvatarUpdatedAt ?? null,
    guestIndex,
  });

  /** The next free spot at or after `from`, wrapping once. Null when full. */
  const freeFrom = (from: number): number | null => {
    for (let step = 0; step < size; step++) {
      const at = (from + step) % size;
      if (placed[at] === null) return at;
    }
    return null;
  };

  // First pass: only the people who asked for somewhere, in registration order
  // so an earlier signup wins a contested circle.
  const settled = new Set<string>();
  for (const party of playing) {
    const wanted = party.slot;
    if (wanted == null || !Number.isInteger(wanted)) continue;
    if (wanted < 0 || wanted >= size || placed[wanted] !== null) continue;
    placed[wanted] = bodyOf(party, 0);
    settled.add(party.memberId);

    // Their guests fill forward from them rather than from the front.
    for (let guest = 1; guest <= Math.max(0, party.guests ?? 0); guest++) {
      const at = freeFrom(wanted + guest);
      if (at === null) break;
      placed[at] = bodyOf(party, guest);
    }
  }

  // Second pass: everybody else, into whatever is left, in registration order.
  const remaining: TeamSlot[] = [];
  for (const party of playing) {
    // A settled party is settled whole — the pass above placed its guests too.
    if (settled.has(party.memberId)) continue;
    remaining.push(bodyOf(party, 0));
    for (let guest = 1; guest <= Math.max(0, party.guests ?? 0); guest++) {
      remaining.push(bodyOf(party, guest));
    }
  }

  let cursor = 0;
  for (const body of remaining) {
    while (cursor < size && placed[cursor] !== null) cursor++;
    if (cursor >= size) break;
    placed[cursor] = body;
  }

  return placed;
}
