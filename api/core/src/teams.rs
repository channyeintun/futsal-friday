//! Splitting the people who turned up into sides.
//!
//! This happens at the pitch, in the two minutes between everybody arriving and
//! the first kick — so it is deliberately not an organizer's job. Whoever gets
//! their phone out first presses the button, and anybody may press it again:
//! the point of a random draw is that it is cheap to reject. A group that feels
//! a split was unfair reshuffles rather than argues, which only works if
//! reshuffling costs one tap and needs nobody's permission.
//!
//! Everything here is pure and takes its randomness as an argument, so the same
//! rules can be tested exactly and the server can hand in a real CSPRNG.
//!
//! Ported from `shared/src/teams.ts`, function for function. The draw is
//! reproduced deal for deal: the same `random` stream fed to the original and to
//! this gives the same sides, which is what makes a differential test possible
//! at all.

use std::collections::HashSet;

use crate::attendance::{arrived_guests, did_attend, Attends};
use crate::clock::SESSION_RUNS_FOR_MS;

/// What the teams are called. Letters rather than numbers so a team name never
/// reads as a score, and left untranslated — a bib is an A on any pitch.
pub const TEAM_LETTERS: [&str; 6] = ["A", "B", "C", "D", "E", "F"];

/// Two sides is a game; more than six and nobody gets a touch.
pub const MIN_TEAMS: i64 = 2;
pub const MAX_TEAMS: i64 = 6;

/// One body on the pitch.
///
/// `guest_index` is `0` for the member themselves and `1..=5` for the guests
/// they brought, which is what makes a party of three three separate slots
/// rather than one lump the draw has to keep together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamSlot {
    pub member_id: String,
    pub member_name: String,
    pub member_avatar_updated_at: Option<String>,
    pub guest_index: i64,
}

/// Who the draw deals out: a registration, plus who it belongs to.
///
/// A trait rather than a struct for the same reason `Attends` is one — the row
/// this is asked about is a full registration, and copying it into a narrower
/// shape just to deal it is how the teams and the bill start disagreeing about
/// who was there.
pub trait Candidate: Attends {
    fn member_id(&self) -> &str;
    fn member_name(&self) -> &str;
    fn member_avatar_updated_at(&self) -> Option<&str>;
}

/// Whether the board is still something to *do*, rather than something that
/// happened.
///
/// Open from the moment the fixture exists. It used to wait until half an hour
/// before kickoff, on the theory that picking sides is something you do
/// standing on the pitch — which is where it *ends*, not where it starts. A
/// group that wants to argue about the teams on Tuesday should be able to, and
/// hiding the board until Friday evening made the app useless for the part of
/// the week the argument actually happens in.
///
/// Nothing is lost by opening early: the draw deals from whoever is down as
/// playing, and `slots_missing_from` already tells the screen when people have
/// signed up since — so a Tuesday draw quietly asks to be reshuffled as the
/// roster fills, rather than going stale.
///
/// It closes two hours after kickoff, when everybody has gone home, and from
/// then on the board is a record: no shuffling, no confirming, no offer to
/// split teams for a game played weeks ago. `SESSION_RUNS_FOR_MS` is the same
/// window the cron uses to call a session finished, so the screen and the
/// schedule agree.
///
/// Deliberately measured off the clock rather than off `status`. Settling the
/// bill also completes a session, and that often happens while the last game is
/// still being scored — closing the board then would take it away mid-use.
pub fn team_board_live(starts_at_ms: i64, status: &str, now_ms: i64) -> bool {
    if status == "cancelled" {
        return false;
    }
    now_ms < starts_at_ms + SESSION_RUNS_FOR_MS
}

/// Every body that turned up, one slot each.
///
/// Built on the same presence rules as the bill, so the people being split into
/// teams are exactly the people being charged — a no-show is in neither, and a
/// reserve who stepped on for them is in both.
///
/// A member marked absent whose guests still came yields guest slots and no
/// member slot. That is not a curiosity: somebody drops out and sends a friend
/// in their place often enough that the model has to hold it.
pub fn arrived_slots<T: Candidate>(candidates: &[T]) -> Vec<TeamSlot> {
    let mut slots = Vec::new();

    for candidate in candidates {
        let slot = |guest_index: i64| TeamSlot {
            member_id: candidate.member_id().to_string(),
            member_name: candidate.member_name().to_string(),
            member_avatar_updated_at: candidate.member_avatar_updated_at().map(str::to_string),
            guest_index,
        };
        if did_attend(candidate) {
            slots.push(slot(0));
        }
        for guest in 1..=arrived_guests(candidate) {
            slots.push(slot(guest));
        }
    }

    slots
}

/// In-place Fisher-Yates, on a copy. Every ordering equally likely.
///
/// `random` must answer in `[0, 1)`, as `Math.random` does — the index is
/// pinned to the range the original's array bounds would have allowed anyway,
/// so a broken source of randomness cannot take a Worker down with it.
fn shuffled<T: Clone>(items: &[T], random: &mut dyn FnMut() -> f64) -> Vec<T> {
    let mut out = items.to_vec();
    let mut i = out.len();
    while i > 1 {
        i -= 1;
        let j = ((random() * (i + 1) as f64).floor() as usize).min(i);
        out.swap(i, j);
    }
    out
}

/// Deal people into teams.
///
/// Shuffle, then deal round-robin, so the sides differ in size by at most one —
/// which is the only fairness constraint a random draw can actually promise.
///
/// The teams are then shuffled *among themselves*, which is less pointless than
/// it looks. Round-robin dealing always puts the spare player on the team it
/// deals first, so with eleven players team A would be six-a-side every single
/// week. Permuting the labels afterwards moves that extra body around, and
/// leaves the assignment uniform over the balanced splits rather than uniform
/// with a systematic thumb on one side.
pub fn draw_teams(
    slots: &[TeamSlot],
    team_count: i64,
    random: &mut dyn FnMut() -> f64,
) -> Vec<Vec<TeamSlot>> {
    let count = team_count.max(1) as usize;
    let mut teams: Vec<Vec<TeamSlot>> = vec![Vec::new(); count];

    for (index, slot) in shuffled(slots, random).into_iter().enumerate() {
        teams[index % count].push(slot);
    }

    shuffled(&teams, random)
}

/// What the sides will come out as, before anybody commits to it.
///
/// The same arithmetic the draw performs, so "5 · 5" on the confirm step is a
/// promise rather than an estimate — a group deciding between two teams and
/// three can see that eleven players makes 4·4·3 and change their mind.
pub fn balanced_sizes(head_count: i64, team_count: i64) -> Vec<i64> {
    let count = team_count.max(1);
    // `Math.floor` of a quotient, not a truncation: the two only differ below
    // zero, and a head count is never negative, but the original said floor.
    let base = head_count.div_euclid(count);
    let spare = head_count % count;
    (0..count).map(|index| base + i64::from(index < spare)).collect()
}

