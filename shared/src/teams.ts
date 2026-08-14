import { arrivedGuests, didAttend, type AttendanceInput } from './attendance.js';
import { MAX_TEAMS, MIN_TEAMS, type MatchOutcome, type TeamMatch, type TeamSlot } from './models.js';
import { SESSION_RUNS_FOR_MS } from './time.js';

/**
 * Splitting the people who turned up into sides.
 *
 * This happens at the pitch, in the two minutes between everybody arriving and
 * the first kick — so it is deliberately not an organizer's job. Whoever gets
 * their phone out first presses the button, and anybody may press it again:
 * the point of a random draw is that it is cheap to reject. A group that feels
 * a split was unfair reshuffles rather than argues, which only works if
 * reshuffling costs one tap and needs nobody's permission.
 *
 * Everything here is pure and takes its randomness as an argument, so the same
 * rules can be tested exactly and the server can hand in a real CSPRNG.
 */

/**
 * What the teams are called. Letters rather than numbers so a team name never
 * reads as a score, and left untranslated — a bib is an A on any pitch.
 */
export const TEAM_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

/** Who the draw deals out: a registration, plus who it belongs to. */
export interface TeamCandidate extends AttendanceInput {
  memberId: string;
  memberName: string;
  memberAvatarUpdatedAt?: string | null;
}

/**
 * Whether the board is still something to *do*, rather than something that
 * happened.
 *
 * Open from the moment the fixture exists. It used to wait until half an hour
 * before kickoff, on the theory that picking sides is something you do
 * standing on the pitch — which is where it *ends*, not where it starts. A
 * group that wants to argue about the teams on Tuesday should be able to, and
 * hiding the board until Friday evening made the app useless for the part of
 * the week the argument actually happens in.
 *
 * Nothing is lost by opening early: the draw deals from whoever is down as
 * playing, and `slotsMissingFrom` already tells the screen when people have
 * signed up since — so a Tuesday draw quietly asks to be reshuffled as the
 * roster fills, rather than going stale.
 *
 * It closes two hours after kickoff, when everybody has gone home, and from
 * then on the board is a record: no shuffling, no confirming, no offer to
 * split teams for a game played weeks ago. `SESSION_RUNS_FOR_MS` is the same
 * window the cron uses to call a session finished, so the screen and the
 * schedule agree.
 *
 * Deliberately measured off the clock rather than off `status`. Settling the
 * bill also completes a session, and that often happens while the last game is
 * still being scored — closing the board then would take it away mid-use.
 */
export function teamBoardLive(
  session: { startsAt: string; status: string },
  now: Date = new Date(),
): boolean {
  if (session.status === 'cancelled') return false;
  return now.getTime() < new Date(session.startsAt).getTime() + SESSION_RUNS_FOR_MS;
}

/**
 * Every body that turned up, one slot each.
 *
 * Built on the same presence rules as the bill, so the people being split into
 * teams are exactly the people being charged — a no-show is in neither, and a
 * reserve who stepped on for them is in both.
 *
 * A member marked absent whose guests still came yields guest slots and no
 * member slot. That is not a curiosity: somebody drops out and sends a friend
 * in their place often enough that the model has to hold it.
 */
export function arrivedSlots(candidates: readonly TeamCandidate[]): TeamSlot[] {
  const slots: TeamSlot[] = [];

  for (const candidate of candidates) {
    const base = {
      memberId: candidate.memberId,
      memberName: candidate.memberName,
      memberAvatarUpdatedAt: candidate.memberAvatarUpdatedAt ?? null,
    };
    if (didAttend(candidate)) slots.push({ ...base, guestIndex: 0 });
    for (let guest = 1; guest <= arrivedGuests(candidate); guest++) {
      slots.push({ ...base, guestIndex: guest });
    }
  }

  return slots;
}

