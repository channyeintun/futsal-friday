//! The roster: who is in the group, who is still waiting, what a profile shows,
//! and the one row a member may change about themselves.
//!
//! Ported from `src/routes/members.ts`, which Hono mounted at `/members` inside
//! `protectedRoutes` — so every path here has already been through
//! `requireMember()` and `requireApproved()` by the time [`route`] sees it, and
//! the identity those two produced arrives as an argument rather than as a
//! context variable.
//!
//! The SQL is copied character for character from the original, indentation
//! included: a query is the contract with the database, and a reformatted one is
//! a different thing to read against a `wrangler d1` console at midnight.

use std::cmp::Ordering;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use wasm_bindgen::JsValue;
use worker::d1::D1Database;
use worker::{Env, Headers, HttpMetadata, Request, Response, ResponseBody};

use crate::db::{self, Attendance, Member, MemberRow, Streak};
use crate::http::{self, new_id, now_iso, ApiError, ApiResult};
use crate::middleware::{require_organizer, Identity};
use crate::routes::uploads;

/// A profile picture is a thumbnail, not a screenshot — the client renders it at
/// 40px in a list and 96px on a profile. 200 KB is already generous for that,
/// and re-uploads replace rather than accumulate, so the bucket cannot creep.
const MAX_AVATAR_BYTES: usize = 200_000;

/// Everything `/members` answers, in the order the original declared it.
///
/// `None` means no handler matched and the dispatcher should carry on, which is
/// Hono's fall-through: a path this router does not know still runs the auth
/// middlewares that ran before it, and only then reaches `notFound`.
///
/// `path` is Hono's `c.req.path` and `method` the raw verb string — see the
/// dispatcher for why the method is not `worker::Method`.
pub async fn route(
    method: &str,
    path: &str,
    identity: &Identity,
    req: &mut Request,
    env: &Env,
) -> Option<ApiResult<Response>> {
    let rest = path.strip_prefix("/members")?;
    // `/membersomething` is somebody else's path: Hono matched whole segments,
    // never a prefix of one.
    if !rest.is_empty() && !rest.starts_with('/') {
        return None;
    }
    // `mergePath('/members', '/')` is `/members` with no trailing slash, and
    // Hono does not treat `/members/` as the same path — that splits to a single
    // empty segment, which no pattern below accepts, so it 404s just as it did.
    // A `:param` is `[^/]+` in the router's regex, hence the emptiness guards.
    let segments: Vec<&str> =
        if rest.is_empty() { Vec::new() } else { rest[1..].split('/').collect() };
    let url = req.inner().url();

    Some(match (method, segments.as_slice()) {
        ("GET", []) => list(env, &url).await,
        ("GET", ["count"]) => count(env).await,
        ("GET", ["form"]) => form(env).await,
        ("GET", ["leaderboard"]) => leaderboard(env, &url).await,
        ("GET", ["pending"]) => pending(env, identity).await,
        ("POST", [id, "approve"]) if !id.is_empty() => approve(env, identity, &param(id)).await,
        ("DELETE", [id, "approve"]) if !id.is_empty() => reject(env, identity, &param(id)).await,
        ("GET", ["balances"]) => balances(env, &url).await,
        ("GET", [id, "profile"]) if !id.is_empty() => profile(env, &param(id)).await,
        ("PUT", ["me", "avatar"]) => put_avatar(env, identity, req).await,
        ("DELETE", ["me", "avatar"]) => delete_avatar(env, identity).await,
        // `GET /members/me/avatar` is not declared: it lands here with
        // `id = "me"`, finds no such member and answers 404.
        ("GET", [id, "avatar"]) if !id.is_empty() => avatar(env, &param(id)).await,
        ("GET", [id, "history"]) if !id.is_empty() => {
            history(env, identity, &param(id), &url).await
        }
        ("POST", []) => create(env, identity, req).await,
        ("PATCH", [id]) if !id.is_empty() => update(env, identity, &param(id), req).await,
        ("DELETE", [id]) if !id.is_empty() => remove(env, identity, &param(id)).await,
        _ => return None,
    })
}

/* ----------------------------------------------------------------- cursors */

/// Opaque cursor over `(name, id)`.
///
/// Base64 rather than the raw pair so it reads as a token the client should
/// hand back untouched, and so a name containing the separator cannot forge a
/// position. Anything unparseable is treated as "start from the beginning",
/// which is the safe failure: a stale cursor shows the first page again rather
/// than erroring at somebody halfway down a list.
fn encode_cursor(name: &str, id: &str) -> String {
    #[derive(Serialize)]
    struct Body<'a> {
        n: &'a str,
        i: &'a str,
    }
    // `btoa(unescape(encodeURIComponent(json)))` is base64 of the UTF-8 bytes,
    // standard alphabet, `=` padded — not the base64url the tokens use.
    let json =
        serde_json::to_string(&Body { n: name, i: id }).unwrap_or_else(|_| String::from("{}"));
    btoa(json.as_bytes())
}

struct Cursor {
    name: String,
    id: String,
}

