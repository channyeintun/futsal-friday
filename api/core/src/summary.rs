//! Plain-text snapshots for pasting into the group chat.
//!
//! Pure string building, no DOM — the "copy" part is the platform adapter's
//! job. Kept beside the rest of the shared logic so a future bot could post the
//! exact same text the app shows, and localised because the chat this lands in
//! is the group's own.
//!
//! Ported from `shared/src/summary.ts`, line for line. Two things the
//! TypeScript reached for are written out here: the model, because `models.ts`
//! is a wall of zod schemas with nothing left to port once the validation is
//! gone, and the message catalogue, because this crate has no i18n module to
//! read it from. As in the catalogue, English is the source of truth and the
//! Burmese is written rather than translated.

use crate::clock::format_kickoff;
use crate::money::format_vnd;

/// A pitch. `address`, `map_url` and `price_note` are all optional, and the
/// original tests them for truthiness, so an empty string means the same as no
/// value at all — see `text_of`.
#[derive(Debug, Clone)]
pub struct Venue {
    pub name: String,
    pub address: Option<String>,
    pub map_url: Option<String>,
    pub price_note: Option<String>,
}

/// The parts of a session this text reads. `starts_at` is a UTC instant in
/// milliseconds, as everywhere else in the port.
#[derive(Debug, Clone)]
pub struct Session {
    pub starts_at: i64,
    /// `scheduled` | `cancelled` | `completed`.
    pub status: String,
    pub venue: Option<Venue>,
    pub max_players: Option<i64>,
    pub notes: Option<String>,
}

/// One name on the list, with the guests they are bringing.
#[derive(Debug, Clone)]
pub struct Registration {
    pub member_name: String,
    pub guests: i64,
    /// `in` | `waitlist`.
    pub status: String,
}

/// `in_count` is **heads** — members plus their guests — which is why the
/// numbered list underneath it can be shorter than the number in the heading.
#[derive(Debug, Clone, Copy, Default)]
pub struct Counts {
    pub in_count: i64,
    pub waitlist: i64,
    pub guests: i64,
}

#[derive(Debug, Clone)]
pub struct SessionDetail {
    pub session: Session,
    pub registrations: Vec<Registration>,
    pub counts: Counts,
}

/// One person's line in the bill.
#[derive(Debug, Clone)]
pub struct Payment {
    pub member_name: String,
    pub amount_due: i64,
    pub guests: i64,
    /// `unpaid` | `pending` | `confirmed`.
    pub status: String,
}

/// `pending` never reaches the text, but the three totals only mean anything
/// together, so it is carried rather than dropped.
#[derive(Debug, Clone)]
pub struct PaymentSummary {
    pub total_charge: Option<i64>,
    pub collected: i64,
    pub pending: i64,
    pub outstanding: i64,
    pub payments: Vec<Payment>,
}

/// How the writer wants the snapshot spelled.
#[derive(Debug, Clone)]
pub struct SummaryOptions {
    /// Appended as a call-to-action so newcomers can find the app.
    pub app_url: Option<String>,
    pub locale: String,
    /// The writer's clock. Defaults to 24h, which is what it always was.
    ///
    /// Threaded in rather than left to the default because these strings are
    /// the app talking on somebody's behalf, and a person who reads 7:30 PM
    /// everywhere else in the app should not paste 19:30 into the chat under
    /// their own name.
    pub hour12: bool,
}

/// The defaults the TypeScript spelled as `options: SummaryOptions = {}`.
impl Default for SummaryOptions {
    fn default() -> Self {
        Self { app_url: None, locale: "en".to_string(), hour12: false }
    }
}

