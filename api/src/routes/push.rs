//! Reminder subscriptions.
//!
//! Ported from `src/routes/push.ts`.
//!
//! A member subscribes per device — the PWA installed on a phone and the same
//! app open on a laptop are two endpoints — so this stores a list, not a flag.
//! Whether they *want* each kind of reminder is a per-member preference on top.

use std::future::Future;
use std::task::Poll;

use serde::Deserialize;
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{console_error, Env, Request, Response};

use crate::db::{normalize_locale, to_member, MemberRow};
use crate::http::{self, ApiError, ApiResult};
use crate::middleware::Identity;
use crate::push::{create_push_sender, PushKeys, PushMessage, PushOutcome, PushTarget};

/// `pushRoutes`, mounted at `/push` inside `protectedRoutes`.
///
/// `None` is Hono's fall-through. The method is read off the raw request rather
/// than through `Request::method()`, which folds every verb the `worker` crate
/// does not know onto `GET` — `QUERY` among them, and the CORS preflight
/// advertises it.
pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    match (req.inner().method().as_str(), req.path().as_str()) {
        ("GET", "/push/status") => Some(status(env, identity).await),
        ("POST", "/push/subscribe") => Some(subscribe(req, env, identity).await),
        ("POST", "/push/unsubscribe") => Some(unsubscribe(req, env, identity).await),
        ("PATCH", "/push/preferences") => Some(preferences(req, env, identity).await),
        ("POST", "/push/test") => Some(test(env, identity).await),
        _ => None,
    }
}

/* --------------------------------------------------------------- row shapes */

#[derive(Deserialize)]
struct CountRow {
    n: Option<i64>,
}

#[derive(Deserialize)]
struct LanguageRow {
    language: Option<String>,
}

#[derive(Deserialize)]
struct SubscriptionRow {
    id: String,
    endpoint: String,
    p256dh: String,
    auth: String,
}

/* ------------------------------------------------------------ GET /status */

async fn status(env: &Env, identity: &Identity) -> ApiResult<Response> {
    let sender = create_push_sender(env);
    let db = crate::env::db(env)?;

    let row: Option<MemberRow> = db
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(&identity.member_id)])?
        .first(None)
        .await?;
    let count: Option<CountRow> = db
        .prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id = ?1")
        .bind(&[text(&identity.member_id)])?
        .first(None)
        .await?;

    let member = row.as_ref().map(to_member);

    // `PushStatus`, keys in the order the object literal declared them.
    let status = json!({
        "enabled": sender.enabled(),
        "publicKey": sender.public_key(),
        "devices": count.and_then(|row| row.n).unwrap_or(0),
        // A member row that has gone missing between the auth middleware and
        // here reads as opted in, which is the column default.
        "notifySession": member.as_ref().map(|m| m.notify_session).unwrap_or(true),
        "notifyPayment": member.as_ref().map(|m| m.notify_payment).unwrap_or(true),
        "language": member.as_ref().map(|m| m.language.clone()).unwrap_or_else(|| "en".to_string()),
        // Read off the raw row rather than the mapped member: the original took
        // this one straight from the column.
        "hour12": row.as_ref().map(|row| row.hour12).unwrap_or(0) == 1,
    });
    Ok(Response::from_json(&status)?)
}

/* ------------------------------------------------------- POST /subscribe */

