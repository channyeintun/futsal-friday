//! Issuing and revoking claim links, and the one link the group chat gets.
//!
//! Ported from `src/routes/claims.ts`, which exported **three** Hono routers
//! mounted at two different points in `index.ts` — so this file exposes two
//! entry points rather than one, and the split is exactly that mounting:
//!
//! - [`route`] is `claimRoutes` + `groupInviteRoutes`, both registered inside
//!   `protectedRoutes` (positions 9 and 10, with nothing of theirs in between),
//!   so every request has already passed `requireMember` and `requireApproved`.
//! - [`route_group_join`] is `groupJoinRoutes`, registered on the app *before*
//!   `protectedRoutes` and therefore before the two `ALL /*` auth middlewares.
//!
//! ## Why three of these routes have no authentication
//!
//! `POST /auth/group/{roster,claim,self-add}` are unauthenticated **by
//! necessity**: they are what somebody holding the group link uses to get a
//! credential in the first place, and nobody has one yet. Nothing is relaxed to
//! make that work — every restriction moved into the SQL instead:
//!
//! - the nonce is checked against the singleton `group_invite` row and its
//!   expiry on every one of the three, before anything else happens;
//! - the roster lists only `active = 1 AND is_organizer = 0 AND claimed_at IS
//!   NULL`, so it reveals no organizer and nobody already spoken for;
//! - claiming a name is a single `UPDATE … WHERE … is_organizer = 0 AND
//!   claimed_at IS NULL`, which is both the race resolver and the reason
//!   admin cannot be claimed this way;
//! - adding yourself writes `approved_at NULL`, so the credential it hands back
//!   opens the waiting room and nothing else — a link pasted into a chat can be
//!   forwarded out of it.
//!
//! A chat message is not a secret and this link is not treated as one. What
//! makes it safe is what redeeming it is allowed to do.
//!
//! Two audiences for the per-person links, too: the organizer, handing out
//! identities to the group; and a member adding their own second device, which
//! they can do without waiting on anybody — they are already authenticated, so
//! letting them mint a link for themselves grants no access they do not
//! already have.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use wasm_bindgen::JsValue;
use worker::d1::D1Database;
use worker::{Context, Env, Method, Request, Response};

use crate::db::{self, MemberRow};
use crate::http::{self, ApiError, ApiResult};
use crate::identity::{self, CLAIM_TTL_MS, GROUP_INVITE_TTL_MS};
use crate::js;
use crate::middleware::{require_organizer, Identity};
use crate::routes::members::is_unique_violation;

/// `claimRoutes` and `groupInviteRoutes`. `None` when nothing matches, so the
/// dispatcher can try the next router; a path this file owns with the wrong
/// method is `None` too, because Hono matched on method and the miss fell
/// through to the not-found handler rather than to a 405.
pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    let path = req.path();

    match (req.method(), path.as_str()) {
        (Method::Post, "/auth/my-device-link") => return Some(my_device_link(env, identity).await),
        (Method::Get, "/group-invite") => return Some(read_invite(env, identity).await),
        (Method::Post, "/group-invite") => return Some(rotate_invite(env, identity).await),
        _ => {}
    }

    // `/members/:id/claim-link` and `/members/:id/claim`. `memberRoutes` is
    // mounted first but declares nothing of this shape, so these are reached.
    let mut segments = path.split('/').skip(1);
    if segments.next() != Some("members") {
        return None;
    }
    let id = segments.next().filter(|id| !id.is_empty())?;
    let tail = segments.next()?;
    if segments.next().is_some() {
        return None;
    }
    let id = decode_param(id);

    match (req.method(), tail) {
        (Method::Post, "claim-link") => Some(mint_for_member(env, identity, &id).await),
        (Method::Delete, "claim") => Some(revoke_claim(env, identity, &id).await),
        _ => None,
    }
}

/// `groupJoinRoutes` — see the module docs for why none of this is
/// authenticated. `ctx` is here because self-add tells the organizers on
/// `waitUntil`, which is a handle only the fetch event has.
pub async fn route_group_join(
    req: &mut Request,
    env: &Env,
    ctx: &Context,
) -> Option<ApiResult<Response>> {
    match (req.method(), req.path().as_str()) {
        (Method::Post, "/auth/group/roster") => Some(roster(req, env).await),
        (Method::Post, "/auth/group/claim") => Some(claim_name(req, env).await),
        (Method::Post, "/auth/group/self-add") => Some(self_add(req, env, ctx).await),
        _ => None,
    }
}

