import {
  computeStreak,
  didAttend,
  mvpLeaders,
  normalizeLocale,
  sortTally,
  teamOutcomes,
} from '@futsal/shared';
import type {
  Attendance,
  Member,
  MemberBalance,
  MemberHistoryEntry,
  MemberProfile,
  Mvp,
  StreakEntry,
  Payment,
  PaymentSummary,
  Registration,
  Session,
  SessionDetail,
  SessionMessage,
  TeamDraw,
  TeamMatch,
  TeamSlot,
  Venue,
} from '@futsal/shared';

/**
 * D1 access: row shapes, mappers, and the composite reads that more than one
 * route needs. Single-table CRUD stays inline in the routes.
 *
 * Every row type mirrors its table exactly (snake_case, 0/1 booleans, ISO
 * strings) and is converted at the boundary, so nothing downstream has to know
 * how SQLite spells things.
 */

/* ------------------------------------------------------------------- rows */

export interface MemberRow {
  id: string;
  name: string;
  is_organizer: number;
  active: number;
  /** Reserved hook for an external identity provider. Unused today. */
  external_id: string | null;
  created_at: string;
  notify_session: number;
  notify_payment: number;
  language: string;
  claimed_at: string | null;
  claim_nonce: string | null;
  claim_expires_at: string | null;
  token_version: number;
  avatar_key: string | null;
  avatar_updated_at: string | null;
  approved_at: string | null;
  hour12: number;
}

export interface VenueRow {
  id: string;
  name: string;
  address: string | null;
  map_url: string | null;
  price_note: string | null;
  active: number;
  created_at: string;
}

