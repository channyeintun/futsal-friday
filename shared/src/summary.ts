import { formatVnd } from './money.js';
import type { Payment, PaymentSummary, Session, SessionDetail } from './models.js';
import { formatKickoff } from './time.js';

/**
 * Plain-text snapshots for pasting into the group chat.
 *
 * Pure string building, no DOM — the "copy" part is the platform adapter's job.
 * Kept in /shared so a future bot could post the exact same text the app shows.
 */

export interface SummaryOptions {
  /** Appended as a call-to-action so newcomers can find the app. */
  appUrl?: string;
}

export function registrationSummary(detail: SessionDetail, options: SummaryOptions = {}): string {
  const { session, registrations, counts } = detail;
  const lines: string[] = [];

  lines.push(`⚽ FUTSAL — ${formatKickoff(session.startsAt)}`);

  if (session.status === 'cancelled') {
    lines.push('');
    lines.push('🚫 CANCELLED');
    return lines.join('\n');
  }

  if (session.venue) {
    lines.push(`📍 ${session.venue.name}${session.venue.address ? ` — ${session.venue.address}` : ''}`);
    if (session.venue.mapUrl) lines.push(`🗺 ${session.venue.mapUrl}`);
  }
  if (session.feePerPerson != null) {
    lines.push(`💰 ~${formatVnd(session.feePerPerson)}/person`);
  }

  const playing = registrations.filter((r) => r.status === 'in');
  const waiting = registrations.filter((r) => r.status === 'waitlist');

  lines.push('');
  lines.push(`IN (${counts.in}${session.maxPlayers ? `/${session.maxPlayers}` : ''})`);
  if (playing.length === 0) {
    lines.push('  — nobody yet —');
  } else {
    playing.forEach((r, i) => lines.push(`${i + 1}. ${r.memberName}`));
  }

  if (waiting.length > 0) {
    lines.push('');
    lines.push(`WAITLIST (${counts.waitlist})`);
    waiting.forEach((r, i) => lines.push(`${i + 1}. ${r.memberName}`));
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
  const lines: string[] = [];

  lines.push(`💰 PAYMENTS — ${formatKickoff(session.startsAt)}`);
  if (summary.totalCharge != null) {
    lines.push(`Field total: ${formatVnd(summary.totalCharge)}`);
  }
  lines.push(
    `Collected ${formatVnd(summary.collected)} · Outstanding ${formatVnd(summary.outstanding)}`,
  );

  const byStatus = (status: Payment['status']) =>
    summary.payments.filter((p) => p.status === status);

  const confirmed = byStatus('confirmed');
  const pending = byStatus('pending');
  const unpaid = byStatus('unpaid');

  if (confirmed.length > 0) {
    lines.push('');
    lines.push(`✅ PAID (${confirmed.length})`);
    lines.push(confirmed.map((p) => p.memberName).join(', '));
  }
  if (pending.length > 0) {
    lines.push('');
    lines.push(`⏳ CHECKING (${pending.length})`);
    lines.push(pending.map((p) => p.memberName).join(', '));
  }
  if (unpaid.length > 0) {
    lines.push('');
    lines.push(`❌ NOT YET (${unpaid.length})`);
    unpaid.map((p) => `${p.memberName} — ${formatVnd(p.amountDue)}`).forEach((l) => lines.push(l));
  }

  if (options.appUrl) {
    lines.push('');
    lines.push(`👉 ${options.appUrl}`);
  }

  return lines.join('\n');
}