/* --------------------------------------------------------- per-person links */

/// Organizer: mint a link for someone. Replaces any outstanding one.
async fn mint_for_member(env: &Env, identity: &Identity, id: &str) -> ApiResult<Response> {
    require_organizer(identity)?;

    let db_handle = crate::env::db(env)?;
    let member: Option<MemberRow> = db_handle
        .prepare("SELECT * FROM members WHERE id = ?1 AND active = 1")
        .bind(&[text(id)])?
        .first(None)
        .await?;
    let Some(member) = member else {
        return Err(http::not_found("No such member"));
    };

    let link = mint_link(&db_handle, &crate::env::app_url(env), &member).await?;
    Ok(Response::from_json(&link)?)
}

/// A member adding another device.
///
/// Without this, every new phone or laptop would need the organizer, which is
/// the kind of friction that ends with people sharing one login.
async fn my_device_link(env: &Env, identity: &Identity) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    // No `active = 1` here, unlike the organizer's route: the caller has already
    // been through `requireMember`, which reads the row with that filter.
    let member: Option<MemberRow> = db_handle
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(&identity.member_id)])?
        .first(None)
        .await?;
    let Some(member) = member else {
        return Err(http::not_found("No such member"));
    };

    let link = mint_link(&db_handle, &crate::env::app_url(env), &member).await?;
    Ok(Response::from_json(&link)?)
}

/// Organizer: cut a member off.
///
/// Bumping `token_version` invalidates every session token that member holds,
/// which is what "I lost my phone" actually requires — the tokens are stateless
/// and otherwise good for 90 days. Any outstanding link is dropped at the same
/// time, and `claimed_at` is cleared so the roster shows them as needing a fresh
/// invitation.
async fn revoke_claim(env: &Env, identity: &Identity, id: &str) -> ApiResult<Response> {
    require_organizer(identity)?;

    let db_handle = crate::env::db(env)?;
    let member: Option<MemberRow> = db_handle
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(id)])?
        .first(None)
        .await?;
    if member.is_none() {
        return Err(http::not_found("No such member"));
    }

    // Signing yourself out of the app you are using to do it, with no link in
    // hand, is a lockout waiting to happen.
    if id == identity.member_id {
        return Err(http::conflict(
            "Use \"Add another device\" to move yourself, or sign out normally",
        ));
    }

    db_handle
        .prepare(
            "UPDATE members
          SET token_version = token_version + 1,
              claim_nonce = NULL,
              claim_expires_at = NULL,
              claimed_at = NULL
        WHERE id = ?1",
        )
        .bind(&[text(id)])?
        .run()
        .await?;

    Ok(Response::from_json(&serde_json::json!({ "ok": true }))?)
}

async fn mint_link(db: &D1Database, app_url: &str, member: &MemberRow) -> ApiResult<ClaimLink> {
    let nonce = identity::new_claim_nonce();
    let expires_at = http::iso_of(js::now_ms() + CLAIM_TTL_MS);

    db.prepare("UPDATE members SET claim_nonce = ?2, claim_expires_at = ?3 WHERE id = ?1")
        .bind(&[text(&member.id), text(&nonce), text(&expires_at)])?
        .run()
        .await?;

    Ok(ClaimLink {
        // The nonce goes in the fragment: browsers never put it in the request
        // line, so it stays out of server logs, proxy logs and Referer headers.
        url: format!("{}/claim#{nonce}", trim_trailing_slash(app_url)),
        expires_at,
        member_name: member.name.clone(),
    })
}

/* ------------------------------------------------------------ group invite */

