import {
  type Registration,
  createSessionSchema,
  sessionChannel,
  updateSessionSchema,
  LOBBY_CHANNEL,
} from '@futsal/shared';
import { Hono } from 'hono';
import {
  SESSION_COLUMNS,
  SESSION_FROM,
  type SessionWithVenueRow,
  countRegistrations,
  getSessionRow,
  isRegistrationOpen,
  listRegistrations,
  loadSessionDetail,
  toSession,
} from '../db.js';
import type { AppContext } from '../env.js';
import { badRequest, conflict, newId, notFound, nowIso, parseBody } from '../http.js';
import { requireOrganizer } from '../middleware.js';
import { isUniqueViolation } from './members.js';

export const sessionRoutes = new Hono<AppContext>()

  /** Home screen: the next session plus a short history. */
  .get('/', async (c) => {
    const now = nowIso();

    const upcomingRow = await c.env.DB.prepare(
      `SELECT ${SESSION_COLUMNS} ${SESSION_FROM}
        WHERE s.status = 'scheduled' AND s.starts_at >= ?1
        ORDER BY s.starts_at ASC LIMIT 1`,
    )
      .bind(now)
      .first<SessionWithVenueRow>();

    const { results: recent } = await c.env.DB.prepare(
      `SELECT ${SESSION_COLUMNS} ${SESSION_FROM}
        WHERE s.starts_at < ?1 OR s.status <> 'scheduled'
        ORDER BY s.starts_at DESC LIMIT 12`,
    )
      .bind(now)
      .all<SessionWithVenueRow>();

    return c.json({
      upcoming: upcomingRow ? toSession(upcomingRow) : null,
      recent: recent.map(toSession),
    });
  })

  .get('/:id', async (c) => {
    const detail = await loadSessionDetail(
      c.env.DB,
      c.req.param('id'),
      c.get('identity').memberId,
    );
    if (!detail) throw notFound('No such session');
    return c.json(detail);
  })

  .post('/', requireOrganizer(), async (c) => {
    const input = await parseBody(c.req.raw, createSessionSchema);
    const timestamp = nowIso();
    const id = newId('ses');

    try {
      await c.env.DB.prepare(
        `INSERT INTO sessions
           (id, starts_at, venue_id, status, fee_per_person, max_players, notes,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, 'scheduled', ?4, ?5, ?6, ?7, ?7)`,
      )
        .bind(
          id,
          input.startsAt,
          input.venueId ?? null,
          input.feePerPerson ?? null,
          input.maxPlayers ?? null,
          input.notes ?? null,
          timestamp,
        )
        .run();
    } catch (error) {
      // Partial unique index on starts_at for non-cancelled sessions.
      if (isUniqueViolation(error)) throw conflict('A session already exists at that time');
      throw error;
    }

    const session = await getSessionRow(c.env.DB, id);
    if (!session) throw notFound('Session vanished after insert');

    await c.get('pubsub').emit([sessionChannel(id), LOBBY_CHANNEL], 'session.updated', {
      sessionId: id,
      status: session.status,
      startsAt: session.startsAt,
      venueId: session.venueId,
      reason: 'created',
      at: timestamp,
    });

    return c.json({ session }, 201);
  })

  .patch('/:id', requireOrganizer(), async (c) => {
    const id = c.req.param('id');
    const input = await parseBody(c.req.raw, updateSessionSchema);

    const existing = await getSessionRow(c.env.DB, id);
    if (!existing) throw notFound('No such session');

    const timestamp = nowIso();
    const next = {
      startsAt: input.startsAt ?? existing.startsAt,
      venueId: input.venueId === undefined ? existing.venueId : (input.venueId ?? null),
      feePerPerson:
        input.feePerPerson === undefined ? existing.feePerPerson : (input.feePerPerson ?? null),
      maxPlayers: input.maxPlayers === undefined ? existing.maxPlayers : (input.maxPlayers ?? null),
      notes: input.notes === undefined ? existing.notes : (input.notes ?? null),
      status: input.status ?? existing.status,
    };

    try {
      await c.env.DB.prepare(
        `UPDATE sessions
            SET starts_at = ?2, venue_id = ?3, fee_per_person = ?4, max_players = ?5,
                notes = ?6, status = ?7, updated_at = ?8
          WHERE id = ?1`,
      )
        .bind(
          id,
          next.startsAt,
          next.venueId,
          next.feePerPerson,
          next.maxPlayers,
          next.notes,
          next.status,
          timestamp,
        )
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('A session already exists at that time');
      throw error;
    }

    // Raising the cap should let waitlisted players in straight away rather
    // than waiting for someone to withdraw.
    if (next.maxPlayers !== existing.maxPlayers) {
      await promoteFromWaitlist(c.env.DB, id, next.maxPlayers);
    }

    const session = await getSessionRow(c.env.DB, id);
    if (!session) throw notFound('No such session');

    await c.get('pubsub').emit([sessionChannel(id), LOBBY_CHANNEL], 'session.updated', {
      sessionId: id,
      status: session.status,
      startsAt: session.startsAt,
      venueId: session.venueId,
      reason: next.status === 'cancelled' ? 'cancelled' : 'edited',
      at: timestamp,
    });

    return c.json({ session });
  })

  /* ------------------------------------------------------- registration */

  /**
   * "I'm in". Idempotent: tapping twice is a no-op rather than an error, which
   * matters on a flaky phone connection where the first response may be lost.
   */
  .post('/:id/register', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');

    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');
    if (session.status === 'cancelled') throw conflict('That session was cancelled');
    if (!isRegistrationOpen(session)) {
      throw conflict('Registration has closed for this session', 'registration_closed');
    }

    const timestamp = nowIso();

    // One statement so the cap check, the position and the insert cannot be
    // interleaved with a competing registration. The UNIQUE(session_id,
    // member_id) index is the backstop if two requests race here.
    const result = await c.env.DB.prepare(
      `INSERT INTO registrations (id, session_id, member_id, status, position, created_at)
       SELECT ?1, ?2, ?3,
              CASE
                WHEN ?4 IS NULL THEN 'in'
                WHEN (SELECT COUNT(*) FROM registrations
                       WHERE session_id = ?2 AND status = 'in') < ?4 THEN 'in'
                ELSE 'waitlist'
              END,
              COALESCE((SELECT MAX(position) FROM registrations WHERE session_id = ?2), 0) + 1,
              ?5
        WHERE NOT EXISTS (
          SELECT 1 FROM registrations WHERE session_id = ?2 AND member_id = ?3
        )`,
    )
      .bind(newId('reg'), sessionId, identity.memberId, session.maxPlayers, timestamp)
      .run();

    const registrations = await listRegistrations(c.env.DB, sessionId);
    const mine = registrations.find((r) => r.memberId === identity.memberId);
    if (!mine) throw conflict('Could not register you — try again');

    const counts = countRegistrations(registrations);
    const changed = result.meta.changes > 0;

    if (changed) {
      await c.get('pubsub').emit(sessionChannel(sessionId), 'player.joined', {
        sessionId,
        memberId: identity.memberId,
        memberName: identity.name,
        memberAvatarUpdatedAt: mine.memberAvatarUpdatedAt,
        status: mine.status,
        position: mine.position,
        counts,
        at: timestamp,
      });
    }

    return c.json({ registration: mine, counts, changed });
  })

  /** Withdraw, promoting the first waitlisted player into the freed spot. */
  .delete('/:id/register', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');

    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');
    if (!isRegistrationOpen(session)) {
      throw conflict('Registration has closed for this session', 'registration_closed');
    }

    const before = await listRegistrations(c.env.DB, sessionId);
    const mine = before.find((r) => r.memberId === identity.memberId);
    if (!mine) {
      return c.json({ counts: countRegistrations(before), changed: false, promoted: null });
    }

    // Only a departing *player* frees a spot; leaving the waitlist does not.
    const waitlistHead =
      mine.status === 'in' ? (before.find((r) => r.status === 'waitlist') ?? null) : null;

    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(`DELETE FROM registrations WHERE session_id = ?1 AND member_id = ?2`).bind(
        sessionId,
        identity.memberId,
      ),
    ];
    if (waitlistHead) {
      statements.push(promoteStatement(c.env.DB, sessionId, session.maxPlayers));
    }
    // D1 runs a batch as one transaction, so the spot is never double-filled.
    await c.env.DB.batch(statements);

    const after = await listRegistrations(c.env.DB, sessionId);
    const promoted = resolvePromotion(waitlistHead, after);
    const timestamp = nowIso();

    await c.get('pubsub').emit(sessionChannel(sessionId), 'player.left', {
      sessionId,
      memberId: identity.memberId,
      memberName: identity.name,
      promoted: promoted
        ? { memberId: promoted.memberId, memberName: promoted.memberName }
        : null,
      counts: countRegistrations(after),
      at: timestamp,
    });

    return c.json({ counts: countRegistrations(after), changed: true, promoted });
  });

