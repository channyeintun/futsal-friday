//! Web Push — RFC 8291 (`aes128gcm`) message encryption, RFC 8292 VAPID, and
//! the delivery seam the routes and the cron speak to.
//!
//! Ported from `src/push/crypto.ts` and `src/push/index.ts`.
//!
//! The encryption was written out by hand in the TypeScript rather than pulled
//! from npm — the usual `web-push` package is Node-only, and this is about 150
//! lines of well-specified key derivation that can be proved correct. That
//! proof is the point: `test/push-vectors.test.mjs` ran the worked example from
//! RFC 8291 Appendix A through `encryptPayload` and compared the full body byte
//! for byte, so a mistake failed the build rather than silently producing
//! undecryptable notifications. The same vector is a `#[test]` at the bottom of
//! this file.
//!
//! ## Why pure Rust and not SubtleCrypto
//!
//! Every primitive here exists as a RustCrypto crate that compiles to
//! `wasm32-unknown-unknown`, so the derivation runs in the Worker *and* under
//! `cargo test` on the host. Going through the host's `crypto.subtle` would
//! have made the RFC vector unrunnable anywhere but a live Worker, which is the
//! opposite of what the original test was for. The bytes are identical: HKDF,
//! P-256 ECDH, AES-128-GCM and ECDSA are specified by their standards, not by
//! their implementation.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use hmac::{Hmac, Mac};
use p256::ecdsa::signature::RandomizedSigner;
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use sha2::Sha256;
use worker::Env;

/// Advertised record size. One notification always fits in a single record.
const RECORD_SIZE: u32 = 4096;

/// RFC 8292 wants a contact the push service can reach if we misbehave.
const DEFAULT_SUBJECT: &str = "mailto:futsal-friday@example.com";

/// Subscriber key material, exactly as the browser handed it to us and as it is
/// stored in `push_subscriptions`.
#[derive(Debug, Clone)]
pub struct PushKeys {
    /// Subscriber's P-256 public key (`keys.p256dh`), base64url.
    pub p256dh: String,
    /// Subscriber's auth secret (`keys.auth`), base64url, 16 bytes.
    pub auth: String,
}

/// Everything the encryption or the request can fail with.
///
/// The original let these escape as thrown `DOMException`s and `TypeError`s and
/// caught them all in one place; here they travel as a value to the same place.
/// The one thing that cannot be reproduced is the exact wording the runtime put
/// on those exceptions — the strings below are as close as they can be. It is
/// invisible from outside: a reason only ever reaches `console.error`, and the
/// routes that report on a send report counts.
#[derive(Debug, Clone)]
pub struct PushError(String);

impl std::fmt::Display for PushError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl PushError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl From<worker::Error> for PushError {
    fn from(error: worker::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<serde_json::Error> for PushError {
    fn from(error: serde_json::Error) -> Self {
        Self(error.to_string())
    }
}

/* ---------------------------------------------------------------- base64url */

/// `b64urlEncode` from `lib/base64.ts`: the URL-safe alphabet, **no padding**.
///
/// The original went through `btoa`, which sees one Latin-1 code unit per byte
/// — there is no UTF-8 re-encoding step hiding in it, so this encodes the raw
/// bytes.
pub fn b64url_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let word = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(word >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(word >> 12) as usize & 0x3f] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(word >> 6) as usize & 0x3f] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[word as usize & 0x3f] as char);
        }
    }
    out
}

