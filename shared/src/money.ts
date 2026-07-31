/**
 * Money helpers.
 *
 * All amounts are **integer Vietnamese dong**. VND has no circulating subunit,
 * so there are no fractional amounts anywhere in this app — never introduce a
 * float here. Splitting is done with a largest-remainder allocation so the
 * shares always sum back to the total exactly, with no cent (dong) drift.
 */

/** Cash in Vietnam moves in 1,000d notes; default every split to that grain. */
export const DEFAULT_GRANULARITY = 1_000;

/**
 * Split `total` across `count` people so that:
 *   - every share is a multiple of `granularity` where possible,
 *   - the shares differ by at most one granularity step,
 *   - `sum(shares) === total`, exactly.
 *
 * The extra dong land on the earliest registrants, which is deterministic and
 * therefore reproducible when the organizer re-settles a session.
 */
export function splitEqually(
  total: number,
  count: number,
  granularity: number = DEFAULT_GRANULARITY,
): number[] {
  if (!Number.isFinite(total) || !Number.isFinite(count)) {
    throw new Error('splitEqually: total and count must be finite');
  }
  if (count <= 0) return [];
  if (total <= 0) return new Array(count).fill(0);

  const grain = Math.max(1, Math.floor(granularity));
  const cents = Math.round(total);

  const base = Math.floor(cents / count / grain) * grain;
  const shares: number[] = new Array(count).fill(base);

  let remainder = cents - base * count;
  for (let i = 0; i < count && remainder > 0; i++) {
    const step = Math.min(grain, remainder);
    shares[i] = (shares[i] ?? 0) + step;
    remainder -= step;
  }
  // Guaranteed unreachable (remainder < count * grain), but keeps the
  // invariant sum(shares) === total true even if grain/count change.
  if (remainder > 0) shares[0] = (shares[0] ?? 0) + remainder;

  return shares;
}

export interface SplitInput {
  /** Stable key per payer — a member id. */
  id: string;
  /** Absolute amount fixed by the organizer for this person, if any. */
  override?: number | null;
}

/**
 * Split a session's total charge across payers, honouring per-person overrides.
 *
 * Overridden people pay exactly what the organizer typed; whatever is left over
 * is split equally among everybody else. If the overrides already exceed the
 * total, the remaining players owe nothing rather than a negative amount.
 */
export function splitWithOverrides(
  total: number,
  payers: readonly SplitInput[],
  granularity: number = DEFAULT_GRANULARITY,
): Map<string, number> {
  const result = new Map<string, number>();

  const fixed = payers.filter((p) => typeof p.override === 'number' && p.override !== null);
  const flexible = payers.filter((p) => !(typeof p.override === 'number' && p.override !== null));

  let fixedSum = 0;
  for (const p of fixed) {
    const amount = Math.max(0, Math.round(p.override as number));
    result.set(p.id, amount);
    fixedSum += amount;
  }

  const remaining = Math.max(0, Math.round(total) - fixedSum);
  const shares = splitEqually(remaining, flexible.length, granularity);
  flexible.forEach((p, i) => result.set(p.id, shares[i] ?? 0));

  return result;
}

/** `120000` → `"120.000d"`. Vietnamese convention uses `.` as the group mark. */
export function formatVnd(amount: number): string {
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${digits}d`;
}

/** Tolerant of what people actually type: "120k", "120.000", "120 000". */
export function parseVnd(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  const shorthand = /^(\d+(?:[.,]\d+)?)\s*k$/.exec(trimmed);
  if (shorthand) return Math.round(Number(shorthand[1]!.replace(',', '.')) * 1_000);

  const digits = trimmed.replace(/[.,\s]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  return Number(digits);
}
