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
  const slots: TeamSlot[] = [];

  for (const candidate of candidates) {
    if (candidate.status !== 'in') continue;
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
 *    says you can still join — and not even that once registration has closed,
 *    because then there is nothing left to offer.
 */
export function pitchSlotCount(
  headsIn: number,
  maxPlayers: number | null | undefined,
  registrationOpen: boolean,
): number {
  if (maxPlayers != null) return Math.max(headsIn, maxPlayers);
  return registrationOpen ? headsIn + 1 : headsIn;
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