/// `b64urlDecode` from `lib/base64.ts`, including the two behaviours callers
/// lean on: it accepts input with or without `=` padding, and it *fails* on a
/// length that is `1 mod 4`.
///
/// The original padded to `ceil(len / 4) * 4` and handed the result to `atob`.
/// A `1 mod 4` input therefore gained three `=`, of which `atob` strips two and
/// then rejects the third — the intended failure path, not an accident. The
/// rest of `atob`'s forgiving-base64 decode is reproduced too (leading
/// whitespace stripped, leftover bits of a short final group discarded) so that
/// a malformed subscription key fails in the same place it used to.
pub fn b64url_decode(value: &str) -> Result<Vec<u8>, PushError> {
    // JS pads by string length, which counts UTF-16 code units.
    let length = value.encode_utf16().count();
    let padding = length.div_ceil(4) * 4 - length;

    let mut chars: Vec<char> = value
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    chars.extend(std::iter::repeat_n('=', padding));

    // What `atob` does, in its order: drop ASCII whitespace, drop up to two
    // trailing `=` but only from a length that is already a multiple of four,
    // reject a length of `1 mod 4`, then reject anything left that is not
    // alphabet — which is how a surviving `=` is caught.
    chars.retain(|c| !matches!(c, '\t' | '\n' | '\x0c' | '\r' | ' '));
    if chars.len() % 4 == 0 {
        for _ in 0..2 {
            if chars.last() == Some(&'=') {
                chars.pop();
            }
        }
    }
    if chars.len() % 4 == 1 {
        return Err(PushError::new("Invalid character"));
    }

    let mut sextets = Vec::with_capacity(chars.len());
    for c in chars {
        let value = match c {
            'A'..='Z' => c as u8 - b'A',
            'a'..='z' => c as u8 - b'a' + 26,
            '0'..='9' => c as u8 - b'0' + 52,
            '+' => 62,
            '/' => 63,
            _ => return Err(PushError::new("Invalid character")),
        };
        sextets.push(value);
    }

    let mut out = Vec::with_capacity(sextets.len() * 3 / 4);
    for group in sextets.chunks(4) {
        debug_assert!(group.len() > 1, "a length of 1 mod 4 was rejected above");
        let mut word = 0u32;
        for (index, sextet) in group.iter().enumerate() {
            word |= (*sextet as u32) << (18 - 6 * index);
        }
        out.push((word >> 16) as u8);
        if group.len() > 2 {
            out.push((word >> 8) as u8);
        }
        if group.len() > 3 {
            out.push(word as u8);
        }
    }
    Ok(out)
}

/* --------------------------------------------------------------------- HKDF */

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// HKDF with a single-block expand, which is all Web Push ever needs — every
/// output here is 32 bytes or fewer.
///
/// Extract is `PRK = HMAC(salt, ikm)` and expand is `T(1) = HMAC(PRK, info ||
/// 0x01)`: no `T(0)` prefix, no counter past one. Truncation clamps rather than
/// panics because the original's `slice(0, length)` did.
fn hkdf(salt: &[u8], ikm: &[u8], info: &[u8], length: usize) -> Vec<u8> {
    let prk = hmac_sha256(salt, ikm);
    let mut block = Vec::with_capacity(info.len() + 1);
    block.extend_from_slice(info);
    block.push(0x01);
    let okm = hmac_sha256(&prk, &block);
    okm[..length.min(okm.len())].to_vec()
}

/* --------------------------------------------------------------- encryption */

/// The fixed sender keypair and salt of the RFC 8291 Appendix A worked example.
///
/// Production passes nothing and a fresh ephemeral keypair is generated per
/// message, as the spec requires; this exists so the vector can be reproduced.
#[derive(Debug, Clone)]
pub struct SenderKeys {
    pub public_key: Vec<u8>,
    pub private_key: Vec<u8>,
    pub salt: Vec<u8>,
}

