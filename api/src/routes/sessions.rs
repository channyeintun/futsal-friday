//! The fixture: who is playing, who turned up, the sides, the score, the vote.
//!
//! Ported from `src/routes/sessions.ts`, which Hono mounted at `/sessions`
//! inside `protectedRoutes`. Everything here has therefore already been through
//! `requireMember()` and `requireApproved()`; the two routes that want more say
//! so themselves, and the rest are deliberately open to any member — the draw
//! and the scoreline are decided standing on a pitch, and gating them on the
//! organizer holding their phone would make them useless at the one moment they
//! are wanted.

use serde::Serialize;
use serde_json::{json, Map, Value};
use wasm_bindgen::prelude::*;
use worker::d1::{D1Database, D1PreparedStatement};
use worker::{Env, Method, Request, Response, Result as WorkerResult};

use futsal_core::attendance::{
    did_attend as core_did_attend, total_arrived_heads, AttendanceInput, Attends, Status,
};
use futsal_core::clock::start_of_zoned_day;
use futsal_core::events::{session_channel, LOBBY_CHANNEL};
use futsal_core::mvp::can_vote_for;
use futsal_core::teams::{
    arrived_slots, assign_latecomers, can_redraw_teams, can_split_into, draw_teams, max_teams_for,
    round_robin, slots_missing_from, TeamSlot,
};

use crate::db::{self, Registration, RegistrationCounts, Session, SessionWithVenueRow, TeamDraw};
use crate::http::{self, ApiError, ApiResult};
use crate::js;
use crate::middleware::{self, Identity};
use crate::realtime::create_pub_sub;

/// Ceiling on how many people one draw will deal out.
///
/// Twice the largest cap a session can be given, so it can never be reached by
/// a real fixture — it exists only so the write below stays a bounded batch on
/// a session that was created without a cap at all.
const MAX_DRAW_SLOTS: i64 = 120;

/// "This board is not settled, or you are an organizer" — as SQL.
///
/// The same rule as `can_redraw_teams`, restated where the write happens. The
/// route checks permission with a read first, for a clean 403 in the ordinary
/// case; this is what stops a confirmation that lands in the gap between that
/// read and the batch from being quietly undone by the request it should have
/// refused. Written as a function of the parameter positions because each
/// statement in the batch binds them in a different order.
fn may_write_board(session_param: &str, organizer_param: &str) -> String {
    format!(
        "({organizer_param} = 1 OR NOT EXISTS (
            SELECT 1 FROM team_draws d
             WHERE d.session_id = {session_param} AND d.confirmed_at IS NOT NULL))"
    )
}

/// `None` when nothing here matches, so the dispatcher can go on to the next
/// router. A path this file owns but with the wrong method is also `None`: Hono
/// matched on method too, and an unmatched method fell through to the not-found
/// handler rather than answering 405.
///
/// The identity is passed in rather than resolved here because
/// `requireMember()` and `requireApproved()` were `ALL /*` middlewares mounted
/// ahead of this router, not something it asked for.
pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    let path = hono_path(&req.path());
    let rest = match path.strip_prefix("/sessions") {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => rest,
        _ => return None,
    };
    let segments: Vec<&str> =
        if rest.is_empty() { Vec::new() } else { rest[1..].split('/').collect() };
    // Hono's trie has no node for an empty path segment, so `/sessions/` and
    // `/sessions//register` reach the not-found handler rather than matching
    // `:id` with an empty id.
    if segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }

    // Hono decodes a path parameter it finds a `%` in; the segments themselves
    // are matched as they arrived.
    let id = || decode_param(segments[0]);

    Some(match (req.method(), segments.as_slice()) {
        (Method::Get, []) => home(env).await,
        (Method::Get, ["past"]) => past(req, env).await,
        (Method::Get, [_]) => detail(env, &id(), identity).await,
        (Method::Post, []) => create(req, env, identity).await,
        (Method::Patch, [_]) => update(req, env, identity, &id()).await,

        (Method::Post, [_, "register"]) => register(req, env, identity, &id()).await,
        (Method::Patch, [_, "register"]) => change_guests(req, env, identity, &id()).await,
        (Method::Delete, [_, "register"]) => withdraw(env, identity, &id()).await,

        (Method::Post, [_, "attendance"]) => attendance(req, env, identity, &id()).await,
        (Method::Post, [_, "goals"]) => goals(req, env, identity, &id()).await,

        (Method::Post, [_, "teams"]) => draw(req, env, identity, &id()).await,
        (Method::Post, [_, "teams", "confirm"]) => confirm(env, identity, &id()).await,
        (Method::Post, [_, "teams", "latecomers"]) => latecomers(env, identity, &id()).await,
        (Method::Post, [_, "matches", match_id]) => {
            record_match(req, env, identity, &id(), &decode_param(match_id)).await
        }

        (Method::Get, [_, "mvp"]) => read_mvp(env, identity, &id()).await,
        (Method::Post, [_, "mvp"]) => cast_vote(req, env, identity, &id()).await,

        (Method::Get, [_, "messages"]) => read_messages(env, &id()).await,
        (Method::Post, [_, "messages"]) => post_message(req, env, identity, &id()).await,
        (Method::Delete, [_, "messages", message_id]) => {
            delete_message(env, identity, &id(), &decode_param(message_id)).await
        }

        (Method::Delete, [_, "teams"]) => clear_teams(env, identity, &id()).await,

        _ => return None,
    })
}

/* ---------------------------------------------------------------- reading */

/// Home screen: the session in play plus a short history.
///
/// "In play" runs to the end of the day, not to kickoff — see
/// `start_of_zoned_day`. Neither a passed kickoff nor a `completed` status
/// demotes tonight's game, because both happen while the group is still busy
/// with it: the cron completes a session two hours after it starts, and
/// settling the bill completes it too.
async fn home(env: &Env) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let day_start = http::iso_of(start_of_zoned_day(js::now_ms() as i64) as f64);

    let upcoming_row: Option<SessionWithVenueRow> = db_handle
        .prepare(format!(
            "SELECT {} {}
        WHERE s.status <> 'cancelled' AND s.starts_at >= ?1
        ORDER BY s.starts_at ASC LIMIT 1",
            db::SESSION_COLUMNS,
            db::SESSION_FROM
        ))
        .bind(&[text(&day_start)])?
        .first(None)
        .await?;

    let results = db_handle
        .prepare(format!(
            "SELECT {} {}
        WHERE s.starts_at < ?1 OR s.status = 'cancelled'
        ORDER BY s.starts_at DESC LIMIT 12",
            db::SESSION_COLUMNS,
            db::SESSION_FROM
        ))
        .bind(&[text(&day_start)])?
        .all()
        .await?;
    let recent: Vec<SessionWithVenueRow> = results.results()?;

    Ok(Response::from_json(&Home {
        upcoming: upcoming_row.as_ref().map(db::to_session),
        recent: recent.iter().map(db::to_session).collect(),
    })?)
}

/// Fixtures whose day is over, newest first, a page at a time.
///
/// The home screen used to get twelve of these bundled into `/sessions` and no
/// way to ask for a thirteenth — the group's history simply stopped there.
/// Keyset on `(starts_at DESC, id ASC)`: two sessions can share a kickoff time
/// (a midweek game added twice, a fixture moved onto another), and without the
/// id in the tuple one of them would be unreachable.
///
/// The window is the exact complement of the one above, so a fixture is in one
/// list or the other and never in both.
async fn past(req: &Request, env: &Env) -> ApiResult<Response> {
    let url = req.url()?;
    let query = |key: &str| {
        url.query_pairs().find(|(name, _)| name == key).map(|(_, value)| value.into_owned())
    };

    // `Math.min(Math.max(Number(q ?? 20) || 20, 1), 100)` — `|| 20` catches both
    // an unreadable number and a literal zero, and the clamp is applied to
    // whatever survives. A fractional limit survives too; SQLite truncates it in
    // `LIMIT` and `slice` truncates it here, which is what JavaScript did.
    let requested = js_number(query("limit").as_deref().unwrap_or("20"));
    let requested = if requested.is_nan() || requested == 0.0 { 20.0 } else { requested };
    let limit = requested.max(1.0).min(100.0);
    let cursor = db::decode_session_cursor(query("cursor").as_deref());
    let day_start = http::iso_of(start_of_zoned_day(js::now_ms() as i64) as f64);

    let db_handle = crate::env::db(env)?;
    let statement = match &cursor {
        Some(cursor) => db_handle
            .prepare(format!(
                "SELECT {} {}
            WHERE (s.starts_at < ?1 OR s.status = 'cancelled')
              AND (s.starts_at < ?2 OR (s.starts_at = ?2 AND s.id > ?3))
            ORDER BY s.starts_at DESC, s.id ASC
            LIMIT ?4",
                db::SESSION_COLUMNS,
                db::SESSION_FROM
            ))
            .bind(&[
                text(&day_start),
                text(&cursor.starts_at),
                text(&cursor.id),
                real(limit + 1.0),
            ])?,
        None => db_handle
            .prepare(format!(
                "SELECT {} {}
            WHERE s.starts_at < ?1 OR s.status = 'cancelled'
            ORDER BY s.starts_at DESC, s.id ASC
            LIMIT ?2",
                db::SESSION_COLUMNS,
                db::SESSION_FROM
            ))
            .bind(&[text(&day_start), real(limit + 1.0)])?,
    };

    let results: Vec<SessionWithVenueRow> = statement.all().await?.results()?;
    let page = &results[..results.len().min(limit as usize)];
    let last = page.last();

    Ok(Response::from_json(&PastPage {
        sessions: page.iter().map(db::to_session).collect(),
        next_cursor: match last {
            Some(last) if results.len() as f64 > limit => {
                Some(db::encode_session_cursor(&last.starts_at, &last.id))
            }
            _ => None,
        },
    })?)
}

/// The whole screen in one read: the fixture, the roster, the board.
async fn detail(env: &Env, session_id: &str, identity: &Identity) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let Some(detail) = db::load_session_detail(&db_handle, session_id, &identity.member_id).await?
    else {
        return Err(http::not_found("No such session"));
    };
    Ok(Response::from_json(&detail)?)
}

/* --------------------------------------------------------------- fixtures */

