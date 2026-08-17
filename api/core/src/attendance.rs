//! Who actually played.
//!
//! Registering is a promise; arriving is what the pitch bill is divided by. The
//! two used to be the same field, so a no-show was charged a full share — which
//! meant everybody who did play was under-charged by exactly that much — and
//! their streak survived a game they never came to.
//!
//! Every rule about presence lives here rather than in SQL, because the split,
//! the streak, the roster and the chat summary all have to agree about it. A
//! `WHERE` clause that answers this question in one route and not the others is
//! how the two facts drifted apart in the first place.
//!
//! Ported from `shared/src/attendance.ts`, function for function.

/// What they said before the game.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    In,
    Waitlist,
}

/// The registration fields presence depends on. Anything wider is noise here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttendanceInput {
    pub status: Status,
    /// Guests they registered.
    pub guests: Option<i64>,
    /// `None` when nobody has marked it, else an explicit answer.
    pub attended: Option<bool>,
    /// `None` means "as registered", not zero.
    pub guests_arrived: Option<i64>,
}

impl AttendanceInput {
    /// A registration nobody has marked and who brought nobody.
    pub fn new(status: Status) -> Self {
        Self { status, guests: None, attended: None, guests_arrived: None }
    }
}

/// Whatever a registration's presence can be read out of.
///
/// The rows these questions get asked about carry far more than presence — a
/// name, an avatar, a position in the queue — and copying them into an
/// `AttendanceInput` just to count heads is how the roster and the bill start
/// disagreeing. Implement this on the row instead and the answer is the same
/// one everywhere.
pub trait Attends {
    fn attendance(&self) -> AttendanceInput;
}

impl Attends for AttendanceInput {
    fn attendance(&self) -> AttendanceInput {
        *self
    }
}

/// Did this person play?
///
/// Unmarked is a *presumption*, not a default value, and it differs by status:
/// somebody who was in is presumed to have turned up, somebody on the waitlist
/// is presumed not to have. An explicit mark beats both — including the case
/// worth spelling out, a reserve who played because somebody else silently
/// failed to show and so was never promoted off the waitlist.
pub fn did_attend<T: Attends + ?Sized>(reg: &T) -> bool {
    let reg = reg.attendance();
    match reg.attended {
        Some(attended) => attended,
        None => reg.status == Status::In,
    }
}

/// How many people this registration is charged for — themselves plus whichever
/// guests turned up.
///
/// A no-show's party is worth nothing regardless of what they registered:
/// guests arrive *with* the member who vouched for them, so if that member is
/// marked absent the guests are too, unless somebody has said otherwise by
/// setting `guests_arrived` explicitly.
pub fn arrived_heads<T: Attends + ?Sized>(reg: &T) -> i64 {
    let reg = reg.attendance();
    let registered = reg.guests.unwrap_or(0).max(0);
    let present = did_attend(&reg);

    let guests = match reg.guests_arrived {
        Some(arrived) => arrived.min(registered).max(0),
        None if present => registered,
        None => 0,
    };

    i64::from(present) + guests
}

/// Just the guests out of that party, for the number snapshotted onto the
/// charge. Derived from `arrived_heads` rather than computed alongside it, so
/// the two can never disagree about the same registration.
pub fn arrived_guests<T: Attends + ?Sized>(reg: &T) -> i64 {
    arrived_heads(reg) - i64::from(did_attend(reg))
}

/// Everyone the bill should be divided between, in the order they were given.
pub fn arrived_only<T: Attends>(regs: &[T]) -> Vec<&T> {
    regs.iter().filter(|r| arrived_heads(*r) > 0).collect()
}

/// Total heads on the pitch, for the suggested charge and the player count.
pub fn total_arrived_heads<T: Attends>(regs: &[T]) -> i64 {
    regs.iter().map(|r| arrived_heads(r)).sum()
}

