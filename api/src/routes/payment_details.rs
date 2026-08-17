//! Where the group sends money.
//!
//! Ported from `src/routes/payment-details.ts`.
//!
//! Readable by every member and writable only by organizers. That asymmetry is
//! the whole feature: the details stop living in a chat message somebody has to
//! scroll back for, without letting anyone quietly redirect the group's
//! transfers to themselves.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{Env, Method, Request, Response};

use crate::http::{self, ApiResult};
use crate::middleware::{require_organizer, Identity};

/// The singleton row, `id = 1`. `updated_by` is read by nobody and never
/// leaves — it is there so an organizer can be asked who changed the account.
#[derive(Deserialize)]
struct PaymentDetailsRow {
    bank_bin: String,
    bank_name: String,
    account_number: String,
    account_name: String,
    note: Option<String>,
    updated_at: String,
}

/// Field order is output order; this is the shape the web app reads.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PaymentDetails {
    bank_bin: String,
    bank_name: String,
    account_number: String,
    account_name: String,
    note: Option<String>,
    updated_at: String,
}

#[derive(Serialize)]
struct DetailsEnvelope {
    details: Option<PaymentDetails>,
}

fn to_details(row: PaymentDetailsRow) -> PaymentDetails {
    PaymentDetails {
        bank_bin: row.bank_bin,
        bank_name: row.bank_name,
        account_number: row.account_number,
        account_name: row.account_name,
        note: row.note,
        updated_at: row.updated_at,
    }
}

/// The one entry point the dispatcher calls; `None` when the path or the method
/// is somebody else's.
pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    if req.path() != "/payment-details" {
        return None;
    }
    match req.method() {
        Method::Get => Some(read(env).await),
        Method::Put => Some(save(req, env, identity).await),
        Method::Delete => Some(clear(env, identity).await),
        _ => None,
    }
}

async fn read(env: &Env) -> ApiResult<Response> {
    let row: Option<PaymentDetailsRow> = crate::env::db(env)?
        .prepare("SELECT * FROM payment_details WHERE id = 1")
        .first(None)
        .await?;
    Ok(Response::from_json(&DetailsEnvelope { details: row.map(to_details) })?)
}

async fn save(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    require_organizer(identity)?;
    let input = parse_save(&read_json(req).await?)?;
    let timestamp = http::now_iso();

    crate::env::db(env)?
        .prepare(
            "INSERT INTO payment_details
         (id, bank_bin, bank_name, account_number, account_name, note, updated_at, updated_by)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (id) DO UPDATE SET
         bank_bin = excluded.bank_bin,
         bank_name = excluded.bank_name,
         account_number = excluded.account_number,
         account_name = excluded.account_name,
         note = excluded.note,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by",
        )
        .bind(&[
            text(&input.bank_bin),
            text(&input.bank_name),
            text(&input.account_number),
            text(&input.account_name),
            match &input.note {
                Some(note) => text(note),
                None => JsValue::NULL,
            },
            text(&timestamp),
            text(&identity.member_id),
        ])?
        .run()
        .await?;

    // The parsed input echoed back — trimmed, and never re-read from the row.
    Ok(Response::from_json(&DetailsEnvelope {
        details: Some(PaymentDetails {
            bank_bin: input.bank_bin,
            bank_name: input.bank_name,
            account_number: input.account_number,
            account_name: input.account_name,
            note: input.note,
            updated_at: timestamp,
        }),
    })?)
}

/// Taking the details down is how an organizer stops collecting this way.
///
/// Always 200, even when nothing was stored: this is "make sure there are no
/// details", and there being none already is that.
async fn clear(env: &Env, identity: &Identity) -> ApiResult<Response> {
    require_organizer(identity)?;
    crate::env::db(env)?.prepare("DELETE FROM payment_details WHERE id = 1").run().await?;
    Ok(Response::from_json(&json!({ "ok": true }))?)
}

fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

/* ------------------------------------------------------------- request body */

/// `parseBody` — `await request.json()`, and any throw at all is the one
/// message.
async fn read_json(req: &mut Request) -> ApiResult<Value> {
    let raw = req.text().await.map_err(|_| http::bad_request("Expected a JSON body"))?;
    serde_json::from_str(&raw).map_err(|_| http::bad_request("Expected a JSON body"))
}

struct SaveInput {
    bank_bin: String,
    bank_name: String,
    account_number: String,
    account_name: String,
    note: Option<String>,
}