async fn create(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    middleware::require_organizer(identity)?;

    let input = create_session(&parse_body(req).await?)?;
    let timestamp = http::now_iso();
    let id = http::new_id("ses");

    let db_handle = crate::env::db(env)?;
    let written = db_handle
        .prepare(
            "INSERT INTO sessions
           (id, starts_at, venue_id, status, fee_per_person, max_players, notes,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, 'scheduled', ?4, ?5, ?6, ?7, ?7)",
        )
        .bind(&[
            text(&id),
            text(&input.starts_at),
            maybe_text(input.venue_id.as_deref()),
            maybe_number(input.fee_per_person),
            maybe_number(input.max_players),
            maybe_text(input.notes.as_deref()),
            text(&timestamp),
        ])?
        .run()
        .await;
    if let Err(error) = written {
        // Partial unique index on starts_at for non-cancelled sessions.
        if is_unique_violation(&error) {
            return Err(http::conflict("A session already exists at that time"));
        }
        return Err(error.into());
    }

    let Some(session) = db::get_session_row(&db_handle, &id).await? else {
        return Err(http::not_found("Session vanished after insert"));
    };

    create_pub_sub(env)
        .emit(
            &[&session_channel(&id), LOBBY_CHANNEL],
            "session.updated",
            &json!({
                "sessionId": id,
                "status": session.status,
                "startsAt": session.starts_at,
                "venueId": session.venue_id,
                "reason": "created",
                "at": timestamp,
            }),
        )
        .await;

    Ok(Response::from_json(&SessionBody { session })?.with_status(201))
}

async fn update(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    id: &str,
) -> ApiResult<Response> {
    middleware::require_organizer(identity)?;

    let input = update_session(&parse_body(req).await?)?;

    let db_handle = crate::env::db(env)?;
    let Some(existing) = db::get_session_row(&db_handle, id).await? else {
        return Err(http::not_found("No such session"));
    };

    let timestamp = http::now_iso();
    // An absent field keeps what is there; an explicit `null` clears it.
    let next_starts_at = input.starts_at.unwrap_or_else(|| existing.starts_at.clone());
    let next_venue_id = input.venue_id.apply(existing.venue_id.clone());
    let next_fee_per_person = input.fee_per_person.apply(existing.fee_per_person);
    let next_max_players = input.max_players.apply(existing.max_players);
    let next_notes = input.notes.apply(existing.notes.clone());
    let next_status = input.status.unwrap_or_else(|| existing.status.clone());

    let written = db_handle
        .prepare(
            "UPDATE sessions
            SET starts_at = ?2, venue_id = ?3, fee_per_person = ?4, max_players = ?5,
                notes = ?6, status = ?7, updated_at = ?8
          WHERE id = ?1",
        )
        .bind(&[
            text(id),
            text(&next_starts_at),
            maybe_text(next_venue_id.as_deref()),
            maybe_number(next_fee_per_person),
            maybe_number(next_max_players),
            maybe_text(next_notes.as_deref()),
            text(&next_status),
            text(&timestamp),
        ])?
        .run()
        .await;
    if let Err(error) = written {
        if is_unique_violation(&error) {
            return Err(http::conflict("A session already exists at that time"));
        }
        return Err(error.into());
    }

    // Raising the cap should let waitlisted players in straight away rather
    // than waiting for someone to withdraw.
    if next_max_players != existing.max_players {
        promote_from_waitlist(&db_handle, id, next_max_players).await?;
    }

    let Some(session) = db::get_session_row(&db_handle, id).await? else {
        return Err(http::not_found("No such session"));
    };

    create_pub_sub(env)
        .emit(
            &[&session_channel(id), LOBBY_CHANNEL],
            "session.updated",
            &json!({
                "sessionId": id,
                "status": session.status,
                "startsAt": session.starts_at,
                "venueId": session.venue_id,
                "reason": if next_status == "cancelled" { "cancelled" } else { "edited" },
                "at": timestamp,
            }),
        )
        .await;

    Ok(Response::from_json(&SessionBody { session })?)
}

/* ----------------------------------------------------------- registration */

/// "I'm in". Idempotent: tapping twice is a no-op rather than an error, which
/// matters on a flaky phone connection where the first response may be lost.
async fn register(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    session_id: &str,
) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;

    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    if session.status == "cancelled" {
        return Err(http::conflict("That session was cancelled"));
    }
    if !db::is_registration_open(&session) {
        return Err(http::conflict_with(
            "Registration has closed for this session",
            http::code::REGISTRATION_CLOSED,
        ));
    }

    let body = parse_optional_body(req).await?;
    let guests = register_input(&body)?;
    // Where they pressed, if the client had a pitch to press. Stored as given
    // and never validated against the formation here: how many spots there are
    // is a question about a drawing, the cap can move under it, and a number
    // that no longer fits is not an error — the screen simply falls back to a
    // gap. See `placeOnPitch`.
    let slot = slot_input(&body)?;
    let timestamp = http::now_iso();

    // One statement so the cap check, the position and the insert cannot be
    // interleaved with a competing registration. The UNIQUE(session_id,
    // member_id) index is the backstop if two requests race here.
    //
    // The cap is measured in heads, and a party is all-or-nothing: three
    // people cannot half-fit into two spots, and splitting them would leave
    // somebody's friend on a waitlist they have no way to be told about.
    let result = db_handle
        .prepare(
            "INSERT INTO registrations
         (id, session_id, member_id, guests, status, position, created_at, slot)
       SELECT ?1, ?2, ?3, ?6,
              CASE
                WHEN ?4 IS NULL THEN 'in'
                WHEN (SELECT COALESCE(SUM(1 + guests), 0) FROM registrations
                       WHERE session_id = ?2 AND status = 'in') + 1 + ?6 <= ?4 THEN 'in'
                ELSE 'waitlist'
              END,
              COALESCE((SELECT MAX(position) FROM registrations WHERE session_id = ?2), 0) + 1,
              ?5, ?7
        WHERE NOT EXISTS (
          SELECT 1 FROM registrations WHERE session_id = ?2 AND member_id = ?3
        )",
        )
        .bind(&[
            text(&http::new_id("reg")),
            text(session_id),
            text(&identity.member_id),
            maybe_number(session.max_players),
            text(&timestamp),
            number(guests),
            maybe_number(slot),
        ])?
        .run()
        .await?;

    let registrations = db::list_registrations(&db_handle, session_id).await?;
    let Some(mine) = registrations.iter().find(|r| r.member_id == identity.member_id) else {
        return Err(http::conflict("Could not register you — try again"));
    };

    let counts = db::count_registrations(&registrations);
    let changed = result.meta()?.and_then(|meta| meta.changes).is_some_and(|changes| changes > 0);

    if changed {
        create_pub_sub(env)
            .emit(
                &[&session_channel(session_id)],
                "player.joined",
                &json!({
                    "sessionId": session_id,
                    "memberId": identity.member_id,
                    "memberName": identity.name,
                    "memberAvatarUpdatedAt": mine.member_avatar_updated_at,
                    "guests": mine.guests,
                    "slot": mine.slot,
                    "status": mine.status,
                    "position": mine.position,
                    "counts": counts,
                    "at": timestamp,
                }),
            )
            .await;
    }

    Ok(Response::from_json(&Registered { registration: Some(mine.clone()), counts, changed })?)
}

/// Change how many friends you are bringing, without losing your spot.
///
/// Bounded by the cap on the way up: three extra heads cannot appear in two
/// remaining spots. Going down always works, and frees the difference for
/// whoever is waiting — so the promotion sweep runs afterwards.
async fn change_guests(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    session_id: &str,
) -> ApiResult<Response> {
    let guests = register_input(&parse_optional_body(req).await?)?;

    let db_handle = crate::env::db(env)?;
    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    if !db::is_registration_open(&session) {
        return Err(http::conflict_with(
            "Registration has closed for this session",
            http::code::REGISTRATION_CLOSED,
        ));
    }

    let before = db::list_registrations(&db_handle, session_id).await?;
    let Some(mine) = before.iter().find(|r| r.member_id == identity.member_id).cloned() else {
        return Err(http::conflict("Register yourself first"));
    };

    // Only a spot on the pitch is capped; a longer waitlist entry costs
    // nobody anything.
    if mine.status == "in" {
        if let Some(max_players) = session.max_players {
            let others_heads: i64 = before
                .iter()
                .filter(|r| r.status == "in" && r.member_id != identity.member_id)
                .map(|r| 1 + r.guests)
                .sum();
            if others_heads + 1 + guests > max_players {
                return Err(http::conflict_with(
                    format!(
                        "There is only room for {} more",
                        (max_players - others_heads - 1).max(0)
                    ),
                    http::code::SESSION_FULL,
                ));
            }
        }
    }

    let timestamp = http::now_iso();
    db_handle
        .prepare("UPDATE registrations SET guests = ?3 WHERE session_id = ?1 AND member_id = ?2")
        .bind(&[text(session_id), text(&identity.member_id), number(guests)])?
        .run()
        .await?;

    // Bringing fewer friends may have opened a spot somebody is waiting for.
    if guests < mine.guests {
        promote_from_waitlist(&db_handle, session_id, session.max_players).await?;
    }

    let after = db::list_registrations(&db_handle, session_id).await?;
    let updated = after.iter().find(|r| r.member_id == identity.member_id).cloned();
    let counts = db::count_registrations(&after);

    // A party size change reshuffles the list and may promote somebody, which
    // is more than the `player.joined` patch can express — so viewers refetch.
    create_pub_sub(env)
        .emit(
            &[&session_channel(session_id)],
            "session.updated",
            &json!({
                "sessionId": session_id,
                "status": session.status,
                "startsAt": session.starts_at,
                "venueId": session.venue_id,
                "reason": "edited",
                "at": timestamp,
            }),
        )
        .await;

    Ok(Response::from_json(&Registered {
        registration: updated,
        counts,
        changed: guests != mine.guests,
    })?)
}

/// Withdraw, promoting the first waitlisted player into the freed spot.
async fn withdraw(env: &Env, identity: &Identity, session_id: &str) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    if !db::is_registration_open(&session) {
        return Err(http::conflict_with(
            "Registration has closed for this session",
            http::code::REGISTRATION_CLOSED,
        ));
    }

    let before = db::list_registrations(&db_handle, session_id).await?;
    let Some(mine) = before.iter().find(|r| r.member_id == identity.member_id) else {
        return Ok(Response::from_json(&Withdrawn {
            counts: db::count_registrations(&before),
            changed: false,
            promoted: None,
        })?);
    };

    // Only a departing *player* frees a spot; leaving the waitlist does not.
    let waitlist_head = if mine.status == "in" {
        before.iter().find(|r| r.status == "waitlist").cloned()
    } else {
        None
    };

    let mut statements = vec![db_handle
        .prepare("DELETE FROM registrations WHERE session_id = ?1 AND member_id = ?2")
        .bind(&[text(session_id), text(&identity.member_id)])?];
    if waitlist_head.is_some() {
        statements.push(promote_statement(&db_handle, session_id, session.max_players)?);
    }
    // D1 runs a batch as one transaction, so the spot is never double-filled.
    db_handle.batch(statements).await?;

    let after = db::list_registrations(&db_handle, session_id).await?;
    let promoted = resolve_promotion(waitlist_head.as_ref(), &after);
    let timestamp = http::now_iso();
    let counts = db::count_registrations(&after);

    create_pub_sub(env)
        .emit(
            &[&session_channel(session_id)],
            "player.left",
            &json!({
                "sessionId": session_id,
                "memberId": identity.member_id,
                "memberName": identity.name,
                "promoted": promoted.map(|promoted| json!({
                    "memberId": promoted.member_id,
                    "memberName": promoted.member_name,
                })),
                "counts": counts,
                "at": timestamp,
            }),
        )
        .await;

    Ok(Response::from_json(&Withdrawn { counts, changed: true, promoted: promoted.cloned() })?)
}

