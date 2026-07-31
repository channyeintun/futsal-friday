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

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
