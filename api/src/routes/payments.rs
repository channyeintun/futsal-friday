//! Money routes.
//!
//! Ported from `src/routes/payments.ts`.
//!
//! The split is *derived*, never accumulated: settling recomputes every share
//! from the total charge and the current overrides. Editing one person's amount
//! therefore re-balances everybody else automatically, and re-settling the same
//! session twice produces the same numbers instead of drifting.
//!
//! The arithmetic itself is not here — it is `futsal_core::money`, the same
//! functions the web app splits with, so the two can never disagree about who
//! owes what.

use futsal_core::attendance::{arrived_guests, arrived_heads, AttendanceInput, Status};
use futsal_core::events::{session_channel, LOBBY_CHANNEL};
use futsal_core::money::{amount_for, split_with_overrides, SplitInput, DEFAULT_GRANULARITY};
use serde::Serialize;
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::d1::{D1Database, D1PreparedStatement};
use worker::{Env, Method, Request, Response};

use crate::db::{self, PaymentRow, Registration, Session};
use crate::http::{self, ApiResult};
use crate::middleware::{require_organizer, Identity};
use crate::realtime::create_pub_sub;

/// The one entry point the dispatcher calls. `None` means "not one of mine",
/// which is how a request falls through to the next router and, past the last
/// of them, to the 404 — the same thing Hono's first-match dispatch did.
pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    let path = req.path();
    let rest = path.strip_prefix('/')?;
    let segments: Vec<&str> = rest.split('/').collect();
    let method = req.method();

    // `:id` and `:paymentId` are `[^/]+` in Hono's router, so an empty segment
    // matches no route at all rather than being read as an empty id.
    match segments.as_slice() {
        ["sessions", id, "settle"] if !id.is_empty() => match method {
            Method::Post => Some(settle(req, env, identity, &decode_param(id)).await),
            _ => None,
        },
        ["sessions", id, "payments"] if !id.is_empty() => match method {
            Method::Get => Some(list(env, &decode_param(id)).await),
            _ => None,
        },
        ["sessions", id, "payments", "me", "claim"] if !id.is_empty() => match method {
            Method::Post => Some(claim(req, env, identity, &decode_param(id)).await),
            Method::Delete => Some(unclaim(env, identity, &decode_param(id)).await),
            _ => None,
        },
        ["payments", payment_id, "review"] if !payment_id.is_empty() => match method {
            Method::Post => Some(review(req, env, identity, &decode_param(payment_id)).await),
            _ => None,
        },
        ["payments", payment_id, "override"] if !payment_id.is_empty() => match method {
            Method::Patch => {
                Some(override_amount(req, env, identity, &decode_param(payment_id)).await)
            }
            _ => None,
        },
        ["payments", payment_id, "proof"] if !payment_id.is_empty() => match method {
            Method::Get => Some(proof(env, identity, &decode_param(payment_id)).await),
            _ => None,
        },
        _ => None,
    }
}

/// `{ payment: … }` — the shape every single-payment route answers with, and
/// `null` when the row vanished between the write and the read back.
#[derive(Serialize)]
struct PaymentEnvelope {
    payment: Option<db::Payment>,
}

/* ---------------------------------------------------------------- handlers */

/// Enter the field charge and split it. Also marks the session completed.
async fn settle(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    session_id: &str,
) -> ApiResult<Response> {
    require_organizer(identity)?;
    let input = parse_settle(&read_json(req).await?)?;

    let db_handle = crate::env::db(env)?;
    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    if session.status == "cancelled" {
        return Err(http::conflict("That session was cancelled"));
    }

    // Array order, and a later entry for the same member wins — `Map.set`.
    let mut overrides: Vec<(String, Option<i64>)> = Vec::new();
    for (member_id, amount) in &input.overrides {
        set_override(&mut overrides, member_id, Some(*amount));
    }

    apply_split(
        &db_handle,
        &session,
        input.total_charge,
        &overrides,
        input.granularity.unwrap_or(DEFAULT_GRANULARITY),
    )
    .await?;

    // Taken *after* the split, so this is deliberately not the timestamp the
    // payment rows carry.
    let timestamp = http::now_iso();
    db_handle
        .prepare(
            "UPDATE sessions SET total_charge = ?2, status = 'completed', updated_at = ?3 WHERE id = ?1",
        )
        .bind(&[text(session_id), number(input.total_charge), text(&timestamp)])?
        .run()
        .await?;

    let Some(updated) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };

    // One event for the whole settlement rather than one per player: a 15-person
    // session would otherwise cost 15 emits (45 Redis commands) for what is a
    // single logical change.
    let channel = session_channel(session_id);
    create_pub_sub(env)
        .emit(
            &[&channel, LOBBY_CHANNEL],
            "session.updated",
            &json!({
                "sessionId": session_id,
                "status": updated.status,
                "startsAt": updated.starts_at,
                "venueId": updated.venue_id,
                "reason": "settled",
                "at": timestamp,
            }),
        )
        .await;

    Ok(Response::from_json(&db::load_payment_summary(&db_handle, &updated).await?)?)
}

