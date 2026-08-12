import { z } from 'zod';

/**
 * Domain models + request payloads, defined once and used on both sides of the
 * wire: the Worker parses inbound bodies with these, the frontend types its
 * fetch results from them.
 */

export const idSchema = z.string().min(1).max(64);
/** ISO-8601 UTC instant. Every timestamp in the API is one of these. */
export const isoSchema = z.iso.datetime();
/** Non-negative integer dong. */
export const vndSchema = z.number().int().min(0).max(1_000_000_000);

/* ------------------------------------------------------------------ member */

export const memberSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(40),
  isOrganizer: z.boolean(),
  active: z.boolean(),
  createdAt: isoSchema,
  /** When this identity was first claimed via a link; null if nobody has. */
  claimedAt: isoSchema.nullable(),
  /** True while an unspent claim link is outstanding for this member. */
  hasPendingLink: z.boolean(),
  /** Reminder preferences; only meaningful once push is granted on a device. */
  notifySession: z.boolean().default(true),
  notifyPayment: z.boolean().default(true),
  /** Drives the UI and, crucially, server-written push notifications. */
  language: z.enum(['en', 'my']).default('en'),
  /** Their clock, for the same two reasons. */
  hour12: z.boolean().default(false),
  /**
   * When the profile picture last changed, or null if there is none. The R2
   * key stays server-side; this is what the client caches the image against.
   */
  avatarUpdatedAt: isoSchema.nullable().default(null),
  /**
   * When an organizer let them in. Null means they added themselves from the
   * group link and are still waiting — a different thing from `active`, which
   * is the soft delete for people who have left.
   */
  approvedAt: isoSchema.nullable().default(null),
});
export type Member = z.infer<typeof memberSchema>;

/** Attendance run, computed from every past session since the member joined. */
export const streakSchema = z.object({
  current: z.number().int().min(0),
  best: z.number().int().min(0),
  played: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type StreakStats = z.infer<typeof streakSchema>;

export const memberProfileSchema = z.object({
  member: memberSchema,
  streak: streakSchema,
  /** Still owed across every session, so a profile shows the whole picture. */
  outstanding: z.number().int().min(0),
});
export type MemberProfile = z.infer<typeof memberProfileSchema>;

export const createMemberSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(40),
  isOrganizer: z.boolean().optional().default(false),
});
export type CreateMemberInput = z.infer<typeof createMemberSchema>;

export const updateMemberSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  isOrganizer: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

/** A member may change only their own reminder preferences and language. */
export const notificationPrefsSchema = z.object({
  notifySession: z.boolean().optional(),
  notifyPayment: z.boolean().optional(),
  language: z.enum(['en', 'my']).optional(),
  /** True for "7:30 PM", false for "19:30". Follows them onto a new phone. */
  hour12: z.boolean().optional(),
});
export type NotificationPrefsInput = z.infer<typeof notificationPrefsSchema>;

/* --------------------------------------------------------------- web push */

/** Exactly what `PushSubscription.toJSON()` produces in the browser. */
export const pushSubscriptionSchema = z.object({
  endpoint: z.url().max(500),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export const pushStatusSchema = z.object({
  /** False when the server has no VAPID keys; the UI hides the toggle. */
  enabled: z.boolean(),
  /** Application server key the browser needs to subscribe. */
  publicKey: z.string().nullable(),
  /** How many devices this member currently has reminders on. */
  devices: z.number().int(),
  notifySession: z.boolean(),
  notifyPayment: z.boolean(),
  language: z.enum(['en', 'my']),
  hour12: z.boolean().default(false),
});
export type PushStatus = z.infer<typeof pushStatusSchema>;

/* --------------------------------------------------------- payment details */

/**
 * Where the group sends money. One per group, set by an organizer.
 *
 * Not a secret — an account number and a name are what would otherwise be
 * pasted into the chat every week, and the point is that anyone can look them
 * up without asking. Still behind sign-in.
 */
export const paymentDetailsSchema = z.object({
  /** NAPAS acquirer id; the six digits VietQR addresses a bank by. */
  bankBin: z.string().regex(/^\d{6}$/, 'Pick a bank'),
  bankName: z.string().min(1).max(60),
  accountNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{4,19}$/, 'Account number should be 4-19 letters or digits'),
  accountName: z.string().trim().min(1, 'Who the account belongs to').max(60),
  note: z.string().trim().max(160).nullish(),
  updatedAt: isoSchema,
});
export type PaymentDetails = z.infer<typeof paymentDetailsSchema>;

export const savePaymentDetailsSchema = paymentDetailsSchema.omit({ updatedAt: true });
export type SavePaymentDetailsInput = z.infer<typeof savePaymentDetailsSchema>;

/* ------------------------------------------------------------------- venue */

export const venueSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  address: z.string().max(200).nullable(),
  mapUrl: z.url().max(500).nullable(),
  priceNote: z.string().max(120).nullable(),
  active: z.boolean(),
  createdAt: isoSchema,
});
export type Venue = z.infer<typeof venueSchema>;

