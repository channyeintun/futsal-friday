import { computeStreak, normalizeLocale } from '@futsal/shared';
import type {
  Attendance,
  Member,
  MemberBalance,
  MemberHistoryEntry,
  MemberProfile,
  StreakEntry,
  Payment,
  PaymentSummary,
  Registration,
  Session,
  SessionDetail,
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
  status: string;
  position: number;
  created_at: string;
}

export interface PaymentRow {
  id: string;
  session_id: string;
  member_id: string;
  member_name: string;
  amount_due: number;
  amount_override: number | null;
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
  claimedAt: row.claimed_at ?? null,
  // The nonce itself never leaves the server; the roster only needs to know
  // whether an invitation is outstanding.
  hasPendingLink: row.claim_nonce !== null,
  // Likewise the R2 key: the client gets a timestamp to cache against and
  // reads the picture through an authorized route.
  avatarUpdatedAt: row.avatar_updated_at ?? null,
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

  const registrations = await listRegistrations(db, sessionId);
  return {
    session,
    registrations,
    counts: countRegistrations(registrations),
    registrationOpen: isRegistrationOpen(session),
    me: registrations.find((r) => r.memberId === viewerMemberId) ?? null,
  };
}

export function countRegistrations(registrations: readonly Registration[]): {
  in: number;
  waitlist: number;
} {
  let inCount = 0;
  let waitlistCount = 0;
  for (const r of registrations) {
    if (r.status === 'in') inCount++;
    else waitlistCount++;
  }
  return { in: inCount, waitlist: waitlistCount };
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
              p.amount_override, p.status, p.proof_key, p.note, p.reject_reason,
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
export async function loadMemberBalances(db: D1Database): Promise<MemberBalance[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.name, m.is_organizer, m.active, m.external_id, m.created_at,
              COUNT(p.id) AS sessions_played,
              COALESCE(SUM(p.amount_due), 0) AS total_owed,
              COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.amount_due ELSE 0 END), 0)
                AS total_confirmed
         FROM members m
         LEFT JOIN payments p ON p.member_id = m.id
        WHERE m.active = 1
        GROUP BY m.id
        ORDER BY m.name COLLATE NOCASE ASC`,
    )
    .all<
      MemberRow & { sessions_played: number; total_owed: number; total_confirmed: number }
    >();

  return results.map((row) => ({
    member: toMember(row),
    sessionsPlayed: row.sessions_played,
    totalOwed: row.total_owed,
    totalConfirmed: row.total_confirmed,
    outstanding: Math.max(0, row.total_owed - row.total_confirmed),
  }));
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
      `SELECT s.id, s.starts_at, r.status AS reg_status
         FROM sessions s
         LEFT JOIN registrations r ON r.session_id = s.id AND r.member_id = ?1
        WHERE s.status != 'cancelled'
          AND s.starts_at < ?2
          AND s.starts_at >= ?3
        ORDER BY s.starts_at DESC
        LIMIT 200`,
    )
    .bind(memberId, nowIso, row.created_at)
    .all<{ id: string; starts_at: string; reg_status: string | null }>();

  const entries: StreakEntry[] = results.map((session) => ({
    sessionId: session.id,
    startsAt: session.starts_at,
    attendance: toAttendance(session.reg_status),
  }));

  const owed = await db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(amount_override, amount_due)), 0) AS due
         FROM payments
        WHERE member_id = ?1 AND status != 'confirmed'`,
    )
    .bind(memberId)
    .first<{ due: number }>();

  return {
    member: toMember(row),
    streak: computeStreak(entries),
    outstanding: Math.max(0, owed?.due ?? 0),
  };
}

/** No registration row at all reads the same as "out": they were not there. */
function toAttendance(status: string | null): Attendance {
  if (status === 'in') return 'in';
  if (status === 'waitlist') return 'waitlist';
  return 'missed';
}

/** One member's session-by-session history, newest first. */
export async function loadMemberHistory(
  db: D1Database,
  memberId: string,
  limit = 30,
): Promise<MemberHistoryEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SESSION_COLUMNS},
              r.status AS reg_status,
              p.id AS pay_id, p.amount_due, p.amount_override, p.status AS pay_status,
              p.proof_key, p.note, p.reject_reason, p.claimed_at, p.confirmed_at,
              p.updated_at AS pay_updated_at,
              m.name AS member_name
         ${SESSION_FROM}
         JOIN members m ON m.id = ?1
         LEFT JOIN registrations r ON r.session_id = s.id AND r.member_id = ?1
         LEFT JOIN payments p ON p.session_id = s.id AND p.member_id = ?1
        WHERE r.id IS NOT NULL OR p.id IS NOT NULL
        ORDER BY s.starts_at DESC
        LIMIT ?2`,
    )
    .bind(memberId, limit)
    .all<
      SessionWithVenueRow & {
        reg_status: string | null;
        pay_id: string | null;
        amount_due: number | null;
        amount_override: number | null;
        pay_status: string | null;
        proof_key: string | null;
        note: string | null;
        reject_reason: string | null;
        claimed_at: string | null;
        confirmed_at: string | null;
        pay_updated_at: string | null;
        member_name: string;
      }
    >();

  return results.map((row) => ({
    session: toSession(row),
    registrationStatus: (row.reg_status as MemberHistoryEntry['registrationStatus']) ?? null,
    payment: row.pay_id
      ? toPayment({
          id: row.pay_id,
          session_id: row.id,
          member_id: memberId,
          member_name: row.member_name,
          amount_due: row.amount_due ?? 0,
          amount_override: row.amount_override,
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
}