/* ------------------------------------------------------------- attendance */

/// Say who turned up.
///
/// Anybody may mark themselves. Only an organizer may mark somebody else, which
/// is what makes this usable in practice: the person who did not come is
/// exactly the person who will not open the app to say so.
///
/// Deliberately not gated on kickoff having passed. The screen only offers it
/// after the whistle, but a clock check here would reject a late correction to
/// a game last week — and correcting the record afterwards is most of the
/// point. Re-settling recomputes every share from scratch, so a fix hours later
/// still produces the right bill.
async fn attendance(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    session_id: &str,
) -> ApiResult<Response> {
    let input = mark_attendance(&parse_body(req).await?)?;

    let subject = input.member_id.unwrap_or_else(|| identity.member_id.clone());
    if subject != identity.member_id && !identity.is_organizer {
        return Err(http::forbidden("Only an organizer can mark somebody else"));
    }

    let db_handle = crate::env::db(env)?;
    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    if session.status == "cancelled" {
        return Err(http::conflict("That session was cancelled"));
    }

    let before = db::list_registrations(&db_handle, session_id).await?;
    let Some(target) = before.iter().find(|r| r.member_id == subject) else {
        return Err(http::not_found("They are not on the list for that session"));
    };

    // Absent fields mean "leave alone", so the two halves of this — whether they
    // came, and how many friends came with them — can be sent independently.
    let attended = input.attended.apply(target.attended);
    let guests_arrived = input.guests_arrived.apply(target.guests_arrived);

    if let Some(arrived) = guests_arrived {
        if arrived > target.guests {
            return Err(http::bad_request(format!(
                "They only registered {} guest(s)",
                target.guests
            )));
        }
    }

    let target_name = target.member_name.clone();
    let timestamp = http::now_iso();
    db_handle
        .prepare(
            "UPDATE registrations
          SET attended = ?3, guests_arrived = ?4,
              attendance_marked_at = ?5, attendance_marked_by = ?6
        WHERE session_id = ?1 AND member_id = ?2",
        )
        .bind(&[
            text(session_id),
            text(&subject),
            maybe_number(attended.map(i64::from)),
            maybe_number(guests_arrived),
            text(&timestamp),
            text(&identity.member_id),
        ])?
        .run()
        .await?;

    let after = db::list_registrations(&db_handle, session_id).await?;
    let arrived_heads = total_arrived_heads(&presence(&after));

    create_pub_sub(env)
        .emit(
            &[&session_channel(session_id)],
            "player.attendance",
            &json!({
                "sessionId": session_id,
                "memberId": subject,
                "memberName": target_name,
                "attended": attended,
                "guestsArrived": guests_arrived,
                "arrivedHeads": arrived_heads,
                "byMemberId": identity.member_id,
                "at": timestamp,
            }),
        )
        .await;

    Ok(Response::from_json(&Attendance { registrations: after, arrived_heads })?)
}

/// "I scored two."
///
/// Same shape and same rule as attendance — anybody may speak for themselves,
/// only an organizer may speak for somebody else — because it is the same
/// kind of fact about the same row: something only known once the game has
/// been played, and reported by the person who knows it.
///
/// Not gated on having been marked present. Somebody scores, then somebody
/// else marks them absent by mistake; refusing the goal at that point would
/// make the correction order matter, and it should not.
async fn goals(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    session_id: &str,
) -> ApiResult<Response> {
    let input = record_goals(&parse_body(req).await?)?;

    let subject = input.member_id.unwrap_or_else(|| identity.member_id.clone());
    if subject != identity.member_id && !identity.is_organizer {
        return Err(http::forbidden("Only an organizer can record somebody else's goals"));
    }

    let db_handle = crate::env::db(env)?;
    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    if session.status == "cancelled" {
        return Err(http::conflict("That session was cancelled"));
    }

    let updated = db_handle
        .prepare("UPDATE registrations SET goals = ?3 WHERE session_id = ?1 AND member_id = ?2")
        .bind(&[text(session_id), text(&subject), number(input.goals)])?
        .run()
        .await?;
    if changes(&updated)? == 0 {
        return Err(http::not_found("They are not on the list for that session"));
    }

    let after = db::list_registrations(&db_handle, session_id).await?;
    Ok(Response::from_json(&Roster { registrations: after })?)
}

/* ------------------------------------------------------------------ teams */

/// Split whoever turned up into sides.
///
/// Open to any member, on purpose. This is done standing on the pitch in the
/// minute before kickoff, and gating it on the organizer being present, awake
/// and holding their phone would make it useless at exactly the moment it is
/// wanted. Nothing here is worth money and nothing is hard to undo — the
/// remedy for a draw somebody thinks is unfair is another draw, which is why
/// calling this again is an ordinary thing to do rather than an override.
///
/// Not gated on kickoff having passed either, for the same reason attendance
/// is not: the screen decides when the question is worth asking, and a group
/// that turns up half an hour early is not doing anything wrong.
async fn draw(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    session_id: &str,
) -> ApiResult<Response> {
    let team_count = draw_teams_input(&parse_body(req).await?)?;

    let db_handle = crate::env::db(env)?;
    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    if session.status == "cancelled" {
        return Err(http::conflict("That session was cancelled"));
    }

    // Once the group has settled on a draw, moving anybody is an organizer's
    // call — see `can_redraw_teams`. Up to that point it is deliberately not.
    let existing = db::load_team_draw(&db_handle, session_id).await?;
    if !can_redraw_teams(confirmed_at(existing.as_ref()), identity.is_organizer) {
        return Err(http::forbidden("These teams are settled — ask an organizer to redo them"));
    }

    // The same presence rules as the bill, so the people being split are
    // exactly the people being charged.
    let registrations = db::list_registrations(&db_handle, session_id).await?;
    let slots = arrived_slots(&presence(&registrations));

    if slots.is_empty() {
        return Err(http::conflict("Nobody is down as having played yet"));
    }
    // The batch below is one statement per body on the pitch, and a session
    // with no cap has no bound on how many bodies that is. Nothing near this
    // is a futsal match, but an unbounded batch is worth closing anyway.
    if slots.len() as i64 > MAX_DRAW_SLOTS {
        return Err(http::bad_request(format!(
            "That is too many players to split — {MAX_DRAW_SLOTS} at most"
        )));
    }
    if !can_split_into(slots.len() as i64, team_count) {
        return Err(http::bad_request(format!(
            "Only {} on the pitch — that is at most {} teams",
            slots.len(),
            max_teams_for(slots.len() as i64)
        )));
    }

    let teams = draw_teams(&slots, team_count, &mut crypto_random);
    let timestamp = http::now_iso();

    // The permission check above is a read, and a confirmation landing between
    // that read and this write would be silently undone by somebody who should
    // have been refused. So the rule is restated inside the statements, where
    // it is evaluated against the row as it stands at write time.
    let may_force = i64::from(identity.is_organizer);
    let insert_slot = format!(
        "INSERT INTO team_slots (session_id, member_id, guest_index, team)
       SELECT ?1, ?2, ?3, ?4 WHERE {}",
        may_write_board("?1", "?5")
    );

    // One batch, so a reshuffle is never observable half-applied: D1 runs it as
    // a single transaction, and two people tapping at once resolve to one whole
    // draw rather than a mix of both.
    //
    // A new draw resets the confirmation and wipes the fixtures. It has to:
    // the scorelines were recorded against sides that no longer exist, and
    // keeping them would attribute somebody's win to a team they were never on.
    let mut statements = vec![
        db_handle
            .prepare(format!(
                "DELETE FROM team_slots WHERE session_id = ?1 AND {}",
                may_write_board("?1", "?2")
            ))
            .bind(&[text(session_id), number(may_force)])?,
        db_handle
            .prepare(format!(
                "DELETE FROM team_matches WHERE session_id = ?1 AND {}",
                may_write_board("?1", "?2")
            ))
            .bind(&[text(session_id), number(may_force)])?,
        db_handle
            .prepare(
                "INSERT INTO team_draws (session_id, team_count, drawn_by, drawn_at)
         VALUES (?1, ?3, ?4, ?5)
         ON CONFLICT (session_id) DO UPDATE
           SET team_count = excluded.team_count,
               drawn_by = excluded.drawn_by,
               drawn_at = excluded.drawn_at,
               confirmed_at = NULL,
               confirmed_by = NULL
           WHERE ?2 = 1 OR team_draws.confirmed_at IS NULL",
            )
            .bind(&[
                text(session_id),
                number(may_force),
                number(team_count),
                text(&identity.member_id),
                text(&timestamp),
            ])?,
    ];
    // Guarded like the rest — and read *after* the upsert above, which has
    // by then either cleared `confirmed_at` or been blocked itself, so the
    // slots can never land without the draw row that describes them.
    for (index, team) in teams.iter().enumerate() {
        for slot in team {
            statements.push(db_handle.prepare(insert_slot.clone()).bind(&[
                text(session_id),
                text(&slot.member_id),
                number(slot.guest_index),
                number(index as i64),
                number(may_force),
            ])?);
        }
    }
    db_handle.batch(statements).await?;

    // Nothing moved: the guards refused, which means somebody settled the
    // teams while this request was in flight.
    let written = db::load_team_draw(&db_handle, session_id).await?;
    if written.as_ref().map(|draw| draw.drawn_at.as_str()) != Some(timestamp.as_str()) {
        return Err(http::forbidden(
            "These teams were settled while you were dealing — ask an organizer",
        ));
    }

    let draw = announce_board(env, identity, session_id, &timestamp).await?;
    Ok(Response::from_json(&Board { draw })?)
}

