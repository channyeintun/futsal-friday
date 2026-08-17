//! A short list of pitches the group rotates between. Everyone can read it.
//!
//! Ported from `src/routes/venues.ts`, which Hono mounted at `/venues` inside
//! `protectedRoutes`, so every request here has already passed `requireMember`
//! and `requireApproved`. Writing declares `requireOrganizer()` per route;
//! reading does not.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use wasm_bindgen::{JsCast, JsValue};
use worker::{Env, Method, Request, Response};

use crate::db::{self, Venue, VenueRow};
use crate::http::{self, ApiError, ApiResult};
use crate::middleware::{require_organizer, Identity};

/// `None` when nothing here matches, so the dispatcher can go on to the next
/// router. A path this file owns but with the wrong method is also `None`,
/// because Hono matched on method too and an unmatched request fell through to
/// the not-found handler rather than to a 405.
pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    let path = req.path();
    let mut segments = path.split('/').skip(1);
    if segments.next() != Some("venues") {
        return None;
    }
    let id = segments.next();
    if segments.next().is_some() {
        return None;
    }

    // `/venues/:id` binds `[^/]+`, so `/venues/` is an empty segment that
    // matches neither route — and routing is strict, so it is not `/venues`
    // either. A deeper path matches nothing at all.
    match (req.method(), id) {
        (Method::Get, None) => Some(list(req, env, identity).await),
        (Method::Post, None) => Some(create(req, env, identity).await),
        (Method::Patch, Some(id)) if !id.is_empty() => {
            let id = decode_param(id);
            Some(update(req, env, identity, &id).await)
        }
        (Method::Delete, Some(id)) if !id.is_empty() => {
            let id = decode_param(id);
            Some(retire(env, identity, &id).await)
        }
        _ => None,
    }
}

async fn list(req: &Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    // `?all=1` includes retired venues so the organizer can bring one back. A
    // non-organizer asking for them is not an error, just the shorter list.
    let include_inactive = query(req, "all").as_deref() == Some("1") && identity.is_organizer;

    let db_handle = crate::env::db(env)?;
    let results = db_handle
        .prepare(if include_inactive {
            "SELECT * FROM venues ORDER BY active DESC, name COLLATE NOCASE ASC"
        } else {
            "SELECT * FROM venues WHERE active = 1 ORDER BY name COLLATE NOCASE ASC"
        })
        .all()
        .await?;
    let rows: Vec<VenueRow> = results.results()?;

    Ok(Response::from_json(&Venues { venues: rows.iter().map(db::to_venue).collect() })?)
}

async fn create(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    require_organizer(identity)?;
    let input = parse_create(&read_body(req).await?)?;

    // Built in memory and echoed back rather than re-read: every column it
    // writes is here, so a second round trip would only restate them.
    let row = VenueRow {
        id: http::new_id("ven"),
        name: input.name,
        address: input.address.flatten(),
        map_url: empty_to_null(input.map_url.flatten()),
        price_note: input.price_note.flatten(),
        active: 1,
        created_at: http::now_iso(),
    };

    let db_handle = crate::env::db(env)?;
    db_handle
        .prepare(
            "INSERT INTO venues (id, name, address, map_url, price_note, active, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
        )
        .bind(&[
            text(&row.id),
            text(&row.name),
            maybe_text(&row.address),
            maybe_text(&row.map_url),
            maybe_text(&row.price_note),
            text(&row.created_at),
        ])?
        .run()
        .await?;

    Ok(Response::from_json(&VenueBody { venue: db::to_venue(&row) })?.with_status(201))
}

