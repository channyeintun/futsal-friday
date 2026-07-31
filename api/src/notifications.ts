import { formatKickoff, formatTime, formatVnd, toZonedParts } from '@futsal/shared';
import { type Env, reminderLeadHours } from './env.js';
import { newId, nowIso } from './http.js';
import { type PushMessage, type PushTarget, createPushSender } from './push/index.js';

/**
 * Deciding who to notify, and making sure nobody is notified twice.
 *
 * The cron runs hourly and this is entirely idempotent: every send is gated on
 * inserting a row into `notifications` with a unique `dedupe_key`, so a cron
 * that fires twice, or a retry after a partial failure, sends nothing extra.
 * The key is what defines "the same notification":
 *
 *   session_reminder:<session_id>              once per member, ever
 *   payment_due:<session_id>:<YYYY-Www>        at most once a week per member
 */

interface Recipient {
  memberId: string;
  memberName: string;
}

/**
 * Raw shape D1 returns for the recipient queries.
 *
 * Kept separate and mapped explicitly because `.all<T>()` is an unchecked cast:
 * annotating a snake_case result set as a camelCase type compiles happily and
 * then binds `undefined` at runtime.
 */
interface RecipientRow {
  member_id: string;
  member_name: string;
}

const toRecipient = (row: RecipientRow): Recipient => ({
  memberId: row.member_id,
  memberName: row.member_name,
});

export interface NotificationSummary {
  sessionReminders: number;
  paymentNudges: number;
  removedSubscriptions: number;
}

export async function sendDueNotifications(
  env: Env,
  now: Date = new Date(),
): Promise<NotificationSummary> {
  const sender = createPushSender(env);
  const summary: NotificationSummary = {
    sessionReminders: 0,
    paymentNudges: 0,
    removedSubscriptions: 0,
  };
  if (!sender.enabled) return summary;

  const removed = new Set<string>();

  // Isolated on purpose: a failure in one kind of reminder must not suppress
  // the other. They share nothing but the subscription table.
  try {
    summary.sessionReminders = await sendSessionReminders(env, now, removed);
  } catch (error) {
    console.error('session reminders failed', error);
  }

  try {
    summary.paymentNudges = await sendPaymentNudges(env, now, removed);
  } catch (error) {
    console.error('payment nudges failed', error);
  }

  summary.removedSubscriptions = removed.size;
  return summary;
}

/* ------------------------------------------------------- match is coming up */

/**
 * "Kickoff in a few hours" to everyone actually playing.
 *
 * The window is [lead, lead + 1h) because the cron runs hourly — a session is
 * caught by exactly one run. Waitlisted players are left out on purpose: being
 * reminded about a game you are not in is noise.
 */
async function sendSessionReminders(
  env: Env,
  now: Date,
  removed: Set<string>,
): Promise<number> {
  const lead = reminderLeadHours(env);
  const from = new Date(now.getTime() + lead * 3_600_000).toISOString();
  const to = new Date(now.getTime() + (lead + 1) * 3_600_000).toISOString();

  const { results: sessions } = await env.DB.prepare(
    `SELECT s.id, s.starts_at, s.fee_per_person, v.name AS venue_name
       FROM sessions s
       LEFT JOIN venues v ON v.id = s.venue_id
      WHERE s.status = 'scheduled' AND s.starts_at >= ?1 AND s.starts_at < ?2`,
  )
    .bind(from, to)
    .all<{
      id: string;
      starts_at: string;
      fee_per_person: number | null;
      venue_name: string | null;
    }>();

  let sent = 0;

  for (const session of sessions) {
    const { results: players } = await env.DB.prepare(
      `SELECT m.id AS member_id, m.name AS member_name
         FROM registrations r
         JOIN members m ON m.id = r.member_id
        WHERE r.session_id = ?1 AND r.status = 'in'
          AND m.active = 1 AND m.notify_session = 1`,
    )
      .bind(session.id)
      .all<RecipientRow>();

    const where = session.venue_name ? ` at ${session.venue_name}` : '';
    const message: PushMessage = {
      title: `Futsal today, ${formatTime(session.starts_at)}`,
      body: `Kickoff in about ${Math.round(lead)}h${where}.`,
      url: `/session/${session.id}`,
      tag: `session-${session.id}`,
      // Pointless to deliver after the game has finished.
      ttl: Math.max(600, Math.floor(lead * 3600)),
    };

    sent += await deliver(
      env,
      players.map(toRecipient),
      message,
      `session_reminder:${session.id}`,
      'session_reminder',
      removed,
    );
  }

  return sent;
}

/* ------------------------------------------------------------ still unpaid */

/**
 * Nudge people who owe money for a session that has already been settled.
 *
 * Only fires once a day's grace has passed — nobody wants a notification an
 * hour after the whistle — and at most weekly per session thereafter, so an
 * unpaid debt becomes a gentle recurring reminder rather than a daily nag.
 */