/// "These are the teams."
///
/// Open to anybody, like the draw itself: the group agrees out loud and
/// whoever is holding a phone taps it. What it changes is who may reshuffle
/// afterwards — from anyone to organizers only — because from here people put
/// bibs on and results start being recorded.
///
/// Confirming is also what produces the fixture list, so that finishing a game
/// later is only ever a score against a line that already exists. Idempotent:
/// confirming twice does not regenerate the fixtures and so cannot wipe a
/// score somebody already entered.
async fn confirm(env: &Env, identity: &Identity, session_id: &str) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    if session.status == "cancelled" {
        return Err(http::conflict("That session was cancelled"));
    }

    let Some(existing) = db::load_team_draw(&db_handle, session_id).await? else {
        return Err(http::conflict("Split the teams first"));
    };
    if existing.confirmed_at.is_some() {
        return Ok(Response::from_json(&Board { draw: Some(existing) })?);
    }

    let timestamp = http::now_iso();
    // `DO NOTHING` rather than a plain insert, and `confirmed_at IS NULL` on
    // the update: the read above makes confirming twice a no-op in the normal
    // case, but two people tapping at the same moment both see an unconfirmed
    // draw. Without these the second batch collides with the fixture list the
    // first one just wrote, and the tap fails for no reason the group can see.
    let insert_match = "INSERT INTO team_matches
         (id, session_id, ordinal, first_team, second_team, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE EXISTS (SELECT 1 FROM team_draws d
                       WHERE d.session_id = ?2 AND d.confirmed_at = ?6)
       ON CONFLICT (session_id, ordinal) DO NOTHING";

    // Guarded on the draw still being the one that was read.
    //
    // The fixture list is generated from `existing.team_count`, so a redraw
    // landing between that read and this write would settle the new teams
    // against the old draw's fixtures — a three-team list bolted onto two
    // sides, naming a Team C that nobody is on. `confirmed_at IS NULL` covers
    // the other half: two people confirming at the same moment.
    let mut statements = vec![db_handle
        .prepare(
            "UPDATE team_draws SET confirmed_at = ?2, confirmed_by = ?3
          WHERE session_id = ?1 AND confirmed_at IS NULL AND drawn_at = ?4",
        )
        .bind(&[
            text(session_id),
            text(&timestamp),
            text(&identity.member_id),
            text(&existing.drawn_at),
        ])?];
    // Everyone plays everyone. Two teams is one fixture; three is three.
    //
    // Each insert is conditional on the update above having been ours —
    // `confirmed_at` equals this request's timestamp only in that case — so
    // fixtures can never land against somebody else's draw.
    for (ordinal, (first_team, second_team)) in round_robin(existing.team_count).iter().enumerate()
    {
        statements.push(db_handle.prepare(insert_match).bind(&[
            text(&http::new_id("mat")),
            text(session_id),
            number(ordinal as i64),
            number(*first_team),
            number(*second_team),
            text(&timestamp),
        ])?);
    }
    db_handle.batch(statements).await?;

    // Somebody else got there first, or redrew underneath us. Either way the
    // board in the database is the answer, and this stays idempotent.
    let draw = announce_board(env, identity, session_id, &timestamp).await?;
    Ok(Response::from_json(&Board { draw })?)
}

/// Deal in whoever signed up after the teams were drawn.
///
/// The board opens days before kickoff and registration stays open right up to
/// it, so "teams settled on Tuesday, two more people on Thursday" is the
/// ordinary case rather than an edge one. Redrawing answers it badly: it moves
/// people who already know their side, and on a confirmed board it takes the
/// fixture list and every recorded score with it.
///
/// This only ever appends — each latecomer onto the smallest side — so nobody
/// moves and nothing is lost. Open to any member for that reason: there is
/// nothing here to object to, and the person watching somebody walk up is not
/// always the organizer.
async fn latecomers(env: &Env, identity: &Identity, session_id: &str) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    if session.status == "cancelled" {
        return Err(http::conflict("That session was cancelled"));
    }

    let Some(draw) = db::load_team_draw(&db_handle, session_id).await? else {
        return Err(http::conflict("Split the teams first"));
    };

    let registrations = db::list_registrations(&db_handle, session_id).await?;
    let drawn = board_slots(&draw);
    let missing = slots_missing_from(&drawn, &arrived_slots(&presence(&registrations)));
    // Idempotent: nothing to add is a no-op, not an error. Two people tapping
    // it at once means the second finds nobody missing.
    if missing.is_empty() {
        return Ok(Response::from_json(&Board { draw: Some(draw) })?);
    }

    let placed: i64 = drawn.iter().map(|team| team.len() as i64).sum();
    if placed + missing.len() as i64 > MAX_DRAW_SLOTS {
        return Err(http::bad_request(format!(
            "That is too many players to split — {MAX_DRAW_SLOTS} at most"
        )));
    }

    let timestamp = http::now_iso();
    let insert_slot = "INSERT INTO team_slots (session_id, member_id, guest_index, team)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (session_id, member_id, guest_index) DO NOTHING";

    let mut statements = Vec::new();
    for (slot, team) in assign_latecomers(&drawn, &missing, &mut crypto_random) {
        statements.push(db_handle.prepare(insert_slot).bind(&[
            text(session_id),
            text(&slot.member_id),
            number(slot.guest_index),
            number(team as i64),
        ])?);
    }
    db_handle.batch(statements).await?;

    let draw = announce_board(env, identity, session_id, &timestamp).await?;
    Ok(Response::from_json(&Board { draw })?)
}

/// How a game finished.
///
/// Anybody may record it and anybody may correct it, on the same reasoning as
/// attendance and goals: the person who knows the score is whoever is standing
/// there, not whoever holds the organizer flag. Sending both goals as null puts
/// the fixture back to "not played yet", which is a different state from
/// nil-nil and has to stay expressible.
async fn record_match(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    session_id: &str,
    match_id: &str,
) -> ApiResult<Response> {
    let input = record_match_input(&parse_body(req).await?)?;

    // One score or the other alone is not a result, and storing half of one
    // would make "played" ambiguous everywhere it is read.
    if input.first_goals.is_none() != input.second_goals.is_none() {
        return Err(http::bad_request("A score needs both sides"));
    }

    // The same gate every other write to a session carries. A cancelled
    // fixture has no games in it to have a score.
    let db_handle = crate::env::db(env)?;
    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    if session.status == "cancelled" {
        return Err(http::conflict("That session was cancelled"));
    }

    let timestamp = http::now_iso();
    let played = input.first_goals.is_some();
    let updated = db_handle
        .prepare(
            "UPDATE team_matches
          SET first_goals = ?3, second_goals = ?4,
              recorded_at = ?5, recorded_by = ?6
        WHERE session_id = ?1 AND id = ?2",
        )
        .bind(&[
            text(session_id),
            text(match_id),
            maybe_number(input.first_goals),
            maybe_number(input.second_goals),
            if played { text(&timestamp) } else { JsValue::NULL },
            if played { text(&identity.member_id) } else { JsValue::NULL },
        ])?
        .run()
        .await?;

    if changes(&updated)? == 0 {
        return Err(http::not_found("No such match in this session"));
    }

    let draw = announce_board(env, identity, session_id, &timestamp).await?;
    Ok(Response::from_json(&Board { draw })?)
}

/// Take the board down. Same permission rule as redrawing it.
async fn clear_teams(env: &Env, identity: &Identity, session_id: &str) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    if db::get_session_row(&db_handle, session_id).await?.is_none() {
        return Err(http::not_found("No such session"));
    }

    let existing = db::load_team_draw(&db_handle, session_id).await?;
    if !can_redraw_teams(confirmed_at(existing.as_ref()), identity.is_organizer) {
        return Err(http::forbidden("These teams are settled — ask an organizer to clear them"));
    }

    // Neither child table has a foreign key to `team_draws`, so both are
    // cleared explicitly rather than by cascade. Guarded like the redraw, and
    // in this order: both children read the draw row before it is removed.
    let may_force = i64::from(identity.is_organizer);
    db_handle
        .batch(vec![
            db_handle
                .prepare(format!(
                    "DELETE FROM team_slots WHERE session_id = ?1 AND {}",
                    may_write_board("?1", "?2")
                ))
                .bind(&[text(session_id), number(may_force)])?,
            db_handle
                .prepare(format!(
                    "DELETE FROM team_matches WHERE session_id = ?1 AND {}",
                    may_write_board("?1", "?2")
                ))
                .bind(&[text(session_id), number(may_force)])?,
            db_handle
                .prepare(
                    "DELETE FROM team_draws
            WHERE session_id = ?1 AND (?2 = 1 OR confirmed_at IS NULL)",
                )
                .bind(&[text(session_id), number(may_force)])?,
        ])
        .await?;

    if db::load_team_draw(&db_handle, session_id).await?.is_some() {
        return Err(http::forbidden(
            "These teams were settled while you were clearing — ask an organizer",
        ));
    }

    create_pub_sub(env)
        .emit(
            &[&session_channel(session_id)],
            "teams.changed",
            &json!({
                "sessionId": session_id,
                "draw": Value::Null,
                "byMemberId": identity.member_id,
                "byMemberName": identity.name,
                "at": http::now_iso(),
            }),
        )
        .await;

    Ok(Response::from_json(&Board { draw: None })?)
}

/* -------------------------------------------------------------------- mvp */

/// The vote, as this caller is allowed to see it.
///
/// The standing goes to anybody who can read the session at all — voting is
/// the part reserved for the people who played. What `load_mvp` never returns
/// is who voted for whom; see the note there and in the migration.
async fn read_mvp(env: &Env, identity: &Identity, session_id: &str) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let mvp = db::load_mvp(&db_handle, session_id, &identity.member_id).await?;
    Ok(Response::from_json(&MvpBody { mvp })?)
}

