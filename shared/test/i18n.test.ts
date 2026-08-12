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
import { clockTime, formatKickoff, formatTime, relativeToNow } from '../src/time.ts';
import { sessionAnnouncement } from '../src/announce.ts';
import { computeStreak, type StreakEntry } from '../src/streak.ts';
import { initialsOf } from '../src/names.ts';
import { parseInvite } from '../src/invite.ts';
import { buildVietQrPayload, crc16, sanitizeReference } from '../src/vietqr.ts';
import {
  arrivedHeads, arrivedOnly, attendanceChecked, didAttend, suggestedTotal,
} from '../src/attendance.ts';
import { splitWithOverrides } from '../src/money.ts';

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
  venue: { name: 'Tao Dan', address: '1 Truong Dinh', mapUrl: null, priceNote: '600.000d/hour' },
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
// The pitch's hourly rate, which the organizer set and which does not move.
check('the hourly pitch rate is in every variant',
  everyRoll.every((t) => t.includes('600.000d/hour')));
// And never a per-person figure: the group books one hour some weeks and two
// the next, so a share cannot be honest before the game is played. The number
// that used to be quoted here was last week's, copied forward by the cron.
check('AND NO PER-PERSON PRICE IS PROMISED',
  everyRoll.every((t) => !t.includes('70.000d') && !/\/person|တစ်ယောက် ~/.test(t)),
  everyRoll.find((t) => t.includes('70.000d') || /\/person|တစ်ယောက် ~/.test(t)));
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


console.log('\nVietQR payloads');

