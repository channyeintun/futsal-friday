//! A random, slightly rude announcement to drop into the group chat.
//!
//! The sibling of `registration_summary` in `summary.rs`: same job — text for
//! the chat — but this one is for the nudge before anyone has signed up, where
//! a neat table of zero names persuades nobody.
//!
//! The jokes come out of the locale catalogue rather than being translated at
//! runtime, because a Burmese joke is not an English joke with the words
//! swapped. Only the flavour is random; the kickoff, venue and pitch rate are
//! always the real ones, so a funny message is still a correct message.
//!
//! Ported from `shared/src/announce.ts`. The session it reads is the model in
//! `summary.rs` — the TypeScript passes the same `SessionDetail` to both.

use crate::clock::format_kickoff;
use crate::summary::{cancelled, text_of, SessionDetail};

/// How the writer wants the announcement spelled.
#[derive(Debug, Clone)]
pub struct AnnounceOptions {
    pub app_url: Option<String>,
    pub locale: String,
    /// The organizer's own jab, in place of one of the canned ones.
    ///
    /// Only the tease is overridable, and deliberately so: the opener is
    /// generic hype and a random one does that job perfectly, but the tease is
    /// where the week's actual needling lives — who went missing last time, who
    /// has been talking, whose turn it is to be reminded of something. That is
    /// the one line a joke bank cannot know, because it is about these people.
    ///
    /// Everything else is either flavour that does not matter or the kickoff,
    /// the venue and the price — facts, and not the writer's to change.
    ///
    /// Blank or whitespace falls back to the shuffle, so clearing the box is how
    /// you get the jokes back rather than a separate control.
    pub tease: Option<String>,
    /// The writer's clock. Defaults to 24h, which is what it always was.
    ///
    /// The message language is chosen per announcement — the group chat is in
    /// Burmese even when the organizer reads the app in English — but the clock
    /// is not a property of the message, it is how the person writing it reads a
    /// time. So this follows them rather than the language beside it.
    pub hour12: bool,
}

/// The defaults the TypeScript spelled as `options: AnnounceOptions = {}`.
impl Default for AnnounceOptions {
    fn default() -> Self {
        Self { app_url: None, locale: "en".to_string(), tease: None, hour12: false }
    }
}

fn pick<'a>(list: &[&'a str], random: &mut dyn FnMut() -> f64) -> &'a str {
    // `random()` is allowed to return 1 by callers who are not `Math.random`.
    let count = list.len();
    let index = (random() * count as f64).floor().min(count as f64 - 1.0);
    // An index off either end of the list — or off the number line, which a
    // `random` that answers NaN produces — is `undefined` in JavaScript, and
    // `join` writes that as an empty line rather than throwing.
    if index.is_nan() || index < 0.0 {
        return "";
    }
    list.get(index as usize).copied().unwrap_or("")
}