/// "Best player today was…"
///
/// One vote each, changeable: sending a different nominee moves it rather than
/// adding a second, and sending null takes it back. Changing your mind is the
/// ordinary case — people vote early and then somebody scores a hat-trick.
///
/// Voting is offered from kickoff and never closes, like attendance and goals:
/// the screen decides when to ask, and a correction days later still works.
async fn cast_vote(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    session_id: &str,
) -> ApiResult<Response> {
    let nominee_id = cast_vote_input(&parse_body(req).await?)?;

    let db_handle = crate::env::db(env)?;
    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    if session.status == "cancelled" {
        return Err(http::conflict("That session was cancelled"));
    }

    let registrations = db::list_registrations(&db_handle, session_id).await?;
    let candidates: Vec<&str> = registrations
        .iter()
        .filter(|registration| core_did_attend(&Present(registration)))
        .map(|registration| registration.member_id.as_str())
        .collect();

    // Only somebody who was there gets a say. Not a permission so much as the
    // question itself: you cannot know who played best in a game you missed.
    if !candidates.iter().any(|candidate| *candidate == identity.member_id) {
        return Err(http::forbidden("Only somebody who played can vote"));
    }

    match &nominee_id {
        None => {
            db_handle
                .prepare("DELETE FROM mvp_votes WHERE session_id = ?1 AND voter_id = ?2")
                .bind(&[text(session_id), text(&identity.member_id)])?
                .run()
                .await?;
        }
        Some(nominee_id) => {
            if !can_vote_for(nominee_id, &identity.member_id, candidates.iter().copied()) {
                // The two refusals are deliberately one message. Telling somebody
                // "you cannot vote for yourself" and "they did not play" apart is
                // of no use to anyone and the screen never offers either.
                return Err(http::bad_request("You can only vote for somebody else who played"));
            }
            db_handle
                .prepare(
                    "INSERT INTO mvp_votes (session_id, voter_id, nominee_id, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (session_id, voter_id) DO UPDATE
           SET nominee_id = excluded.nominee_id, created_at = excluded.created_at",
                )
                .bind(&[
                    text(session_id),
                    text(&identity.member_id),
                    text(nominee_id),
                    text(&http::now_iso()),
                ])?
                .run()
                .await?;
        }
    }

    // Everyone else is told only that the count moved. The payload names
    // neither the voter nor the nominee — the standing is public but the pair
    // is not, and an event saying "X just voted for Y" would give away in
    // passing exactly what the read is careful never to return.
    create_pub_sub(env)
        .emit(
            &[&session_channel(session_id)],
            "mvp.changed",
            &json!({ "sessionId": session_id, "at": http::now_iso() }),
        )
        .await;

    let mvp = db::load_mvp(&db_handle, session_id, &identity.member_id).await?;
    Ok(Response::from_json(&MvpBody { mvp })?)
}

/* ------------------------------------------------------------- trash talk */

/// The session's thread.
///
/// Its own route rather than a field on the session detail: the roster has to
/// paint the moment the screen opens, and the banter is the part you scroll
/// to. Same reasoning as the form squares.
async fn read_messages(env: &Env, session_id: &str) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let messages = db::list_session_messages(&db_handle, session_id).await?;
    Ok(Response::from_json(&Thread { messages })?)
}

/// Say something.
///
/// Not gated on kickoff, on having registered, or on being an organizer. The
/// winding up starts days before the game and the gloating runs for a week
/// after, and somebody who is not playing this week has the most to say about
/// it. A cancelled session is the one exception: there is nothing to talk
/// about, and its thread goes down with it.
async fn post_message(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    session_id: &str,
) -> ApiResult<Response> {
    let body = post_message_input(&parse_body(req).await?)?;

    let db_handle = crate::env::db(env)?;
    let Some(session) = db::get_session_row(&db_handle, session_id).await? else {
        return Err(http::not_found("No such session"));
    };
    if session.status == "cancelled" {
        return Err(http::conflict("That session was cancelled"));
    }

    let id = http::new_id("msg");
    let timestamp = http::now_iso();
    db_handle
        .prepare(
            "INSERT INTO session_messages (id, session_id, member_id, body, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(&[
            text(&id),
            text(session_id),
            text(&identity.member_id),
            text(&body),
            text(&timestamp),
        ])?
        .run()
        .await?;

    // Read back for the writer's picture, so every phone draws the row
    // complete rather than popping the avatar in on the next refresh.
    let author = db::get_member_by_id(&db_handle, &identity.member_id).await?;
    let message = PostedMessage {
        id,
        session_id: session_id.to_string(),
        member_id: identity.member_id.clone(),
        member_name: author
            .as_ref()
            .map(|author| author.name.clone())
            .unwrap_or_else(|| identity.name.clone()),
        member_avatar_updated_at: author.and_then(|author| author.avatar_updated_at),
        body,
        created_at: timestamp.clone(),
    };

    create_pub_sub(env)
        .emit(
            &[&session_channel(session_id)],
            "message.posted",
            &json!({
                "sessionId": session_id,
                "id": message.id,
                "memberId": message.member_id,
                "memberName": message.member_name,
                "memberAvatarUpdatedAt": message.member_avatar_updated_at,
                "body": message.body,
                "at": timestamp,
            }),
        )
        .await;

    Ok(Response::from_json(&Posted { message })?.with_status(201))
}

/// Take one down.
///
/// Whoever wrote it, or an organizer — see `can_delete_message`. Somebody will
/// post something that lands wrong, and the person whose joke it was is not
/// always the person who will remove it.
async fn delete_message(
    env: &Env,
    identity: &Identity,
    session_id: &str,
    message_id: &str,
) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let existing: Option<AuthorRow> = db_handle
        .prepare("SELECT member_id FROM session_messages WHERE id = ?1 AND session_id = ?2")
        .bind(&[text(message_id), text(session_id)])?
        .first(None)
        .await?;
    let Some(existing) = existing else {
        return Err(http::not_found("No such message"));
    };

    if !can_delete_message(&existing.member_id, identity) {
        return Err(http::forbidden("That is not yours to delete"));
    }

    db_handle
        .prepare("DELETE FROM session_messages WHERE id = ?1")
        .bind(&[text(message_id)])?
        .run()
        .await?;

    create_pub_sub(env)
        .emit(
            &[&session_channel(session_id)],
            "message.deleted",
            &json!({
                "sessionId": session_id,
                "id": message_id,
                "byMemberId": identity.member_id,
                "at": http::now_iso(),
            }),
        )
        .await;

    Ok(Response::from_json(&json!({ "ok": true }))?)
}

/// Who may take a message down: whoever wrote it, or an organizer.
///
/// The same pair the app trusts everywhere else it stores something one person
/// said — attendance, goals, a scoreline.
fn can_delete_message(author_id: &str, viewer: &Identity) -> bool {
    author_id == viewer.member_id || viewer.is_organizer
}

/* -------------------------------------------------------------- the board */

/// Read the board back and tell everybody about it.
///
/// Read back rather than assembled from what was just written: the board people
/// see is the one in the database, including whichever of two simultaneous
/// taps actually won. Every write to the board goes out as the same event
/// carrying the whole thing, so a viewer never has to work out which half of
/// their screen a change applies to.
async fn announce_board(
    env: &Env,
    identity: &Identity,
    session_id: &str,
    at: &str,
) -> ApiResult<Option<TeamDraw>> {
    let db_handle = crate::env::db(env)?;
    let draw = db::load_team_draw(&db_handle, session_id).await?;

    create_pub_sub(env)
        .emit(
            &[&session_channel(session_id)],
            "teams.changed",
            &json!({
                "sessionId": session_id,
                "draw": draw,
                "byMemberId": identity.member_id,
                "byMemberName": identity.name,
                "at": at,
            }),
        )
        .await;

    Ok(draw)
}

/// `draw?.confirmedAt` — a missing draw and an unconfirmed one answer alike.
fn confirmed_at(draw: Option<&TeamDraw>) -> Option<&str> {
    draw.and_then(|draw| draw.confirmed_at.as_deref())
}

/// The board as the pure helpers read it. Same four fields under both names;
/// the copy exists because `db::TeamSlot` is what the API serializes and
/// `teams::TeamSlot` is what the draw is written against.
fn board_slots(draw: &TeamDraw) -> Vec<Vec<TeamSlot>> {
    draw.teams
        .iter()
        .map(|team| {
            team.iter()
                .map(|slot| TeamSlot {
                    member_id: slot.member_id.clone(),
                    member_name: slot.member_name.clone(),
                    member_avatar_updated_at: slot.member_avatar_updated_at.clone(),
                    guest_index: slot.guest_index,
                })
                .collect()
        })
        .collect()
}

/// Uniform floats from the platform CSPRNG.
///
/// `Math.random()` would do for picking teams, but a draw people are meant to
/// accept as fair should not be seeded by something a Worker isolate shares
/// across requests. This costs nothing and removes the question.
fn crypto_random() -> f64 {
    let buffer = js_sys::Uint32Array::new_with_length(1);
    crypto_get_random_values(&buffer);
    f64::from(buffer.get_index(0)) / 4_294_967_296.0
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = crypto, js_name = getRandomValues)]
    fn crypto_get_random_values(buffer: &js_sys::Uint32Array);
}

/* --------------------------------------------------------------- waitlist */

/// Promote the longest-waiting player, if the cap allows. The head of the
/// waitlist is chosen inside the statement rather than passed in, so a
/// concurrent withdrawal cannot promote the same person twice.
fn promote_statement(
    db: &D1Database,
    session_id: &str,
    max_players: Option<i64>,
) -> WorkerResult<D1PreparedStatement> {
    // The first waitlisted party that *fits*, not simply the first.
    //
    // A party of three behind two free spots cannot be promoted whole, and
    // splitting it is not on the table — so the spots would sit empty while a
    // solo player waits behind them. Skipping to whoever fits keeps the pitch
    // full without ever reordering anybody: positions are untouched, and the
    // skipped party is still first in line for the next opening big enough.
    db.prepare(
        "UPDATE registrations
          SET status = 'in'
        WHERE id = (
          SELECT w.id FROM registrations w
           WHERE w.session_id = ?1 AND w.status = 'waitlist'
             AND (?2 IS NULL
                  OR (SELECT COALESCE(SUM(1 + guests), 0) FROM registrations
                       WHERE session_id = ?1 AND status = 'in') + 1 + w.guests <= ?2)
           ORDER BY w.position ASC LIMIT 1
        )",
    )
    .bind(&[text(session_id), maybe_number(max_players)])
}

/// Fill every spot the cap allows — used when the organizer raises the cap.
async fn promote_from_waitlist(
    db: &D1Database,
    session_id: &str,
    max_players: Option<i64>,
) -> WorkerResult<()> {
    // Bounded loop: each pass promotes exactly one player, and the guard inside
    // the statement stops it as soon as the session is full.
    for _ in 0..60 {
        let result = promote_statement(db, session_id, max_players)?.run().await?;
        if result.meta()?.and_then(|meta| meta.changes) == Some(0) {
            break;
        }
    }
    Ok(())
}

/// Who actually moved up. Recomputed from the post-write list rather than
/// assumed, so the reported name is never a stale guess.
fn resolve_promotion<'a>(
    candidate: Option<&Registration>,
    after: &'a [Registration],
) -> Option<&'a Registration> {
    let candidate = candidate?;
    let now = after.iter().find(|r| r.member_id == candidate.member_id)?;
    if now.status == "in" {
        Some(now)
    } else {
        None
    }
}

/* ------------------------------------------------------------- attendance */

/// A registration, as the presence rules read it.
///
/// A wrapper rather than an implementation on `db::Registration` itself: the
/// answer is the same either way, and this keeps the trait impl inside the one
/// module that needs it.
struct Present<'a>(&'a Registration);

impl Attends for Present<'_> {
    fn attendance(&self) -> AttendanceInput {
        AttendanceInput {
            // Every status that is not `in` is a waitlist entry as far as
            // presence is concerned, which is what `status === 'in'` meant.
            status: if self.0.status == "in" { Status::In } else { Status::Waitlist },
            guests: Some(self.0.guests),
            attended: self.0.attended,
            guests_arrived: self.0.guests_arrived,
        }
    }
}