/** In-place Fisher-Yates, on a copy. Every ordering equally likely. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const held = out[i]!;
    out[i] = out[j]!;
    out[j] = held;
  }
  return out;
}

/**
 * Deal people into teams.
 *
 * Shuffle, then deal round-robin, so the sides differ in size by at most one —
 * which is the only fairness constraint a random draw can actually promise.
 *
 * The teams are then shuffled *among themselves*, which is less pointless than
 * it looks. Round-robin dealing always puts the spare player on the team it
 * deals first, so with eleven players team A would be six-a-side every single
 * week. Permuting the labels afterwards moves that extra body around, and
 * leaves the assignment uniform over the balanced splits rather than uniform
 * with a systematic thumb on one side.
 */
export function drawTeams(
  slots: readonly TeamSlot[],
  teamCount: number,
  random: () => number,
): TeamSlot[][] {
  const count = Math.max(1, Math.floor(teamCount));
  const teams: TeamSlot[][] = Array.from({ length: count }, () => []);

  shuffled(slots, random).forEach((slot, index) => {
    teams[index % count]!.push(slot);
  });

  return shuffled(teams, random);
}

/**
 * What the sides will come out as, before anybody commits to it.
 *
 * The same arithmetic the draw performs, so "5 · 5" on the confirm step is a
 * promise rather than an estimate — a group deciding between two teams and
 * three can see that eleven players makes 4·4·3 and change their mind.
 */
export function balancedSizes(headCount: number, teamCount: number): number[] {
  const count = Math.max(1, Math.floor(teamCount));
  const base = Math.floor(headCount / count);
  const spare = headCount % count;
  return Array.from({ length: count }, (_, index) => base + (index < spare ? 1 : 0));
}

/**
 * Fold late arrivals into a board that already exists.
 *
 * Registration stays open until kickoff and the board opens days before it, so
 * the ordinary case is teams settled on Tuesday and two more people signing up
 * on Thursday. Redrawing would answer that, but it is the wrong answer twice
 * over: it moves people who have already been told which side they are on, and
 * once the teams are confirmed it throws away the fixture list and every score
 * recorded against it.
 *
 * So a latecomer is *added* rather than dealt. Each one goes to the smallest
 * side, which keeps the sides within one of each other exactly as the original
 * draw promised — and because it only ever appends, nobody already on a team
 * moves and no result is lost. That is also why it needs no permission beyond
 * membership: there is nothing here for anyone to object to.
 *
 * Ties are broken at random rather than by index. Always filling team A first
 * would make the earliest side the one that absorbs every latecomer.
 */
export function assignLatecomers(
  teams: readonly (readonly TeamSlot[])[],
  newcomers: readonly TeamSlot[],
  random: () => number,
): { slot: TeamSlot; team: number }[] {
  if (teams.length === 0) return [];

  const sizes = teams.map((team) => team.length);
  const placed: { slot: TeamSlot; team: number }[] = [];

  for (const slot of shuffled(newcomers, random)) {
    const smallest = Math.min(...sizes);
    const tied = sizes.flatMap((size, index) => (size === smallest ? [index] : []));
    const team = tied[Math.floor(random() * tied.length)] ?? 0;
    placed.push({ slot, team });
    sizes[team]!++;
  }

  return placed;
}

/**
 * The most teams this many people can be split into and still field a side
 * each. Below the floor there is nothing to ask about.
 */
export function maxTeamsFor(headCount: number): number {
  return Math.min(MAX_TEAMS, headCount);
}

/** Whether it is worth offering the split at all. */
export function canSplitInto(headCount: number, teamCount: number): boolean {
  return teamCount >= MIN_TEAMS && teamCount <= maxTeamsFor(headCount);
}

/**
 * People who turned up after the last draw and are on nobody's team.
 *
 * A stored draw does not follow the roster, which is what keeps the teams
 * still — so somebody arriving late is simply missing from it, and the screen
 * says so rather than quietly rearranging two groups of people who have
 * already started playing.
 */
export function slotsMissingFrom(draw: { teams: TeamSlot[][] }, current: readonly TeamSlot[]): TeamSlot[] {
  const drawn = new Set(draw.teams.flat().map(slotKey));
  return current.filter((slot) => !drawn.has(slotKey(slot)));
}

/** Identity of a slot: a member, or the nth guest they brought. */
export function slotKey(slot: TeamSlot): string {
  return `${slot.memberId}:${slot.guestIndex}`;
}

/* ---------------------------------------------------------------- fixtures */

