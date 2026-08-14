import type { MvpTallyEntry } from './models.js';

/**
 * Who was the best today.
 *
 * The counting is trivial; what is worth writing down is the shape of the
 * question, because two obvious-looking choices are wrong.
 *
 * **Ties are ties.** A tiebreak the group did not agree to is worse than an
 * honest draw — goals, or alphabetical, or whoever voted first all invent a
 * rule out of thin air and then quietly hand somebody an award on it. Three
 * names on the trophy is a real answer; a made-up winner is not.
 *
 * **Nobody is at the top on zero votes.** With no votes cast, every candidate
 * is level on nothing, and calling all of them joint MVP is the arithmetic
 * being true and the meaning being false.
 */

/** Highest first, then by name so the order is stable between renders. */
export function sortTally(tally: readonly MvpTallyEntry[]): MvpTallyEntry[] {
  return tally
    .slice()
    .sort((a, b) => b.votes - a.votes || a.memberName.localeCompare(b.memberName));
}

/**
 * Everybody level at the top, or nobody.
 *
 * Returns several ids on a tie and an empty array when no vote has been cast —
 * see the note above.
 */
export function mvpLeaders(tally: readonly MvpTallyEntry[]): string[] {
  const most = Math.max(0, ...tally.map((entry) => entry.votes));
  if (most === 0) return [];
  return tally.filter((entry) => entry.votes === most).map((entry) => entry.memberId);
}

/**
 * Whether this person may be voted for by that one.
 *
 * You cannot vote for yourself. Not a technicality — it is the whole social
 * contract of the award, and an app that allows it will have exactly one
 * person who does, every week, as a joke that stops being funny.
 */
export function canVoteFor(
  nomineeId: string,
  voter: { memberId: string },
  candidates: readonly { memberId: string }[],
): boolean {
  if (nomineeId === voter.memberId) return false;
  return candidates.some((candidate) => candidate.memberId === nomineeId);
}