impl futsal_core::teams::Candidate for Present<'_> {
    fn member_id(&self) -> &str {
        &self.0.member_id
    }

    fn member_name(&self) -> &str {
        &self.0.member_name
    }

    fn member_avatar_updated_at(&self) -> Option<&str> {
        self.0.member_avatar_updated_at.as_deref()
    }
}

fn presence(registrations: &[Registration]) -> Vec<Present<'_>> {
    registrations.iter().map(Present).collect()
}

/* --------------------------------------------------------- response shapes */

#[derive(Serialize)]
struct Home {
    upcoming: Option<Session>,
    recent: Vec<Session>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PastPage {
    sessions: Vec<Session>,
    next_cursor: Option<String>,
}

#[derive(Serialize)]
struct SessionBody {
    session: Session,
}

/// `registration` is `undefined` — and so absent from the JSON — when the row
/// has gone between the write and the read back. `JSON.stringify` drops an
/// undefined value rather than writing null, and the two are different answers.
#[derive(Serialize)]
struct Registered {
    #[serde(skip_serializing_if = "Option::is_none")]
    registration: Option<Registration>,
    counts: RegistrationCounts,
    changed: bool,
}

#[derive(Serialize)]
struct Withdrawn {
    counts: RegistrationCounts,
    changed: bool,
    promoted: Option<Registration>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Attendance {
    registrations: Vec<Registration>,
    arrived_heads: i64,
}

#[derive(Serialize)]
struct Roster {
    registrations: Vec<Registration>,
}

#[derive(Serialize)]
struct Board {
    draw: Option<TeamDraw>,
}

#[derive(Serialize)]
struct MvpBody {
    mvp: db::Mvp,
}

#[derive(Serialize)]
struct Thread {
    messages: Vec<db::SessionMessage>,
}

#[derive(Serialize)]
struct Posted {
    message: PostedMessage,
}

/// The row the writer gets back, in the order the original built it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PostedMessage {
    id: String,
    session_id: String,
    member_id: String,
    member_name: String,
    member_avatar_updated_at: Option<String>,
    body: String,
    created_at: String,
}

#[derive(serde::Deserialize)]
struct AuthorRow {
    member_id: String,
}

/* ------------------------------------------------------------- primitives */

fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

fn number(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}

fn real(value: f64) -> JsValue {
    JsValue::from_f64(value)
}

fn maybe_text(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from_str)
}

fn maybe_number(value: Option<i64>) -> JsValue {
    value.map_or(JsValue::NULL, |value| JsValue::from_f64(value as f64))
}

/// `(result.meta?.changes ?? 0)`.
fn changes(result: &worker::d1::D1Result) -> WorkerResult<usize> {
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0))
}

/// `isUniqueViolation(error)` — the clash the session's partial unique index
/// raises, told apart from every other database failure by its message. The
/// original imported this from `members.ts`; it is restated here rather than
/// reached for across modules, and the two must stay the same test.
///
/// The D1 binding throws an `Error` whose `message` begins `D1_ERROR:`, which is
/// the string the original's regex ran against; `worker` wraps that one in
/// `Error::D1`, whose `Display` shows the *cause* instead. So the message is
/// read off the JavaScript error itself rather than off the wrapper.
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

/// `Number(value)` on a string: JavaScript's own conversion, which trims, reads
/// `0x` and `1e3`, and answers `NaN` for anything else. Called as the global
/// function rather than reimplemented, because every one of those rules is
/// reachable through the query string.
fn js_number(text: &str) -> f64 {
    number_of(&JsValue::from_str(text))
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = Number)]
    fn number_of(value: &JsValue) -> f64;
}

/// `getPath` — the pathname, decoded with `decodeURI` when it carries a `%`.
///
/// This runs *before* routing, so `/sessions/%72egister` is a route match and
/// not a 404. `decodeURI` keeps the escapes for the reserved characters, `%2F`
/// among them, which is what lets the result still be split on `/`; and the
/// `%25` → `%2525` swap is what leaves a literal percent sign for the parameter
/// decoder to find.
fn hono_path(path: &str) -> String {
    if !path.contains('%') {
        return path.to_string();
    }
    try_decode(&path.replace("%25", "%2525"), reserved_uri)
}

/// Hono decodes a path parameter with `decodeURIComponent` when it contains a
/// `%` — nothing is reserved at that point, because the segment is already cut.
fn decode_param(raw: &str) -> String {
    if !raw.contains('%') {
        return raw.to_string();
    }
    try_decode(raw, |_| false)
}

/// `decodeURI`'s reserved set: the characters whose escapes it leaves alone,
/// because decoding them would change what the URI means.
fn reserved_uri(byte: u8) -> bool {
    matches!(byte, b';' | b'/' | b'?' | b':' | b'@' | b'&' | b'=' | b'+' | b'$' | b',' | b'#')
}

/// `tryDecode`: decode the whole string, or — when that throws — decode each
/// run of escapes on its own and leave whatever will not decode as it arrived.
fn try_decode(raw: &str, reserved: fn(u8) -> bool) -> String {
    if let Some(decoded) = decode_escapes(raw, reserved) {
        return decoded;
    }

    let mut out = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            // The longest run of `%XX` starting here, decoded together or left
            // exactly as it arrived.
            let start = index;
            while bytes.get(index) == Some(&b'%')
                && is_hex(bytes.get(index + 1))
                && is_hex(bytes.get(index + 2))
            {
                index += 3;
            }
            if index > start {
                let run = &raw[start..index];
                out.push_str(&decode_escapes(run, reserved).unwrap_or_else(|| run.to_string()));
                continue;
            }
        }
        let ch = raw[index..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

fn is_hex(byte: Option<&u8>) -> bool {
    byte.is_some_and(u8::is_ascii_hexdigit)
}

/// The decoding both of those do, which throws — here `None` — on a malformed
/// escape and on escaped bytes that are not valid UTF-8. Checking the buffer
/// once at the end rejects exactly what checking each sequence would: a raw
/// character can never finish a sequence an escape began, because it is already
/// well-formed UTF-8 itself.
fn decode_escapes(raw: &str, reserved: fn(u8) -> bool) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        if !is_hex(bytes.get(index + 1)) || !is_hex(bytes.get(index + 2)) {
            return None;
        }
        let byte = u8::from_str_radix(&raw[index + 1..index + 3], 16).ok()?;
        if byte < 0x80 && reserved(byte) {
            out.extend_from_slice(&bytes[index..index + 3]);
        } else {
            out.push(byte);
        }
        index += 3;
    }
    String::from_utf8(out).ok()
}

/* --------------------------------------------------------- body validation */

/// `parseBody(c.req.raw, schema)` — `await request.json()` is a read plus a
/// parse, and either throw lands in the same `catch`.
async fn parse_body(req: &mut Request) -> ApiResult<Value> {
    let Ok(text) = req.text().await else {
        return Err(http::bad_request("Expected a JSON body"));
    };
    serde_json::from_str(&text).map_err(|_| http::bad_request("Expected a JSON body"))
}

/// `parseOptionalBody(c.req.raw, schema)` — an empty or blank body validates
/// `{}`, so the schema's defaults apply.
async fn parse_optional_body(req: &mut Request) -> ApiResult<Value> {
    let Ok(text) = req.text().await else {
        return Err(http::bad_request("Expected a JSON body"));
    };
    if js_trim(&text).is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(&text).map_err(|_| http::bad_request("Expected a JSON body"))
}

/// `validate(schema, raw)`: only the first issue is ever reported, and its
/// dotted path is prefixed to zod's own wording when it has one. An issue
/// against the object itself has an empty path, so its message stands alone.
fn issue(path: &str, message: impl Into<String>) -> ApiError {
    let message = message.into();
    if path.is_empty() {
        http::bad_request(message)
    } else {
        http::bad_request(format!("{path}: {message}"))
    }
}

/// The names zod prints in `expected X, received Y`. An array is its own name
/// there rather than `object`, and an absent key is `undefined`.
fn zod_type(value: Option<&Value>) -> &'static str {
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

fn object_of(raw: &Value) -> ApiResult<&Map<String, Value>> {
    raw.as_object().ok_or_else(|| {
        issue("", format!("Invalid input: expected object, received {}", zod_type(Some(raw))))
    })
}

/// `.optional()` — an absent key is accepted, an explicit `null` is not.
fn optional<T>(
    object: &Map<String, Value>,
    key: &str,
    read: impl FnOnce(Option<&Value>, &str) -> ApiResult<T>,
) -> ApiResult<Option<T>> {
    match object.get(key) {
        None => Ok(None),
        value => read(value, key).map(Some),
    }
}

/// `.nullable()` — the key must be there, but may be `null`.
fn nullable<T>(
    object: &Map<String, Value>,
    key: &str,
    read: impl FnOnce(Option<&Value>, &str) -> ApiResult<T>,
) -> ApiResult<Option<T>> {
    match object.get(key) {
        Some(Value::Null) => Ok(None),
        value => read(value, key).map(Some),
    }
}

/// `.nullish()` — optional *and* nullable, which the route then flattens with
/// `?? null`: both spellings of "no value" mean the same thing on a create.
fn nullish<T>(
    object: &Map<String, Value>,
    key: &str,
    read: impl FnOnce(Option<&Value>, &str) -> ApiResult<T>,
) -> ApiResult<Option<T>> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        value => read(value, key).map(Some),
    }
}

/// The three states an optional field arrives in on a patch. Absent means
/// "leave it alone" and `null` means "clear it", and the distinction is the
/// whole point of a PATCH.
enum Patch<T> {
    Keep,
    Clear,
    Set(T),
}

impl<T> Patch<T> {
    /// `input.x === undefined ? existing.x : (input.x ?? null)`.
    fn apply(self, existing: Option<T>) -> Option<T> {
        match self {
            Patch::Keep => existing,
            Patch::Clear => None,
            Patch::Set(value) => Some(value),
        }
    }
}

fn patch<T>(
    object: &Map<String, Value>,
    key: &str,
    read: impl FnOnce(Option<&Value>, &str) -> ApiResult<T>,
) -> ApiResult<Patch<T>> {
    match object.get(key) {
        None => Ok(Patch::Keep),
        Some(Value::Null) => Ok(Patch::Clear),
        value => read(value, key).map(Patch::Set),
    }
}

/* ------------------------------------------------------------ field checks */

/// zod measures `String.prototype.length`, which counts UTF-16 code units.
fn length_of(text: &str) -> usize {
    text.encode_utf16().count()
}