/**
 * Everyone plays everyone: the fixture list a confirmed draw produces.
 *
 * Generated once, when the teams are settled, rather than assembled a match at
 * a time. The alternative is asking "who did you just play?" as people walk
 * off the pitch, which is the one moment nobody wants to answer a question and
 * — with three sides rotating for an hour — is the one question they will get
 * wrong. Every fixture exists up front, so finishing a game only ever means
 * putting a score against a line that is already there.
 *
 * Pairs are ordered `(i, j)` with `i < j` and listed in that order. Two teams
 * is one fixture, three is three, four is six. Nobody plays themselves and no
 * pair appears twice.
 */
export function roundRobin(teamCount: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let first = 0; first < teamCount; first++) {
    for (let second = first + 1; second < teamCount; second++) {
      pairs.push([first, second]);
    }
  }
  return pairs;
}

/** A fixture with a score against it. Both halves or neither. */
export function matchPlayed(match: {
  firstGoals: number | null;
  secondGoals: number | null;
}): boolean {
  return match.firstGoals != null && match.secondGoals != null;
}

/**
 * How one side's games went, in fixture order.
 *
 * The sequence rather than the tally, because that is what a history row
 * wants: three marks in a line say "won, won, lost" — a shape you read without
 * reading — where "2W 1L" is a number you have to parse. Fixtures with no
 * score contribute nothing; a game not played is not a draw.
 */
export function teamOutcomes(team: number, matches: readonly TeamMatch[]): MatchOutcome[] {
  const outcomes: MatchOutcome[] = [];

  for (const match of matches) {
    if (!matchPlayed(match)) continue;

    const mine =
      match.firstTeam === team
        ? match.firstGoals
        : match.secondTeam === team
          ? match.secondGoals
          : null;
    const theirs =
      match.firstTeam === team
        ? match.secondGoals
        : match.secondTeam === team
          ? match.firstGoals
          : null;
    // Not this team's game.
    if (mine == null || theirs == null) continue;

    outcomes.push(mine > theirs ? 'won' : mine < theirs ? 'lost' : 'drawn');
  }

  return outcomes;
}

/** How one team's afternoon went. */
export interface TeamRecord {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
}

const emptyRecord = (): TeamRecord => ({
  played: 0,
  won: 0,
  drawn: 0,
  lost: 0,
  goalsFor: 0,
  goalsAgainst: 0,
});

/**
 * Win, draw and loss counts per team, from the scorelines alone.
 *
 * Derived rather than stored, so correcting a score an hour later corrects
 * everything that was said about it. A fixture with no score yet contributes
 * nothing — it is a game not played, not a nil-nil.
 */
export function teamRecords(teamCount: number, matches: readonly TeamMatch[]): TeamRecord[] {
  const records = Array.from({ length: Math.max(0, teamCount) }, emptyRecord);

  for (const match of matches) {
    if (!matchPlayed(match)) continue;
    const first = records[match.firstTeam];
    const second = records[match.secondTeam];
    // A fixture naming a team the draw no longer has: skip rather than throw.
    if (!first || !second) continue;

    const forFirst = match.firstGoals!;
    const forSecond = match.secondGoals!;

    first.played++;
    second.played++;
    first.goalsFor += forFirst;
    first.goalsAgainst += forSecond;
    second.goalsFor += forSecond;
    second.goalsAgainst += forFirst;

    if (forFirst > forSecond) {
      first.won++;
      second.lost++;
    } else if (forFirst < forSecond) {
      first.lost++;
      second.won++;
    } else {
      first.drawn++;
      second.drawn++;
    }
  }

  return records;
}

/**
 * Whether this person may move people between teams.
 *
 * Before the draw is confirmed, anybody — that is the whole point, and a group
 * that dislikes a split reshuffles rather than argues. Afterwards the teams are
 * bibs on people who have started playing, and results may already be recorded
 * against them, so only an organizer may pull it apart.
 */
export function canRedrawTeams(
  draw: { confirmedAt: string | null } | null,
  viewer: { isOrganizer: boolean },
): boolean {
  return draw?.confirmedAt == null || viewer.isOrganizer;
}