/// One announcement: an opener, the facts, a jab, and a call to action.
///
/// `random` is handed in rather than defaulted to a global the way the original
/// defaults to `Math.random` — this crate holds nothing from the host — and the
/// callers that matter passed their own anyway: the tests pin the message, and
/// the shuffle button uses it to avoid handing back the line it just showed.
pub fn session_announcement(
    detail: &SessionDetail,
    options: &AnnounceOptions,
    random: &mut dyn FnMut() -> f64,
) -> String {
    let locale = options.locale.as_str();
    let session = &detail.session;
    let mut lines: Vec<String> = Vec::new();

    // Nothing funny about a cancelled game; say it plainly and stop.
    if session.status == "cancelled" {
        let header = format!(
            "🚫 {} — {}",
            cancelled(locale),
            format_kickoff(session.starts_at, locale, options.hour12)
        );
        let notes = text_of(&session.notes);
        return if notes.is_empty() { header } else { format!("{header}\n{notes}") };
    }

    lines.push(pick(openers(locale), random).to_string());
    lines.push(String::new());

    lines.push(format!("⚽ {}", format_kickoff(session.starts_at, locale, options.hour12)));
    if let Some(venue) = &session.venue {
        let address = text_of(&venue.address);
        let dash = if address.is_empty() { String::new() } else { format!(" — {address}") };
        lines.push(format!("📍 {}{dash}", venue.name));
        let map_url = text_of(&venue.map_url);
        if !map_url.is_empty() {
            lines.push(format!("🗺 {map_url}"));
        }
        // The pitch's hourly rate, not a share.
        //
        // A per-person figure cannot be honest before the game: it depends on
        // how long they book — one hour some weeks, two the next — and on how
        // many actually turn up. Posting "~70.000d each" to fifteen people is a
        // promise the app has no way to keep, and the number it was quoting came
        // from the *previous* session anyway, copied forward by the cron. What
        // the organizer genuinely set, and what does not move week to week, is
        // the pitch's price per hour.
        let price_note = text_of(&venue.price_note);
        if !price_note.is_empty() {
            lines.push(format!("💰 {price_note}"));
        }
    }

    lines.push(String::new());
    // `counts.in_count` is heads, guests included — the number that decides
    // whether there is still room.
    lines.push(headcount(locale, detail.counts.in_count, session.max_players));

    lines.push(String::new());
    let written = js_trim(text_of(&options.tease));
    if written.is_empty() {
        lines.push(pick(teases(locale), random).to_string());
    } else {
        lines.push(written.to_string());
    }

    lines.push(String::new());
    lines.push(pick(call_to_action(locale), random).to_string());
    let app_url = text_of(&options.app_url);
    if !app_url.is_empty() {
        lines.push(format!("👉 {app_url}"));
    }

    lines.join("\n")
}

/// The one line that has to be true, so it is picked by state, not at random.
fn headcount(locale: &str, going: i64, max_players: Option<i64>) -> String {
    if going == 0 {
        return nobody_yet(locale).to_string();
    }
    let Some(max) = max_players else {
        return so_far(locale, going);
    };
    let left = max - going;
    if left <= 0 {
        return full(locale).to_string();
    }
    spots_left(locale, going, left)
}

/// `String.prototype.trim`, spelled out.
///
/// Rust's own `trim` is close but not the same set: it takes U+0085 off, which
/// JavaScript leaves alone, and leaves U+FEFF on, which JavaScript takes off.
/// What this decides is whether the organizer wrote anything, so it has to agree
/// with the box they typed into.
fn js_trim(value: &str) -> &str {
    value.trim_matches(js_space)
}