fn decode_cursor(raw: Option<&str>) -> Option<Cursor> {
    // `if (!raw)` — absent and empty are both the first page.
    let raw = raw.filter(|value| !value.is_empty())?;
    let bytes = atob(raw)?;
    // `decodeURIComponent(escape(...))` is a UTF-8 decode, and it throws on a
    // malformed sequence exactly where this gives up.
    let json = String::from_utf8(bytes).ok()?;
    let parsed: Value = serde_json::from_str(&json).ok()?;
    // Only when both halves are strings; anything else is the first page.
    let name = parsed.get("n")?.as_str()?.to_string();
    let id = parsed.get("i")?.as_str()?.to_string();
    Some(Cursor { name, id })
}

/* ------------------------------------------------------------------ routes */

/// The roster, a page at a time.
///
/// Keyset, not `OFFSET`: the order is by name, and adding somebody called
/// "Aung" while you are three pages down would shift every later row by one
/// and make the next page repeat a name it had already shown. Comparing
/// against the last row you actually saw cannot skip or duplicate, however
/// much the table moves underneath.
///
/// The tuple has to include `id` because names are not unique — two players
/// called "Minh" would otherwise make the cursor ambiguous and the second one
/// unreachable. SQLite compares row values left to right, which is exactly
/// the "name greater, or name equal and id greater" rule we want.
async fn list(env: &Env, url: &str) -> ApiResult<Response> {
    let db = crate::env::db(env)?;
    let limit = clamped(query(url, "limit").as_deref(), 50.0);
    let cursor = decode_cursor(query(url, "cursor").as_deref());

    // Approved only. Somebody in the waiting room is not a member of the group
    // yet, and leaking them here would put them in the roster, the session
    // lists and every count in the app.
    let where_clause = "active = 1 AND approved_at IS NOT NULL";
    let statement = match &cursor {
        Some(cursor) => db
            .prepare(format!(
                "SELECT * FROM members
            WHERE {where_clause}
              AND (name COLLATE NOCASE, id) > (?1 COLLATE NOCASE, ?2)
            ORDER BY name COLLATE NOCASE ASC, id ASC
            LIMIT ?3"
            ))
            .bind(&[text(&cursor.name), text(&cursor.id), number(limit + 1.0)])?,
        None => db
            .prepare(format!(
                "SELECT * FROM members
            WHERE {where_clause}
            ORDER BY name COLLATE NOCASE ASC, id ASC
            LIMIT ?1"
            ))
            .bind(&[number(limit + 1.0)])?,
    };

    // One more than asked for, so "is there another page" is answered without
    // a second COUNT query on every scroll.
    let results: Vec<MemberRow> = statement.all().await?.results()?;
    // `slice(0, limit)` with a fractional limit truncates, which is what
    // `Array.prototype.slice` does with a non-integer end.
    let page_size = (limit as usize).min(results.len());
    let page = &results[..page_size];
    let last = page.last();

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        members: Vec<Member>,
        next_cursor: Option<String>,
    }
    Ok(Response::from_json(&Page {
        members: page.iter().map(db::to_member).collect(),
        next_cursor: match last {
            Some(last) if results.len() as f64 > limit => {
                Some(encode_cursor(&last.name, &last.id))
            }
            _ => None,
        },
    })?)
}

/// Just how many there are.
///
/// The Setup screen wants a number and an Add button, not a roster — reading
/// every member to render "23 players" would be the whole list downloaded to
/// print two characters.
async fn count(env: &Env) -> ApiResult<Response> {
    let db = crate::env::db(env)?;
    #[derive(Deserialize)]
    struct CountRow {
        n: Option<i64>,
    }
    let row: Option<CountRow> = db
        .prepare("SELECT COUNT(*) AS n FROM members WHERE active = 1 AND approved_at IS NOT NULL")
        .first(None)
        .await?;

    #[derive(Serialize)]
    struct Total {
        total: i64,
    }
    Ok(Response::from_json(&Total { total: row.and_then(|row| row.n).unwrap_or(0) })?)
}

/// Recent form for the whole roster, for the squares beside each name.
///
/// One call for everybody rather than one per player: the home screen draws a
/// row of these next to every name on the list, and per-member requests would
/// be a dozen round trips on the screen people open most.
async fn form(env: &Env) -> ApiResult<Response> {
    let db = crate::env::db(env)?;
    let form = db::load_recent_form(&db).await?;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Entry {
        member_id: String,
        recent: Vec<Attendance>,
    }
    #[derive(Serialize)]
    struct Body {
        window: i64,
        form: Vec<Entry>,
    }
    Ok(Response::from_json(&Body {
        window: db::FORM_WINDOW,
        // `[...form]` — the `Map`'s insertion order, which is the roster
        // query's row order.
        form: form
            .into_iter()
            .map(|(member_id, recent)| Entry { member_id, recent })
            .collect(),
    })?)
}