async fn read_invite(env: &Env, identity: &Identity) -> ApiResult<Response> {
    require_organizer(identity)?;

    let db_handle = crate::env::db(env)?;
    let row: Option<InviteRow> =
        db_handle.prepare("SELECT * FROM group_invite WHERE id = 1").first(None).await?;

    // Expiry is `<=` here where the redemption check is `expires_at > ?`, so the
    // instant it lapses the organizer stops being shown a link that would no
    // longer work.
    let Some(row) = row.filter(|row| row.expires_at > http::now_iso()) else {
        return Ok(Response::from_json(&Invite { invite: None })?);
    };

    let invite = describe_invite(&db_handle, &crate::env::app_url(env), &row).await?;
    Ok(Response::from_json(&Invite { invite: Some(invite) })?)
}

/// Create or rotate it. Rotating kills the copy sitting in the chat history.
async fn rotate_invite(env: &Env, identity: &Identity) -> ApiResult<Response> {
    require_organizer(identity)?;

    let nonce = identity::new_claim_nonce();
    let expires_at = http::iso_of(js::now_ms() + GROUP_INVITE_TTL_MS);

    let db_handle = crate::env::db(env)?;
    db_handle
        .prepare(
            "INSERT INTO group_invite (id, nonce, expires_at, created_at, created_by)
       VALUES (1, ?1, ?2, ?3, ?4)
       ON CONFLICT (id) DO UPDATE SET
         nonce = excluded.nonce,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at,
         created_by = excluded.created_by",
        )
        // `created_at` is a second reading of the clock, taken after the one
        // `expires_at` was measured from.
        .bind(&[
            text(&nonce),
            text(&expires_at),
            text(&http::now_iso()),
            text(&identity.member_id),
        ])?
        .run()
        .await?;

    let row = InviteRow { nonce, expires_at };
    let invite = describe_invite(&db_handle, &crate::env::app_url(env), &row).await?;
    Ok(Response::from_json(&Invite { invite: Some(invite) })?)
}

async fn describe_invite(
    db: &D1Database,
    app_url: &str,
    row: &InviteRow,
) -> ApiResult<GroupInvite> {
    let count: Option<CountRow> =
        db.prepare(format!("SELECT COUNT(*) AS n FROM ({JOINABLE_QUERY})")).first(None).await?;

    Ok(GroupInvite {
        url: format!("{}/join#{}", trim_trailing_slash(app_url), row.nonce),
        expires_at: row.expires_at.clone(),
        unclaimed: count.map_or(0, |count| count.n),
    })
}

/* --------------------------------------------------------------- group join */

/// The names still up for grabs. Reveals nothing else about the group.
async fn roster(req: &mut Request, env: &Env) -> ApiResult<Response> {
    let nonce = parse_group_join(&read_body(req).await?)?;

    let db_handle = crate::env::db(env)?;
    require_valid_group_nonce(&db_handle, &nonce).await?;

    let results = db_handle.prepare(JOINABLE_QUERY).all().await?;
    let members: Vec<JoinableMember> = results.results()?;
    Ok(Response::from_json(&Roster { members })?)
}

/// Take a name. It locks to this device and leaves the list for good.
async fn claim_name(req: &mut Request, env: &Env) -> ApiResult<Response> {
    let input = parse_group_claim(&read_body(req).await?)?;

    let db_handle = crate::env::db(env)?;
    require_valid_group_nonce(&db_handle, &input.nonce).await?;

    let timestamp = http::now_iso();

    // Guarded in the statement, not before it: `claimed_at IS NULL` is what
    // makes two people racing for the same name resolve to one winner, and
    // `is_organizer = 0` is what stops admin being claimed this way.
    let taken = db_handle
        .prepare(
            "UPDATE members
          SET claimed_at = ?2, claim_nonce = NULL, claim_expires_at = NULL
        WHERE id = ?1 AND active = 1 AND is_organizer = 0 AND claimed_at IS NULL",
        )
        .bind(&[text(&input.member_id), text(&timestamp)])?
        .run()
        .await?;

    if taken.meta()?.and_then(|meta| meta.changes) == Some(0) {
        return Err(http::conflict(
            "Somebody already took that name. Pick another, or ask the organizer.",
        ));
    }

    let row: Option<MemberRow> = db_handle
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(&input.member_id)])?
        .first(None)
        .await?;
    let Some(row) = row else {
        return Err(http::not_found("No such member"));
    };

    let member = db::to_member(&row);
    let identity = Identity {
        member_id: member.id,
        name: member.name,
        is_organizer: member.is_organizer,
        language: member.language,
        hour12: member.hour12,
        approved: member.approved_at.is_some(),
    };

    let credential = identity::issue(&identity, row.token_version, env).await?;
    let response = Response::from_json(&Credential { token: &credential.token, identity })?;
    if let Some(set_cookie) = &credential.set_cookie {
        response.headers().set("Set-Cookie", set_cookie)?;
    }
    Ok(response)
}