/// No organizer requirement: the whole group can see who still owes what.
async fn list(env: &Env, session_id: &str) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    Ok(Response::from_json(&db::load_payment_summary(&db_handle, &session).await?)?)
}

/// "I've transferred it" — optionally with a screenshot.
async fn claim(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    session_id: &str,
) -> ApiResult<Response> {
    let input = parse_claim(&read_json(req).await?)?;

    let db_handle = crate::env::db(env)?;
    let Some(payment) = find_payment(&db_handle, session_id, &identity.member_id).await? else {
        return Err(http::not_found("Nothing to pay for this session yet"));
    };
    if payment.status == "confirmed" {
        return Err(http::conflict("That payment is already confirmed"));
    }

    let timestamp = http::now_iso();
    db_handle
        .prepare(
            "UPDATE payments
          SET status = 'pending', claimed_at = ?2, proof_key = COALESCE(?3, proof_key),
              note = ?4, reject_reason = NULL, updated_at = ?2
        WHERE id = ?1",
        )
        .bind(&[
            text(&payment.id),
            text(&timestamp),
            // `COALESCE`, so a claim without a screenshot keeps the one already
            // attached — but `note` below is written unconditionally, and null
            // clears it.
            optional_text(input.proof_key.as_deref()),
            optional_text(input.note.as_deref()),
        ])?
        .run()
        .await?;

    let updated = find_payment_by_id(&db_handle, &payment.id).await?;
    create_pub_sub(env)
        .emit(
            &[&session_channel(session_id)],
            "payment.claimed",
            &json!({
                "sessionId": session_id,
                "memberId": identity.member_id,
                // The caller's own name, not the one joined onto the payment row.
                "memberName": identity.name,
                // The amount as it stood *before* the update.
                "amountDue": payment.amount_due,
                "hasProof": updated.as_ref().and_then(|row| row.proof_key.as_ref()).is_some(),
                "at": timestamp,
            }),
        )
        .await;

    Ok(Response::from_json(&PaymentEnvelope {
        payment: updated.as_ref().map(db::to_payment),
    })?)
}

/// Undo a claim made by mistake, as long as it is still unreviewed.
///
/// No body is read, and no event is emitted: nothing anybody else is looking at
/// has changed.
async fn unclaim(env: &Env, identity: &Identity, session_id: &str) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let Some(payment) = find_payment(&db_handle, session_id, &identity.member_id).await? else {
        return Err(http::not_found("Nothing to pay for this session yet"));
    };
    if payment.status == "confirmed" {
        return Err(http::conflict("That payment is already confirmed"));
    }

    let timestamp = http::now_iso();
    db_handle
        .prepare(
            "UPDATE payments SET status = 'unpaid', claimed_at = NULL, updated_at = ?2 WHERE id = ?1",
        )
        // `proof_key`, `note` and `reject_reason` are left alone: taking the
        // claim back is not the same as taking the screenshot back.
        .bind(&[text(&payment.id), text(&timestamp)])?
        .run()
        .await?;

    let updated = find_payment_by_id(&db_handle, &payment.id).await?;
    Ok(Response::from_json(&PaymentEnvelope {
        payment: updated.as_ref().map(db::to_payment),
    })?)
}