/// Encrypt a payload for one subscription, returning the complete `aes128gcm`
/// body ready to POST.
///
/// The TypeScript wrapped this in a one-field `EncryptedPayload` object purely
/// so the call site could destructure `{ body }`; the bytes are the whole
/// result.
pub fn encrypt_payload(
    payload: &str,
    keys: &PushKeys,
    sender_keys: Option<&SenderKeys>,
) -> Result<Vec<u8>, PushError> {
    let ua_public = b64url_decode(&keys.p256dh)?;
    let auth_secret = b64url_decode(&keys.auth)?;

    let as_public: Vec<u8>;
    let as_private: p256::SecretKey;
    let salt: Vec<u8>;

    if let Some(sender) = sender_keys {
        as_public = sender.public_key.clone();
        // WebCrypto could not import a bare scalar, so the original rebuilt a
        // JWK around it using the matching public point the caller already had.
        // Rust imports the scalar directly; the public point is carried
        // separately below exactly as it was there.
        as_private = p256::SecretKey::from_slice(&sender.private_key)
            .map_err(|_| PushError::new("Invalid key data"))?;
        salt = sender.salt.clone();
    } else {
        let secret = p256::SecretKey::random(&mut OsRng);
        as_public = secret.public_key().to_sec1_bytes().to_vec();
        as_private = secret;
        let mut fresh = vec![0u8; 16];
        OsRng.fill_bytes(&mut fresh);
        salt = fresh;
    }

    let ua_public_key =
        p256::PublicKey::from_sec1_bytes(&ua_public).map_err(|_| PushError::new("Invalid key data"))?;
    let ecdh_secret = p256::ecdh::diffie_hellman(as_private.to_nonzero_scalar(), ua_public_key.as_affine());
    let ecdh_secret = ecdh_secret.raw_secret_bytes();

    // RFC 8291 §3.4. Note the order: the *user agent* key comes first.
    let mut key_info = Vec::with_capacity(13 + 1 + ua_public.len() + as_public.len());
    key_info.extend_from_slice(b"WebPush: info");
    key_info.push(0x00);
    key_info.extend_from_slice(&ua_public);
    key_info.extend_from_slice(&as_public);
    let ikm = hkdf(&auth_secret, ecdh_secret, &key_info, 32);

    let cek = hkdf(&salt, &ikm, b"Content-Encoding: aes128gcm\0", 16);
    let nonce: [u8; 12] = hkdf(&salt, &ikm, b"Content-Encoding: nonce\0", 12)
        .try_into()
        .expect("HKDF was asked for twelve bytes");

    // 0x02 is the last-record delimiter (RFC 8188 §2); a padding-only tail is
    // not used because every notification here fits one record.
    let mut plaintext = payload.as_bytes().to_vec();
    plaintext.push(0x02);

    let cipher =
        Aes128Gcm::new_from_slice(&cek).map_err(|_| PushError::new("Invalid key data"))?;
    let ciphertext = cipher
        .encrypt(&Nonce::from(nonce), plaintext.as_slice())
        .map_err(|_| PushError::new("The operation failed for an operation-specific reason"))?;

    // Header: salt(16) || record size(4, big-endian) || key id length(1) || key id
    let mut body = Vec::with_capacity(salt.len() + 5 + as_public.len() + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(&as_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

/* -------------------------------------------------------------------- VAPID */

#[derive(Debug, Clone)]
pub struct VapidKeys {
    /// base64url uncompressed P-256 point. Public — shipped to the browser.
    pub public_key: String,
    /// base64url raw scalar. Secret.
    pub private_key: String,
    /// `mailto:` or `https:` contact, per RFC 8292.
    pub subject: String,
}

#[derive(Serialize)]
struct VapidClaims<'a> {
    aud: &'a str,
    exp: i64,
    sub: &'a str,
}

/// Build the `Authorization: vapid t=..., k=...` header proving to the push
/// service which application server is sending.
///
/// `now` is milliseconds since the epoch. The original defaulted it to
/// `Date.now()` and passed it explicitly from tests; Rust has no default
/// arguments, so the one production caller passes the clock.
pub fn vapid_authorization(endpoint: &str, vapid: &VapidKeys, now: f64) -> Result<String, PushError> {
    let audience = origin_of(endpoint)?;

    // `{"typ":"JWT","alg":"ES256"}` — `typ` before `alg`, which is the fixed
    // string `eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9`.
    let header = b64url_encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = b64url_encode(
        serde_json::to_string(&VapidClaims {
            aud: &audience,
            // Spec allows 24h; 12h leaves room for clock skew at both ends.
            exp: (now / 1000.0).floor() as i64 + 12 * 60 * 60,
            sub: &vapid.subject,
        })?
        .as_bytes(),
    );
    let signing_input = format!("{header}.{claims}");

    let scalar = b64url_decode(&vapid.private_key)?;
    let signing_key = p256::ecdsa::SigningKey::from_slice(&scalar)
        .map_err(|_| PushError::new("Invalid key data"))?;

    // WebCrypto emits the raw r||s form that JWS wants — no DER unwrapping —
    // and it picks a fresh `k` per call, so this signs randomized rather than
    // with RFC 6979.
    let signature: p256::ecdsa::Signature =
        signing_key.sign_with_rng(&mut OsRng, signing_input.as_bytes());

    Ok(format!(
        "vapid t={signing_input}.{}, k={}",
        b64url_encode(&signature.to_bytes()),
        // Whatever base64url string the env var holds is what ships: the
        // advertised key is not re-encoded from the decoded bytes.
        vapid.public_key
    ))
}

/// `new URL(endpoint).origin` — `scheme://host[:port]`, no trailing slash,
/// default ports omitted, host lowercased and punycoded.
///
/// `worker::Url` is the same WHATWG URL implementation the runtime parses with,
/// so the normalisation matches; an unparseable endpoint fails here exactly
/// where the `TypeError` used to be thrown.
fn origin_of(endpoint: &str) -> Result<String, PushError> {
    let url = worker::Url::parse(endpoint).map_err(|_| PushError::new("Invalid URL string."))?;
    Ok(url.origin().ascii_serialization())
}

/// A generated VAPID keypair, both halves base64url.
#[derive(Debug, Clone)]
pub struct GeneratedVapidKeys {
    pub public_key: String,
    pub private_key: String,
}

/// Generate a VAPID keypair. Used by `npm run push:keys`.
pub fn generate_vapid_keys() -> GeneratedVapidKeys {
    let secret = p256::SecretKey::random(&mut OsRng);
    GeneratedVapidKeys {
        public_key: b64url_encode(&secret.public_key().to_sec1_bytes()),
        // The original read the JWK `d` member, which WebCrypto already emits
        // as unpadded base64url of the 32-byte scalar.
        private_key: b64url_encode(&secret.to_bytes()),
    }
}

/* ----------------------------------------------------------------- delivery */

/// One device to deliver to.
#[derive(Debug, Clone)]
pub struct PushTarget {
    pub subscription_id: String,
    pub endpoint: String,
    pub keys: PushKeys,
}

/// What the service worker receives and renders as a notification.
#[derive(Debug, Clone, Default)]
pub struct PushMessage {
    pub title: String,
    pub body: String,
    /// Deep link opened when the notification is tapped.
    pub url: Option<String>,
    /// Collapses earlier notifications with the same tag.
    pub tag: Option<String>,
    /// Seconds the push service should hold the message for an offline device.
    /// The original typed this `number`; every producer computes a whole number
    /// of seconds, and `TTL` is an integer header, so it is one here.
    pub ttl: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushOutcome {
    Sent {
        subscription_id: String,
    },
    /// The subscription is permanently gone — delete the row.
    Gone {
        subscription_id: String,
    },
    /// Transient or unexpected; count the failure but keep the row.
    Failed {
        subscription_id: String,
        reason: String,
    },
}

impl PushOutcome {
    pub fn subscription_id(&self) -> &str {
        match self {
            Self::Sent { subscription_id }
            | Self::Gone { subscription_id }
            | Self::Failed { subscription_id, .. } => subscription_id,
        }
    }
}

#[derive(Serialize)]
struct NotificationPayload<'a> {
    title: &'a str,
    body: &'a str,
    url: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    tag: Option<&'a str>,
}

/// Web Push delivery.
///
/// Kept behind a seam for the same reason as the realtime module: it is a
/// third-party dependency in the hot path of a cron job, and the day it needs
/// to become "post to a queue instead" should be a one-file change.
///
/// `enabled` was a field on the original interface and is a method here only
/// because the answer *is* whether VAPID is configured — storing it twice would
/// let the two disagree.
pub struct PushSender {
    vapid: Option<VapidKeys>,
}

pub fn create_push_sender(env: &Env) -> PushSender {
    // Truthiness, not presence: an empty binding disables push, and both halves
    // of the keypair have to be there.
    let Some(configured) = crate::env::vapid(env) else {
        return PushSender { vapid: None };
    };

    PushSender {
        vapid: Some(VapidKeys {
            public_key: configured.public_key,
            private_key: configured.private_key,
            // `||`, not `??`: an empty `VAPID_SUBJECT` falls back too.
            subject: if configured.subject.is_empty() {
                DEFAULT_SUBJECT.to_string()
            } else {
                configured.subject
            },
        }),
    }
}

impl PushSender {
    pub fn enabled(&self) -> bool {
        self.vapid.is_some()
    }

    /// The key browsers need to create a subscription.
    pub fn public_key(&self) -> Option<String> {
        self.vapid.as_ref().map(|vapid| vapid.public_key.clone())
    }

    /// Never fails: every error becomes a `failed` outcome, because the caller's
    /// job is to count failures and prune dead endpoints, not to unwind.
    pub async fn send(&self, target: &PushTarget, message: &PushMessage) -> PushOutcome {
        let Some(vapid) = self.vapid.as_ref() else {
            worker::console_log!("[push disabled] would notify {}", target.subscription_id);
            return PushOutcome::Failed {
                subscription_id: target.subscription_id.clone(),
                reason: "disabled".to_string(),
            };
        };

        match deliver(vapid, target, message).await {
            Ok(outcome) => outcome,
            Err(error) => PushOutcome::Failed {
                subscription_id: target.subscription_id.clone(),
                reason: error.to_string(),
            },
        }
    }
}

async fn deliver(
    vapid: &VapidKeys,
    target: &PushTarget,
    message: &PushMessage,
) -> Result<PushOutcome, PushError> {
    let payload = serde_json::to_string(&NotificationPayload {
        title: &message.title,
        body: &message.body,
        // `??`, so an explicitly empty string stays empty.
        url: message.url.as_deref().unwrap_or("/"),
        // Absent means the key is not in the JSON at all, not `null`.
        tag: message.tag.as_deref(),
    })?;

    let body = encrypt_payload(&payload, &target.keys, None)?;
    // Encryption first, so the VAPID `exp` is anchored to the moment after it —
    // immaterial to the bytes, but this was the order.
    let authorization = vapid_authorization(&target.endpoint, vapid, crate::js::now_ms())?;

    let headers = worker::Headers::new();
    headers.set("Authorization", &authorization)?;
    headers.set("Content-Encoding", "aes128gcm")?;
    headers.set("Content-Type", "application/octet-stream")?;
    // A reminder that arrives a day late is worse than none at all.
    headers.set("TTL", &message.ttl.unwrap_or(6 * 60 * 60).to_string())?;
    headers.set("Urgency", "normal")?;
    // An empty tag is falsy, so it carries no `Topic` at all; a tag that
    // survives filtering to nothing still carries an empty one.
    if let Some(tag) = message.tag.as_deref().filter(|tag| !tag.is_empty()) {
        headers.set("Topic", &safe_topic(tag))?;
    }

    let mut init = worker::RequestInit::new();
    init.with_method(worker::Method::Post)
        .with_headers(headers)
        .with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));

    let request = worker::Request::new_with_init(&target.endpoint, &init)?;
    let mut response = worker::Fetch::Request(request).send().await?;
    let status = response.status_code();

    if (200..300).contains(&status) {
        return Ok(PushOutcome::Sent {
            subscription_id: target.subscription_id.clone(),
        });
    }

    // 404/410 is the push service saying this endpoint will never work again —
    // the user cleared site data or uninstalled the app.
    if status == 404 || status == 410 {
        return Ok(PushOutcome::Gone {
            subscription_id: target.subscription_id.clone(),
        });
    }

    let detail = response.text().await.unwrap_or_default();
    Ok(PushOutcome::Failed {
        subscription_id: target.subscription_id.clone(),
        reason: format!("{status} {}", slice_utf16(&detail, 120)),
    })
}

