//! Payment screenshot upload.
//!
//! Ported from `src/routes/uploads.ts`.
//!
//! Images are resized and re-encoded in the browser before they get here (see
//! `web/src/platform/images.ts`), so this endpoint's job is to be strict about
//! what it accepts rather than to do any processing of its own — a Worker has
//! neither the CPU budget nor an image library for that.
//!
//! ## R2 free-tier arithmetic
//!
//! The free bucket is 10 GB with no egress charge. At the ~150 KB the client
//! compressor targets, 15 players × 52 weeks is roughly 120 MB/year — about 1%
//! of the allowance per year. The hard cap below is what stops an unresized
//! 12-megapixel photo from turning that estimate into a lie.

use std::collections::HashMap;

use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{Env, HttpMetadata, Request, Response};

use crate::http::{self, code, ApiError, ApiResult};
use crate::js;
use crate::middleware::Identity;

/// Comfortably above the client's ~150 KB target, far below an original photo.
const MAX_BYTES: usize = 1_000_000;

/// The allowlist, as content type → file extension.
///
/// A `Record<string, string>` in the original, and a slice of pairs here for the
/// same reason it was a plain object there: three entries looked up by exact
/// key and never iterated.
pub const ALLOWED_IMAGE_TYPES: &[(&str, &str)] =
    &[("image/jpeg", "jpg"), ("image/png", "png"), ("image/webp", "webp")];

fn extension_for(content_type: &str) -> Option<&'static str> {
    ALLOWED_IMAGE_TYPES
        .iter()
        .find(|(candidate, _)| *candidate == content_type)
        .map(|(_, extension)| *extension)
}

/// What an accepted upload turned out to be.
pub struct ImageUpload {
    pub body: Vec<u8>,
    /// The request's content type with any `; charset=…` parameters removed —
    /// this is what gets stored on the object, not the raw header.
    pub content_type: String,
    pub extension: &'static str,
}

/// Read an uploaded image off the request, or return a useful error.
///
/// Shared with the avatar route so both intakes are strict in the same way and
/// cannot drift apart — the size cap differs, everything else does not.
pub async fn read_image_upload(req: &mut Request, max_bytes: usize) -> ApiResult<ImageUpload> {
    // `(header ?? '').split(';')[0]?.trim() ?? ''` — splitting an empty string
    // yields one empty part, so an absent header lands on the same empty value
    // a parameters-only header would.
    let raw = req.headers().get("Content-Type").ok().flatten().unwrap_or_default();
    let content_type = raw.split(';').next().unwrap_or("").trim().to_string();
    let Some(extension) = extension_for(&content_type) else {
        return Err(http::bad_request("Upload a JPEG, PNG or WebP image"));
    };

    // Reject on the declared length first so an oversized body is not streamed
    // into the Worker at all; the real check follows, since the header lies.
    let declared = req
        .headers()
        .get("Content-Length")
        .ok()
        .flatten()
        .as_deref()
        .and_then(js::parse_int_prefix);
    // `Number.isFinite(declared)` — an absent or unparseable header is `NaN`,
    // which fails that test and skips the early rejection entirely.
    if let Some(declared) = declared {
        if declared > max_bytes as i64 {
            return Err(too_large_at(max_bytes));
        }
    }

    let body = req.bytes().await?;
    if body.is_empty() {
        return Err(http::bad_request("Empty upload"));
    }
    if body.len() > max_bytes {
        return Err(too_large_at(max_bytes));
    }

    Ok(ImageUpload { body, content_type, extension })
}

/// The cap is quoted in KB of a thousand bytes, which is how the client's
/// compressor talks about it. `Math.round` of a whole number of thousands is
/// exact, so the proof route's message is always `… under 1000 KB`.
fn too_large_at(max_bytes: usize) -> ApiError {
    let kilobytes = (max_bytes as f64 / 1000.0).round() as i64;
    ApiError::new(
        413,
        code::PAYLOAD_TOO_LARGE,
        format!("Image is too large — keep it under {kilobytes} KB"),
    )
}

/// `uploadRoutes`, mounted at `/uploads` inside `protectedRoutes`.
///
/// `None` is Hono's fall-through: the dispatcher tries the next router, and a
/// path this file owns under the wrong method — `GET /uploads/proof` — falls
/// through to the not-found handler having already passed the auth gates.
///
/// The method is read off the raw request rather than through
/// `Request::method()`, which folds every verb the `worker` crate does not know
/// onto `GET` — `QUERY` among them, and the CORS preflight advertises it.
pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    match (req.inner().method().as_str(), req.path().as_str()) {
        ("POST", "/uploads/proof") => Some(post_proof(req, env, identity).await),
        _ => None,
    }
}

async fn post_proof(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    // `if (!sessionId)` — absent and present-but-empty are the same falsy thing.
    let session_id = query_param(req, "sessionId")?.filter(|value| !value.is_empty());
    let Some(session_id) = session_id else {
        return Err(http::bad_request("sessionId query parameter is required"));
    };

    let db = crate::env::db(env)?;

    // Only somebody who actually owes money for this session can attach a
    // screenshot to it — that also bounds how many objects can ever be written.
    let owes: Option<Value> = db
        .prepare("SELECT 1 FROM payments WHERE session_id = ?1 AND member_id = ?2")
        .bind(&[JsValue::from_str(&session_id), JsValue::from_str(&identity.member_id)])?
        .first(None)
        .await?;
    if owes.is_none() {
        return Err(http::conflict("You have nothing to pay for that session"));
    }

    let upload = read_image_upload(req, MAX_BYTES).await?;

    let key = format!(
        "proofs/{}/{}/{}.{}",
        session_id,
        identity.member_id,
        http::new_id("img"),
        upload.extension
    );

    let mut custom = HashMap::new();
    custom.insert("memberId".to_string(), identity.member_id.clone());
    custom.insert("sessionId".to_string(), session_id.clone());

    // Objects are never deleted by this route: a proof outlives the claim it
    // was attached to, and the arithmetic above is what says that is affordable.
    let proofs = crate::env::proofs(env)?;
    proofs
        .put(&key, upload.body)
        .http_metadata(HttpMetadata {
            content_type: Some(upload.content_type),
            ..Default::default()
        })
        .custom_metadata(custom)
        .execute()
        .await?;

    // The key is opaque to the client: it is echoed back only so it can be
    // attached to the payment claim. Reading an image always goes through the
    // authorized `/payments/:id/proof` route.
    Ok(Response::from_json(&json!({ "key": key }))?.with_status(201))
}

/// `c.req.query(name)` — the first occurrence, form-decoded (`+` is a space),
/// or `None` when the key is not in the query string at all.
fn query_param(req: &Request, name: &str) -> ApiResult<Option<String>> {
    let url = req.url()?;
    Ok(url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_three_encodings_the_client_can_produce() {
        assert_eq!(extension_for("image/jpeg"), Some("jpg"));
        assert_eq!(extension_for("image/png"), Some("png"));
        assert_eq!(extension_for("image/webp"), Some("webp"));
        assert_eq!(extension_for("image/gif"), None);
        assert_eq!(extension_for("IMAGE/PNG"), None);
        assert_eq!(extension_for(""), None);
    }

    /// The message is user-visible and carries an em dash (U+2014).
    #[test]
    fn quotes_the_cap_in_thousands_of_bytes() {
        let error = too_large_at(MAX_BYTES);
        assert_eq!(error.status, 413);
        assert_eq!(error.code, "payload_too_large");
        assert_eq!(error.message, "Image is too large — keep it under 1000 KB");
    }
}