/// Organizer verdict on a claimed payment.
async fn review(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    payment_id: &str,
) -> ApiResult<Response> {
    require_organizer(identity)?;
    let input = parse_review(&read_json(req).await?)?;

    let db_handle = crate::env::db(env)?;
    // Reviewing a payment nobody claimed is not blocked: an organizer who was
    // handed cash on the pitch still has to be able to mark it paid.
    let Some(payment) = find_payment_by_id(&db_handle, payment_id).await? else {
        return Err(http::not_found("No such payment"));
    };

    let timestamp = http::now_iso();
    let pubsub = create_pub_sub(env);
    let channel = session_channel(&payment.session_id);

    if input.confirm {
        db_handle
            .prepare(
                "UPDATE payments
            SET status = 'confirmed', confirmed_at = ?2, confirmed_by = ?3,
                reject_reason = NULL, updated_at = ?2
          WHERE id = ?1",
            )
            .bind(&[text(payment_id), text(&timestamp), text(&identity.member_id)])?
            .run()
            .await?;

        pubsub
            .emit(
                &[&channel],
                "payment.confirmed",
                &json!({
                    "sessionId": payment.session_id,
                    "memberId": payment.member_id,
                    "memberName": payment.member_name,
                    "amountDue": payment.amount_due,
                    "at": timestamp,
                }),
            )
            .await;
    } else {
        // Back to unpaid, keeping the screenshot so the two of them can compare
        // notes about what went wrong.
        db_handle
            .prepare(
                "UPDATE payments
            SET status = 'unpaid', claimed_at = NULL, confirmed_at = NULL,
                reject_reason = ?3, updated_at = ?2
          WHERE id = ?1",
            )
            .bind(&[
                text(payment_id),
                text(&timestamp),
                optional_text(input.reason.as_deref()),
            ])?
            .run()
            .await?;

        pubsub
            .emit(
                &[&channel],
                "payment.rejected",
                &json!({
                    "sessionId": payment.session_id,
                    "memberId": payment.member_id,
                    "memberName": payment.member_name,
                    "reason": input.reason,
                    "at": timestamp,
                }),
            )
            .await;
    }

    let updated = find_payment_by_id(&db_handle, payment_id).await?;
    Ok(Response::from_json(&PaymentEnvelope {
        payment: updated.as_ref().map(db::to_payment),
    })?)
}

/// Pin one person's amount (someone brought the ball, someone left at half
/// time). Everyone else's share is recomputed from what is left.
async fn override_amount(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    payment_id: &str,
) -> ApiResult<Response> {
    require_organizer(identity)?;
    let amount = parse_override(&read_json(req).await?)?;

    let db_handle = crate::env::db(env)?;
    let Some(payment) = find_payment_by_id(&db_handle, payment_id).await? else {
        return Err(http::not_found("No such payment"));
    };

    let Some(session) = db::get_session_row(&db_handle, &payment.session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    let Some(total_charge) = session.total_charge else {
        return Err(http::conflict("Settle the session before editing amounts"));
    };

    // No granularity argument, so the default grain is used however coarse or
    // fine the original settlement was.
    apply_split(
        &db_handle,
        &session,
        total_charge,
        &[(payment.member_id.clone(), amount)],
        DEFAULT_GRANULARITY,
    )
    .await?;

    // The session channel only — nothing on the lobby screen changed.
    create_pub_sub(env)
        .emit(
            &[&session_channel(&session.id)],
            "session.updated",
            &json!({
                "sessionId": session.id,
                "status": session.status,
                "startsAt": session.starts_at,
                "venueId": session.venue_id,
                "reason": "settled",
                // A fresh reading, so not the timestamp `apply_split` wrote.
                "at": http::now_iso(),
            }),
        )
        .await;

    // Computed from the session as it was already read: this route does not
    // touch the session row, so its `total_charge` is still current.
    Ok(Response::from_json(&db::load_payment_summary(&db_handle, &session).await?)?)
}

/// Stream a payment screenshot out of R2.
///
/// Object keys never leave the server: the only way to read a proof is through
/// this route, which is restricted to the organizer and the member who
/// uploaded it.
async fn proof(env: &Env, identity: &Identity, payment_id: &str) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let Some(payment) = find_payment_by_id(&db_handle, payment_id).await? else {
        return Err(http::not_found("No such payment"));
    };
    if !identity.is_organizer && payment.member_id != identity.member_id {
        return Err(http::forbidden_default());
    }
    // Truthiness: an empty key is no key.
    let Some(key) = payment.proof_key.filter(|key| !key.is_empty()) else {
        return Err(http::not_found("No screenshot attached"));
    };

    let bucket = crate::env::proofs(env)?;
    let Some(object) = bucket.get(key).execute().await? else {
        return Err(http::not_found("Screenshot is no longer stored"));
    };

    let headers = worker::Headers::new();
    headers.set(
        "Content-Type",
        object.http_metadata().content_type.as_deref().unwrap_or("application/octet-stream"),
    )?;
    // Private, because the object is one person's bank screenshot; an hour,
    // because the same thumbnail is opened repeatedly while a list is reviewed.
    headers.set("Cache-Control", "private, max-age=3600")?;
    headers.set("Content-Disposition", "inline")?;

    // Handed to the runtime as a stream rather than buffered here: the Worker
    // then spends no CPU time on the transfer, and `new Response(object.body)`
    // did not buffer either.
    let body = match object.body() {
        Some(body) => body.response_body()?,
        None => worker::ResponseBody::Empty,
    };
    Ok(Response::from_body(body)?.with_headers(headers))
}

