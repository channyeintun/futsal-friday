import type { CreateVenueInput, UpdateVenueInput, Venue } from '@futsal/shared';
import { del, get, patch, post } from './client.js';

export const listVenues = (includeRetired = false, signal?: AbortSignal) =>
  get<{ venues: Venue[] }>(`/venues${includeRetired ? '?all=1' : ''}`, signal).then(
    (r) => r.venues,
  );

export const createVenue = (input: CreateVenueInput) =>
  post<{ venue: Venue }>('/venues', input).then((r) => r.venue);

export const updateVenue = (id: string, input: UpdateVenueInput) =>
  patch<{ venue: Venue }>(`/venues/${id}`, input).then((r) => r.venue);

export const retireVenue = (id: string) => del<{ ok: true }>(`/venues/${id}`);
