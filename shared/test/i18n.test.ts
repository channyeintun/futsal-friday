/**
 * Catalogue completeness and locale-aware formatting.
 *
 * TypeScript already guarantees every key exists in every locale — `my` is
 * declared as `Messages`. What it cannot catch is a translation that was left
 * as the English string, an interpolation that drops its argument, or Zawgyi
 * bytes pasted in where Unicode was meant. That is what this covers.
 */
import { LOCALES, messagesFor, normalizeLocale } from '../src/i18n/index.ts';
import { en } from '../src/i18n/en.ts';
import { my } from '../src/i18n/my.ts';
import { formatKickoff, relativeToNow } from '../src/time.ts';
import { sessionAnnouncement } from '../src/announce.ts';
import { computeStreak, type StreakEntry } from '../src/streak.ts';
import { initialsOf } from '../src/names.ts';
import { parseInvite } from '../src/invite.ts';

let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failed++;
    if (detail !== undefined) console.log(`         ${String(detail)}`);
  }
};

type Node = Record<string, unknown>;

/** Every leaf path in a catalogue, e.g. `session.imIn`. */
function paths(node: Node, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' && typeof value !== 'function'
      ? paths(value as Node, path)
      : [path];
  });
}

function at(node: Node, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc as Node)?.[key], node);
}

console.log('\ncatalogue completeness');
const enPaths = paths(en as unknown as Node).sort();
const myPaths = paths(my as unknown as Node).sort();

check('every English key exists in Burmese', enPaths.join('|') === myPaths.join('|'),
  `only in en: ${enPaths.filter((p) => !myPaths.includes(p)).join(', ') || '—'}\n         ` +
  `only in my: ${myPaths.filter((p) => !enPaths.includes(p)).join(', ') || '—'}`);
check('the catalogue is not trivially small', enPaths.length > 150, `${enPaths.length} keys`);

console.log('\ntranslations are actually translated');
// Values that are legitimately identical across locales: proper nouns, units,
// and things that should stay in Latin script.
const SHARED_BY_DESIGN = new Set([
  'connection.pollingShort',
  'editor.feeHint',
  'payments.enterAmount',
  'admin.priceNoteHint',
]);

const untranslated = enPaths.filter((path) => {
  if (SHARED_BY_DESIGN.has(path)) return false;
  const a = at(en as unknown as Node, path);
  const b = at(my as unknown as Node, path);
  return typeof a === 'string' && typeof b === 'string' && a === b;
});
check('no Burmese entry is still the English string', untranslated.length === 0,
  untranslated.join(', '));

const missingBurmese = enPaths.filter((path) => {
  if (SHARED_BY_DESIGN.has(path)) return false;
  const value = at(my as unknown as Node, path);
  // Every translated string should contain at least one Myanmar codepoint.
  return typeof value === 'string' && !/[က-႟]/.test(value);
});
check('every Burmese string contains Myanmar script', missingBurmese.length === 0,
  missingBurmese.join(', '));

console.log('\nUnicode, not Zawgyi');
// Zawgyi reuses the Unicode Myanmar block but places medials and vowels at
// codepoints that are unassigned or differently assigned in Unicode. These
// ranges are the reliable tell.
const ZAWGYI_ONLY = /[ၠ-႗]/;
const zawgyiHits = enPaths.filter((path) => {
  const value = at(my as unknown as Node, path);
  return typeof value === 'string' && ZAWGYI_ONLY.test(value);
});
check('no Zawgyi-only codepoints', zawgyiHits.length === 0, zawgyiHits.join(', '));

console.log('\ninterpolation carries its arguments through');
check('playing()', my.session.playing(5, 14).includes('5') && my.session.playing(5, 14).includes('14'),
  my.session.playing(5, 14));
check('playing() without a cap omits it', !my.session.playing(5, null).includes('/'),
  my.session.playing(5, null));
check('memberAdded()', my.toast.memberAdded('Kyaw').includes('Kyaw'), my.toast.memberAdded('Kyaw'));
check('unpaidBody()', my.push.unpaidBody('120.000d', 'x').includes('120.000d'),
  my.push.unpaidBody('120.000d', 'x'));
check('matchBodyAtVenue()',
  my.push.matchBodyAtVenue(3, 'Tao Dan').includes('3') &&
  my.push.matchBodyAtVenue(3, 'Tao Dan').includes('Tao Dan'),
  my.push.matchBodyAtVenue(3, 'Tao Dan'));