/* ----------------------------------------------------------------- helpers */

/// Recompute and persist every player's share.
///
/// `new_overrides` is merged over the overrides already stored, so callers can
/// change one amount without restating the rest. Existing payment *status* is
/// untouched — re-splitting must not un-confirm somebody who has already paid.
async fn apply_split(
    db: &D1Database,
    session: &Session,
    total_charge: i64,
    new_overrides: &[(String, Option<i64>)],
    granularity: i64,
) -> ApiResult<()> {
    let registrations = db::list_registrations(db, &session.id).await?;
    // Who was on the pitch, not who said they would be. Unmarked still means
    // present for anyone who was `in`, so a roster nobody checked splits exactly
    // as it always did; the difference is that a no-show can now be excluded,
    // and a reserve who played can be included.
    let players: Vec<&Registration> = registrations
        .iter()
        .filter(|registration| arrived_heads(&attendance_of(registration)) > 0)
        .collect();
    if players.is_empty() {
        return Err(http::conflict("Nobody is down as having played that session"));
    }

    let existing = db::list_payments(db, &session.id).await?;
    let mut overrides: Vec<(String, Option<i64>)> = Vec::new();
    for payment in &existing {
        set_override(&mut overrides, &payment.member_id, payment.amount_override);
    }
    // New overrides win, an explicit `null` included — that is how one is
    // cleared.
    for (member_id, amount) in new_overrides {
        set_override(&mut overrides, member_id, *amount);
    }

    // Weighted by heads: whoever brought friends pays for them. An override is
    // read as covering that person's whole party, which is what "Bao pays
    // 200.000" means when Bao arrived with two mates. Registration order
    // (`position ASC`) decides who receives the extra granularity steps, which
    // is what makes re-settling reproducible.
    let payers: Vec<SplitInput> = players
        .iter()
        .map(|player| SplitInput {
            id: player.member_id.clone(),
            over: lookup_override(&overrides, &player.member_id),
            heads: arrived_heads(&attendance_of(player)),
        })
        .collect();
    let shares = split_with_overrides(total_charge, &payers, granularity);

    let timestamp = http::now_iso();
    let mut statements: Vec<D1PreparedStatement> = Vec::with_capacity(players.len() + 1);
    for player in &players {
        statements.push(
            db.prepare(
                // `guests` is snapshotted, not looked up later: the charge has to
                // stay explainable on its own. "Why do I owe 210.000?" is
                // answered by the row saying it was billed for three heads,
                // whatever the registration says by the time anybody asks.
                "INSERT INTO payments
           (id, session_id, member_id, amount_due, amount_override, guests, status,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?7, 'unpaid', ?6, ?6)
         ON CONFLICT (session_id, member_id) DO UPDATE SET
           amount_due = excluded.amount_due,
           amount_override = excluded.amount_override,
           guests = excluded.guests,
           updated_at = excluded.updated_at",
            )
            .bind(&[
                text(&http::new_id("pay")),
                text(&session.id),
                text(&player.member_id),
                number(amount_for(&shares, &player.member_id)),
                optional_number(lookup_override(&overrides, &player.member_id)),
                text(&timestamp),
                // The guests actually billed for, not the guests registered.
                // Snapshot what the split was computed from or the amount stops
                // being explainable the moment somebody edits the roster.
                number(arrived_guests(&attendance_of(player))),
            ])?,
        );
    }

    // Someone who was settled and then removed from the list should stop owing
    // money — but only if they had not already paid, so history is never erased.
    let placeholders =
        (0..players.len()).map(|index| format!("?{}", index + 2)).collect::<Vec<_>>().join(", ");
    let mut binds = Vec::with_capacity(players.len() + 1);
    binds.push(text(&session.id));
    binds.extend(players.iter().map(|player| text(&player.member_id)));
    statements.push(
        db.prepare(format!(
            "DELETE FROM payments
          WHERE session_id = ?1 AND status = 'unpaid'
            AND member_id NOT IN ({placeholders})"
        ))
        .bind(&binds)?,
    );

    // Every insert first, the delete last, in one batch: a half-applied split
    // would leave somebody owing money for a session they were removed from.
    db.batch(statements).await?;
    Ok(())
}

