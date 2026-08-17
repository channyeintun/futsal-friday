//! Scheduled housekeeping, run hourly.
//!
//! Reminders are why this is hourly rather than daily: "three hours before
//! kickoff" cannot be hit by a once-a-day job.
//!
//! The session bookkeeping runs on every tick too. It could be gated to once a
//! day, but it is two indexed queries and entirely idempotent, so running it
//! hourly costs nothing measurable and buys promptness: a finished game opens
//! for payment within the hour, and a missing fixture is created within the hour
//! rather than waiting for tomorrow morning. Gating it would also have made it
//! untestable without mocking the clock.
//!
//!   1. Send any reminders that are due.
//!   2. Close out finished sessions.
//!   3. Make sure the upcoming Friday exists, inheriting last week's venue.
//!
//! Ported from `src/cron.ts`.

use serde_json::json;
use wasm_bindgen::JsValue;
use worker::{console_log, Env, Result as WorkerResult};

use futsal_core::clock::{next_friday_kickoff, SESSION_RUNS_FOR_MS};
use futsal_core::events::{session_channel, LOBBY_CHANNEL};

use crate::db::{get_session_row, SessionRow};
use crate::http::{iso_of, new_id, now_iso};
use crate::js;
use crate::notifications::send_due_notifications;
use crate::realtime::create_pub_sub;

/// What the `scheduled()` handler hands to `waitUntil`.
///
/// `now` defaulted to `new Date()` in the original and the `ScheduledController`
/// was ignored, so a run is anchored on the wall clock at the moment it starts
/// rather than on `event.scheduledTime`. The `_at` variant below takes that
/// instant explicitly — Rust has no default arguments, and the injectable clock
/// is the half worth keeping.
pub async fn run_scheduled_maintenance(env: &Env) -> WorkerResult<()> {
    run_scheduled_maintenance_at(env, js::now_ms()).await
}

pub async fn run_scheduled_maintenance_at(env: &Env, now_ms: f64) -> WorkerResult<()> {
    // Time-sensitive, so it goes first. Isolated so a push outage cannot stop
    // the session bookkeeping below: `send_due_notifications` catches both kinds
    // of failure itself and reports zero for whichever failed, which is what the
    // original's outer `try` was there to guarantee. Nothing is left that could
    // escape it, so there is no branch here for the failure it would have logged.
    let summary = send_due_notifications(env, now_ms).await;
    if summary.session_reminders != 0
        || summary.payment_nudges != 0
        || summary.removed_subscriptions != 0
    {
        // `console.log('notifications', JSON.stringify(summary))` — two
        // arguments, which the runtime renders space-separated.
        console_log!("notifications {}", summary.to_json());
    }

    run_session_maintenance(env, now_ms).await
}

/// The original defaulted `now` here as well, but every call site — its one
/// caller above — passes the instant the run started with, so the two halves of
/// a tick cannot disagree about what time it is.
pub async fn run_session_maintenance(env: &Env, now_ms: f64) -> WorkerResult<()> {
    // Its own instance, not the request-scoped one: there is no request here.
    let pubsub = create_pub_sub(env);

    let completed = complete_finished_sessions(env, now_ms).await?;
    for session in &completed {
        pubsub
            .emit(
                &[&session_channel(&session.id), LOBBY_CHANNEL],
                "session.updated",
                // The rows were read *before* the UPDATE, so their `status` is
                // still `'scheduled'`; the event says what they now are. The
                // fields come off the raw row, hence `starts_at`/`venue_id`.
                &json!({
                    "sessionId": session.id,
                    "status": "completed",
                    "startsAt": session.starts_at,
                    "venueId": session.venue_id,
                    "reason": "completed",
                    // Re-read per emit, not hoisted: this is the moment this
                    // event happened, not the moment the run began.
                    "at": now_iso(),
                }),
            )
            .await;
    }

    let created = ensure_upcoming_session(env, now_ms).await?;
    if let Some(created) = created {
        let db = crate::env::db(env)?;
        // A row that has vanished between the insert and this read emits
        // nothing, rather than an event about a session nobody can fetch.
        if let Some(session) = get_session_row(&db, &created).await? {
            pubsub
                .emit(
                    &[&session_channel(&session.id), LOBBY_CHANNEL],
                    "session.updated",
                    // Mapped `Session` this time, so these are the camelCase
                    // fields — the same wire shape either way.
                    &json!({
                        "sessionId": session.id,
                        "status": session.status,
                        "startsAt": session.starts_at,
                        "venueId": session.venue_id,
                        "reason": "created",
                        "at": now_iso(),
                    }),
                )
                .await;
        }
    }

    Ok(())
}