/** Walk the TLV back apart, so the assertions read the payload as a bank would. */
function parseTlv(payload: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= payload.length) {
    const tag = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    out[tag] = payload.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

// The checksum is the part most implementations get wrong, because it covers
// its own "6304" header. This is a published payload with a known CRC.
const published =
  '00020001021238570010A00000072701270006970436011308810004580860208QRIBFTTA53037045802VN6304CD60';
check('CRC matches a published VietQR payload', crc16(published.slice(0, -4)) === 'CD60',
  crc16(published.slice(0, -4)));

const dynamic = buildVietQrPayload({
  bankBin: '970436',
  accountNumber: '0881000458086',
  amount: 70_000,
  reference: 'Futsal 14 Aug Bao',
});
const top = parseTlv(dynamic);
check('a built payload verifies its own checksum',
  crc16(dynamic.slice(0, -4)) === dynamic.slice(-4), dynamic.slice(-4));
// Tag 01 decides whether the payer can change the figure. "12" is a fixed bill
// and banking apps grey the field out. "11" asks for an editable amount, which
// BIDV and Zalo both ignore — so a bill for one person is marked "12".
check('an amount makes it a dynamic, fixed bill', top['01'] === '12', top['01']);
const editable = parseTlv(buildVietQrPayload({
  bankBin: '970436', accountNumber: '0881000458086', amount: 70_000, amountEditable: true,
}));
check('asking for an editable amount marks it static', editable['01'] === '11', editable['01']);
check('an editable payload carries the same amount', editable['54'] === '70000', editable['54']);
check('the amount is integer dong, no decimal point', top['54'] === '70000', top['54']);
check('currency is VND', top['53'] === '704', top['53']);
check('country is VN', top['58'] === 'VN', top['58']);

const napas = parseTlv(top['38'] ?? '');
check('the NAPAS application id is present', napas['00'] === 'A000000727', napas['00']);
check('transfer is to an account, not a card', napas['02'] === 'QRIBFTTA', napas['02']);
const beneficiary = parseTlv(napas['01'] ?? '');
check('the bank BIN round-trips', beneficiary['00'] === '970436', beneficiary['00']);
check('THE ACCOUNT NUMBER ROUND-TRIPS', beneficiary['01'] === '0881000458086', beneficiary['01']);
check('the reference round-trips', parseTlv(top['62'] ?? '')['08'] === 'Futsal 14 Aug Bao',
  parseTlv(top['62'] ?? '')['08']);

// No amount means a static code the payer fills in themselves.
const staticQr = parseTlv(buildVietQrPayload({ bankBin: '970436', accountNumber: '0881000458086' }));
check('without an amount it is marked static', staticQr['01'] === '11', staticQr['01']);
check('and carries no amount field', staticQr['54'] === undefined, staticQr['54']);
check('a zero amount is treated as no amount',
  parseTlv(buildVietQrPayload({ bankBin: '970436', accountNumber: '123456', amount: 0 }))['01'] === '11');
// `amountEditable` only means anything when there is an amount to mark.
check('no amount plus amountEditable is still static and empty', (() => {
  const q = parseTlv(buildVietQrPayload({
    bankBin: '970436', accountNumber: '123456', amountEditable: true,
  }));
  return q['01'] === '11' && q['54'] === undefined;
})());

// Rubbish in must not silently produce a QR that sends money nowhere.
const rejects = (fn: () => unknown) => {
  try { fn(); return false; } catch { return true; }
};
check('a short bank BIN is refused',
  rejects(() => buildVietQrPayload({ bankBin: '97043', accountNumber: '123456' })));
check('a non-numeric BIN is refused',
  rejects(() => buildVietQrPayload({ bankBin: '97o436', accountNumber: '123456' })));
check('an empty account number is refused',
  rejects(() => buildVietQrPayload({ bankBin: '970436', accountNumber: '' })));
check('an account number with punctuation is refused',
  rejects(() => buildVietQrPayload({ bankBin: '970436', accountNumber: '0881-0004' })));

// Vietnamese banks are unreliable with diacritics in the transfer note.
check('Vietnamese folds to ASCII', sanitizeReference('Sân Bóng Tao Đàn') === 'San Bong Tao Dan',
  sanitizeReference('Sân Bóng Tao Đàn'));
check('punctuation becomes spaces', sanitizeReference('Futsal — 14/08') === 'Futsal 14 08',
  sanitizeReference('Futsal — 14/08'));
check('a long note is truncated, not rejected', sanitizeReference('x'.repeat(80)).length === 25,
  String(sanitizeReference('x'.repeat(80)).length));
check('Burmese leaves nothing a bank could use', sanitizeReference('ဖူဆယ်') === '',
  JSON.stringify(sanitizeReference('ဖူဆယ်')));

// Every field length must stay two digits, whatever the inputs.
let badLength = '';
for (const account of ['1234', '0881000458086', '1234567890123456789']) {
  for (const amount of [0, 1, 1_000, 999_999_999]) {
    const built = buildVietQrPayload({ bankBin: '970436', accountNumber: account, amount, reference: 'A'.repeat(30) });
    if (crc16(built.slice(0, -4)) !== built.slice(-4)) badLength = `${account}/${amount}`;
  }
}
check('payloads stay well formed across account and amount sizes', badLength === '', badLength);

console.log('\nThe clock');

check('24-hour is unchanged and zero-padded', clockTime(19, 30) === '19:30', clockTime(19, 30));
check('12-hour drops the leading zero', clockTime(7, 5, true) === '7:05 AM', clockTime(7, 5, true));
check('evening kickoff reads as PM', clockTime(19, 30, true) === '7:30 PM', clockTime(19, 30, true));
// The two ends of the clock are where a naive `% 12` goes wrong.
check('MIDNIGHT IS 12 AM, NOT 0 AM', clockTime(0, 5, true) === '12:05 AM', clockTime(0, 5, true));
check('NOON IS 12 PM, NOT 0 PM', clockTime(12, 0, true) === '12:00 PM', clockTime(12, 0, true));
check('one minute before noon is still AM', clockTime(11, 59, true) === '11:59 AM',
  clockTime(11, 59, true));
// A Friday 19:30 ICT kickoff, which is what the whole app is about.
const friday = '2026-08-14T12:30:00.000Z';
check('a kickoff formats on both clocks',
  formatKickoff(friday, 'en') === 'Fri 14 Aug, 19:30' &&
    formatKickoff(friday, 'en', true) === 'Fri 14 Aug, 7:30 PM',
  `${formatKickoff(friday, 'en')} / ${formatKickoff(friday, 'en', true)}`);
check('and Burmese keeps its own comma with AM/PM in Latin',
  formatKickoff(friday, 'my', true).includes('၊') &&
    formatKickoff(friday, 'my', true).endsWith('7:30 PM'),
  formatKickoff(friday, 'my', true));
check('formatTime follows the same rule', formatTime(friday, true) === '7:30 PM',
  formatTime(friday, true));

console.log('\nWho actually played');

// The presumption, which is the whole design: not marking anything must leave
// the bill exactly as it was before attendance existed.
check('a player nobody marked is presumed to have arrived',
  didAttend({ status: 'in' }) === true);
check('a waitlister nobody marked is presumed absent',
  didAttend({ status: 'waitlist' }) === false);
check('an explicit no-show is absent however they registered',
  didAttend({ status: 'in', attended: false }) === false);
check('a waitlister who played is present — the reserve who was never promoted',
  didAttend({ status: 'waitlist', attended: true }) === true);

check('an unmarked solo player is one head', arrivedHeads({ status: 'in' }) === 1);
check('an unmarked party bills for everyone registered',
  arrivedHeads({ status: 'in', guests: 2 }) === 3);
check('A NO-SHOW IS WORTH NOTHING',
  arrivedHeads({ status: 'in', guests: 2, attended: false }) === 0);
check('bringing one fewer friend than planned bills for one fewer',
  arrivedHeads({ status: 'in', guests: 2, guestsArrived: 1 }) === 2);
check('guests cannot exceed the number registered',
  arrivedHeads({ status: 'in', guests: 1, guestsArrived: 4 }) === 2);
check('guests cannot go negative',
  arrivedHeads({ status: 'in', guests: 2, guestsArrived: -3 }) === 1);
check('an absent member whose guests still came bills only the guests',
  arrivedHeads({ status: 'in', guests: 2, attended: false, guestsArrived: 2 }) === 2);
check('a waitlisted party that played counts in full',
  arrivedHeads({ status: 'waitlist', guests: 1, attended: true }) === 2);

const roster = [
  { id: 'a', status: 'in' as const },
  { id: 'b', status: 'in' as const, guests: 2 },
  { id: 'c', status: 'in' as const, attended: false },
  { id: 'd', status: 'waitlist' as const },
  { id: 'e', status: 'waitlist' as const, attended: true },
];
check('only the people who played are billed',
  arrivedOnly(roster).map((r) => r.id).join(',') === 'a,b,e',
  arrivedOnly(roster).map((r) => r.id).join(','));
check('an untouched roster reports itself unchecked',
  attendanceChecked([{ status: 'in' }, { status: 'in', guests: 1 }]) === false);
check('one mark is enough to count as checked', attendanceChecked(roster) === true);

check('the suggested total is the standing fee times heads that turned up',
  suggestedTotal(70_000, roster) === 70_000 * 5, String(suggestedTotal(70_000, roster)));
check('no standing fee means no suggestion', suggestedTotal(null, roster) === null);
check('nobody there means no suggestion',
  suggestedTotal(70_000, [{ status: 'in', attended: false }]) === null);

// The point of the whole feature: the same pitch bill, divided by the people
// who were actually on the pitch.
const billed = arrivedOnly(roster);
const shares = splitWithOverrides(
  700_000,
  billed.map((r) => ({ id: r.id, override: null, heads: arrivedHeads(r) })),
);
const paid = [...shares.values()].reduce((a, b) => a + b, 0);
check('THE SPLIT STILL SUMS TO THE PITCH BILL EXACTLY', paid === 700_000, String(paid));
check('the no-show is not charged', shares.get('c') === undefined, String(shares.get('c')));
check('the reserve who played is charged', (shares.get('e') ?? 0) > 0, String(shares.get('e')));
check('the party of three pays three shares',
  (shares.get('b') ?? 0) === 3 * (shares.get('a') ?? 0),
  `${shares.get('b')} vs 3 x ${shares.get('a')}`);

// Against the old behaviour, which billed the sign-up sheet. Here the reserve
// stepped into the no-show's place, so the *per-head* figure happens to match
// — the difference that matters is which names are on the bill at all.
const naive = splitWithOverrides(
  700_000,
  roster.filter((r) => r.status === 'in').map((r) => ({ id: r.id, override: null, heads: 1 + (r.guests ?? 0) })),
);
check('billing the sign-up sheet charges the man who never came',
  naive.get('c') !== undefined && shares.get('c') === undefined);
check('and misses the man who played', naive.get('e') === undefined && shares.get('e') !== undefined);

// And when nobody replaces the no-show, the people who played carry his share.
const thin = [
  { id: 'a', status: 'in' as const },
  { id: 'b', status: 'in' as const },
  { id: 'c', status: 'in' as const },
  { id: 'd', status: 'in' as const, attended: false },
];
const arrivedShares = splitWithOverrides(600_000,
  arrivedOnly(thin).map((r) => ({ id: r.id, override: null, heads: arrivedHeads(r) })));
const signedUpShares = splitWithOverrides(600_000,
  thin.map((r) => ({ id: r.id, override: null, heads: 1 })));
check('a no-show nobody replaced raises everyone else\'s share',
  arrivedShares.get('a') === 200_000 && signedUpShares.get('a') === 150_000,
  `arrived ${arrivedShares.get('a')} vs signed-up ${signedUpShares.get('a')}`);
check('and the total is still exactly the pitch bill',
  [...arrivedShares.values()].reduce((x, y) => x + y, 0) === 600_000);

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