/// The four fields presence depends on, read off a roster row.
///
/// A `futsal_core::attendance::Attends` impl on [`Registration`] would read
/// better at the call sites, but there may be only one in the crate and the row
/// type belongs to `db.rs`, not to a route module.
fn attendance_of(registration: &Registration) -> AttendanceInput {
    AttendanceInput {
        // Every status that is not `in` is presumed absent, which is what
        // `reg.status === 'in'` said.
        status: if registration.status == "in" { Status::In } else { Status::Waitlist },
        guests: Some(registration.guests),
        attended: registration.attended,
        guests_arrived: registration.guests_arrived,
    }
}

/// `Map.prototype.set` — replace in place, else append.
fn set_override(overrides: &mut Vec<(String, Option<i64>)>, member_id: &str, amount: Option<i64>) {
    match overrides.iter_mut().find(|(id, _)| id == member_id) {
        Some(slot) => slot.1 = amount,
        None => overrides.push((member_id.to_string(), amount)),
    }
}

/// `overrides.get(id) ?? null` — an absent key and a stored `null` are the same
/// answer: this person is on the equal split.
fn lookup_override(overrides: &[(String, Option<i64>)], member_id: &str) -> Option<i64> {
    overrides.iter().find(|(id, _)| id == member_id).and_then(|(_, amount)| *amount)
}

async fn find_payment(
    db: &D1Database,
    session_id: &str,
    member_id: &str,
) -> ApiResult<Option<PaymentRow>> {
    Ok(db
        .prepare(
            "SELECT p.*, m.name AS member_name FROM payments p
         JOIN members m ON m.id = p.member_id
        WHERE p.session_id = ?1 AND p.member_id = ?2",
        )
        .bind(&[text(session_id), text(member_id)])?
        .first(None)
        .await?)
}

async fn find_payment_by_id(db: &D1Database, payment_id: &str) -> ApiResult<Option<PaymentRow>> {
    Ok(db
        .prepare(
            "SELECT p.*, m.name AS member_name FROM payments p
         JOIN members m ON m.id = p.member_id
        WHERE p.id = ?1",
        )
        .bind(&[text(payment_id)])?
        .first(None)
        .await?)
}

/* -------------------------------------------------------------- bind values */

fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

/// Every amount here is an integer dong well inside the range a JavaScript
/// number holds exactly, which is what the original bound.
fn number(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}

fn optional_text(value: Option<&str>) -> JsValue {
    match value {
        Some(value) => text(value),
        None => JsValue::NULL,
    }
}

fn optional_number(value: Option<i64>) -> JsValue {
    match value {
        Some(value) => number(value),
        None => JsValue::NULL,
    }
}

/* ------------------------------------------------------------- request body */

/// `parseBody` — `await request.json()`, and *any* throw at all, from reading
/// the body or from parsing it, is the same one message.
async fn read_json(req: &mut Request) -> ApiResult<Value> {
    let raw = req.text().await.map_err(|_| http::bad_request("Expected a JSON body"))?;
    serde_json::from_str(&raw).map_err(|_| http::bad_request("Expected a JSON body"))
}

struct SettleInput {
    total_charge: i64,
    granularity: Option<i64>,
    /// `amount` is not nullable in this schema — an override here is always a
    /// figure, never a clearing.
    overrides: Vec<(String, i64)>,
}

fn parse_settle(raw: &Value) -> ApiResult<SettleInput> {
    let body = object(raw)?;
    let total_charge = vnd("totalCharge", body.get("totalCharge"))?;
    let granularity = match body.get("granularity") {
        None => None,
        Some(value) => Some(bounded_int("granularity", Some(value), 1, 100_000)?),
    };

    let mut overrides = Vec::new();
    if let Some(value) = body.get("overrides") {
        let Some(entries) = value.as_array() else {
            return Err(issue(
                "overrides",
                format!("Invalid input: expected array, received {}", parsed_type(Some(value))),
            ));
        };
        // Element issues are raised before the array's own length check, because
        // an array schema parses its elements and only then runs its checks.
        for (index, entry) in entries.iter().enumerate() {
            let Some(entry) = entry.as_object() else {
                let received = parsed_type(Some(entry));
                return Err(issue(
                    &format!("overrides.{index}"),
                    format!("Invalid input: expected object, received {received}"),
                ));
            };
            let member_id =
                id(&format!("overrides.{index}.memberId"), entry.get("memberId"))?.to_string();
            let amount = vnd(&format!("overrides.{index}.amount"), entry.get("amount"))?;
            overrides.push((member_id, amount));
        }
        if entries.len() > 60 {
            return Err(issue("overrides", "Too big: expected array to have <=60 items"));
        }
    }

    Ok(SettleInput { total_charge, granularity, overrides })
}

