/**
 * Attendance streaks.
 *
 * The point of a streak is social, not statistical — it exists so somebody can
 * say "don't break my run" in the group chat. That makes the *fairness* of the
 * rules matter more than their precision, so the three judgement calls are:
 *
 * - **A cancelled session is not a miss.** Nobody played, so nobody's run ends.
 *   Those are filtered out before they reach here.
 * - **The waitlist is not a miss either.** You said yes and there was no room;
 *   ending your streak for the organizer's cap would be punishing the wrong
 *   person. It neither extends nor breaks — the session is skipped.
 * - **Games before you joined do not count.** Also filtered out upstream.
 *
 * Saying "out", or never answering at all, breaks it. Those are the same thing
 * from the pitch's point of view.
 */

/** What a member did about one session that has already happened. */
export type Attendance = 'in' | 'waitlist' | 'missed';

export interface StreakEntry {
  sessionId: string;
  startsAt: string;
  attendance: Attendance;
}

export interface Streak {
  /** Consecutive games played, counting back from the most recent one. */
  current: number;
  /** The longest run ever, which is the one worth bragging about. */
  best: number;
  played: number;
  /**
   * Every game that happened while they were a member, cancelled ones and
   * anything before they joined excluded. Waitlisted games are counted here
   * even though the streak ignores them — "played 12 of 15" should not quietly
   * shrink its own denominator.
   */
  total: number;
}

/**
 * `entries` must be newest-first, which is the order the query returns and the
 * order the current streak has to be read in.
 */
export function computeStreak(entries: readonly StreakEntry[]): Streak {
  let current = 0;
  let best = 0;
  let run = 0;
  let played = 0;
  // Only the leading run counts as "current", so stop growing it at the first
  // miss — but keep walking, because `best` may be further back.
  let currentIsLive = true;

  for (const entry of entries) {
    if (entry.attendance === 'waitlist') continue;

    if (entry.attendance === 'in') {
      played++;
      run++;
      if (currentIsLive) current++;
      if (run > best) best = run;
    } else {
      run = 0;
      currentIsLive = false;
    }
  }

  return { current, best, played, total: entries.length };
}