async fn update(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    id: &str,
) -> ApiResult<Response> {
    require_organizer(identity)?;
    // Before the row is read, so a malformed body on a venue that does not exist
    // is still the 400 it was.
    let input = parse_update(&read_body(req).await?)?;

    let db_handle = crate::env::db(env)?;
    let existing: Option<VenueRow> = db_handle
        .prepare("SELECT * FROM venues WHERE id = ?1")
        .bind(&[text(id)])?
        .first(None)
        .await?;
    let Some(existing) = existing else {
        return Err(http::not_found("No such venue"));
    };

    // Field by field, because "absent" and "null" are different instructions:
    // leaving a key out keeps what is stored, sending `null` clears it.
    let next = VenueRow {
        id: existing.id,
        name: input.name.unwrap_or(existing.name),
        address: match input.address {
            None => existing.address,
            Some(address) => address,
        },
        map_url: match input.map_url {
            None => existing.map_url,
            Some(map_url) => empty_to_null(map_url),
        },
        price_note: match input.price_note {
            None => existing.price_note,
            Some(price_note) => price_note,
        },
        active: match input.active {
            None => existing.active,
            Some(active) => i64::from(active),
        },
        created_at: existing.created_at,
    };

    db_handle
        .prepare(
            "UPDATE venues SET name = ?2, address = ?3, map_url = ?4, price_note = ?5, active = ?6
       WHERE id = ?1",
        )
        .bind(&[
            text(&next.id),
            text(&next.name),
            maybe_text(&next.address),
            maybe_text(&next.map_url),
            maybe_text(&next.price_note),
            number(next.active as f64),
        ])?
        .run()
        .await?;

    Ok(Response::from_json(&VenueBody { venue: db::to_venue(&next) })?)
}

/// Retire rather than delete: past sessions point at this venue, and the cron
/// copies the previous session's venue forward as the default.
async fn retire(env: &Env, identity: &Identity, id: &str) -> ApiResult<Response> {
    require_organizer(identity)?;

    let db_handle = crate::env::db(env)?;
    let upcoming: Option<CountRow> = db_handle
        .prepare(
            "SELECT COUNT(*) AS n FROM sessions
        WHERE venue_id = ?1 AND status = 'scheduled' AND starts_at > ?2",
        )
        .bind(&[text(id), text(&http::now_iso())])?
        .first(None)
        .await?;

    if upcoming.map_or(0, |row| row.n) > 0 {
        return Err(http::conflict("An upcoming session still uses this venue — move it first"));
    }

    let result = db_handle
        .prepare("UPDATE venues SET active = 0 WHERE id = ?1")
        .bind(&[text(id)])?
        .run()
        .await?;
    // An already-retired venue still matches the `WHERE`, so it reports success;
    // only a venue that is not there at all counts zero rows. A result carrying
    // no meta would have read as `undefined === 0`, i.e. false.
    if result.meta()?.and_then(|meta| meta.changes) == Some(0) {
        return Err(http::not_found("No such venue"));
    }

    Ok(Response::from_json(&serde_json::json!({ "ok": true }))?)
}

/* ----------------------------------------------------------------- output */

#[derive(Serialize)]
struct Venues {
    venues: Vec<Venue>,
}

#[derive(Serialize)]
struct VenueBody {
    venue: Venue,
}

#[derive(Deserialize)]
struct CountRow {
    n: i64,
}