/// "My name isn't here."
///
/// The roster used to have to be typed out in full before the link was worth
/// sending, which is the work the one-link design was supposed to remove. So
/// somebody holding the link can put their own name forward instead — and lands
/// in the waiting room rather than in the group, because a link pasted into a
/// chat can be forwarded out of it.
async fn self_add(req: &mut Request, env: &Env, ctx: &Context) -> ApiResult<Response> {
    let input = parse_group_self_add(&read_body(req).await?)?;

    let db_handle = crate::env::db(env)?;
    require_valid_group_nonce(&db_handle, &input.nonce).await?;

    let timestamp = http::now_iso();
    let id = http::new_id("mem");

    let inserted = db_handle
        .prepare(
            // `approved_at` stays NULL: they are asking, not joining. Claimed
            // immediately, though — the name belongs to this device from the
            // moment it is requested, so nobody can take it while they wait.
            "INSERT INTO members (id, name, is_organizer, active, created_at, claimed_at, approved_at)
         VALUES (?1, ?2, 0, 1, ?3, ?3, NULL)",
        )
        .bind(&[text(&id), text(&input.name), text(&timestamp)])?
        .run()
        .await;
    if let Err(error) = inserted {
        // The name may be one the organizer already typed in, in which case the
        // list is where they should have tapped.
        if is_unique_violation(&error) {
            return Err(http::conflict(format!(
                "{} is already on the list — tap that name instead.",
                input.name
            )));
        }
        return Err(ApiError::from(error));
    }

    let row: Option<MemberRow> = db_handle
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(&id)])?
        .first(None)
        .await?;
    let Some(row) = row else {
        return Err(http::conflict("Could not add you — try again"));
    };

    let member = db::to_member(&row);
    let name = member.name.clone();
    // `isOrganizer` and `approved` are written here rather than read from the
    // row, unlike the name picker's: the statement above settles both, and
    // somebody who has just asked to join is neither.
    let identity = Identity {
        member_id: member.id,
        name: member.name,
        is_organizer: false,
        language: member.language,
        hour12: member.hour12,
        approved: false,
    };

    let credential = identity::issue(&identity, row.token_version, env).await?;
    let response =
        Response::from_json(&Credential { token: &credential.token, identity })?.with_status(201);
    if let Some(set_cookie) = &credential.set_cookie {
        response.headers().set("Set-Cookie", set_cookie)?;
    }

    // Somebody waiting on a screen that says "ask the organizer" is only a
    // feature if the organizer finds out. Never fatal: they are in the roster
    // either way, and failing the request would strand them for no reason.
    let env = env.clone();
    ctx.wait_until(async move {
        if let Err(error) = crate::notifications::notify_organizers_of_request(&env, &name).await {
            worker::console_error!(
                "Could not tell the organizers about a join request {:?}",
                error
            );
        }
    });

    Ok(response)
}

/// Who the group link may be used to become: active, not yet claimed, and not
/// an organizer. Defined once so the roster and the claim cannot disagree, and
/// wrapped verbatim by the `COUNT(*)` the invite is described with.
const JOINABLE_QUERY: &str = "
  SELECT id, name FROM members
   WHERE active = 1 AND is_organizer = 0 AND claimed_at IS NULL
   ORDER BY name COLLATE NOCASE ASC
";

/// The expiry check is the `WHERE`, so a lapsed link and a wrong one are the
/// same answer — telling them apart would tell a stranger which they hold.
async fn require_valid_group_nonce(db: &D1Database, nonce: &str) -> ApiResult<()> {
    let row: Option<NonceRow> = db
        .prepare("SELECT nonce FROM group_invite WHERE id = 1 AND nonce = ?1 AND expires_at > ?2")
        .bind(&[text(nonce), text(&http::now_iso())])?
        .first(None)
        .await?;

    if row.is_none() {
        return Err(http::unauthorized(
            "That group link is not valid any more. Ask for a new one.",
        ));
    }
    Ok(())
}