export const createVenueSchema = z.object({
  name: z.string().trim().min(1, 'Venue name is required').max(80),
  address: z.string().trim().max(200).nullish(),
  mapUrl: z.url('Must be a valid URL').max(500).nullish().or(z.literal('')),
  priceNote: z.string().trim().max(120).nullish(),
});
export type CreateVenueInput = z.infer<typeof createVenueSchema>;

export const updateVenueSchema = createVenueSchema.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateVenueInput = z.infer<typeof updateVenueSchema>;

/* ----------------------------------------------------------------- session */

export const sessionStatusSchema = z.enum(['scheduled', 'cancelled', 'completed']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSchema = z.object({
  id: idSchema,
  startsAt: isoSchema,
  venueId: idSchema.nullable(),
  venue: venueSchema.nullable(),
  status: sessionStatusSchema,
  /** Organizer's up-front estimate, shown before the session is settled. */
  feePerPerson: vndSchema.nullable(),
  /** Actual charge, entered after the session. Drives the payment split. */
  totalCharge: vndSchema.nullable(),
  maxPlayers: z.number().int().min(1).max(60).nullable(),
  notes: z.string().max(500).nullable(),
  createdAt: isoSchema,
  updatedAt: isoSchema,
});
export type Session = z.infer<typeof sessionSchema>;

export const createSessionSchema = z.object({
  startsAt: isoSchema,
  venueId: idSchema.nullish(),
  feePerPerson: vndSchema.nullish(),
  maxPlayers: z.number().int().min(1).max(60).nullish(),
  notes: z.string().trim().max(500).nullish(),
});
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const updateSessionSchema = createSessionSchema.partial().extend({
  status: sessionStatusSchema.optional(),
});
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;

/* ------------------------------------------------------------ registration */

export const registrationStatusSchema = z.enum(['in', 'waitlist']);
export type RegistrationStatus = z.infer<typeof registrationStatusSchema>;

/** Sign up, optionally bringing friends. */
export const registerSchema = z.object({
  guests: z.number().int().min(0).max(5).default(0),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const registrationSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  memberId: idSchema,
  memberName: z.string(),
  /** Cache token for the member's picture; null when they have none. */
  memberAvatarUpdatedAt: isoSchema.nullable().default(null),
  /**
   * Friends brought along who have no account. They take spots and cost money;
   * this member answers for both.
   */
  guests: z.number().int().min(0).max(5).default(0),
  status: registrationStatusSchema,
  /**
   * Whether they actually turned up. `null` means nobody has said, which is
   * read as present for `in` and absent for `waitlist` — see `attendance.ts`.
   * Kept distinct from `false` so the settle screen can tell an unchecked
   * roster from a confirmed one.
   */
  attended: z.boolean().nullable().default(null),
  /** How many guests came. `null` means "as registered", not none. */
  guestsArrived: z.number().int().min(0).max(5).nullable().default(null),
  /** Monotonic per session; defines display order and waitlist promotion order. */
  position: z.number().int(),
  createdAt: isoSchema,
});
export type Registration = z.infer<typeof registrationSchema>;

/**
 * Say who turned up.
 *
 * `memberId` is only honoured for an organizer; everyone else may mark
 * themselves and nobody else. Every field is optional so the two halves —
 * "I was there" and "only one of my two friends came" — can be sent apart.
 */
export const markAttendanceSchema = z.object({
  memberId: idSchema.optional(),
  attended: z.boolean().nullable().optional(),
  guestsArrived: z.number().int().min(0).max(5).nullable().optional(),
});
export type MarkAttendanceInput = z.infer<typeof markAttendanceSchema>;

/* ----------------------------------------------------------------- payment */

/** unpaid -> pending (member claims) -> confirmed (organizer verifies). */
export const paymentStatusSchema = z.enum(['unpaid', 'pending', 'confirmed']);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const paymentSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  memberId: idSchema,
  memberName: z.string(),
  /** What this person owes after the split and any override. */
  amountDue: vndSchema,
  /** Organizer's manual per-person amount, when set. */
  amountOverride: vndSchema.nullable(),
  /**
   * Guests this charge was computed for, snapshotted when the bill was split.
   * Keeps the amount explainable from the payment alone.
   */
  guests: z.number().int().min(0).default(0),
  status: paymentStatusSchema,
  /** True when a screenshot exists; the object key itself stays server-side. */
  hasProof: z.boolean(),
  note: z.string().max(300).nullable(),
  rejectReason: z.string().max(300).nullable(),
  claimedAt: isoSchema.nullable(),
  confirmedAt: isoSchema.nullable(),
  updatedAt: isoSchema,
});
export type Payment = z.infer<typeof paymentSchema>;

export const settleSessionSchema = z.object({
  totalCharge: vndSchema,
  /** Round each share to this grain (dong). 1 disables rounding. */
  granularity: z.number().int().min(1).max(100_000).optional(),
  /** Absolute amounts that bypass the equal split. */
  overrides: z.array(z.object({ memberId: idSchema, amount: vndSchema })).max(60).optional(),
});
export type SettleSessionInput = z.infer<typeof settleSessionSchema>;