/// An empty string from a cleared form field means "no link", not `""`.
fn empty_to_null(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

/* --------------------------------------------------------- body validation */

/// `createVenueSchema`, parsed. `Option<Option<String>>` is the three states a
/// `.nullish()` field has and the merge in `PATCH` distinguishes: absent, an
/// explicit `null`, and a value.
#[derive(Debug)]
struct CreateVenue {
    name: String,
    address: Option<Option<String>>,
    map_url: Option<Option<String>>,
    price_note: Option<Option<String>>,
}

/// `updateVenueSchema` = `createVenueSchema.partial().extend({ active })`.
#[derive(Debug)]
struct UpdateVenue {
    name: Option<String>,
    address: Option<Option<String>>,
    map_url: Option<Option<String>>,
    price_note: Option<Option<String>>,
    active: Option<bool>,
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

fn parse_create(raw: &Value) -> ApiResult<CreateVenue> {
    let object = as_object(raw)?;
    // Keys are checked in the order the schema declares them, because that is
    // the order zod collects issues in and only `issues[0]` is ever reported.
    Ok(CreateVenue {
        name: required_trimmed(object, "name", "Venue name is required", 80)?,
        address: nullish_trimmed(object, "address", 200)?,
        map_url: nullish_url(object, "mapUrl", 500)?,
        price_note: nullish_trimmed(object, "priceNote", 120)?,
    })
}

fn parse_update(raw: &Value) -> ApiResult<UpdateVenue> {
    let object = as_object(raw)?;
    Ok(UpdateVenue {
        // `.partial()` wraps each field in `optional`, which answers before the
        // string checks run — so an absent name skips the "required" message.
        name: match object.get("name") {
            None => None,
            Some(_) => Some(required_trimmed(object, "name", "Venue name is required", 80)?),
        },
        address: nullish_trimmed(object, "address", 200)?,
        map_url: nullish_url(object, "mapUrl", 500)?,
        price_note: nullish_trimmed(object, "priceNote", 120)?,
        active: optional_bool(object, "active")?,
    })
}

/// The object `safeParse` starts from. Its own failure has an empty path, and
/// `path.join('.')` of `[]` is falsy, so that message travels without a prefix.
fn as_object(raw: &Value) -> ApiResult<&Map<String, Value>> {
    raw.as_object().ok_or_else(|| {
        http::bad_request(format!("Invalid input: expected object, received {}", zod_type(raw)))
    })
}

/// `z.string().trim().min(1, empty).max(max)`.
///
/// `.trim()` is a check like any other and runs first, so the length rules see
/// the trimmed value and a field of nothing but spaces is "required", not
/// "too short".
fn required_trimmed(
    object: &Map<String, Value>,
    key: &str,
    empty: &str,
    max: usize,
) -> ApiResult<String> {
    let value = expect_string(object.get(key), key)?;
    let value = js_trim(value);
    if utf16_len(value) < 1 {
        return Err(issue(key, empty));
    }
    if utf16_len(value) > max {
        return Err(issue(key, too_big(max)));
    }
    Ok(value.to_string())
}

/// `z.string().trim().max(max).nullish()`.
fn nullish_trimmed(
    object: &Map<String, Value>,
    key: &str,
    max: usize,
) -> ApiResult<Option<Option<String>>> {
    match object.get(key) {
        // `optional` and `nullable` both answer before the string is looked at.
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(value)) => {
            let value = js_trim(value);
            if utf16_len(value) > max {
                return Err(issue(key, too_big(max)));
            }
            Ok(Some(Some(value.to_string())))
        }
        Some(other) => Err(issue(key, expected_string(other))),
    }
}

/// `z.url(message).max(max).nullish().or(z.literal(''))`.
///
/// A union, and which half reports depends on how the two failed. zod keeps the
/// issues of the single option that failed *without* aborting, so a string that
/// is simply not a URL reports the URL message; a value that is not a string at
/// all aborts both halves and reports the union's own `Invalid input`.
fn nullish_url(
    object: &Map<String, Value>,
    key: &str,
    max: usize,
) -> ApiResult<Option<Option<String>>> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(value)) => {
            // The right-hand option. It is tried second but it succeeds, and a
            // union returns the first option that does.
            if value.is_empty() {
                return Ok(Some(Some(String::new())));
            }
            let trimmed = js_trim(value);
            if !parses_as_url(trimmed) {
                return Err(issue(key, "Must be a valid URL"));
            }
            // The URL check hands the trimmed value on, so the length rule and
            // the stored value are both of the trimmed string.
            if utf16_len(trimmed) > max {
                return Err(issue(key, too_big(max)));
            }
            Ok(Some(Some(trimmed.to_string())))
        }
        Some(_) => Err(issue(key, "Invalid input")),
    }
}

/// `z.boolean().optional()`.
fn optional_bool(object: &Map<String, Value>, key: &str) -> ApiResult<Option<bool>> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(other) => Err(issue(
            key,
            format!("Invalid input: expected boolean, received {}", zod_type(other)),
        )),
    }
}

