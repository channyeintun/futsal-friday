import type {
  CreateSessionInput,
  Registration,
  Session,
  SessionDetail,
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