struct ClaimInput {
    proof_key: Option<String>,
    note: Option<String>,
}

fn parse_claim(raw: &Value) -> ApiResult<ClaimInput> {
    let body = object(raw)?;
    Ok(ClaimInput {
        proof_key: nullish_string("proofKey", body.get("proofKey"), false, 200)?,
        note: nullish_string("note", body.get("note"), true, 300)?,
    })
}

struct ReviewInput {
    confirm: bool,
    reason: Option<String>,
}

fn parse_review(raw: &Value) -> ApiResult<ReviewInput> {
    let body = object(raw)?;
    let decision = match body.get("decision").and_then(Value::as_str) {
        Some("confirm") => true,
        Some("reject") => false,
        _ => {
            return Err(issue(
                "decision",
                "Invalid option: expected one of \"confirm\"|\"reject\"",
            ))
        }
    };
    Ok(ReviewInput {
        confirm: decision,
        reason: nullish_string("reason", body.get("reason"), true, 300)?,
    })
}

/// `overridePaymentSchema` — `amount` is nullable but **required**, so an empty
/// body is a 400 rather than a no-op.
fn parse_override(raw: &Value) -> ApiResult<Option<i64>> {
    let body = object(raw)?;
    match body.get("amount") {
        Some(Value::Null) => Ok(None),
        value => Ok(Some(vnd("amount", value)?)),
    }
}

/* ------------------------------------------------------------ zod, in Rust */
//
// The original validated with zod v4 and reported `issues[0]` as
// `"<dotted.path>: <message>"`. These helpers produce the same first issue for
// the same input, message for message — those strings are on the wire and the
// web app puts some of them straight in front of a person.

/// `badRequest(path ? `${path}: ${message}` : message)`.
fn issue(path: &str, message: impl AsRef<str>) -> crate::http::ApiError {
    http::bad_request(format!("{path}: {}", message.as_ref()))
}

/// `util.parsedType` — the word the message uses for what it was handed. JSON
/// carries no `undefined`, so only an absent key produces that one.
fn parsed_type(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// The top-level object check. Its path is empty, so the message travels bare.
fn object(raw: &Value) -> ApiResult<&serde_json::Map<String, Value>> {
    raw.as_object().ok_or_else(|| {
        http::bad_request(format!(
            "Invalid input: expected object, received {}",
            parsed_type(Some(raw))
        ))
    })
}

/// `vndSchema` — `z.number().int().min(0).max(1_000_000_000)`.
fn vnd(path: &str, value: Option<&Value>) -> ApiResult<i64> {
    bounded_int(path, value, 0, 1_000_000_000)
}

/// A `z.number().int().min(a).max(b)`, with zod's own ordering: the type first,
/// then integrality (which aborts), then the bounds.
fn bounded_int(path: &str, value: Option<&Value>, min: i64, max: i64) -> ApiResult<i64> {
    let Some(number) = value.and_then(Value::as_f64) else {
        return Err(issue(
            path,
            format!("Invalid input: expected number, received {}", parsed_type(value)),
        ));
    };
    if !number.is_finite() || number.fract() != 0.0 {
        return Err(issue(path, "Invalid input: expected int, received number"));
    }
    if number < min as f64 {
        return Err(issue(path, format!("Too small: expected number to be >={min}")));
    }
    if number > max as f64 {
        return Err(issue(path, format!("Too big: expected number to be <={max}")));
    }
    Ok(number as i64)
}

/// `idSchema` — `z.string().min(1).max(64)`.
fn id<'a>(path: &str, value: Option<&'a Value>) -> ApiResult<&'a str> {
    let text = string(path, value)?;
    let length = text.encode_utf16().count();
    if length < 1 {
        return Err(issue(path, "Too small: expected string to have >=1 characters"));
    }
    if length > 64 {
        return Err(issue(path, "Too big: expected string to have <=64 characters"));
    }
    Ok(text)
}

fn string<'a>(path: &str, value: Option<&'a Value>) -> ApiResult<&'a str> {
    value.and_then(Value::as_str).ok_or_else(|| {
        issue(path, format!("Invalid input: expected string, received {}", parsed_type(value)))
    })
}