fn string_of<'a>(value: Option<&'a Value>, path: &str) -> ApiResult<&'a str> {
    match value {
        Some(Value::String(text)) => Ok(text),
        other => Err(issue(
            path,
            format!("Invalid input: expected string, received {}", zod_type(other)),
        )),
    }
}

/// `idSchema` = `z.string().min(1).max(64)`.
fn id_of(value: Option<&Value>, path: &str) -> ApiResult<String> {
    let text = string_of(value, path)?;
    let length = length_of(text);
    if length < 1 {
        return Err(issue(path, "Too small: expected string to have >=1 characters"));
    }
    if length > 64 {
        return Err(issue(path, "Too big: expected string to have <=64 characters"));
    }
    Ok(text.to_string())
}

/// `isoSchema` = `z.iso.datetime()`.
fn iso_of(value: Option<&Value>, path: &str) -> ApiResult<String> {
    let text = string_of(value, path)?;
    if !is_iso_datetime(text) {
        return Err(issue(path, "Invalid ISO datetime"));
    }
    Ok(text.to_string())
}

/// `z.number().int().min(min).max(max)`.
///
/// The order of the checks is the order zod reports them in: `.int()` is a type
/// check rather than a bound, so a fractional number never reaches the range,
/// and the safe-integer window is tested before the schema's own limits.
fn int_of(value: Option<&Value>, path: &str, min: i64, max: i64) -> ApiResult<i64> {
    let number = match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        other => {
            return Err(issue(
                path,
                format!("Invalid input: expected number, received {}", zod_type(other)),
            ))
        }
    };
    if !number.is_finite() || number.fract() != 0.0 {
        return Err(issue(path, "Invalid input: expected int, received number"));
    }
    const SAFE: f64 = 9_007_199_254_740_991.0;
    if number > SAFE {
        return Err(issue(path, "Too big: expected int to be <=9007199254740991"));
    }
    if number < -SAFE {
        return Err(issue(path, "Too small: expected int to be >=-9007199254740991"));
    }
    if number < min as f64 {
        return Err(issue(path, format!("Too small: expected number to be >={min}")));
    }
    if number > max as f64 {
        return Err(issue(path, format!("Too big: expected number to be <={max}")));
    }
    Ok(number as i64)
}

fn bool_of(value: Option<&Value>, path: &str) -> ApiResult<bool> {
    match value {
        Some(Value::Bool(value)) => Ok(*value),
        other => Err(issue(
            path,
            format!("Invalid input: expected boolean, received {}", zod_type(other)),
        )),
    }
}

/// `sessionStatusSchema` = `z.enum(['scheduled','cancelled','completed'])`.
/// zod reports the same message whatever the wrong value was, `null` included.
fn status_of(value: Option<&Value>, path: &str) -> ApiResult<String> {
    match value {
        Some(Value::String(text))
            if matches!(text.as_str(), "scheduled" | "cancelled" | "completed") =>
        {
            Ok(text.clone())
        }
        _ => Err(issue(
            path,
            "Invalid option: expected one of \"scheduled\"|\"cancelled\"|\"completed\"",
        )),
    }
}

/// `String.prototype.trim`: JavaScript's whitespace set, which is Unicode's
/// minus U+0085 and plus the byte-order mark.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

