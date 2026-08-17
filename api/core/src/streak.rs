//! Attendance streaks.
//!
//! The point of a streak is social, not statistical — it exists so somebody can
//! say "don't break my run" in the group chat. That makes the *fairness* of the
//! rules matter more than their precision, so the three judgement calls are:
//!
//! - **A cancelled session is not a miss.** Nobody played, so nobody's run ends.
//!   Those are filtered out before they reach here.
//! - **The waitlist is not a miss either.** You said yes and there was no room;
//!   ending your streak for the organizer's cap would be punishing the wrong
//!   person. It neither extends nor breaks — the session is skipped.
//! - **Games before you joined do not count.** Also filtered out upstream.
//!
//! Saying "out", or never answering at all, breaks it. Those are the same thing
//! from the pitch's point of view.
//!
//! Ported from `shared/src/streak.ts`.

/// What a member did about one session that has already happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attendance {
    In,
    Waitlist,
    Missed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreakEntry {
    pub session_id: String,
    pub starts_at: String,
    pub attendance: Attendance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Streak {
    /// Consecutive games played, counting back from the most recent one.
    pub current: i64,
    /// The longest run ever, which is the one worth bragging about.
    pub best: i64,
    pub played: i64,
    /// Every game that happened while they were a member, cancelled ones and
    /// anything before they joined excluded. Waitlisted games are counted here
    /// even though the streak ignores them — "played 12 of 15" should not
    /// quietly shrink its own denominator.
    pub total: i64,
}

/// `entries` must be newest-first, which is the order the query returns and the
/// order the current streak has to be read in.
pub fn compute_streak(entries: &[StreakEntry]) -> Streak {
    let mut current = 0;
    let mut best = 0;
    let mut run = 0;
    let mut played = 0;
    // Only the leading run counts as "current", so stop growing it at the first
    // miss — but keep walking, because `best` may be further back.
    let mut current_is_live = true;

    for entry in entries {
        match entry.attendance {
            Attendance::Waitlist => continue,
            Attendance::In => {
                played += 1;
                run += 1;
                if current_is_live {
                    current += 1;
                }
                if run > best {
                    best = run;
                }
            }
            Attendance::Missed => {
                run = 0;
                current_is_live = false;
            }
        }
    }

    Streak { current, best, played, total: entries.len() as i64 }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `i` played, `w` had no room, `x` did not come — newest first, the way the
    /// query hands them over.
    fn entries(pattern: &str) -> Vec<StreakEntry> {
        pattern
            .chars()
            .enumerate()
            .map(|(n, c)| StreakEntry {
                session_id: format!("s{n}"),
                starts_at: format!("2026-08-{:02}T12:30:00.000Z", n + 1),
                attendance: match c {
                    'i' => Attendance::In,
                    'w' => Attendance::Waitlist,
                    _ => Attendance::Missed,
                },
            })
            .collect()
    }

    /// Every pattern up to four sessions long, plus longer ones that separate
    /// `current` from `best`, with the answers the TypeScript gives.
    ///
    /// (pattern, current, best, played, total)
    #[rustfmt::skip]
    const VECTORS: &[(&str, i64, i64, i64, i64)] = &[
        ("", 0, 0, 0, 0), ("i", 1, 1, 1, 1), ("ii", 2, 2, 2, 2), ("iii", 3, 3, 3, 3),
        ("iiii", 4, 4, 4, 4), ("iiiw", 3, 3, 3, 4), ("iiix", 3, 3, 3, 4), ("iiw", 2, 2, 2, 3),
        ("iiwi", 3, 3, 3, 4), ("iiww", 2, 2, 2, 4), ("iiwx", 2, 2, 2, 4), ("iix", 2, 2, 2, 3),
        ("iixi", 2, 2, 3, 4), ("iixw", 2, 2, 2, 4), ("iixx", 2, 2, 2, 4), ("iw", 1, 1, 1, 2),
        ("iwi", 2, 2, 2, 3), ("iwii", 3, 3, 3, 4), ("iwiw", 2, 2, 2, 4), ("iwix", 2, 2, 2, 4),
        ("iww", 1, 1, 1, 3), ("iwwi", 2, 2, 2, 4), ("iwww", 1, 1, 1, 4), ("iwwx", 1, 1, 1, 4),
        ("iwx", 1, 1, 1, 3), ("iwxi", 1, 1, 2, 4), ("iwxw", 1, 1, 1, 4), ("iwxx", 1, 1, 1, 4),
        ("ix", 1, 1, 1, 2), ("ixi", 1, 1, 2, 3), ("ixii", 1, 2, 3, 4), ("ixiw", 1, 1, 2, 4),
        ("ixix", 1, 1, 2, 4), ("ixw", 1, 1, 1, 3), ("ixwi", 1, 1, 2, 4), ("ixww", 1, 1, 1, 4),
        ("ixwx", 1, 1, 1, 4), ("ixx", 1, 1, 1, 3), ("ixxi", 1, 1, 2, 4), ("ixxw", 1, 1, 1, 4),
        ("ixxx", 1, 1, 1, 4), ("w", 0, 0, 0, 1), ("wi", 1, 1, 1, 2), ("wii", 2, 2, 2, 3),
        ("wiii", 3, 3, 3, 4), ("wiiw", 2, 2, 2, 4), ("wiix", 2, 2, 2, 4), ("wiw", 1, 1, 1, 3),
        ("wiwi", 2, 2, 2, 4), ("wiww", 1, 1, 1, 4), ("wiwx", 1, 1, 1, 4), ("wix", 1, 1, 1, 3),
        ("wixi", 1, 1, 2, 4), ("wixw", 1, 1, 1, 4), ("wixx", 1, 1, 1, 4), ("ww", 0, 0, 0, 2),
        ("wwi", 1, 1, 1, 3), ("wwii", 2, 2, 2, 4), ("wwiw", 1, 1, 1, 4), ("wwix", 1, 1, 1, 4),
        ("www", 0, 0, 0, 3), ("wwwi", 1, 1, 1, 4), ("wwww", 0, 0, 0, 4), ("wwwx", 0, 0, 0, 4),
        ("wwx", 0, 0, 0, 3), ("wwxi", 0, 1, 1, 4), ("wwxw", 0, 0, 0, 4), ("wwxx", 0, 0, 0, 4),
        ("wx", 0, 0, 0, 2), ("wxi", 0, 1, 1, 3), ("wxii", 0, 2, 2, 4), ("wxiw", 0, 1, 1, 4),
        ("wxix", 0, 1, 1, 4), ("wxw", 0, 0, 0, 3), ("wxwi", 0, 1, 1, 4), ("wxww", 0, 0, 0, 4),
        ("wxwx", 0, 0, 0, 4), ("wxx", 0, 0, 0, 3), ("wxxi", 0, 1, 1, 4), ("wxxw", 0, 0, 0, 4),
        ("wxxx", 0, 0, 0, 4), ("x", 0, 0, 0, 1), ("xi", 0, 1, 1, 2), ("xii", 0, 2, 2, 3),
        ("xiii", 0, 3, 3, 4), ("xiiw", 0, 2, 2, 4), ("xiix", 0, 2, 2, 4), ("xiw", 0, 1, 1, 3),
        ("xiwi", 0, 2, 2, 4), ("xiww", 0, 1, 1, 4), ("xiwx", 0, 1, 1, 4), ("xix", 0, 1, 1, 3),
        ("xixi", 0, 1, 2, 4), ("xixw", 0, 1, 1, 4), ("xixx", 0, 1, 1, 4), ("xw", 0, 0, 0, 2),
        ("xwi", 0, 1, 1, 3), ("xwii", 0, 2, 2, 4), ("xwiw", 0, 1, 1, 4), ("xwix", 0, 1, 1, 4),
        ("xww", 0, 0, 0, 3), ("xwwi", 0, 1, 1, 4), ("xwww", 0, 0, 0, 4), ("xwwx", 0, 0, 0, 4),
        ("xwx", 0, 0, 0, 3), ("xwxi", 0, 1, 1, 4), ("xwxw", 0, 0, 0, 4), ("xwxx", 0, 0, 0, 4),
        ("xx", 0, 0, 0, 2), ("xxi", 0, 1, 1, 3), ("xxii", 0, 2, 2, 4), ("xxiw", 0, 1, 1, 4),
        ("xxix", 0, 1, 1, 4), ("xxw", 0, 0, 0, 3), ("xxwi", 0, 1, 1, 4), ("xxww", 0, 0, 0, 4),
        ("xxwx", 0, 0, 0, 4), ("xxx", 0, 0, 0, 3), ("xxxi", 0, 1, 1, 4), ("xxxw", 0, 0, 0, 4),
        ("xxxx", 0, 0, 0, 4), ("iixii", 2, 2, 4, 5), ("iixiii", 2, 3, 5, 6),
        ("iixiiii", 2, 4, 6, 7), ("iwii", 3, 3, 3, 4), ("www", 0, 0, 0, 3),
        ("iwwwi", 2, 2, 2, 5), ("ixixi", 1, 1, 3, 5), ("xxx", 0, 0, 0, 3),
        ("xiii", 0, 3, 3, 4), ("iiiiiiii", 8, 8, 8, 8), ("wwwwwwww", 0, 0, 0, 8),
        ("iwxwiwxwi", 1, 1, 3, 9), ("xxiiiiixx", 0, 5, 5, 9), ("iixxxiiii", 2, 4, 6, 9),
        ("wiwiwiwiw", 4, 4, 4, 9),
    ];

    #[test]
    fn every_run_reads_the_way_the_original_reads_it() {
        for &(pattern, current, best, played, total) in VECTORS {
            let got = compute_streak(&entries(pattern));
            assert_eq!(got, Streak { current, best, played, total }, "pattern {pattern:?}");
        }
    }

    #[test]
    fn the_waitlist_neither_extends_nor_breaks_a_run() {
        // Three games played either side of a session there was no room in, and
        // the run reads as three.
        assert_eq!(compute_streak(&entries("iwii")).current, 3);
        // But the session still counts against the denominator.
        assert_eq!(compute_streak(&entries("iwii")).total, 4);
    }

    #[test]
    fn best_may_be_further_back_than_current() {
        let s = compute_streak(&entries("iixiiii"));
        assert_eq!(s.current, 2);
        assert_eq!(s.best, 4);
        assert_eq!(s.played, 6);
        assert_eq!(s.total, 7);
    }
}