fn expect_string<'a>(value: Option<&'a Value>, key: &str) -> ApiResult<&'a str> {
    match value {
        Some(Value::String(value)) => Ok(value),
        Some(other) => Err(issue(key, expected_string(other))),
        // An absent key is `undefined`, which zod names rather than skips.
        None => Err(issue(key, "Invalid input: expected string, received undefined")),
    }
}

fn expected_string(value: &Value) -> String {
    format!("Invalid input: expected string, received {}", zod_type(value))
}

fn too_big(max: usize) -> String {
    format!("Too big: expected string to have <={max} characters")
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

/// zod measures `String.prototype.length`, which counts UTF-16 code units: an
/// emoji is two characters to the length rules and one to everybody else.
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// JavaScript's `trim`: `WhiteSpace` plus `LineTerminator`, which is Unicode's
/// `White_Space` with U+FEFF added and U+0085 left out.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

/// `new URL(value)` — the host's own parser, which is the one `z.url()` called.
/// Writing a second WHATWG implementation here would be a second answer to a
/// question the runtime already answers, and the two would disagree eventually.
fn parses_as_url(value: &str) -> bool {
    let Ok(constructor) = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("URL")) else {
        return false;
    };
    let Ok(constructor) = constructor.dyn_into::<js_sys::Function>() else {
        return false;
    };
    js_sys::Reflect::construct(&constructor, &js_sys::Array::of1(&JsValue::from_str(value))).is_ok()
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

/// `c.req.query(name)` — the first occurrence wins, `+` is a space, and a key
/// with no `=` reads as the empty string.
fn query(req: &Request, name: &str) -> Option<String> {
    let url = req.url().ok()?;
    url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned())
}

fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

fn maybe_text(value: &Option<String>) -> JsValue {
    match value {
        Some(value) => JsValue::from_str(value),
        None => JsValue::NULL,
    }
}