/// The registration list, ready to paste: kickoff, venue, who is in, who is
/// waiting, the organizer's notes, and a link.
pub fn registration_summary(detail: &SessionDetail, options: &SummaryOptions) -> String {
    let locale = options.locale.as_str();
    let session = &detail.session;
    let mut lines: Vec<String> = Vec::new();

    lines.push(format!(
        "⚽ {} — {}",
        match_header(locale),
        format_kickoff(session.starts_at, locale, options.hour12)
    ));

    if session.status == "cancelled" {
        lines.push(String::new());
        lines.push(format!("🚫 {}", cancelled(locale)));
        return lines.join("\n");
    }

    if let Some(venue) = &session.venue {
        let address = text_of(&venue.address);
        let dash = if address.is_empty() { String::new() } else { format!(" — {address}") };
        lines.push(format!("📍 {}{dash}", venue.name));
        let map_url = text_of(&venue.map_url);
        if !map_url.is_empty() {
            lines.push(format!("🗺 {map_url}"));
        }
        // The pitch's hourly rate rather than a per-person share — see the note
        // in `announce.rs`: a share cannot be known before the game is played.
        let price_note = text_of(&venue.price_note);
        if !price_note.is_empty() {
            lines.push(format!("💰 {price_note}"));
        }
    }

    let playing: Vec<&Registration> =
        detail.registrations.iter().filter(|r| r.status == "in").collect();
    let waiting: Vec<&Registration> =
        detail.registrations.iter().filter(|r| r.status == "waitlist").collect();

    lines.push(String::new());
    lines.push(in_heading(locale, detail.counts.in_count, session.max_players));
    if playing.is_empty() {
        lines.push(format!("  {}", nobody_yet(locale)));
    } else {
        // "3. Bao (+2)" — the head count has to add up for whoever reads this in
        // the chat and counts names against the number at the top.
        for (i, r) in playing.iter().enumerate() {
            lines.push(format!("{}. {}{}", i + 1, r.member_name, guest_suffix(r.guests)));
        }
    }

    if !waiting.is_empty() {
        lines.push(String::new());
        lines.push(waitlist_heading(locale, detail.counts.waitlist));
        for (i, r) in waiting.iter().enumerate() {
            lines.push(format!("{}. {}{}", i + 1, r.member_name, guest_suffix(r.guests)));
        }
    }

    let notes = text_of(&session.notes);
    if !notes.is_empty() {
        lines.push(String::new());
        lines.push(format!("📝 {notes}"));
    }

    let app_url = text_of(&options.app_url);
    if !app_url.is_empty() {
        lines.push(String::new());
        lines.push(format!("👉 {app_url}"));
    }

    lines.join("\n")
}

/// Who has paid, who is being checked, and who still owes — the message the
/// organizer drops into the chat instead of chasing people one at a time.
pub fn payments_summary(
    session: &Session,
    summary: &PaymentSummary,
    options: &SummaryOptions,
) -> String {
    let locale = options.locale.as_str();
    let mut lines: Vec<String> = Vec::new();

    lines.push(format!(
        "💰 {} — {}",
        payments_header(locale),
        format_kickoff(session.starts_at, locale, options.hour12)
    ));
    // Present or absent, not truthiness: a bill of zero is a bill that was
    // settled, and it says so.
    if let Some(total) = summary.total_charge {
        lines.push(field_total(locale, &format_vnd(total)));
    }
    lines.push(collected_outstanding(
        locale,
        &format_vnd(summary.collected),
        &format_vnd(summary.outstanding),
    ));

    let by_status = |status: &str| -> Vec<&Payment> {
        summary.payments.iter().filter(|p| p.status == status).collect()
    };
    let confirmed = by_status("confirmed");
    let pending = by_status("pending");
    let unpaid = by_status("unpaid");

    if !confirmed.is_empty() {
        lines.push(String::new());
        lines.push(format!("✅ {}", paid(locale, confirmed.len())));
        lines.push(names(&confirmed));
    }
    if !pending.is_empty() {
        lines.push(String::new());
        lines.push(format!("⏳ {}", checking(locale, pending.len())));
        lines.push(names(&pending));
    }
    if !unpaid.is_empty() {
        lines.push(String::new());
        lines.push(format!("❌ {}", not_yet(locale, unpaid.len())));
        // One per line with the amount, because this is the list people read
        // looking for themselves.
        for p in &unpaid {
            lines.push(format!(
                "{}{} — {}",
                p.member_name,
                guest_suffix(p.guests),
                format_vnd(p.amount_due)
            ));
        }
    }

    let app_url = text_of(&options.app_url);
    if !app_url.is_empty() {
        lines.push(String::new());
        lines.push(format!("👉 {app_url}"));
    }

    lines.join("\n")
}

/// An absent string and an empty one are the same thing to the original, which
/// tests `venue.address ? …`: a blank address adds no dash, a blank map link
/// adds no line at all.
pub(crate) fn text_of(value: &Option<String>) -> &str {
    value.as_deref().unwrap_or("")
}