check('shareBody()', my.payments.shareBody('Aung').includes('Aung'), my.payments.shareBody('Aung'));

console.log('\ndates and durations');
// 2026-08-07T12:30:00Z is Friday 19:30 in Ho Chi Minh City.
const kickoff = '2026-08-07T12:30:00.000Z';
check('English kickoff', formatKickoff(kickoff, 'en') === 'Fri 07 Aug, 19:30', formatKickoff(kickoff, 'en'));
check('Burmese names the weekday in Myanmar script', formatKickoff(kickoff, 'my').startsWith('သောကြာ'),
  formatKickoff(kickoff, 'my'));
check('Burmese names the month in Myanmar script', formatKickoff(kickoff, 'my').includes('ဩဂုတ်'),
  formatKickoff(kickoff, 'my'));
check('Burmese keeps a 24h clock in Arabic numerals', formatKickoff(kickoff, 'my').includes('19:30'),
  formatKickoff(kickoff, 'my'));
check('Burmese uses its own comma (U+104A)', formatKickoff(kickoff, 'my').includes('၊'),
  formatKickoff(kickoff, 'my'));

const now = new Date('2026-08-05T12:30:00.000Z');
check('English future duration', relativeToNow(kickoff, now, 'en') === 'in 2d', relativeToNow(kickoff, now, 'en'));
check('Burmese future duration is suffixed, not prefixed',
  relativeToNow(kickoff, now, 'my').endsWith('အကြာ'), relativeToNow(kickoff, now, 'my'));
check('Burmese past duration', relativeToNow(now, new Date(kickoff), 'my').endsWith('က'),
  relativeToNow(now, new Date(kickoff), 'my'));

console.log('\nlocale negotiation');
check('my-MM resolves to Burmese', normalizeLocale('my-MM') === 'my');
check('bare my resolves to Burmese', normalizeLocale('my') === 'my');
check('legacy bur/mya tags resolve to Burmese',
  normalizeLocale('bur') === 'my' && normalizeLocale('mya') === 'my');
check('en-GB resolves to English', normalizeLocale('en-GB') === 'en');
check('unknown tags fall back to English', normalizeLocale('fr-FR') === 'en');
check('null falls back to English', normalizeLocale(null) === 'en');
check('every declared locale has a catalogue',
  LOCALES.every((l) => typeof messagesFor(l).app.name === 'string'));


console.log('\nrandom announcement');

const baseSession = {
  id: 'ses_1',
  startsAt: '2026-08-07T12:30:00.000Z',
  status: 'scheduled' as const,
  maxPlayers: 12,
  feePerPerson: 70_000,
  notes: null,
  venue: { name: 'Tao Dan', address: '1 Truong Dinh', mapUrl: null },
};
const detailWith = (over: Record<string, unknown> = {}, going = 5) =>
  ({ session: { ...baseSession, ...over }, registrations: [], counts: { in: going, waitlist: 0 } }) as never;

// Sweep the whole random range rather than one lucky seed: every joke in every
// slot, in both locales. The facts must survive all of them.
const everyRoll: string[] = [];
for (const locale of LOCALES) {
  for (let i = 0; i <= 20; i++) {
    everyRoll.push(sessionAnnouncement(detailWith(), { locale, random: () => i / 20 }));
  }
}
check('a roll of exactly 1.0 does not fall off the end of a list',
  everyRoll.every((t) => !t.includes('undefined')),
  everyRoll.find((t) => t.includes('undefined')));
check('the kickoff time is in every variant',
  everyRoll.every((t) => t.includes('19:30')));
check('the venue is in every variant', everyRoll.every((t) => t.includes('Tao Dan')));
check('the price is in every variant', everyRoll.every((t) => t.includes('70.000d')));
check('no variant is empty or a lone header', everyRoll.every((t) => t.split('\n').length >= 7));

// The joke is random; the number of players is not.
check('nobody signed up says so, never a count',
  sessionAnnouncement(detailWith({}, 0), { locale: 'en', random: () => 0.5 }).includes('Nobody has signed up'));
check('a full session says full, not "spots left"', (() => {
  const t = sessionAnnouncement(detailWith({}, 12), { locale: 'en', random: () => 0.5 });
  return t.includes('full') && !t.includes('spots left');
})());
check('a partial session counts the gap',
  sessionAnnouncement(detailWith({}, 5), { locale: 'en', random: () => 0.5 }).includes('7 spots left'));