/// `Topic` must be a short base64url token; our tags contain `:` and ids.
/// Truncating keeps collapsing behaviour without risking a 400 from the service.
fn safe_topic(tag: &str) -> String {
    tag.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(32)
        .collect()
}

/// `detail.slice(0, 120)` — JS slices by UTF-16 code unit, so a string of
/// astral characters is cut at 60 of them, not 120.
fn slice_utf16(value: &str, limit: usize) -> &str {
    let mut units = 0usize;
    for (index, c) in value.char_indices() {
        let width = c.len_utf16();
        if units + width > limit {
            return &value[..index];
        }
        units += width;
    }
    value
}

/* -------------------------------------------------------------------- tests */

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 8291 Appendix A, the specification's own worked example.
    const PLAINTEXT: &str = "When I grow up, I want to be a watermelon";
    const AUTH_SECRET: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const UA_PUBLIC: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const AS_PUBLIC: &str =
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const EXPECTED_BODY: &str = concat!(
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
        "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT",
        "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );

    fn subscriber() -> PushKeys {
        PushKeys {
            p256dh: UA_PUBLIC.to_string(),
            auth: AUTH_SECRET.to_string(),
        }
    }

    fn rfc_body() -> Vec<u8> {
        encrypt_payload(
            PLAINTEXT,
            &subscriber(),
            Some(&SenderKeys {
                public_key: b64url_decode(AS_PUBLIC).unwrap(),
                private_key: b64url_decode(AS_PRIVATE).unwrap(),
                salt: b64url_decode(SALT).unwrap(),
            }),
        )
        .unwrap()
    }

    #[test]
    fn encrypted_body_matches_the_rfc_vector_byte_for_byte() {
        assert_eq!(b64url_encode(&rfc_body()), EXPECTED_BODY);
    }

    #[test]
    fn body_length_is_salt_rs_idlen_key_ciphertext() {
        assert_eq!(rfc_body().len(), 16 + 4 + 1 + 65 + 58);
    }

    #[test]
    fn header_carries_the_sender_public_key() {
        assert_eq!(b64url_encode(&rfc_body()[21..86]), AS_PUBLIC);
    }

    #[test]
    fn record_size_is_4096() {
        let body = rfc_body();
        assert_eq!(u32::from_be_bytes(body[16..20].try_into().unwrap()), 4096);
    }

    #[test]
    fn a_fresh_keypair_and_salt_are_used_per_message() {
        let a = encrypt_payload("hello", &subscriber(), None).unwrap();
        let b = encrypt_payload("hello", &subscriber(), None).unwrap();
        assert_ne!(b64url_encode(&a), b64url_encode(&b));
        // Both still have the right shape.
        assert_eq!(a.len(), b.len());
        assert_eq!(a.len(), 16 + 4 + 1 + 65 + 22);
    }

    #[test]
    fn generated_vapid_keys_have_the_right_shape() {
        let keys = generate_vapid_keys();
        let public = b64url_decode(&keys.public_key).unwrap();
        assert_eq!(public.len(), 65);
        assert_eq!(public[0], 0x04);
        assert_eq!(b64url_decode(&keys.private_key).unwrap().len(), 32);
    }

    #[test]
    fn vapid_header_is_a_verifiable_es256_jwt() {
        use p256::ecdsa::signature::Verifier;

        // Pinned so `exp` can be asserted exactly rather than approximately.
        let now = 1_755_300_123_456.0_f64;
        let generated = generate_vapid_keys();
        let keys = VapidKeys {
            public_key: generated.public_key.clone(),
            private_key: generated.private_key.clone(),
            subject: "mailto:organizer@example.com".to_string(),
        };

        let header =
            vapid_authorization("https://fcm.googleapis.com/fcm/send/abc123", &keys, now).unwrap();

        assert!(header.starts_with("vapid t="));
        assert!(header.contains(&format!("k={}", keys.public_key)));

        let jwt = header["vapid t=".len()..].split(',').next().unwrap();
        let segments: Vec<&str> = jwt.split('.').collect();
        assert_eq!(segments.len(), 3);
        let (h, c, s) = (segments[0], segments[1], segments[2]);

        let decoded_header: serde_json::Value =
            serde_json::from_slice(&b64url_decode(h).unwrap()).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&b64url_decode(c).unwrap()).unwrap();

        assert_eq!(decoded_header["typ"], "JWT");
        assert_eq!(decoded_header["alg"], "ES256");
        // The audience is the push service origin, not the full endpoint.
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["sub"], "mailto:organizer@example.com");
        assert_eq!(claims["exp"], 1_755_300_123_i64 + 12 * 60 * 60);

        // Raw r||s, not DER.
        let signature = b64url_decode(s).unwrap();
        assert_eq!(signature.len(), 64);

        // And it verifies under the advertised public key.
        let verifying = p256::ecdsa::VerifyingKey::from_sec1_bytes(
            &b64url_decode(&keys.public_key).unwrap(),
        )
        .unwrap();
        verifying
            .verify(
                format!("{h}.{c}").as_bytes(),
                &p256::ecdsa::Signature::from_slice(&signature).unwrap(),
            )
            .unwrap();
    }

    #[test]
    fn the_jose_header_is_the_fixed_string() {
        assert_eq!(
            b64url_encode(br#"{"typ":"JWT","alg":"ES256"}"#),
            "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9"
        );
    }

    #[test]
    fn base64url_matches_btoa_and_atob() {
        // No padding on the way out, padding tolerated on the way in.
        assert_eq!(b64url_encode(&[]), "");
        assert_eq!(b64url_encode(&[0xff, 0xff, 0xfe]), "___-");
        assert_eq!(b64url_encode(&[0x01]), "AQ");
        assert_eq!(b64url_encode(&[0x01, 0x02]), "AQI");
        assert_eq!(b64url_decode("AQ").unwrap(), vec![0x01]);
        assert_eq!(b64url_decode("AQ==").unwrap(), vec![0x01]);
        assert_eq!(b64url_decode("___-").unwrap(), vec![0xff, 0xff, 0xfe]);
        // Length 1 mod 4 gains three `=` and is rejected, as `atob` rejected it.
        assert!(b64url_decode("AQIDA").is_err());
        assert!(b64url_decode("!!!!").is_err());
        // An `=` that is not trailing padding is not alphabet.
        assert!(b64url_decode("A=QI").is_err());
        // Trailing bits of a short final group are discarded, not an error.
        assert_eq!(b64url_decode("AR").unwrap(), vec![0x01]);
    }

    #[test]
    fn the_notification_payload_keeps_its_key_order_and_drops_an_absent_tag() {
        let with_tag = serde_json::to_string(&NotificationPayload {
            title: "t",
            body: "b",
            url: "/",
            tag: Some("session-1"),
        })
        .unwrap();
        assert_eq!(
            with_tag,
            r#"{"title":"t","body":"b","url":"/","tag":"session-1"}"#
        );

        let without = serde_json::to_string(&NotificationPayload {
            title: "t",
            body: "b",
            url: "/",
            tag: None,
        })
        .unwrap();
        assert_eq!(without, r#"{"title":"t","body":"b","url":"/"}"#);
    }

    #[test]
    fn safe_topic_filters_then_truncates() {
        assert_eq!(safe_topic("session-abc:123"), "session-abc123");
        assert_eq!(safe_topic("héllo"), "hllo");
        assert_eq!(safe_topic(&"a:".repeat(40)).len(), 32);
        assert_eq!(safe_topic("::::"), "");
    }

    #[test]
    fn a_failure_reason_truncates_to_120_utf16_units() {
        assert_eq!(format!("429 {}", slice_utf16("", 120)), "429 ");
        let long = "x".repeat(200);
        assert_eq!(slice_utf16(&long, 120).len(), 120);
    }
}