/// The catalogue spells the tail the same way in both locales; the rule about
/// when it appears at all belongs here.
fn guest_suffix(guests: i64) -> String {
    if guests > 0 {
        return format!(" (+{guests})");
    }
    String::new()
}

/// Everybody in one group, on one line.
fn names(payments: &[&Payment]) -> String {
    payments.iter().map(|p| p.member_name.as_str()).collect::<Vec<_>>().join(", ")
}

// ---- the catalogue ---------------------------------------------------------

fn match_header(locale: &str) -> &'static str {
    if locale == "my" {
        "ဖူဆယ်"
    } else {
        "FUTSAL"
    }
}

/// Read by `announce.rs` too: a cancelled game is the one thing both messages
/// say, and they must say it the same way.
pub(crate) fn cancelled(locale: &str) -> &'static str {
    if locale == "my" {
        "ပွဲပျက်"
    } else {
        "CANCELLED"
    }
}

/// The original writes `max ? … : …`, so a cap of zero reads as no cap at all —
/// unlike `announce.rs`, which asks whether the cap is *there*.
fn in_heading(locale: &str, count: i64, max: Option<i64>) -> String {
    match max.filter(|m| *m != 0) {
        Some(max) => {
            if locale == "my" {
                format!("ကစားမည် ({count}/{max})")
            } else {
                format!("IN ({count}/{max})")
            }
        }
        None => {
            if locale == "my" {
                format!("ကစားမည် ({count})")
            } else {
                format!("IN ({count})")
            }
        }
    }
}

fn nobody_yet(locale: &str) -> &'static str {
    if locale == "my" {
        "— ဘယ်သူမှ မရှိသေး —"
    } else {
        "— nobody yet —"
    }
}

fn waitlist_heading(locale: &str, count: i64) -> String {
    if locale == "my" {
        format!("စောင့်ဆိုင်း ({count})")
    } else {
        format!("WAITLIST ({count})")
    }
}

fn payments_header(locale: &str) -> &'static str {
    if locale == "my" {
        "ငွေပေးချေမှု"
    } else {
        "PAYMENTS"
    }
}

fn field_total(locale: &str, amount: &str) -> String {
    if locale == "my" {
        format!("ကွင်းခ စုစုပေါင်း: {amount}")
    } else {
        format!("Field total: {amount}")
    }
}

fn collected_outstanding(locale: &str, collected: &str, outstanding: &str) -> String {
    if locale == "my" {
        format!("ရရှိပြီး {collected} · ကျန် {outstanding}")
    } else {
        format!("Collected {collected} · Outstanding {outstanding}")
    }
}

fn paid(locale: &str, count: usize) -> String {
    if locale == "my" {
        format!("ပေးပြီး ({count})")
    } else {
        format!("PAID ({count})")
    }
}

fn checking(locale: &str, count: usize) -> String {
    if locale == "my" {
        format!("စစ်ဆဲ ({count})")
    } else {
        format!("CHECKING ({count})")
    }
}