check('no cap means no phantom spots left', (() => {
  const t = sessionAnnouncement(detailWith({ maxPlayers: null }, 5), { locale: 'en', random: () => 0.5 });
  return t.includes('5 in so far') && !t.includes('spots left');
})());

// A cancelled game is not an occasion for banter.
const cancelled = sessionAnnouncement(
  detailWith({ status: 'cancelled', notes: 'Pitch flooded' }),
  { locale: 'en', random: () => 0.5 },
);
check('a cancelled session drops the jokes', !cancelled.includes('👇') && cancelled.includes('CANCELLED'), cancelled);
check('and keeps the reason why', cancelled.includes('Pitch flooded'));

// The Burmese announcement must be Burmese, not the English bank reused.
const burmese = LOCALES.flatMap((l) =>
  l === 'my' ? [sessionAnnouncement(detailWith(), { locale: 'my', random: () => 0.3 })] : []);
check('Burmese announcements are in Myanmar script',
  burmese.every((t) => /[\u1000-\u109F]/.test(t)), burmese[0]);
check('and share no joke text with English', (() => {
  const enJokes = new Set([...en.announce.openers, ...en.announce.teases, ...en.announce.callToAction]);
  return [...my.announce.openers, ...my.announce.teases, ...my.announce.callToAction]
    .every((line) => !enJokes.has(line));
})());
check('both banks are the same size', (() => (
  en.announce.openers.length === my.announce.openers.length &&
  en.announce.teases.length === my.announce.teases.length &&
  en.announce.callToAction.length === my.announce.callToAction.length
))());


console.log('\nattendance streaks');

// Newest first, which is the order the query returns and the order the current
// streak has to be read in. `i` = in, `w` = waitlist, `x` = missed.
const run = (pattern: string) =>
  computeStreak(
    [...pattern].map((ch, index): StreakEntry => ({
      sessionId: `s${index}`,
      startsAt: new Date(Date.UTC(2026, 0, 30 - index)).toISOString(),
      attendance: ch === 'i' ? 'in' : ch === 'w' ? 'waitlist' : 'missed',
    })),
  );

check('no history at all', JSON.stringify(run('')) === JSON.stringify({ current: 0, best: 0, played: 0, total: 0 }),
  JSON.stringify(run('')));
check('an unbroken run', run('iiii').current === 4 && run('iiii').best === 4);
check('a miss last week ends the current run', run('xiii').current === 0, JSON.stringify(run('xiii')));
check('but the best run survives it', run('xiii').best === 3, JSON.stringify(run('xiii')));
check('the current run stops at the first gap', run('iixii').current === 2, JSON.stringify(run('iixii')));
check('and best looks past it', run('iixiii').best === 3, JSON.stringify(run('iixiii')));
check('best is the longest, not the latest', run('iixiiii').best === 4, JSON.stringify(run('iixiiii')));

// The waitlist rule: you said yes, there was no room. It must not end a run.
check('the waitlist does not break a streak', run('iwii').current === 3, JSON.stringify(run('iwii')));
check('and does not inflate one either', run('iwii').played === 3, JSON.stringify(run('iwii')));
check('a waitlist-only history has no streak', run('www').current === 0 && run('www').best === 0);
check('waitlisted games still count in the total', run('iwii').total === 4, JSON.stringify(run('iwii')));
check('a run that is only waitlists between plays joins up', run('iwwwi').current === 2,
  JSON.stringify(run('iwwwi')));

check('played counts every game, not just the current run', run('ixixi').played === 3,
  JSON.stringify(run('ixixi')));
check('never played', JSON.stringify(run('xxx')) === JSON.stringify({ current: 0, best: 0, played: 0, total: 3 }),
  JSON.stringify(run('xxx')));


console.log('\navatar initials');

check('one word', initialsOf('Bao') === 'B', initialsOf('Bao'));
check('two words take one letter each', initialsOf('Chan Nyein') === 'CN', initialsOf('Chan Nyein'));
check('a third word is ignored', initialsOf('Chan Nyein Tun') === 'CN', initialsOf('Chan Nyein Tun'));
check('extra whitespace does not produce blanks', initialsOf('  Bao   Nguyen  ') === 'BN',
  initialsOf('  Bao   Nguyen  '));
check('an empty name gives an empty string', initialsOf('   ') === '', JSON.stringify(initialsOf('   ')));

