import { type Locale, messagesFor } from './i18n/index.js';
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
 * swapped. Only the flavour is random; the kickoff, venue and pitch rate are
 * always the real ones, so a funny message is still a correct message.
 */

export interface AnnounceOptions {
  appUrl?: string;
  locale?: Locale;
  /**
   * Injected so the same message can be reproduced — the tests pin it, and the
   * shuffle button uses it to avoid handing back the line it just showed.
   */
  random?: () => number;
  /**
   * The organizer's own first line, in place of one of the canned ones.
   *
   * Only the opener is overridable, and deliberately so: it is the sentence
   * that carries whatever is actually going on this week — a birthday, a new
   * pitch, somebody flying in — and it is the only line the joke bank cannot
   * know about. Everything under it is the kickoff, the venue and the price,
   * which are facts and are not the writer's to change.
   *
   * Blank or whitespace falls back to the shuffle, so clearing the box is how
   * you get the jokes back rather than a separate control.
   */
  opener?: string | null;
  /**
   * The writer's clock. Defaults to 24h, which is what it always was.
   *
   * The message language is chosen per announcement — the group chat is in
   * Burmese even when the organizer reads the app in English — but the clock
   * is not a property of the message, it is how the person writing it reads a
   * time. So this follows them rather than the language beside it.
   */
  hour12?: boolean;
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
  const hour12 = options.hour12 ?? false;
  const random = options.random ?? Math.random;
  const m = messagesFor(locale);
  const { session, counts } = detail;
  const lines: string[] = [];

  // Nothing funny about a cancelled game; say it plainly and stop.
  if (session.status === 'cancelled') {
    return [
      `🚫 ${m.summary.cancelled} — ${formatKickoff(session.startsAt, locale, hour12)}`,
      ...(session.notes ? [session.notes] : []),
    ].join('\n');
  }

  const written = options.opener?.trim();
  lines.push(written ? written : pick(m.announce.openers, random));
  lines.push('');

  lines.push(`⚽ ${formatKickoff(session.startsAt, locale, hour12)}`);
  if (session.venue) {
    lines.push(`📍 ${session.venue.name}${session.venue.address ? ` — ${session.venue.address}` : ''}`);
    if (session.venue.mapUrl) lines.push(`🗺 ${session.venue.mapUrl}`);
  }
  // The pitch's hourly rate, not a share.
  //
  // A per-person figure cannot be honest before the game: it depends on how
  // long they book — one hour some weeks, two the next — and on how many
  // actually turn up. Posting "~70.000d each" to fifteen people is a promise
  // the app has no way to keep, and the number it was quoting came from the
  // *previous* session anyway, copied forward by the cron. What the organizer
  // genuinely set, and what does not move week to week, is the pitch's price
  // per hour.
  if (session.venue?.priceNote) {
    lines.push(`💰 ${session.venue.priceNote}`);
  }

  lines.push('');
  // `counts.in` is heads, guests included — the number that decides whether
  // there is still room.
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