/// The ranking, by whichever column was asked for.
///
/// Computed rather than stored — see `load_leaderboard`. Paged off the sorted
/// result, with the sort settled before slicing so a page boundary cannot
/// reorder anybody.
async fn leaderboard(env: &Env, url: &str) -> ApiResult<Response> {
    let db = crate::env::db(env)?;
    let asked = query(url, "board");
    let board = match asked.as_deref() {
        Some("goals") => "goals",
        Some("mvp") => "mvp",
        _ => "streak",
    };
    let limit = clamped(query(url, "limit").as_deref(), 25.0);
    // A member id, not base64 — and `if (cursor)`, so an empty one is absent.
    let cursor = query(url, "cursor").filter(|value| !value.is_empty());

    let all = db::load_leaderboard(&db).await?;
    // Nobody with nothing to show: a board of forty people on zero is not a
    // ranking, it is a roster.
    let mut ranked: Vec<db::LeaderboardEntry> = all
        .into_iter()
        .filter(|row| match board {
            "goals" => row.goals > 0,
            "mvp" => row.mvps > 0,
            _ => row.streak.best > 0,
        })
        .collect();
    // `Array.prototype.sort` is stable and so is this, so entries level on
    // every key keep `load_leaderboard`'s order — members by name.
    ranked.sort_by(|a, b| match board {
        "goals" => b
            .goals
            .cmp(&a.goals)
            .then_with(|| locale_compare(&a.member.name, &b.member.name)),
        // Level on awards falls back to goals, which is the nearest thing to
        // "and who else was doing something" — then to the name, so the order
        // is stable rather than whatever the roster query happened to return.
        "mvp" => b
            .mvps
            .cmp(&a.mvps)
            .then_with(|| b.goals.cmp(&a.goals))
            .then_with(|| locale_compare(&a.member.name, &b.member.name)),
        _ => b
            .streak
            .current
            .cmp(&a.streak.current)
            .then_with(|| b.streak.best.cmp(&a.streak.best))
            .then_with(|| locale_compare(&a.member.name, &b.member.name)),
    });

    // `findIndex` answers -1 for a cursor nobody matches, and -1 + 1 is the
    // first page — a stale id restarts rather than erroring.
    let from = match &cursor {
        Some(cursor) => {
            ranked.iter().position(|row| row.member.id == *cursor).map_or(0, |index| index + 1)
        }
        None => 0,
    };
    // `slice(from, from + limit)`, whose end is truncated toward zero.
    let end = ((from as f64 + limit) as usize).min(ranked.len());
    let page = if from < end { &ranked[from..end] } else { &[][..] };
    let last = page.last();

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Ranked {
        member: Member,
        streak: Streak,
        goals: i64,
        mvps: i64,
        rank: i64,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Body {
        board: String,
        entries: Vec<Ranked>,
        next_cursor: Option<String>,
    }
    Ok(Response::from_json(&Body {
        board: board.to_string(),
        entries: page
            .iter()
            .enumerate()
            .map(|(index, row)| Ranked {
                member: row.member.clone(),
                streak: row.streak,
                goals: row.goals,
                mvps: row.mvps,
                rank: (from + index + 1) as i64,
            })
            .collect(),
        next_cursor: match last {
            Some(last) if (from as f64 + limit) < ranked.len() as f64 => {
                Some(last.member.id.clone())
            }
            _ => None,
        },
    })?)
}

/// The waiting room. Organizers only — it is a queue of decisions for them.
async fn pending(env: &Env, identity: &Identity) -> ApiResult<Response> {
    require_organizer(identity)?;
    let db = crate::env::db(env)?;
    let results: Vec<MemberRow> = db
        .prepare(
            "SELECT * FROM members
        WHERE active = 1 AND approved_at IS NULL
        ORDER BY created_at ASC",
        )
        .all()
        .await?
        .results()?;

    #[derive(Serialize)]
    struct Body {
        members: Vec<Member>,
    }
    Ok(Response::from_json(&Body { members: results.iter().map(db::to_member).collect() })?)
}

/// Let somebody in. Idempotent: approving twice is not an error.
async fn approve(env: &Env, identity: &Identity, id: &str) -> ApiResult<Response> {
    require_organizer(identity)?;
    let db = crate::env::db(env)?;

    let existing: Option<MemberRow> = db
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(id)])?
        .first(None)
        .await?;
    let Some(existing) = existing else { return Err(http::not_found("No such member")) };

    let approved_at = existing.approved_at.clone().unwrap_or_else(now_iso);
    db.prepare("UPDATE members SET approved_at = ?2 WHERE id = ?1")
        .bind(&[text(id), text(&approved_at)])?
        .run()
        .await?;

    let next = MemberRow { approved_at: Some(approved_at), ..existing };
    Ok(Response::from_json(&MemberEnvelope { member: db::to_member(&next) })?)
}

/// Turn somebody away.
///
/// A hard delete, unlike removing a member who has been playing — this row
/// was created by the person themselves, has no registrations or payments
/// behind it (a pending member cannot make any), and the name needs to go
/// back on the list so the real owner can ask for it. Soft-deleting would
/// hold the name hostage forever.
async fn reject(env: &Env, identity: &Identity, id: &str) -> ApiResult<Response> {
    require_organizer(identity)?;
    let db = crate::env::db(env)?;

    let gone = db
        .prepare("DELETE FROM members WHERE id = ?1 AND approved_at IS NULL")
        .bind(&[text(id)])?
        .run()
        .await?;

    // An id nobody has changes nothing either, so an unknown member reads as
    // "already in" — a 409, not a 404, exactly as before.
    if changes(&gone)? == 0 {
        return Err(http::conflict(
            "That member is already in — remove them from the roster instead",
        ));
    }
    Ok(Response::from_json(&Acknowledged { ok: true })?)
}