/// `savePaymentDetailsSchema`, key by key in shape order — which is the order
/// zod collected its issues in, and only the first one is reported.
///
/// The three custom messages are quoted verbatim: they are shown to a person
/// filling the form in, not to a developer.
fn parse_save(raw: &Value) -> ApiResult<SaveInput> {
    let body = object(raw)?;

    // `z.string().regex(/^\d{6}$/, 'Pick a bank')` — no trim here, so a stray
    // space is a rejection rather than something quietly cleaned up.
    let bank_bin = string("bankBin", body.get("bankBin"))?;
    if bank_bin.len() != 6 || !bank_bin.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(issue("bankBin", "Pick a bank"));
    }

    let bank_name = string("bankName", body.get("bankName"))?;
    let bank_name_length = bank_name.encode_utf16().count();
    if bank_name_length < 1 {
        return Err(issue("bankName", "Too small: expected string to have >=1 characters"));
    }
    if bank_name_length > 60 {
        return Err(issue("bankName", "Too big: expected string to have <=60 characters"));
    }

    // Trimmed first, then matched: `.trim()` is a check like any other and it
    // was declared before the pattern.
    let account_number = js_trim(string("accountNumber", body.get("accountNumber"))?);
    // The pattern is ASCII-only, so a byte count is the character count for
    // everything that could ever match it.
    if !(4..=19).contains(&account_number.len())
        || !account_number.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(issue("accountNumber", "Account number should be 4-19 letters or digits"));
    }

    let account_name = js_trim(string("accountName", body.get("accountName"))?);
    let account_name_length = account_name.encode_utf16().count();
    if account_name_length < 1 {
        return Err(issue("accountName", "Who the account belongs to"));
    }
    if account_name_length > 60 {
        return Err(issue("accountName", "Too big: expected string to have <=60 characters"));
    }

    let note = match body.get("note") {
        None | Some(Value::Null) => None,
        value => {
            let note = js_trim(string("note", value)?);
            if note.encode_utf16().count() > 160 {
                return Err(issue("note", "Too big: expected string to have <=160 characters"));
            }
            Some(note.to_string())
        }
    };

    Ok(SaveInput {
        bank_bin: bank_bin.to_string(),
        bank_name: bank_name.to_string(),
        account_number: account_number.to_string(),
        account_name: account_name.to_string(),
        note,
    })
}

/* ------------------------------------------------------------ zod, in Rust */

/// `badRequest(path ? `${path}: ${message}` : message)`.
fn issue(path: &str, message: &str) -> crate::http::ApiError {
    http::bad_request(format!("{path}: {message}"))
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

fn string<'a>(path: &str, value: Option<&'a Value>) -> ApiResult<&'a str> {
    value.and_then(Value::as_str).ok_or_else(|| {
        http::bad_request(format!(
            "{path}: Invalid input: expected string, received {}",
            parsed_type(value)
        ))
    })
}

/// `String.prototype.trim()`, whose set of spaces is not Rust's: JavaScript
/// strips the byte-order mark and does not strip U+0085.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{0085}'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save(json: &str) -> ApiResult<SaveInput> {
        parse_save(&serde_json::from_str(json).unwrap())
    }

    fn message(json: &str) -> String {
        save(json).err().expect("expected a rejection").message
    }

    const GOOD: &str = r#"{"bankBin":"970422","bankName":"MB Bank",
        "accountNumber":"  0123456789  ","accountName":"  Le Van A  ","note":"  ca 1  "}"#;

    /// The three custom messages are shown to a person filling the form in, so
    /// they are quoted from the schema character for character.
    #[test]
    fn the_custom_messages_are_verbatim() {
        assert_eq!(message(r#"{"bankBin":"97042"}"#), "bankBin: Pick a bank");
        assert_eq!(
            message(r#"{"bankBin":" 970422 "}"#),
            "bankBin: Pick a bank",
            "no trim on the bin, so a padded one is a rejection"
        );
        assert_eq!(
            message(r#"{"bankBin":"970422","bankName":"MB","accountNumber":"abc"}"#),
            "accountNumber: Account number should be 4-19 letters or digits"
        );
        assert_eq!(
            message(
                r#"{"bankBin":"970422","bankName":"MB","accountNumber":"1234","accountName":"   "}"#
            ),
            "accountName: Who the account belongs to"
        );
    }

    #[test]
    fn the_rest_are_zod_defaults_in_shape_order() {
        assert_eq!(message("5"), "Invalid input: expected object, received number");
        assert_eq!(message("{}"), "bankBin: Invalid input: expected string, received undefined");
        assert_eq!(
            message(r#"{"bankBin":"970422","bankName":""}"#),
            "bankName: Too small: expected string to have >=1 characters"
        );
        let long = "x".repeat(61);
        assert_eq!(
            message(&format!(r#"{{"bankBin":"970422","bankName":"{long}"}}"#)),
            "bankName: Too big: expected string to have <=60 characters"
        );
    }

    /// The trimmed values are what gets stored and what the response echoes.
    #[test]
    fn the_trimmed_value_is_the_stored_value() {
        let input = save(GOOD).unwrap();
        assert_eq!(input.bank_bin, "970422");
        assert_eq!(input.account_number, "0123456789");
        assert_eq!(input.account_name, "Le Van A");
        assert_eq!(input.note.as_deref(), Some("ca 1"));

        let bare =
            r#"{"bankBin":"970422","bankName":"MB","accountNumber":"1234","accountName":"A"}"#;
        assert_eq!(save(bare).unwrap().note, None);
    }
}