fn not_yet(locale: &str, count: usize) -> String {
    if locale == "my" {
        format!("မပေးရသေး ({count})")
    } else {
        format!("NOT YET ({count})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2025-08-08T12:30:00Z — Friday 19:30 in Ho Chi Minh City.
    const KICKOFF: i64 = 1_754_656_200_000;

    fn venue() -> Venue {
        Venue {
            name: "Sân Tao Đàn".into(),
            address: Some("1 Trương Định".into()),
            map_url: Some("https://maps.example/tao-dan".into()),
            price_note: Some("700.000d / giờ".into()),
        }
    }

    fn session() -> Session {
        Session {
            starts_at: KICKOFF,
            status: "scheduled".into(),
            venue: Some(venue()),
            max_players: Some(12),
            notes: Some("Bring a white shirt".into()),
        }
    }

    fn reg(name: &str, guests: i64, status: &str) -> Registration {
        Registration { member_name: name.into(), guests, status: status.into() }
    }

    fn detail() -> SessionDetail {
        SessionDetail {
            session: session(),
            registrations: vec![
                reg("Bao", 2, "in"),
                reg("Minh", 0, "in"),
                reg("Khoa", 1, "waitlist"),
            ],
            counts: Counts { in_count: 5, waitlist: 2, guests: 2 },
        }
    }

    fn options(locale: &str, hour12: bool, app_url: Option<&str>) -> SummaryOptions {
        SummaryOptions { app_url: app_url.map(String::from), locale: locale.into(), hour12 }
    }

    fn summary() -> PaymentSummary {
        PaymentSummary {
            total_charge: Some(500_000),
            collected: 200_000,
            pending: 100_000,
            outstanding: 300_000,
            payments: vec![
                Payment {
                    member_name: "Bao".into(),
                    amount_due: 200_000,
                    guests: 1,
                    status: "confirmed".into(),
                },
                Payment {
                    member_name: "Minh".into(),
                    amount_due: 100_000,
                    guests: 0,
                    status: "pending".into(),
                },
                Payment {
                    member_name: "Khoa".into(),
                    amount_due: 100_000,
                    guests: 0,
                    status: "unpaid".into(),
                },
                Payment {
                    member_name: "An".into(),
                    amount_due: 100_000,
                    guests: 2,
                    status: "unpaid".into(),
                },
            ],
        }
    }

    /// Every expected string below is what `shared/src/summary.ts` answered for
    /// the same fixture, character for character.
    #[test]
    fn the_registration_list_in_both_languages() {
        let cases = [
            (
                options("en", false, Some("https://futsal.example")),
                "⚽ FUTSAL — Fri 08 Aug, 19:30\n📍 Sân Tao Đàn — 1 Trương Định\n🗺 https://maps.example/tao-dan\n💰 700.000d / giờ\n\nIN (5/12)\n1. Bao (+2)\n2. Minh\n\nWAITLIST (2)\n1. Khoa (+1)\n\n📝 Bring a white shirt\n\n👉 https://futsal.example",
            ),
            (
                options("my", true, Some("https://futsal.example")),
                "⚽ ဖူဆယ် — သောကြာ 08 ဩဂုတ်၊ 7:30 PM\n📍 Sân Tao Đàn — 1 Trương Định\n🗺 https://maps.example/tao-dan\n💰 700.000d / giờ\n\nကစားမည် (5/12)\n1. Bao (+2)\n2. Minh\n\nစောင့်ဆိုင်း (2)\n1. Khoa (+1)\n\n📝 Bring a white shirt\n\n👉 https://futsal.example",
            ),
        ];
        for (options, expected) in cases {
            assert_eq!(registration_summary(&detail(), &options), expected);
        }
    }

    #[test]
    fn no_app_url_no_call_to_action() {
        assert_eq!(
            registration_summary(&detail(), &SummaryOptions::default()),
            "⚽ FUTSAL — Fri 08 Aug, 19:30\n📍 Sân Tao Đàn — 1 Trương Định\n🗺 https://maps.example/tao-dan\n💰 700.000d / giờ\n\nIN (5/12)\n1. Bao (+2)\n2. Minh\n\nWAITLIST (2)\n1. Khoa (+1)\n\n📝 Bring a white shirt"
        );
    }

    /// A cancelled game stops after the header: no venue, no list, no notes, and
    /// no link either.
    #[test]
    fn a_cancelled_game_says_so_and_stops() {
        let mut off = detail();
        off.session.status = "cancelled".into();
        assert_eq!(
            registration_summary(&off, &options("en", false, Some("https://futsal.example"))),
            "⚽ FUTSAL — Fri 08 Aug, 19:30\n\n🚫 CANCELLED"
        );
        assert_eq!(
            registration_summary(&off, &options("my", false, None)),
            "⚽ ဖူဆယ် — သောကြာ 08 ဩဂုတ်၊ 19:30\n\n🚫 ပွဲပျက်"
        );
    }

    #[test]
    fn an_empty_list_says_nobody_yet() {
        let empty = SessionDetail {
            session: Session {
                starts_at: KICKOFF,
                status: "scheduled".into(),
                venue: None,
                max_players: None,
                notes: None,
            },
            registrations: Vec::new(),
            counts: Counts::default(),
        };
        let cases = [
            (
                options("en", false, None),
                "⚽ FUTSAL — Fri 08 Aug, 19:30\n\nIN (0)\n  — nobody yet —",
            ),
            (
                options("my", false, None),
                "⚽ ဖူဆယ် — သောကြာ 08 ဩဂုတ်၊ 19:30\n\nကစားမည် (0)\n  — ဘယ်သူမှ မရှိသေး —",
            ),
        ];
        for (options, expected) in cases {
            assert_eq!(registration_summary(&empty, &options), expected);
        }
    }

    /// The original tests these fields for truthiness, so a blank one is no
    /// field at all — and a cap of zero is no cap.
    #[test]
    fn blank_is_the_same_as_absent() {
        let mut blank = detail();
        blank.session.venue = Some(Venue {
            name: "Sân Tao Đàn".into(),
            address: Some(String::new()),
            map_url: Some(String::new()),
            price_note: Some(String::new()),
        });
        blank.session.notes = Some(String::new());
        assert_eq!(
            registration_summary(&blank, &SummaryOptions::default()),
            "⚽ FUTSAL — Fri 08 Aug, 19:30\n📍 Sân Tao Đàn\n\nIN (5/12)\n1. Bao (+2)\n2. Minh\n\nWAITLIST (2)\n1. Khoa (+1)"
        );

        let mut uncapped = detail();
        uncapped.session.max_players = Some(0);
        assert_eq!(
            registration_summary(&uncapped, &SummaryOptions::default()),
            "⚽ FUTSAL — Fri 08 Aug, 19:30\n📍 Sân Tao Đàn — 1 Trương Định\n🗺 https://maps.example/tao-dan\n💰 700.000d / giờ\n\nIN (5)\n1. Bao (+2)\n2. Minh\n\nWAITLIST (2)\n1. Khoa (+1)\n\n📝 Bring a white shirt"
        );
    }

    /// Nobody in, two waiting: the heading still counts heads and the numbering
    /// restarts under the waitlist.
    #[test]
    fn a_list_of_only_reserves() {
        let mut waiting = detail();
        waiting.registrations = vec![reg("Khoa", 1, "waitlist"), reg("An", 0, "waitlist")];
        waiting.counts = Counts { in_count: 0, waitlist: 3, guests: 0 };
        assert_eq!(
            registration_summary(&waiting, &SummaryOptions::default()),
            "⚽ FUTSAL — Fri 08 Aug, 19:30\n📍 Sân Tao Đàn — 1 Trương Định\n🗺 https://maps.example/tao-dan\n💰 700.000d / giờ\n\nIN (0/12)\n  — nobody yet —\n\nWAITLIST (3)\n1. Khoa (+1)\n2. An\n\n📝 Bring a white shirt"
        );
    }

    #[test]
    fn the_bill_in_both_languages() {
        let cases = [
            (
                options("en", false, Some("https://futsal.example")),
                "💰 PAYMENTS — Fri 08 Aug, 19:30\nField total: 500.000d\nCollected 200.000d · Outstanding 300.000d\n\n✅ PAID (1)\nBao\n\n⏳ CHECKING (1)\nMinh\n\n❌ NOT YET (2)\nKhoa — 100.000d\nAn (+2) — 100.000d\n\n👉 https://futsal.example",
            ),
            (
                options("my", true, Some("https://futsal.example")),
                "💰 ငွေပေးချေမှု — သောကြာ 08 ဩဂုတ်၊ 7:30 PM\nကွင်းခ စုစုပေါင်း: 500.000d\nရရှိပြီး 200.000d · ကျန် 300.000d\n\n✅ ပေးပြီး (1)\nBao\n\n⏳ စစ်ဆဲ (1)\nMinh\n\n❌ မပေးရသေး (2)\nKhoa — 100.000d\nAn (+2) — 100.000d\n\n👉 https://futsal.example",
            ),
        ];
        for (options, expected) in cases {
            assert_eq!(payments_summary(&session(), &summary(), &options), expected);
        }
    }

    /// No total set yet, nobody charged: two lines and nothing else. A total of
    /// zero, by contrast, is a settled bill and still prints.
    #[test]
    fn a_bill_with_nothing_on_it() {
        let nothing = PaymentSummary {
            total_charge: None,
            collected: 0,
            pending: 0,
            outstanding: 0,
            payments: Vec::new(),
        };
        assert_eq!(
            payments_summary(&session(), &nothing, &SummaryOptions::default()),
            "💰 PAYMENTS — Fri 08 Aug, 19:30\nCollected 0d · Outstanding 0d"
        );

        let settled = PaymentSummary { total_charge: Some(0), ..nothing };
        assert_eq!(
            payments_summary(&session(), &settled, &options("my", false, None)),
            "💰 ငွေပေးချေမှု — သောကြာ 08 ဩဂုတ်၊ 19:30\nကွင်းခ စုစုပေါင်း: 0d\nရရှိပြီး 0d · ကျန် 0d"
        );
    }
}