export const claimPaymentSchema = z.object({
  /** R2 object key returned by the upload endpoint. */
  proofKey: z.string().max(200).nullish(),
  note: z.string().trim().max(300).nullish(),
});
export type ClaimPaymentInput = z.infer<typeof claimPaymentSchema>;

export const reviewPaymentSchema = z.object({
  decision: z.enum(['confirm', 'reject']),
  reason: z.string().trim().max(300).nullish(),
});
export type ReviewPaymentInput = z.infer<typeof reviewPaymentSchema>;

export const overridePaymentSchema = z.object({
  /** null clears the override and returns this person to the equal split. */
  amount: vndSchema.nullable(),
});
export type OverridePaymentInput = z.infer<typeof overridePaymentSchema>;

/* -------------------------------------------------------- composite views */

export const sessionDetailSchema = z.object({
  session: sessionSchema,
  registrations: z.array(registrationSchema),
  counts: z.object({
    /** Heads on the pitch: members plus the guests they brought. */
    in: z.number().int(),
    waitlist: z.number().int(),
    /** How many of `in` are guests, so a screen can say why the numbers differ. */
    guests: z.number().int().default(0),
  }),
  /** Whether registration is still open (before kickoff, not cancelled). */
  registrationOpen: z.boolean(),
  /** The caller's own registration, if any. */
  me: registrationSchema.nullable(),
});
export type SessionDetail = z.infer<typeof sessionDetailSchema>;

export const paymentSummarySchema = z.object({
  sessionId: idSchema,
  totalCharge: vndSchema.nullable(),
  collected: vndSchema,
  pending: vndSchema,
  outstanding: vndSchema,
  payments: z.array(paymentSchema),
});
export type PaymentSummary = z.infer<typeof paymentSummarySchema>;

export const memberBalanceSchema = z.object({
  member: memberSchema,
  sessionsPlayed: z.number().int(),
  totalOwed: vndSchema,
  totalConfirmed: vndSchema,
  /** Owed minus confirmed: what this person still needs to settle up. */
  outstanding: vndSchema,
});
export type MemberBalance = z.infer<typeof memberBalanceSchema>;

export const memberHistoryEntrySchema = z.object({
  session: sessionSchema,
  registrationStatus: registrationStatusSchema.nullable(),
  payment: paymentSchema.nullable(),
});
export type MemberHistoryEntry = z.infer<typeof memberHistoryEntrySchema>;

/* -------------------------------------------------------------- identity */

export const identitySchema = z.object({
  memberId: idSchema,
  name: z.string(),
  isOrganizer: z.boolean(),
  /**
   * False while the organizer has not let them in yet. The client shows a
   * waiting screen; the server refuses everything but this check.
   */
  approved: z.boolean().default(true),
  /** Follows the member across devices, so a new phone opens in their language. */
  language: z.enum(['en', 'my']),
  /** And on their preferred clock. */
  hour12: z.boolean().default(false),
});
export type Identity = z.infer<typeof identitySchema>;

/**
 * Redeeming a claim link.
 *
 * The nonce travels in the URL *fragment*, which browsers never send to the
 * server and which stays out of access logs and `Referer` headers. The page
 * reads it and posts it here.
 */
export const claimSchema = z.object({
  nonce: z.string().min(20).max(100),
});
export type ClaimInput = z.infer<typeof claimSchema>;

/** A name offered on the group join screen. Nothing else about them leaks. */
export const joinableMemberSchema = z.object({
  id: idSchema,
  name: z.string(),
});
export type JoinableMember = z.infer<typeof joinableMemberSchema>;

export const groupJoinSchema = z.object({
  nonce: z.string().min(20).max(100),
});
export type GroupJoinInput = z.infer<typeof groupJoinSchema>;

/**
 * Putting your own name forward from the group link.
 *
 * Same nonce as the name picker, so only somebody holding the link can do it,
 * and the result is a member the organizer still has to approve.
 */
export const groupSelfAddSchema = z.object({
  nonce: z.string().min(20),
  name: z.string().trim().min(1, 'Name is required').max(40),
});
export type GroupSelfAddInput = z.infer<typeof groupSelfAddSchema>;

export const groupClaimSchema = z.object({
  nonce: z.string().min(20).max(100),
  memberId: idSchema,
});
export type GroupClaimInput = z.infer<typeof groupClaimSchema>;

/** The one link the organizer pastes into the group chat. */
export const groupInviteSchema = z.object({
  url: z.string(),
  expiresAt: isoSchema,
  /** How many people still have a name to claim through it. */
  unclaimed: z.number().int(),
});
export type GroupInvite = z.infer<typeof groupInviteSchema>;

export const claimLinkSchema = z.object({
  /** Full URL to send to the person. Contains the only copy of the nonce. */
  url: z.string(),
  expiresAt: isoSchema,
  memberName: z.string(),
});
export type ClaimLink = z.infer<typeof claimLinkSchema>;
