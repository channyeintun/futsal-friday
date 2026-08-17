//! Deciding who to notify, and making sure nobody is notified twice.
//!
//! The cron runs hourly and this is entirely idempotent: every send is gated on
//! inserting a row into `notifications` with a unique `dedupe_key`, so a cron
//! that fires twice, or a retry after a partial failure, sends nothing extra.
//! The key is what defines "the same notification":
//!
//!   session_reminder:<session_id>              once per member, ever
//!   payment_due:<session_id>:<YYYY-Www>        at most once a week per member
//!
//! Ported from `src/notifications.ts`.

use std::collections::HashSet;
use std::future::Future;
use std::task::Poll;

use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;
use worker::d1::D1PreparedStatement;
use worker::{console_error, Env, Result as WorkerResult};

use futsal_core::clock::{
    format_kickoff, format_time, from_zoned_parts, to_zoned_parts, ZonedParts, TZ_OFFSET_MINUTES,
};
use futsal_core::money::format_vnd;

use crate::db::normalize_locale;
use crate::env::reminder_lead_hours;
use crate::http::{iso_of, new_id, now_iso};
use crate::js;
use crate::push::{create_push_sender, PushKeys, PushMessage, PushOutcome, PushSender, PushTarget};

/// Somebody to write to.
struct Recipient {
    member_id: String,
    /// Selected by both recipient queries, and part of the shape the original
    /// defined. Nothing this module sends greets by name — the test push in
    /// `routes/push.rs` is the one that does — so nothing reads it here.
    #[allow(dead_code)]
    member_name: String,
    /// Notification text is written here, so each member gets their own language.
    locale: &'static str,
    /// And their own clock: a reminder saying 19:30 to somebody whose app says
    /// 7:30 PM reads as a bug rather than a preference.
    hour12: bool,
}

/// Raw shape D1 returns for the recipient queries.
///
/// Kept separate and mapped explicitly because `.all<T>()` is an unchecked cast:
/// annotating a snake_case result set as a camelCase type compiles happily and
/// then binds `undefined` at runtime.
#[derive(Deserialize)]
struct RecipientRow {
    member_id: String,
    member_name: String,
    language: String,
    hour12: i64,
}

fn to_recipient(row: &RecipientRow) -> Recipient {
    Recipient {
        member_id: row.member_id.clone(),
        member_name: row.member_name.clone(),
        locale: normalize_locale(&row.language),
        hour12: row.hour12 == 1,
    }
}

/// The three counters the cron logs. Field order is the order
/// `JSON.stringify` wrote them in, because that log line is read by people.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSummary {
    pub session_reminders: i64,
    pub payment_nudges: i64,
    pub removed_subscriptions: i64,
}