/// Register a device. Upserts on the endpoint: browsers hand back the same
/// endpoint when a subscription is refreshed, and re-granting permission must
/// not pile up duplicate rows that each send the same notification.
async fn subscribe(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    // Parsed before the enabled check, so a malformed body is a 400 even on a
    // server with no VAPID keys.
    let input = parse_body(req, push_subscription_schema).await?;

    let sender = create_push_sender(env);
    if !sender.enabled() {
        return Err(http::conflict("Reminders are not configured on this server"));
    }

    let user_agent = req.headers().get("User-Agent").ok().flatten().unwrap_or_default();

    let timestamp = http::now_iso();
    crate::env::db(env)?
        .prepare(
            "INSERT INTO push_subscriptions
           (id, member_id, endpoint, p256dh, auth, user_agent, created_at, failure_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
         ON CONFLICT (endpoint) DO UPDATE SET
           member_id = excluded.member_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent,
           failure_count = 0",
        )
        .bind(&[
            text(&http::new_id("sub")),
            text(&identity.member_id),
            text(&input.endpoint),
            text(&input.p256dh),
            text(&input.auth),
            text(slice_utf16(&user_agent, 200)),
            text(&timestamp),
        ])?
        .run()
        .await?;

    Ok(Response::from_json(&json!({ "ok": true }))?)
}

/* ----------------------------------------------------- POST /unsubscribe */

async fn unsubscribe(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    // `.catch(() => ({}))` — an unreadable body means "drop every device".
    let body = read_json(req).await.unwrap_or_else(|| json!({}));
    if body.is_null() {
        // `typeof body.endpoint` on a JSON `null` is a TypeError in the
        // original, which reaches `onError` rather than any handler. Nothing
        // else this route can be sent produces that, and the 500 it turns into
        // is part of the API.
        console_error!("Unhandled error TypeError: Cannot read properties of null");
        return Err(http::internal());
    }
    let endpoint = body.get("endpoint").and_then(Value::as_str).filter(|value| !value.is_empty());

    let db = crate::env::db(env)?;
    match endpoint {
        // Scoped to the caller so one member cannot unsubscribe another's device.
        Some(endpoint) => {
            db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1 AND member_id = ?2")
                .bind(&[text(endpoint), text(&identity.member_id)])?
                .run()
                .await?;
        }
        None => {
            db.prepare("DELETE FROM push_subscriptions WHERE member_id = ?1")
                .bind(&[text(&identity.member_id)])?
                .run()
                .await?;
        }
    }

    Ok(Response::from_json(&json!({ "ok": true }))?)
}

/* ---------------------------------------------------- PATCH /preferences */

async fn preferences(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    let input = parse_body(req, notification_prefs_schema).await?;

    let db = crate::env::db(env)?;
    let row: Option<MemberRow> = db
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(&identity.member_id)])?
        .first(None)
        .await?;
    let Some(row) = row else {
        return Err(http::conflict("Member no longer exists"));
    };

    // An absent field writes the column back unchanged; only `language` is
    // normalised on every write, whether it was sent or not.
    let next_session = match input.notify_session {
        Some(value) => i64::from(value),
        None => row.notify_session,
    };
    let next_payment = match input.notify_payment {
        Some(value) => i64::from(value),
        None => row.notify_payment,
    };
    let next_language =
        input.language.unwrap_or_else(|| normalize_locale(&row.language).to_string());
    let next_hour12 = match input.hour12 {
        Some(value) => i64::from(value),
        None => row.hour12,
    };

    db.prepare(
        "UPDATE members
            SET notify_session = ?2, notify_payment = ?3, language = ?4, hour12 = ?5
          WHERE id = ?1",
    )
    .bind(&[
        text(&identity.member_id),
        number(next_session as f64),
        number(next_payment as f64),
        text(&next_language),
        number(next_hour12 as f64),
    ])?
    .run()
    .await?;

    Ok(Response::from_json(&json!({
        "notifySession": next_session == 1,
        "notifyPayment": next_payment == 1,
        "language": next_language,
        "hour12": next_hour12 == 1,
    }))?)
}

/* ------------------------------------------------------------ POST /test */