/// JavaScript's `WhiteSpace` and `LineTerminator` productions, together.
fn js_space(c: char) -> bool {
    matches!(c,
        '\u{9}'..='\u{d}'
            | '\u{20}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

// ---- the banter bank -------------------------------------------------------
//
// Each locale writes its own jokes. These are deliberately not translations of
// each other — the Burmese list is what a Burmese friend group actually says to
// each other, not these lines rendered in Myanmar script.

const OPENERS_EN: [&str; 8] = [
    "Legs itching yet? 🦵",
    "Futsal Friday is back ⚽",
    "The pitch is calling. Pick up 📣",
    "Time to run it back this week!",
    "Off the sofa, onto the pitch 🛋➡️⚽",
    "Dig the boots out 👟",
    "Team sheet is open 📝",
    "No FIFA this week. The real thing 🎮❌",
];

const OPENERS_MY: [&str; 8] = [
    "ခြေထောက်တွေ ယားနေပြီလား? 🦵",
    "ဖူဆယ် သောကြာ ပြန်ရောက်လာပြီ ⚽",
    "ကွင်းက ခေါ်နေပြီ — ကြားလား? 📣",
    "ဒီတစ်ပတ်လည်း ကန်ဖို့ အချိန်တန်ပြီ!",
    "ဆိုဖာပေါ်က ထ — ကွင်းထဲ ဆင်း 🛋➡️⚽",
    "ဖိနပ်တွေ ထုတ်ထားကြ 👟",
    "စာရင်း ဖွင့်လိုက်ပြီ 📝",
    "ဒီအပတ် ဖီဖာ မဟုတ်ဘူး — တကယ့်ကွင်းထဲ 🎮❌",
];

const TEASES_EN: [&str; 8] = [
    "Everyone who was \"busy\" last week — you will need a fresh excuse 😏",
    "Bad knee, bad back, big meeting. Not accepted this week 🙅",
    "If nobody calls keeper, everybody is keeper 🥅",
    "PS: those of you who still owe money. Yes. You 👀",
    "Said yes and then vanished? There is a list 📋",
    "Do not think about how you will feel tomorrow morning 💪",
    "Score once and you get to bring it up all week 🏆",
    "Last one to arrive buys the water 💧",
];

const TEASES_MY: [&str; 8] = [
    "ပြီးခဲ့တဲ့အပတ်က \"အလုပ်များတယ်\" ဆိုသူများ — အကြောင်းပြချက် အသစ် လိုပြီနော် 😏",
    "ဒူးနာတယ်၊ ခါးနာတယ်၊ အစည်းအဝေး ရှိတယ် — ဒီတစ်ပတ် လက်မခံပါ 🙅",
    "ဂိုးသမား ဘယ်သူမှ မလုပ်ရင် အားလုံး ဂိုးသမား ဖြစ်ကြမယ် 🥅",
    "မှတ်ချက် — ပိုက်ဆံ မရှင်းရသေးသူများ။ ဟုတ်တယ်။ ခင်ဗျားတို့ကို ပြောနေတာ 👀",
    "လာမယ်ဆိုပြီး ပျောက်သွားသူများ — စာရင်း ရှိတယ်နော် 📋",
    "မနက်ဖြန် ကြွက်တက်မယ့်အကြောင်း ကြိုမတွေးနဲ့ 💪",
    "တစ်ဂိုးလောက် သွင်းလိုက်ရင် တစ်ပတ်လုံး ပြောလို့ရတယ် 🏆",
    "နောက်ဆုံး ရောက်လာသူ ရေဖိုး တာဝန်ယူ 💧",
];

const CALL_TO_ACTION_EN: [&str; 4] =
    ["Tap in now 👇", "Get your name down 👇", "Before the spots go 👇", "You in? 👇"];

const CALL_TO_ACTION_MY: [&str; 4] = [
    "လာမယ်ဆိုရင် အခုပဲ နှိပ်လိုက် 👇",
    "နာမည် စာရင်းသွင်းလိုက် 👇",
    "နေရာ မကုန်ခင် 👇",
    "ပါမလား? 👇",
];

fn openers(locale: &str) -> &'static [&'static str] {
    if locale == "my" {
        &OPENERS_MY
    } else {
        &OPENERS_EN
    }
}

fn teases(locale: &str) -> &'static [&'static str] {
    if locale == "my" {
        &TEASES_MY
    } else {
        &TEASES_EN
    }
}

fn call_to_action(locale: &str) -> &'static [&'static str] {
    if locale == "my" {
        &CALL_TO_ACTION_MY
    } else {
        &CALL_TO_ACTION_EN
    }
}

fn nobody_yet(locale: &str) -> &'static str {
    if locale == "my" {
        "ခုထိ ဘယ်သူမှ မရှိသေးဘူး။ တစ်ယောက်ယောက်တော့ ဦးဆုံး ဖြစ်ရမယ် 🥇"
    } else {
        "Nobody has signed up yet. Someone has to go first 🥇"
    }
}

fn so_far(locale: &str, going: i64) -> String {
    if locale == "my" {
        format!("ခုထိ {going} ယောက်")
    } else {
        format!("{going} in so far")
    }
}

fn spots_left(locale: &str, going: i64, left: i64) -> String {
    if locale == "my" {
        format!("{going} ယောက် ရှိပြီ · {left} နေရာ ကျန်သေး")
    } else {
        format!("{going} in · {left} spots left")
    }
}

