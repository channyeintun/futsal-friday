import {
  type Registration,
  createSessionSchema,
  markAttendanceSchema,
  sessionChannel,
  totalArrivedHeads,
  updateSessionSchema,
  LOBBY_CHANNEL,
  registerSchema,
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
import {
  badRequest,
  conflict,
  forbidden,
  newId,
  notFound,
  nowIso,
  parseBody,
  parseOptionalBody,
} from '../http.js';
import { requireOrganizer } from '../middleware.js';
import { isUniqueViolation } from './members.js';

/** Opaque `(starts_at, id)` position in the fixture history. */
function encodePastCursor(startsAt: string, id: string): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify({ s: startsAt, i: id }))));
}

function decodePastCursor(raw: string | undefined): { startsAt: string; id: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(escape(atob(raw))));
    if (typeof parsed?.s === 'string' && typeof parsed?.i === 'string') {
      return { startsAt: parsed.s, id: parsed.i };
    }
  } catch {
    // An unreadable cursor is the first page, not an error.
  }
  return null;
}

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

  /**
   * Fixtures that have already happened, newest first, a page at a time.
   *
   * The home screen used to get twelve of these bundled into `/sessions` and
   * no way to ask for a thirteenth — the group's history simply stopped there.
   * Keyset on `(starts_at DESC, id ASC)`: two sessions can share a kickoff
   * time (a midweek game added twice, a fixture moved onto another), and
   * without the id in the tuple one of them would be unreachable.
   */
  .get('/past', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);
    const cursor = decodePastCursor(c.req.query('cursor'));
    const now = nowIso();

    const statement = cursor
      ? c.env.DB.prepare(
          `SELECT ${SESSION_COLUMNS} ${SESSION_FROM}
            WHERE (s.starts_at < ?1 OR s.status <> 'scheduled')
              AND (s.starts_at < ?2 OR (s.starts_at = ?2 AND s.id > ?3))
            ORDER BY s.starts_at DESC, s.id ASC
            LIMIT ?4`,
        ).bind(now, cursor.startsAt, cursor.id, limit + 1)
      : c.env.DB.prepare(
          `SELECT ${SESSION_COLUMNS} ${SESSION_FROM}
            WHERE s.starts_at < ?1 OR s.status <> 'scheduled'
            ORDER BY s.starts_at DESC, s.id ASC
            LIMIT ?2`,
        ).bind(now, limit + 1);

    const { results } = await statement.all<SessionWithVenueRow>();
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return c.json({
      sessions: page.map(toSession),
      nextCursor:
        results.length > limit && last ? encodePastCursor(last.starts_at, last.id) : null,
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

    const { guests } = await parseOptionalBody(c.req.raw, registerSchema);
    const timestamp = nowIso();

    // One statement so the cap check, the position and the insert cannot be
    // interleaved with a competing registration. The UNIQUE(session_id,
    // member_id) index is the backstop if two requests race here.
    //
    // The cap is measured in heads, and a party is all-or-nothing: three
    // people cannot half-fit into two spots, and splitting them would leave
    // somebody's friend on a waitlist they have no way to be told about.
    const result = await c.env.DB.prepare(
      `INSERT INTO registrations
         (id, session_id, member_id, guests, status, position, created_at)
       SELECT ?1, ?2, ?3, ?6,
              CASE
                WHEN ?4 IS NULL THEN 'in'
                WHEN (SELECT COALESCE(SUM(1 + guests), 0) FROM registrations
                       WHERE session_id = ?2 AND status = 'in') + 1 + ?6 <= ?4 THEN 'in'
                ELSE 'waitlist'
              END,
              COALESCE((SELECT MAX(position) FROM registrations WHERE session_id = ?2), 0) + 1,
              ?5
        WHERE NOT EXISTS (
          SELECT 1 FROM registrations WHERE session_id = ?2 AND member_id = ?3
        )`,
    )
      .bind(newId('reg'), sessionId, identity.memberId, session.maxPlayers, timestamp, guests)
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
        guests: mine.guests,
        status: mine.status,
        position: mine.position,
        counts,
        at: timestamp,
      });
    }

    return c.json({ registration: mine, counts, changed });
  })

  /**
   * Change how many friends you are bringing, without losing your spot.
   *
   * Bounded by the cap on the way up: three extra heads cannot appear in two
   * remaining spots. Going down always works, and frees the difference for
   * whoever is waiting — so the promotion sweep runs afterwards.
   */
  .patch('/:id/register', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');
    const { guests } = await parseOptionalBody(c.req.raw, registerSchema);

    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');
    if (!isRegistrationOpen(session)) {
      throw conflict('Registration has closed for this session', 'registration_closed');
    }

    const before = await listRegistrations(c.env.DB, sessionId);
    const mine = before.find((r) => r.memberId === identity.memberId);
    if (!mine) throw conflict('Register yourself first');

    // Only a spot on the pitch is capped; a longer waitlist entry costs
    // nobody anything.
    if (mine.status === 'in' && session.maxPlayers !== null) {
      const othersHeads = before
        .filter((r) => r.status === 'in' && r.memberId !== identity.memberId)
        .reduce((sum, r) => sum + 1 + r.guests, 0);
      if (othersHeads + 1 + guests > session.maxPlayers) {
        throw conflict(
          `There is only room for ${Math.max(0, session.maxPlayers - othersHeads - 1)} more`,
          'session_full',
        );
      }
    }

    const timestamp = nowIso();
    await c.env.DB.prepare(
      `UPDATE registrations SET guests = ?3 WHERE session_id = ?1 AND member_id = ?2`,
    )
      .bind(sessionId, identity.memberId, guests)
      .run();

    // Bringing fewer friends may have opened a spot somebody is waiting for.
    if (guests < mine.guests) await promoteFromWaitlist(c.env.DB, sessionId, session.maxPlayers);

    const after = await listRegistrations(c.env.DB, sessionId);
    const updated = after.find((r) => r.memberId === identity.memberId);
    const counts = countRegistrations(after);

    // A party size change reshuffles the list and may promote somebody, which
    // is more than the `player.joined` patch can express — so viewers refetch.
    await c.get('pubsub').emit(sessionChannel(sessionId), 'session.updated', {
      sessionId,
      status: session.status as 'scheduled' | 'cancelled' | 'completed',
      startsAt: session.startsAt,
      venueId: session.venueId,
      reason: 'edited',
      at: timestamp,
    });

    return c.json({ registration: updated, counts, changed: guests !== mine.guests });
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
  })

  /* --------------------------------------------------------- attendance */

  /**
   * Say who turned up.
   *
   * Anybody may mark themselves. Only an organizer may mark somebody else, which
   * is what makes this usable in practice: the person who did not come is
   * exactly the person who will not open the app to say so.
   *
   * Deliberately not gated on kickoff having passed. The screen only offers it
   * after the whistle, but a clock check here would reject a late correction to
   * a game last week — and correcting the record afterwards is most of the
   * point. Re-settling recomputes every share from scratch, so a fix hours later
   * still produces the right bill.
   */
  .post('/:id/attendance', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');
    const input = await parseBody(c.req.raw, markAttendanceSchema);

    const subject = input.memberId ?? identity.memberId;
    if (subject !== identity.memberId && !identity.isOrganizer) {
      throw forbidden('Only an organizer can mark somebody else');
    }

    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');
    if (session.status === 'cancelled') throw conflict('That session was cancelled');

    const before = await listRegistrations(c.env.DB, sessionId);
    const target = before.find((r) => r.memberId === subject);
    if (!target) throw notFound('They are not on the list for that session');

    // Absent fields mean "leave alone", so the two halves of this — whether they
    // came, and how many friends came with them — can be sent independently.
    const attended = input.attended === undefined ? target.attended : input.attended;
    const guestsArrived =
      input.guestsArrived === undefined ? target.guestsArrived : input.guestsArrived;

    if (guestsArrived != null && guestsArrived > target.guests) {
      throw badRequest(`They only registered ${target.guests} guest(s)`);
    }

    const timestamp = nowIso();
    await c.env.DB.prepare(
      `UPDATE registrations
          SET attended = ?3, guests_arrived = ?4,
              attendance_marked_at = ?5, attendance_marked_by = ?6
        WHERE session_id = ?1 AND member_id = ?2`,
    )
      .bind(
        sessionId,
        subject,
        attended == null ? null : attended ? 1 : 0,
        guestsArrived,
        timestamp,
        identity.memberId,
      )
      .run();

    const after = await listRegistrations(c.env.DB, sessionId);

    await c.get('pubsub').emit(sessionChannel(sessionId), 'player.attendance', {
      sessionId,
      memberId: subject,
      memberName: target.memberName,
      attended,
      guestsArrived,
      arrivedHeads: totalArrivedHeads(after),
      byMemberId: identity.memberId,
      at: timestamp,
    });

    return c.json({ registrations: after, arrivedHeads: totalArrivedHeads(after) });
  })
;

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
  // The first waitlisted party that *fits*, not simply the first.
  //
  // A party of three behind two free spots cannot be promoted whole, and
  // splitting it is not on the table — so the spots would sit empty while a
  // solo player waits behind them. Skipping to whoever fits keeps the pitch
  // full without ever reordering anybody: positions are untouched, and the
  // skipped party is still first in line for the next opening big enough.
  return db
    .prepare(
      `UPDATE registrations
          SET status = 'in'
        WHERE id = (
          SELECT w.id FROM registrations w
           WHERE w.session_id = ?1 AND w.status = 'waitlist'
             AND (?2 IS NULL
                  OR (SELECT COALESCE(SUM(1 + guests), 0) FROM registrations
                       WHERE session_id = ?1 AND status = 'in') + 1 + w.guests <= ?2)
           ORDER BY w.position ASC LIMIT 1
        )`,
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
