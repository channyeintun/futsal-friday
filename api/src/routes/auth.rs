//! Getting in.
//!
//! Two ways: redeem a claim link the organizer sent you, or type your name and
//! a password. The password is the group's shared one until you choose your
//! own — see `password.rs` for why it exists at all.
//!
//! The previous design — a group-wide invite code plus "pick who you are" — had
//! two problems that only look small until you think about money. Anyone holding
//! the code could pick *any* name, including an organizer's, which made
//! privilege escalation a two-tap operation; and the code itself sits in a group
//! chat forever, so it never really expires. A per-person, single-use link fixes
//! both: it names its holder, it is spent on first use, and it can be reissued
//! without disturbing anybody else.
//!
//! Ported from `src/routes/auth.ts`, which Hono mounted at `/auth` with no auth
//! middleware of its own — `/auth/me` and changing your password declare
//! `requireMember()` themselves and are the only ones that have any.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wasm_bindgen::JsValue;
use worker::{Env, Method, Request, Response};

use crate::db::{self, MemberRow};
use crate::http::{self, ApiResult};
use crate::identity::{self, IssuedCredential};
use crate::js;
use crate::middleware::{self, Identity};
use crate::password;

/// `None` when nothing here matches, so the dispatcher can go on to the next
/// router. A path this file owns but with the wrong method is also `None`: Hono
/// matched on method too, so `GET /auth/claim` fell through to the `ALL /*`
/// gates that `protectedRoutes` installed and came back 401, not 404.
pub async fn route(req: &mut Request, env: &Env) -> Option<ApiResult<Response>> {
    match (req.method(), req.path().as_str()) {
        (Method::Post, "/auth/claim") => Some(claim(req, env).await),
        (Method::Post, "/auth/password") => Some(sign_in(req, env).await),
        (Method::Put, "/auth/password") => Some(change_password(req, env).await),
        (Method::Get, "/auth/me") => Some(me(req, env).await),
        (Method::Post, "/auth/logout") => Some(logout()),
        _ => None,
    }
}

/// Redeem a link. The nonce is looked up directly — the row is the proof — and
/// cleared in the same statement, so a forwarded link is worthless once the
/// first person has opened it.
async fn claim(req: &mut Request, env: &Env) -> ApiResult<Response> {
    let nonce = parse_body(req).await?;
    let timestamp = http::now_iso();

    let db_handle = crate::env::db(env)?;
    let row: Option<MemberRow> = db_handle
        .prepare(
            "SELECT * FROM members
        WHERE claim_nonce = ?1 AND active = 1 AND claim_expires_at > ?2",
        )
        .bind(&[JsValue::from_str(&nonce), JsValue::from_str(&timestamp)])?
        .first(None)
        .await?;

    // One message for "wrong", "expired" and "already used": distinguishing
    // them would tell a stranger which of those a value happens to be.
    let Some(row) = row else {
        return Err(spent_link());
    };

    // Spend it. Guarded on the nonce so two simultaneous opens cannot both win.
    let spent = db_handle
        .prepare(
            "UPDATE members
          SET claim_nonce = NULL,
              claim_expires_at = NULL,
              claimed_at = COALESCE(claimed_at, ?2)
        WHERE id = ?1 AND claim_nonce = ?3",
        )
        .bind(&[
            JsValue::from_str(&row.id),
            JsValue::from_str(&timestamp),
            JsValue::from_str(&nonce),
        ])?
        .run()
        .await?;

    // `spent.meta.changes === 0`. A D1 result that carried no meta at all would
    // have read as `undefined === 0`, i.e. false; there is no such result, and
    // the loser of the race is the row-count case either way.
    if spent.meta()?.and_then(|meta| meta.changes) == Some(0) {
        return Err(spent_link());
    }

    // The row as it was read, before the update: `hasPendingLink` is therefore
    // computed from the nonce this request just spent and is `true`, and
    // `claimedAt` is the old value — `null` for a first redemption.
    let member = db::to_member(&row);
    let identity = Identity {
        member_id: member.id,
        name: member.name,
        is_organizer: member.is_organizer,
        language: member.language,
        hour12: member.hour12,
        approved: member.approved_at.is_some(),
        has_password: row.password_hash.is_some(),
    };

    let credential = identity::issue(&identity, row.token_version, env).await?;
    signed_in(&identity, &credential)
}