/// Who owes what, across every session — readable by anyone signed in.
///
/// Deliberately not an organizer secret. In a group this size the debt is
/// already public: the payments screen has a *Copy status for chat* button
/// whose whole job is pasting the unpaid list into the group, and any
/// member's outstanding total is already on their profile. Keeping the
/// aggregate private only meant the one person chasing the money was also
/// the only one who could see it, which put all the nagging on them.
async fn balances(env: &Env, url: &str) -> ApiResult<Response> {
    let db = crate::env::db(env)?;
    // Not clamped here — `load_member_balances` does it, and does it to the
    // same number this hands over, fractions included.
    let limit = js_or(query(url, "limit").as_deref(), 50.0);
    let page = db::load_member_balances(
        &db,
        Some(limit),
        db::decode_balance_cursor(query(url, "cursor").as_deref()),
    )
    .await?;
    Ok(Response::from_json(&page)?)
}

/// Everything the profile screen needs. Readable by anyone signed in: these
/// people already see each other's names and attendance on every session
/// screen, so a streak is not a new disclosure.
async fn profile(env: &Env, id: &str) -> ApiResult<Response> {
    let db = crate::env::db(env)?;
    let Some(profile) = db::load_member_profile(&db, id).await? else {
        return Err(http::not_found("No such member"));
    };

    #[derive(Serialize)]
    struct Body {
        profile: db::MemberProfile,
    }
    Ok(Response::from_json(&Body { profile })?)
}

/// Your own face, and only your own — an organizer picking somebody else's
/// profile picture is not a feature anyone asked for.
///
/// One request rather than the upload-then-attach dance the payment proofs
/// use: there is nothing to attach it to but this row, and a two-step flow
/// would leave an orphaned object behind every time somebody changed their
/// mind between the two calls.
async fn put_avatar(env: &Env, identity: &Identity, req: &mut Request) -> ApiResult<Response> {
    let upload = uploads::read_image_upload(req, MAX_AVATAR_BYTES).await?;
    let db = crate::env::db(env)?;
    let proofs = crate::env::proofs(env)?;

    let existing: Option<MemberRow> = db
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(&identity.member_id)])?
        .first(None)
        .await?;
    let Some(existing) = existing else { return Err(http::not_found("No such member")) };

    let key = format!("avatars/{}/{}.{}", identity.member_id, new_id("img"), upload.extension);
    let mut custom = HashMap::new();
    custom.insert(String::from("memberId"), identity.member_id.clone());
    proofs
        .put(&key, upload.body)
        .http_metadata(HttpMetadata {
            content_type: Some(upload.content_type.clone()),
            ..Default::default()
        })
        .custom_metadata(custom)
        .execute()
        .await?;

    let updated_at = now_iso();
    db.prepare("UPDATE members SET avatar_key = ?2, avatar_updated_at = ?3 WHERE id = ?1")
        .bind(&[text(&identity.member_id), text(&key), text(&updated_at)])?
        .run()
        .await?;

    // Only once the row points at the new object. Deleting first would leave a
    // broken picture if the write below failed; deleting after is at worst an
    // orphan, and this is the only writer of that key.
    if let Some(previous) = existing.avatar_key.as_deref().filter(|old| !old.is_empty()) {
        // `.catch(() => {})`: a failed cleanup is not the caller's problem.
        let _ = proofs.delete(previous).await;
    }

    let next =
        MemberRow { avatar_key: Some(key), avatar_updated_at: Some(updated_at), ..existing };
    Ok(Response::from_json(&MemberEnvelope { member: db::to_member(&next) })?)
}

async fn delete_avatar(env: &Env, identity: &Identity) -> ApiResult<Response> {
    let db = crate::env::db(env)?;
    let proofs = crate::env::proofs(env)?;

    let existing: Option<MemberRow> = db
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(&identity.member_id)])?
        .first(None)
        .await?;
    let Some(existing) = existing else { return Err(http::not_found("No such member")) };

    db.prepare("UPDATE members SET avatar_key = NULL, avatar_updated_at = NULL WHERE id = ?1")
        .bind(&[text(&identity.member_id)])?
        .run()
        .await?;
    if let Some(previous) = existing.avatar_key.as_deref().filter(|old| !old.is_empty()) {
        let _ = proofs.delete(previous).await;
    }

    let next = MemberRow { avatar_key: None, avatar_updated_at: None, ..existing };
    Ok(Response::from_json(&MemberEnvelope { member: db::to_member(&next) })?)
}