export interface SessionRow {
  id: string;
  starts_at: string;
  venue_id: string | null;
  status: string;
  fee_per_person: number | null;
  total_charge: number | null;
  max_players: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** A session left-joined onto its venue; venue columns are `v_`-prefixed. */
export interface SessionWithVenueRow extends SessionRow {
  v_id: string | null;
  v_name: string | null;
  v_address: string | null;
  v_map_url: string | null;
  v_price_note: string | null;
  v_active: number | null;
  v_created_at: string | null;
}

export interface RegistrationRow {
  id: string;
  session_id: string;
  member_id: string;
  member_name: string;
  member_avatar_updated_at: string | null;
  guests: number;
  attended: number | null;
  guests_arrived: number | null;
  goals: number;
  status: string;
  position: number;
  created_at: string;
}

/**
 * A team slot joined to its draw. The draw's own columns repeat on every row,
 * which is what lets one query answer "are there teams, and who is on them" —
 * see {@link loadTeamDraw}.
 */
export interface TeamSlotRow {
  team_count: number;
  drawn_at: string;
  drawn_by: string | null;
  drawn_by_name: string | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  confirmed_by_name: string | null;
  team: number | null;
  guest_index: number | null;
  member_id: string | null;
  member_name: string | null;
  member_avatar_updated_at: string | null;
}

export interface TeamMatchRow {
  id: string;
  ordinal: number;
  first_team: number;
  second_team: number;
  first_goals: number | null;
  second_goals: number | null;
  recorded_at: string | null;
  recorded_by: string | null;
  recorded_by_name: string | null;
}

export interface PaymentRow {
  id: string;
  session_id: string;
  member_id: string;
  member_name: string;
  amount_due: number;
  amount_override: number | null;
  guests: number;
  status: string;
  proof_key: string | null;
  note: string | null;
  reject_reason: string | null;
  claimed_at: string | null;
  confirmed_at: string | null;
  updated_at: string;
}

/* ---------------------------------------------------------------- mappers */

export const toMember = (row: MemberRow): Member => ({
  id: row.id,
  name: row.name,
  isOrganizer: row.is_organizer === 1,
  active: row.active === 1,
  createdAt: row.created_at,
  // `?? 1` keeps rows written before migration 0002 behaving as opted-in.
  notifySession: (row.notify_session ?? 1) === 1,
  notifyPayment: (row.notify_payment ?? 1) === 1,
  language: normalizeLocale(row.language),
  hour12: (row.hour12 ?? 0) === 1,
  claimedAt: row.claimed_at ?? null,
  // The nonce itself never leaves the server; the roster only needs to know
  // whether an invitation is outstanding.
  hasPendingLink: row.claim_nonce !== null,
  // Likewise the R2 key: the client gets a timestamp to cache against and
  // reads the picture through an authorized route.
  avatarUpdatedAt: row.avatar_updated_at ?? null,
  approvedAt: row.approved_at ?? null,
});

export const toVenue = (row: VenueRow): Venue => ({
  id: row.id,
  name: row.name,
  address: row.address,
  mapUrl: row.map_url,
  priceNote: row.price_note,
  active: row.active === 1,
  createdAt: row.created_at,
});

export const toSession = (row: SessionWithVenueRow): Session => ({
  id: row.id,
  startsAt: row.starts_at,
  venueId: row.venue_id,
  venue:
    row.v_id && row.v_name
      ? {
          id: row.v_id,
          name: row.v_name,
          address: row.v_address,
          mapUrl: row.v_map_url,
          priceNote: row.v_price_note,
          active: row.v_active === 1,
          createdAt: row.v_created_at ?? row.created_at,
        }
      : null,
  status: row.status as Session['status'],
  feePerPerson: row.fee_per_person,
  totalCharge: row.total_charge,
  maxPlayers: row.max_players,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toRegistration = (row: RegistrationRow): Registration => ({
  id: row.id,
  sessionId: row.session_id,
  memberId: row.member_id,
  memberName: row.member_name,
  memberAvatarUpdatedAt: row.member_avatar_updated_at ?? null,
  guests: row.guests ?? 0,
  // SQLite has no boolean, and the three states are load-bearing: null is
  // "unmarked", which is not the same as "marked absent".
  attended: row.attended == null ? null : row.attended === 1,
  guestsArrived: row.guests_arrived ?? null,
  goals: row.goals ?? 0,
  status: row.status as Registration['status'],
  position: row.position,
  createdAt: row.created_at,
});

export const toPayment = (row: PaymentRow): Payment => ({
  id: row.id,
  sessionId: row.session_id,
  memberId: row.member_id,
  memberName: row.member_name,
  amountDue: row.amount_due,
  amountOverride: row.amount_override,
  guests: row.guests ?? 0,
  status: row.status as Payment['status'],
  hasProof: row.proof_key !== null,
  note: row.note,
  rejectReason: row.reject_reason,
  claimedAt: row.claimed_at,
  confirmedAt: row.confirmed_at,
  updatedAt: row.updated_at,
});

/* ------------------------------------------------------------- SQL pieces */

/** Column list for a session joined to its venue. Keep in sync with the row type. */
export const SESSION_COLUMNS = `
  s.id, s.starts_at, s.venue_id, s.status, s.fee_per_person, s.total_charge,
  s.max_players, s.notes, s.created_at, s.updated_at,
  v.id AS v_id, v.name AS v_name, v.address AS v_address, v.map_url AS v_map_url,
  v.price_note AS v_price_note, v.active AS v_active, v.created_at AS v_created_at
`;

export const SESSION_FROM = `FROM sessions s LEFT JOIN venues v ON v.id = s.venue_id`;

/* ------------------------------------------------------------ basic reads */

export async function getSessionRow(
  db: D1Database,
  sessionId: string,
): Promise<Session | null> {
  const row = await db
    .prepare(`SELECT ${SESSION_COLUMNS} ${SESSION_FROM} WHERE s.id = ?1`)
    .bind(sessionId)
    .first<SessionWithVenueRow>();
  return row ? toSession(row) : null;
}

export async function getMemberById(db: D1Database, id: string): Promise<Member | null> {
  const row = await db
    .prepare(`SELECT * FROM members WHERE id = ?1 AND active = 1`)
    .bind(id)
    .first<MemberRow>();
  return row ? toMember(row) : null;
}

export async function listRegistrations(
  db: D1Database,
  sessionId: string,
): Promise<Registration[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.session_id, r.member_id, m.name AS member_name,
              m.avatar_updated_at AS member_avatar_updated_at,
              r.guests, r.attended, r.guests_arrived, r.goals,
              r.status, r.position, r.created_at
         FROM registrations r
         JOIN members m ON m.id = r.member_id
        WHERE r.session_id = ?1
        ORDER BY r.position ASC`,
    )
    .bind(sessionId)
    .all<RegistrationRow>();
  return results.map(toRegistration);
}

/**
 * The teams as they currently stand, or null if nobody has split them.
 *
 * One query rather than two. The draw's metadata repeats on every slot row,
 * which is a few bytes duplicated a dozen times in exchange for one less round
 * trip on the screen people open while standing on a pitch. The LEFT JOIN also
 * makes "a draw exists but everybody in it has since left" representable,
 * rather than indistinguishable from no draw at all.
 */
export async function loadTeamDraw(
  db: D1Database,
  sessionId: string,
): Promise<TeamDraw | null> {
  // Slots and fixtures are independent, so they go together rather than one
  // after the other. Both are a dozen rows at most.
  const [slots, fixtures] = await Promise.all([
    db
      .prepare(
        `SELECT d.team_count, d.drawn_at, d.drawn_by, b.name AS drawn_by_name,
                d.confirmed_at, d.confirmed_by, c.name AS confirmed_by_name,
                s.team, s.guest_index, s.member_id, m.name AS member_name,
                m.avatar_updated_at AS member_avatar_updated_at
           FROM team_draws d
           LEFT JOIN members b ON b.id = d.drawn_by
           LEFT JOIN members c ON c.id = d.confirmed_by
           LEFT JOIN team_slots s ON s.session_id = d.session_id
           LEFT JOIN members m ON m.id = s.member_id
          WHERE d.session_id = ?1
          ORDER BY s.team ASC, m.name COLLATE NOCASE ASC, s.guest_index ASC`,
      )
      .bind(sessionId)
      .all<TeamSlotRow>(),
    db
      .prepare(
        `SELECT x.id, x.ordinal, x.first_team, x.second_team,
                x.first_goals, x.second_goals, x.recorded_at, x.recorded_by,
                r.name AS recorded_by_name
           FROM team_matches x
           LEFT JOIN members r ON r.id = x.recorded_by
          WHERE x.session_id = ?1
          ORDER BY x.ordinal ASC`,
      )
      .bind(sessionId)
      .all<TeamMatchRow>(),
  ]);

  const results = slots.results;
  const first = results[0];
  if (!first) return null;

  const teams: TeamSlot[][] = Array.from({ length: first.team_count }, () => []);
  for (const row of results) {
    // The slot half of the join is null when the draw has no slots left.
    if (row.team == null || row.member_id == null || row.member_name == null) continue;
    // A team index outside the stored count would have to come from a shrunk
    // `team_count`, which nothing writes — but dropping the row is better than
    // indexing off the end of the board.
    teams[row.team]?.push({
      memberId: row.member_id,
      memberName: row.member_name,
      memberAvatarUpdatedAt: row.member_avatar_updated_at ?? null,
      guestIndex: row.guest_index ?? 0,
    });
  }

  return {
    teamCount: first.team_count,
    teams,
    drawnBy:
      first.drawn_by && first.drawn_by_name
        ? { memberId: first.drawn_by, memberName: first.drawn_by_name }
        : null,
    drawnAt: first.drawn_at,
    confirmedAt: first.confirmed_at ?? null,
    confirmedBy:
      first.confirmed_by && first.confirmed_by_name
        ? { memberId: first.confirmed_by, memberName: first.confirmed_by_name }
        : null,
    matches: fixtures.results.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      firstTeam: row.first_team,
      secondTeam: row.second_team,
      // A half-recorded score cannot be written, but reading it back as
      // unplayed is safer than reporting a one-sided scoreline.
      firstGoals: row.first_goals ?? null,
      secondGoals: row.second_goals ?? null,
      recordedBy:
        row.recorded_by && row.recorded_by_name
          ? { memberId: row.recorded_by, memberName: row.recorded_by_name }
          : null,
      recordedAt: row.recorded_at ?? null,
    })),
  };
}

export interface SessionMessageRow {
  id: string;
  session_id: string;
  member_id: string;
  member_name: string;
  member_avatar_updated_at: string | null;
  body: string;
  created_at: string;
}

/**
 * A session's thread, oldest first.
 *
 * Capped rather than paged. A thread is one week of banter about one game, so
 * the realistic ceiling is a few dozen; a cursor here would be machinery for a
 * case that does not arrive, and a chat that starts halfway through is worse
 * than one that starts at the beginning. The cap exists only so a runaway
 * cannot put a megabyte on somebody's phone.
 */
export async function listSessionMessages(
  db: D1Database,
  sessionId: string,
  limit = 200,
): Promise<SessionMessage[]> {
  const { results } = await db
    .prepare(
      `SELECT x.id, x.session_id, x.member_id, m.name AS member_name,
              m.avatar_updated_at AS member_avatar_updated_at,
              x.body, x.created_at
         FROM session_messages x
         JOIN members m ON m.id = x.member_id
        WHERE x.session_id = ?1
        ORDER BY x.created_at DESC, x.id DESC
        LIMIT ?2`,
    )
    .bind(sessionId, limit)
    .all<SessionMessageRow>();

  // Newest-first in SQL so the cap keeps the *latest* messages, then flipped
  // for display: a conversation reads downwards.
  return results.reverse().map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    memberId: row.member_id,
    memberName: row.member_name,
    memberAvatarUpdatedAt: row.member_avatar_updated_at ?? null,
    body: row.body,
    createdAt: row.created_at,
  }));
}

/**
 * The MVP vote on one session, as one caller is allowed to see it.
 *
 * Two withholdings, both deliberate and both done here rather than on the
 * screen:
 *
 *  * **No voter identity leaves this function.** `voter_id` is read only to
 *    find the caller's own choice and to count how many have voted.
 *  * **No tally until the caller has voted.** Hiding it in the UI would leave
 *    it one devtools tab away, and the whole point is that an early lead
 *    cannot pull the rest of the votes after it.
 */
export async function loadMvp(
  db: D1Database,
  sessionId: string,
  viewerMemberId: string,
): Promise<Mvp> {
  const registrations = await listRegistrations(db, sessionId);
  // Whoever played, members only. A guest has no account to award, and no
  // profile for it to accumulate on.
  const candidates = registrations
    .filter((registration) => didAttend(registration))
    .map((registration) => ({
      memberId: registration.memberId,
      memberName: registration.memberName,
      memberAvatarUpdatedAt: registration.memberAvatarUpdatedAt,
    }));

  const { results: votes } = await db
    .prepare(`SELECT voter_id, nominee_id FROM mvp_votes WHERE session_id = ?1`)
    .bind(sessionId)
    .all<{ voter_id: string; nominee_id: string }>();

  const counts = new Map<string, number>();
  let myVote: string | null = null;
  for (const vote of votes) {
    counts.set(vote.nominee_id, (counts.get(vote.nominee_id) ?? 0) + 1);
    if (vote.voter_id === viewerMemberId) myVote = vote.nominee_id;
  }

  // Everyone who has a vote counted, even somebody since marked absent — their
  // votes were cast and are not the app's to quietly discard.
  const named = new Map(candidates.map((candidate) => [candidate.memberId, candidate]));
  for (const [nomineeId] of counts) {
    if (named.has(nomineeId)) continue;
    const known = registrations.find((registration) => registration.memberId === nomineeId);
    named.set(nomineeId, {
      memberId: nomineeId,
      memberName: known?.memberName ?? '',
      memberAvatarUpdatedAt: known?.memberAvatarUpdatedAt ?? null,
    });
  }

  const tally = sortTally(
    [...named.values()].map((entry) => ({ ...entry, votes: counts.get(entry.memberId) ?? 0 })),
  );

  return {
    candidates,
    myVote,
    // Withheld, not hidden — and `leaders` goes with it. Sending who is
    // winning to somebody who has not voted would hand back exactly what
    // withholding the tally was for.
    tally: myVote === null ? null : tally,
    leaders: myVote === null ? [] : mvpLeaders(tally),
    // Safe either way: how many have voted says nothing about who for.
    votesCast: votes.length,
    voterCount: candidates.length,
  };
}

/**
 * Sessions this member was voted the best in.
 *
 * Wins, not votes received. Twenty votes spread over five games somebody else
 * won is not five MVPs, and a career count that says otherwise is the kind of
 * number people notice is wrong.
 *
 * A shared win counts for everyone tied, which is the same answer the session
 * screen gives — see `mvpLeaders`. Inventing a tiebreak here so the totals
 * look tidier would make the profile disagree with the trophy.
 */
const MVP_WINS = `
  WITH tallies AS (
    SELECT session_id, nominee_id, COUNT(*) AS votes
      FROM mvp_votes GROUP BY session_id, nominee_id
  ),
  tops AS (
    SELECT session_id, MAX(votes) AS best FROM tallies GROUP BY session_id
  )
  SELECT t.nominee_id AS member_id, COUNT(*) AS wins
    FROM tallies t
    JOIN tops ON tops.session_id = t.session_id
   WHERE t.votes = tops.best AND tops.best > 0
`;

export async function countMvpWins(db: D1Database, memberId: string): Promise<number> {
  const row = await db
    .prepare(`${MVP_WINS} AND t.nominee_id = ?1 GROUP BY t.nominee_id`)
    .bind(memberId)
    .first<{ wins: number }>();
  return row?.wins ?? 0;
}

/** The same count for everybody at once, for the leaderboard. */
export async function mvpWinsByMember(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(`${MVP_WINS} GROUP BY t.nominee_id`)
    .all<{ member_id: string; wins: number }>();
  return new Map(results.map((row) => [row.member_id, row.wins]));
}

/* -------------------------------------------------------- composite reads */

/**
 * Registration is open while the session is still scheduled and kickoff has not
 * passed. This is the single definition of that rule — the UI mirrors it for
 * button state, but the server decides.
 */
export function isRegistrationOpen(session: Session, now: Date = new Date()): boolean {
  return session.status === 'scheduled' && new Date(session.startsAt).getTime() > now.getTime();
}

export async function loadSessionDetail(
  db: D1Database,
  sessionId: string,
  viewerMemberId: string,
): Promise<SessionDetail | null> {
  const session = await getSessionRow(db, sessionId);
  if (!session) return null;

  // Independent reads, so they cost one round trip between them rather than
  // two. The team board is on the same screen as the roster and is wanted at
  // the same moment.
  const [registrations, teams] = await Promise.all([
    listRegistrations(db, sessionId),
    loadTeamDraw(db, sessionId),
  ]);

  return {
    session,
    registrations,
    counts: countRegistrations(registrations),
    registrationOpen: isRegistrationOpen(session),
    me: registrations.find((r) => r.memberId === viewerMemberId) ?? null,
    teams,
  };
}

/**
 * Heads, not rows.
 *
 * A member who brought two friends is three bodies on a pitch that was hired
 * for twelve, so every number the cap is compared against counts guests. The
 * list of names is shorter than `in` whenever anyone brought somebody, which
 * is why `guests` is returned too — a screen showing "7 playing" over five
 * rows needs to be able to say why.
 */
export function countRegistrations(registrations: readonly Registration[]): {
  in: number;
  waitlist: number;
  guests: number;
} {
  let inCount = 0;
  let waitlistCount = 0;
  let guestCount = 0;
  for (const r of registrations) {
    const heads = 1 + (r.guests ?? 0);
    if (r.status === 'in') {
      inCount += heads;
      guestCount += r.guests ?? 0;
    } else {
      waitlistCount += heads;
    }
  }
  return { in: inCount, waitlist: waitlistCount, guests: guestCount };
}

/** Counts straight from SQL, for the paths that do not need the full list. */
export async function countRegistrationsBySession(
  db: D1Database,
  sessionId: string,
): Promise<{ in: number; waitlist: number }> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'in' THEN 1 ELSE 0 END) AS in_count,
         SUM(CASE WHEN status = 'waitlist' THEN 1 ELSE 0 END) AS wait_count
       FROM registrations WHERE session_id = ?1`,
    )
    .bind(sessionId)
    .first<{ in_count: number | null; wait_count: number | null }>();
  return { in: row?.in_count ?? 0, waitlist: row?.wait_count ?? 0 };
}

export async function listPayments(db: D1Database, sessionId: string): Promise<Payment[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.session_id, p.member_id, m.name AS member_name, p.amount_due,
              p.amount_override, p.guests, p.status, p.proof_key, p.note, p.reject_reason,
              p.claimed_at, p.confirmed_at, p.updated_at
         FROM payments p
         JOIN members m ON m.id = p.member_id
        WHERE p.session_id = ?1
        ORDER BY m.name COLLATE NOCASE ASC`,
    )
    .bind(sessionId)
    .all<PaymentRow>();
  return results.map(toPayment);
}

export async function loadPaymentSummary(
  db: D1Database,
  session: Session,
): Promise<PaymentSummary> {
  const payments = await listPayments(db, session.id);

  let collected = 0;
  let pending = 0;
  let outstanding = 0;
  for (const p of payments) {
    if (p.status === 'confirmed') collected += p.amountDue;
    else if (p.status === 'pending') {
      pending += p.amountDue;
      outstanding += p.amountDue;
    } else outstanding += p.amountDue;
  }

  return {
    sessionId: session.id,
    totalCharge: session.totalCharge,
    collected,
    pending,
    outstanding,
    payments,
  };
}

/**
 * Outstanding balance per member across every settled session — the "who still
 * owes me money" view, answered in one query rather than N.
 */
/**
 * Who owes what, biggest debt first, a page at a time.
 *
 * The order moved from the client to here when this list grew past one screen.
 * Sorting "debtors first" in the browser only sorts what the browser happens
 * to have fetched, so with paging the top of page two could easily outrank the
 * bottom of page one — the list would no longer be in any order at all.
 *
 * Keyset on `(outstanding DESC, id ASC)`, spelled out rather than as a row
 * value because the two directions differ and `(a, b) < (?, ?)` cannot express
 * that. `HAVING`, not `WHERE`, because `outstanding` is an aggregate and does
 * not exist yet when `WHERE` runs.
 */
export async function loadMemberBalances(
  db: D1Database,
  opts: { limit?: number; cursor?: { outstanding: number; id: string } | null } = {},
): Promise<{ balances: MemberBalance[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const cursor = opts.cursor ?? null;

  const columns = `m.id, m.name, m.is_organizer, m.active, m.external_id, m.created_at,
              m.notify_session, m.notify_payment, m.language, m.claimed_at, m.claim_nonce,
              m.claim_expires_at, m.token_version, m.avatar_key, m.avatar_updated_at,
              m.approved_at, m.hour12,
              COUNT(p.id) AS sessions_played,
              COALESCE(SUM(p.amount_due), 0) AS total_owed,
              COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.amount_due ELSE 0 END), 0)
                AS total_confirmed,
              MAX(0, COALESCE(SUM(p.amount_due), 0)
                     - COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.amount_due ELSE 0 END), 0))
                AS outstanding`;

  const statement = cursor
    ? db.prepare(
        `SELECT ${columns}
           FROM members m
           LEFT JOIN payments p ON p.member_id = m.id
          WHERE m.active = 1
          GROUP BY m.id
         HAVING outstanding < ?1 OR (outstanding = ?1 AND m.id > ?2)
          ORDER BY outstanding DESC, m.id ASC
          LIMIT ?3`,
      ).bind(cursor.outstanding, cursor.id, limit + 1)
    : db.prepare(
        `SELECT ${columns}
           FROM members m
           LEFT JOIN payments p ON p.member_id = m.id
          WHERE m.active = 1
          GROUP BY m.id
          ORDER BY outstanding DESC, m.id ASC
          LIMIT ?1`,
      ).bind(limit + 1);

  const { results } = await statement.all<
    MemberRow & {
      sessions_played: number;
      total_owed: number;
      total_confirmed: number;
      outstanding: number;
    }
  >();

  const page = results.slice(0, limit);
  const last = page.at(-1);
  return {
    balances: page.map((row) => ({
      member: toMember(row),
      sessionsPlayed: row.sessions_played,
      totalOwed: row.total_owed,
      totalConfirmed: row.total_confirmed,
      outstanding: Math.max(0, row.total_owed - row.total_confirmed),
    })),
    nextCursor:
      results.length > limit && last
        ? encodeBalanceCursor(last.outstanding, last.id)
        : null,
  };
}

/** Opaque `(outstanding, id)` position in the debt list. */
/**
 * Opaque `(starts_at, id)` position in a list of sessions, newest first.
 *
 * The id is in the tuple because two sessions can share a kickoff time — a
 * midweek game added twice, a fixture moved onto another — and a keyset on the
 * timestamp alone would make one of them unreachable. Both the group's fixture
 * history and a member's own page on this.
 */
export function encodeSessionCursor(startsAt: string, id: string): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify({ s: startsAt, i: id }))));
}

export function decodeSessionCursor(
  raw: string | undefined,
): { startsAt: string; id: string } | null {
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

export function encodeBalanceCursor(outstanding: number, id: string): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify({ o: outstanding, i: id }))));
}

export function decodeBalanceCursor(
  raw: string | undefined,
): { outstanding: number; id: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(escape(atob(raw))));
    if (typeof parsed?.o === 'number' && typeof parsed?.i === 'string') {
      return { outstanding: parsed.o, id: parsed.i };
    }
  } catch {
    // An unreadable cursor is the first page, not an error.
  }
  return null;
}

/**
 * Everything a profile screen shows: who they are, their attendance run, and
 * what they still owe.
 *
 * The streak deliberately does *not* reuse `loadMemberHistory`. That query
 * keeps only sessions where the member has a registration or payment row,
 * which silently drops the games they ignored entirely — exactly the gaps that
 * are supposed to end a run. Reading it from there would hand every no-show a
 * perfect record.
 */
export async function loadMemberProfile(
  db: D1Database,
  memberId: string,
  now = new Date(),
): Promise<MemberProfile | null> {
  const row = await db
    .prepare(`SELECT * FROM members WHERE id = ?1`)
    .bind(memberId)
    .first<MemberRow>();
  if (!row) return null;

  const nowIso = now.toISOString();
  const { results } = await db
    .prepare(
      // Every game that has already kicked off since they joined. Cancelled
      // ones are excluded rather than treated as misses: nobody played, so
      // nobody's run should end. `starts_at` rather than `status` decides
      // whether it has happened, so a late cron cannot resurrect a streak.
      `SELECT s.id, s.starts_at, r.status AS reg_status, r.attended AS reg_attended
         FROM sessions s
         LEFT JOIN registrations r ON r.session_id = s.id AND r.member_id = ?1
        WHERE s.status != 'cancelled'
          AND s.starts_at < ?2
          AND s.starts_at >= ?3
        ORDER BY s.starts_at DESC
        LIMIT 200`,
    )
    .bind(memberId, nowIso, row.created_at)
    .all<{
      id: string;
      starts_at: string;
      reg_status: string | null;
      reg_attended: number | null;
    }>();

  const entries: StreakEntry[] = results.map((session) => ({
    sessionId: session.id,
    startsAt: session.starts_at,
    attendance: toAttendance(session.reg_status, session.reg_attended),
  }));

  const owed = await db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(amount_override, amount_due)), 0) AS due
         FROM payments
        WHERE member_id = ?1 AND status != 'confirmed'`,
    )
    .bind(memberId)
    .first<{ due: number }>();

  const scored = await db
    .prepare(`SELECT COALESCE(SUM(goals), 0) AS n FROM registrations WHERE member_id = ?1`)
    .bind(memberId)
    .first<{ n: number }>();

  return {
    member: toMember(row),
    streak: computeStreak(entries),
    goals: scored?.n ?? 0,
    mvps: await countMvpWins(db, memberId),
    outstanding: Math.max(0, owed?.due ?? 0),
  };
}