/// Name and password.
///
/// The name is matched the way the roster keeps names unique — ignoring ASCII
/// case — so "an" finds "An". One message for an unknown name and a wrong
/// password, for the same reason the link has one message for its failures.
async fn sign_in(req: &mut Request, env: &Env) -> ApiResult<Response> {
    let body = read_json(req).await?;
    let name = string_field(&body, "name")?;
    let attempt = string_field(&body, "password")?;
    let name = name.trim();

    // Bounded before anything is looked up or hashed: this is the one route a
    // stranger can make spend CPU.
    if name.is_empty()
        || name.chars().count() > 100
        || attempt.is_empty()
        || attempt.chars().count() > password::MAX_LENGTH
    {
        return Err(wrong_password());
    }

    let db_handle = crate::env::db(env)?;
    let row: Option<MemberRow> = db_handle
        .prepare("SELECT * FROM members WHERE name = ?1 COLLATE NOCASE AND active = 1")
        .bind(&[JsValue::from_str(name)])?
        .first(None)
        .await?;
    let Some(row) = row else {
        return Err(wrong_password());
    };

    let accepted = match &row.password_hash {
        Some(stored) => password::verify(&attempt, stored).await?,
        None => password::is_default(crate::env::default_password(env).as_deref(), &attempt),
    };
    if !accepted {
        return Err(wrong_password());
    }

    // As far as the roster is concerned, signing in is joining: the badge says
    // so, and the name leaves the group link's list so nobody can take it there.
    db_handle
        .prepare("UPDATE members SET claimed_at = COALESCE(claimed_at, ?2) WHERE id = ?1")
        .bind(&[JsValue::from_str(&row.id), JsValue::from_str(&http::now_iso())])?
        .run()
        .await?;

    let member = db::to_member(&row);
    let identity = Identity {
        member_id: member.id,
        name: member.name,
        is_organizer: member.is_organizer,
        language: member.language,
        hour12: member.hour12,
        approved: member.approved_at.is_some(),
        has_password: row.password_hash.is_some(),
    };
    let credential = identity::issue(&identity, row.token_version, env).await?;
    signed_in(&identity, &credential)
}

#[derive(Deserialize)]
struct PasswordRow {
    password_hash: Option<String>,
}

#[derive(Deserialize)]
struct VersionRow {
    token_version: i64,
}

/// Choose a password, or change the one you chose.
///
/// The first time needs nothing but being signed in: whoever holds the token
/// is already that member. After that the current one is asked for, so a phone
/// left unlocked on the bench cannot be used to lock its owner out.
///
/// Every other device is signed out, any unused link is cancelled, and this
/// device is handed a fresh token. If somebody else had used the shared
/// password to be you, this is what ends it — the link matters as much as the
/// tokens, because they could have minted one for "another device" while they
/// were in.
async fn change_password(req: &mut Request, env: &Env) -> ApiResult<Response> {
    let identity = middleware::require_member(req, env).await?;
    // The version this token carries, which `require_member` has just checked
    // is current. The update below is conditional on it still being so.
    let Some(resolved) = identity::authenticate(req, env).await? else {
        return Err(http::unauthorized_default());
    };
    let body = read_json(req).await?;
    let next = string_field(&body, "newPassword")?;
    let current = match body.get("currentPassword") {
        Some(Value::String(current)) => current.clone(),
        _ => String::new(),
    };

    if !password::length_ok(&next) {
        return Err(http::bad_request_with(
            format!(
                "Use between {} and {} characters.",
                password::MIN_LENGTH,
                password::MAX_LENGTH
            ),
            http::code::PASSWORD_LENGTH,
        ));
    }
    if password::is_default(crate::env::default_password(env).as_deref(), &next) {
        return Err(http::bad_request_with(
            "That is the group password. Pick one of your own.",
            http::code::PASSWORD_IS_DEFAULT,
        ));
    }

    let db_handle = crate::env::db(env)?;
    let stored: Option<PasswordRow> = db_handle
        .prepare("SELECT password_hash FROM members WHERE id = ?1")
        .bind(&[JsValue::from_str(&identity.member_id)])?
        .first(None)
        .await?;
    if let Some(stored) = stored.and_then(|row| row.password_hash) {
        // 403, not 401: the token is fine, and a 401 would sign them out.
        if current.is_empty() || !password::verify(&current, &stored).await? {
            return Err(http::forbidden("That is not your current password."));
        }
    }

    let hash = password::hash(&next).await?;
    // Guarded on the version, because the hashing above leaves a window. If the
    // organizer pressed "Sign out everywhere" in it, or another device set a
    // password in it, this token is no longer current and must not win: every
    // password set and every revocation bumps the version, so this one check
    // covers both.
    let updated: Option<VersionRow> = db_handle
        .prepare(
            "UPDATE members
          SET password_hash = ?2,
              token_version = token_version + 1,
              claim_nonce = NULL,
              claim_expires_at = NULL,
              claimed_at = COALESCE(claimed_at, ?3)
        WHERE id = ?1 AND active = 1 AND token_version = ?4
        RETURNING token_version",
        )
        .bind(&[
            JsValue::from_str(&identity.member_id),
            JsValue::from_str(&hash),
            JsValue::from_str(&http::now_iso()),
            JsValue::from_f64(resolved.token_version as f64),
        ])?
        .first(None)
        .await?;
    let Some(updated) = updated else {
        return Err(http::unauthorized("This device was signed out. Sign in again."));
    };

    let identity = Identity { has_password: true, ..identity };
    let credential = identity::issue(&identity, updated.token_version, env).await?;
    signed_in(&identity, &credential)
}