fn number(value: f64) -> JsValue {
    JsValue::from_f64(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_error(json: &str) -> String {
        parse_create(&serde_json::from_str(json).unwrap()).unwrap_err().message
    }

    fn update_error(json: &str) -> String {
        parse_update(&serde_json::from_str(json).unwrap()).unwrap_err().message
    }

    /// Every string here was taken from zod 4.4.3 running the real schema
    /// through the real `validate`.
    #[test]
    fn words_the_create_issues_the_way_zod_does() {
        assert_eq!(create_error("{}"), "name: Invalid input: expected string, received undefined");
        assert_eq!(
            create_error(r#"{"name":null}"#),
            "name: Invalid input: expected string, received null"
        );
        assert_eq!(
            create_error(r#"{"name":5}"#),
            "name: Invalid input: expected string, received number"
        );
        assert_eq!(create_error(r#"{"name":"   "}"#), "name: Venue name is required");
        assert_eq!(
            create_error(&format!(r#"{{"name":"{}"}}"#, "x".repeat(81))),
            "name: Too big: expected string to have <=80 characters"
        );
        assert_eq!(
            create_error(r#"{"name":"a","address":5}"#),
            "address: Invalid input: expected string, received number"
        );
        assert_eq!(
            create_error(&format!(r#"{{"name":"a","address":"{}"}}"#, "x".repeat(201))),
            "address: Too big: expected string to have <=200 characters"
        );
        assert_eq!(
            create_error(&format!(r#"{{"name":"a","priceNote":"{}"}}"#, "x".repeat(121))),
            "priceNote: Too big: expected string to have <=120 characters"
        );
        // The union aborts on both halves when the value is not a string at all.
        assert_eq!(create_error(r#"{"name":"a","mapUrl":5}"#), "mapUrl: Invalid input");
        assert_eq!(create_error(r#"{"name":"a","mapUrl":[]}"#), "mapUrl: Invalid input");
        assert_eq!(create_error(r#"{"name":"a","mapUrl":true}"#), "mapUrl: Invalid input");

        // The object's own failure has an empty path, so no prefix.
        assert_eq!(create_error(r#""nope""#), "Invalid input: expected object, received string");
        assert_eq!(create_error("[]"), "Invalid input: expected object, received array");
        assert_eq!(create_error("null"), "Invalid input: expected object, received null");
    }

    /// The first failing key in declaration order is the one reported.
    #[test]
    fn reports_only_the_first_issue() {
        assert_eq!(
            create_error(r#"{"name":"","address":5,"priceNote":7}"#),
            "name: Venue name is required"
        );
        assert_eq!(
            create_error(r#"{"name":"a","address":5,"priceNote":7}"#),
            "address: Invalid input: expected string, received number"
        );
    }

    #[test]
    fn trims_before_it_measures() {
        let input = parse_create(
            &serde_json::from_str(
                r#"{"name":"  Pitch  ","address":"  addr  ","priceNote":"  p  "}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(input.name, "Pitch");
        assert_eq!(input.address, Some(Some("addr".to_string())));
        assert_eq!(input.price_note, Some(Some("p".to_string())));

        // Forty emoji are eighty UTF-16 code units, which is the whole budget.
        let forty = "😀".repeat(40);
        assert!(parse_create(&serde_json::json!({ "name": forty })).is_ok());
        assert_eq!(
            parse_create(&serde_json::json!({ "name": "😀".repeat(41) })).unwrap_err().message,
            "name: Too big: expected string to have <=80 characters"
        );

        // U+FEFF is trimmed, U+0085 is not — JavaScript's rule, not Unicode's.
        assert_eq!(js_trim("\u{feff}a\u{feff}"), "a");
        assert_eq!(js_trim("\u{85}"), "\u{85}");
    }

    #[test]
    fn tells_absent_from_null() {
        let absent = parse_update(&serde_json::json!({})).unwrap();
        assert_eq!(absent.address, None);
        assert_eq!(absent.map_url, None);
        assert_eq!(absent.active, None);

        let cleared =
            parse_update(&serde_json::json!({ "address": null, "mapUrl": null })).unwrap();
        assert_eq!(cleared.address, Some(None));
        assert_eq!(cleared.map_url, Some(None));

        // `''` is the union's other option and survives parsing, then
        // `emptyToNull` is what turns it into "no link".
        let blank = parse_update(&serde_json::json!({ "mapUrl": "" })).unwrap();
        assert_eq!(blank.map_url, Some(Some(String::new())));
        assert_eq!(empty_to_null(blank.map_url.flatten()), None);
    }

    #[test]
    fn checks_active_and_the_partial_name() {
        assert_eq!(
            update_error(r#"{"active":"yes"}"#),
            "active: Invalid input: expected boolean, received string"
        );
        assert_eq!(
            parse_update(&serde_json::json!({ "active": false })).unwrap().active,
            Some(false)
        );
        // Absent skips the string checks; present and blank does not.
        assert_eq!(parse_update(&serde_json::json!({})).unwrap().name, None);
        assert_eq!(update_error(r#"{"name":" "}"#), "name: Venue name is required");
    }

    /// Hono only decoded a parameter that still held a `%`, and fell back to
    /// decoding the well-formed runs when the whole thing would not decode.
    #[test]
    fn decodes_path_parameters_like_hono() {
        assert_eq!(decode_param("ven_abc"), "ven_abc");
        assert_eq!(decode_param("a%2Fb"), "a/b");
        assert_eq!(decode_param("caf%C3%A9"), "café");
        assert_eq!(decode_param("a%25b"), "a%b");
        // Not decodable at all: left exactly as written.
        assert_eq!(decode_param("a%zzb"), "a%zzb");
        // A good run beside a bad one: the good one still decodes.
        assert_eq!(decode_param("%41%zz%42"), "A%zzB");
        // Well formed but not UTF-8, so the whole decode throws and the runs are
        // retried one at a time — and that one fails too.
        assert_eq!(decode_param("%FF"), "%FF");
    }
}