fn full(locale: &str) -> &'static str {
    if locale == "my" {
        "နေရာ ပြည့်သွားပြီ — စောင့်ဆိုင်းစာရင်း ဖွင့်ထားတယ်၊ ပြုတ်တဲ့သူ အမြဲရှိတယ် 🤞"
    } else {
        "We are full — waitlist is open, and people always drop out 🤞"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::summary::{Counts, Registration, Session, Venue};

    /// 2025-08-08T12:30:00Z — Friday 19:30 in Ho Chi Minh City.
    const KICKOFF: i64 = 1_754_656_200_000;

    fn detail(venue: Option<Venue>, max_players: Option<i64>, going: i64) -> SessionDetail {
        SessionDetail {
            session: Session {
                starts_at: KICKOFF,
                status: "scheduled".into(),
                venue,
                max_players,
                notes: Some("Bring a white shirt".into()),
            },
            registrations: vec![Registration {
                member_name: "Bao".into(),
                guests: 2,
                status: "in".into(),
            }],
            counts: Counts { in_count: going, waitlist: 0, guests: 0 },
        }
    }

    fn venue() -> Venue {
        Venue {
            name: "Sân Tao Đàn".into(),
            address: Some("1 Trương Định".into()),
            map_url: Some("https://maps.example/tao-dan".into()),
            price_note: Some("700.000d / giờ".into()),
        }
    }

    fn options(
        locale: &str,
        app_url: Option<&str>,
        tease: Option<&str>,
        hour12: bool,
    ) -> AnnounceOptions {
        AnnounceOptions {
            app_url: app_url.map(String::from),
            locale: locale.into(),
            tease: tease.map(String::from),
            hour12,
        }
    }

    /// A `random` that answers the same number every time, as the original's
    /// tests do.
    fn fixed(value: f64) -> impl FnMut() -> f64 {
        move || value
    }

    /// A `random` that answers each value in turn, so a case can pin the opener,
    /// the tease and the call to action separately.
    fn seq(values: [f64; 3]) -> impl FnMut() -> f64 {
        let mut i = 0usize;
        move || {
            let value = values[i % values.len()];
            i += 1;
            value
        }
    }

    /// Every expected string below is what `shared/src/announce.ts` answered for
    /// the same fixture, character for character.
    #[test]
    fn the_whole_announcement_in_both_languages() {
        assert_eq!(
            session_announcement(
                &detail(Some(venue()), Some(12), 8),
                &options("en", Some("https://futsal.example"), None, false),
                &mut fixed(0.0)
            ),
            "Legs itching yet? 🦵\n\n⚽ Fri 08 Aug, 19:30\n📍 Sân Tao Đàn — 1 Trương Định\n🗺 https://maps.example/tao-dan\n💰 700.000d / giờ\n\n8 in · 4 spots left\n\nEveryone who was \"busy\" last week — you will need a fresh excuse 😏\n\nTap in now 👇\n👉 https://futsal.example"
        );
        assert_eq!(
            session_announcement(
                &detail(Some(venue()), Some(12), 8),
                &options("my", Some("https://futsal.example"), None, true),
                &mut fixed(0.0)
            ),
            "ခြေထောက်တွေ ယားနေပြီလား? 🦵\n\n⚽ သောကြာ 08 ဩဂုတ်၊ 7:30 PM\n📍 Sân Tao Đàn — 1 Trương Định\n🗺 https://maps.example/tao-dan\n💰 700.000d / giờ\n\n8 ယောက် ရှိပြီ · 4 နေရာ ကျန်သေး\n\nပြီးခဲ့တဲ့အပတ်က \"အလုပ်များတယ်\" ဆိုသူများ — အကြောင်းပြချက် အသစ် လိုပြီနော် 😏\n\nလာမယ်ဆိုရင် အခုပဲ နှိပ်လိုက် 👇\n👉 https://futsal.example"
        );
    }

    /// The headcount is the one line picked by state: nobody, a number, the last
    /// few spots, or full. A cap of zero is a cap that has been reached — unlike
    /// the registration heading, this asks whether the cap is *there*.
    #[test]
    fn the_headcount_line() {
        let cases = [
            ("en", None, 0, "Nobody has signed up yet. Someone has to go first 🥇"),
            ("my", None, 0, "ခုထိ ဘယ်သူမှ မရှိသေးဘူး။ တစ်ယောက်ယောက်တော့ ဦးဆုံး ဖြစ်ရမယ် 🥇"),
            ("en", None, 3, "3 in so far"),
            ("my", None, 3, "ခုထိ 3 ယောက်"),
            ("en", Some(12), 8, "8 in · 4 spots left"),
            ("my", Some(12), 8, "8 ယောက် ရှိပြီ · 4 နေရာ ကျန်သေး"),
            ("en", Some(12), 12, "We are full — waitlist is open, and people always drop out 🤞"),
            (
                "my",
                Some(12),
                14,
                "နေရာ ပြည့်သွားပြီ — စောင့်ဆိုင်းစာရင်း ဖွင့်ထားတယ်၊ ပြုတ်တဲ့သူ အမြဲရှိတယ် 🤞",
            ),
            ("en", Some(0), 3, "We are full — waitlist is open, and people always drop out 🤞"),
        ];
        for (locale, max_players, going, expected) in cases {
            let text = session_announcement(
                &detail(None, max_players, going),
                &options(locale, None, None, false),
                &mut fixed(0.0),
            );
            assert_eq!(text.lines().nth(4).unwrap(), expected, "{locale} {going}/{max_players:?}");
        }
    }

    /// The organizer's own jab wins, trimmed; blank or whitespace falls back to
    /// the joke bank. The trimming is JavaScript's, which leaves U+0085 alone
    /// and takes U+FEFF off.
    #[test]
    fn the_tease_is_the_only_line_the_writer_owns() {
        let written = session_announcement(
            &detail(None, Some(12), 8),
            &options("en", None, Some("  Where were you last week?  "), false),
            &mut fixed(0.0),
        );
        assert_eq!(
            written,
            "Legs itching yet? 🦵\n\n⚽ Fri 08 Aug, 19:30\n\n8 in · 4 spots left\n\nWhere were you last week?\n\nTap in now 👇"
        );

        let blank = session_announcement(
            &detail(None, Some(12), 8),
            &options("en", None, Some("   \t\n  "), false),
            &mut fixed(0.0),
        );
        assert_eq!(
            blank,
            "Legs itching yet? 🦵\n\n⚽ Fri 08 Aug, 19:30\n\n8 in · 4 spots left\n\nEveryone who was \"busy\" last week — you will need a fresh excuse 😏\n\nTap in now 👇"
        );

        let odd_spaces = session_announcement(
            &detail(None, Some(12), 8),
            &options("en", None, Some("\u{feff}\u{85}Oi\u{feff}"), false),
            &mut fixed(0.0),
        );
        assert_eq!(
            odd_spaces,
            "Legs itching yet? 🦵\n\n⚽ Fri 08 Aug, 19:30\n\n8 in · 4 spots left\n\n\u{85}Oi\n\nTap in now 👇"
        );
    }

    #[test]
    fn a_cancelled_game_is_not_a_joke() {
        assert_eq!(
            session_announcement(
                &{
                    let mut off = detail(Some(venue()), Some(12), 8);
                    off.session.status = "cancelled".into();
                    off
                },
                &options("en", Some("https://futsal.example"), None, false),
                &mut fixed(0.0)
            ),
            "🚫 CANCELLED — Fri 08 Aug, 19:30\nBring a white shirt"
        );
        assert_eq!(
            session_announcement(
                &{
                    let mut off = detail(None, None, 8);
                    off.session.status = "cancelled".into();
                    off.session.notes = None;
                    off
                },
                &options("my", None, None, true),
                &mut fixed(0.0)
            ),
            "🚫 ပွဲပျက် — သောကြာ 08 ဩဂုတ်၊ 7:30 PM"
        );
    }

    /// `random()` is allowed to answer 1, and the original clamps it onto the
    /// last line rather than off the end.
    #[test]
    fn a_random_of_one_lands_on_the_last_line() {
        for value in [0.999, 1.0] {
            assert_eq!(
                session_announcement(
                    &detail(None, Some(12), 8),
                    &options("en", None, None, false),
                    &mut fixed(value)
                ),
                "No FIFA this week. The real thing 🎮❌\n\n⚽ Fri 08 Aug, 19:30\n\n8 in · 4 spots left\n\nLast one to arrive buys the water 💧\n\nYou in? 👇"
            );
        }
    }

    /// Every line of the joke bank, in both languages, walked in order.
    #[test]
    fn the_whole_joke_bank() {
        let en = [
            "Legs itching yet? 🦵\n\n⚽ Fri 08 Aug, 19:30\n\n8 in · 4 spots left\n\nEveryone who was \"busy\" last week — you will need a fresh excuse 😏\n\nTap in now 👇",
            "Futsal Friday is back ⚽\n\n⚽ Fri 08 Aug, 19:30\n\n8 in · 4 spots left\n\nBad knee, bad back, big meeting. Not accepted this week 🙅\n\nGet your name down 👇",
            "The pitch is calling. Pick up 📣\n\n⚽ Fri 08 Aug, 19:30\n\n8 in · 4 spots left\n\nIf nobody calls keeper, everybody is keeper 🥅\n\nBefore the spots go 👇",
            "Time to run it back this week!\n\n⚽ Fri 08 Aug, 19:30\n\n8 in · 4 spots left\n\nPS: those of you who still owe money. Yes. You 👀\n\nYou in? 👇",
            "Off the sofa, onto the pitch 🛋➡️⚽\n\n⚽ Fri 08 Aug, 19:30\n\n8 in · 4 spots left\n\nSaid yes and then vanished? There is a list 📋\n\nTap in now 👇",
            "Dig the boots out 👟\n\n⚽ Fri 08 Aug, 19:30\n\n8 in · 4 spots left\n\nDo not think about how you will feel tomorrow morning 💪\n\nGet your name down 👇",
            "Team sheet is open 📝\n\n⚽ Fri 08 Aug, 19:30\n\n8 in · 4 spots left\n\nScore once and you get to bring it up all week 🏆\n\nBefore the spots go 👇",
            "No FIFA this week. The real thing 🎮❌\n\n⚽ Fri 08 Aug, 19:30\n\n8 in · 4 spots left\n\nLast one to arrive buys the water 💧\n\nYou in? 👇",
        ];
        let my = [
            "ခြေထောက်တွေ ယားနေပြီလား? 🦵\n\n⚽ သောကြာ 08 ဩဂုတ်၊ 19:30\n\n8 ယောက် ရှိပြီ · 4 နေရာ ကျန်သေး\n\nပြီးခဲ့တဲ့အပတ်က \"အလုပ်များတယ်\" ဆိုသူများ — အကြောင်းပြချက် အသစ် လိုပြီနော် 😏\n\nလာမယ်ဆိုရင် အခုပဲ နှိပ်လိုက် 👇",
            "ဖူဆယ် သောကြာ ပြန်ရောက်လာပြီ ⚽\n\n⚽ သောကြာ 08 ဩဂုတ်၊ 19:30\n\n8 ယောက် ရှိပြီ · 4 နေရာ ကျန်သေး\n\nဒူးနာတယ်၊ ခါးနာတယ်၊ အစည်းအဝေး ရှိတယ် — ဒီတစ်ပတ် လက်မခံပါ 🙅\n\nနာမည် စာရင်းသွင်းလိုက် 👇",
            "ကွင်းက ခေါ်နေပြီ — ကြားလား? 📣\n\n⚽ သောကြာ 08 ဩဂုတ်၊ 19:30\n\n8 ယောက် ရှိပြီ · 4 နေရာ ကျန်သေး\n\nဂိုးသမား ဘယ်သူမှ မလုပ်ရင် အားလုံး ဂိုးသမား ဖြစ်ကြမယ် 🥅\n\nနေရာ မကုန်ခင် 👇",
            "ဒီတစ်ပတ်လည်း ကန်ဖို့ အချိန်တန်ပြီ!\n\n⚽ သောကြာ 08 ဩဂုတ်၊ 19:30\n\n8 ယောက် ရှိပြီ · 4 နေရာ ကျန်သေး\n\nမှတ်ချက် — ပိုက်ဆံ မရှင်းရသေးသူများ။ ဟုတ်တယ်။ ခင်ဗျားတို့ကို ပြောနေတာ 👀\n\nပါမလား? 👇",
            "ဆိုဖာပေါ်က ထ — ကွင်းထဲ ဆင်း 🛋➡️⚽\n\n⚽ သောကြာ 08 ဩဂုတ်၊ 19:30\n\n8 ယောက် ရှိပြီ · 4 နေရာ ကျန်သေး\n\nလာမယ်ဆိုပြီး ပျောက်သွားသူများ — စာရင်း ရှိတယ်နော် 📋\n\nလာမယ်ဆိုရင် အခုပဲ နှိပ်လိုက် 👇",
            "ဖိနပ်တွေ ထုတ်ထားကြ 👟\n\n⚽ သောကြာ 08 ဩဂုတ်၊ 19:30\n\n8 ယောက် ရှိပြီ · 4 နေရာ ကျန်သေး\n\nမနက်ဖြန် ကြွက်တက်မယ့်အကြောင်း ကြိုမတွေးနဲ့ 💪\n\nနာမည် စာရင်းသွင်းလိုက် 👇",
            "စာရင်း ဖွင့်လိုက်ပြီ 📝\n\n⚽ သောကြာ 08 ဩဂုတ်၊ 19:30\n\n8 ယောက် ရှိပြီ · 4 နေရာ ကျန်သေး\n\nတစ်ဂိုးလောက် သွင်းလိုက်ရင် တစ်ပတ်လုံး ပြောလို့ရတယ် 🏆\n\nနေရာ မကုန်ခင် 👇",
            "ဒီအပတ် ဖီဖာ မဟုတ်ဘူး — တကယ့်ကွင်းထဲ 🎮❌\n\n⚽ သောကြာ 08 ဩဂုတ်၊ 19:30\n\n8 ယောက် ရှိပြီ · 4 နေရာ ကျန်သေး\n\nနောက်ဆုံး ရောက်လာသူ ရေဖိုး တာဝန်ယူ 💧\n\nပါမလား? 👇",
        ];
        for (locale, expected) in [("en", en), ("my", my)] {
            for (i, want) in expected.iter().enumerate() {
                let step = i as f64 / 8.0 + 0.01;
                let cta = (i % 4) as f64 / 4.0 + 0.01;
                let text = session_announcement(
                    &detail(None, Some(12), 8),
                    &options(locale, None, None, false),
                    &mut seq([step, step, cta]),
                );
                assert_eq!(&text, want, "{locale}[{i}]");
            }
        }
    }

    /// A blank venue field is no field at all, exactly as in the summary.
    #[test]
    fn blank_is_the_same_as_absent() {
        let blank = Venue {
            name: "Sân Tao Đàn".into(),
            address: Some(String::new()),
            map_url: Some(String::new()),
            price_note: Some(String::new()),
        };
        assert_eq!(
            session_announcement(
                &detail(Some(blank), Some(12), 8),
                &options("en", None, None, false),
                &mut fixed(0.0)
            ),
            "Legs itching yet? 🦵\n\n⚽ Fri 08 Aug, 19:30\n📍 Sân Tao Đàn\n\n8 in · 4 spots left\n\nEveryone who was \"busy\" last week — you will need a fresh excuse 😏\n\nTap in now 👇"
        );
    }
}