/// Who you are — and, once your token is a month old, a new one.
///
/// Renewing here rather than on every request is deliberate: this is what the
/// app calls each time it opens, so anybody who opens it at least once every
/// two months never sees a sign-in screen again, and nothing else has to carry
/// a token back.
async fn me(req: &Request, env: &Env) -> ApiResult<Response> {
    let identity = middleware::require_member(req, env).await?;

    // `require_member` has verified this token already; reading its expiry
    // back out is one more HMAC.
    let renewed = match identity::authenticate(req, env).await? {
        Some(resolved) if identity::due_for_renewal(resolved.expires_at, js::now_ms()) => {
            Some(identity::issue(&identity, resolved.token_version, env).await?)
        }
        _ => None,
    };

    let response = Response::from_json(&Me {
        identity: &identity,
        token: renewed.as_ref().map(|credential| credential.token.as_str()),
    })?;
    if let Some(set_cookie) = renewed.as_ref().and_then(|credential| credential.set_cookie.as_ref())
    {
        response.headers().set("Set-Cookie", set_cookie)?;
    }
    Ok(response)
}

/// `{ token, identity }`, and the cookie beside it.
fn signed_in(identity: &Identity, credential: &IssuedCredential) -> ApiResult<Response> {
    let response = Response::from_json(&Claimed { token: &credential.token, identity })?;
    if let Some(set_cookie) = &credential.set_cookie {
        response.headers().set("Set-Cookie", set_cookie)?;
    }
    Ok(response)
}

fn logout() -> ApiResult<Response> {
    let set_cookie = identity::revoke();
    let response = Response::from_json(&serde_json::json!({ "ok": true }))?;
    response.headers().set("Set-Cookie", &set_cookie)?;
    Ok(response)
}

/// Two top-level keys, `token` before `identity`.
#[derive(Serialize)]
struct Claimed<'a> {
    token: &'a str,
    identity: &'a Identity,
}

#[derive(Serialize)]
struct Me<'a> {
    identity: &'a Identity,
    /// Present only when the one this request carried is due for renewal.
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<&'a str>,
}

fn spent_link() -> http::ApiError {
    http::unauthorized("That link is not valid any more. Ask for a new one.")
}

fn wrong_password() -> http::ApiError {
    http::unauthorized("That name and password do not match.")
}

/// Any JSON body at all; the fields are read one at a time below.
async fn read_json(req: &mut Request) -> ApiResult<Value> {
    let Ok(text) = req.text().await else {
        return Err(http::bad_request("Expected a JSON body"));
    };
    serde_json::from_str::<Value>(&text).map_err(|_| http::bad_request("Expected a JSON body"))
}

/// A required string, worded the way the rest of the API words a bad field.
fn string_field(body: &Value, key: &str) -> ApiResult<String> {
    let Some(object) = body.as_object() else {
        return Err(http::bad_request(format!(
            "Invalid input: expected object, received {}",
            zod_type(body)
        )));
    };
    match object.get(key) {
        Some(Value::String(value)) => Ok(value.clone()),
        other => Err(http::bad_request(format!(
            "{key}: Invalid input: expected string, received {}",
            other.map_or("undefined", zod_type)
        ))),
    }
}

/* --------------------------------------------------------- body validation */

/// `parseBody(c.req.raw, claimSchema)`.
///
/// Two failures are visible from outside and they are different messages: a
/// body that is not JSON at all, and a body that is JSON of the wrong shape.
/// The second is zod's own text, and only the *first* issue is ever reported.
async fn parse_body(req: &mut Request) -> ApiResult<String> {
    // `await request.json()` is a read plus a parse, and either throw lands in
    // the same `catch`.
    let raw = match req.text().await {
        Ok(text) => serde_json::from_str::<Value>(&text),
        Err(_) => return Err(http::bad_request("Expected a JSON body")),
    };
    let Ok(raw) = raw else {
        return Err(http::bad_request("Expected a JSON body"));
    };
    validate(&raw)
}

