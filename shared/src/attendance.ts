/**
 * Who actually played.
 *
 * Registering is a promise; arriving is what the pitch bill is divided by. The
 * two used to be the same field, so a no-show was charged a full share — which
 * meant everybody who did play was under-charged by exactly that much — and
 * their streak survived a game they never came to.
 *
 * Every rule about presence lives here rather than in SQL, because the split,
 * the streak, the roster and the chat summary all have to agree about it. A
 * `WHERE` clause that answers this question in one route and not the others is
 * how the two facts drifted apart in the first place.
 */

/** The registration fields presence depends on. Anything wider is noise here. */
export interface AttendanceInput {
  /** `'in'` or `'waitlist'` — what they said before the game. */
  status: 'in' | 'waitlist';
  /** Guests they registered. */
  guests?: number | null;
  /** `null` when nobody has marked it, else an explicit answer. */
  attended?: boolean | null;
  /** `null` means "as registered", not zero. */
  guestsArrived?: number | null;
}

/**
 * Did this person play?
 *
 * Unmarked is a *presumption*, not a default value, and it differs by status:
 * somebody who was in is presumed to have turned up, somebody on the waitlist
 * is presumed not to have. An explicit mark beats both — including the case
 * worth spelling out, a reserve who played because somebody else silently
 * failed to show and so was never promoted off the waitlist.
 */
export function didAttend(reg: AttendanceInput): boolean {
  if (reg.attended != null) return reg.attended;
  return reg.status === 'in';
}

/**
 * How many people this registration is charged for — themselves plus whichever
 * guests turned up.
 *
 * A no-show's party is worth nothing regardless of what they registered:
 * guests arrive *with* the member who vouched for them, so if that member is
 * marked absent the guests are too, unless somebody has said otherwise by
 * setting `guestsArrived` explicitly.
 */
export function arrivedHeads(reg: AttendanceInput): number {
  const registered = Math.max(0, reg.guests ?? 0);
  const present = didAttend(reg);

  const guests = reg.guestsArrived != null
    ? Math.max(0, Math.min(reg.guestsArrived, registered))
    : present
      ? registered
      : 0;

  return (present ? 1 : 0) + guests;
}

/**
 * Just the guests out of that party, for the number snapshotted onto the
 * charge. Derived from `arrivedHeads` rather than computed alongside it, so
 * the two can never disagree about the same registration.
 */
export function arrivedGuests(reg: AttendanceInput): number {
  return arrivedHeads(reg) - (didAttend(reg) ? 1 : 0);
}

/** Everyone the bill should be divided between. */
export function arrivedOnly<T extends AttendanceInput>(regs: readonly T[]): T[] {
  return regs.filter((r) => arrivedHeads(r) > 0);
}

/** Total heads on the pitch, for the suggested charge and the player count. */
export function totalArrivedHeads(regs: readonly AttendanceInput[]): number {
  return regs.reduce((sum, r) => sum + arrivedHeads(r), 0);
}

/**
 * Whether the roster has been checked at all.
 *
 * The point of keeping "unmarked" distinguishable from "confirmed present" is
 * so the settle screen can say whether anybody has actually looked, rather
 * than presenting a presumption as a headcount.
 */
export function attendanceChecked(regs: readonly AttendanceInput[]): boolean {
  return regs.some((r) => r.attended != null || r.guestsArrived != null);
}

/**
 * What the organiser is likely to charge: the standing per-person fee times
 * the number of heads that turned up.
 *
 * A suggestion, never the bill. The pitch is rented by the hour, so the total
 * is the real constraint and the fee is only what the group normally expects
 * to pay each — the settle form prefills this and lets it be overwritten.
 * Returns null when there is no standing fee to multiply.
 */
export function suggestedTotal(
  feePerPerson: number | null | undefined,
  regs: readonly AttendanceInput[],
): number | null {
  if (feePerPerson == null || feePerPerson <= 0) return null;
  const heads = totalArrivedHeads(regs);
  return heads > 0 ? Math.round(feePerPerson) * heads : null;
}