/// A `z.string()[.trim()].max(max).nullish()`: absent and `null` are both
/// `None`, and the trim happens before the length is measured because that is
/// the order the checks were declared in. The trimmed value is what gets stored.
fn nullish_string(
    path: &str,
    value: Option<&Value>,
    trim: bool,
    max: usize,
) -> ApiResult<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(_) => {
            let raw = string(path, value)?;
            let text = if trim { js_trim(raw) } else { raw };
            // `String.prototype.length` counts UTF-16 code units, and these
            // bounds were written against it.
            if text.encode_utf16().count() > max {
                return Err(issue(
                    path,
                    format!("Too big: expected string to have <={max} characters"),
                ));
            }
            Ok(Some(text.to_string()))
        }
    }
}

/// `String.prototype.trim()`, whose set of spaces is not Rust's: JavaScript
/// strips the byte-order mark and does not strip U+0085.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{0085}'))
}

/* --------------------------------------------------------- path parameters */

/// Hono decoded a route parameter with `decodeURIComponent` whenever it held a
/// `%`, and left it alone otherwise — so `pay_%41BC` and `pay_ABC` address the
/// same row.
fn decode_param(raw: &str) -> String {
    if !raw.contains('%') {
        return raw.to_string();
    }
    // `tryDecode`: the strict decode first, and on a `URIError` a second pass
    // that decodes each `(?:%XX)+` run on its own and leaves the ones that still
    // fail as they were.
    decode_percent(raw, false).unwrap_or_else(|| decode_percent(raw, true).unwrap_or_default())
}

fn decode_percent(raw: &str, forgiving: bool) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            let character = raw[index..].chars().next()?;
            out.push(character);
            index += character.len_utf8();
            continue;
        }
        // One maximal run of escapes, decoded together: a multi-byte character
        // is spelled as several of them and is only valid as a whole.
        let start = index;
        let mut octets = Vec::new();
        while bytes.get(index) == Some(&b'%') {
            let (Some(high), Some(low)) =
                (hex(bytes.get(index + 1)), hex(bytes.get(index + 2)))
            else {
                break;
            };
            octets.push(high * 16 + low);
            index += 3;
        }
        if octets.is_empty() {
            if !forgiving {
                return None;
            }
            out.push('%');
            index += 1;
            continue;
        }
        match String::from_utf8(octets) {
            Ok(decoded) => out.push_str(&decoded),
            Err(_) if forgiving => out.push_str(&raw[start..index]),
            Err(_) => return None,
        }
    }
    Some(out)
}