/**
 * Promote the longest-waiting player, if the cap allows. The head of the
 * waitlist is chosen inside the statement rather than passed in, so a
 * concurrent withdrawal cannot promote the same person twice.
 */
function promoteStatement(
  db: D1Database,
  sessionId: string,
  maxPlayers: number | null,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE registrations
          SET status = 'in'
        WHERE id = (SELECT id FROM registrations
                     WHERE session_id = ?1 AND status = 'waitlist'
                     ORDER BY position ASC LIMIT 1)
          AND (?2 IS NULL
               OR (SELECT COUNT(*) FROM registrations
                    WHERE session_id = ?1 AND status = 'in') < ?2)`,
    )
    .bind(sessionId, maxPlayers);
}

/** Fill every spot the cap allows — used when the organizer raises the cap. */
async function promoteFromWaitlist(
  db: D1Database,
  sessionId: string,
  maxPlayers: number | null,
): Promise<void> {
  // Bounded loop: each pass promotes exactly one player, and the guard inside
  // the statement stops it as soon as the session is full.
  for (let i = 0; i < 60; i++) {
    const result = await promoteStatement(db, sessionId, maxPlayers).run();
    if (result.meta.changes === 0) break;
  }
}

/**
 * Who actually moved up. Recomputed from the post-write list rather than
 * assumed, so the reported name is never a stale guess.
 */
function resolvePromotion(
  candidate: Registration | null,
  after: readonly Registration[],
): Registration | null {
  if (!candidate) return null;
  const now = after.find((r) => r.memberId === candidate.memberId);
  return now?.status === 'in' ? now : null;
}
