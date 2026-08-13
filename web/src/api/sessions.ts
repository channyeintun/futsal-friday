import type {
  CreateSessionInput,
  Registration,
  Session,
  SessionDetail,
  TeamDraw,
  UpdateSessionInput,
} from '@futsal/shared';
import { del, get, patch, post } from './client.js';

export interface SessionsOverview {
  upcoming: Session | null;
  recent: Session[];
}

export interface RegisterResult {
  registration: Registration;
  counts: { in: number; waitlist: number };
  /** False when the tap was a no-op because you were already registered. */
  changed: boolean;
}

export interface WithdrawResult {
  counts: { in: number; waitlist: number };
  changed: boolean;
  promoted: Registration | null;
}

export const listSessions = (signal?: AbortSignal) =>
  get<SessionsOverview>('/sessions', signal);

export interface PastSessionPage {
  sessions: Session[];
  nextCursor: string | null;
}

/** Fixtures already played, newest first. */
export const listPastSessions = (
  opts: { cursor?: string | null; limit?: number } = {},
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams();
  if (opts.cursor) query.set('cursor', opts.cursor);
  if (opts.limit) query.set('limit', String(opts.limit));
  return get<PastSessionPage>(`/sessions/past${query.size ? `?${query}` : ''}`, signal);
};

export const getSession = (id: string, signal?: AbortSignal) =>
  get<SessionDetail>(`/sessions/${id}`, signal);

export const createSession = (input: CreateSessionInput) =>
  post<{ session: Session }>('/sessions', input);

export const updateSession = (id: string, input: UpdateSessionInput) =>
  patch<{ session: Session }>(`/sessions/${id}`, input);

export const cancelSession = (id: string) =>
  patch<{ session: Session }>(`/sessions/${id}`, { status: 'cancelled' });

export const registerForSession = (id: string, guests = 0) =>
  post<RegisterResult>(`/sessions/${id}/register`, { guests });

/** Change how many friends you are bringing, without giving up your spot. */
export const setSessionGuests = (id: string, guests: number) =>
  patch<RegisterResult>(`/sessions/${id}/register`, { guests });

export const withdrawFromSession = (id: string) =>
  del<WithdrawResult>(`/sessions/${id}/register`);

export interface AttendanceResult {
  registrations: Registration[];
  arrivedHeads: number;
}

/**
 * Say who turned up.
 *
 * Omitting `memberId` marks yourself, which is all a non-organizer may do.
 * Omitting a field leaves it alone, so "I was there" and "only one of my two
 * friends came" are separate taps rather than one combined write.
 */
/** "I scored two." Omit `memberId` for yourself; organizers may name anyone. */
export const recordGoals = (id: string, body: { memberId?: string; goals: number }) =>
  post<{ registrations: Registration[] }>(`/sessions/${id}/goals`, body);

export const markAttendance = (
  id: string,
  body: { memberId?: string; attended?: boolean | null; guestsArrived?: number | null },
) => post<AttendanceResult>(`/sessions/${id}/attendance`, body);

/**
 * Deal whoever turned up into `teamCount` sides.
 *
 * Not an organizer's call, and calling it again is the ordinary way to use it:
 * a group that dislikes a draw reshuffles rather than argues.
 */
export const drawSessionTeams = (id: string, teamCount: number) =>
  post<{ draw: TeamDraw }>(`/sessions/${id}/teams`, { teamCount });

/**
 * "These are the teams." Fixes the sides — after this only an organizer may
 * redraw — and generates the fixture list.
 */
export const confirmSessionTeams = (id: string) =>
  post<{ draw: TeamDraw }>(`/sessions/${id}/teams/confirm`, {});

/** A finished game. Both goals null puts it back to not-played-yet. */
export const recordMatch = (
  id: string,
  matchId: string,
  body: { firstGoals: number | null; secondGoals: number | null },
) => post<{ draw: TeamDraw }>(`/sessions/${id}/matches/${matchId}`, body);

export const clearSessionTeams = (id: string) =>
  del<{ draw: null }>(`/sessions/${id}/teams`);