/// The picture itself. Like payment proofs, R2 keys never leave the server —
/// reading one always goes through here, so access follows the session token
/// rather than knowledge of a URL.
async fn avatar(env: &Env, id: &str) -> ApiResult<Response> {
    let db = crate::env::db(env)?;
    let proofs = crate::env::proofs(env)?;

    #[derive(Deserialize)]
    struct AvatarRow {
        avatar_key: Option<String>,
    }
    let row: Option<AvatarRow> = db
        .prepare("SELECT avatar_key FROM members WHERE id = ?1")
        .bind(&[text(id)])?
        .first(None)
        .await?;
    // `!row?.avatar_key` — no row, no key, and an empty key are one answer.
    let key = row
        .and_then(|row| row.avatar_key)
        .filter(|key| !key.is_empty())
        .ok_or_else(|| http::not_found("No profile picture"))?;

    let Some(object) = proofs.get(&key).execute().await? else {
        return Err(http::not_found("No profile picture"));
    };

    let headers = Headers::new();
    headers.set(
        "Content-Type",
        &object.http_metadata().content_type.unwrap_or_else(|| String::from("image/jpeg")),
    )?;
    // Private: it is behind auth, and a shared cache must not hold it.
    // A day is only safe because the client versions the URL with
    // `?v=<avatarUpdatedAt>` (see `memberAvatar`). Drop that query
    // parameter and a new picture stays invisible until the entry expires,
    // however hard the app refetches — the address would not have changed.
    headers.set("Cache-Control", "private, max-age=86400")?;

    // `new Response(object.body, …)`: the bytes are handed on as a stream, not
    // buffered through the Worker.
    let body = match object.body() {
        Some(body) => body.response_body()?,
        None => ResponseBody::Empty,
    };
    Ok(Response::builder().with_status(200).with_headers(headers).body(body))
}

async fn history(env: &Env, identity: &Identity, id: &str, url: &str) -> ApiResult<Response> {
    // Your own history is yours; everyone else's is the organizer's business.
    if id != identity.member_id && !identity.is_organizer {
        return Err(http::forbidden_default());
    }

    let db = crate::env::db(env)?;
    let limit = clamped(query(url, "limit").as_deref(), 20.0);
    let page = db::load_member_history(
        &db,
        id,
        Some(limit),
        db::decode_session_cursor(query(url, "cursor").as_deref()),
    )
    .await?;
    Ok(Response::from_json(&page)?)
}

async fn create(env: &Env, identity: &Identity, req: &mut Request) -> ApiResult<Response> {
    require_organizer(identity)?;
    let input = create_member_schema(&read_body(req).await?).map_err(Invalid::into_api_error)?;
    let db = crate::env::db(env)?;
    let id = new_id("mem");

    // The original wrapped `nowIso()` and the insert in one `try`; a failure
    // from either is offered to `isUniqueViolation` and rethrown if it is
    // something else.
    let timestamp = now_iso();
    let inserted = db
        .prepare(
            // Approved on the spot: an organizer typing a name in *is* the
            // approval. The waiting room is only for people who added themselves
            // from the group link.
            "INSERT INTO members (id, name, is_organizer, active, created_at, approved_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?4)",
        )
        .bind(&[
            text(&id),
            text(&input.name),
            number(if input.is_organizer { 1.0 } else { 0.0 }),
            text(&timestamp),
        ]);
    let inserted = match inserted {
        Ok(statement) => statement.run().await,
        Err(error) => Err(error),
    };
    if let Err(error) = inserted {
        // Names have to be unambiguous — they are how the organizer picks who a
        // claim link is for — so surface the collision as a real message.
        if is_unique_violation(&error) {
            return Err(http::conflict(format!("{} is already on the list", input.name)));
        }
        return Err(ApiError::from(error));
    }

    // Read the row back rather than mirroring the column defaults by hand;
    // every migration that adds a column would otherwise break this literal.
    let row: Option<MemberRow> = db
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(&id)])?
        .first(None)
        .await?;
    let Some(row) = row else { return Err(http::conflict("Member vanished after insert")) };

    Ok(Response::from_json(&MemberEnvelope { member: db::to_member(&row) })?.with_status(201))
}

async fn update(
    env: &Env,
    identity: &Identity,
    id: &str,
    req: &mut Request,
) -> ApiResult<Response> {
    require_organizer(identity)?;
    let input = update_member_schema(&read_body(req).await?).map_err(Invalid::into_api_error)?;
    let db = crate::env::db(env)?;

    let existing: Option<MemberRow> = db
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(id)])?
        .first(None)
        .await?;
    let Some(existing) = existing else { return Err(http::not_found("No such member")) };

    // Refuse to remove the last way into the admin screens.
    if input.is_organizer == Some(false) || input.active == Some(false) {
        if existing.is_organizer == 1 && count_organizers(&db).await? <= 1 {
            return Err(http::conflict("Promote someone else first — this is the only organizer"));
        }
    }

    let next = MemberRow {
        name: input.name.clone().unwrap_or_else(|| existing.name.clone()),
        is_organizer: match input.is_organizer {
            None => existing.is_organizer,
            Some(true) => 1,
            Some(false) => 0,
        },
        active: match input.active {
            None => existing.active,
            Some(true) => 1,
            Some(false) => 0,
        },
        ..existing
    };

    let written = db
        .prepare("UPDATE members SET name = ?2, is_organizer = ?3, active = ?4 WHERE id = ?1")
        .bind(&[
            text(&next.id),
            text(&next.name),
            number(next.is_organizer as f64),
            number(next.active as f64),
        ]);
    let written = match written {
        Ok(statement) => statement.run().await,
        Err(error) => Err(error),
    };
    if let Err(error) = written {
        if is_unique_violation(&error) {
            return Err(http::conflict(format!("{} is already on the list", next.name)));
        }
        return Err(ApiError::from(error));
    }

    Ok(Response::from_json(&MemberEnvelope { member: db::to_member(&next) })?)
}