async function sendPaymentNudges(env: Env, now: Date, removed: Set<string>): Promise<number> {
  const graceCutoff = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const week = isoWeekKey(now);

  const { results: debts } = await env.DB.prepare(
    `SELECT p.session_id, p.amount_due, m.id AS member_id, m.name AS member_name,
            s.starts_at
       FROM payments p
       JOIN members m ON m.id = p.member_id
       JOIN sessions s ON s.id = p.session_id
      WHERE p.status = 'unpaid'
        AND p.amount_due > 0
        AND s.status = 'completed'
        AND s.starts_at < ?1
        AND m.active = 1
        AND m.notify_payment = 1`,
  )
    .bind(graceCutoff)
    .all<{
      session_id: string;
      amount_due: number;
      member_id: string;
      member_name: string;
      starts_at: string;
    }>();

  let sent = 0;

  for (const debt of debts) {
    const message: PushMessage = {
      title: 'Still to settle up',
      body: `${formatVnd(debt.amount_due)} for ${formatKickoff(debt.starts_at)}.`,
      url: `/payments/${debt.session_id}`,
      tag: `payment-${debt.session_id}`,
      ttl: 3 * 24 * 3600,
    };

    sent += await deliver(
      env,
      [{ memberId: debt.member_id, memberName: debt.member_name }],
      message,
      `payment_due:${debt.session_id}:${week}`,
      'payment_due',
      removed,
    );
  }

  return sent;
}

/* -------------------------------------------------------------- delivery */

/**
 * Send one message to a set of members, once each.
 *
 * The `notifications` row is inserted *before* sending, and a duplicate-key
 * conflict is the signal to skip. Claiming first means a crash mid-send costs
 * at most one missed reminder; claiming after would risk sending the same
 * notification on every subsequent run.
 */
async function deliver(
  env: Env,
  recipients: readonly Recipient[],
  message: PushMessage,
  dedupeKey: string,
  kind: 'session_reminder' | 'payment_due',
  removed: Set<string>,
): Promise<number> {
  if (recipients.length === 0) return 0;

  const sender = createPushSender(env);
  let sent = 0;

  for (const recipient of recipients) {
    const claimed = await claim(env, recipient.memberId, kind, dedupeKey);
    if (!claimed) continue;

    const { results: subscriptions } = await env.DB.prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
        WHERE member_id = ?1 AND failure_count < 5`,
    )
      .bind(recipient.memberId)
      .all<{ id: string; endpoint: string; p256dh: string; auth: string }>();

    if (subscriptions.length === 0) continue;

    const targets: PushTarget[] = subscriptions.map((row) => ({
      subscriptionId: row.id,
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    }));

    const outcomes = await Promise.all(targets.map((target) => sender.send(target, message)));

    const gone = outcomes.filter((o) => o.status === 'gone');
    const failed = outcomes.filter((o) => o.status === 'failed');
    const ok = outcomes.filter((o) => o.status === 'sent');
    if (ok.length > 0) sent++;

    const statements: D1PreparedStatement[] = [];

    for (const outcome of gone) {
      removed.add(outcome.subscriptionId);
      statements.push(
        env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?1`).bind(
          outcome.subscriptionId,
        ),
      );
    }
    for (const outcome of failed) {
      console.error(`push failed for ${outcome.subscriptionId}: ${outcome.reason}`);
      statements.push(
        env.DB.prepare(
          `UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?1`,
        ).bind(outcome.subscriptionId),
      );
    }
    for (const outcome of ok) {
      statements.push(
        env.DB.prepare(
          `UPDATE push_subscriptions SET failure_count = 0, last_success_at = ?2 WHERE id = ?1`,
        ).bind(outcome.subscriptionId, nowIso()),
      );
    }

    if (statements.length > 0) await env.DB.batch(statements);
  }

  return sent;
}

/** Returns false when this notification has already been sent to this member. */
async function claim(
  env: Env,
  memberId: string,
  kind: string,
  dedupeKey: string,
): Promise<boolean> {
  // D1 reports a bound `undefined` as an opaque type error with no column name.
  // Fail with something that says which value went missing instead.
  if (!memberId) throw new Error(`claim(${kind}, ${dedupeKey}): memberId is empty`);

  const result = await env.DB.prepare(
    `INSERT INTO notifications (id, member_id, kind, dedupe_key, sent_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (member_id, dedupe_key) DO NOTHING`,
  )
    .bind(newId('ntf'), memberId, kind, dedupeKey, nowIso())
    .run();

  return result.meta.changes > 0;
}

/**
 * ISO-8601 week key (`2026-W32`) in Ho Chi Minh time, so a weekly nudge lands
 * on the same day of the week locally rather than drifting across a UTC edge.
 */
export function isoWeekKey(instant: Date): string {
  const local = toZonedParts(instant);
  // Shift to the Thursday of this week: ISO weeks are numbered by the year
  // containing their Thursday.
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - day + 3);

  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);

  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}
