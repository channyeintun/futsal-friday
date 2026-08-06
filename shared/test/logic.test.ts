import { nextFridayKickoff, formatKickoff, toZonedParts, zonedDateKey, fromDatetimeLocal, toDatetimeLocal } from '../src/time.ts';
import { splitEqually, splitWithOverrides, formatVnd, parseVnd } from '../src/money.ts';

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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