/// Soft delete. Registrations and payments reference members, and wiping a
/// row would rewrite the group's financial history — so a departing member is
/// deactivated and simply stops appearing on the name picker.
async fn remove(env: &Env, identity: &Identity, id: &str) -> ApiResult<Response> {
    require_organizer(identity)?;
    let db = crate::env::db(env)?;

    let existing: Option<MemberRow> = db
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(id)])?
        .first(None)
        .await?;
    let Some(existing) = existing else { return Err(http::not_found("No such member")) };
    if existing.is_organizer == 1 && count_organizers(&db).await? <= 1 {
        return Err(http::conflict("Promote someone else first — this is the only organizer"));
    }

    db.prepare("UPDATE members SET active = 0 WHERE id = ?1")
        .bind(&[text(id)])?
        .run()
        .await?;
    Ok(Response::from_json(&Acknowledged { ok: true })?)
}

async fn count_organizers(db: &D1Database) -> ApiResult<i64> {
    #[derive(Deserialize)]
    struct CountRow {
        n: Option<i64>,
    }
    let row: Option<CountRow> = db
        .prepare("SELECT COUNT(*) AS n FROM members WHERE is_organizer = 1 AND active = 1")
        .first(None)
        .await?;
    Ok(row.and_then(|row| row.n).unwrap_or(0))
}

/* ------------------------------------------------------- response envelopes */

#[derive(Serialize)]
struct MemberEnvelope {
    member: Member,
}

/// `{ ok: true }` — what the two routes that only did something answer with.
#[derive(Serialize)]
struct Acknowledged {
    ok: bool,
}

/* ------------------------------------------------------------ body schemas */

/// The first zod issue, as `validate` in `http.ts` reads it: a dotted path and
/// a message, or a bare message when the failure is the body itself.
struct Invalid {
    path: &'static str,
    message: String,
}

impl Invalid {
    fn into_api_error(self) -> ApiError {
        if self.path.is_empty() {
            http::bad_request(self.message)
        } else {
            http::bad_request(format!("{}: {}", self.path, self.message))
        }
    }
}

/// `parseBody(request, schema)` — the body as JSON before any schema sees it.
/// `request.json()` throws on an empty or malformed body, and that throw is a
/// 400 rather than a 500.
async fn read_body(req: &mut Request) -> ApiResult<Value> {
    let raw = req.text().await.map_err(|_| http::bad_request("Expected a JSON body"))?;
    serde_json::from_str(&raw).map_err(|_| http::bad_request("Expected a JSON body"))
}

struct CreateMember {
    name: String,
    is_organizer: bool,
}

/// ```js
/// z.object({
///   name: z.string().trim().min(1, 'Name is required').max(40),
///   isOrganizer: z.boolean().optional().default(false),
/// })
/// ```
///
/// Zod collects every field's issues and `validate` reports only the first, and
/// it walks the shape in declaration order — so returning at the first failure
/// in that same order is the same message.
fn create_member_schema(raw: &Value) -> Result<CreateMember, Invalid> {
    let object = expect_object(raw)?;
    Ok(CreateMember {
        name: expect_name(object, "name", "Name is required")?,
        is_organizer: expect_boolean(object, "isOrganizer")?.unwrap_or(false),
    })
}

struct UpdateMember {
    name: Option<String>,
    is_organizer: Option<bool>,
    active: Option<bool>,
}

/// ```js
/// z.object({
///   name: z.string().trim().min(1).max(40).optional(),
///   isOrganizer: z.boolean().optional(),
///   active: z.boolean().optional(),
/// })
/// ```
fn update_member_schema(raw: &Value) -> Result<UpdateMember, Invalid> {
    let object = expect_object(raw)?;
    Ok(UpdateMember {
        // No custom message on this one, so the failure is zod's own wording.
        name: match object.get("name") {
            None => None,
            Some(_) => Some(expect_name(
                object,
                "name",
                "Too small: expected string to have >=1 characters",
            )?),
        },
        is_organizer: expect_boolean(object, "isOrganizer")?,
        active: expect_boolean(object, "active")?,
    })
}

/// `z.object(...)` on something that is not an object. Arrays and `null` are
/// excluded by `util.isObject`, and both have their own name in the message.
fn expect_object(raw: &Value) -> Result<&Map<String, Value>, Invalid> {
    match raw {
        Value::Object(map) => Ok(map),
        other => Err(Invalid {
            path: "",
            message: format!(
                "Invalid input: expected object, received {}",
                parsed_type(Some(other))
            ),
        }),
    }
}

/// `z.string().trim().min(n, message).max(40)`.
///
/// The order is the order the checks were declared in: trim first, so `"   "`
/// is empty by the time the minimum looks at it. Lengths are counted in UTF-16
/// code units, because that is what `String.prototype.length` counts — a name
/// of 40 emoji is 80 to zod and too big.
fn expect_name(
    object: &Map<String, Value>,
    key: &'static str,
    too_small: &str,
) -> Result<String, Invalid> {
    let value = object.get(key);
    let Some(Value::String(raw)) = value else {
        return Err(Invalid {
            path: key,
            message: format!(
                "Invalid input: expected string, received {}",
                parsed_type(value)
            ),
        });
    };
    let trimmed = js_trim(raw);
    let length: usize = trimmed.chars().map(char::len_utf16).sum();
    if length < 1 {
        return Err(Invalid { path: key, message: too_small.to_string() });
    }
    if length > 40 {
        return Err(Invalid {
            path: key,
            message: String::from("Too big: expected string to have <=40 characters"),
        });
    }
    Ok(trimmed.to_string())
}

