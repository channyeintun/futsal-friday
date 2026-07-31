import { z } from 'zod';
import { idSchema, isoSchema, paymentStatusSchema, registrationStatusSchema, sessionStatusSchema, vndSchema } from './models.js';

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

const counts = z.object({
  in: z.number().int(),
  waitlist: z.number().int(),
});

/* ------------------------------------------------------------------ schemas */

export const playerJoinedSchema = z.object({
  sessionId: idSchema,
  memberId: idSchema,
  memberName: z.string(),
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
  },
  payment: {
    claimed: paymentClaimedSchema,
    confirmed: paymentConfirmedSchema,
    rejected: paymentRejectedSchema,
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
  'payment.claimed': z.infer<typeof paymentClaimedSchema>;
  'payment.confirmed': z.infer<typeof paymentConfirmedSchema>;
  'payment.rejected': z.infer<typeof paymentRejectedSchema>;
  'session.updated': z.infer<typeof sessionUpdatedSchema>;
}

export type EventName = keyof EventPayloadMap;
export type EventPayload<K extends EventName> = EventPayloadMap[K];

export const EVENT_NAMES = [
  'player.joined',
  'player.left',
  'payment.claimed',
  'payment.confirmed',
  'payment.rejected',
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
  Assert<Exact<EventPayloadMap['payment.claimed'], z.infer<typeof realtimeSchema.payment.claimed>>> &
  Assert<
    Exact<EventPayloadMap['payment.confirmed'], z.infer<typeof realtimeSchema.payment.confirmed>>
  > &
  Assert<
    Exact<EventPayloadMap['payment.rejected'], z.infer<typeof realtimeSchema.payment.rejected>>
  > &
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
 * the server library, and so the ZMP port can talk the same protocol with a
 * different transport.
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
