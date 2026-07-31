/**
 * Time helpers pinned to Asia/Ho_Chi_Minh (ICT).
 *
 * Vietnam has been on a fixed UTC+7 with no daylight saving since 1975, so the
 * offset arithmetic below is exact and needs no tz database. Formatting still
 * goes through `Intl` with an explicit `timeZone` so the rendered strings stay
 * correct even if that ever changes.
 *
 * Everything crossing the API boundary is an ISO-8601 UTC instant. The "wall
 * clock" helpers exist only to answer questions like "which Friday is next?",
 * which are inherently local questions.
 */

export const TZ = 'Asia/Ho_Chi_Minh' as const;

/** Fixed ICT offset. Vietnam has observed no DST since 1975. */
export const TZ_OFFSET_MINUTES = 7 * 60;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Default kickoff: Friday 19:30 ICT. */
export const DEFAULT_KICKOFF = { weekday: 5, hour: 19, minute: 30 } as const;

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

/** Break a UTC instant into its Asia/Ho_Chi_Minh wall-clock parts. */
export function toZonedParts(instant: Date | string | number): ZonedParts {
  const date = asDate(instant);
  const shifted = new Date(date.getTime() + TZ_OFFSET_MINUTES * MS_PER_MINUTE);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** Interpret the given wall-clock parts as ICT and return the UTC instant. */
export function fromZonedParts(parts: {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
}): Date {
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    0,
    0,
  );
  return new Date(asUtc - TZ_OFFSET_MINUTES * MS_PER_MINUTE);
}

/**
 * The next kickoff strictly after `from`.
 *
 * If today is the target weekday but kickoff has already passed, this rolls to
 * next week — which is what the cron wants when it runs the morning after a
 * session.
 */
export function nextWeekday(
  from: Date | string | number = new Date(),
  weekday: number = DEFAULT_KICKOFF.weekday,
  hour: number = DEFAULT_KICKOFF.hour,
  minute: number = DEFAULT_KICKOFF.minute,
): Date {
  const now = asDate(from);
  const local = toZonedParts(now);

  let deltaDays = (weekday - local.weekday + 7) % 7;
  let candidate = fromZonedParts({
    year: local.year,
    month: local.month,
    day: local.day + deltaDays,
    hour,
    minute,
  });

  // Same-day but already kicked off → next week.
  if (candidate.getTime() <= now.getTime()) {
    deltaDays += 7;
    candidate = fromZonedParts({
      year: local.year,
      month: local.month,
      day: local.day + deltaDays,
      hour,
      minute,
    });
  }
  return candidate;
}

/** Convenience wrapper: the upcoming Friday 19:30 ICT. */
export function nextFridayKickoff(from: Date | string | number = new Date()): Date {
  return nextWeekday(from, DEFAULT_KICKOFF.weekday, DEFAULT_KICKOFF.hour, DEFAULT_KICKOFF.minute);
}

/** `YYYY-MM-DD` of the instant, in ICT. Used to dedupe "one session per day". */
export function zonedDateKey(instant: Date | string | number): string {
  const p = toZonedParts(instant);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** e.g. "Fri 08 Aug, 19:30" — the format used across the UI and chat summaries. */
export function formatKickoff(instant: Date | string | number): string {
  const p = toZonedParts(instant);
  return `${WEEKDAY_NAMES[p.weekday]} ${pad(p.day)} ${MONTHS[p.month - 1]}, ${pad(p.hour)}:${pad(p.minute)}`;
}

/** e.g. "19:30" in ICT. */
export function formatTime(instant: Date | string | number): string {
  const p = toZonedParts(instant);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** e.g. "08 Aug 2026" in ICT. */
export function formatDate(instant: Date | string | number): string {
  const p = toZonedParts(instant);
  return `${pad(p.day)} ${MONTHS[p.month - 1]} ${p.year}`;
}

/**
 * Value for a `<input type="datetime-local">`, expressed in ICT wall-clock so
 * the organizer edits the time they actually see on the poster.
 */
export function toDatetimeLocal(instant: Date | string | number): string {
  const p = toZonedParts(instant);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Inverse of {@link toDatetimeLocal}: reads a local-time string as ICT. */
export function fromDatetimeLocal(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) throw new Error(`Not a datetime-local value: ${value}`);
  return fromZonedParts({
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  });
}

/** Short human delta, e.g. "in 2 days", "in 3h", "started 40m ago". */
export function relativeToNow(instant: Date | string | number, now: Date = new Date()): string {
  const diffMs = asDate(instant).getTime() - now.getTime();
  const future = diffMs >= 0;
  const abs = Math.abs(diffMs);

  const days = Math.floor(abs / MS_PER_DAY);
  const hours = Math.floor((abs % MS_PER_DAY) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);

  let value: string;
  if (days > 0) value = `${days}d${hours > 0 ? ` ${hours}h` : ''}`;
  else if (hours > 0) value = `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
  else value = `${Math.max(minutes, 1)}m`;

  return future ? `in ${value}` : `${value} ago`;
}

function asDate(value: Date | string | number): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${String(value)}`);
  return date;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
