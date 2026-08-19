import { nextFridayKickoff, formatKickoff, startOfZonedDay, toZonedParts, zonedDateKey, fromDatetimeLocal, toDatetimeLocal } from '../src/time.ts';
import { splitEqually, splitWithOverrides, formatVnd, parseVnd } from '../src/money.ts';
import {
  arrivedSlots, assignLatecomers, canRedrawTeams, canSplitInto, drawTeams, matchPlayed, maxTeamsFor, roundRobin,
  slotsMissingFrom, teamBoardLive, teamOutcomes, teamRecords,
} from '../src/teams.ts';
import { SESSION_RUNS_FOR_MS } from '../src/time.ts';
import { sessionAnnouncement } from '../src/announce.ts';
import { canVoteFor, mvpLeaders, sortTally } from '../src/mvp.ts';
import { paymentsSummary, registrationSummary } from '../src/summary.ts';
import { en } from '../src/i18n/en.ts';
import { totalArrivedHeads } from '../src/attendance.ts';
import {
  PITCH_LINE_GAP, PITCH_MAX_HEIGHT, partyFits, pitchLines, pitchSlotCount, pitchSlotSize,
  pitchSpotGap, registeredSlots, waitingSlots,
} from '../src/pitch.ts';
import type { TeamMatch, TeamSlot } from '../src/models.ts';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${a}\n        want ${e}`}`);
}

// --- time: next Friday 19:30 ICT ------------------------------------------
// 2026-08-01 is a Saturday. Next Friday is 2026-08-07 19:30 ICT = 12:30 UTC.
check('Sat -> next Fri', nextFridayKickoff(new Date('2026-08-01T00:00:00Z')).toISOString(), '2026-08-07T12:30:00.000Z');

// Friday BEFORE kickoff (2026-08-07 10:00 ICT = 03:00 UTC) -> same day.
check('Fri pre-kickoff -> today', nextFridayKickoff(new Date('2026-08-07T03:00:00Z')).toISOString(), '2026-08-07T12:30:00.000Z');

// Friday AFTER kickoff (2026-08-07 21:00 ICT = 14:00 UTC) -> next week.
check('Fri post-kickoff -> +7d', nextFridayKickoff(new Date('2026-08-07T14:00:00Z')).toISOString(), '2026-08-14T12:30:00.000Z');

// Exactly at kickoff -> rolls forward (strictly after).
check('Fri exactly at kickoff', nextFridayKickoff(new Date('2026-08-07T12:30:00Z')).toISOString(), '2026-08-14T12:30:00.000Z');

// Month boundary: 2026-08-28 is a Friday; from 2026-08-29 (Sat) -> 2026-09-04.
check('crosses month end', nextFridayKickoff(new Date('2026-08-29T00:00:00Z')).toISOString(), '2026-09-04T12:30:00.000Z');

// Year boundary: 2026-12-31 is a Thursday -> Fri 2027-01-01.
check('crosses year end', nextFridayKickoff(new Date('2026-12-31T00:00:00Z')).toISOString(), '2027-01-01T12:30:00.000Z');

// UTC-vs-ICT trap: 2026-08-06T18:00Z is Thu in UTC but already Fri 01:00 ICT.
check('late-UTC Thu is ICT Fri', nextFridayKickoff(new Date('2026-08-06T18:00:00Z')).toISOString(), '2026-08-07T12:30:00.000Z');

check('zoned parts', toZonedParts('2026-08-07T12:30:00Z'), { year: 2026, month: 8, day: 7, hour: 19, minute: 30, weekday: 5 });
check('date key uses ICT day', zonedDateKey('2026-08-06T18:00:00Z'), '2026-08-07');

// The home screen's upcoming/previously line. Friday 19:30 ICT kickoff, read
// an hour after the final whistle (22:00 ICT = 15:00 UTC): the day it belongs
// to opened at Friday 00:00 ICT, which is Thursday 17:00 UTC. Kickoff is at or
// after that instant, so the fixture is still today's.
check('day starts at ICT midnight', startOfZonedDay('2026-08-07T15:00:00Z').toISOString(), '2026-08-06T17:00:00.000Z');
check('a finished game is still today', '2026-08-07T12:30:00.000Z' >= startOfZonedDay('2026-08-07T15:00:00Z').toISOString(), true);
// Half past midnight ICT on Saturday (17:30 UTC Friday) — now it is history.
check('and is history once the day turns', '2026-08-07T12:30:00.000Z' >= startOfZonedDay('2026-08-07T17:30:00Z').toISOString(), false);
// Same trap as above: late-UTC Friday is already Saturday in ICT.
check('day boundary follows ICT, not UTC', startOfZonedDay('2026-08-07T18:00:00Z').toISOString(), '2026-08-07T17:00:00.000Z');
check('formatKickoff', formatKickoff('2026-08-07T12:30:00Z'), 'Fri 07 Aug, 19:30');
check('datetime-local roundtrip', fromDatetimeLocal(toDatetimeLocal('2026-08-07T12:30:00Z')).toISOString(), '2026-08-07T12:30:00.000Z');