/// `z.boolean().optional()`, and — since an absent key never reaches the inner
/// schema — `z.boolean().optional().default(false)` too. A key that is present
/// and not a boolean is an issue either way; `null` is not the same as absent.
fn expect_boolean(
    object: &Map<String, Value>,
    key: &'static str,
) -> Result<Option<bool>, Invalid> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(other) => Err(Invalid {
            path: key,
            message: format!(
                "Invalid input: expected boolean, received {}",
                parsed_type(Some(other))
            ),
        }),
    }
}

/// `util.parsedType` over the values `JSON.parse` can produce. An absent key is
/// `undefined`, which is what a missing required field reports.
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

/// `String.prototype.trim`, which is not `str::trim`: ECMAScript's whitespace
/// set has U+FEFF in it and not U+0085, and Rust's has it the other way round.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| {
        matches!(c,
            '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | '\u{20}' | '\u{a0}'
            | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
            | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

/* ------------------------------------------------------------- primitives */

/// A bound value. D1 takes JS values; text and number are all this file needs.
fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

fn number(value: f64) -> JsValue {
    JsValue::from_f64(value)
}

/// `.run()`'s `meta.changes`, which is how every write here tells whether it
/// found anything.
fn changes(result: &worker::D1Result) -> ApiResult<usize> {
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0))
}

/// `isUniqueViolation(error)` — the name collision the roster's unique index
/// raises, told apart from every other database failure by its message.
///
/// The D1 binding throws an `Error` whose `message` begins `D1_ERROR:`, which is
/// the string the original's regex ran against; `worker` wraps that one in
/// `Error::D1`, whose `Display` shows the *cause* instead. So the message is
/// read off the JavaScript error itself rather than off the wrapper.
pub(crate) fn is_unique_violation(error: &worker::Error) -> bool {
    let message = match error {
        worker::Error::D1(failure) => {
            let inner: &js_sys::Error = failure.as_ref();
            String::from(inner.message())
        }
        other => other.to_string(),
    };
    message.to_lowercase().contains("unique constraint failed")
}

/// `String.prototype.localeCompare` with the default locale, which is what the
/// leaderboard's name tiebreak sorts on. An empty `locales` array means
/// "nothing requested", the same as passing no argument at all.
fn locale_compare(a: &str, b: &str) -> Ordering {
    let result =
        js_sys::JsString::from(a).locale_compare(b, &js_sys::Array::new(), &js_sys::Object::new());
    result.cmp(&0)
}

/// `Number(value)` — not `parseFloat`. The difference is reachable from the
/// wire: `Number('0x10')` is 16, `Number('')` is 0, `Number('12abc')` is NaN
/// where `parseFloat` would say 12.
#[allow(deprecated)]
fn js_number(value: &str) -> f64 {
    js_sys::Number::new(&JsValue::from_str(value)).value_of()
}

/// `Number(query ?? fallback) || fallback` — zero and NaN are both falsy, so
/// `?limit=0` and `?limit=nonsense` mean the default rather than an error.
fn js_or(raw: Option<&str>, fallback: f64) -> f64 {
    let parsed = raw.map(js_number).unwrap_or(fallback);
    if parsed == 0.0 || parsed.is_nan() {
        fallback
    } else {
        parsed
    }
}

/// The same, clamped: `Math.min(Math.max(…, 1), 100)`. Fractional values
/// survive the clamp, and the routes hand them on unrounded.
fn clamped(raw: Option<&str>, fallback: f64) -> f64 {
    js_or(raw, fallback).max(1.0).min(100.0)
}

/// `c.req.param(key)` — Hono percent-decodes a parameter that contains one, and
/// leaves the text alone where the decode throws.
fn param(segment: &str) -> String {
    if segment.contains('%') {
        try_decode(segment)
    } else {
        segment.to_string()
    }
}

/* ------------------------------------------------------------ query string */

/// `c.req.query(key)`, which is `_getQueryParam(url, key)` over the raw URL.
///
/// Not `Url::query_pairs`: the two disagree about a malformed `%` escape, and a
/// cursor is exactly the kind of value that arrives mangled. Hono hands back the
/// text untouched where a decode throws; the `url` crate substitutes U+FFFD,
/// which would turn "unreadable cursor, show the first page" into a different
/// unreadable cursor.
fn query(url: &str, key: &str) -> Option<String> {
    // The library's fast path, taken because every key read here is ASCII with
    // no `%` or `+` in it. It scans the raw URL for `?key` or `&key`.
    let start = index_of(url, "?", 8)?;
    let needle = format!("&{key}");
    let mut key_index = if url[start + 1..].starts_with(key) {
        start
    } else {
        match index_of(url, &needle, start + 1) {
            Some(index) => index,
            None => return query_slow(url, key),
        }
    };

    loop {
        match url.as_bytes().get(key_index + key.len() + 1) {
            // `=`: the value runs to the next `&`, or to the end.
            Some(b'=') => {
                let from = key_index + key.len() + 2;
                let to = index_of(url, "&", from).unwrap_or(url.len());
                return Some(decode_query(&url[from..to]));
            }
            // `&` or the end of the string: the key is present with no value.
            Some(b'&') | None => return Some(String::new()),
            // Some other character — the key is only a prefix of this one.
            _ => {}
        }
        match index_of(url, &needle, key_index + 1) {
            Some(index) => key_index = index,
            None => return query_slow(url, key),
        }
    }
}

