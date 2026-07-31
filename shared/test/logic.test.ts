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

check('formatVnd', formatVnd(1_234_000), '1.234.000d');
check('formatVnd small', formatVnd(500), '500d');
check('parseVnd 120k', parseVnd('120k'), 120_000);
check('parseVnd dotted', parseVnd('120.000'), 120_000);
check('parseVnd spaced', parseVnd('120 000'), 120_000);
check('parseVnd junk', parseVnd('abc'), null);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