impl NotificationSummary {
    /// `JSON.stringify(summary)`.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

pub async fn send_due_notifications(env: &Env, now_ms: f64) -> NotificationSummary {
    let sender = create_push_sender(env);
    let mut summary = NotificationSummary {
        session_reminders: 0,
        payment_nudges: 0,
        removed_subscriptions: 0,
    };
    // Nothing to send with, so nothing is read either — not one query runs.
    if !sender.enabled() {
        return summary;
    }

    let mut removed: HashSet<String> = HashSet::new();

    // Isolated on purpose: a failure in one kind of reminder must not suppress
    // the other. They share nothing but the subscription table.
    match send_session_reminders(env, now_ms, &mut removed).await {
        Ok(sent) => summary.session_reminders = sent,
        Err(error) => console_error!("session reminders failed {:?}", error),
    }

    match send_payment_nudges(env, now_ms, &mut removed).await {
        Ok(sent) => summary.payment_nudges = sent,
        Err(error) => console_error!("payment nudges failed {:?}", error),
    }

    summary.removed_subscriptions = removed.len() as i64;
    summary
}

/* ------------------------------------------------------- match is coming up */

#[derive(Deserialize)]
struct ReminderSessionRow {
    id: String,
    starts_at: String,
    /// Selected by the statement and read by nothing. Kept on the row because
    /// the statement text is the contract with the database, and a column that
    /// silently stopped being fetched would be the easier thing to get wrong.
    #[allow(dead_code)]
    fee_per_person: Option<i64>,
    venue_name: Option<String>,
}

/// "Kickoff in a few hours" to everyone actually playing.
///
/// The window is [lead, lead + 1h) because the cron runs hourly — a session is
/// caught by exactly one run. Waitlisted players are left out on purpose: being
/// reminded about a game you are not in is noise.
async fn send_session_reminders(
    env: &Env,
    now_ms: f64,
    removed: &mut HashSet<String>,
) -> WorkerResult<i64> {
    let lead = reminder_lead_hours(env);
    let from = iso_of(now_ms + lead * 3_600_000.0);
    let to = iso_of(now_ms + (lead + 1.0) * 3_600_000.0);

    let db = crate::env::db(env)?;
    let read = db
        .prepare(
            "SELECT s.id, s.starts_at, s.fee_per_person, v.name AS venue_name
       FROM sessions s
       LEFT JOIN venues v ON v.id = s.venue_id
      WHERE s.status = 'scheduled' AND s.starts_at >= ?1 AND s.starts_at < ?2",
        )
        .bind(&[text(&from), text(&to)])?
        .all()
        .await?;
    let sessions: Vec<ReminderSessionRow> = read.results()?;

    let mut sent = 0i64;

    for session in &sessions {
        let read = db
            .prepare(
                "SELECT m.id AS member_id, m.name AS member_name, m.language, m.hour12
         FROM registrations r
         JOIN members m ON m.id = r.member_id
        WHERE r.session_id = ?1 AND r.status = 'in'
          AND m.active = 1 AND m.notify_session = 1",
            )
            .bind(&[text(&session.id)])?
            .all()
            .await?;
        let players: Vec<RecipientRow> = read.results()?;

        // `Math.round` is half-up rather than half-away-from-zero; the lead is
        // always positive, but the definition is what travels. A lead of 2.5
        // therefore says "3h" while the window stays 2.5–3.5 hours out.
        let hours = (lead + 0.5).floor() as i64;
        let message = |locale: &str, hour12: bool| -> WorkerResult<PushMessage> {
            let m = messages_for(locale);
            Ok(PushMessage {
                title: (m.match_title)(&format_time(as_date(&session.starts_at)?, hour12)),
                body: match session.venue_name.as_deref() {
                    Some(venue) if !venue.is_empty() => (m.match_body_at_venue)(hours, venue),
                    _ => (m.match_body)(hours),
                },
                url: Some(format!("/session/{}", session.id)),
                tag: Some(format!("session-{}", session.id)),
                // Pointless to deliver after the game has finished.
                ttl: Some(((lead * 3600.0).floor() as i64).max(600)),
            })
        };

        let recipients: Vec<Recipient> = players.iter().map(to_recipient).collect();
        sent += deliver(
            env,
            &recipients,
            message,
            &format!("session_reminder:{}", session.id),
            "session_reminder",
            removed,
        )
        .await?;
    }

    Ok(sent)
}

/* ------------------------------------------------------------ still unpaid */

#[derive(Deserialize)]
struct DebtRow {
    session_id: String,
    amount_due: i64,
    member_id: String,
    member_name: String,
    language: String,
    hour12: i64,
    starts_at: String,
}

/// Nudge people who owe money for a session that has already been settled.
///
/// Only fires once a day's grace has passed — nobody wants a notification an
/// hour after the whistle — and at most weekly per session thereafter, so an
/// unpaid debt becomes a gentle recurring reminder rather than a daily nag.
async fn send_payment_nudges(
    env: &Env,
    now_ms: f64,
    removed: &mut HashSet<String>,
) -> WorkerResult<i64> {
    let grace_cutoff = iso_of(now_ms - 24.0 * 3_600_000.0);
    let week = iso_week_key(now_ms as i64);

    let db = crate::env::db(env)?;
    let read = db
        .prepare(
            "SELECT p.session_id, p.amount_due, m.id AS member_id, m.name AS member_name,
            m.language, m.hour12, s.starts_at
       FROM payments p
       JOIN members m ON m.id = p.member_id
       JOIN sessions s ON s.id = p.session_id
      WHERE p.status = 'unpaid'
        AND p.amount_due > 0
        AND s.status = 'completed'
        AND s.starts_at < ?1
        AND m.active = 1
        AND m.notify_payment = 1",
        )
        .bind(&[text(&grace_cutoff)])?
        .all()
        .await?;
    let debts: Vec<DebtRow> = read.results()?;

    let mut sent = 0i64;

    for debt in &debts {
        // `hour12` alongside the locale, like the match reminder above. Both are
        // properties of the person being written to, and the column exists so the
        // server can honour them — a member reading 7:30 PM in the app should not
        // be pushed 19:30 by it.
        let message = |locale: &str, hour12: bool| -> WorkerResult<PushMessage> {
            let m = messages_for(locale);
            Ok(PushMessage {
                title: m.unpaid_title.to_string(),
                body: (m.unpaid_body)(
                    &format_vnd(debt.amount_due),
                    &format_kickoff(as_date(&debt.starts_at)?, locale, hour12),
                ),
                url: Some(format!("/payments/{}", debt.session_id)),
                tag: Some(format!("payment-{}", debt.session_id)),
                ttl: Some(3 * 24 * 3600),
            })
        };

        sent += deliver(
            env,
            &[Recipient {
                member_id: debt.member_id.clone(),
                member_name: debt.member_name.clone(),
                locale: normalize_locale(&debt.language),
                hour12: debt.hour12 == 1,
            }],
            message,
            &format!("payment_due:{}:{week}", debt.session_id),
            "payment_due",
            removed,
        )
        .await?;
    }

    Ok(sent)
}

/* -------------------------------------------------------------- delivery */

/// Send one message to a set of members, once each.
///
/// The `notifications` row is inserted *before* sending, and a duplicate-key
/// conflict is the signal to skip. Claiming first means a crash mid-send costs
/// at most one missed reminder; claiming after would risk sending the same
/// notification on every subsequent run.
///
/// `message` is built per recipient, because the text is in their language and
/// on their clock.
async fn deliver(
    env: &Env,
    recipients: &[Recipient],
    message: impl Fn(&str, bool) -> WorkerResult<PushMessage>,
    dedupe_key: &str,
    kind: &str,
    removed: &mut HashSet<String>,
) -> WorkerResult<i64> {
    if recipients.is_empty() {
        return Ok(0);
    }

    // A second sender: the one in `send_due_notifications` exists only to answer
    // whether push is configured at all.
    let sender = create_push_sender(env);
    let mut sent = 0i64;

    for recipient in recipients {
        let claimed = claim(env, &recipient.member_id, kind, dedupe_key).await?;
        if !claimed {
            continue;
        }

        let written = message(recipient.locale, recipient.hour12)?;
        if push_to_member(env, &sender, &recipient.member_id, &written, removed).await? {
            sent += 1;
        }
    }

    Ok(sent)
}

#[derive(Deserialize)]
struct SubscriptionRow {
    id: String,
    endpoint: String,
    p256dh: String,
    auth: String,
}

/// Push to every live subscription one member has, and keep the table honest:
/// a `410 Gone` endpoint is deleted, a failure is counted towards the cut-off,
/// a success clears the count.
///
/// Separate from [`deliver`] because not everything that notifies somebody is a
/// scheduled reminder — a join request happens once, in a request handler, with
/// nothing to deduplicate against.
async fn push_to_member(
    env: &Env,
    sender: &PushSender,
    member_id: &str,
    text_message: &PushMessage,
    removed: &mut HashSet<String>,
) -> WorkerResult<bool> {
    let db = crate::env::db(env)?;
    let read = db
        .prepare(
            "SELECT id, endpoint, p256dh, auth FROM push_subscriptions
      WHERE member_id = ?1 AND failure_count < 5",
        )
        .bind(&[text(member_id)])?
        .all()
        .await?;
    let subscriptions: Vec<SubscriptionRow> = read.results()?;

    // Nobody subscribed: nothing sent and nothing written.
    if subscriptions.is_empty() {
        return Ok(false);
    }

    let targets: Vec<PushTarget> = subscriptions
        .iter()
        .map(|row| PushTarget {
            subscription_id: row.id.clone(),
            endpoint: row.endpoint.clone(),
            keys: PushKeys { p256dh: row.p256dh.clone(), auth: row.auth.clone() },
        })
        .collect();

    // Every endpoint at once, as `Promise.all` did: one member's phone being
    // slow must not hold up their laptop.
    let sends: Vec<_> = targets
        .iter()
        .map(|target| async move { sender.send(target, text_message).await })
        .collect();
    let outcomes = join_all(sends).await;

    let mut statements: Vec<D1PreparedStatement> = Vec::new();

    // Built in this order — gone, then failed, then sent — because that is the
    // order they go into the one batch below.
    for outcome in &outcomes {
        if let PushOutcome::Gone { subscription_id } = outcome {
            removed.insert(subscription_id.clone());
            statements.push(
                db.prepare("DELETE FROM push_subscriptions WHERE id = ?1")
                    .bind(&[text(subscription_id)])?,
            );
        }
    }
    for outcome in &outcomes {
        if let PushOutcome::Failed { subscription_id, reason } = outcome {
            console_error!("push failed for {}: {}", subscription_id, reason);
            statements.push(
                db.prepare(
                    "UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?1",
                )
                .bind(&[text(subscription_id)])?,
            );
        }
    }
    let mut ok = 0usize;
    for outcome in &outcomes {
        if let PushOutcome::Sent { subscription_id } = outcome {
            ok += 1;
            statements.push(
                db.prepare(
                    "UPDATE push_subscriptions SET failure_count = 0, last_success_at = ?2 WHERE id = ?1",
                )
                // A fresh clock read per statement, as the original took one.
                .bind(&[text(subscription_id), text(&now_iso())])?,
            );
        }
    }

    if !statements.is_empty() {
        db.batch(statements).await?;
    }

    Ok(ok > 0)
}

#[derive(Deserialize)]
struct OrganizerRow {
    member_id: String,
    language: Option<String>,
}

/// Tell the organizers that somebody is in the waiting room.
///
/// Not deduplicated and not scheduled: each request is its own event, and there
/// is no cron re-run to guard against. Written in each organizer's own
/// language, like every other notification this app sends.
pub async fn notify_organizers_of_request(env: &Env, name: &str) -> WorkerResult<()> {
    let db = crate::env::db(env)?;
    let read = db
        .prepare(
            "SELECT id AS member_id, language FROM members
      WHERE is_organizer = 1 AND active = 1 AND approved_at IS NOT NULL",
        )
        .all()
        .await?;
    let results: Vec<OrganizerRow> = read.results()?;
    if results.is_empty() {
        return Ok(());
    }

    let sender = create_push_sender(env);
    let mut removed: HashSet<String> = HashSet::new();

    for row in &results {
        let m = messages_for(normalize_locale(row.language.as_deref().unwrap_or_default()));
        push_to_member(
            env,
            &sender,
            &row.member_id,
            // No tag and no ttl: the sender's own 6h default holds and no
            // `Topic` header goes out, so these never collapse onto each other.
            &PushMessage {
                title: m.join_request_title.to_string(),
                body: (m.join_request_body)(name),
                url: Some("/admin".to_string()),
                tag: None,
                ttl: None,
            },
            &mut removed,
        )
        .await?;
    }

    Ok(())
}

/// Returns false when this notification has already been sent to this member.
async fn claim(env: &Env, member_id: &str, kind: &str, dedupe_key: &str) -> WorkerResult<bool> {
    // D1 reports a bound `undefined` as an opaque type error with no column name.
    // Fail with something that says which value went missing instead.
    if member_id.is_empty() {
        return Err(worker::Error::RustError(format!(
            "claim({kind}, {dedupe_key}): memberId is empty"
        )));
    }

    let db = crate::env::db(env)?;
    let result = db
        .prepare(
            "INSERT INTO notifications (id, member_id, kind, dedupe_key, sent_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (member_id, dedupe_key) DO NOTHING",
        )
        .bind(&[
            text(&new_id("ntf")),
            text(member_id),
            text(kind),
            text(dedupe_key),
            text(&now_iso()),
        ])?
        .run()
        .await?;

    // `DO NOTHING` on a conflict writes no row, and that zero is the whole
    // dedupe primitive.
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

/// ISO-8601 week key (`2026-W32`) in Ho Chi Minh time, so a weekly nudge lands
/// on the same day of the week locally rather than drifting across a UTC edge.
pub fn iso_week_key(instant_ms: i64) -> String {
    let local = to_zoned_parts(instant_ms);
    // `new Date(Date.UTC(local.year, local.month - 1, local.day))` — the ICT
    // calendar date reinterpreted as a UTC midnight, which turns everything
    // below into whole days of arithmetic.
    let date = utc_midnight(local.year, local.month, local.day);

    // Shift to the Thursday of this week: ISO weeks are numbered by the year
    // containing their Thursday.
    let day = (utc_parts(date).weekday + 6).rem_euclid(7); // Monday = 0
    let date = date + (3 - day) * MS_PER_DAY;

    let iso_year = utc_parts(date).year;
    let first_thursday = utc_midnight(iso_year, 1, 4);
    let first_day = (utc_parts(first_thursday).weekday + 6).rem_euclid(7);
    let first_thursday = first_thursday + (3 - first_day) * MS_PER_DAY;

    // Both ends are Thursdays at UTC midnight, so the gap is an exact number of
    // weeks and the original's `Math.round` had nothing left to round.
    let week = 1 + (date - first_thursday) / (7 * MS_PER_DAY);
    format!("{iso_year}-W{week:02}")
}

/* ---------------------------------------------------------------- i18n */

/// The push strings this module needs, from `shared/src/i18n/{en,my}.ts`.
///
/// The catalogue is a per-member language because the notification is written
/// on the server and read on a phone the server never sees. Note the Burmese
/// argument order flips in `match_body_at_venue` (venue first) and
/// `unpaid_body` (when first): the sentence is not the English one with the
/// words swapped out.
struct PushMessages {
    match_title: fn(&str) -> String,
    match_body_at_venue: fn(i64, &str) -> String,
    match_body: fn(i64) -> String,
    unpaid_title: &'static str,
    unpaid_body: fn(&str, &str) -> String,
    join_request_title: &'static str,
    join_request_body: fn(&str) -> String,
}

fn messages_for(locale: &str) -> PushMessages {
    if locale == "my" {
        PushMessages {
            match_title: |time| format!("ယနေ့ ဖူဆယ်၊ {time}"),
            match_body_at_venue: |hours, venue| {
                format!("{venue} တွင် {hours} နာရီခန့်အကြာ ပွဲစပါမည်။")
            },
            match_body: |hours| format!("{hours} နာရီခန့်အကြာ ပွဲစပါမည်။"),
            unpaid_title: "ငွေပေးရန် ကျန်ရှိသေးသည်",
            unpaid_body: |amount, when| format!("{when} အတွက် {amount}။"),
            join_request_title: "ဝင်ခွင့် တောင်းနေသူ ရှိတယ်",
            join_request_body: |name| format!("{name} က ဝင်ခွင့် စောင့်နေတယ်။"),
        }
    } else {
        PushMessages {
            match_title: |time| format!("Futsal today, {time}"),
            match_body_at_venue: |hours, venue| format!("Kickoff in about {hours}h at {venue}."),
            match_body: |hours| format!("Kickoff in about {hours}h."),
            unpaid_title: "Still to settle up",
            unpaid_body: |amount, when| format!("{amount} for {when}."),
            join_request_title: "Someone wants to join",
            join_request_body: |name| format!("{name} is waiting to be let in."),
        }
    }
}

/* ------------------------------------------------------------- primitives */

const MS_PER_DAY: i64 = 86_400_000;

/// `Date.UTC(year, month - 1, day)`.
///
/// `from_zoned_parts` reads its parts as ICT, so undoing that shift lands on the
/// UTC midnight the original's `Date.UTC` produced.
fn utc_midnight(year: i64, month: i64, day: i64) -> i64 {
    from_zoned_parts(year, month, day, 0, 0) + TZ_OFFSET_MINUTES * 60_000
}

/// The `getUTC*` fields of an instant.
///
/// `to_zoned_parts` reads ICT; shifting the instant back by the same offset
/// first makes it read UTC.
fn utc_parts(instant_ms: i64) -> ZonedParts {
    to_zoned_parts(instant_ms - TZ_OFFSET_MINUTES * 60_000)
}

/// `asDate(value)` — the shared time helpers throw `Invalid date: <value>` on
/// anything unparseable rather than formatting `NaN:NaN` into a notification.
/// The throw is caught one level up as "session reminders failed" / "payment
/// nudges failed", so one corrupt `starts_at` stops that kind of reminder for
/// this tick instead of pushing nonsense.
fn as_date(value: &str) -> WorkerResult<i64> {
    let ms = js::parse_date(value);
    if ms.is_nan() {
        return Err(worker::Error::RustError(format!("Invalid date: {value}")));
    }
    Ok(ms as i64)
}

fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

/// `Promise.all(…)` over a set of futures.
///
/// Rust futures do nothing until polled, so awaiting them one at a time would
/// turn a fan-out across a member's devices into a queue. Polling all of them
/// from one future starts every request before any is waited on, which is what
/// `Promise.all` did.
async fn join_all<F: Future>(futures: Vec<F>) -> Vec<F::Output> {
    let mut pending: Vec<_> = futures.into_iter().map(Box::pin).collect();
    let mut done: Vec<Option<F::Output>> = pending.iter().map(|_| None).collect();
    std::future::poll_fn(move |cx| {
        let mut all_ready = true;
        for (slot, future) in done.iter_mut().zip(pending.iter_mut()) {
            if slot.is_some() {
                continue;
            }
            match future.as_mut().poll(cx) {
                Poll::Ready(value) => *slot = Some(value),
                Poll::Pending => all_ready = false,
            }
        }
        if all_ready {
            Poll::Ready(done.iter_mut().map(|slot| slot.take().expect("all ready")).collect())
        } else {
            Poll::Pending
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every expectation here was read off the original `isoWeekKey` running on
    /// the same instants.
    #[test]
    fn iso_weeks_are_numbered_by_their_thursday() {
        // 2026-08-16T12:00:00Z — a Sunday evening in Ho Chi Minh City.
        assert_eq!(iso_week_key(1_786_881_600_000), "2026-W33");
        // 2026-08-16T18:00:00Z is still Sunday in UTC but already 01:00 Monday
        // in Ho Chi Minh City — the next week, which is the whole reason this
        // is computed on the local calendar rather than on UTC.
        assert_eq!(iso_week_key(1_786_903_200_000), "2026-W34");
        // 2026-01-01T00:00:00Z is 07:00 on New Year's Day locally: a Thursday,
        // and therefore week 1 of 2026.
        assert_eq!(iso_week_key(1_767_225_600_000), "2026-W01");
        // 2025-12-31T20:00:00Z is already 03:00 on 1 January locally.
        assert_eq!(iso_week_key(1_767_211_200_000), "2026-W01");
        // 2027-01-01T00:00:00Z is a Friday locally, whose Thursday falls in
        // 2026 — so it is the 53rd week of the *previous* ISO year.
        assert_eq!(iso_week_key(1_798_761_600_000), "2026-W53");
    }
}