/// `claimSchema` — `z.object({ nonce: z.string().min(20).max(100) })` — and the
/// `validate` around it, which prefixes the message with the dotted path of the
/// issue when there is one. The object's own issues have an empty path, so
/// `path.join('.')` is falsy for those and the message stands alone.
fn validate(raw: &Value) -> ApiResult<String> {
    let Some(object) = raw.as_object() else {
        return Err(http::bad_request(format!(
            "Invalid input: expected object, received {}",
            zod_type(raw)
        )));
    };
    let nonce = match object.get("nonce") {
        Some(Value::String(nonce)) => nonce,
        // An absent key is `undefined`, which zod names rather than skips.
        other => {
            return Err(http::bad_request(format!(
                "nonce: Invalid input: expected string, received {}",
                other.map_or("undefined", zod_type)
            )))
        }
    };

    // zod measures `String.prototype.length`, which counts UTF-16 code units:
    // ten emoji are twenty characters and clear the minimum.
    let length = nonce.encode_utf16().count();
    if length < 20 {
        return Err(http::bad_request("nonce: Too small: expected string to have >=20 characters"));
    }
    if length > 100 {
        return Err(http::bad_request("nonce: Too big: expected string to have <=100 characters"));
    }
    Ok(nonce.clone())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn message(json: &str) -> String {
        validate(&serde_json::from_str(json).unwrap()).unwrap_err().message
    }

    /// Every string here was taken from zod 4.4.3 running the real schema
    /// through the real `validate`.
    #[test]
    fn reports_the_first_issue_the_way_zod_words_it() {
        assert_eq!(message("{}"), "nonce: Invalid input: expected string, received undefined");
        assert_eq!(
            message(r#"{"nonce":null}"#),
            "nonce: Invalid input: expected string, received null"
        );
        assert_eq!(
            message(r#"{"nonce":123}"#),
            "nonce: Invalid input: expected string, received number"
        );
        assert_eq!(
            message(r#"{"nonce":true}"#),
            "nonce: Invalid input: expected string, received boolean"
        );
        assert_eq!(
            message(r#"{"nonce":{}}"#),
            "nonce: Invalid input: expected string, received object"
        );
        // Two issues here; the first is still the type one.
        assert_eq!(
            message(r#"{"nonce":[]}"#),
            "nonce: Invalid input: expected string, received array"
        );

        assert_eq!(
            message(r#"{"nonce":"short"}"#),
            "nonce: Too small: expected string to have >=20 characters"
        );
        assert_eq!(
            message(&format!(r#"{{"nonce":"{}"}}"#, "x".repeat(101))),
            "nonce: Too big: expected string to have <=100 characters"
        );

        // The object's own failure has an empty path, so no prefix.
        assert_eq!(message(r#""nope""#), "Invalid input: expected object, received string");
        assert_eq!(message("42"), "Invalid input: expected object, received number");
        assert_eq!(message("true"), "Invalid input: expected object, received boolean");
        assert_eq!(message("null"), "Invalid input: expected object, received null");
        assert_eq!(message("[]"), "Invalid input: expected object, received array");
    }

    #[test]
    fn accepts_what_the_schema_accepts() {
        let ok = |json: &str| validate(&serde_json::from_str(json).unwrap()).unwrap();
        assert_eq!(ok(&format!(r#"{{"nonce":"{}"}}"#, "y".repeat(20))), "y".repeat(20));
        assert_eq!(ok(&format!(r#"{{"nonce":"{}"}}"#, "y".repeat(100))), "y".repeat(100));
        // Unknown keys are stripped, not rejected.
        assert_eq!(ok(&format!(r#"{{"nonce":"{}","x":1}}"#, "y".repeat(20))), "y".repeat(20));
        // Ten emoji are twenty UTF-16 code units.
        assert_eq!(ok(r#"{"nonce":"😀😀😀😀😀😀😀😀😀😀"}"#), "😀😀😀😀😀😀😀😀😀😀");
    }

    #[test]
    fn reads_string_fields() {
        let body = serde_json::json!({ "name": "An", "password": 123456 });
        assert_eq!(string_field(&body, "name").unwrap(), "An");
        assert_eq!(
            string_field(&body, "password").unwrap_err().message,
            "password: Invalid input: expected string, received number"
        );
        assert_eq!(
            string_field(&body, "missing").unwrap_err().message,
            "missing: Invalid input: expected string, received undefined"
        );
        assert_eq!(
            string_field(&serde_json::json!([]), "name").unwrap_err().message,
            "Invalid input: expected object, received array"
        );
    }

    /// An unknown name and a wrong password are the same answer, and it is a
    /// 401 — the sign-in screen has no token for it to clear.
    #[test]
    fn says_nothing_about_which_half_was_wrong() {
        let error = wrong_password();
        assert_eq!(error.status, 401);
        assert_eq!(error.code, "unauthorized");
    }

    /// The one message all three "no" answers share.
    #[test]
    fn says_nothing_about_which_kind_of_no_it_is() {
        let error = spent_link();
        assert_eq!(error.status, 401);
        assert_eq!(error.code, "unauthorized");
        assert_eq!(error.message, "That link is not valid any more. Ask for a new one.");
    }
}