// --- money -----------------------------------------------------------------
const s1 = splitEqually(500_000, 7);
check('split 500k/7 sums exact', s1.reduce((a, b) => a + b, 0), 500_000);
check('split 500k/7 shares', s1, [72_000, 72_000, 72_000, 71_000, 71_000, 71_000, 71_000]);

const s2 = splitEqually(490_000, 7);
check('split 490k/7 even', s2, [70_000, 70_000, 70_000, 70_000, 70_000, 70_000, 70_000]);

// Grain larger than the per-head share must still sum exactly.
const s3 = splitEqually(5_000, 7);
check('split 5k/7 sums exact', s3.reduce((a, b) => a + b, 0), 5_000);

// Non-round total with grain 1000 -> remainder lands on first payer.
const s4 = splitEqually(500_500, 7);
check('split 500.5k/7 sums exact', s4.reduce((a, b) => a + b, 0), 500_500);

check('split zero people', splitEqually(100_000, 0), []);
check('split zero total', splitEqually(0, 3), [0, 0, 0]);

const o1 = splitWithOverrides(500_000, [
  { id: 'a', override: 100_000 },
  { id: 'b' },
  { id: 'c' },
  { id: 'd' },
]);
check('overrides: fixed honoured', o1.get('a'), 100_000);
check('overrides: rest split', [o1.get('b'), o1.get('c'), o1.get('d')], [134_000, 133_000, 133_000]);
check('overrides sum exact', [...o1.values()].reduce((a, b) => a + b, 0), 500_000);

// Overrides exceeding the total must not produce negatives.
const o2 = splitWithOverrides(100_000, [{ id: 'a', override: 200_000 }, { id: 'b' }]);
check('overrides over total -> 0', o2.get('b'), 0);

// --- guests: the split is by heads, not by accounts ---------------------
const g1 = splitWithOverrides(600_000, [
  { id: 'a', heads: 1 },
  { id: 'b', heads: 2 },
  { id: 'c', heads: 3 },
]);
check('guests: 6 heads at 100k', [g1.get('a'), g1.get('b'), g1.get('c')], [100_000, 200_000, 300_000]);

// An override covers the payer's whole party; the rest divides by heads.
const g2 = splitWithOverrides(500_000, [
  { id: 'a', heads: 3, override: 200_000 },
  { id: 'b', heads: 1 },
  { id: 'c', heads: 2 },
]);
check('guests: override covers the party', g2.get('a'), 200_000);
check('guests: remainder splits by heads', [g2.get('b'), g2.get('c')], [100_000, 200_000]);

