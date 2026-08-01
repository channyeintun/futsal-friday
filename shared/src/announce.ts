import { type Locale, messagesFor } from './i18n/index.js';
import { formatVnd } from './money.js';
import type { SessionDetail } from './models.js';
import { formatKickoff } from './time.js';

/**
 * A random, slightly rude announcement to drop into the group chat.
 *
 * The sibling of `registrationSummary` in summary.ts: same job — text for the
 * chat — but this one is for the nudge before anyone has signed up, where a
 * neat table of zero names persuades nobody.
 *
 * The jokes come out of the locale catalogue rather than being translated at
 * runtime, because a Burmese joke is not an English joke with the words
 * swapped. Only the flavour is random; the kickoff, venue and price are always
 * the real ones, so a funny message is still a correct message.
 */

export interface AnnounceOptions {
  appUrl?: string;
  locale?: Locale;
  /**
   * Injected so the same message can be reproduced — the tests pin it, and the
   * shuffle button uses it to avoid handing back the line it just showed.
   */
  random?: () => number;
}

function pick<T>(list: readonly T[], random: () => number): T {
  // `random()` is allowed to return 1 by callers who are not Math.random.
  return list[Math.min(Math.floor(random() * list.length), list.length - 1)] as T;
}

export function sessionAnnouncement(
  detail: SessionDetail,
  options: AnnounceOptions = {},
): string {
  const locale = options.locale ?? 'en';
  const random = options.random ?? Math.random;
  const m = messagesFor(locale);
  const { session, counts } = detail;
  const lines: string[] = [];

  // Nothing funny about a cancelled game; say it plainly and stop.
  if (session.status === 'cancelled') {
    return [
      `🚫 ${m.summary.cancelled} — ${formatKickoff(session.startsAt, locale)}`,
      ...(session.notes ? [session.notes] : []),
    ].join('\n');
  }

  lines.push(pick(m.announce.openers, random));
  lines.push('');

  lines.push(`⚽ ${formatKickoff(session.startsAt, locale)}`);
  if (session.venue) {
    lines.push(`📍 ${session.venue.name}${session.venue.address ? ` — ${session.venue.address}` : ''}`);
    if (session.venue.mapUrl) lines.push(`🗺 ${session.venue.mapUrl}`);
  }
  if (session.feePerPerson != null) {
    lines.push(`💰 ${m.summary.perPersonApprox(formatVnd(session.feePerPerson))}`);
  }

  lines.push('');
  lines.push(headcount(counts.in, session.maxPlayers, m));

  lines.push('');
  lines.push(pick(m.announce.teases, random));

  lines.push('');
  lines.push(pick(m.announce.callToAction, random));
  if (options.appUrl) lines.push(`👉 ${options.appUrl}`);

  return lines.join('\n');
}

/** The one line that has to be true, so it is picked by state, not at random. */
function headcount(
  going: number,
  maxPlayers: number | null | undefined,
  m: ReturnType<typeof messagesFor>,
): string {
  if (going === 0) return m.announce.nobodyYet;
  if (maxPlayers == null) return m.announce.soFar(going);
  const left = maxPlayers - going;
  if (left <= 0) return m.announce.full;
  return m.announce.spotsLeft(going, left);
}