/// Fold late arrivals into a board that already exists.
///
/// Registration stays open until kickoff and the board opens days before it, so
/// the ordinary case is teams settled on Tuesday and two more people signing up
/// on Thursday. Redrawing would answer that, but it is the wrong answer twice
/// over: it moves people who have already been told which side they are on, and
/// once the teams are confirmed it throws away the fixture list and every score
/// recorded against it.
///
/// So a latecomer is *added* rather than dealt. Each one goes to the smallest
/// side, which keeps the sides within one of each other exactly as the original
/// draw promised — and because it only ever appends, nobody already on a team
/// moves and no result is lost. That is also why it needs no permission beyond
/// membership: there is nothing here for anyone to object to.
///
/// Ties are broken at random rather than by index. Always filling team A first
/// would make the earliest side the one that absorbs every latecomer.
///
/// The answer is in shuffled order, not the order the newcomers arrived in.
pub fn assign_latecomers(
    teams: &[Vec<TeamSlot>],
    newcomers: &[TeamSlot],
    random: &mut dyn FnMut() -> f64,
) -> Vec<(TeamSlot, usize)> {
    if teams.is_empty() {
        return Vec::new();
    }

    let mut sizes: Vec<usize> = teams.iter().map(Vec::len).collect();
    let mut placed = Vec::new();

    for slot in shuffled(newcomers, random) {
        let smallest = *sizes.iter().min().expect("at least one team");
        let tied: Vec<usize> = (0..sizes.len()).filter(|&index| sizes[index] == smallest).collect();
        let pick = (random() * tied.len() as f64).floor() as usize;
        // The original indexes past the end onto `?? 0`; nothing reaches it
        // while `random` keeps to its range, but the fallback is the behaviour.
        let team = tied.get(pick).copied().unwrap_or(0);
        placed.push((slot, team));
        sizes[team] += 1;
    }

    placed
}

/// The most teams this many people can be split into and still field a side
/// each. Below the floor there is nothing to ask about.
pub fn max_teams_for(head_count: i64) -> i64 {
    MAX_TEAMS.min(head_count)
}

/// Whether it is worth offering the split at all.
pub fn can_split_into(head_count: i64, team_count: i64) -> bool {
    team_count >= MIN_TEAMS && team_count <= max_teams_for(head_count)
}

/// People who turned up after the last draw and are on nobody's team.
///
/// A stored draw does not follow the roster, which is what keeps the teams
/// still — so somebody arriving late is simply missing from it, and the screen
/// says so rather than quietly rearranging two groups of people who have
/// already started playing.
pub fn slots_missing_from(drawn: &[Vec<TeamSlot>], current: &[TeamSlot]) -> Vec<TeamSlot> {
    let taken: HashSet<String> = drawn.iter().flatten().map(slot_key).collect();
    current.iter().filter(|slot| !taken.contains(&slot_key(slot))).cloned().collect()
}

/// Identity of a slot: a member, or the nth guest they brought.
pub fn slot_key(slot: &TeamSlot) -> String {
    format!("{}:{}", slot.member_id, slot.guest_index)
}

// ---------------------------------------------------------------- fixtures --

/// Everyone plays everyone: the fixture list a confirmed draw produces.
///
/// Generated once, when the teams are settled, rather than assembled a match at
/// a time. The alternative is asking "who did you just play?" as people walk
/// off the pitch, which is the one moment nobody wants to answer a question and
/// — with three sides rotating for an hour — is the one question they will get
/// wrong. Every fixture exists up front, so finishing a game only ever means
/// putting a score against a line that is already there.
///
/// Pairs are ordered `(i, j)` with `i < j` and listed in that order. Two teams
/// is one fixture, three is three, four is six. Nobody plays themselves and no
/// pair appears twice.
pub fn round_robin(team_count: i64) -> Vec<(i64, i64)> {
    let mut pairs = Vec::new();
    for first in 0..team_count {
        for second in (first + 1)..team_count {
            pairs.push((first, second));
        }
    }
    pairs
}

/// The half of a fixture the table is read out of: who played whom, and what it
/// finished. Both goal fields are `None` until somebody puts a score up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TeamMatch {
    /// A position in the draw's `teams`, not a team id.
    pub first_team: i64,
    pub second_team: i64,
    pub first_goals: Option<i64>,
    pub second_goals: Option<i64>,
}

/// Whatever a fixture's result can be read out of.
///
/// The stored row carries an id, an ordinal and who recorded it; none of that
/// changes a scoreline, so the questions below take the trait and the row keeps
/// its own shape.
pub trait Scored {
    fn score(&self) -> TeamMatch;
}

impl Scored for TeamMatch {
    fn score(&self) -> TeamMatch {
        *self
    }
}

/// How one side's game went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchOutcome {
    Won,
    Drawn,
    Lost,
}

impl MatchOutcome {
    /// The wire spelling, which is what a history row is stored and rendered as.
    pub fn as_str(self) -> &'static str {
        match self {
            MatchOutcome::Won => "won",
            MatchOutcome::Drawn => "drawn",
            MatchOutcome::Lost => "lost",
        }
    }
}

/// A fixture with a score against it. Both halves or neither.
pub fn match_played<T: Scored + ?Sized>(match_: &T) -> bool {
    let m = match_.score();
    m.first_goals.is_some() && m.second_goals.is_some()
}

/// How one side's games went, in fixture order.
///
/// The sequence rather than the tally, because that is what a history row
/// wants: three marks in a line say "won, won, lost" — a shape you read without
/// reading — where "2W 1L" is a number you have to parse. Fixtures with no
/// score contribute nothing; a game not played is not a draw.
pub fn team_outcomes<T: Scored>(team: i64, matches: &[T]) -> Vec<MatchOutcome> {
    let mut outcomes = Vec::new();

    for match_ in matches {
        let m = match_.score();
        if !match_played(&m) {
            continue;
        }

        // A fixture where a side somehow plays itself resolves both halves
        // through the first branch, and so reads as a draw.
        let (mine, theirs) = if m.first_team == team {
            (m.first_goals, m.second_goals)
        } else if m.second_team == team {
            (m.second_goals, m.first_goals)
        } else {
            // Not this team's game.
            continue;
        };
        let (Some(mine), Some(theirs)) = (mine, theirs) else { continue };

        outcomes.push(if mine > theirs {
            MatchOutcome::Won
        } else if mine < theirs {
            MatchOutcome::Lost
        } else {
            MatchOutcome::Drawn
        });
    }

    outcomes
}

/// How one team's afternoon went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TeamRecord {
    pub played: i64,
    pub won: i64,
    pub drawn: i64,
    pub lost: i64,
    pub goals_for: i64,
    pub goals_against: i64,
}

/// Win, draw and loss counts per team, from the scorelines alone.
///
/// Derived rather than stored, so correcting a score an hour later corrects
/// everything that was said about it. A fixture with no score yet contributes
/// nothing — it is a game not played, not a nil-nil.
pub fn team_records<T: Scored>(team_count: i64, matches: &[T]) -> Vec<TeamRecord> {
    let mut records = vec![TeamRecord::default(); team_count.max(0) as usize];

    for match_ in matches {
        let m = match_.score();
        if !match_played(&m) {
            continue;
        }
        // A fixture naming a team the draw no longer has: skip rather than throw.
        let (Some(first), Some(second)) =
            (index_of(m.first_team, &records), index_of(m.second_team, &records))
        else {
            continue;
        };

        let for_first = m.first_goals.expect("played");
        let for_second = m.second_goals.expect("played");

        // Written in the original's order, which is load-bearing when a fixture
        // names the same side twice: both halves land on the one record, and it
        // finishes with two games played and the goals counted both ways.
        records[first].played += 1;
        records[second].played += 1;
        records[first].goals_for += for_first;
        records[first].goals_against += for_second;
        records[second].goals_for += for_second;
        records[second].goals_against += for_first;

        if for_first > for_second {
            records[first].won += 1;
            records[second].lost += 1;
        } else if for_first < for_second {
            records[first].lost += 1;
            records[second].won += 1;
        } else {
            records[first].drawn += 1;
            records[second].drawn += 1;
        }
    }

    records
}

/// A team number that actually names a record, the way a JavaScript index into
/// a short array either finds one or is `undefined`.
fn index_of(team: i64, records: &[TeamRecord]) -> Option<usize> {
    if team < 0 || team >= records.len() as i64 {
        return None;
    }
    Some(team as usize)
}