// Heads default to 1, so the old call sites keep their old answers.
const g3 = splitWithOverrides(300_000, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
check('guests: absent heads means one', [g3.get('a'), g3.get('b'), g3.get('c')],
  [100_000, 100_000, 100_000]);

/**
 * The invariant, swept rather than sampled.
 *
 * Enumerated cases only prove the totals somebody thought to write down. What
 * must hold for *every* bill is that the parts sum to the whole: a split that
 * rounds per party instead of grouping slices passes the tidy 600.000-across-6
 * case above and still loses a thousand dong on the awkward ones.
 */
let worstDrift = 0;
let driftExample = '';
for (let total = 0; total <= 2_000_000; total += 7_331) {
  for (const shape of [[1], [1, 1], [3], [1, 2], [2, 2, 1], [1, 1, 1, 5], [4, 3, 2, 1], [5, 5, 5]]) {
    const payers = shape.map((heads, i) => ({ id: `p${i}`, heads }));
    const split = splitWithOverrides(total, payers);
    const sum = [...split.values()].reduce((a, b) => a + b, 0);
    if (sum !== total && Math.abs(sum - total) > worstDrift) {
      worstDrift = Math.abs(sum - total);
      driftExample = `total=${total} shape=${shape.join('+')} sum=${sum}`;
    }
    // Nobody may owe a negative amount, whatever the shape.
    if ([...split.values()].some((v) => v < 0)) {
      worstDrift = Math.max(worstDrift, 1);
      driftExample = `negative share: total=${total} shape=${shape.join('+')}`;
    }
  }
}
check('guests: shares always sum to the total exactly', `${worstDrift} ${driftExample}`.trim(), '0');

// Same sweep with an override in play, which is where a naive fix breaks.
let overrideDrift = '';
for (let total = 0; total <= 1_000_000; total += 3_997) {
  for (const fixedAmount of [0, 50_000, 999_999, 2_000_000]) {
    const split = splitWithOverrides(total, [
      { id: 'a', heads: 2, override: fixedAmount },
      { id: 'b', heads: 1 },
      { id: 'c', heads: 3 },
    ]);
    const sum = [...split.values()].reduce((a, b) => a + b, 0);
    // Once the override alone exceeds the bill the total is the override, by
    // design: the others owe nothing rather than a negative.
    const expected = Math.max(total, Math.min(fixedAmount, Math.max(total, fixedAmount)));
    if (sum !== expected) overrideDrift = `total=${total} fixed=${fixedAmount} sum=${sum} want=${expected}`;
  }
}
check('guests: overrides never break the sum', overrideDrift, '');

check('formatVnd', formatVnd(1_234_000), '1.234.000d');
check('formatVnd small', formatVnd(500), '500d');
check('parseVnd 120k', parseVnd('120k'), 120_000);
check('parseVnd dotted', parseVnd('120.000'), 120_000);
check('parseVnd spaced', parseVnd('120 000'), 120_000);
check('parseVnd junk', parseVnd('abc'), null);

// --- teams: the random draw ------------------------------------------------
//
// The draw's whole job is to be defensible to fifteen people standing on a
// pitch, so the properties are checked over a sweep rather than on one lucky
// seed: everybody is dealt exactly once, the sides differ by at most one, and
// no team is systematically the bigger one.

/** Deterministic PRNG (mulberry32), so a failure here is reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const slotOf = (n: number): TeamSlot => ({
  memberId: `m${n}`,
  memberName: `Player ${n}`,
  memberAvatarUpdatedAt: null,
  guestIndex: 0,
});

let drawFault = '';
for (let heads = 0; heads <= 24 && !drawFault; heads++) {
  const slots = Array.from({ length: heads }, (_, i) => slotOf(i));
  for (let teamCount = 1; teamCount <= 6; teamCount++) {
    for (let seed = 1; seed <= 40; seed++) {
      const teams = drawTeams(slots, teamCount, seeded(seed * 31 + heads));
      const dealt = teams.flat();

      if (teams.length !== teamCount) drawFault = `heads=${heads} n=${teamCount} teams=${teams.length}`;
      // Everybody, exactly once. A draw that loses somebody is worse than
      // no draw: they find out by nobody passing to them.
      if (dealt.length !== heads) drawFault = `heads=${heads} n=${teamCount} dealt=${dealt.length}`;
      if (new Set(dealt.map((s) => s.memberId)).size !== heads) {
        drawFault = `heads=${heads} n=${teamCount} duplicated somebody`;
      }
      const sizes = teams.map((t) => t.length);
      if (Math.max(...sizes) - Math.min(...sizes) > 1) {
        drawFault = `heads=${heads} n=${teamCount} lopsided ${sizes.join('/')}`;
      }
    }
  }
}
check('teams: every draw is complete and balanced', drawFault, '');

// The spare player must not always land on the same side. Round-robin alone
// puts it on the team dealt first every time, which over a season is team A
// playing a man up every odd week.
const spareLandedOn = new Set<number>();
for (let seed = 1; seed <= 200; seed++) {
  const teams = drawTeams(Array.from({ length: 11 }, (_, i) => slotOf(i)), 2, seeded(seed));
  spareLandedOn.add(teams[0]!.length);
}
check('teams: the odd player out moves between sides', [...spareLandedOn].sort(), [5, 6]);

// Guests are their own bodies, and a party is not welded together.
const partySlots = arrivedSlots([
  { memberId: 'a', memberName: 'Aung', status: 'in', guests: 2 },
  { memberId: 'b', memberName: 'Bo', status: 'in', guests: 0 },
  { memberId: 'c', memberName: 'Chit', status: 'in', guests: 0, attended: false },
  { memberId: 'd', memberName: 'Dara', status: 'waitlist', guests: 0, attended: true },
  { memberId: 'e', memberName: 'Ei', status: 'in', guests: 1, attended: false, guestsArrived: 1 },
]);
check('teams: a party of three is three slots', partySlots.filter((s) => s.memberId === 'a').length, 3);
check('teams: the no-show gets no slot', partySlots.some((s) => s.memberId === 'c'), false);
check('teams: the reserve who played gets one', partySlots.filter((s) => s.memberId === 'd').length, 1);
check(
  'teams: an absent member whose guest came yields only the guest',
  partySlots.filter((s) => s.memberId === 'e').map((s) => s.guestIndex),
  [1],
);
check('teams: slots are the same heads the bill is divided by', partySlots.length,
  totalArrivedHeads([
    { status: 'in', guests: 2 },
    { status: 'in', guests: 0 },
    { status: 'in', guests: 0, attended: false },
    { status: 'waitlist', guests: 0, attended: true },
    { status: 'in', guests: 1, attended: false, guestsArrived: 1 },
  ]));

// A stored draw does not follow the roster; the screen has to notice instead.
const drawnBoard = { teams: drawTeams(partySlots.slice(0, 3), 2, seeded(7)) };
check('teams: latecomers are reported as missing from the draw',
  slotsMissingFrom(drawnBoard, partySlots).length, partySlots.length - 3);
check('teams: nobody is missing from a fresh draw',
  slotsMissingFrom({ teams: drawTeams(partySlots, 2, seeded(9)) }, partySlots), []);

// --- teams: latecomers are added, never dealt -------------------------------
//
// The board opens days before kickoff and registration runs to the whistle, so
// "settled on Tuesday, two more on Thursday" is ordinary. Adding must not move
// anybody already placed, or a confirmed board would lose its fixtures.

const placed = (n: number, prefix = 'p'): TeamSlot[] =>
  Array.from({ length: n }, (_, i) => ({
    memberId: `${prefix}${i}`, memberName: `${prefix}${i}`, memberAvatarUpdatedAt: null, guestIndex: 0,
  }));

let addFault = '';
for (let a = 0; a <= 6 && !addFault; a++) {
  for (let b = 0; b <= 6; b++) {
    for (let late = 1; late <= 5; late++) {
      for (let seed = 1; seed <= 12; seed++) {
        const board = [placed(a, 'a'), placed(b, 'b')];
        const newcomers = placed(late, 'late');
        const out = assignLatecomers(board, newcomers, seeded(seed * 13 + late));

        if (out.length !== late) addFault = `a=${a} b=${b} late=${late} placed ${out.length}`;
        if (new Set(out.map((x) => x.slot.memberId)).size !== late) {
          addFault = `a=${a} b=${b} late=${late} duplicated somebody`;
        }
        if (out.some((x) => x.team < 0 || x.team >= board.length)) {
          addFault = `a=${a} b=${b} late=${late} assigned off the board`;
        }
        // The promise the original draw made must still hold afterwards.
        const sizes = board.map((t, i) => t.length + out.filter((x) => x.team === i).length);
        if (Math.max(...sizes) - Math.min(...sizes) > Math.max(1, Math.abs(a - b))) {
          addFault = `a=${a} b=${b} late=${late} left it lopsided ${sizes.join('/')}`;
        }
      }
    }
  }
}
check('LATECOMERS: EVERY ONE PLACED, ONTO A REAL SIDE', addFault, '');

// The whole point: the smaller side absorbs them.
check('latecomers: go to the smaller side',
  assignLatecomers([placed(5, 'a'), placed(2, 'b')], placed(1, 'late'), seeded(3))[0]!.team, 1);
check('latecomers: three of them even it up',
  assignLatecomers([placed(5, 'a'), placed(2, 'b')], placed(3, 'late'), seeded(3))
    .filter((x) => x.team === 1).length, 3);

// Ties must not always fall on team A, or the first side absorbs everybody.
const tieLanded = new Set<number>();
for (let seed = 1; seed <= 60; seed++) {
  tieLanded.add(assignLatecomers([placed(3, 'a'), placed(3, 'b')], placed(1, 'late'), seeded(seed))[0]!.team);
}
check('latecomers: a tie is broken at random', [...tieLanded].sort(), [0, 1]);

check('latecomers: nobody to add is nothing to do',
  assignLatecomers([placed(3, 'a'), placed(3, 'b')], [], seeded(1)), []);
check('latecomers: no board is nothing to add to',
  assignLatecomers([], placed(2, 'late'), seeded(1)), []);

check('teams: two is the floor', canSplitInto(10, 1), false);
check('teams: cannot field more teams than players', canSplitInto(3, 4), false);
check('teams: three players make three teams', canSplitInto(3, 3), true);
check('teams: the cap is six', maxTeamsFor(40), 6);

// The board is open for the whole life of the fixture. It used to wait until
// half an hour before kickoff, which hid it for the entire week the group
// actually argues about the teams in.
const kickoffAt = '2026-08-07T12:30:00.000Z';
check('BOARD: OPEN DAYS BEFORE THE GAME',
  teamBoardLive({ startsAt: kickoffAt, status: 'scheduled' }, new Date('2026-08-04T09:00:00Z')), true);
check('board: open an hour before kickoff',
  teamBoardLive({ startsAt: kickoffAt, status: 'scheduled' }, new Date('2026-08-07T11:30:00Z')), true);
check('board: never open on a cancelled session',
  teamBoardLive({ startsAt: kickoffAt, status: 'cancelled' }, new Date('2026-08-04T09:00:00Z')), false);

// And it stops being a control once everybody has gone home. Measured off the
// clock, not off `status`: settling the bill completes a session too, and that
// often happens while the last game is still being scored.
check('board: live in the half hour before kickoff',
  teamBoardLive({ startsAt: kickoffAt, status: 'scheduled' }, new Date('2026-08-07T12:20:00Z')), true);
check('board: live an hour into the game',
  teamBoardLive({ startsAt: kickoffAt, status: 'scheduled' }, new Date('2026-08-07T13:30:00Z')), true);
check('BOARD: A RECORD TWO HOURS AFTER KICKOFF',
  teamBoardLive({ startsAt: kickoffAt, status: 'scheduled' }, new Date('2026-08-07T14:31:00Z')), false);
check('board: settling the bill mid-game does not close it',
  teamBoardLive({ startsAt: kickoffAt, status: 'completed' }, new Date('2026-08-07T13:30:00Z')), true);
check('board: closed for good the week after',
  teamBoardLive({ startsAt: kickoffAt, status: 'completed' }, new Date('2026-08-14T12:30:00Z')), false);
check('board: the window matches the one the cron completes on',
  SESSION_RUNS_FOR_MS, 2 * 60 * 60 * 1000);


// --- teams: fixtures and results -------------------------------------------

check('fixtures: two teams play once', roundRobin(2), [[0, 1]]);
check('fixtures: three teams all play each other', roundRobin(3), [[0, 1], [0, 2], [1, 2]]);
check('fixtures: four teams make six games', roundRobin(4).length, 6);
check('fixtures: one team has nothing to play', roundRobin(1), []);

let pairFault = '';
for (let n = 2; n <= 6; n++) {
  const pairs = roundRobin(n);
  const seen = new Set(pairs.map(([a, b]) => `${a}-${b}`));
  if (seen.size !== pairs.length) pairFault = `n=${n} repeats a fixture`;
  // Stored low-first so the same pairing cannot exist twice under two
  // orderings — the unique index depends on it.
  if (pairs.some(([a, b]) => a >= b)) pairFault = `n=${n} has an unordered pair`;
  if (pairs.length !== (n * (n - 1)) / 2) pairFault = `n=${n} wrong count ${pairs.length}`;
}
check('fixtures: every pair once, low team first', pairFault, '');

const asMatch = (
  ordinal: number, firstTeam: number, secondTeam: number,
  firstGoals: number | null, secondGoals: number | null,
): TeamMatch => ({
  id: `mat_${ordinal}`, ordinal, firstTeam, secondTeam, firstGoals, secondGoals,
  recordedBy: null, recordedAt: null,
});

check('a fixture with no score is not played', matchPlayed(asMatch(0, 0, 1, null, null)), false);
check('a nil-nil is played', matchPlayed(asMatch(0, 0, 1, 0, 0)), true);
check('half a score is not a result', matchPlayed(asMatch(0, 0, 1, 3, null)), false);

// A three-team afternoon: A beat B, A drew with C, C beat B.
const table = teamRecords(3, [
  asMatch(0, 0, 1, 4, 2),
  asMatch(1, 0, 2, 1, 1),
  asMatch(2, 1, 2, 0, 3),
]);
check('results: a win and a draw', [table[0]!.won, table[0]!.drawn, table[0]!.lost], [1, 1, 0]);
check('results: the team that lost both', [table[1]!.won, table[1]!.drawn, table[1]!.lost], [0, 0, 2]);
check('results: a draw counts for both sides', [table[2]!.won, table[2]!.drawn, table[2]!.lost], [1, 1, 0]);
check('results: goals for and against tally both ways',
  [table[0]!.goalsFor, table[0]!.goalsAgainst], [5, 3]);
check('results: every game counts for two teams',
  table.reduce((sum, r) => sum + r.played, 0), 6);
check('results: goals for across the table equal goals against',
  table.reduce((s, r) => s + r.goalsFor, 0) === table.reduce((s, r) => s + r.goalsAgainst, 0), true);

// An unplayed fixture is a game not played, not a nil-nil.
const partial = teamRecords(2, [asMatch(0, 0, 1, null, null)]);
check('results: an unrecorded game is not a draw',
  [partial[0]!.played, partial[0]!.drawn], [0, 0]);

// A fixture naming a team the draw no longer has must not throw.
check('results: a stale fixture is ignored rather than fatal',
  teamRecords(2, [asMatch(0, 0, 4, 3, 1)]).every((r) => r.played === 0), true);

// Who may pull the teams apart.
check('anybody may redraw an unconfirmed board',
  canRedrawTeams({ confirmedAt: null }, { isOrganizer: false }), true);
check('ONCE SETTLED, ONLY AN ORGANIZER MAY REDRAW',
  canRedrawTeams({ confirmedAt: '2026-08-07T12:40:00.000Z' }, { isOrganizer: false }), false);
check('and an organizer still may',
  canRedrawTeams({ confirmedAt: '2026-08-07T12:40:00.000Z' }, { isOrganizer: true }), true);
check('with no board at all there is nothing to protect',
  canRedrawTeams(null, { isOrganizer: false }), true);

// --- teams: one side's run of results --------------------------------------
// The run rather than the tally: what a history row draws as a line of marks.
check('outcomes: read from the winning side', teamOutcomes(0, [
  asMatch(0, 0, 1, 4, 2), asMatch(1, 0, 2, 1, 1), asMatch(2, 1, 2, 0, 3),
]), ['won', 'drawn']);
check('outcomes: and from the losing one', teamOutcomes(1, [
  asMatch(0, 0, 1, 4, 2), asMatch(1, 0, 2, 1, 1), asMatch(2, 1, 2, 0, 3),
]), ['lost', 'lost']);
check('outcomes: a draw counts for both sides', teamOutcomes(2, [
  asMatch(0, 0, 1, 4, 2), asMatch(1, 0, 2, 1, 1), asMatch(2, 1, 2, 0, 3),
]), ['drawn', 'won']);
check('outcomes: in fixture order, not sorted',
  teamOutcomes(2, [asMatch(0, 1, 2, 5, 0), asMatch(1, 0, 2, 0, 1)]), ['lost', 'won']);
check('outcomes: an unplayed game contributes nothing',
  teamOutcomes(0, [asMatch(0, 0, 1, null, null), asMatch(1, 0, 1, 2, 1)]), ['won']);
check('outcomes: a team in no fixture has no run', teamOutcomes(4, [asMatch(0, 0, 1, 2, 1)]), []);
check('outcomes: nil-nil is a draw, not an absence',
  teamOutcomes(0, [asMatch(0, 0, 1, 0, 0)]), ['drawn']);

// The two readings of the same afternoon have to agree — the history row and
// the session board are both derived, and from the same fixtures.
check('OUTCOMES: THE RUN AND THE TALLY CANNOT DISAGREE',
  [0, 1, 2].map((team) => {
    const run = teamOutcomes(team, [
      asMatch(0, 0, 1, 4, 2), asMatch(1, 0, 2, 1, 1), asMatch(2, 1, 2, 0, 3),
    ]);
    const record = table[team]!;
    return [
      run.filter((o) => o === 'won').length === record.won,
      run.filter((o) => o === 'drawn').length === record.drawn,
      run.filter((o) => o === 'lost').length === record.lost,
    ].every(Boolean);
  }),
  [true, true, true]);

// --- mvp: counting the vote -------------------------------------------------

const nominee = (id: string, votes: number, name = id) => ({
  memberId: id, memberName: name, memberAvatarUpdatedAt: null, votes,
});

check('mvp: the most votes leads', mvpLeaders([nominee('a', 3), nominee('b', 1)]), ['a']);
check('MVP: A TIE IS A TIE, NOT A TIEBREAK',
  mvpLeaders([nominee('a', 2), nominee('b', 2), nominee('c', 1)]), ['a', 'b']);
check('mvp: three level at the top all lead',
  mvpLeaders([nominee('a', 1), nominee('b', 1), nominee('c', 1)]), ['a', 'b', 'c']);
// Everyone level on nothing is arithmetically a tie and meaningfully not one.
check('MVP: NOBODY LEADS ON ZERO VOTES',
  mvpLeaders([nominee('a', 0), nominee('b', 0)]), []);
check('mvp: an empty ballot has no leader', mvpLeaders([]), []);

check('mvp: sorted by votes, then by name',
  sortTally([nominee('c', 1, 'Chit'), nominee('a', 3, 'Aung'), nominee('b', 3, 'Bo')])
    .map((e) => e.memberName),
  ['Aung', 'Bo', 'Chit']);
check('mvp: sorting does not mutate its argument', (() => {
  const original = [nominee('c', 1), nominee('a', 3)];
  sortTally(original);
  return original.map((e) => e.memberId);
})(), ['c', 'a']);

const ballot = [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' }];
check('MVP: YOU CANNOT VOTE FOR YOURSELF',
  canVoteFor('a', { memberId: 'a' }, ballot), false);
check('mvp: but you can vote for anybody else who played',
  canVoteFor('b', { memberId: 'a' }, ballot), true);
check('mvp: and not for somebody who did not play',
  canVoteFor('zzz', { memberId: 'a' }, ballot), false);

// --- announcements: the writer's own tease ----------------------------------
//
// The tease is the overridable line, not the opener. The opener is generic
// hype and a random one does that job; the tease is the week's actual
// needling, which is the part a joke bank cannot know because it is about
// these people.
const announceFixture = {
  session: {
    id: 'ses_x', startsAt: '2026-08-07T12:30:00.000Z', venueId: null, venue: null,
    status: 'scheduled' as const, feePerPerson: null, totalCharge: null, maxPlayers: null,
    notes: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
  registrations: [], counts: { in: 0, waitlist: 0, guests: 0 },
  registrationOpen: true, me: null, teams: null,
};
const linesOf = (tease?: string | null) =>
  sessionAnnouncement(announceFixture, { tease, random: () => 0 }).split('\n');

check('tease: a written jab replaces the canned one',
  linesOf('Kyaw has been talking all week 👀').includes('Kyaw has been talking all week 👀'), true);
check('tease: and the canned one is gone',
  linesOf('Kyaw has been talking all week 👀').includes(en.announce.teases[0]!), false);
check('tease: whitespace is not a jab', linesOf('   ').includes(en.announce.teases[0]!), true);
check('tease: empty falls back to the bank', linesOf('').includes(en.announce.teases[0]!), true);
check('tease: absent falls back to the bank', linesOf(undefined).includes(en.announce.teases[0]!), true);
check('tease: it is trimmed', linesOf('  Bring bibs  ').includes('Bring bibs'), true);

// The opener is no longer the writer's to set, and the facts underneath never
// were.
check('tease: the opener is still shuffled', linesOf('anything')[0], en.announce.openers[0]!);
check('tease: the kickoff is untouched',
  linesOf('anything').some((line) => line.includes(formatKickoff('2026-08-07T12:30:00.000Z', 'en'))),
  true);
check('tease: the sign-off is still there',
  linesOf('anything').includes(en.announce.callToAction[0]!), true);

// --- the writer's clock reaches the text they paste ------------------------
//
// These three build the strings that leave the app under somebody's name, and
// each of them dropped `hour12` on the floor: a person reading 7:30 PM
// everywhere else pasted 19:30 into the chat.

const clockFixture = {
  ...announceFixture,
  session: { ...announceFixture.session, maxPlayers: 14 },
};
const paymentsFixture = {
  sessionId: 'ses_x', totalCharge: 600_000, collected: 0, pending: 0,
  outstanding: 600_000, payments: [],
};

for (const [label, twelve, want] of [
  ['24h', false, '19:30'],
  ['12h', true, '7:30 PM'],
] as const) {
  check(`announcement follows the writer's clock (${label})`,
    sessionAnnouncement(clockFixture, { hour12: twelve, random: () => 0 }).includes(want), true);
  check(`registration summary follows it too (${label})`,
    registrationSummary(clockFixture, { hour12: twelve }).includes(want), true);
  check(`and so does the payment status (${label})`,
    paymentsSummary(clockFixture.session, paymentsFixture, { hour12: twelve }).includes(want), true);
}

// A cancelled announcement is a different branch, and had the same bug.
check('a cancelled announcement follows it as well',
  sessionAnnouncement(
    { ...clockFixture, session: { ...clockFixture.session, status: 'cancelled' as const } },
    { hour12: true },
  ).includes('7:30 PM'), true);

// Unset stays 24h — every existing caller and every stored string.
check('left unset, nothing moves',
  sessionAnnouncement(clockFixture, { random: () => 0 }).includes('19:30'), true);

// Burmese keeps Arabic numerals on both clocks; only the separator is its own.
check('Burmese on a 12h clock is still Arabic numerals',
  sessionAnnouncement(clockFixture, { locale: 'my', hour12: true, random: () => 0 })
    .includes('7:30 PM'), true);


// --- the pitch: spots, caps and parties -----------------------------------

const roster = [
  { memberId: 'm1', memberName: 'Aung', guests: 0, status: 'in' as const },
  { memberId: 'm2', memberName: 'Kyaw', guests: 2, status: 'in' as const },
  { memberId: 'm3', memberName: 'Min', guests: 1, status: 'waitlist' as const },
  { memberId: 'm4', memberName: 'Thu', guests: 0, status: 'in' as const },
];

// Guests are bodies, so the party of three occupies three spots in a row.
check('a guest takes a spot of their own',
  registeredSlots(roster).map((s) => `${s.memberId}:${s.guestIndex}`),
  ['m1:0', 'm2:0', 'm2:1', 'm2:2', 'm4:0']);

// The whole meaning of the waitlist is having no spot on the field.
check('the waitlist stands on the touchline instead',
  waitingSlots(roster).map((s) => `${s.memberId}:${s.guestIndex}`), ['m3:0', 'm3:1']);
check('the waitlist is not on the pitch',
  registeredSlots(roster).some((s) => s.memberId === 'm3'), false);

check('the avatar token comes along, defaulted',
  registeredSlots([{ memberId: 'm1', memberName: 'Aung', status: 'in' as const }]),
  [{ memberId: 'm1', memberName: 'Aung', memberAvatarUpdatedAt: null, guestIndex: 0 }]);

// A cap is the number of spots, filled or not — that is what makes the gaps
// worth looking at.
check('a cap with room to spare draws the cap', pitchSlotCount(5, 12, true), 12);
check('a full pitch draws the cap', pitchSlotCount(12, 12, true), 12);

// The organizer can lower the cap under a roster that has already outgrown it,
// and nothing demotes. Drawing the cap would hide people who are playing.
check('a cap the roster outgrew loses to the roster', pitchSlotCount(12, 8, true), 12);

// No cap is the common case: the pitch is the people on it, plus the one open
// spot that says you can still join.
check('no cap draws one open spot', pitchSlotCount(7, null, true), 8);
check('no cap and closed draws nobody extra', pitchSlotCount(7, null, false), 7);
check('no cap and nobody yet still offers a spot', pitchSlotCount(0, null, true), 1);

// The server decides in/waitlist for the whole party at once.
check('a solo fits the last spot', partyFits(11, 12, 0), true);
check('a party of three does not fit two spots', partyFits(10, 12, 2), false);
check('and the party that does not fit leaves the spots empty', partyFits(11, 12, 1), false);
check('without a cap everybody fits', partyFits(99, null, 5), true);


// --- the pitch: the formation ---------------------------------------------

// Symmetric about halfway, a keeper at each end. Ten is the count this group
// actually plays, so it is the one that has to look like a game.
check('ten is the shape people draw', pitchLines(10), [1, 3, 2, 3, 1]);
check('a five-a-side is a keeper and two lines', pitchLines(5), [1, 2, 2]);
check('eight is three lines of two between the keepers', pitchLines(8), [1, 2, 2, 2, 1]);
check('twelve pinches at the centre circle', pitchLines(12), [1, 3, 2, 2, 3, 1]);
check('fourteen is four even lines', pitchLines(14), [1, 3, 3, 3, 3, 1]);
check('twenty stays symmetric', pitchLines(20), [1, 4, 3, 4, 3, 4, 1]);
check('sixty is a crowd and says so', pitchLines(60), [1, 8, 7, 7, 7, 7, 7, 7, 8, 1]);
check('one player stands on the centre spot', pitchLines(1), [1]);
check('an empty pitch has no lines at all', pitchLines(0), []);
check('the same count always draws the same pitch',
  JSON.stringify(pitchLines(14)) === JSON.stringify(pitchLines(14)), true);

// Everything below sweeps the whole legal range rather than sampling it: the
// cap is 1..60 and a formation that overflows at 37 is a formation that ships.
const everyCount = Array.from({ length: 61 }, (_, n) => n);

check('the lines always add up, 0..60',
  everyCount.filter((n) => pitchLines(n).reduce((a, b) => a + b, 0) !== n), []);

check('no line is ever empty',
  everyCount.filter((n) => pitchLines(n).some((width) => width < 1)), []);

// 252px is the interior of a card on a 320px phone — narrower than anything
// the browser suite drives, so holding here holds everywhere.
check('and never overflow the narrowest phone',
  everyCount.filter((n) => {
    const lines = pitchLines(n);
    if (lines.length === 0) return false;
    const widest = Math.max(...lines);
    return widest * pitchSlotSize(lines) + (widest - 1) * pitchSpotGap(lines) > 252;
  }), []);

check('the pitch never grows past its box',
  everyCount.filter((n) => {
    const lines = pitchLines(n);
    if (lines.length === 0) return false;
    return lines.length * pitchSlotSize(lines) + (lines.length - 1) * PITCH_LINE_GAP + 24
      > PITCH_MAX_HEIGHT;
  }), []);

// A spot is never drawn smaller than this. It can go under 44 on a big roster
// — 38 heads gives 30px — and that is what the pressable spot's own 44px
// pseudo-element is for; it may overhang, because nothing beside it is a
// control. Worth pinning so a change to the sizing has to face the question.
check('a spot never gets too small to see',
  everyCount.filter((n) => pitchLines(n).length > 0 && pitchSlotSize(pitchLines(n)) < 24), []);
check('a roster this big does shrink the discs', pitchSlotSize(pitchLines(38)), 30);
check('and a normal Friday does not', pitchSlotSize(pitchLines(12)), 44);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