fn hex(byte: Option<&u8>) -> Option<u8> {
    match byte {
        Some(b @ b'0'..=b'9') => Some(b - b'0'),
        Some(b @ b'a'..=b'f') => Some(b - b'a' + 10),
        Some(b @ b'A'..=b'F') => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(parsed: ApiResult<impl Sized>) -> String {
        parsed.err().expect("expected a rejection").message
    }

    fn settle(json: &str) -> ApiResult<SettleInput> {
        parse_settle(&serde_json::from_str(json).unwrap())
    }

    /// The strings zod v4 produces, which are on the wire and therefore part of
    /// the API. Only the first issue is ever reported, in shape-key order.
    #[test]
    fn settle_rejections_are_zod_verbatim() {
        assert_eq!(message(settle("[]")), "Invalid input: expected object, received array");
        assert_eq!(
            message(settle("{}")),
            "totalCharge: Invalid input: expected number, received undefined"
        );
        assert_eq!(
            message(settle(r#"{"totalCharge":"1"}"#)),
            "totalCharge: Invalid input: expected number, received string"
        );
        assert_eq!(
            message(settle(r#"{"totalCharge":1.5}"#)),
            "totalCharge: Invalid input: expected int, received number"
        );
        assert_eq!(
            message(settle(r#"{"totalCharge":-1}"#)),
            "totalCharge: Too small: expected number to be >=0"
        );
        assert_eq!(
            message(settle(r#"{"totalCharge":1000000001}"#)),
            "totalCharge: Too big: expected number to be <=1000000000"
        );
        assert_eq!(
            message(settle(r#"{"totalCharge":0,"granularity":0}"#)),
            "granularity: Too small: expected number to be >=1"
        );
        assert_eq!(
            message(settle(r#"{"totalCharge":0,"overrides":{}}"#)),
            "overrides: Invalid input: expected array, received object"
        );
        assert_eq!(
            message(settle(r#"{"totalCharge":0,"overrides":[{"memberId":"","amount":1}]}"#)),
            "overrides.0.memberId: Too small: expected string to have >=1 characters"
        );
        assert_eq!(
            message(settle(r#"{"totalCharge":0,"overrides":[{"memberId":"a","amount":-1}]}"#)),
            "overrides.0.amount: Too small: expected number to be >=0"
        );
    }

    /// An element's issue is raised before the array's own length check, because
    /// an array schema parses its elements and only then runs its checks.
    #[test]
    fn an_element_outranks_the_length() {
        let entries: Vec<String> =
            (0..61).map(|_| String::from(r#"{"memberId":1,"amount":0}"#)).collect();
        let json = format!(r#"{{"totalCharge":0,"overrides":[{}]}}"#, entries.join(","));
        assert_eq!(
            message(settle(&json)),
            "overrides.0.memberId: Invalid input: expected string, received number"
        );

        let good: Vec<String> =
            (0..61).map(|_| String::from(r#"{"memberId":"a","amount":0}"#)).collect();
        let json = format!(r#"{{"totalCharge":0,"overrides":[{}]}}"#, good.join(","));
        assert_eq!(message(settle(&json)), "overrides: Too big: expected array to have <=60 items");
    }

    #[test]
    fn nullish_strings_are_trimmed_and_null_is_absent() {
        let claim = parse_claim(
            &serde_json::from_str(r#"{"proofKey":"  k  ","note":"  hi  "}"#).unwrap(),
        )
        .unwrap();
        // `proofKey` has no `.trim()`; `note` does.
        assert_eq!(claim.proof_key.as_deref(), Some("  k  "));
        assert_eq!(claim.note.as_deref(), Some("hi"));

        let claim = parse_claim(&serde_json::from_str(r#"{"note":null}"#).unwrap()).unwrap();
        assert_eq!(claim.proof_key, None);
        assert_eq!(claim.note, None);
    }

    #[test]
    fn a_decision_is_one_of_two_words() {
        let review = parse_review(&serde_json::from_str(r#"{"decision":"reject"}"#).unwrap());
        assert!(!review.unwrap().confirm);
        assert_eq!(
            message(parse_review(&serde_json::from_str(r#"{"decision":"maybe"}"#).unwrap())),
            "decision: Invalid option: expected one of \"confirm\"|\"reject\""
        );
    }

    /// `amount` is nullable but required: `null` clears the override, an absent
    /// key is a rejection.
    #[test]
    fn an_override_must_say_something() {
        assert_eq!(
            parse_override(&serde_json::from_str(r#"{"amount":null}"#).unwrap()).unwrap(),
            None
        );
        assert_eq!(
            parse_override(&serde_json::from_str(r#"{"amount":5000}"#).unwrap()).unwrap(),
            Some(5000)
        );
        assert_eq!(
            message(parse_override(&serde_json::from_str("{}").unwrap())),
            "amount: Invalid input: expected number, received undefined"
        );
    }

    #[test]
    fn later_overrides_win_and_null_clears() {
        let mut overrides = Vec::new();
        set_override(&mut overrides, "a", Some(1));
        set_override(&mut overrides, "b", Some(2));
        set_override(&mut overrides, "a", None);
        assert_eq!(lookup_override(&overrides, "a"), None);
        assert_eq!(lookup_override(&overrides, "b"), Some(2));
        assert_eq!(lookup_override(&overrides, "c"), None);
    }

    #[test]
    fn a_parameter_is_decoded_only_when_it_carries_a_percent() {
        assert_eq!(decode_param("pay_abc"), "pay_abc");
        assert_eq!(decode_param("pay_%41BC"), "pay_ABC");
        assert_eq!(decode_param("a%2Fb"), "a/b");
        assert_eq!(decode_param("%E2%9C%93"), "\u{2713}");
        // A malformed escape is left exactly as it arrived.
        assert_eq!(decode_param("%zz"), "%zz");
        assert_eq!(decode_param("%E0%A4%A"), "%E0%A4%A");
    }

    #[test]
    fn javascript_trims_the_byte_order_mark_but_not_the_next_line() {
        assert_eq!(js_trim("\u{feff} hi \u{feff}"), "hi");
        assert_eq!(js_trim("\u{85}hi"), "\u{85}hi");
        assert_eq!(js_trim("\u{a0}hi\u{2028}"), "hi");
    }
}