/** No registration row at all reads the same as "out": they were not there. */
/**
 * What one past session says about somebody's run.
 *
 * A streak is supposed to mean "turned up N weeks running", and until
 * attendance existed it meant "said yes N weeks running" — so a no-show kept a
 * streak for a game they never came to, which is the opposite of the point.
 *
 * `attended` is the decider where it has been set; where it has not, the old
 * presumption stands and a registration still reads as playing. So histories
 * from before this existed are unchanged, and only games somebody actually
 * marked can break a run.
 */
function toAttendance(status: string | null, attended: number | null): Attendance {
  if (status === null) return 'missed';
  if (attended != null) return attended === 1 ? 'in' : 'missed';
  if (status === 'in') return 'in';
  if (status === 'waitlist') return 'waitlist';
  return 'missed';
}

/** One member's session-by-session history, newest first. */
export async function loadMemberHistory(
  db: D1Database,
  memberId: string,
  opts: { limit?: number; cursor?: { startsAt: string; id: string } | null } = {},
): Promise<{ history: MemberHistoryEntry[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const cursor = opts.cursor ?? null;

  // Keyset on `(starts_at DESC, id ASC)`, the same tuple the group's fixture
  // list pages on — see `encodeSessionCursor`. One row past the page is
  // fetched to answer "is there more" without a second count query.
  const keyset = cursor
    ? `AND (s.starts_at < ?3 OR (s.starts_at = ?3 AND s.id > ?4))`
    : '';

  const statement = db
    .prepare(
      `SELECT ${SESSION_COLUMNS},
              r.status AS reg_status,
              p.id AS pay_id, p.amount_due, p.amount_override, p.guests,
              p.status AS pay_status,
              p.proof_key, p.note, p.reject_reason, p.claimed_at, p.confirmed_at,
              p.updated_at AS pay_updated_at,
              m.name AS member_name,
              ts.team AS team
         ${SESSION_FROM}
         JOIN members m ON m.id = ?1
         LEFT JOIN registrations r ON r.session_id = s.id AND r.member_id = ?1
         LEFT JOIN payments p ON p.session_id = s.id AND p.member_id = ?1
         -- Their own slot, not their guests': guest_index 0 is the member.
         LEFT JOIN team_slots ts
                ON ts.session_id = s.id AND ts.member_id = ?1 AND ts.guest_index = 0
        WHERE (r.id IS NOT NULL OR p.id IS NOT NULL)
          ${keyset}
        ORDER BY s.starts_at DESC, s.id ASC
        LIMIT ?2`,
    );

  const { results: page } = await (cursor
    ? statement.bind(memberId, limit + 1, cursor.startsAt, cursor.id)
    : statement.bind(memberId, limit + 1)
  ).all<
      SessionWithVenueRow & {
        reg_status: string | null;
        pay_id: string | null;
        amount_due: number | null;
        amount_override: number | null;
        guests: number | null;
        pay_status: string | null;
        proof_key: string | null;
        note: string | null;
        reject_reason: string | null;
        claimed_at: string | null;
        confirmed_at: string | null;
        pay_updated_at: string | null;
        member_name: string;
        team: number | null;
      }
    >();

  // The extra row was only ever the answer to "is there more".
  const results = page.slice(0, limit);
  const last = results.at(-1);
  const nextCursor =
    page.length > limit && last ? encodeSessionCursor(last.starts_at, last.id) : null;

  // The fixtures for every session on the page, in one go.
  //
  // A second query rather than a join: a session has several games and this one
  // has a row per session, so joining them would multiply the page out and then
  // need collapsing again. A page at most — see the `limit` — which is
  // comfortably inside D1's bound-parameter ceiling.
  const played = results.filter((row) => row.team !== null).map((row) => row.id);
  const fixtures = new Map<string, TeamMatch[]>();

  if (played.length > 0) {
    const { results: matchRows } = await db
      .prepare(
        `SELECT session_id, id, ordinal, first_team, second_team, first_goals, second_goals
           FROM team_matches
          WHERE session_id IN (${played.map((_, i) => `?${i + 1}`).join(', ')})
          ORDER BY session_id, ordinal ASC`,
      )
      .bind(...played)
      .all<TeamMatchRow & { session_id: string }>();

    for (const row of matchRows) {
      const list = fixtures.get(row.session_id) ?? [];
      list.push({
        id: row.id,
        ordinal: row.ordinal,
        firstTeam: row.first_team,
        secondTeam: row.second_team,
        firstGoals: row.first_goals ?? null,
        secondGoals: row.second_goals ?? null,
        recordedBy: null,
        recordedAt: null,
      });
      fixtures.set(row.session_id, list);
    }
  }

  const history = results.map((row) => ({
    session: toSession(row),
    registrationStatus: (row.reg_status as MemberHistoryEntry['registrationStatus']) ?? null,
    teams:
      row.team === null
        ? null
        : {
            team: row.team,
            // Resolved with the shared helper, so a row in the history list and
            // the board on the session screen can never disagree about who won.
            outcomes: teamOutcomes(row.team, fixtures.get(row.id) ?? []),
          },
    payment: row.pay_id
      ? toPayment({
          id: row.pay_id,
          session_id: row.id,
          member_id: memberId,
          member_name: row.member_name,
          amount_due: row.amount_due ?? 0,
          amount_override: row.amount_override,
          guests: row.guests ?? 0,
          status: row.pay_status ?? 'unpaid',
          proof_key: row.proof_key,
          note: row.note,
          reject_reason: row.reject_reason,
          claimed_at: row.claimed_at,
          confirmed_at: row.confirmed_at,
          updated_at: row.pay_updated_at ?? row.updated_at,
        })
      : null,
  }));

  return { history, nextCursor };
}

/* ------------------------------------------------------------ form + ranks */

/** How many past games the little squares beside a name show. */
export const FORM_WINDOW = 8;

/**
 * Recent form for everybody at once.
 *
 * One bounded query, not one per player: the home screen draws a row of
 * squares beside every name, and asking per member would be a dozen round
 * trips on the screen people open most. The window is the last handful of
 * games, so the whole thing is at most `FORM_WINDOW x roster` rows however
 * long the group has existed.
 *
 * A game from before somebody joined is `none` rather than `missed` — an empty
 * square, not a black mark for a match that happened without them.
 */
export async function loadRecentForm(
  db: D1Database,
  window = FORM_WINDOW,
): Promise<Map<string, Attendance[]>> {
  const { results: sessions } = await db
    .prepare(
      `SELECT id, starts_at FROM sessions
        WHERE status != 'cancelled' AND starts_at < ?1
        ORDER BY starts_at DESC LIMIT ?2`,
    )
    .bind(new Date().toISOString(), window)
    .all<{ id: string; starts_at: string }>();

  // Oldest first, so the row reads left to right like a calendar.
  const ordered = sessions.reverse();
  const byMember = new Map<string, Attendance[]>();
  if (ordered.length === 0) return byMember;

  // Joined against the same window rather than an `IN (?, ?, ...)` list of ids:
  // D1 refuses more than 100 bound parameters, so a list would cap how far
  // back any of this could ever look. Two parameters, whatever the window.
  const { results: rows } = await db
    .prepare(
      `SELECT r.session_id, r.member_id, r.status, r.attended
         FROM registrations r
         JOIN (SELECT id FROM sessions
                WHERE status != 'cancelled' AND starts_at < ?1
                ORDER BY starts_at DESC LIMIT ?2) s ON s.id = r.session_id`,
    )
    .bind(new Date().toISOString(), window)
    .all<{ session_id: string; member_id: string; status: string; attended: number | null }>();

  const { results: members } = await db
    .prepare(`SELECT id, created_at FROM members WHERE active = 1 AND approved_at IS NOT NULL`)
    .all<{ id: string; created_at: string }>();

  const lookup = new Map<string, { status: string; attended: number | null }>();
  for (const row of rows) lookup.set(`${row.session_id}|${row.member_id}`, row);

  for (const member of members) {
    byMember.set(
      member.id,
      ordered.map((session) => {
        // Not yet a member: nothing to say about that game either way.
        if (session.starts_at < member.created_at) return 'none' as Attendance;
        const row = lookup.get(`${session.id}|${member.id}`);
        return toAttendance(row?.status ?? null, row?.attended ?? null);
      }),
    );
  }
  return byMember;
}

/**
 * The whole ranking, computed.
 *
 * A streak cannot be a `SUM` — it is "how many in a row, counting back from
 * the newest", which needs the sequence. So this reads a bounded slice of
 * history once and runs the same `computeStreak` the profile uses, rather than
 * inventing a second definition in SQL that would drift from the first.
 *
 * Bounded by `HISTORY_LIMIT` games rather than all of them: a streak longer
 * than two years of Fridays is not the number anybody is arguing about, and
 * the alternative is a query that grows for ever.
 */
const HISTORY_LIMIT = 120;

export async function loadLeaderboard(
  db: D1Database,
): Promise<
  { member: Member; streak: ReturnType<typeof computeStreak>; goals: number; mvps: number }[]
> {
  const { results: sessions } = await db
    .prepare(
      `SELECT id, starts_at FROM sessions
        WHERE status != 'cancelled' AND starts_at < ?1
        ORDER BY starts_at DESC LIMIT ?2`,
    )
    .bind(new Date().toISOString(), HISTORY_LIMIT)
    .all<{ id: string; starts_at: string }>();

  const { results: members } = await db
    .prepare(
      `SELECT * FROM members WHERE active = 1 AND approved_at IS NOT NULL
        ORDER BY name COLLATE NOCASE ASC`,
    )
    .all<MemberRow>();

  // Same join rather than a parameter list — see `loadRecentForm`. With 120
  // sessions in the window an `IN` list would be 120 bound parameters, and D1
  // stops at 100.
  const { results: regs } = await db
    .prepare(
      `SELECT r.session_id, r.member_id, r.status, r.attended
         FROM registrations r
         JOIN (SELECT id FROM sessions
                WHERE status != 'cancelled' AND starts_at < ?1
                ORDER BY starts_at DESC LIMIT ?2) s ON s.id = r.session_id`,
    )
    .bind(new Date().toISOString(), HISTORY_LIMIT)
    .all<{ session_id: string; member_id: string; status: string; attended: number | null }>();

  const { results: scored } = await db
    .prepare(
      `SELECT member_id, COALESCE(SUM(goals), 0) AS n FROM registrations GROUP BY member_id`,
    )
    .all<{ member_id: string; n: number }>();
  const goalsBy = new Map(scored.map((row) => [row.member_id, row.n]));
  const mvpsBy = await mvpWinsByMember(db);

  const lookup = new Map<string, { status: string; attended: number | null }>();
  for (const row of regs) lookup.set(`${row.session_id}|${row.member_id}`, row);

  return members.map((row) => {
    const entries: StreakEntry[] = sessions
      .filter((session) => session.starts_at >= row.created_at)
      .map((session) => {
        const reg = lookup.get(`${session.id}|${row.id}`);
        return {
          sessionId: session.id,
          startsAt: session.starts_at,
          attendance: toAttendance(reg?.status ?? null, reg?.attended ?? null),
        };
      });
    return {
      member: toMember(row),
      streak: computeStreak(entries),
      goals: goalsBy.get(row.id) ?? 0,
      mvps: mvpsBy.get(row.id) ?? 0,
    };
  });
}
