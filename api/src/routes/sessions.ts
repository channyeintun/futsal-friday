import {
  type Registration,
  type TeamDraw,
  arrivedSlots,
  assignLatecomers,
  canDeleteMessage,
  canVoteFor,
  canRedrawTeams,
  canSplitInto,
  castVoteSchema,
  createSessionSchema,
  drawTeams,
  didAttend,
  drawTeamsSchema,
  markAttendanceSchema,
  maxTeamsFor,
  postMessageSchema,
  recordGoalsSchema,
  recordMatchSchema,
  roundRobin,
  sessionChannel,
  slotsMissingFrom,
  startOfZonedDay,
  totalArrivedHeads,
  updateSessionSchema,
  LOBBY_CHANNEL,
  registerSchema,
} from '@futsal/shared';
import { type Context, Hono } from 'hono';
import {
  SESSION_COLUMNS,
  SESSION_FROM,
  type SessionWithVenueRow,
  countRegistrations,
  getMemberById,
  getSessionRow,
  isRegistrationOpen,
  listRegistrations,
  listSessionMessages,
  loadMvp,
  loadSessionDetail,
  decodeSessionCursor,
  encodeSessionCursor,
  loadTeamDraw,
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

/**
 * Ceiling on how many people one draw will deal out.
 *
 * Twice the largest cap a session can be given, so it can never be reached by
 * a real fixture — it exists only so the write below stays a bounded batch on
 * a session that was created without a cap at all.
 */
const MAX_DRAW_SLOTS = 120;

/**
 * "This board is not settled, or you are an organizer" — as SQL.
 *
 * The same rule as `canRedrawTeams`, restated where the write happens. The
 * route checks permission with a read first, for a clean 403 in the ordinary
 * case; this is what stops a confirmation that lands in the gap between that
 * read and the batch from being quietly undone by the request it should have
 * refused. Written as a function of the parameter positions because each
 * statement in the batch binds them in a different order.
 */
function mayWriteBoard(sessionParam: string, organizerParam: string): string {
  return `(${organizerParam} = 1 OR NOT EXISTS (
            SELECT 1 FROM team_draws d
             WHERE d.session_id = ${sessionParam} AND d.confirmed_at IS NOT NULL))`;
}

export const sessionRoutes = new Hono<AppContext>()

  /**
   * Home screen: the session in play plus a short history.
   *
   * "In play" runs to the end of the day, not to kickoff — see
   * `startOfZonedDay`. Neither a passed kickoff nor a `completed` status
   * demotes tonight's game, because both happen while the group is still busy
   * with it: the cron completes a session two hours after it starts, and
   * settling the bill completes it too.
   */
  .get('/', async (c) => {
    const dayStart = startOfZonedDay().toISOString();

    const upcomingRow = await c.env.DB.prepare(
      `SELECT ${SESSION_COLUMNS} ${SESSION_FROM}
        WHERE s.status <> 'cancelled' AND s.starts_at >= ?1
        ORDER BY s.starts_at ASC LIMIT 1`,
    )
      .bind(dayStart)
      .first<SessionWithVenueRow>();

    const { results: recent } = await c.env.DB.prepare(
      `SELECT ${SESSION_COLUMNS} ${SESSION_FROM}
        WHERE s.starts_at < ?1 OR s.status = 'cancelled'
        ORDER BY s.starts_at DESC LIMIT 12`,
    )
      .bind(dayStart)
      .all<SessionWithVenueRow>();

    return c.json({
      upcoming: upcomingRow ? toSession(upcomingRow) : null,
      recent: recent.map(toSession),
    });
  })

  /**
   * Fixtures whose day is over, newest first, a page at a time.
   *
   * The home screen used to get twelve of these bundled into `/sessions` and
   * no way to ask for a thirteenth — the group's history simply stopped there.
   * Keyset on `(starts_at DESC, id ASC)`: two sessions can share a kickoff
   * time (a midweek game added twice, a fixture moved onto another), and
   * without the id in the tuple one of them would be unreachable.
   *
   * The window is the exact complement of the one above, so a fixture is in
   * one list or the other and never in both.
   */
  .get('/past', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);
    const cursor = decodeSessionCursor(c.req.query('cursor'));
    const dayStart = startOfZonedDay().toISOString();

    const statement = cursor
      ? c.env.DB.prepare(
          `SELECT ${SESSION_COLUMNS} ${SESSION_FROM}
            WHERE (s.starts_at < ?1 OR s.status = 'cancelled')
              AND (s.starts_at < ?2 OR (s.starts_at = ?2 AND s.id > ?3))
            ORDER BY s.starts_at DESC, s.id ASC
            LIMIT ?4`,
        ).bind(dayStart, cursor.startsAt, cursor.id, limit + 1)
      : c.env.DB.prepare(
          `SELECT ${SESSION_COLUMNS} ${SESSION_FROM}
            WHERE s.starts_at < ?1 OR s.status = 'cancelled'
            ORDER BY s.starts_at DESC, s.id ASC
            LIMIT ?2`,
        ).bind(dayStart, limit + 1);

    const { results } = await statement.all<SessionWithVenueRow>();
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return c.json({
      sessions: page.map(toSession),
      nextCursor:
        results.length > limit && last ? encodeSessionCursor(last.starts_at, last.id) : null,
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

  /**
   * "I scored two."
   *
   * Same shape and same rule as attendance — anybody may speak for themselves,
   * only an organizer may speak for somebody else — because it is the same
   * kind of fact about the same row: something only known once the game has
   * been played, and reported by the person who knows it.
   *
   * Not gated on having been marked present. Somebody scores, then somebody
   * else marks them absent by mistake; refusing the goal at that point would
   * make the correction order matter, and it should not.
   */
  .post('/:id/goals', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');
    const input = await parseBody(c.req.raw, recordGoalsSchema);

    const subject = input.memberId ?? identity.memberId;
    if (subject !== identity.memberId && !identity.isOrganizer) {
      throw forbidden('Only an organizer can record somebody else\'s goals');
    }

    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');
    if (session.status === 'cancelled') throw conflict('That session was cancelled');

    const updated = await c.env.DB.prepare(
      `UPDATE registrations SET goals = ?3 WHERE session_id = ?1 AND member_id = ?2`,
    )
      .bind(sessionId, subject, input.goals)
      .run();
    if ((updated.meta?.changes ?? 0) === 0) {
      throw notFound('They are not on the list for that session');
    }

    const after = await listRegistrations(c.env.DB, sessionId);
    return c.json({ registrations: after });
  })

  /* -------------------------------------------------------------- teams */

  /**
   * Split whoever turned up into sides.
   *
   * Open to any member, on purpose. This is done standing on the pitch in the
   * minute before kickoff, and gating it on the organizer being present, awake
   * and holding their phone would make it useless at exactly the moment it is
   * wanted. Nothing here is worth money and nothing is hard to undo — the
   * remedy for a draw somebody thinks is unfair is another draw, which is why
   * calling this again is an ordinary thing to do rather than an override.
   *
   * Not gated on kickoff having passed either, for the same reason attendance
   * is not: the screen decides when the question is worth asking, and a group
   * that turns up half an hour early is not doing anything wrong.
   */
  .post('/:id/teams', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');
    const { teamCount } = await parseBody(c.req.raw, drawTeamsSchema);

    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');
    if (session.status === 'cancelled') throw conflict('That session was cancelled');

    // Once the group has settled on a draw, moving anybody is an organizer's
    // call — see `canRedrawTeams`. Up to that point it is deliberately not.
    const existing = await loadTeamDraw(c.env.DB, sessionId);
    if (!canRedrawTeams(existing, identity)) {
      throw forbidden('These teams are settled — ask an organizer to redo them');
    }

    // The same presence rules as the bill, so the people being split are
    // exactly the people being charged.
    const registrations = await listRegistrations(c.env.DB, sessionId);
    const slots = arrivedSlots(registrations);

    if (slots.length === 0) {
      throw conflict('Nobody is down as having played yet');
    }
    // The batch below is one statement per body on the pitch, and a session
    // with no cap has no bound on how many bodies that is. Nothing near this
    // is a futsal match, but an unbounded batch is worth closing anyway.
    if (slots.length > MAX_DRAW_SLOTS) {
      throw badRequest(`That is too many players to split — ${MAX_DRAW_SLOTS} at most`);
    }
    if (!canSplitInto(slots.length, teamCount)) {
      throw badRequest(
        `Only ${slots.length} on the pitch — that is at most ${maxTeamsFor(slots.length)} teams`,
      );
    }

    const teams = drawTeams(slots, teamCount, cryptoRandom);
    const timestamp = nowIso();

    // The permission check above is a read, and a confirmation landing between
    // that read and this write would be silently undone by somebody who should
    // have been refused. So the rule is restated inside the statements, where
    // it is evaluated against the row as it stands at write time.
    const mayForce = identity.isOrganizer ? 1 : 0;
    const insertSlot = c.env.DB.prepare(
      `INSERT INTO team_slots (session_id, member_id, guest_index, team)
       SELECT ?1, ?2, ?3, ?4 WHERE ${mayWriteBoard('?1', '?5')}`,
    );

    // One batch, so a reshuffle is never observable half-applied: D1 runs it as
    // a single transaction, and two people tapping at once resolve to one whole
    // draw rather than a mix of both.
    //
    // A new draw resets the confirmation and wipes the fixtures. It has to:
    // the scorelines were recorded against sides that no longer exist, and
    // keeping them would attribute somebody's win to a team they were never on.
    await c.env.DB.batch([
      c.env.DB
        .prepare(`DELETE FROM team_slots WHERE session_id = ?1 AND ${mayWriteBoard('?1', '?2')}`)
        .bind(sessionId, mayForce),
      c.env.DB
        .prepare(`DELETE FROM team_matches WHERE session_id = ?1 AND ${mayWriteBoard('?1', '?2')}`)
        .bind(sessionId, mayForce),
      c.env.DB.prepare(
        `INSERT INTO team_draws (session_id, team_count, drawn_by, drawn_at)
         VALUES (?1, ?3, ?4, ?5)
         ON CONFLICT (session_id) DO UPDATE
           SET team_count = excluded.team_count,
               drawn_by = excluded.drawn_by,
               drawn_at = excluded.drawn_at,
               confirmed_at = NULL,
               confirmed_by = NULL
           WHERE ?2 = 1 OR team_draws.confirmed_at IS NULL`,
      ).bind(sessionId, mayForce, teamCount, identity.memberId, timestamp),
      // Guarded like the rest — and read *after* the upsert above, which has
      // by then either cleared `confirmed_at` or been blocked itself, so the
      // slots can never land without the draw row that describes them.
      ...teams.flatMap((team, index) =>
        team.map((slot) =>
          insertSlot.bind(sessionId, slot.memberId, slot.guestIndex, index, mayForce),
        ),
      ),
    ]);

    const draw = await loadTeamDraw(c.env.DB, sessionId);
    // Nothing moved: the guards refused, which means somebody settled the
    // teams while this request was in flight.
    if (draw?.drawnAt !== timestamp) {
      throw forbidden('These teams were settled while you were dealing — ask an organizer');
    }

    return c.json({ draw: await announceBoard(c, sessionId, timestamp) });
  })

  /**
   * "These are the teams."
   *
   * Open to anybody, like the draw itself: the group agrees out loud and
   * whoever is holding a phone taps it. What it changes is who may reshuffle
   * afterwards — from anyone to organizers only — because from here people put
   * bibs on and results start being recorded.
   *
   * Confirming is also what produces the fixture list, so that finishing a game
   * later is only ever a score against a line that already exists. Idempotent:
   * confirming twice does not regenerate the fixtures and so cannot wipe a
   * score somebody already entered.
   */
  .post('/:id/teams/confirm', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');

    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');
    if (session.status === 'cancelled') throw conflict('That session was cancelled');

    const existing = await loadTeamDraw(c.env.DB, sessionId);
    if (!existing) throw conflict('Split the teams first');
    if (existing.confirmedAt) return c.json({ draw: existing });

    const timestamp = nowIso();
    // `DO NOTHING` rather than a plain insert, and `confirmed_at IS NULL` on
    // the update: the read above makes confirming twice a no-op in the normal
    // case, but two people tapping at the same moment both see an unconfirmed
    // draw. Without these the second batch collides with the fixture list the
    // first one just wrote, and the tap fails for no reason the group can see.
    const insertMatch = c.env.DB.prepare(
      `INSERT INTO team_matches
         (id, session_id, ordinal, first_team, second_team, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE EXISTS (SELECT 1 FROM team_draws d
                       WHERE d.session_id = ?2 AND d.confirmed_at = ?6)
       ON CONFLICT (session_id, ordinal) DO NOTHING`,
    );

    await c.env.DB.batch([
      // Guarded on the draw still being the one that was read.
      //
      // The fixture list is generated from `existing.teamCount`, so a redraw
      // landing between that read and this write would settle the new teams
      // against the old draw's fixtures — a three-team list bolted onto two
      // sides, naming a Team C that nobody is on. `confirmed_at IS NULL`
      // covers the other half: two people confirming at the same moment.
      c.env.DB.prepare(
        `UPDATE team_draws SET confirmed_at = ?2, confirmed_by = ?3
          WHERE session_id = ?1 AND confirmed_at IS NULL AND drawn_at = ?4`,
      ).bind(sessionId, timestamp, identity.memberId, existing.drawnAt),
      // Everyone plays everyone. Two teams is one fixture; three is three.
      //
      // Each insert is conditional on the update above having been ours —
      // `confirmed_at` equals this request's timestamp only in that case — so
      // fixtures can never land against somebody else's draw.
      ...roundRobin(existing.teamCount).map(([firstTeam, secondTeam], ordinal) =>
        insertMatch.bind(newId('mat'), sessionId, ordinal, firstTeam, secondTeam, timestamp),
      ),
    ]);

    // Somebody else got there first, or redrew underneath us. Either way the
    // board in the database is the answer, and this stays idempotent.
    return c.json({ draw: await announceBoard(c, sessionId, timestamp) });
  })

  /**
   * Deal in whoever signed up after the teams were drawn.
   *
   * The board opens days before kickoff and registration stays open right up to
   * it, so "teams settled on Tuesday, two more people on Thursday" is the
   * ordinary case rather than an edge one. Redrawing answers it badly: it moves
   * people who already know their side, and on a confirmed board it takes the
   * fixture list and every recorded score with it.
   *
   * This only ever appends — each latecomer onto the smallest side — so nobody
   * moves and nothing is lost. Open to any member for that reason: there is
   * nothing here to object to, and the person watching somebody walk up is not
   * always the organizer.
   */
  .post('/:id/teams/latecomers', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');

    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');
    if (session.status === 'cancelled') throw conflict('That session was cancelled');

    const draw = await loadTeamDraw(c.env.DB, sessionId);
    if (!draw) throw conflict('Split the teams first');

    const registrations = await listRegistrations(c.env.DB, sessionId);
    const missing = slotsMissingFrom(draw, arrivedSlots(registrations));
    // Idempotent: nothing to add is a no-op, not an error. Two people tapping
    // it at once means the second finds nobody missing.
    if (missing.length === 0) return c.json({ draw });

    if (draw.teams.flat().length + missing.length > MAX_DRAW_SLOTS) {
      throw badRequest(`That is too many players to split — ${MAX_DRAW_SLOTS} at most`);
    }

    const timestamp = nowIso();
    const insertSlot = c.env.DB.prepare(
      `INSERT INTO team_slots (session_id, member_id, guest_index, team)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (session_id, member_id, guest_index) DO NOTHING`,
    );

    await c.env.DB.batch(
      assignLatecomers(draw.teams, missing, cryptoRandom).map(({ slot, team }) =>
        insertSlot.bind(sessionId, slot.memberId, slot.guestIndex, team),
      ),
    );

    return c.json({ draw: await announceBoard(c, sessionId, timestamp) });
  })

  /**
   * How a game finished.
   *
   * Anybody may record it and anybody may correct it, on the same reasoning as
   * attendance and goals: the person who knows the score is whoever is
   * standing there, not whoever holds the organizer flag. Sending both goals
   * as null puts the fixture back to "not played yet", which is a different
   * state from nil-nil and has to stay expressible.
   */
  .post('/:id/matches/:matchId', async (c) => {
    const sessionId = c.req.param('id');
    const matchId = c.req.param('matchId');
    const identity = c.get('identity');
    const input = await parseBody(c.req.raw, recordMatchSchema);

    // One score or the other alone is not a result, and storing half of one
    // would make "played" ambiguous everywhere it is read.
    if ((input.firstGoals == null) !== (input.secondGoals == null)) {
      throw badRequest('A score needs both sides');
    }

    // The same gate every other write to a session carries. A cancelled
    // fixture has no games in it to have a score.
    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');
    if (session.status === 'cancelled') throw conflict('That session was cancelled');

    const timestamp = nowIso();
    const played = input.firstGoals != null;
    const updated = await c.env.DB.prepare(
      `UPDATE team_matches
          SET first_goals = ?3, second_goals = ?4,
              recorded_at = ?5, recorded_by = ?6
        WHERE session_id = ?1 AND id = ?2`,
    )
      .bind(
        sessionId,
        matchId,
        input.firstGoals,
        input.secondGoals,
        played ? timestamp : null,
        played ? identity.memberId : null,
      )
      .run();

    if ((updated.meta?.changes ?? 0) === 0) throw notFound('No such match in this session');

    return c.json({ draw: await announceBoard(c, sessionId, timestamp) });
  })

  /* ---------------------------------------------------------------- mvp */

  /**
   * The vote, as this caller is allowed to see it.
   *
   * `loadMvp` withholds the tally until they have voted, and never returns who
   * voted for whom — see the note there and in the migration.
   */
  .get('/:id/mvp', async (c) =>
    c.json({ mvp: await loadMvp(c.env.DB, c.req.param('id'), c.get('identity').memberId) }),
  )

  /**
   * "Best player today was…"
   *
   * One vote each, changeable: sending a different nominee moves it rather than
   * adding a second, and sending null takes it back. Changing your mind is the
   * ordinary case — people vote early and then somebody scores a hat-trick.
   *
   * Voting is offered from kickoff and never closes, like attendance and goals:
   * the screen decides when to ask, and a correction days later still works.
   */
  .post('/:id/mvp', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');
    const { nomineeId } = await parseBody(c.req.raw, castVoteSchema);

    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');
    if (session.status === 'cancelled') throw conflict('That session was cancelled');

    const registrations = await listRegistrations(c.env.DB, sessionId);
    const candidates = registrations
      .filter((registration) => didAttend(registration))
      .map((registration) => ({ memberId: registration.memberId }));

    // Only somebody who was there gets a say. Not a permission so much as the
    // question itself: you cannot know who played best in a game you missed.
    if (!candidates.some((candidate) => candidate.memberId === identity.memberId)) {
      throw forbidden('Only somebody who played can vote');
    }

    if (nomineeId === null) {
      await c.env.DB.prepare(`DELETE FROM mvp_votes WHERE session_id = ?1 AND voter_id = ?2`)
        .bind(sessionId, identity.memberId)
        .run();
    } else {
      if (!canVoteFor(nomineeId, identity, candidates)) {
        // The two refusals are deliberately one message. Telling somebody
        // "you cannot vote for yourself" and "they did not play" apart is of
        // no use to anyone and the screen never offers either.
        throw badRequest('You can only vote for somebody else who played');
      }
      await c.env.DB.prepare(
        `INSERT INTO mvp_votes (session_id, voter_id, nominee_id, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (session_id, voter_id) DO UPDATE
           SET nominee_id = excluded.nominee_id, created_at = excluded.created_at`,
      )
        .bind(sessionId, identity.memberId, nomineeId, nowIso())
        .run();
    }

    // Everyone else is told only that the count moved. The payload carries no
    // nominee and no voter: a viewer who has not voted must not learn who is
    // ahead from an event, having been refused it by the read.
    await c.get('pubsub').emit(sessionChannel(sessionId), 'mvp.changed', {
      sessionId,
      at: nowIso(),
    });

    return c.json({ mvp: await loadMvp(c.env.DB, sessionId, identity.memberId) });
  })

  /* --------------------------------------------------------- trash talk */

  /**
   * The session's thread.
   *
   * Its own route rather than a field on the session detail: the roster has to
   * paint the moment the screen opens, and the banter is the part you scroll
   * to. Same reasoning as the form squares.
   */
  .get('/:id/messages', async (c) =>
    c.json({ messages: await listSessionMessages(c.env.DB, c.req.param('id')) }),
  )

  /**
   * Say something.
   *
   * Not gated on kickoff, on having registered, or on being an organizer. The
   * winding up starts days before the game and the gloating runs for a week
   * after, and somebody who is not playing this week has the most to say about
   * it. A cancelled session is the one exception: there is nothing to talk
   * about, and its thread goes down with it.
   */
  .post('/:id/messages', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');
    const { body } = await parseBody(c.req.raw, postMessageSchema);

    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');
    if (session.status === 'cancelled') throw conflict('That session was cancelled');

    const id = newId('msg');
    const timestamp = nowIso();
    await c.env.DB.prepare(
      `INSERT INTO session_messages (id, session_id, member_id, body, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(id, sessionId, identity.memberId, body, timestamp)
      .run();

    // Read back for the writer's picture, so every phone draws the row
    // complete rather than popping the avatar in on the next refresh.
    const author = await getMemberById(c.env.DB, identity.memberId);
    const message = {
      id,
      sessionId,
      memberId: identity.memberId,
      memberName: author?.name ?? identity.name,
      memberAvatarUpdatedAt: author?.avatarUpdatedAt ?? null,
      body,
      createdAt: timestamp,
    };

    await c.get('pubsub').emit(sessionChannel(sessionId), 'message.posted', {
      sessionId,
      id,
      memberId: message.memberId,
      memberName: message.memberName,
      memberAvatarUpdatedAt: message.memberAvatarUpdatedAt,
      body,
      at: timestamp,
    });

    return c.json({ message }, 201);
  })

  /**
   * Take one down.
   *
   * Whoever wrote it, or an organizer — see `canDeleteMessage`. Somebody will
   * post something that lands wrong, and the person whose joke it was is not
   * always the person who will remove it.
   */
  .delete('/:id/messages/:messageId', async (c) => {
    const sessionId = c.req.param('id');
    const messageId = c.req.param('messageId');
    const identity = c.get('identity');

    const existing = await c.env.DB.prepare(
      `SELECT member_id FROM session_messages WHERE id = ?1 AND session_id = ?2`,
    )
      .bind(messageId, sessionId)
      .first<{ member_id: string }>();
    if (!existing) throw notFound('No such message');

    if (!canDeleteMessage({ memberId: existing.member_id }, identity)) {
      throw forbidden('That is not yours to delete');
    }

    await c.env.DB.prepare(`DELETE FROM session_messages WHERE id = ?1`).bind(messageId).run();

    await c.get('pubsub').emit(sessionChannel(sessionId), 'message.deleted', {
      sessionId,
      id: messageId,
      byMemberId: identity.memberId,
      at: nowIso(),
    });

    return c.json({ ok: true });
  })

  /** Take the board down. Same permission rule as redrawing it. */
  .delete('/:id/teams', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');

    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');

    const existing = await loadTeamDraw(c.env.DB, sessionId);
    if (!canRedrawTeams(existing, identity)) {
      throw forbidden('These teams are settled — ask an organizer to clear them');
    }

    // Neither child table has a foreign key to `team_draws`, so both are
    // cleared explicitly rather than by cascade. Guarded like the redraw, and
    // in this order: both children read the draw row before it is removed.
    const mayForce = identity.isOrganizer ? 1 : 0;
    await c.env.DB.batch([
      c.env.DB
        .prepare(`DELETE FROM team_slots WHERE session_id = ?1 AND ${mayWriteBoard('?1', '?2')}`)
        .bind(sessionId, mayForce),
      c.env.DB
        .prepare(`DELETE FROM team_matches WHERE session_id = ?1 AND ${mayWriteBoard('?1', '?2')}`)
        .bind(sessionId, mayForce),
      c.env.DB
        .prepare(
          `DELETE FROM team_draws
            WHERE session_id = ?1 AND (?2 = 1 OR confirmed_at IS NULL)`,
        )
        .bind(sessionId, mayForce),
    ]);

    if (await loadTeamDraw(c.env.DB, sessionId)) {
      throw forbidden('These teams were settled while you were clearing — ask an organizer');
    }

    await c.get('pubsub').emit(sessionChannel(sessionId), 'teams.changed', {
      sessionId,
      draw: null,
      byMemberId: identity.memberId,
      byMemberName: identity.name,
      at: nowIso(),
    });

    return c.json({ draw: null });
  })
;

/**
 * Read the board back and tell everybody about it.
 *
 * Read back rather than assembled from what was just written: the board people
 * see is the one in the database, including whichever of two simultaneous
 * taps actually won. Every write to the board goes out as the same event
 * carrying the whole thing, so a viewer never has to work out which half of
 * their screen a change applies to.
 */
async function announceBoard(
  c: Context<AppContext>,
  sessionId: string,
  at: string,
): Promise<TeamDraw | null> {
  const draw = await loadTeamDraw(c.env.DB, sessionId);
  const identity = c.get('identity');

  await c.get('pubsub').emit(sessionChannel(sessionId), 'teams.changed', {
    sessionId,
    draw,
    byMemberId: identity.memberId,
    byMemberName: identity.name,
    at,
  });

  return draw;
}

/**
 * Uniform floats from the platform CSPRNG.
 *
 * `Math.random()` would do for picking teams, but a draw people are meant to
 * accept as fair should not be seeded by something a Worker isolate shares
 * across requests. This costs nothing and removes the question.
 */
function cryptoRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0]! / 2 ** 32;
}

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
