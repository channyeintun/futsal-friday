import { z } from 'zod';
import { idSchema, isoSchema, paymentStatusSchema, registrationStatusSchema, sessionStatusSchema, teamDrawSchema, vndSchema } from './models.js';

/**
 * Typed realtime events.
 *
 * The nested shape is what `@upstash/realtime` wants for its dotted event
 * paths (`player.joined` addresses `realtimeSchema.player.joined`), and the
 * same object gives us the payload types on the client. One definition, both
 * sides — a mismatch is a type error rather than a silent no-op at runtime.
 *
 * Payloads are deliberately *self-sufficient*: a client that receives
 * `player.joined` can update its list and its counter without issuing a
 * follow-up request. That keeps Worker requests and Upstash commands down,
 * which is the whole game on these free tiers.
 */

/* ----------------------------------------------------------------- channels */

/** Everything about one session fans out on its own channel. */
export function sessionChannel(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Low-traffic channel for "the schedule changed" pings on the home screen. */
export const LOBBY_CHANNEL = 'lobby';

/**
 * Heads, not rows. `in` counts everybody standing on the pitch — members and
 * the guests they brought — because that is what the cap is about. `guests` is
 * how many of those are guests, so a screen can explain the difference between
 * "7 playing" and five names on the list.
 */
const counts = z.object({
  in: z.number().int(),
  waitlist: z.number().int(),
  guests: z.number().int().default(0),
});

/* ------------------------------------------------------------------ schemas */

export const playerJoinedSchema = z.object({
  sessionId: idSchema,
  memberId: idSchema,
  memberName: z.string(),
  /**
   * Carried for the same reason as the name: so a client can draw the new row
   * complete, without the picture popping in on the next refresh.
   */
  memberAvatarUpdatedAt: isoSchema.nullable().default(null),
  /** How many friends they brought; they answer for the spots and the cost. */
  guests: z.number().int().min(0).default(0),
  /**
   * Where they stood. Carried for the same reason as the name and the picture:
   * without it every other phone draws the arrival into the first gap, and only
   * a refetch would slide it across to where they actually pressed.
   */
  slot: z.number().int().nullable().default(null),
  status: registrationStatusSchema,
  position: z.number().int(),
  counts,
  at: isoSchema,
});

export const playerLeftSchema = z.object({
  sessionId: idSchema,
  memberId: idSchema,
  memberName: z.string(),
  /** Set when this withdrawal auto-promoted the first person off the waitlist. */
  promoted: z.object({ memberId: idSchema, memberName: z.string() }).nullable(),
  counts,
  at: isoSchema,
});

/**
 * Somebody said who turned up.
 *
 * Carries the resulting head count so the settle screen can update the
 * suggested charge without a refetch — attendance is usually marked by several
 * people at once, in the ten minutes around kickoff.
 */
export const playerAttendanceSchema = z.object({
  sessionId: idSchema,
  memberId: idSchema,
  memberName: z.string(),
  /** `null` puts it back to unmarked. */
  attended: z.boolean().nullable(),
  guestsArrived: z.number().int().min(0).max(5).nullable(),
  /** Heads now down as having played, across the whole session. */
  arrivedHeads: z.number().int().min(0),
  /** Who marked it — not always the person it is about. */
  byMemberId: idSchema,
  at: isoSchema,
});

export const paymentClaimedSchema = z.object({
  sessionId: idSchema,
  memberId: idSchema,
  memberName: z.string(),
  amountDue: vndSchema,
  hasProof: z.boolean(),
  at: isoSchema,
});

export const paymentConfirmedSchema = z.object({
  sessionId: idSchema,
  memberId: idSchema,
  memberName: z.string(),
  amountDue: vndSchema,
  at: isoSchema,
});

export const paymentRejectedSchema = z.object({
  sessionId: idSchema,
  memberId: idSchema,
  memberName: z.string(),
  reason: z.string().nullable(),
  at: isoSchema,
});

/**
 * The team board changed: split, reshuffled, confirmed, scored or cleared.
 *
 * One event for all of it, carrying the whole board. That is the point:
 * everyone is standing on the same pitch looking at the same six phones, and a
 * change that arrived as "go and refetch" would land on each of them at a
 * slightly different moment. The payload is a dozen names and a handful of
 * scorelines, so sending it costs less than the round trip it saves.
 *
 * `draw` is null when the teams were cleared — the same fact ("the board is
 * now this") with nothing on it.
 */
export const teamsChangedSchema = z.object({
  sessionId: idSchema,
  draw: teamDrawSchema.nullable(),
  /** Who did it — anybody may, so this is not implied by the session. */
  byMemberId: idSchema,
  byMemberName: z.string(),
  at: isoSchema,
});

/**
 * Somebody said something.
 *
 * Carries the whole message rather than a nudge to refetch — the same rule as
 * `player.joined`, and it matters more here: a thread that goes back to the
 * server for every jab turns a five-message exchange into ten round trips on
 * fifteen phones. The board, by contrast, ships whole because it is one object
 * that changes at once; a thread only ever grows by one at the end.
 */
export const messagePostedSchema = z.object({
  sessionId: idSchema,
  id: idSchema,
  memberId: idSchema,
  memberName: z.string(),
  memberAvatarUpdatedAt: isoSchema.nullable().default(null),
  body: z.string(),
  at: isoSchema,
});

/** Taken down by its author or an organizer. The id is all a client needs. */
export const messageDeletedSchema = z.object({
  sessionId: idSchema,
  id: idSchema,
  byMemberId: idSchema,
  at: isoSchema,
});

/**
 * The MVP vote moved.
 *
 * Carries nothing but the fact that it did — no nominee, no voter, no counts.
 * Every other event in this catalogue is deliberately self-sufficient so a
 * client can patch without refetching; this one deliberately is not, because
 * what it would have to carry is exactly what the read refuses to hand
 * somebody who has not voted yet. A viewer who has voted refetches and sees
 * the new tally; one who has not sees the same nothing they saw before.
 */
export const mvpChangedSchema = z.object({
  sessionId: idSchema,
  at: isoSchema,
});

export const sessionUpdatedSchema = z.object({
  sessionId: idSchema,
  status: sessionStatusSchema,
  startsAt: isoSchema,
  venueId: idSchema.nullable(),
  /** Why the session changed — lets the UI decide whether to refetch heavily. */
  reason: z.enum(['created', 'edited', 'cancelled', 'settled', 'completed']),
  at: isoSchema,
});

/**
 * The single source of truth for the event catalogue. Passed straight into
 * `new Realtime({ schema })` on the Worker, which validates every payload with
 * these before it reaches Redis.
 */
export const realtimeSchema = {
  player: {
    joined: playerJoinedSchema,
    left: playerLeftSchema,
    attendance: playerAttendanceSchema,
  },
  payment: {
    claimed: paymentClaimedSchema,
    confirmed: paymentConfirmedSchema,
    rejected: paymentRejectedSchema,
  },
  teams: {
    changed: teamsChangedSchema,
  },
  message: {
    posted: messagePostedSchema,
    deleted: messageDeletedSchema,
  },
  mvp: {
    changed: mvpChangedSchema,
  },
  session: {
    updated: sessionUpdatedSchema,
  },
} as const;

export type RealtimeSchema = typeof realtimeSchema;

/* -------------------------------------------------------------------- types */

export interface EventPayloadMap {
  'player.joined': z.infer<typeof playerJoinedSchema>;
  'player.left': z.infer<typeof playerLeftSchema>;
  'player.attendance': z.infer<typeof playerAttendanceSchema>;
  'payment.claimed': z.infer<typeof paymentClaimedSchema>;
  'payment.confirmed': z.infer<typeof paymentConfirmedSchema>;
  'payment.rejected': z.infer<typeof paymentRejectedSchema>;
  'teams.changed': z.infer<typeof teamsChangedSchema>;
  'message.posted': z.infer<typeof messagePostedSchema>;
  'message.deleted': z.infer<typeof messageDeletedSchema>;
  'mvp.changed': z.infer<typeof mvpChangedSchema>;
  'session.updated': z.infer<typeof sessionUpdatedSchema>;
}

export type EventName = keyof EventPayloadMap;
export type EventPayload<K extends EventName> = EventPayloadMap[K];

export const EVENT_NAMES = [
  'player.joined',
  'player.left',
  'player.attendance',
  'payment.claimed',
  'payment.confirmed',
  'payment.rejected',
  'teams.changed',
  'message.posted',
  'message.deleted',
  'mvp.changed',
  'session.updated',
] as const satisfies readonly EventName[];

/**
 * Compile-time proof that {@link EventPayloadMap} says exactly what
 * {@link realtimeSchema} says.
 *
 * `@upstash/realtime` types `emit` by walking the schema object along the
 * dotted path, which TypeScript cannot prove equivalent to a lookup in the map
 * above while the event name is still a generic parameter. The Worker's pub/sub
 * adapter therefore casts once at that seam — and these assertions are what
 * make the cast safe. Point a payload at the wrong schema, or add an event to
 * one side only, and the build fails here rather than at runtime in Redis.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type EventCatalogueIsConsistent = Assert<
  Exact<EventPayloadMap['player.joined'], z.infer<typeof realtimeSchema.player.joined>>
> &
  Assert<Exact<EventPayloadMap['player.left'], z.infer<typeof realtimeSchema.player.left>>> &
  Assert<
    Exact<EventPayloadMap['player.attendance'], z.infer<typeof realtimeSchema.player.attendance>>
  > &
  Assert<Exact<EventPayloadMap['payment.claimed'], z.infer<typeof realtimeSchema.payment.claimed>>> &
  Assert<
    Exact<EventPayloadMap['payment.confirmed'], z.infer<typeof realtimeSchema.payment.confirmed>>
  > &
  Assert<
    Exact<EventPayloadMap['payment.rejected'], z.infer<typeof realtimeSchema.payment.rejected>>
  > &
  Assert<Exact<EventPayloadMap['teams.changed'], z.infer<typeof realtimeSchema.teams.changed>>> &
  Assert<
    Exact<EventPayloadMap['message.posted'], z.infer<typeof realtimeSchema.message.posted>>
  > &
  Assert<
    Exact<EventPayloadMap['message.deleted'], z.infer<typeof realtimeSchema.message.deleted>>
  > &
  Assert<Exact<EventPayloadMap['mvp.changed'], z.infer<typeof realtimeSchema.mvp.changed>>> &
  Assert<Exact<EventPayloadMap['session.updated'], z.infer<typeof realtimeSchema.session.updated>>>;

/** Discriminated union of every event, handy for exhaustive `switch`es. */
export type RealtimeEvent = {
  [K in EventName]: { name: K; channel: string; data: EventPayload<K> };
}[EventName];

/* --------------------------------------------------------------- wire format */

/**
 * SSE frame shapes emitted by `@upstash/realtime`'s `handle()`.
 *
 * Mirrored here (rather than imported) so the frontend never has to depend on
 * the server library, and so a different transport could speak the same
 * protocol.
 */
export const wireUserEventSchema = z.object({
  data: z.unknown(),
  __event_path: z.array(z.string()),
  __stream_id: z.string().optional(),
  __channel: z.string().optional(),
});

export const wireSystemEventSchema = z.union([
  z.object({ type: z.literal('connected'), channel: z.string(), cursor: z.string().optional() }),
  z.object({ type: z.literal('reconnect') }),
  z.object({ type: z.literal('error'), error: z.string() }),
  z.object({ type: z.literal('disconnected'), channel: z.string() }),
  z.object({ type: z.literal('ping'), timestamp: z.number() }),
]);

export type WireSystemEvent = z.infer<typeof wireSystemEventSchema>;

/**
 * Narrow a raw SSE frame into a typed application event, or `null` if it is a
 * system frame / an event this build does not know about. Unknown events are
 * ignored rather than thrown so an older client survives a newer server.
 */
export function parseWireEvent(raw: unknown): RealtimeEvent | null {
  const parsed = wireUserEventSchema.safeParse(raw);
  if (!parsed.success) return null;

  const name = parsed.data.__event_path.join('.') as EventName;
  const schema = lookupSchema(parsed.data.__event_path);
  if (!schema) return null;

  const payload = schema.safeParse(parsed.data.data);
  if (!payload.success) return null;

  return {
    name,
    channel: parsed.data.__channel ?? '',
    data: payload.data,
  } as RealtimeEvent;
}

function lookupSchema(path: readonly string[]): z.ZodType | null {
  let node: unknown = realtimeSchema;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[key];
  }
  return node instanceof z.ZodType ? node : null;
}