/// `appUrl.replace(/\/$/, '')` — one trailing slash, not all of them.
fn trim_trailing_slash(app_url: &str) -> &str {
    app_url.strip_suffix('/').unwrap_or(app_url)
}

/* ---------------------------------------------------------- rows and output */

#[derive(Deserialize)]
struct InviteRow {
    nonce: String,
    expires_at: String,
}

#[derive(Deserialize)]
struct NonceRow {
    #[allow(dead_code)]
    nonce: String,
}

#[derive(Deserialize)]
struct CountRow {
    n: i64,
}

#[derive(Serialize, Deserialize)]
struct JoinableMember {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimLink {
    url: String,
    expires_at: String,
    member_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupInvite {
    url: String,
    expires_at: String,
    unclaimed: i64,
}

#[derive(Serialize)]
struct Invite {
    invite: Option<GroupInvite>,
}

#[derive(Serialize)]
struct Roster {
    members: Vec<JoinableMember>,
}

/// Two top-level keys, `token` before `identity`.
#[derive(Serialize)]
struct Credential<'a> {
    token: &'a str,
    identity: Identity,
}

/* --------------------------------------------------------- body validation */

#[derive(Debug)]
struct GroupClaim {
    nonce: String,
    member_id: String,
}

#[derive(Debug)]
struct GroupSelfAdd {
    nonce: String,
    name: String,
}

/// `await request.json()` — a read and a parse, and either throw lands in the
/// same `catch` and becomes the one 400.
async fn read_body(req: &mut Request) -> ApiResult<Value> {
    let raw = match req.text().await {
        Ok(text) => serde_json::from_str::<Value>(&text),
        Err(_) => return Err(http::bad_request("Expected a JSON body")),
    };
    raw.map_err(|_| http::bad_request("Expected a JSON body"))
}

/// `groupJoinSchema` — `z.object({ nonce: z.string().min(20).max(100) })`.
fn parse_group_join(raw: &Value) -> ApiResult<String> {
    let object = as_object(raw)?;
    bounded_string(object, "nonce", 20, Some(100))
}

/// `groupClaimSchema` — the same nonce plus `idSchema`.
fn parse_group_claim(raw: &Value) -> ApiResult<GroupClaim> {
    let object = as_object(raw)?;
    // Keys are checked in the order the schema declares them, because that is
    // the order zod collects issues in and only `issues[0]` is ever reported.
    Ok(GroupClaim {
        nonce: bounded_string(object, "nonce", 20, Some(100))?,
        member_id: bounded_string(object, "memberId", 1, Some(64))?,
    })
}

/// `groupSelfAddSchema`. The nonce here has **no** upper bound, unlike the other
/// two — the schema simply does not declare one.
fn parse_group_self_add(raw: &Value) -> ApiResult<GroupSelfAdd> {
    let object = as_object(raw)?;
    Ok(GroupSelfAdd {
        nonce: bounded_string(object, "nonce", 20, None)?,
        name: required_trimmed(object, "name", "Name is required", 40)?,
    })
}

/// The object `safeParse` starts from. Its own failure has an empty path, and
/// `path.join('.')` of `[]` is falsy, so that message travels without a prefix.
fn as_object(raw: &Value) -> ApiResult<&Map<String, Value>> {
    raw.as_object().ok_or_else(|| {
        http::bad_request(format!("Invalid input: expected object, received {}", zod_type(raw)))
    })
}

/// `z.string().min(min)` with an optional `.max(max)`. No trimming: these two
/// values are looked up verbatim, so trimming them would change what is looked
/// up.
fn bounded_string(
    object: &Map<String, Value>,
    key: &str,
    min: usize,
    max: Option<usize>,
) -> ApiResult<String> {
    let value = expect_string(object.get(key), key)?;
    let length = utf16_len(value);
    if length < min {
        return Err(issue(key, format!("Too small: expected string to have >={min} characters")));
    }
    if let Some(max) = max {
        if length > max {
            return Err(issue(key, format!("Too big: expected string to have <={max} characters")));
        }
    }
    Ok(value.to_string())
}

/// `z.string().trim().min(1, empty).max(max)`.
///
/// `.trim()` is a check like any other and runs first, so the length rules see
/// the trimmed value — a name of nothing but spaces is "required", not "too
/// short" — and the trimmed value is what gets stored.
fn required_trimmed(
    object: &Map<String, Value>,
    key: &str,
    empty: &str,
    max: usize,
) -> ApiResult<String> {
    let value = js_trim(expect_string(object.get(key), key)?);
    if utf16_len(value) < 1 {
        return Err(issue(key, empty));
    }
    if utf16_len(value) > max {
        return Err(issue(key, format!("Too big: expected string to have <={max} characters")));
    }
    Ok(value.to_string())
}

fn expect_string<'a>(value: Option<&'a Value>, key: &str) -> ApiResult<&'a str> {
    match value {
        Some(Value::String(value)) => Ok(value),
        Some(other) => {
            Err(issue(key, format!("Invalid input: expected string, received {}", zod_type(other))))
        }
        // An absent key is `undefined`, which zod names rather than skips.
        None => Err(issue(key, "Invalid input: expected string, received undefined")),
    }
}

