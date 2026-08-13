import {
  LOBBY_CHANNEL,
  SESSION_RUNS_FOR_MS,
  nextFridayKickoff,
  sessionChannel,
} from '@futsal/shared';
import { type SessionRow, getSessionRow } from './db.js';
import type { Env } from './env.js';
import { newId, nowIso } from './http.js';
import { sendDueNotifications } from './notifications.js';
import { createPubSub } from './realtime/index.js';

/**
 * Scheduled housekeeping, run hourly.
 *
 * Reminders are why this is hourly rather than daily: "three hours before
 * kickoff" cannot be hit by a once-a-day job.
 *
 * The session bookkeeping runs on every tick too. It could be gated to once a
 * day, but it is two indexed queries and entirely idempotent, so running it
 * hourly costs nothing measurable and buys promptness: a finished game opens
 * for payment within the hour, and a missing fixture is created within the hour
 * rather than waiting for tomorrow morning. Gating it would also have made it
 * untestable without mocking the clock.
 *
 *   1. Send any reminders that are due.
 *   2. Close out finished sessions.
 *   3. Make sure the upcoming Friday exists, inheriting last week's venue.
 */
export async function runScheduledMaintenance(env: Env, now: Date = new Date()): Promise<void> {
  // Time-sensitive, so it goes first. Isolated so a push outage cannot stop
  // the session bookkeeping below.
  try {
    const summary = await sendDueNotifications(env, now);
    if (summary.sessionReminders || summary.paymentNudges || summary.removedSubscriptions) {
      console.log('notifications', JSON.stringify(summary));
    }
  } catch (error) {
    console.error('notification run failed', error);
  }

  await runSessionMaintenance(env, now);
}

export async function runSessionMaintenance(env: Env, now: Date = new Date()): Promise<void> {
  const pubsub = createPubSub(env);

  const completed = await completeFinishedSessions(env, now);
  for (const session of completed) {
    await pubsub.emit([sessionChannel(session.id), LOBBY_CHANNEL], 'session.updated', {
      sessionId: session.id,
      status: 'completed',
      startsAt: session.starts_at,
      venueId: session.venue_id,
      reason: 'completed',
      at: nowIso(),
    });
  }

  const created = await ensureUpcomingSession(env, now);
  if (created) {
    const session = await getSessionRow(env.DB, created);
    if (session) {
      await pubsub.emit([sessionChannel(session.id), LOBBY_CHANNEL], 'session.updated', {
        sessionId: session.id,
        status: session.status,
        startsAt: session.startsAt,
        venueId: session.venueId,
        reason: 'created',
        at: nowIso(),
      });
    }
  }
}

/**
 * A session is "finished" two hours after kickoff — see `SESSION_RUNS_FOR_MS`,
 * which the team board reads too so that both agree about when the game ended.
 */
async function completeFinishedSessions(env: Env, now: Date): Promise<SessionRow[]> {
  const cutoff = new Date(now.getTime() - SESSION_RUNS_FOR_MS).toISOString();

  const { results } = await env.DB.prepare(
    `SELECT * FROM sessions WHERE status = 'scheduled' AND starts_at < ?1`,
  )
    .bind(cutoff)
    .all<SessionRow>();

  if (results.length === 0) return [];

  await env.DB.prepare(
    `UPDATE sessions SET status = 'completed', updated_at = ?2
      WHERE status = 'scheduled' AND starts_at < ?1`,
  )
    .bind(cutoff, nowIso())
    .run();

  return results;
}

/**
 * Create the upcoming Friday 19:30 ICT session if the group has nothing
 * scheduled.
 *
 * The guard is "is there *any* future scheduled session", not "is there one at
 * exactly this timestamp". That way an organizer who has already moved this
 * week's game to Thursday does not get a duplicate Friday fixture created
 * underneath them.
 */
async function ensureUpcomingSession(env: Env, now: Date): Promise<string | null> {
  const existing = await env.DB.prepare(
    `SELECT id FROM sessions WHERE status = 'scheduled' AND starts_at >= ?1 LIMIT 1`,
  )
    .bind(now.toISOString())
    .first<{ id: string }>();
  if (existing) return null;

  // Inherit the venue, fee and cap from whatever the group played last, which
  // is almost always what they want again.
  const previous = await env.DB.prepare(
    `SELECT * FROM sessions WHERE status <> 'cancelled' ORDER BY starts_at DESC LIMIT 1`,
  ).first<SessionRow>();

  const id = newId('ses');
  const timestamp = nowIso();
  const startsAt = nextFridayKickoff(now).toISOString();

  try {
    await env.DB.prepare(
      `INSERT INTO sessions
         (id, starts_at, venue_id, status, fee_per_person, max_players, notes,
          created_at, updated_at)
       VALUES (?1, ?2, ?3, 'scheduled', ?4, ?5, NULL, ?6, ?6)`,
    )
      .bind(
        id,
        startsAt,
        previous?.venue_id ?? null,
        previous?.fee_per_person ?? null,
        previous?.max_players ?? null,
        timestamp,
      )
      .run();
  } catch (error) {
    // The partial unique index on starts_at makes a concurrent or retried run
    // a no-op rather than a duplicate fixture.
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) return null;
    throw error;
  }

  return id;
}