/// Whether this person may move people between teams.
///
/// Before the draw is confirmed, anybody — that is the whole point, and a group
/// that dislikes a split reshuffles rather than argues. Afterwards the teams are
/// bibs on people who have started playing, and results may already be recorded
/// against them, so only an organizer may pull it apart.
///
/// `confirmed_at` is `None` both when there is no draw at all and when there is
/// one nobody has confirmed; the original cannot tell those apart either, and
/// answers the same for both.
pub fn can_redraw_teams(confirmed_at: Option<&str>, is_organizer: bool) -> bool {
    confirmed_at.is_none() || is_organizer
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attendance::Status::{In, Waitlist};
    use crate::attendance::{total_arrived_heads, AttendanceInput, Status};

    /// One fixture list, each fixture `(first, second, first_goals, second_goals)`.
    type Fixtures = &'static [(i64, i64, Option<i64>, Option<i64>)];
    /// One registration, as `arrived_slots` reads it, and the slots it yields.
    type Presence = (Status, Option<i64>, Option<bool>, Option<i64>, &'static [i64]);
    /// One `(played, won, drawn, lost, goals_for, goals_against)` per team.
    type Table = &'static [(i64, i64, i64, i64, i64, i64)];

    /// mulberry32 — the generator the original's own test suite hands the draw.
    /// Written out in `u32` because every step of it is 32-bit integer work that
    /// JavaScript does through `Math.imul` and `>>> 0`.
    fn mulberry32(state: &mut u32) -> u32 {
        *state = state.wrapping_add(0x6d2b_79f5);
        let seed = *state;
        let mixed = (seed ^ (seed >> 15)).wrapping_mul(seed | 1);
        let folded = mixed ^ mixed.wrapping_add((mixed ^ (mixed >> 7)).wrapping_mul(mixed | 61));
        folded ^ (folded >> 14)
    }

    /// The same stream as a float in `[0, 1)`, which is what the draw asks for.
    fn seeded(seed: u32) -> impl FnMut() -> f64 {
        let mut state = seed;
        move || f64::from(mulberry32(&mut state)) / 4_294_967_296.0
    }

    /// A roster row, which is what the draw is actually dealt from.
    struct Row {
        id: &'static str,
        name: &'static str,
        avatar: Option<&'static str>,
        registration: AttendanceInput,
    }

    impl Attends for Row {
        fn attendance(&self) -> AttendanceInput {
            self.registration
        }
    }

    impl Candidate for Row {
        fn member_id(&self) -> &str {
            self.id
        }
        fn member_name(&self) -> &str {
            self.name
        }
        fn member_avatar_updated_at(&self) -> Option<&str> {
            self.avatar
        }
    }

    fn slot(id: &str, guest_index: i64) -> TeamSlot {
        TeamSlot {
            member_id: id.to_string(),
            member_name: format!("Player {id}"),
            member_avatar_updated_at: None,
            guest_index,
        }
    }

    /// Sides as `member,member|member` — the shape the vectors are written in.
    fn encode(teams: &[Vec<TeamSlot>]) -> String {
        teams
            .iter()
            .map(|team| team.iter().map(|s| s.member_id.clone()).collect::<Vec<_>>().join(","))
            .collect::<Vec<_>>()
            .join("|")
    }

    fn matches_of(fixtures: Fixtures) -> Vec<TeamMatch> {
        fixtures
            .iter()
            .map(|&(first_team, second_team, first_goals, second_goals)| TeamMatch {
                first_team,
                second_team,
                first_goals,
                second_goals,
            })
            .collect()
    }

    /// The generator the vectors below were drawn from — mulberry32, the
    /// same one the original's test suite uses. If this drifts, nothing else
    /// here means anything.
    #[rustfmt::skip]
    const RNG: &[(u32, [u32; 6])] = &[
        (0, [1144304738, 1416247, 958946056, 627933444, 2007157716, 2340967985]),
        (1, [2693262067, 11749833, 2265367787, 4213581821, 4159151403, 1207330352]),
        (7, [50271532, 266108690, 4195786334, 3002305430, 2239590375, 1741702388]),
        (42, [2581720956, 1925393290, 3661312704, 2876485805, 750819978, 2261697747]),
        (65535, [1608821784, 1603854095, 3647177647, 2714160345, 1758640262, 1292782129]),
        (2147483647, [1842962257, 546041740, 1654754255, 1702490205, 513796057, 4093909556]),
        (4294967295, [3850105811, 813802916, 3073704848, 4054706436, 3630262831, 2315588663]),
    ];

    /// Kickoff is 1786105800000 — 2026-08-07T12:30:00Z. (status, now - kickoff, live)
    #[rustfmt::skip]
    const BOARD: &[(&str, i64, bool)] = &[
        ("scheduled", -604800000, true), ("scheduled", -3600000, true), ("scheduled", 0, true),
        ("scheduled", 1, true), ("scheduled", 7199999, true), ("scheduled", 7200000, false),
        ("scheduled", 7200001, false), ("scheduled", 604800000, false),
        ("cancelled", -604800000, false), ("cancelled", -3600000, false),
        ("cancelled", 0, false), ("cancelled", 1, false), ("cancelled", 7199999, false),
        ("cancelled", 7200000, false), ("cancelled", 7200001, false),
        ("cancelled", 604800000, false), ("completed", -604800000, true),
        ("completed", -3600000, true), ("completed", 0, true), ("completed", 1, true),
        ("completed", 7199999, true), ("completed", 7200000, false),
        ("completed", 7200001, false), ("completed", 604800000, false),
    ];

    /// (status, guests, attended, guests_arrived, the guest_index of each slot)
    #[rustfmt::skip]
    const SLOTS: &[Presence] = &[
        (In, None, None, None, &[0]), (In, None, None, Some(0), &[0]),
        (In, None, None, Some(1), &[0]), (In, None, None, Some(4), &[0]),
        (In, None, Some(true), None, &[0]), (In, None, Some(true), Some(0), &[0]),
        (In, None, Some(true), Some(1), &[0]), (In, None, Some(true), Some(4), &[0]),
        (In, None, Some(false), None, &[]), (In, None, Some(false), Some(0), &[]),
        (In, None, Some(false), Some(1), &[]), (In, None, Some(false), Some(4), &[]),
        (In, Some(2), None, None, &[0, 1, 2]), (In, Some(2), None, Some(0), &[0]),
        (In, Some(2), None, Some(1), &[0, 1]), (In, Some(2), None, Some(4), &[0, 1, 2]),
        (In, Some(2), Some(true), None, &[0, 1, 2]), (In, Some(2), Some(true), Some(0), &[0]),
        (In, Some(2), Some(true), Some(1), &[0, 1]),
        (In, Some(2), Some(true), Some(4), &[0, 1, 2]), (In, Some(2), Some(false), None, &[]),
        (In, Some(2), Some(false), Some(0), &[]), (In, Some(2), Some(false), Some(1), &[1]),
        (In, Some(2), Some(false), Some(4), &[1, 2]),
        (In, Some(5), None, None, &[0, 1, 2, 3, 4, 5]), (In, Some(5), None, Some(0), &[0]),
        (In, Some(5), None, Some(1), &[0, 1]), (In, Some(5), None, Some(4), &[0, 1, 2, 3, 4]),
        (In, Some(5), Some(true), None, &[0, 1, 2, 3, 4, 5]),
        (In, Some(5), Some(true), Some(0), &[0]), (In, Some(5), Some(true), Some(1), &[0, 1]),
        (In, Some(5), Some(true), Some(4), &[0, 1, 2, 3, 4]),
        (In, Some(5), Some(false), None, &[]), (In, Some(5), Some(false), Some(0), &[]),
        (In, Some(5), Some(false), Some(1), &[1]),
        (In, Some(5), Some(false), Some(4), &[1, 2, 3, 4]), (Waitlist, None, None, None, &[]),
        (Waitlist, None, None, Some(0), &[]), (Waitlist, None, None, Some(1), &[]),
        (Waitlist, None, None, Some(4), &[]), (Waitlist, None, Some(true), None, &[0]),
        (Waitlist, None, Some(true), Some(0), &[0]),
        (Waitlist, None, Some(true), Some(1), &[0]),
        (Waitlist, None, Some(true), Some(4), &[0]), (Waitlist, None, Some(false), None, &[]),
        (Waitlist, None, Some(false), Some(0), &[]),
        (Waitlist, None, Some(false), Some(1), &[]),
        (Waitlist, None, Some(false), Some(4), &[]), (Waitlist, Some(2), None, None, &[]),
        (Waitlist, Some(2), None, Some(0), &[]), (Waitlist, Some(2), None, Some(1), &[1]),
        (Waitlist, Some(2), None, Some(4), &[1, 2]),
        (Waitlist, Some(2), Some(true), None, &[0, 1, 2]),
        (Waitlist, Some(2), Some(true), Some(0), &[0]),
        (Waitlist, Some(2), Some(true), Some(1), &[0, 1]),
        (Waitlist, Some(2), Some(true), Some(4), &[0, 1, 2]),
        (Waitlist, Some(2), Some(false), None, &[]),
        (Waitlist, Some(2), Some(false), Some(0), &[]),
        (Waitlist, Some(2), Some(false), Some(1), &[1]),
        (Waitlist, Some(2), Some(false), Some(4), &[1, 2]),
        (Waitlist, Some(5), None, None, &[]), (Waitlist, Some(5), None, Some(0), &[]),
        (Waitlist, Some(5), None, Some(1), &[1]),
        (Waitlist, Some(5), None, Some(4), &[1, 2, 3, 4]),
        (Waitlist, Some(5), Some(true), None, &[0, 1, 2, 3, 4, 5]),
        (Waitlist, Some(5), Some(true), Some(0), &[0]),
        (Waitlist, Some(5), Some(true), Some(1), &[0, 1]),
        (Waitlist, Some(5), Some(true), Some(4), &[0, 1, 2, 3, 4]),
        (Waitlist, Some(5), Some(false), None, &[]),
        (Waitlist, Some(5), Some(false), Some(0), &[]),
        (Waitlist, Some(5), Some(false), Some(1), &[1]),
        (Waitlist, Some(5), Some(false), Some(4), &[1, 2, 3, 4]),
    ];

    /// (seed, team_count, heads, the sides as `|`-separated member numbers)
    #[rustfmt::skip]
    const DRAW: &[(u32, i64, usize, &str)] = &[
        (1, -1, 0, ""), (2, -1, 0, ""), (1, 1, 0, ""), (2, 1, 0, ""), (1, 2, 0, "|"),
        (2, 2, 0, "|"), (1, 3, 0, "||"), (2, 3, 0, "||"), (1, 6, 0, "|||||"),
        (2, 6, 0, "|||||"), (1, -1, 1, "0"), (2, -1, 1, "0"), (1, 1, 1, "0"), (2, 1, 1, "0"),
        (1, 2, 1, "0|"), (2, 2, 1, "0|"), (1, 3, 1, "|0|"), (2, 3, 1, "|0|"),
        (1, 6, 1, "||||0|"), (2, 6, 1, "0|||||"), (1, -1, 5, "4,2,1,0,3"),
        (2, -1, 5, "2,4,0,1,3"), (1, 1, 5, "4,2,1,0,3"), (2, 1, 5, "2,4,0,1,3"),
        (1, 2, 5, "4,1,3|2,0"), (2, 2, 5, "2,0,3|4,1"), (1, 3, 5, "2,3|4,0|1"),
        (2, 3, 5, "2,1|4,3|0"), (1, 6, 5, "3|4|0|1|2|"), (2, 6, 5, "2|0|3|4|1|"),
        (1, -1, 7, "1,5,6,3,2,0,4"), (2, -1, 7, "0,4,3,2,6,1,5"), (1, 1, 7, "1,5,6,3,2,0,4"),
        (2, 1, 7, "0,4,3,2,6,1,5"), (1, 2, 7, "1,6,2,4|5,3,0"), (2, 2, 7, "4,2,1|0,3,6,5"),
        (1, 3, 7, "1,3,4|6,0|5,2"), (2, 3, 7, "3,1|0,2,5|4,6"), (1, 6, 7, "2|1,4|6|5|0|3"),
        (2, 6, 7, "1|6|0,5|2|4|3"), (1, -1, 11, "9,8,5,2,3,1,10,7,4,0,6"),
        (2, -1, 11, "5,0,7,1,10,9,6,4,2,3,8"), (1, 1, 11, "9,8,5,2,3,1,10,7,4,0,6"),
        (2, 1, 11, "5,0,7,1,10,9,6,4,2,3,8"), (1, 2, 11, "8,2,1,7,0|9,5,3,10,4,6"),
        (2, 2, 11, "5,7,10,6,2,8|0,1,9,4,3"), (1, 3, 11, "5,1,4|9,2,10,0|8,3,7,6"),
        (2, 3, 11, "0,10,4,8|5,1,6,3|7,9,2"), (1, 6, 11, "3,6|2,0|8,7|9,10|1|5,4"),
        (2, 6, 11, "5,6|1,3|7,2|9|0,4|10,8"), (1, -1, 12, "4,10,2,6,9,3,1,11,8,5,0,7"),
        (2, -1, 12, "5,6,0,10,1,9,11,7,4,2,3,8"), (1, 1, 12, "4,10,2,6,9,3,1,11,8,5,0,7"),
        (2, 1, 12, "5,6,0,10,1,9,11,7,4,2,3,8"), (1, 2, 12, "10,6,3,11,5,7|4,2,9,1,8,0"),
        (2, 2, 12, "6,10,9,7,2,8|5,0,1,11,4,3"), (1, 3, 12, "2,3,8,7|4,6,1,5|10,9,11,0"),
        (2, 3, 12, "6,1,7,3|0,9,4,8|5,10,11,2"), (1, 6, 12, "6,5|3,7|9,0|10,11|4,1|2,8"),
        (2, 6, 12, "1,3|5,11|9,8|10,2|0,4|6,7"),
    ];

    /// (head_count, team_count, the sides the confirm step promises)
    #[rustfmt::skip]
    const SIZES: &[(i64, i64, &[i64])] = &[
        (-5, -2, &[-5]), (-5, 0, &[-5]), (-5, 1, &[-5]), (-5, 2, &[-3, -3]),
        (-5, 3, &[-2, -2, -2]), (-5, 4, &[-2, -2, -2, -2]), (-5, 5, &[-1, -1, -1, -1, -1]),
        (-5, 6, &[-1, -1, -1, -1, -1, -1]), (0, -2, &[0]), (0, 0, &[0]), (0, 1, &[0]),
        (0, 2, &[0, 0]), (0, 3, &[0, 0, 0]), (0, 4, &[0, 0, 0, 0]), (0, 5, &[0, 0, 0, 0, 0]),
        (0, 6, &[0, 0, 0, 0, 0, 0]), (1, -2, &[1]), (1, 0, &[1]), (1, 1, &[1]), (1, 2, &[1, 0]),
        (1, 3, &[1, 0, 0]), (1, 4, &[1, 0, 0, 0]), (1, 5, &[1, 0, 0, 0, 0]),
        (1, 6, &[1, 0, 0, 0, 0, 0]), (2, -2, &[2]), (2, 0, &[2]), (2, 1, &[2]), (2, 2, &[1, 1]),
        (2, 3, &[1, 1, 0]), (2, 4, &[1, 1, 0, 0]), (2, 5, &[1, 1, 0, 0, 0]),
        (2, 6, &[1, 1, 0, 0, 0, 0]), (7, -2, &[7]), (7, 0, &[7]), (7, 1, &[7]), (7, 2, &[4, 3]),
        (7, 3, &[3, 2, 2]), (7, 4, &[2, 2, 2, 1]), (7, 5, &[2, 2, 1, 1, 1]),
        (7, 6, &[2, 1, 1, 1, 1, 1]), (11, -2, &[11]), (11, 0, &[11]), (11, 1, &[11]),
        (11, 2, &[6, 5]), (11, 3, &[4, 4, 3]), (11, 4, &[3, 3, 3, 2]),
        (11, 5, &[3, 2, 2, 2, 2]), (11, 6, &[2, 2, 2, 2, 2, 1]), (12, -2, &[12]),
        (12, 0, &[12]), (12, 1, &[12]), (12, 2, &[6, 6]), (12, 3, &[4, 4, 4]),
        (12, 4, &[3, 3, 3, 3]), (12, 5, &[3, 3, 2, 2, 2]), (12, 6, &[2, 2, 2, 2, 2, 2]),
        (23, -2, &[23]), (23, 0, &[23]), (23, 1, &[23]), (23, 2, &[12, 11]),
        (23, 3, &[8, 8, 7]), (23, 4, &[6, 6, 6, 5]), (23, 5, &[5, 5, 5, 4, 4]),
        (23, 6, &[4, 4, 4, 4, 4, 3]),
    ];

    /// (seed, the sides already dealt, how many turned up late, `newcomer:team`
    /// in the order they came back out)
    #[rustfmt::skip]
    const LATE: &[(u32, &[usize], usize, &str)] = &[
        (1, &[], 0, ""), (2, &[], 0, ""), (1, &[], 1, ""), (2, &[], 1, ""), (1, &[], 2, ""),
        (2, &[], 2, ""), (1, &[], 5, ""), (2, &[], 5, ""), (1, &[0], 0, ""), (2, &[0], 0, ""),
        (1, &[0], 1, "0:0"), (2, &[0], 1, "0:0"), (1, &[0], 2, "0:0,1:0"),
        (2, &[0], 2, "0:0,1:0"), (1, &[0], 5, "4:0,2:0,1:0,0:0,3:0"),
        (2, &[0], 5, "2:0,4:0,0:0,1:0,3:0"), (1, &[5, 2], 0, ""), (2, &[5, 2], 0, ""),
        (1, &[5, 2], 1, "0:1"), (2, &[5, 2], 1, "0:1"), (1, &[5, 2], 2, "0:1,1:1"),
        (2, &[5, 2], 2, "0:1,1:1"), (1, &[5, 2], 5, "4:1,2:1,1:1,0:1,3:0"),
        (2, &[5, 2], 5, "2:1,4:1,0:1,1:0,3:1"), (1, &[3, 3], 0, ""), (2, &[3, 3], 0, ""),
        (1, &[3, 3], 1, "0:1"), (2, &[3, 3], 1, "0:1"), (1, &[3, 3], 2, "0:0,1:1"),
        (2, &[3, 3], 2, "0:0,1:1"), (1, &[3, 3], 5, "4:1,2:0,1:1,0:0,3:0"),
        (2, &[3, 3], 5, "2:1,4:0,0:0,1:1,3:1"), (1, &[1, 4, 2], 0, ""), (2, &[1, 4, 2], 0, ""),
        (1, &[1, 4, 2], 1, "0:0"), (2, &[1, 4, 2], 1, "0:0"), (1, &[1, 4, 2], 2, "0:0,1:2"),
        (2, &[1, 4, 2], 2, "0:0,1:0"), (1, &[1, 4, 2], 5, "4:0,2:0,1:2,0:2,3:0"),
        (2, &[1, 4, 2], 5, "2:0,4:2,0:0,1:0,3:2"), (1, &[3, 3, 3], 0, ""),
        (2, &[3, 3, 3], 0, ""), (1, &[3, 3, 3], 1, "0:1"), (2, &[3, 3, 3], 1, "0:2"),
        (1, &[3, 3, 3], 2, "0:0,1:2"), (2, &[3, 3, 3], 2, "0:0,1:1"),
        (1, &[3, 3, 3], 5, "4:2,2:0,1:1,0:2,3:0"), (2, &[3, 3, 3], 5, "2:2,4:1,0:0,1:1,3:2"),
    ];

    /// (head_count, max_teams_for, can_split_into for team counts -1..=7)
    #[rustfmt::skip]
    const SPLIT: &[(i64, i64, &[bool; 9])] = &[
        (-2, -2, &[false, false, false, false, false, false, false, false, false]),
        (0, 0, &[false, false, false, false, false, false, false, false, false]),
        (1, 1, &[false, false, false, false, false, false, false, false, false]),
        (2, 2, &[false, false, false, true, false, false, false, false, false]),
        (3, 3, &[false, false, false, true, true, false, false, false, false]),
        (5, 5, &[false, false, false, true, true, true, true, false, false]),
        (6, 6, &[false, false, false, true, true, true, true, true, false]),
        (7, 6, &[false, false, false, true, true, true, true, true, false]),
        (10, 6, &[false, false, false, true, true, true, true, true, false]),
        (40, 6, &[false, false, false, true, true, true, true, true, false]),
    ];

    #[rustfmt::skip]
    const ROUND_ROBIN: &[(i64, &[(i64, i64)])] = &[
        (-1, &[]), (0, &[]), (1, &[]), (2, &[(0, 1)]), (3, &[(0, 1), (0, 2), (1, 2)]),
        (4, &[(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)]),
        (5, &[(0, 1), (0, 2), (0, 3), (0, 4), (1, 2), (1, 3), (1, 4), (2, 3), (2, 4), (3, 4)]),
        (6, &[(0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (1, 2), (1, 3), (1, 4), (1, 5), (2, 3), (2, 4), (2, 5), (3, 4), (3, 5), (4, 5)]),
        (7, &[(0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (0, 6), (1, 2), (1, 3), (1, 4), (1, 5), (1, 6), (2, 3), (2, 4), (2, 5), (2, 6), (3, 4), (3, 5), (3, 6), (4, 5), (4, 6), (5, 6)]),
    ];

    #[rustfmt::skip]
    const PLAYED: &[(Option<i64>, Option<i64>, bool)] = &[
        (None, None, false), (None, Some(0), false), (None, Some(3), false),
        (None, Some(30), false), (Some(0), None, false), (Some(0), Some(0), true),
        (Some(0), Some(3), true), (Some(0), Some(30), true), (Some(3), None, false),
        (Some(3), Some(0), true), (Some(3), Some(3), true), (Some(3), Some(30), true),
        (Some(30), None, false), (Some(30), Some(0), true), (Some(30), Some(3), true),
        (Some(30), Some(30), true),
    ];

    /// The fixture lists the two tables below index into, each fixture
    /// `(first_team, second_team, first_goals, second_goals)`.
    #[rustfmt::skip]
    const FIXTURES: &[Fixtures] = &[
        &[], &[(0, 1, Some(4), Some(2)), (0, 2, Some(1), Some(1)), (1, 2, Some(0), Some(3))],
        &[(0, 1, None, None), (0, 1, Some(2), Some(1))], &[(0, 1, Some(0), Some(0))],
        &[(0, 1, Some(3), None)], &[(0, 1, None, Some(3))],
        &[(1, 2, Some(5), Some(0)), (0, 2, Some(0), Some(1))], &[(0, 4, Some(3), Some(1))],
        &[(0, 0, Some(2), Some(2))], &[(1, 1, Some(4), Some(1))], &[(-1, 0, Some(1), Some(0))],
        &[(5, 9, Some(1), Some(0))],
        &[(2, 0, Some(1), Some(0)), (0, 1, Some(0), Some(0)), (1, 2, Some(2), Some(7)), (0, 2, None, None)],
    ];

    /// (which fixture list, which team, the run of results it came out with)
    #[rustfmt::skip]
    const OUTCOMES: &[(usize, i64, &str)] = &[
        (0, -1, ""), (0, 0, ""), (0, 1, ""), (0, 2, ""), (0, 3, ""), (0, 4, ""), (1, -1, ""),
        (1, 0, "won,drawn"), (1, 1, "lost,lost"), (1, 2, "drawn,won"), (1, 3, ""), (1, 4, ""),
        (2, -1, ""), (2, 0, "won"), (2, 1, "lost"), (2, 2, ""), (2, 3, ""), (2, 4, ""),
        (3, -1, ""), (3, 0, "drawn"), (3, 1, "drawn"), (3, 2, ""), (3, 3, ""), (3, 4, ""),
        (4, -1, ""), (4, 0, ""), (4, 1, ""), (4, 2, ""), (4, 3, ""), (4, 4, ""), (5, -1, ""),
        (5, 0, ""), (5, 1, ""), (5, 2, ""), (5, 3, ""), (5, 4, ""), (6, -1, ""), (6, 0, "lost"),
        (6, 1, "won"), (6, 2, "lost,won"), (6, 3, ""), (6, 4, ""), (7, -1, ""), (7, 0, "won"),
        (7, 1, ""), (7, 2, ""), (7, 3, ""), (7, 4, "lost"), (8, -1, ""), (8, 0, "drawn"),
        (8, 1, ""), (8, 2, ""), (8, 3, ""), (8, 4, ""), (9, -1, ""), (9, 0, ""), (9, 1, "won"),
        (9, 2, ""), (9, 3, ""), (9, 4, ""), (10, -1, "won"), (10, 0, "lost"), (10, 1, ""),
        (10, 2, ""), (10, 3, ""), (10, 4, ""), (11, -1, ""), (11, 0, ""), (11, 1, ""),
        (11, 2, ""), (11, 3, ""), (11, 4, ""), (12, -1, ""), (12, 0, "lost,drawn"),
        (12, 1, "drawn,lost"), (12, 2, "won,won"), (12, 3, ""), (12, 4, ""),
    ];

    /// (which fixture list, team_count, one
    /// (played, won, drawn, lost, goals_for, goals_against) per team)
    #[rustfmt::skip]
    const RECORDS: &[(usize, i64, Table)] = &[
        (0, -1, &[]), (0, 0, &[]), (0, 2, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (0, 3, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (0, 5, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (1, -1, &[]), (1, 0, &[]), (1, 2, &[(1, 1, 0, 0, 4, 2), (1, 0, 0, 1, 2, 4)]),
        (1, 3, &[(2, 1, 1, 0, 5, 3), (2, 0, 0, 2, 2, 7), (2, 1, 1, 0, 4, 1)]),
        (1, 5, &[(2, 1, 1, 0, 5, 3), (2, 0, 0, 2, 2, 7), (2, 1, 1, 0, 4, 1), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (2, -1, &[]), (2, 0, &[]), (2, 2, &[(1, 1, 0, 0, 2, 1), (1, 0, 0, 1, 1, 2)]),
        (2, 3, &[(1, 1, 0, 0, 2, 1), (1, 0, 0, 1, 1, 2), (0, 0, 0, 0, 0, 0)]),
        (2, 5, &[(1, 1, 0, 0, 2, 1), (1, 0, 0, 1, 1, 2), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (3, -1, &[]), (3, 0, &[]), (3, 2, &[(1, 0, 1, 0, 0, 0), (1, 0, 1, 0, 0, 0)]),
        (3, 3, &[(1, 0, 1, 0, 0, 0), (1, 0, 1, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (3, 5, &[(1, 0, 1, 0, 0, 0), (1, 0, 1, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (4, -1, &[]), (4, 0, &[]), (4, 2, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (4, 3, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (4, 5, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (5, -1, &[]), (5, 0, &[]), (5, 2, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (5, 3, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (5, 5, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (6, -1, &[]), (6, 0, &[]), (6, 2, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (6, 3, &[(1, 0, 0, 1, 0, 1), (1, 1, 0, 0, 5, 0), (2, 1, 0, 1, 1, 5)]),
        (6, 5, &[(1, 0, 0, 1, 0, 1), (1, 1, 0, 0, 5, 0), (2, 1, 0, 1, 1, 5), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (7, -1, &[]), (7, 0, &[]), (7, 2, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (7, 3, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (7, 5, &[(1, 1, 0, 0, 3, 1), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (1, 0, 0, 1, 1, 3)]),
        (8, -1, &[]), (8, 0, &[]), (8, 2, &[(2, 0, 2, 0, 4, 4), (0, 0, 0, 0, 0, 0)]),
        (8, 3, &[(2, 0, 2, 0, 4, 4), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (8, 5, &[(2, 0, 2, 0, 4, 4), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (9, -1, &[]), (9, 0, &[]), (9, 2, &[(0, 0, 0, 0, 0, 0), (2, 1, 0, 1, 5, 5)]),
        (9, 3, &[(0, 0, 0, 0, 0, 0), (2, 1, 0, 1, 5, 5), (0, 0, 0, 0, 0, 0)]),
        (9, 5, &[(0, 0, 0, 0, 0, 0), (2, 1, 0, 1, 5, 5), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (10, -1, &[]), (10, 0, &[]), (10, 2, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (10, 3, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (10, 5, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (11, -1, &[]), (11, 0, &[]), (11, 2, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (11, 3, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (11, 5, &[(0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
        (12, -1, &[]), (12, 0, &[]), (12, 2, &[(1, 0, 1, 0, 0, 0), (1, 0, 1, 0, 0, 0)]),
        (12, 3, &[(2, 0, 1, 1, 0, 1), (2, 0, 1, 1, 2, 7), (2, 2, 0, 0, 8, 2)]),
        (12, 5, &[(2, 0, 1, 1, 0, 1), (2, 0, 1, 1, 2, 7), (2, 2, 0, 0, 8, 2), (0, 0, 0, 0, 0, 0), (0, 0, 0, 0, 0, 0)]),
    ];

    #[rustfmt::skip]
    const KEYS: &[(&str, i64, &str)] = &[
        ("a", 0, "a:0"), ("mem_x", 5, "mem_x:5"), ("ကျော်", 3, "ကျော်:3"), ("", 0, ":0"),
        ("a:b", 1, "a:b:1"),
    ];

    /// (how many of the pool the stored draw holds, over how many sides, the
    /// slots the roster has that the draw does not)
    #[rustfmt::skip]
    const MISSING: &[(usize, usize, &str)] = &[
        (0, 1, "a:0,a:1,a:2,b:0,ကျော်:0,c:0,c:1"), (0, 2, "a:0,a:1,a:2,b:0,ကျော်:0,c:0,c:1"),
        (0, 3, "a:0,a:1,a:2,b:0,ကျော်:0,c:0,c:1"), (1, 1, "a:1,a:2,b:0,ကျော်:0,c:0,c:1"),
        (1, 2, "a:1,a:2,b:0,ကျော်:0,c:0,c:1"), (1, 3, "a:1,a:2,b:0,ကျော်:0,c:0,c:1"),
        (2, 1, "a:2,b:0,ကျော်:0,c:0,c:1"), (2, 2, "a:2,b:0,ကျော်:0,c:0,c:1"),
        (2, 3, "a:2,b:0,ကျော်:0,c:0,c:1"), (3, 1, "b:0,ကျော်:0,c:0,c:1"),
        (3, 2, "b:0,ကျော်:0,c:0,c:1"), (3, 3, "b:0,ကျော်:0,c:0,c:1"), (4, 1, "ကျော်:0,c:0,c:1"),
        (4, 2, "ကျော်:0,c:0,c:1"), (4, 3, "ကျော်:0,c:0,c:1"), (5, 1, "c:0,c:1"),
        (5, 2, "c:0,c:1"), (5, 3, "c:0,c:1"), (6, 1, "c:1"), (6, 2, "c:1"), (6, 3, "c:1"),
        (7, 1, ""), (7, 2, ""), (7, 3, ""),
    ];

    /// (confirmed_at, is_organizer, may reshuffle). The first two rows are the
    /// two ways the original spells "not confirmed" — no draw, and an
    /// unconfirmed one — which it answers identically.
    #[rustfmt::skip]
    const REDRAW: &[(Option<&str>, bool, bool)] = &[
        (None, false, true), (None, true, true), (None, false, true), (None, true, true),
        (Some("2026-08-07T12:40:00.000Z"), false, false),
        (Some("2026-08-07T12:40:00.000Z"), true, true),
    ];

    #[test]
    fn the_generator_the_vectors_were_drawn_from_still_draws_them() {
        for &(seed, expected) in RNG {
            let mut state = seed;
            let drawn: Vec<u32> = (0..6).map(|_| mulberry32(&mut state)).collect();
            assert_eq!(drawn, expected, "seed {seed}");
        }
        // And the float form stays inside the range the draw's index arithmetic
        // assumes, for every one of those.
        for &(seed, _) in RNG {
            let mut random = seeded(seed);
            for _ in 0..64 {
                let value = random();
                assert!((0.0..1.0).contains(&value), "seed {seed} answered {value}");
            }
        }
    }

    #[test]
    fn the_board_is_live_until_two_hours_after_kickoff() {
        let kickoff = 1_786_105_800_000; // 2026-08-07T12:30:00Z
        for &(status, delta, live) in BOARD {
            assert_eq!(
                team_board_live(kickoff, status, kickoff + delta),
                live,
                "{status} at kickoff{delta:+}"
            );
        }
    }

    #[test]
    fn one_slot_per_body_that_turned_up() {
        for &(status, guests, attended, guests_arrived, expected) in SLOTS {
            let row = Row {
                id: "m",
                name: "Aung",
                avatar: None,
                registration: AttendanceInput { status, guests, attended, guests_arrived },
            };
            let slots = arrived_slots(std::slice::from_ref(&row));
            let indexes: Vec<i64> = slots.iter().map(|s| s.guest_index).collect();
            assert_eq!(indexes, expected, "{:?}", row.registration);
            // The bill and the teams are divided between the same bodies.
            assert_eq!(slots.len() as i64, total_arrived_heads(std::slice::from_ref(&row)));
        }
    }

    #[test]
    fn a_roster_deals_out_in_order_carrying_each_name_and_avatar() {
        let roster = vec![
            Row {
                id: "a",
                name: "Aung",
                avatar: Some("2026-08-01T00:00:00.000Z"),
                registration: AttendanceInput {
                    status: In,
                    guests: Some(2),
                    attended: None,
                    guests_arrived: None,
                },
            },
            Row { id: "b", name: "Bo", avatar: None, registration: AttendanceInput::new(In) },
            Row {
                id: "c",
                name: "Chit",
                avatar: None,
                registration: AttendanceInput {
                    status: In,
                    guests: None,
                    attended: Some(false),
                    guests_arrived: None,
                },
            },
            Row {
                id: "d",
                name: "Zaw",
                avatar: None,
                registration: AttendanceInput::new(Waitlist),
            },
            Row {
                id: "e",
                name: "ကျော်",
                avatar: None,
                // Dropped out and sent a friend: guests, and no member slot.
                registration: AttendanceInput {
                    status: In,
                    guests: Some(1),
                    attended: Some(false),
                    guests_arrived: Some(1),
                },
            },
        ];

        let slots = arrived_slots(&roster);
        let keys: Vec<String> = slots.iter().map(slot_key).collect();
        assert_eq!(keys, ["a:0", "a:1", "a:2", "b:0", "e:1"]);
        assert_eq!(slots[0].member_name, "Aung");
        assert_eq!(slots[1].member_avatar_updated_at.as_deref(), Some("2026-08-01T00:00:00.000Z"));
        assert_eq!(slots[3].member_avatar_updated_at, None);
        assert_eq!(slots.len() as i64, total_arrived_heads(&roster));
    }

    #[test]
    fn the_draw_deals_what_the_original_deals() {
        for &(seed, team_count, heads, expected) in DRAW {
            let slots: Vec<TeamSlot> = (0..heads).map(|n| slot(&n.to_string(), 0)).collect();
            let teams = draw_teams(&slots, team_count, &mut seeded(seed));
            assert_eq!(encode(&teams), expected, "seed {seed}, {team_count} teams, {heads} heads");
        }
    }

    #[test]
    fn every_body_is_dealt_once_and_the_sides_come_out_level() {
        for heads in 0..=24usize {
            let slots: Vec<TeamSlot> = (0..heads).map(|n| slot(&n.to_string(), 0)).collect();
            for team_count in 1..=6 {
                for seed in 1..=40 {
                    let teams = draw_teams(&slots, team_count, &mut seeded(seed));
                    assert_eq!(teams.len(), team_count as usize);

                    let mut dealt: Vec<String> =
                        teams.iter().flatten().map(|s| s.member_id.clone()).collect();
                    dealt.sort();
                    dealt.dedup();
                    assert_eq!(
                        dealt.len(),
                        heads,
                        "{heads} heads, {team_count} teams, seed {seed}"
                    );

                    // The labels are shuffled after the deal, so the sides are
                    // the promised sizes in some order — never other sizes.
                    let mut sizes: Vec<i64> = teams.iter().map(|t| t.len() as i64).collect();
                    let spread = sizes.iter().max().unwrap() - sizes.iter().min().unwrap();
                    assert!(spread <= 1, "{sizes:?} for {heads} heads over {team_count} teams");
                    let mut promised = balanced_sizes(heads as i64, team_count);
                    sizes.sort_unstable();
                    promised.sort_unstable();
                    assert_eq!(sizes, promised, "{heads} heads over {team_count}, seed {seed}");
                }
            }
        }
    }

    /// The second shuffle is the whole reason `draw_teams` shuffles twice: with
    /// eleven players and two sides, round-robin dealing would make team A the
    /// six every single week.
    #[test]
    fn the_spare_player_does_not_always_land_on_team_a() {
        let slots: Vec<TeamSlot> = (0..11).map(|n| slot(&n.to_string(), 0)).collect();
        let mut seen_five = false;
        let mut seen_six = false;
        for seed in 1..=200 {
            let teams = draw_teams(&slots, 2, &mut seeded(seed));
            match teams[0].len() {
                5 => seen_five = true,
                6 => seen_six = true,
                other => panic!("eleven over two gave a side of {other}"),
            }
        }
        assert!(seen_five && seen_six);
    }

    #[test]
    fn the_sides_promised_are_the_sides_dealt() {
        for &(head_count, team_count, expected) in SIZES {
            assert_eq!(
                balanced_sizes(head_count, team_count),
                expected,
                "{head_count} heads over {team_count}"
            );
        }
    }

    #[test]
    fn latecomers_are_added_to_the_smallest_side() {
        for &(seed, sizes, late, expected) in LATE {
            let board: Vec<Vec<TeamSlot>> = sizes
                .iter()
                .enumerate()
                .map(|(team, &size)| (0..size).map(|n| slot(&format!("t{team}{n}"), 0)).collect())
                .collect();
            let newcomers: Vec<TeamSlot> = (0..late).map(|n| slot(&format!("l{n}"), 0)).collect();

            let placed = assign_latecomers(&board, &newcomers, &mut seeded(seed));
            let answer = placed
                .iter()
                .map(|(newcomer, team)| format!("{}:{team}", &newcomer.member_id[1..]))
                .collect::<Vec<_>>()
                .join(",");
            assert_eq!(answer, expected, "seed {seed} onto {sizes:?} with {late} late");
        }
    }

    #[test]
    fn nobody_already_placed_moves_and_the_sides_stay_within_one() {
        for a in 0..=6usize {
            for b in 0..=6usize {
                for late in 1..=5usize {
                    for seed in 1..=12 {
                        let board = vec![
                            (0..a).map(|n| slot(&format!("a{n}"), 0)).collect::<Vec<_>>(),
                            (0..b).map(|n| slot(&format!("b{n}"), 0)).collect::<Vec<_>>(),
                        ];
                        let newcomers: Vec<TeamSlot> =
                            (0..late).map(|n| slot(&format!("l{n}"), 0)).collect();
                        let placed = assign_latecomers(&board, &newcomers, &mut seeded(seed));

                        assert_eq!(placed.len(), late);
                        let mut who: Vec<&str> =
                            placed.iter().map(|(s, _)| s.member_id.as_str()).collect();
                        who.sort();
                        who.dedup();
                        assert_eq!(who.len(), late, "somebody was placed twice");

                        let mut sizes = [a, b];
                        for (_, team) in &placed {
                            assert!(*team < 2);
                            sizes[*team] += 1;
                        }
                        let spread = sizes[0].abs_diff(sizes[1]);
                        assert!(spread <= a.abs_diff(b).max(1), "{sizes:?} from {a}/{b}");
                    }
                }
            }
        }
    }

    #[test]
    fn a_board_with_no_sides_places_nobody() {
        let newcomers = vec![slot("l0", 0), slot("l1", 0)];
        assert!(assign_latecomers(&[], &newcomers, &mut seeded(1)).is_empty());
        assert!(assign_latecomers(&[vec![], vec![]], &[], &mut seeded(1)).is_empty());
    }

    #[test]
    fn how_many_sides_this_many_people_make() {
        for &(head_count, max_teams, can_split) in SPLIT {
            assert_eq!(max_teams_for(head_count), max_teams, "{head_count} heads");
            for (offset, &expected) in can_split.iter().enumerate() {
                let team_count = offset as i64 - 1;
                assert_eq!(
                    can_split_into(head_count, team_count),
                    expected,
                    "{head_count} heads into {team_count}"
                );
            }
        }
    }

    #[test]
    fn everyone_plays_everyone_once_low_side_first() {
        for &(team_count, expected) in ROUND_ROBIN {
            assert_eq!(round_robin(team_count), expected, "{team_count} teams");
        }
    }

    #[test]
    fn the_slots_a_stored_draw_has_not_heard_of() {
        let pool: Vec<TeamSlot> =
            [("a", 0), ("a", 1), ("a", 2), ("b", 0), ("ကျော်", 0), ("c", 0), ("c", 1)]
                .iter()
                .map(|&(id, guest_index)| slot(id, guest_index))
                .collect();

        for &(cut, team_count, expected) in MISSING {
            let mut drawn: Vec<Vec<TeamSlot>> = vec![Vec::new(); team_count];
            for (index, slot) in pool[..cut].iter().enumerate() {
                drawn[index % team_count].push(slot.clone());
            }
            let missing = slots_missing_from(&drawn, &pool)
                .iter()
                .map(slot_key)
                .collect::<Vec<_>>()
                .join(",");
            assert_eq!(missing, expected, "{cut} of the pool over {team_count} sides");
        }

        for &(member_id, guest_index, expected) in KEYS {
            assert_eq!(slot_key(&slot(member_id, guest_index)), expected);
        }
    }

    #[test]
    fn both_halves_of_a_score_or_neither() {
        for &(first_goals, second_goals, expected) in PLAYED {
            let fixture = TeamMatch { first_team: 0, second_team: 1, first_goals, second_goals };
            assert_eq!(match_played(&fixture), expected, "{fixture:?}");
        }
    }

    #[test]
    fn a_teams_afternoon_reads_in_fixture_order() {
        for &(fixtures, team, expected) in OUTCOMES {
            let matches = matches_of(FIXTURES[fixtures]);
            let run = team_outcomes(team, &matches)
                .iter()
                .map(|outcome| outcome.as_str())
                .collect::<Vec<_>>()
                .join(",");
            assert_eq!(run, expected, "team {team} of fixture list {fixtures}");
        }
    }

    #[test]
    fn the_table_is_derived_from_the_scorelines_alone() {
        for &(fixtures, team_count, expected) in RECORDS {
            let matches = matches_of(FIXTURES[fixtures]);
            let records: Vec<(i64, i64, i64, i64, i64, i64)> = team_records(team_count, &matches)
                .iter()
                .map(|r| (r.played, r.won, r.drawn, r.lost, r.goals_for, r.goals_against))
                .collect();
            assert_eq!(records, expected, "{team_count} teams of fixture list {fixtures}");
        }
    }

    /// The run and the tally are two readings of the same scorelines, so on a
    /// fixture list the draw actually produced they are not allowed to disagree.
    ///
    /// Only on such a list: a fixture naming a side the draw does not have is
    /// skipped by the table and still counted by the run, and one naming the
    /// same side twice lands on the one record twice. Both are the original's
    /// answers, and both are pinned by the vectors above rather than here.
    #[test]
    fn the_run_and_the_tally_say_the_same_thing() {
        for team_count in 2..=6 {
            let fixtures = round_robin(team_count);
            let matches: Vec<TeamMatch> = fixtures
                .iter()
                .enumerate()
                .map(|(ordinal, &(first_team, second_team))| TeamMatch {
                    first_team,
                    second_team,
                    first_goals: Some(ordinal as i64 % 4),
                    second_goals: Some((ordinal as i64 + 1) % 3),
                })
                .collect();

            let records = team_records(team_count, &matches);
            assert_eq!(records.len(), team_count as usize);
            for (team, record) in records.iter().enumerate() {
                let run = team_outcomes(team as i64, &matches);
                let count = |wanted: MatchOutcome| {
                    run.iter().filter(|&&outcome| outcome == wanted).count() as i64
                };
                assert_eq!(count(MatchOutcome::Won), record.won, "team {team} of {team_count}");
                assert_eq!(count(MatchOutcome::Drawn), record.drawn, "team {team}");
                assert_eq!(count(MatchOutcome::Lost), record.lost, "team {team}");
                assert_eq!(run.len() as i64, record.played, "team {team}");
            }
            // Every game counts for two sides, and every goal is somebody's for
            // and somebody else's against.
            assert_eq!(records.iter().map(|r| r.played).sum::<i64>(), 2 * fixtures.len() as i64);
            assert_eq!(
                records.iter().map(|r| r.goals_for).sum::<i64>(),
                records.iter().map(|r| r.goals_against).sum::<i64>()
            );
        }
    }

    #[test]
    fn a_confirmed_draw_is_the_organizers_to_pull_apart() {
        for &(confirmed_at, is_organizer, expected) in REDRAW {
            assert_eq!(can_redraw_teams(confirmed_at, is_organizer), expected);
        }
    }

    #[test]
    fn the_sides_are_lettered() {
        assert_eq!(TEAM_LETTERS, ["A", "B", "C", "D", "E", "F"]);
        assert_eq!(TEAM_LETTERS.len() as i64, MAX_TEAMS);
        assert_eq!(MIN_TEAMS, 2);
    }
}