/// `validate`'s message: the dotted path, then the issue's own text.
fn issue(path: &str, message: impl AsRef<str>) -> ApiError {
    http::bad_request(format!("{path}: {}", message.as_ref()))
}

/// The names zod prints in `expected X, received Y`. An array is its own name
/// there rather than `object`, which is the one place it differs from `typeof`.
fn zod_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// zod measures `String.prototype.length`, which counts UTF-16 code units: ten
/// emoji are twenty characters and clear a minimum of twenty.
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// JavaScript's `trim`: `WhiteSpace` plus `LineTerminator`, which is Unicode's
/// `White_Space` with U+FEFF added and U+0085 left out.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

/// Hono decoded a path parameter with `decodeURIComponent` when it still held a
/// `%`, falling back to decoding whatever runs of it were well formed.
fn decode_param(value: &str) -> String {
    if !value.contains('%') {
        return value.to_string();
    }
    match decode_uri_component(value) {
        Some(decoded) => decoded,
        None => decode_valid_runs(value),
    }
}

/// `decodeURIComponent`: percent-escapes are UTF-8 bytes, and a malformed
/// escape or a byte sequence that is not UTF-8 throws.
fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The `catch` half: every maximal run of `%XX` is decoded on its own, and one
/// that still refuses is left as written.
fn decode_valid_runs(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            let character = value[index..].chars().next().expect("index is a char boundary");
            out.push(character);
            index += character.len_utf8();
            continue;
        }
        let start = index;
        while bytes.get(index) == Some(&b'%')
            && value
                .get(index + 1..index + 3)
                .is_some_and(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            index += 3;
        }
        if index == start {
            out.push('%');
            index += 1;
            continue;
        }
        let run = &value[start..index];
        match decode_uri_component(run) {
            Some(decoded) => out.push_str(&decoded),
            None => out.push_str(run),
        }
    }
    out
}

fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn join_error(json: &str) -> String {
        parse_group_join(&serde_json::from_str(json).unwrap()).unwrap_err().message
    }

    fn claim_error(json: &str) -> String {
        parse_group_claim(&serde_json::from_str(json).unwrap()).unwrap_err().message
    }

    fn self_add_error(json: &str) -> String {
        parse_group_self_add(&serde_json::from_str(json).unwrap()).unwrap_err().message
    }

    /// Every string here was taken from zod 4.4.3 running the real schemas
    /// through the real `validate`.
    #[test]
    fn words_the_issues_the_way_zod_does() {
        assert_eq!(join_error("{}"), "nonce: Invalid input: expected string, received undefined");
        assert_eq!(
            join_error(r#"{"nonce":null}"#),
            "nonce: Invalid input: expected string, received null"
        );
        assert_eq!(
            join_error(r#"{"nonce":5}"#),
            "nonce: Invalid input: expected string, received number"
        );
        assert_eq!(
            join_error(r#"{"nonce":"short"}"#),
            "nonce: Too small: expected string to have >=20 characters"
        );
        assert_eq!(
            join_error(&format!(r#"{{"nonce":"{}"}}"#, "x".repeat(101))),
            "nonce: Too big: expected string to have <=100 characters"
        );

        assert_eq!(
            claim_error(&format!(r#"{{"nonce":"{}","memberId":""}}"#, "x".repeat(43))),
            "memberId: Too small: expected string to have >=1 characters"
        );
        assert_eq!(
            claim_error(&format!(
                r#"{{"nonce":"{}","memberId":"{}"}}"#,
                "x".repeat(43),
                "m".repeat(65)
            )),
            "memberId: Too big: expected string to have <=64 characters"
        );

        assert_eq!(
            self_add_error(&format!(r#"{{"nonce":"{}","name":"  "}}"#, "x".repeat(43))),
            "name: Name is required"
        );
        assert_eq!(
            self_add_error(&format!(
                r#"{{"nonce":"{}","name":"{}"}}"#,
                "x".repeat(43),
                "y".repeat(41)
            )),
            "name: Too big: expected string to have <=40 characters"
        );

        // The object's own failure has an empty path, so no prefix.
        assert_eq!(join_error(r#""nope""#), "Invalid input: expected object, received string");
        assert_eq!(join_error("[]"), "Invalid input: expected object, received array");
        assert_eq!(join_error("null"), "Invalid input: expected object, received null");
    }

    /// Both keys can fail at once; the first one declared is the one reported.
    #[test]
    fn reports_only_the_first_issue() {
        assert_eq!(
            claim_error(r#"{"nonce":"short"}"#),
            "nonce: Too small: expected string to have >=20 characters"
        );
        assert_eq!(
            self_add_error("{}"),
            "nonce: Invalid input: expected string, received undefined"
        );
    }

    #[test]
    fn accepts_what_the_schemas_accept() {
        // Ten emoji are twenty UTF-16 code units.
        assert_eq!(
            parse_group_join(&serde_json::json!({ "nonce": "😀".repeat(10) })).unwrap(),
            "😀".repeat(10)
        );
        // Self-add's nonce has no ceiling.
        let long = "x".repeat(5_000);
        let input =
            parse_group_self_add(&serde_json::json!({ "nonce": long, "name": "  Bob  " })).unwrap();
        assert_eq!(input.nonce.len(), 5_000);
        // The stored name is the trimmed one, and it is what the conflict
        // message and the push both quote.
        assert_eq!(input.name, "Bob");
        // Unknown keys are stripped, not rejected.
        let nonce = "x".repeat(43);
        assert!(parse_group_join(&serde_json::json!({ "nonce": nonce, "extra": 1 })).is_ok());
    }

    #[test]
    fn trims_one_trailing_slash_from_the_app_url() {
        assert_eq!(trim_trailing_slash("https://app.example"), "https://app.example");
        assert_eq!(trim_trailing_slash("https://app.example/"), "https://app.example");
        assert_eq!(trim_trailing_slash("https://app.example//"), "https://app.example/");
        assert_eq!(trim_trailing_slash(""), "");
    }

    /// The two statements that quote it must see the same text, newlines
    /// included — `SELECT COUNT(*) AS n FROM (…)` wraps this verbatim.
    #[test]
    fn keeps_the_joinable_query_verbatim() {
        assert_eq!(
            JOINABLE_QUERY,
            "\n  SELECT id, name FROM members\n   WHERE active = 1 AND is_organizer = 0 AND \
             claimed_at IS NULL\n   ORDER BY name COLLATE NOCASE ASC\n"
        );
    }

    /// Hono only decoded a parameter that still held a `%`, and fell back to
    /// decoding the well-formed runs when the whole thing would not decode.
    #[test]
    fn decodes_path_parameters_like_hono() {
        assert_eq!(decode_param("mem_abc"), "mem_abc");
        assert_eq!(decode_param("a%2Fb"), "a/b");
        assert_eq!(decode_param("caf%C3%A9"), "café");
        assert_eq!(decode_param("a%25b"), "a%b");
        assert_eq!(decode_param("a%zzb"), "a%zzb");
        assert_eq!(decode_param("%41%zz%42"), "A%zzB");
        assert_eq!(decode_param("%FF"), "%FF");
    }
}