/// Fire a notification at the caller's own devices, to prove it works.
async fn test(env: &Env, identity: &Identity) -> ApiResult<Response> {
    let sender = create_push_sender(env);
    if !sender.enabled() {
        return Err(http::conflict("Reminders are not configured on this server"));
    }

    let db = crate::env::db(env)?;
    let results = db
        .prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE member_id = ?1")
        .bind(&[text(&identity.member_id)])?
        .all()
        .await?;
    let rows: Vec<SubscriptionRow> = results.results()?;

    if rows.is_empty() {
        return Err(http::conflict("No devices are subscribed yet"));
    }

    let member: Option<LanguageRow> = db
        .prepare("SELECT language FROM members WHERE id = ?1")
        .bind(&[text(&identity.member_id)])?
        .first(None)
        .await?;
    let language = member.and_then(|row| row.language).unwrap_or_default();
    let messages = messages_for(normalize_locale(&language));

    let sends: Vec<_> = rows
        .iter()
        .map(|row| {
            let sender = &sender;
            let target = PushTarget {
                subscription_id: row.id.clone(),
                endpoint: row.endpoint.clone(),
                keys: PushKeys { p256dh: row.p256dh.clone(), auth: row.auth.clone() },
            };
            let message = PushMessage {
                title: messages.test_title.to_string(),
                body: (messages.test_body)(&identity.name),
                url: Some("/".to_string()),
                tag: Some("test".to_string()),
                // No `ttl` on the message, so the sender's own 6h default holds.
                ttl: None,
            };
            async move { sender.send(&target, &message).await }
        })
        .collect();
    let outcomes = join_all(sends).await;

    // A test that finds a dead endpoint should clean it up, same as the cron.
    let gone: Vec<&str> = outcomes
        .iter()
        .filter(|outcome| matches!(outcome, PushOutcome::Gone { .. }))
        .map(PushOutcome::subscription_id)
        .collect();
    if !gone.is_empty() {
        let placeholders = (1..=gone.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
        let binds: Vec<JsValue> = gone.iter().map(|id| text(id)).collect();
        db.prepare(format!("DELETE FROM push_subscriptions WHERE id IN ({placeholders})"))
            .bind(&binds)?
            .run()
            .await?;
    }

    Ok(Response::from_json(&json!({
        "sent": outcomes.iter().filter(|o| matches!(o, PushOutcome::Sent { .. })).count(),
        "removed": gone.len(),
        "failed": outcomes.iter().filter(|o| matches!(o, PushOutcome::Failed { .. })).count(),
    }))?)
}

/* ---------------------------------------------------------------- i18n */

/// The two push strings this route needs, from `shared/src/i18n/{en,my}.ts`.
///
/// The catalogue is a per-member language because the notification is written
/// on the server and read on a phone the server never sees.
struct PushMessages {
    test_title: &'static str,
    test_body: fn(&str) -> String,
}

fn messages_for(locale: &str) -> PushMessages {
    if locale == "my" {
        PushMessages {
            test_title: "ဖူဆယ် သောကြာ",
            test_body: |name| format!("သတိပေးချက်များ အလုပ်လုပ်နေပါသည်၊ {name}။"),
        }
    } else {
        PushMessages {
            test_title: "Futsal Friday",
            test_body: |name| format!("Reminders are working, {name}."),
        }
    }
}

/* ------------------------------------------------------------- validation */

/// What `pushSubscriptionSchema` produces. `endpoint` is the **trimmed** value:
/// `z.url()` writes the trimmed string back onto the payload, so that is what
/// the row stores.
#[cfg_attr(test, derive(Debug))]
struct PushSubscriptionInput {
    endpoint: String,
    p256dh: String,
    auth: String,
}

fn push_subscription_schema(raw: &Value) -> Result<PushSubscriptionInput, Invalid> {
    let object = expect_object(raw, &[])?;

    // z.url().max(500) — the format check is prepended to the check list, so a
    // string that is both unparseable and too long reports the URL failure.
    let endpoint = expect_string(object.get("endpoint"), &["endpoint"])?;
    let endpoint = js_trim(&endpoint).to_string();
    if worker::Url::parse(&endpoint).is_err() {
        return Err(Invalid::new(&["endpoint"], "Invalid URL"));
    }
    check_max(&endpoint, 500, &["endpoint"])?;

    let keys = match object.get("keys") {
        Some(Value::Object(map)) => map,
        other => return Err(invalid_type(&["keys"], "object", parsed_type(other))),
    };

    let p256dh = expect_string(keys.get("p256dh"), &["keys", "p256dh"])?;
    check_min(&p256dh, 1, &["keys", "p256dh"])?;
    check_max(&p256dh, 200, &["keys", "p256dh"])?;

    let auth = expect_string(keys.get("auth"), &["keys", "auth"])?;
    check_min(&auth, 1, &["keys", "auth"])?;
    check_max(&auth, 100, &["keys", "auth"])?;

    Ok(PushSubscriptionInput { endpoint, p256dh, auth })
}

/// What `notificationPrefsSchema` produces — every field optional, so absent and
/// "leave it alone" are the same thing.
#[cfg_attr(test, derive(Debug))]
struct NotificationPrefsInput {
    notify_session: Option<bool>,
    notify_payment: Option<bool>,
    language: Option<String>,
    hour12: Option<bool>,
}

fn notification_prefs_schema(raw: &Value) -> Result<NotificationPrefsInput, Invalid> {
    let object = expect_object(raw, &[])?;

    Ok(NotificationPrefsInput {
        notify_session: optional_bool(object.get("notifySession"), &["notifySession"])?,
        notify_payment: optional_bool(object.get("notifyPayment"), &["notifyPayment"])?,
        language: optional_enum(object.get("language"), &["en", "my"], &["language"])?,
        hour12: optional_bool(object.get("hour12"), &["hour12"])?,
    })
}

/// The first zod issue, as its path and its message.
///
/// Only the first is ever reported, and only its dotted path and English text
/// reach the caller, so that is all this carries.
struct Invalid {
    path: Vec<String>,
    message: String,
}

impl Invalid {
    fn new(path: &[&str], message: impl Into<String>) -> Self {
        Self {
            path: path.iter().map(|part| (*part).to_string()).collect(),
            message: message.into(),
        }
    }

    /// `path ? \`${path}: ${message}\` : message` — a top-level failure has an
    /// empty path, which is falsy, and reports the bare message.
    fn into_error(self) -> ApiError {
        let path = self.path.join(".");
        if path.is_empty() {
            http::bad_request(self.message)
        } else {
            http::bad_request(format!("{path}: {}", self.message))
        }
    }
}

/// `parseBody(request, schema)`: read JSON, then validate.
async fn parse_body<T>(
    req: &mut Request,
    schema: fn(&Value) -> Result<T, Invalid>,
) -> ApiResult<T> {
    let Some(raw) = read_json(req).await else {
        return Err(http::bad_request("Expected a JSON body"));
    };
    schema(&raw).map_err(Invalid::into_error)
}

/// `await request.json()`, with every failure — an unreadable body, a body that
/// is not JSON — collapsed to `None`, which is what the two callers' `catch`
/// clauses did with it.
async fn read_json(req: &mut Request) -> Option<Value> {
    let text = req.text().await.ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

fn expect_object<'a>(
    value: &'a Value,
    path: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, Invalid> {
    match value {
        Value::Object(map) => Ok(map),
        other => Err(invalid_type(path, "object", parsed_type(Some(other)))),
    }
}

fn expect_string(value: Option<&Value>, path: &[&str]) -> Result<String, Invalid> {
    match value {
        Some(Value::String(text)) => Ok(text.clone()),
        other => Err(invalid_type(path, "string", parsed_type(other))),
    }
}

fn optional_bool(value: Option<&Value>, path: &[&str]) -> Result<Option<bool>, Invalid> {
    match value {
        // An absent key on an optional field is never an issue at all.
        None => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        other => Err(invalid_type(path, "boolean", parsed_type(other))),
    }
}

fn optional_enum(
    value: Option<&Value>,
    allowed: &[&str],
    path: &[&str],
) -> Result<Option<String>, Invalid> {
    match value {
        None => Ok(None),
        Some(Value::String(text)) if allowed.contains(&text.as_str()) => Ok(Some(text.clone())),
        // `z.enum` never reports a type mismatch: anything that is not one of
        // the values, of any type, is the same "invalid option".
        Some(_) => {
            let options =
                allowed.iter().map(|value| format!("\"{value}\"")).collect::<Vec<_>>().join("|");
            Err(Invalid::new(path, format!("Invalid option: expected one of {options}")))
        }
    }
}

fn check_min(value: &str, min: usize, path: &[&str]) -> Result<(), Invalid> {
    if utf16_len(value) < min {
        return Err(Invalid::new(
            path,
            format!("Too small: expected string to have >={min} characters"),
        ));
    }
    Ok(())
}

fn check_max(value: &str, max: usize, path: &[&str]) -> Result<(), Invalid> {
    if utf16_len(value) > max {
        return Err(Invalid::new(
            path,
            format!("Too big: expected string to have <={max} characters"),
        ));
    }
    Ok(())
}

fn invalid_type(path: &[&str], expected: &str, received: &str) -> Invalid {
    Invalid::new(path, format!("Invalid input: expected {expected}, received {received}"))
}

/// `util.parsedType(input)` — what zod calls the value it was handed. A missing
/// key is `undefined`, which is how a required field reports itself.
fn parsed_type(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        // JSON has no NaN, so the `nan` arm is unreachable from a request body.
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/* ------------------------------------------------------------- primitives */

/// `String.prototype.length` counts UTF-16 code units, which is what every zod
/// length check compares against.
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `String.prototype.slice(0, limit)`, cutting on UTF-16 code units. A cut that
/// would land inside a surrogate pair takes neither half, because there is no
/// way to write half of one back out.
fn slice_utf16(value: &str, limit: usize) -> &str {
    let mut units = 0usize;
    for (index, character) in value.char_indices() {
        let width = character.len_utf16();
        if units + width > limit {
            return &value[..index];
        }
        units += width;
    }
    value
}

/// `String.prototype.trim()` — the ECMAScript white space set plus the line
/// terminators, which is not quite Unicode's `White_Space` (no U+0085, but
/// U+FEFF counts).
fn js_trim(value: &str) -> &str {
    let is_space = |c: char| {
        matches!(c, '\u{9}' | '\u{b}' | '\u{c}' | '\u{20}' | '\u{a0}' | '\u{feff}')
            || matches!(c, '\u{a}' | '\u{d}' | '\u{2028}' | '\u{2029}')
            || (c != '\u{85}' && c.is_whitespace())
    };
    value.trim_matches(is_space)
}

/// A bound value. D1 takes JS values; text and number are all this file needs.
fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

fn number(value: f64) -> JsValue {
    JsValue::from_f64(value)
}

/// `Promise.all(list)` — every send starts before any of them is waited on.
///
/// A member with three devices should get three notifications in the time one
/// takes, which is what the original's `Promise.all` bought. Rust futures do
/// nothing until polled, so awaiting them in a loop would serialise the
/// round trips.
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

    fn subscription(json: &str) -> Result<PushSubscriptionInput, String> {
        push_subscription_schema(&serde_json::from_str(json).unwrap())
            .map_err(|invalid| invalid.into_error().message)
    }

    fn prefs(json: &str) -> Result<NotificationPrefsInput, String> {
        notification_prefs_schema(&serde_json::from_str(json).unwrap())
            .map_err(|invalid| invalid.into_error().message)
    }

    const KEYS: &str = r#""keys":{"p256dh":"k","auth":"a"}"#;

    /// Every string here was read off zod 4.4.3 running the real
    /// `pushSubscriptionSchema` through the real `validate`.
    #[test]
    fn words_a_bad_subscription_the_way_zod_does() {
        assert_eq!(
            subscription("{}").unwrap_err(),
            "endpoint: Invalid input: expected string, received undefined"
        );
        assert_eq!(
            subscription(r#"{"endpoint":5}"#).unwrap_err(),
            "endpoint: Invalid input: expected string, received number"
        );
        assert_eq!(
            subscription(r#"{"endpoint":null}"#).unwrap_err(),
            "endpoint: Invalid input: expected string, received null"
        );
        assert_eq!(
            subscription(r#"{"endpoint":"not a url"}"#).unwrap_err(),
            "endpoint: Invalid URL"
        );
        // Unparseable *and* too long: the format check is prepended to the
        // check list, so it is the one that reports.
        assert_eq!(
            subscription(&format!(r#"{{"endpoint":"nope{}"}}"#, "a".repeat(600))).unwrap_err(),
            "endpoint: Invalid URL"
        );
        assert_eq!(
            subscription(&format!(
                r#"{{"endpoint":"https://e.example/{}"}}"#,
                "a".repeat(501 - "https://e.example/".len())
            ))
            .unwrap_err(),
            "endpoint: Too big: expected string to have <=500 characters"
        );

        assert_eq!(
            subscription(r#"{"endpoint":"https://e.example/x"}"#).unwrap_err(),
            "keys: Invalid input: expected object, received undefined"
        );
        assert_eq!(
            subscription(r#"{"endpoint":"https://e.example/x","keys":3}"#).unwrap_err(),
            "keys: Invalid input: expected object, received number"
        );
        assert_eq!(
            subscription(r#"{"endpoint":"https://e.example/x","keys":[]}"#).unwrap_err(),
            "keys: Invalid input: expected object, received array"
        );
        assert_eq!(
            subscription(r#"{"endpoint":"https://e.example/x","keys":{}}"#).unwrap_err(),
            "keys.p256dh: Invalid input: expected string, received undefined"
        );
        assert_eq!(
            subscription(r#"{"endpoint":"https://e.example/x","keys":{"p256dh":""}}"#).unwrap_err(),
            "keys.p256dh: Too small: expected string to have >=1 characters"
        );
        assert_eq!(
            subscription(&format!(
                r#"{{"endpoint":"https://e.example/x","keys":{{"p256dh":"{}"}}}}"#,
                "a".repeat(201)
            ))
            .unwrap_err(),
            "keys.p256dh: Too big: expected string to have <=200 characters"
        );
        assert_eq!(
            subscription(r#"{"endpoint":"https://e.example/x","keys":{"p256dh":"k","auth":""}}"#)
                .unwrap_err(),
            "keys.auth: Too small: expected string to have >=1 characters"
        );
        assert_eq!(
            subscription(&format!(
                r#"{{"endpoint":"https://e.example/x","keys":{{"p256dh":"k","auth":"{}"}}}}"#,
                "a".repeat(101)
            ))
            .unwrap_err(),
            "keys.auth: Too big: expected string to have <=100 characters"
        );

        // The object's own failure has an empty path, so no prefix.
        assert_eq!(
            subscription(r#""nope""#).unwrap_err(),
            "Invalid input: expected object, received string"
        );
        assert_eq!(
            subscription("null").unwrap_err(),
            "Invalid input: expected object, received null"
        );
        assert_eq!(
            subscription("[]").unwrap_err(),
            "Invalid input: expected object, received array"
        );
        assert_eq!(
            subscription("42").unwrap_err(),
            "Invalid input: expected object, received number"
        );
    }

    /// `z.url()` writes the trimmed string back onto the payload, so the trimmed
    /// value is what the row stores and what the 500-character cap measures.
    #[test]
    fn stores_the_trimmed_endpoint() {
        // `\t` and `\n` here are JSON escapes, read by `from_str` before the
        // schema ever sees the value.
        let padded = format!(r#"{{"endpoint":"  https://e.example/x \t\n",{KEYS}}}"#);
        let parsed = subscription(&padded).unwrap();
        assert_eq!(parsed.endpoint, "https://e.example/x");

        let url500 = format!("https://e.example/{}", "a".repeat(500 - "https://e.example/".len()));
        let padded = format!(r#"{{"endpoint":"  {url500}  ",{KEYS}}}"#);
        assert_eq!(subscription(&padded).unwrap().endpoint, url500);
    }

    #[test]
    fn takes_any_absolute_url_the_url_constructor_takes() {
        let ok = |endpoint: &str| {
            subscription(&format!(r#"{{"endpoint":"{endpoint}",{KEYS}}}"#)).is_ok()
        };
        assert!(ok("https://fcm.googleapis.com/fcm/send/abc"));
        assert!(ok("mailto:a@b.c"));
        // A special scheme with no `//` still parses, and a host-less one does not.
        assert!(ok("http:example.com"));
        assert!(!ok("//x/y"));
        assert!(!ok("https://"));
    }

    /// Every string here was read off zod 4.4.3 running the real
    /// `notificationPrefsSchema`.
    #[test]
    fn words_bad_preferences_the_way_zod_does() {
        assert_eq!(
            prefs(r#"{"notifySession":"yes"}"#).unwrap_err(),
            "notifySession: Invalid input: expected boolean, received string"
        );
        assert_eq!(
            prefs(r#"{"notifySession":null}"#).unwrap_err(),
            "notifySession: Invalid input: expected boolean, received null"
        );
        assert_eq!(
            prefs(r#"{"notifyPayment":1}"#).unwrap_err(),
            "notifyPayment: Invalid input: expected boolean, received number"
        );
        assert_eq!(
            prefs(r#"{"hour12":"x"}"#).unwrap_err(),
            "hour12: Invalid input: expected boolean, received string"
        );
        // An enum reports the same thing whatever the wrong value's type is.
        for raw in [r#"{"language":"fr"}"#, r#"{"language":5}"#, r#"{"language":null}"#] {
            assert_eq!(
                prefs(raw).unwrap_err(),
                "language: Invalid option: expected one of \"en\"|\"my\""
            );
        }
        // Declaration order decides which of two failures is reported.
        assert_eq!(
            prefs(r#"{"notifySession":"y","language":"fr"}"#).unwrap_err(),
            "notifySession: Invalid input: expected boolean, received string"
        );
        assert_eq!(
            prefs(r#""nope""#).unwrap_err(),
            "Invalid input: expected object, received string"
        );
    }

    #[test]
    fn an_empty_preferences_body_changes_nothing() {
        let parsed = prefs("{}").unwrap();
        assert!(parsed.notify_session.is_none());
        assert!(parsed.notify_payment.is_none());
        assert!(parsed.language.is_none());
        assert!(parsed.hour12.is_none());

        let parsed = prefs(r#"{"language":"my","hour12":true}"#).unwrap();
        assert_eq!(parsed.language.as_deref(), Some("my"));
        assert_eq!(parsed.hour12, Some(true));
    }

    #[test]
    fn trims_the_ecmascript_white_space_set() {
        assert_eq!(js_trim(" \t\n\r\u{b}\u{c}\u{a0}\u{feff}x\u{2028}\u{2029} "), "x");
        // U+0085 is Unicode white space but not ECMAScript white space.
        assert_eq!(js_trim("\u{85}x\u{85}"), "\u{85}x\u{85}");
    }

    #[test]
    fn slices_the_user_agent_by_utf16_code_units() {
        assert_eq!(slice_utf16("abc", 200), "abc");
        assert_eq!(slice_utf16(&"a".repeat(300), 200), "a".repeat(200));
        // One astral character is two code units, so 200 of them fill the cap.
        assert_eq!(slice_utf16(&"😀".repeat(300), 200).chars().count(), 100);
        // A cut that would split a surrogate pair takes neither half.
        assert_eq!(slice_utf16("a😀", 2), "a");
    }
}
