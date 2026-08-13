import { type Locale, messagesFor } from './i18n/index.js';
import { formatVnd } from './money.js';
import type { Payment, PaymentSummary, Session, SessionDetail } from './models.js';
import { formatKickoff } from './time.js';

/**
 * Plain-text snapshots for pasting into the group chat.
 *
 * Pure string building, no DOM — the "copy" part is the platform adapter's job.
 * Kept in /shared so a future bot could post the exact same text the app shows,
 * and localised because the chat this lands in is the group's own.
 */

export interface SummaryOptions {
  /** Appended as a call-to-action so newcomers can find the app. */
  appUrl?: string;
  locale?: Locale;
  /**
   * The writer's clock. Defaults to 24h, which is what it always was.
   *
   * Threaded in rather than left to the default because these strings are the
   * app talking on somebody's behalf, and a person who reads 7:30 PM
   * everywhere else in the app should not paste 19:30 into the chat under
   * their own name.
   */
  hour12?: boolean;
}

export function registrationSummary(detail: SessionDetail, options: SummaryOptions = {}): string {
  const locale = options.locale ?? 'en';
  const hour12 = options.hour12 ?? false;
  const m = messagesFor(locale);
  const { session, registrations, counts } = detail;
  const lines: string[] = [];

  lines.push(`⚽ ${m.summary.matchHeader} — ${formatKickoff(session.startsAt, locale, hour12)}`);

  if (session.status === 'cancelled') {
    lines.push('');
    lines.push(`🚫 ${m.summary.cancelled}`);
    return lines.join('\n');
  }

  if (session.venue) {
    lines.push(`📍 ${session.venue.name}${session.venue.address ? ` — ${session.venue.address}` : ''}`);
    if (session.venue.mapUrl) lines.push(`🗺 ${session.venue.mapUrl}`);
  }
  // The pitch's hourly rate rather than a per-person share — see the note in
  // `announce.ts`: a share cannot be known before the game is played.
  if (session.venue?.priceNote) {
    lines.push(`💰 ${session.venue.priceNote}`);
  }

  const playing = registrations.filter((r) => r.status === 'in');
  const waiting = registrations.filter((r) => r.status === 'waitlist');

  lines.push('');
  lines.push(m.summary.inHeading(counts.in, session.maxPlayers));
  if (playing.length === 0) {
    lines.push(`  ${m.summary.nobodyYet}`);
  } else {
    // "3. Bao (+2)" — the head count has to add up for whoever reads this in
    // the chat and counts names against the number at the top.
    playing.forEach((r, i) =>
      lines.push(`${i + 1}. ${r.memberName}${r.guests > 0 ? m.summary.guestSuffix(r.guests) : ''}`),
    );
  }

  if (waiting.length > 0) {
    lines.push('');
    lines.push(m.summary.waitlistHeading(counts.waitlist));
    waiting.forEach((r, i) =>
      lines.push(`${i + 1}. ${r.memberName}${r.guests > 0 ? m.summary.guestSuffix(r.guests) : ''}`),
    );
  }

  if (session.notes) {
    lines.push('');
    lines.push(`📝 ${session.notes}`);
  }

  if (options.appUrl) {
    lines.push('');
    lines.push(`👉 ${options.appUrl}`);
  }

  return lines.join('\n');
}

export function paymentsSummary(
  session: Session,
  summary: PaymentSummary,
  options: SummaryOptions = {},
): string {
  const locale = options.locale ?? 'en';
  const hour12 = options.hour12 ?? false;
  const m = messagesFor(locale);
  const lines: string[] = [];

  lines.push(`💰 ${m.summary.paymentsHeader} — ${formatKickoff(session.startsAt, locale, hour12)}`);
  if (summary.totalCharge != null) {
    lines.push(m.summary.fieldTotal(formatVnd(summary.totalCharge)));
  }
  lines.push(
    m.summary.collectedOutstanding(formatVnd(summary.collected), formatVnd(summary.outstanding)),
  );

  const byStatus = (status: Payment['status']) =>
    summary.payments.filter((p) => p.status === status);

  const confirmed = byStatus('confirmed');
  const pending = byStatus('pending');
  const unpaid = byStatus('unpaid');

  if (confirmed.length > 0) {
    lines.push('');
    lines.push(`✅ ${m.summary.paid(confirmed.length)}`);
    lines.push(confirmed.map((p) => p.memberName).join(', '));
  }
  if (pending.length > 0) {
    lines.push('');
    lines.push(`⏳ ${m.summary.checking(pending.length)}`);
    lines.push(pending.map((p) => p.memberName).join(', '));
  }
  if (unpaid.length > 0) {
    lines.push('');
    lines.push(`❌ ${m.summary.notYet(unpaid.length)}`);
    unpaid
      .map(
        (p) =>
          `${p.memberName}${p.guests > 0 ? m.summary.guestSuffix(p.guests) : ''} — ${formatVnd(p.amountDue)}`,
      )
      .forEach((l) => lines.push(l));
  }

  if (options.appUrl) {
    lines.push('');
    lines.push(`👉 ${options.appUrl}`);
  }

  return lines.join('\n');
}