/// A session is "finished" two hours after kickoff — see `SESSION_RUNS_FOR_MS`,
/// which the team board reads too so that both agree about when the game ended.
async fn complete_finished_sessions(env: &Env, now_ms: f64) -> WorkerResult<Vec<SessionRow>> {
    let cutoff = iso_of(now_ms - SESSION_RUNS_FOR_MS as f64);

    let db = crate::env::db(env)?;
    let read = db
        .prepare("SELECT * FROM sessions WHERE status = 'scheduled' AND starts_at < ?1")
        .bind(&[text(&cutoff)])?
        .all()
        .await?;
    let results: Vec<SessionRow> = read.results()?;

    // Nothing to close out, and no UPDATE either: the write is skipped rather
    // than run against an empty set.
    if results.is_empty() {
        return Ok(Vec::new());
    }

    db.prepare(
        "UPDATE sessions SET status = 'completed', updated_at = ?2
      WHERE status = 'scheduled' AND starts_at < ?1",
    )
    // Cutoff first: `?2` appears earlier in the text than `?1`, and the
    // numbering — not the position — is what decides where each value lands.
    .bind(&[text(&cutoff), text(&now_iso())])?
    .run()
    .await?;

    // The rows as they were read, before the update.
    Ok(results)
}

/// Create the upcoming Friday 19:30 ICT session if the group has nothing
/// scheduled.
///
/// The guard is "is there *any* future scheduled session", not "is there one at
/// exactly this timestamp". That way an organizer who has already moved this
/// week's game to Thursday does not get a duplicate Friday fixture created
/// underneath them.
async fn ensure_upcoming_session(env: &Env, now_ms: f64) -> WorkerResult<Option<String>> {
    let db = crate::env::db(env)?;

    let existing: Option<String> = db
        .prepare("SELECT id FROM sessions WHERE status = 'scheduled' AND starts_at >= ?1 LIMIT 1")
        .bind(&[text(&iso_of(now_ms))])?
        .first(Some("id"))
        .await?;
    if existing.is_some() {
        return Ok(None);
    }

    // Inherit the venue, fee and cap from whatever the group played last, which
    // is almost always what they want again.
    let previous: Option<SessionRow> = db
        .prepare(
            "SELECT * FROM sessions WHERE status <> 'cancelled' ORDER BY starts_at DESC LIMIT 1",
        )
        .first(None)
        .await?;

    let id = new_id("ses");
    let timestamp = now_iso();
    let starts_at = iso_of(next_friday_kickoff(now_ms as i64) as f64);

    let written = db
        .prepare(
            "INSERT INTO sessions
         (id, starts_at, venue_id, status, fee_per_person, max_players, notes,
          created_at, updated_at)
       VALUES (?1, ?2, ?3, 'scheduled', ?4, ?5, NULL, ?6, ?6)",
        )
        // `?6` twice: created_at and updated_at are the same instant, not two
        // reads of the clock. `total_charge` is not written at all.
        .bind(&[
            text(&id),
            text(&starts_at),
            maybe_text(previous.as_ref().and_then(|row| row.venue_id.as_deref())),
            maybe_number(previous.as_ref().and_then(|row| row.fee_per_person)),
            maybe_number(previous.as_ref().and_then(|row| row.max_players)),
            text(&timestamp),
        ])?
        .run()
        .await;
    if let Err(error) = written {
        // The partial unique index on starts_at makes a concurrent or retried run
        // a no-op rather than a duplicate fixture.
        if is_unique_violation(&error) {
            return Ok(None);
        }
        return Err(error);
    }

    Ok(Some(id))
}

/* ------------------------------------------------------------- primitives */

/// `/UNIQUE constraint failed/i.test(error.message)`, which the original wrote
/// inline in its `catch`.
///
/// The D1 binding throws an `Error` whose `message` begins `D1_ERROR:`, and that
/// is the string the regex ran against; `worker` wraps that one in `Error::D1`,
/// whose `Display` shows the *cause* instead. So the message is read off the
/// JavaScript error itself rather than off the wrapper. `routes/sessions.rs`
/// runs the same test on the insert an organizer drives; the two must stay the
/// same test.
fn is_unique_violation(error: &worker::Error) -> bool {
    let message = match error {
        worker::Error::D1(failure) => {
            let inner: &js_sys::Error = failure.as_ref();
            String::from(inner.message())
        }
        other => other.to_string(),
    };
    message.to_lowercase().contains("unique constraint failed")
}

fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

/// `previous?.venue_id ?? null` — no previous session and a null column are the
/// same bind.
fn maybe_text(value: Option<&str>) -> JsValue {
    match value {
        Some(value) => JsValue::from_str(value),
        None => JsValue::NULL,
    }
}

fn maybe_number(value: Option<i64>) -> JsValue {
    match value {
        Some(value) => JsValue::from_f64(value as f64),
        None => JsValue::NULL,
    }
}