/// Whether the roster has been checked at all.
///
/// The point of keeping "unmarked" distinguishable from "confirmed present" is
/// so the settle screen can say whether anybody has actually looked, rather
/// than presenting a presumption as a headcount.
pub fn attendance_checked<T: Attends>(regs: &[T]) -> bool {
    regs.iter().any(|r| {
        let reg = r.attendance();
        reg.attended.is_some() || reg.guests_arrived.is_some()
    })
}

/// What the organiser is likely to charge: the standing per-person fee times
/// the number of heads that turned up.
///
/// A suggestion, never the bill. The pitch is rented by the hour, so the total
/// is the real constraint and the fee is only what the group normally expects
/// to pay each — the settle form prefills this and lets it be overwritten.
/// Returns `None` when there is no standing fee to multiply.
///
/// The original rounds the fee before multiplying; a dong is already the
/// smallest unit there is, so here there is nothing left to round.
pub fn suggested_total<T: Attends>(fee_per_person: Option<i64>, regs: &[T]) -> Option<i64> {
    let fee = fee_per_person?;
    if fee <= 0 {
        return None;
    }
    let heads = total_arrived_heads(regs);
    if heads > 0 {
        Some(fee * heads)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::Status::{In, Waitlist};
    use super::*;

    /// A roster row, which is what these questions actually get asked about.
    struct Row {
        id: &'static str,
        reg: AttendanceInput,
    }

    impl Attends for Row {
        fn attendance(&self) -> AttendanceInput {
            self.reg
        }
    }

    fn row(
        id: &'static str,
        status: Status,
        guests: Option<i64>,
        attended: Option<bool>,
        guests_arrived: Option<i64>,
    ) -> Row {
        Row { id, reg: AttendanceInput { status, guests, attended, guests_arrived } }
    }

    fn ids(rows: &[&Row]) -> Vec<&'static str> {
        rows.iter().map(|r| r.id).collect()
    }

    /// Every combination of the four fields, with the answers the TypeScript
    /// gives. `None` covers both `null` and an absent field — the original was
    /// run with each and agrees on all 252 rows.
    ///
    /// (status, guests, attended, guests_arrived, did_attend, arrived_heads, arrived_guests)
    #[rustfmt::skip]
    const VECTORS: &[(Status, Option<i64>, Option<bool>, Option<i64>, bool, i64, i64)] = &[
        (In, None, None, None, true, 1, 0), (In, None, None, Some(-3), true, 1, 0),
        (In, None, None, Some(0), true, 1, 0), (In, None, None, Some(1), true, 1, 0),
        (In, None, None, Some(2), true, 1, 0), (In, None, None, Some(4), true, 1, 0),
        (In, None, None, Some(7), true, 1, 0), (In, None, Some(true), None, true, 1, 0),
        (In, None, Some(true), Some(-3), true, 1, 0),
        (In, None, Some(true), Some(0), true, 1, 0), (In, None, Some(true), Some(1), true, 1, 0),
        (In, None, Some(true), Some(2), true, 1, 0), (In, None, Some(true), Some(4), true, 1, 0),
        (In, None, Some(true), Some(7), true, 1, 0), (In, None, Some(false), None, false, 0, 0),
        (In, None, Some(false), Some(-3), false, 0, 0),
        (In, None, Some(false), Some(0), false, 0, 0),
        (In, None, Some(false), Some(1), false, 0, 0),
        (In, None, Some(false), Some(2), false, 0, 0),
        (In, None, Some(false), Some(4), false, 0, 0),
        (In, None, Some(false), Some(7), false, 0, 0), (In, Some(-3), None, None, true, 1, 0),
        (In, Some(-3), None, Some(-3), true, 1, 0), (In, Some(-3), None, Some(0), true, 1, 0),
        (In, Some(-3), None, Some(1), true, 1, 0), (In, Some(-3), None, Some(2), true, 1, 0),
        (In, Some(-3), None, Some(4), true, 1, 0), (In, Some(-3), None, Some(7), true, 1, 0),
        (In, Some(-3), Some(true), None, true, 1, 0),
        (In, Some(-3), Some(true), Some(-3), true, 1, 0),
        (In, Some(-3), Some(true), Some(0), true, 1, 0),
        (In, Some(-3), Some(true), Some(1), true, 1, 0),
        (In, Some(-3), Some(true), Some(2), true, 1, 0),
        (In, Some(-3), Some(true), Some(4), true, 1, 0),
        (In, Some(-3), Some(true), Some(7), true, 1, 0),
        (In, Some(-3), Some(false), None, false, 0, 0),
        (In, Some(-3), Some(false), Some(-3), false, 0, 0),
        (In, Some(-3), Some(false), Some(0), false, 0, 0),
        (In, Some(-3), Some(false), Some(1), false, 0, 0),
        (In, Some(-3), Some(false), Some(2), false, 0, 0),
        (In, Some(-3), Some(false), Some(4), false, 0, 0),
        (In, Some(-3), Some(false), Some(7), false, 0, 0), (In, Some(0), None, None, true, 1, 0),
        (In, Some(0), None, Some(-3), true, 1, 0), (In, Some(0), None, Some(0), true, 1, 0),
        (In, Some(0), None, Some(1), true, 1, 0), (In, Some(0), None, Some(2), true, 1, 0),
        (In, Some(0), None, Some(4), true, 1, 0), (In, Some(0), None, Some(7), true, 1, 0),
        (In, Some(0), Some(true), None, true, 1, 0),
        (In, Some(0), Some(true), Some(-3), true, 1, 0),
        (In, Some(0), Some(true), Some(0), true, 1, 0),
        (In, Some(0), Some(true), Some(1), true, 1, 0),
        (In, Some(0), Some(true), Some(2), true, 1, 0),
        (In, Some(0), Some(true), Some(4), true, 1, 0),
        (In, Some(0), Some(true), Some(7), true, 1, 0),
        (In, Some(0), Some(false), None, false, 0, 0),
        (In, Some(0), Some(false), Some(-3), false, 0, 0),
        (In, Some(0), Some(false), Some(0), false, 0, 0),
        (In, Some(0), Some(false), Some(1), false, 0, 0),
        (In, Some(0), Some(false), Some(2), false, 0, 0),
        (In, Some(0), Some(false), Some(4), false, 0, 0),
        (In, Some(0), Some(false), Some(7), false, 0, 0), (In, Some(1), None, None, true, 2, 1),
        (In, Some(1), None, Some(-3), true, 1, 0), (In, Some(1), None, Some(0), true, 1, 0),
        (In, Some(1), None, Some(1), true, 2, 1), (In, Some(1), None, Some(2), true, 2, 1),
        (In, Some(1), None, Some(4), true, 2, 1), (In, Some(1), None, Some(7), true, 2, 1),
        (In, Some(1), Some(true), None, true, 2, 1),
        (In, Some(1), Some(true), Some(-3), true, 1, 0),
        (In, Some(1), Some(true), Some(0), true, 1, 0),
        (In, Some(1), Some(true), Some(1), true, 2, 1),
        (In, Some(1), Some(true), Some(2), true, 2, 1),
        (In, Some(1), Some(true), Some(4), true, 2, 1),
        (In, Some(1), Some(true), Some(7), true, 2, 1),
        (In, Some(1), Some(false), None, false, 0, 0),
        (In, Some(1), Some(false), Some(-3), false, 0, 0),
        (In, Some(1), Some(false), Some(0), false, 0, 0),
        (In, Some(1), Some(false), Some(1), false, 1, 1),
        (In, Some(1), Some(false), Some(2), false, 1, 1),
        (In, Some(1), Some(false), Some(4), false, 1, 1),
        (In, Some(1), Some(false), Some(7), false, 1, 1), (In, Some(2), None, None, true, 3, 2),
        (In, Some(2), None, Some(-3), true, 1, 0), (In, Some(2), None, Some(0), true, 1, 0),
        (In, Some(2), None, Some(1), true, 2, 1), (In, Some(2), None, Some(2), true, 3, 2),
        (In, Some(2), None, Some(4), true, 3, 2), (In, Some(2), None, Some(7), true, 3, 2),
        (In, Some(2), Some(true), None, true, 3, 2),
        (In, Some(2), Some(true), Some(-3), true, 1, 0),
        (In, Some(2), Some(true), Some(0), true, 1, 0),
        (In, Some(2), Some(true), Some(1), true, 2, 1),
        (In, Some(2), Some(true), Some(2), true, 3, 2),
        (In, Some(2), Some(true), Some(4), true, 3, 2),
        (In, Some(2), Some(true), Some(7), true, 3, 2),
        (In, Some(2), Some(false), None, false, 0, 0),
        (In, Some(2), Some(false), Some(-3), false, 0, 0),
        (In, Some(2), Some(false), Some(0), false, 0, 0),
        (In, Some(2), Some(false), Some(1), false, 1, 1),
        (In, Some(2), Some(false), Some(2), false, 2, 2),
        (In, Some(2), Some(false), Some(4), false, 2, 2),
        (In, Some(2), Some(false), Some(7), false, 2, 2), (In, Some(5), None, None, true, 6, 5),
        (In, Some(5), None, Some(-3), true, 1, 0), (In, Some(5), None, Some(0), true, 1, 0),
        (In, Some(5), None, Some(1), true, 2, 1), (In, Some(5), None, Some(2), true, 3, 2),
        (In, Some(5), None, Some(4), true, 5, 4), (In, Some(5), None, Some(7), true, 6, 5),
        (In, Some(5), Some(true), None, true, 6, 5),
        (In, Some(5), Some(true), Some(-3), true, 1, 0),
        (In, Some(5), Some(true), Some(0), true, 1, 0),
        (In, Some(5), Some(true), Some(1), true, 2, 1),
        (In, Some(5), Some(true), Some(2), true, 3, 2),
        (In, Some(5), Some(true), Some(4), true, 5, 4),
        (In, Some(5), Some(true), Some(7), true, 6, 5),
        (In, Some(5), Some(false), None, false, 0, 0),
        (In, Some(5), Some(false), Some(-3), false, 0, 0),
        (In, Some(5), Some(false), Some(0), false, 0, 0),
        (In, Some(5), Some(false), Some(1), false, 1, 1),
        (In, Some(5), Some(false), Some(2), false, 2, 2),
        (In, Some(5), Some(false), Some(4), false, 4, 4),
        (In, Some(5), Some(false), Some(7), false, 5, 5),
        (Waitlist, None, None, None, false, 0, 0), (Waitlist, None, None, Some(-3), false, 0, 0),
        (Waitlist, None, None, Some(0), false, 0, 0),
        (Waitlist, None, None, Some(1), false, 0, 0),
        (Waitlist, None, None, Some(2), false, 0, 0),
        (Waitlist, None, None, Some(4), false, 0, 0),
        (Waitlist, None, None, Some(7), false, 0, 0),
        (Waitlist, None, Some(true), None, true, 1, 0),
        (Waitlist, None, Some(true), Some(-3), true, 1, 0),
        (Waitlist, None, Some(true), Some(0), true, 1, 0),
        (Waitlist, None, Some(true), Some(1), true, 1, 0),
        (Waitlist, None, Some(true), Some(2), true, 1, 0),
        (Waitlist, None, Some(true), Some(4), true, 1, 0),
        (Waitlist, None, Some(true), Some(7), true, 1, 0),
        (Waitlist, None, Some(false), None, false, 0, 0),
        (Waitlist, None, Some(false), Some(-3), false, 0, 0),
        (Waitlist, None, Some(false), Some(0), false, 0, 0),
        (Waitlist, None, Some(false), Some(1), false, 0, 0),
        (Waitlist, None, Some(false), Some(2), false, 0, 0),
        (Waitlist, None, Some(false), Some(4), false, 0, 0),
        (Waitlist, None, Some(false), Some(7), false, 0, 0),
        (Waitlist, Some(-3), None, None, false, 0, 0),
        (Waitlist, Some(-3), None, Some(-3), false, 0, 0),
        (Waitlist, Some(-3), None, Some(0), false, 0, 0),
        (Waitlist, Some(-3), None, Some(1), false, 0, 0),
        (Waitlist, Some(-3), None, Some(2), false, 0, 0),
        (Waitlist, Some(-3), None, Some(4), false, 0, 0),
        (Waitlist, Some(-3), None, Some(7), false, 0, 0),
        (Waitlist, Some(-3), Some(true), None, true, 1, 0),
        (Waitlist, Some(-3), Some(true), Some(-3), true, 1, 0),
        (Waitlist, Some(-3), Some(true), Some(0), true, 1, 0),
        (Waitlist, Some(-3), Some(true), Some(1), true, 1, 0),
        (Waitlist, Some(-3), Some(true), Some(2), true, 1, 0),
        (Waitlist, Some(-3), Some(true), Some(4), true, 1, 0),
        (Waitlist, Some(-3), Some(true), Some(7), true, 1, 0),
        (Waitlist, Some(-3), Some(false), None, false, 0, 0),
        (Waitlist, Some(-3), Some(false), Some(-3), false, 0, 0),
        (Waitlist, Some(-3), Some(false), Some(0), false, 0, 0),
        (Waitlist, Some(-3), Some(false), Some(1), false, 0, 0),
        (Waitlist, Some(-3), Some(false), Some(2), false, 0, 0),
        (Waitlist, Some(-3), Some(false), Some(4), false, 0, 0),
        (Waitlist, Some(-3), Some(false), Some(7), false, 0, 0),
        (Waitlist, Some(0), None, None, false, 0, 0),
        (Waitlist, Some(0), None, Some(-3), false, 0, 0),
        (Waitlist, Some(0), None, Some(0), false, 0, 0),
        (Waitlist, Some(0), None, Some(1), false, 0, 0),
        (Waitlist, Some(0), None, Some(2), false, 0, 0),
        (Waitlist, Some(0), None, Some(4), false, 0, 0),
        (Waitlist, Some(0), None, Some(7), false, 0, 0),
        (Waitlist, Some(0), Some(true), None, true, 1, 0),
        (Waitlist, Some(0), Some(true), Some(-3), true, 1, 0),
        (Waitlist, Some(0), Some(true), Some(0), true, 1, 0),
        (Waitlist, Some(0), Some(true), Some(1), true, 1, 0),
        (Waitlist, Some(0), Some(true), Some(2), true, 1, 0),
        (Waitlist, Some(0), Some(true), Some(4), true, 1, 0),
        (Waitlist, Some(0), Some(true), Some(7), true, 1, 0),
        (Waitlist, Some(0), Some(false), None, false, 0, 0),
        (Waitlist, Some(0), Some(false), Some(-3), false, 0, 0),
        (Waitlist, Some(0), Some(false), Some(0), false, 0, 0),
        (Waitlist, Some(0), Some(false), Some(1), false, 0, 0),
        (Waitlist, Some(0), Some(false), Some(2), false, 0, 0),
        (Waitlist, Some(0), Some(false), Some(4), false, 0, 0),
        (Waitlist, Some(0), Some(false), Some(7), false, 0, 0),
        (Waitlist, Some(1), None, None, false, 0, 0),
        (Waitlist, Some(1), None, Some(-3), false, 0, 0),
        (Waitlist, Some(1), None, Some(0), false, 0, 0),
        (Waitlist, Some(1), None, Some(1), false, 1, 1),
        (Waitlist, Some(1), None, Some(2), false, 1, 1),
        (Waitlist, Some(1), None, Some(4), false, 1, 1),
        (Waitlist, Some(1), None, Some(7), false, 1, 1),
        (Waitlist, Some(1), Some(true), None, true, 2, 1),
        (Waitlist, Some(1), Some(true), Some(-3), true, 1, 0),
        (Waitlist, Some(1), Some(true), Some(0), true, 1, 0),
        (Waitlist, Some(1), Some(true), Some(1), true, 2, 1),
        (Waitlist, Some(1), Some(true), Some(2), true, 2, 1),
        (Waitlist, Some(1), Some(true), Some(4), true, 2, 1),
        (Waitlist, Some(1), Some(true), Some(7), true, 2, 1),
        (Waitlist, Some(1), Some(false), None, false, 0, 0),
        (Waitlist, Some(1), Some(false), Some(-3), false, 0, 0),
        (Waitlist, Some(1), Some(false), Some(0), false, 0, 0),
        (Waitlist, Some(1), Some(false), Some(1), false, 1, 1),
        (Waitlist, Some(1), Some(false), Some(2), false, 1, 1),
        (Waitlist, Some(1), Some(false), Some(4), false, 1, 1),
        (Waitlist, Some(1), Some(false), Some(7), false, 1, 1),
        (Waitlist, Some(2), None, None, false, 0, 0),
        (Waitlist, Some(2), None, Some(-3), false, 0, 0),
        (Waitlist, Some(2), None, Some(0), false, 0, 0),
        (Waitlist, Some(2), None, Some(1), false, 1, 1),
        (Waitlist, Some(2), None, Some(2), false, 2, 2),
        (Waitlist, Some(2), None, Some(4), false, 2, 2),
        (Waitlist, Some(2), None, Some(7), false, 2, 2),
        (Waitlist, Some(2), Some(true), None, true, 3, 2),
        (Waitlist, Some(2), Some(true), Some(-3), true, 1, 0),
        (Waitlist, Some(2), Some(true), Some(0), true, 1, 0),
        (Waitlist, Some(2), Some(true), Some(1), true, 2, 1),
        (Waitlist, Some(2), Some(true), Some(2), true, 3, 2),
        (Waitlist, Some(2), Some(true), Some(4), true, 3, 2),
        (Waitlist, Some(2), Some(true), Some(7), true, 3, 2),
        (Waitlist, Some(2), Some(false), None, false, 0, 0),
        (Waitlist, Some(2), Some(false), Some(-3), false, 0, 0),
        (Waitlist, Some(2), Some(false), Some(0), false, 0, 0),
        (Waitlist, Some(2), Some(false), Some(1), false, 1, 1),
        (Waitlist, Some(2), Some(false), Some(2), false, 2, 2),
        (Waitlist, Some(2), Some(false), Some(4), false, 2, 2),
        (Waitlist, Some(2), Some(false), Some(7), false, 2, 2),
        (Waitlist, Some(5), None, None, false, 0, 0),
        (Waitlist, Some(5), None, Some(-3), false, 0, 0),
        (Waitlist, Some(5), None, Some(0), false, 0, 0),
        (Waitlist, Some(5), None, Some(1), false, 1, 1),
        (Waitlist, Some(5), None, Some(2), false, 2, 2),
        (Waitlist, Some(5), None, Some(4), false, 4, 4),
        (Waitlist, Some(5), None, Some(7), false, 5, 5),
        (Waitlist, Some(5), Some(true), None, true, 6, 5),
        (Waitlist, Some(5), Some(true), Some(-3), true, 1, 0),
        (Waitlist, Some(5), Some(true), Some(0), true, 1, 0),
        (Waitlist, Some(5), Some(true), Some(1), true, 2, 1),
        (Waitlist, Some(5), Some(true), Some(2), true, 3, 2),
        (Waitlist, Some(5), Some(true), Some(4), true, 5, 4),
        (Waitlist, Some(5), Some(true), Some(7), true, 6, 5),
        (Waitlist, Some(5), Some(false), None, false, 0, 0),
        (Waitlist, Some(5), Some(false), Some(-3), false, 0, 0),
        (Waitlist, Some(5), Some(false), Some(0), false, 0, 0),
        (Waitlist, Some(5), Some(false), Some(1), false, 1, 1),
        (Waitlist, Some(5), Some(false), Some(2), false, 2, 2),
        (Waitlist, Some(5), Some(false), Some(4), false, 4, 4),
        (Waitlist, Some(5), Some(false), Some(7), false, 5, 5),
    ];

    #[test]
    fn every_combination_answers_what_the_original_answers() {
        assert_eq!(VECTORS.len(), 252);
        for &(status, guests, attended, guests_arrived, did, heads, guest_heads) in VECTORS {
            let reg = AttendanceInput { status, guests, attended, guests_arrived };
            assert_eq!(did_attend(&reg), did, "did_attend {reg:?}");
            assert_eq!(arrived_heads(&reg), heads, "arrived_heads {reg:?}");
            assert_eq!(arrived_guests(&reg), guest_heads, "arrived_guests {reg:?}");
        }
    }

    /// The roster from the spec: `a` in, `b` in with two guests, `c` in but
    /// marked absent, `d` on the waitlist, `e` on the waitlist but marked
    /// present.
    fn spec_roster() -> Vec<Row> {
        vec![
            row("a", In, None, None, None),
            row("b", In, Some(2), None, None),
            row("c", In, None, Some(false), None),
            row("d", Waitlist, None, None, None),
            row("e", Waitlist, None, Some(true), None),
        ]
    }

    #[test]
    fn the_bill_is_divided_between_the_people_who_turned_up() {
        let roster = spec_roster();
        assert_eq!(ids(&arrived_only(&roster)), ["a", "b", "e"]);
        assert_eq!(total_arrived_heads(&roster), 5);
        assert!(attendance_checked(&roster));
        assert_eq!(suggested_total(Some(70_000), &roster), Some(350_000));
        assert_eq!(suggested_total(Some(70_500), &roster), Some(352_500));
        assert_eq!(suggested_total(None, &roster), None);
        assert_eq!(suggested_total(Some(0), &roster), None);
        assert_eq!(suggested_total(Some(-5), &roster), None);
    }

    #[test]
    fn a_presumed_headcount_is_not_a_checked_one() {
        let unmarked = vec![row("a", In, None, None, None), row("b", In, Some(1), None, None)];
        assert!(!attendance_checked(&unmarked));
        assert_eq!(total_arrived_heads(&unmarked), 3);
        assert_eq!(suggested_total(Some(70_000), &unmarked), Some(210_000));

        // One mark anywhere is enough, even one that changes nothing.
        let checked = vec![row("a", In, None, None, None), row("b", In, Some(1), None, Some(0))];
        assert!(attendance_checked(&checked));
        assert_eq!(total_arrived_heads(&checked), 2);
        assert_eq!(suggested_total(Some(70_000), &checked), Some(140_000));
    }

    #[test]
    fn nobody_on_the_pitch_means_nothing_to_suggest() {
        let empty: Vec<Row> = Vec::new();
        assert_eq!(ids(&arrived_only(&empty)), [] as [&str; 0]);
        assert_eq!(total_arrived_heads(&empty), 0);
        assert!(!attendance_checked(&empty));
        assert_eq!(suggested_total(Some(70_000), &empty), None);

        let all_out = vec![row("a", In, None, Some(false), None)];
        assert_eq!(total_arrived_heads(&all_out), 0);
        assert!(attendance_checked(&all_out));
        assert_eq!(suggested_total(Some(70_000), &all_out), None);

        let waitlist_only =
            vec![row("a", Waitlist, None, None, None), row("b", Waitlist, Some(3), None, None)];
        assert_eq!(ids(&arrived_only(&waitlist_only)), [] as [&str; 0]);
        assert_eq!(total_arrived_heads(&waitlist_only), 0);
        assert_eq!(suggested_total(Some(70_000), &waitlist_only), None);
    }

    #[test]
    fn a_no_show_whose_guests_came_anyway_still_counts_for_them() {
        let roster = vec![
            row("a", In, Some(2), None, Some(1)),
            row("b", Waitlist, Some(1), Some(true), None),
            row("c", In, Some(5), Some(false), Some(5)),
            row("d", In, Some(0), None, None),
        ];
        assert_eq!(ids(&arrived_only(&roster)), ["a", "b", "c", "d"]);
        assert_eq!(total_arrived_heads(&roster), 10);
        assert_eq!(suggested_total(Some(70_000), &roster), Some(700_000));
        assert_eq!(suggested_total(Some(70_500), &roster), Some(705_000));
    }
}