// Vietnamese: the group is in Ho Chi Minh City, so stacked tone marks on a
// Latin base are the common case, not an edge case.
check('Vietnamese diacritics survive', initialsOf('Đức Anh') === 'ĐA', initialsOf('Đức Anh'));

/**
 * Burmese is the reason this function exists.
 *
 * Each of these begins with a base consonant carrying attached marks. A naive
 * `name[0]` returns the bare consonant and drops them; `slice(0, 2)` can stop
 * *inside* the cluster and leave a combining mark with nothing to combine
 * with, which renders as a dotted circle (◌). What must hold is that the
 * result is a real prefix of the name and begins with a base consonant —
 * U+1000..U+102A — rather than a mark.
 */
const burmeseNames = ['ကျော်စွာ', 'မြင့်မိုရ်', 'ချမ်းမြေ့', 'အောင်'];
const startsWithBaseConsonant = (text: string) => /^[\u1000-\u102A]/.test(text);

for (const name of burmeseNames) {
  const got = initialsOf(name);
  check(`Burmese ${name} -> ${got} is a prefix of the name`, name.startsWith(got), JSON.stringify(got));
  check(`Burmese ${name} -> ${got} starts on a base consonant`, startsWithBaseConsonant(got),
    JSON.stringify(got));
}

const twoPart = initialsOf('ကျော်စွာ မောင်');
check('a Burmese two-part name takes a cluster from each',
  twoPart.length > 2 && startsWithBaseConsonant(twoPart), JSON.stringify(twoPart));

// Astral plane: an emoji is one grapheme, not two code units.
check('an emoji name is not cut in half', initialsOf('🦵 Legs') !== '\uD83E',
  JSON.stringify(initialsOf('🦵 Legs')));


console.log('\npasted invite links');

const N = 'aG9sYS10aGlzLWlzLWEtbm9uY2UtdmFsdWU';
const parsed = (text: string) => JSON.stringify(parseInvite(text));

check('a whole join URL',
  parsed(`https://futsal-friday.pages.dev/join#${N}`) === JSON.stringify({ nonce: N, kind: 'join' }),
  parsed(`https://futsal-friday.pages.dev/join#${N}`));
check('a whole claim URL',
  parsed(`https://futsal-friday.pages.dev/claim#${N}`) === JSON.stringify({ nonce: N, kind: 'claim' }),
  parsed(`https://futsal-friday.pages.dev/claim#${N}`));
check('a bare code has no kind',
  parsed(N) === JSON.stringify({ nonce: N, kind: null }), parsed(N));

// Chat clients mangle links in predictable ways.
check('surrounding chatter is ignored',
  parseInvite(`join here lads https://futsal-friday.pages.dev/join#${N} see you friday`)?.nonce === N,
  parsed(`join here lads https://futsal-friday.pages.dev/join#${N} see you friday`));
check('a trailing full stop is not part of the code',
  parseInvite(`https://futsal-friday.pages.dev/join#${N}.`)?.nonce === N,
  parsed(`https://futsal-friday.pages.dev/join#${N}.`));
check('tracking parameters before the fragment do not confuse it',
  parseInvite(`https://futsal-friday.pages.dev/join?utm_source=chat#${N}`)?.kind === 'join',
  parsed(`https://futsal-friday.pages.dev/join?utm_source=chat#${N}`));
check('whitespace around the paste is trimmed',
  parseInvite(`  https://futsal-friday.pages.dev/claim#${N}  `)?.nonce === N,
  parsed(`  https://futsal-friday.pages.dev/claim#${N}  `));
check('an unknown path still yields the code',
  parseInvite(`https://example.test/somewhere#${N}`)?.kind === null,
  parsed(`https://example.test/somewhere#${N}`));

check('empty input', parseInvite('') === null);
check('whitespace only', parseInvite('   ') === null);
check('prose with no code', parseInvite('hey can you send me the link') === null,
  parsed('hey can you send me the link'));
check('a short token is not a nonce', parseInvite('abc123') === null, parsed('abc123'));
// A link whose fragment never survived carries nothing to recover.
check('a URL with no fragment is refused',
  parseInvite('https://futsal-friday.pages.dev/join') === null,
  parsed('https://futsal-friday.pages.dev/join'));
check('a fragment with nothing usable in it',
  parseInvite('https://futsal-friday.pages.dev/join#') === null,
  parsed('https://futsal-friday.pages.dev/join#'));

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