/// The regex behind `z.iso.datetime()`: a calendar date, `T`, a 24-hour time
/// with optional seconds and fraction, and a literal `Z`. The date rules are
/// spelled out in the pattern rather than parsed, so 31 April and 29 February
/// in a common year are both rejected — and the century rule the pattern
/// encodes is the ordinary Gregorian one.
fn is_iso_datetime(text: &str) -> bool {
    if !text.is_ascii() || text.len() < 17 {
        return false;
    }
    let bytes = text.as_bytes();
    let digits = |from: usize, to: usize| bytes[from..to].iter().all(u8::is_ascii_digit);
    let value = |from: usize, to: usize| text[from..to].parse::<i64>().unwrap_or(-1);

    if !digits(0, 4) || bytes[4] != b'-' || !digits(5, 7) || bytes[7] != b'-' || !digits(8, 10) {
        return false;
    }
    let (year, month, day) = (value(0, 4), value(5, 7), value(8, 10));
    let last_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 100 == 0 => {
            if year % 400 == 0 {
                29
            } else {
                28
            }
        }
        2 => {
            if year % 4 == 0 {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    if day < 1 || day > last_day || bytes[10] != b'T' {
        return false;
    }

    // `(?:[01]\d|2[0-3]):[0-5]\d`
    if !digits(11, 13) || bytes[13] != b':' || !digits(14, 16) {
        return false;
    }
    if value(11, 13) > 23 || value(14, 16) > 59 {
        return false;
    }

    let mut index = 16;
    // `(?::[0-5]\d(?:\.\d+)?)?`
    if bytes.get(index) == Some(&b':') {
        if index + 3 > bytes.len()
            || !digits(index + 1, index + 3)
            || value(index + 1, index + 3) > 59
        {
            return false;
        }
        index += 3;
        if bytes.get(index) == Some(&b'.') {
            let start = index + 1;
            index = start;
            while bytes.get(index).is_some_and(u8::is_ascii_digit) {
                index += 1;
            }
            if index == start {
                return false;
            }
        }
    }

    bytes.get(index) == Some(&b'Z') && index + 1 == bytes.len()
}

/* ----------------------------------------------------------------- schemas */

/// `registerSchema` = `{ guests: z.number().int().min(0).max(5).default(0) }`.
fn register_input(raw: &Value) -> ApiResult<i64> {
    let object = object_of(raw)?;
    Ok(optional(object, "guests", |value, path| int_of(value, path, 0, 5))?.unwrap_or(0))
}

/// Which spot on the pitch was pressed. Absent means no preference.
///
/// Bounded only by the widest formation the app can draw — sixty spots, the
/// same ceiling as `maxPlayers` — because the real bound is a drawing the
/// server has never seen and which changes whenever the cap does.
fn slot_input(raw: &Value) -> ApiResult<Option<i64>> {
    let object = object_of(raw)?;
    optional(object, "slot", |value, path| int_of(value, path, 0, 59))
}

struct CreateSession {
    starts_at: String,
    venue_id: Option<String>,
    fee_per_person: Option<i64>,
    max_players: Option<i64>,
    notes: Option<String>,
}

/// `createSessionSchema`. Fields are checked in declaration order, because that
/// is the order zod collects issues in and only the first is reported.
fn create_session(raw: &Value) -> ApiResult<CreateSession> {
    let object = object_of(raw)?;
    Ok(CreateSession {
        starts_at: iso_of(object.get("startsAt"), "startsAt")?,
        venue_id: nullish(object, "venueId", id_of)?,
        fee_per_person: nullish(object, "feePerPerson", |value, path| {
            int_of(value, path, 0, 1_000_000_000)
        })?,
        max_players: nullish(object, "maxPlayers", |value, path| int_of(value, path, 1, 60))?,
        notes: nullish(object, "notes", notes_of)?,
    })
}

struct UpdateSession {
    starts_at: Option<String>,
    venue_id: Patch<String>,
    fee_per_person: Patch<i64>,
    max_players: Patch<i64>,
    notes: Patch<String>,
    status: Option<String>,
}

/// `updateSessionSchema` = `createSessionSchema.partial()` plus an optional
/// status. `.partial()` over a `.nullish()` field changes nothing; over
/// `startsAt` it only adds "may be absent", so an explicit `null` there is
/// still the wrong type.
fn update_session(raw: &Value) -> ApiResult<UpdateSession> {
    let object = object_of(raw)?;
    Ok(UpdateSession {
        starts_at: optional(object, "startsAt", iso_of)?,
        venue_id: patch(object, "venueId", id_of)?,
        fee_per_person: patch(object, "feePerPerson", |value, path| {
            int_of(value, path, 0, 1_000_000_000)
        })?,
        max_players: patch(object, "maxPlayers", |value, path| int_of(value, path, 1, 60))?,
        notes: patch(object, "notes", notes_of)?,
        status: optional(object, "status", status_of)?,
    })
}

/// `z.string().trim().max(500)` — trimmed first, then measured, and the trimmed
/// value is what is stored.
fn notes_of(value: Option<&Value>, path: &str) -> ApiResult<String> {
    let text = js_trim(string_of(value, path)?);
    if length_of(text) > 500 {
        return Err(issue(path, "Too big: expected string to have <=500 characters"));
    }
    Ok(text.to_string())
}

struct MarkAttendance {
    member_id: Option<String>,
    attended: Patch<bool>,
    guests_arrived: Patch<i64>,
}

/// `markAttendanceSchema`.
fn mark_attendance(raw: &Value) -> ApiResult<MarkAttendance> {
    let object = object_of(raw)?;
    Ok(MarkAttendance {
        member_id: optional(object, "memberId", id_of)?,
        attended: patch(object, "attended", bool_of)?,
        guests_arrived: patch(object, "guestsArrived", |value, path| int_of(value, path, 0, 5))?,
    })
}

struct RecordGoals {
    member_id: Option<String>,
    goals: i64,
}

/// `recordGoalsSchema`.
fn record_goals(raw: &Value) -> ApiResult<RecordGoals> {
    let object = object_of(raw)?;
    Ok(RecordGoals {
        member_id: optional(object, "memberId", id_of)?,
        goals: int_of(object.get("goals"), "goals", 0, 30)?,
    })
}

/// `drawTeamsSchema` = `{ teamCount: z.number().int().min(2).max(6) }`.
fn draw_teams_input(raw: &Value) -> ApiResult<i64> {
    let object = object_of(raw)?;
    int_of(object.get("teamCount"), "teamCount", 2, 6)
}

struct RecordMatch {
    first_goals: Option<i64>,
    second_goals: Option<i64>,
}

/// `recordMatchSchema` — both keys are required and both may be null.
fn record_match_input(raw: &Value) -> ApiResult<RecordMatch> {
    let object = object_of(raw)?;
    Ok(RecordMatch {
        first_goals: nullable(object, "firstGoals", |value, path| int_of(value, path, 0, 30))?,
        second_goals: nullable(object, "secondGoals", |value, path| int_of(value, path, 0, 30))?,
    })
}

/// `castVoteSchema` = `{ nomineeId: idSchema.nullable() }` — a required key
/// whose null is how a vote is taken back.
fn cast_vote_input(raw: &Value) -> ApiResult<Option<String>> {
    let object = object_of(raw)?;
    nullable(object, "nomineeId", id_of)
}

/// `postMessageSchema` = `z.string().trim().min(1, 'Say something').max(280)`.
fn post_message_input(raw: &Value) -> ApiResult<String> {
    let object = object_of(raw)?;
    let text = js_trim(string_of(object.get("body"), "body")?);
    let length = length_of(text);
    if length < 1 {
        return Err(issue("body", "Say something"));
    }
    if length > 280 {
        return Err(issue("body", "Too big: expected string to have <=280 characters"));
    }
    Ok(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message<T>(result: ApiResult<T>) -> String {
        result.err().expect("an issue").message
    }

    fn parse(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    /// Every string here was taken from zod 4.4.3 running the real schema
    /// through the real `validate`.
    #[test]
    fn reports_the_first_issue_the_way_zod_words_it() {
        assert_eq!(
            message(create_session(&parse("{}"))),
            "startsAt: Invalid input: expected string, received undefined"
        );
        assert_eq!(
            message(create_session(&parse(r#"{"startsAt":"2026-08-16T12:30:00+07:00"}"#))),
            "startsAt: Invalid ISO datetime"
        );
        // Two failures, and the one reported is the field declared first.
        assert_eq!(
            message(create_session(&parse(r#"{"startsAt":"nope","venueId":5}"#))),
            "startsAt: Invalid ISO datetime"
        );
        assert_eq!(
            message(create_session(&parse(r#"{"startsAt":"2026-08-16T12:30:00Z","venueId":""}"#))),
            "venueId: Too small: expected string to have >=1 characters"
        );
        assert_eq!(
            message(create_session(&parse(
                r#"{"startsAt":"2026-08-16T12:30:00Z","maxPlayers":61}"#
            ))),
            "maxPlayers: Too big: expected number to be <=60"
        );
        assert_eq!(
            message(update_session(&parse(r#"{"startsAt":null,"status":"bogus"}"#))),
            "startsAt: Invalid input: expected string, received null"
        );
        assert_eq!(
            message(update_session(&parse(r#"{"status":"bogus"}"#))),
            "status: Invalid option: expected one of \"scheduled\"|\"cancelled\"|\"completed\""
        );
        assert_eq!(
            message(mark_attendance(&parse(r#"{"attended":"yes"}"#))),
            "attended: Invalid input: expected boolean, received string"
        );
        assert_eq!(
            message(record_goals(&parse("{}"))),
            "goals: Invalid input: expected number, received undefined"
        );
        assert_eq!(
            message(record_goals(&parse(r#"{"memberId":5,"goals":1}"#))),
            "memberId: Invalid input: expected string, received number"
        );
        assert_eq!(
            message(draw_teams_input(&parse(r#"{"teamCount":2.5}"#))),
            "teamCount: Invalid input: expected int, received number"
        );
        assert_eq!(
            message(draw_teams_input(&parse(r#"{"teamCount":1}"#))),
            "teamCount: Too small: expected number to be >=2"
        );
        assert_eq!(
            message(record_match_input(&parse(r#"{"firstGoals":1}"#))),
            "secondGoals: Invalid input: expected number, received undefined"
        );
        assert_eq!(
            message(cast_vote_input(&parse("{}"))),
            "nomineeId: Invalid input: expected string, received undefined"
        );
        assert_eq!(message(post_message_input(&parse(r#"{"body":"   "}"#))), "body: Say something");
        assert_eq!(
            message(post_message_input(&parse(&format!(r#"{{"body":"{}"}}"#, "x".repeat(281))))),
            "body: Too big: expected string to have <=280 characters"
        );
        // The object's own failure has an empty path, so no prefix.
        assert_eq!(
            message(register_input(&parse("\"nope\""))),
            "Invalid input: expected object, received string"
        );
        assert_eq!(
            message(register_input(&parse("[]"))),
            "Invalid input: expected object, received array"
        );
        // Beyond the safe-integer window the int check fires before the range.
        assert_eq!(
            message(register_input(&parse(r#"{"guests":1e100}"#))),
            "guests: Too big: expected int to be <=9007199254740991"
        );
    }

    #[test]
    fn accepts_what_the_schema_accepts() {
        assert_eq!(register_input(&parse("{}")).unwrap(), 0);
        assert_eq!(register_input(&parse(r#"{"guests":5}"#)).unwrap(), 5);
        assert_eq!(post_message_input(&parse(r#"{"body":" hi "}"#)).unwrap(), "hi");
        assert_eq!(cast_vote_input(&parse(r#"{"nomineeId":null}"#)).unwrap(), None);

        let created = create_session(&parse(
            r#"{"startsAt":"2026-08-16T12:30:00Z","venueId":null,"notes":"  padded  "}"#,
        ))
        .unwrap();
        assert_eq!(created.starts_at, "2026-08-16T12:30:00Z");
        assert_eq!(created.venue_id, None);
        assert_eq!(created.notes.as_deref(), Some("padded"));
    }

    /// `undefined` keeps, `null` clears, a value sets — which is the whole
    /// difference between a PATCH and a PUT.
    #[test]
    fn a_patch_tells_absent_from_null() {
        let input = update_session(&parse(r#"{"venueId":null}"#)).unwrap();
        assert_eq!(input.venue_id.apply(Some("ven_1".to_string())), None);
        let input = update_session(&parse("{}")).unwrap();
        assert_eq!(input.venue_id.apply(Some("ven_1".to_string())), Some("ven_1".to_string()));
        let input = update_session(&parse(r#"{"venueId":"ven_2"}"#)).unwrap();
        assert_eq!(input.venue_id.apply(Some("ven_1".to_string())), Some("ven_2".to_string()));
    }

    /// Every answer here is zod 4.4.3's, on the real `z.iso.datetime()`.
    #[rustfmt::skip]
    const ISO_VECTORS: &[(&str, bool)] = &[
        ("2026-08-16T12:30:00.000Z", true), ("2026-08-16T12:30:00Z", true),
        ("2026-08-16T12:30Z", true), ("2026-08-16T12:30:00.1Z", true),
        ("2026-08-16T12:30:00.123456789Z", true), ("2026-08-16T00:00:00Z", true),
        ("2026-08-16T23:59:59Z", true), ("2026-08-16T23:59:60Z", false),
        ("2026-08-16T12:60:00Z", false), ("2026-08-16T12:30:60Z", false),
        ("2026-08-16T24:00:00Z", false), ("2026-08-16T12:30:00", false),
        ("2026-08-16T12:30:00+00:00", false), ("2026-08-16T12:30:00.000+07:00", false),
        ("2026-08-16 12:30:00Z", false), ("2026-08-16T12:30:00ZZ", false),
        (" 2026-08-16T12:30:00Z", false), ("2026-08-16T12:30:00Z ", false),
        ("2026-8-16T12:30:00Z", false), ("2026-08-6T12:30:00Z", false),
        ("2026-00-16T12:30:00Z", false), ("2026-01-00T12:30:00Z", false),
        ("2026-01-32T12:30:00Z", false), ("2026-02-28T12:30:00Z", true),
        ("2026-02-29T12:30:00Z", false), ("2024-02-29T12:30:00Z", true),
        ("2100-02-29T12:30:00Z", false), ("2400-02-29T12:30:00Z", true),
        ("1600-02-29T12:30:00Z", true), ("2026-04-30T12:30:00Z", true),
        ("2026-04-31T12:30:00Z", false), ("2026-06-31T12:30:00Z", false),
        ("2026-09-31T12:30:00Z", false), ("2026-11-31T12:30:00Z", false),
        ("2026-12-31T12:30:00Z", true), ("2026-13-01T12:30:00Z", false),
        ("0000-01-01T00:00:00Z", true), ("9999-12-31T23:59:59Z", true),
        ("2026-08-16T12:30:.5Z", false), ("2026-08-16T12:30:00.Z", false),
        ("2026-08-16T1:30:00Z", false), ("2026-08-16T12:3:00Z", false),
        ("2026-08-16T12:30:0Z", false), ("2026-08-16t12:30:00Z", false),
        ("2026-08-16T12:30:00z", false), ("", false),
        ("2026-08-16T12:30", false), ("2026-08-16", false),
        ("2026-08-16T12:30:00.000Z\n", false), ("2020-02-29T12:30:00Z", true),
        ("1900-02-29T12:30:00Z", false), ("2000-02-29T12:30:00Z", true),
        ("2004-02-29T12:30:00Z", true), ("2012-02-29T12:30:00Z", true),
        ("2016-02-29T12:30:00Z", true), ("2032-02-29T12:30:00Z", true),
        ("2036-02-29T12:30:00Z", true), ("2052-02-29T12:30:00Z", true),
        ("2096-02-29T12:30:00Z", true), ("1704-02-29T12:30:00Z", true),
        ("1708-02-29T12:30:00Z", true), ("2800-02-29T12:30:00Z", true),
        ("2900-02-29T12:30:00Z", false), ("2026-08-16T12:30:00.000000Z", true),
        ("2026-08-16T12:30:59.9Z", true),
    ];

    #[test]
    fn the_iso_pattern_answers_what_the_regex_answers() {
        for &(text, valid) in ISO_VECTORS {
            assert_eq!(is_iso_datetime(text), valid, "{text:?}");
        }
    }

    /// Both halves of the answers Hono gives, checked against it directly.
    #[test]
    fn a_percent_in_a_path_is_decoded_the_way_hono_decodes_it() {
        // The path is decoded before routing, so an escaped route literal still
        // matches — but a `%2F` stays escaped and cannot invent a segment.
        assert_eq!(hono_path("/sessions/abc/%72egister"), "/sessions/abc/register");
        assert_eq!(hono_path("/sessions/%61bc/register"), "/sessions/abc/register");
        assert_eq!(hono_path("/sessions/%2Fx"), "/sessions/%2Fx");
        assert_eq!(hono_path("/sessions/%25"), "/sessions/%25");
        assert_eq!(hono_path("/sessions/%ff"), "/sessions/%ff");
        assert_eq!(hono_path("/sessions/%zz"), "/sessions/%zz");
        assert_eq!(hono_path("/sessions/ses_1"), "/sessions/ses_1");

        // The parameter is then decoded on its own, where nothing is reserved.
        assert_eq!(decode_param("ses_1"), "ses_1");
        assert_eq!(decode_param("a%20b"), "a b");
        assert_eq!(decode_param("%2Fx"), "/x");
        assert_eq!(decode_param("a%2fb"), "a/b");
        assert_eq!(decode_param("%25"), "%");
        // Malformed: the whole decode throws, and each decodable run is then
        // taken on its own.
        assert_eq!(decode_param("%zz%20"), "%zz ");
        assert_eq!(decode_param("%ff"), "%ff");
        assert_eq!(decode_param("%C3%A9"), "é");
    }

    #[test]
    fn the_board_write_restates_the_permission_rule() {
        assert_eq!(
            may_write_board("?1", "?2"),
            "(?2 = 1 OR NOT EXISTS (
            SELECT 1 FROM team_draws d
             WHERE d.session_id = ?1 AND d.confirmed_at IS NOT NULL))"
        );
    }
}