/// The general routine the fast path falls back to. Only reachable when the URL
/// carries a `%` or a `+`, because only then can a name that did not match
/// literally still decode to the key.
fn query_slow(url: &str, key: &str) -> Option<String> {
    if !url.contains('%') && !url.contains('+') {
        return None;
    }

    // First occurrence wins (`results[name] ??= value`), so the pairs are
    // collected in order and looked up once at the end.
    let mut results: Vec<(String, String)> = Vec::new();
    let mut cursor = index_of(url, "?", 8);
    while let Some(key_index) = cursor {
        let next = index_of(url, "&", key_index + 1);
        let mut value_index = index_of(url, "=", key_index);
        // An `=` belonging to a later pair does not give this one a value.
        if let (Some(value), Some(next)) = (value_index, next) {
            if value > next {
                value_index = None;
            }
        }
        let name_end = value_index.unwrap_or_else(|| next.unwrap_or(url.len()));
        let name = decode_query(&url[key_index + 1..name_end]);
        cursor = next;
        if name.is_empty() {
            continue;
        }
        let value = match value_index {
            None => String::new(),
            Some(value_index) => {
                decode_query(&url[value_index + 1..next.unwrap_or(url.len())])
            }
        };
        if !results.iter().any(|(seen, _)| *seen == name) {
            results.push((name, value));
        }
    }
    results.into_iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

/// `_decodeURI` — `+` is a space, then a percent-decode that never throws.
fn decode_query(value: &str) -> String {
    if !value.contains('%') && !value.contains('+') {
        return value.to_string();
    }
    let value = if value.contains('+') { value.replace('+', " ") } else { value.to_string() };
    if value.contains('%') {
        try_decode(&value)
    } else {
        value
    }
}

/// `tryDecode(value, decodeURIComponent)`: the whole string when that decodes,
/// otherwise each run of escapes decoded on its own, and the raw text kept
/// wherever even that fails. A bad escape is data, never an error.
fn try_decode(value: &str) -> String {
    if let Ok(decoded) = js_sys::decode_uri_component(value) {
        return String::from(decoded);
    }

    // `/(?:%[0-9A-Fa-f]{2})+/g`, one maximal run at a time.
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < bytes.len() {
        let start = index;
        while bytes.get(index) == Some(&b'%')
            && bytes.get(index + 1).is_some_and(u8::is_ascii_hexdigit)
            && bytes.get(index + 2).is_some_and(u8::is_ascii_hexdigit)
        {
            index += 3;
        }
        if index > start {
            let run = &value[start..index];
            match js_sys::decode_uri_component(run) {
                Ok(decoded) => out.push_str(&String::from(decoded)),
                Err(_) => out.push_str(run),
            }
            continue;
        }
        let next = value[index..].chars().next().expect("index is a char boundary");
        out.push(next);
        index += next.len_utf8();
    }
    out
}

/// `String.prototype.indexOf(needle, from)`, in bytes. Every caller searches for
/// ASCII from a position an ASCII character was found at, so byte offsets and
/// the UTF-16 offsets JavaScript counts move together.
fn index_of(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    haystack.get(from..)?.find(needle).map(|index| index + from)
}

/* ------------------------------------------------------------------ base64 */

/// `btoa` over raw bytes: the standard alphabet with `=` padding, which is what
/// the cursors are and what tells them apart from the base64url the identity
/// tokens use.
fn btoa(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let packed = (u32::from(group[0]) << 16)
            | (u32::from(group.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(group.get(2).copied().unwrap_or(0));
        out.push(ALPHABET[(packed >> 18) as usize & 63] as char);
        out.push(ALPHABET[(packed >> 12) as usize & 63] as char);
        out.push(if group.len() > 1 { ALPHABET[(packed >> 6) as usize & 63] as char } else { '=' });
        out.push(if group.len() > 2 { ALPHABET[packed as usize & 63] as char } else { '=' });
    }
    out
}

/// `atob`, the WHATWG "forgiving-base64 decode": ASCII whitespace is stripped
/// first, then up to two trailing `=` come off a properly sized string, a
/// remainder of one character is a failure, and anything outside the alphabet is
/// a failure. Every failure is `None`, because the caller reads that as "start
/// from the beginning".
fn atob(value: &str) -> Option<Vec<u8>> {
    let mut data: Vec<u8> = value
        .bytes()
        .filter(|byte| !matches!(byte, b'\t' | b'\n' | b'\x0c' | b'\r' | b' '))
        .collect();
    if !value.is_ascii() {
        return None;
    }
    if data.len() % 4 == 0 {
        for _ in 0..2 {
            if data.last() == Some(&b'=') {
                data.pop();
            }
        }
    }
    if data.len() % 4 == 1 {
        return None;
    }

    let mut out = Vec::with_capacity(data.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in data {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            // A leftover `=` included: well-formed padding is already off.
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    // The bits past the last whole byte are dropped, not checked for zero.
    Some(out)
}
