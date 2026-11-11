//! Passwords: hashing one, checking one, and the group's shared default.
//!
//! A member who has not chosen a password signs in with the group's, which is
//! the `DEFAULT_PASSWORD` secret and the same for everybody. It exists because a
//! link was once the only way in, and the day the organizer was signed out too
//! there was nobody left to send one. Choosing your own takes the shared one
//! away from your account; until then, anybody who knows it and your name can
//! be you, which is why the app keeps asking.
//!
//! ## Why PBKDF2, and why only this many rounds
//!
//! The Worker runs on the free plan, which allows about 10 ms of CPU per
//! request. Anything memory-hard (Argon2, scrypt) compiled to Wasm would spend
//! that several times over, and so would PBKDF2 in pure Rust. WebCrypto's PBKDF2
//! is native code: 50,000 rounds of SHA-256 is about 6 ms, which leaves room for
//! the rest of the request. Changing a password you already have does two —
//! checking the old one, hashing the new — so that request runs to about 12 ms.
//! The free plan tolerates a Worker that goes over now and then, and nobody
//! changes their password often; if it ever starts failing, that is the request
//! to split. A hash records its own round count, so raising this later only
//! affects passwords set after the change.

use crate::base64;
use crate::http::{self, ApiResult};
use crate::identity::timing_safe_equal;
use crate::js;

const SCHEME: &str = "pbkdf2-sha256";

/// Rounds for a newly set password. See the module note for why not more.
pub const ITERATIONS: u32 = 50_000;

/// What `crypto.subtle.deriveBits` accepts in a Worker; a stored hash claiming
/// more cannot be checked, so it reads as malformed.
const MAX_ITERATIONS: u32 = 100_000;

const SALT_BYTES: usize = 16;
const HASH_BYTES: usize = 32;

/// Counted in characters. Short enough to type on a phone, long enough that the
/// six-digit PIN everybody reaches for first still fits.
pub const MIN_LENGTH: usize = 6;
pub const MAX_LENGTH: usize = 200;

/// A stored hash, taken apart.
#[derive(Debug, PartialEq)]
struct Stored {
    iterations: u32,
    salt: Vec<u8>,
    /// base64url, compared as text so the existing constant-time compare does.
    hash: String,
}

/// `pbkdf2-sha256$<iterations>$<salt>$<hash>`, or `None` for anything else.
fn parse(stored: &str) -> Option<Stored> {
    let mut parts = stored.split('$');
    if parts.next()? != SCHEME {
        return None;
    }
    let iterations: u32 = parts.next()?.parse().ok()?;
    if iterations == 0 || iterations > MAX_ITERATIONS {
        return None;
    }
    let salt = base64::b64url_decode(parts.next()?).ok()?;
    let hash = parts.next()?.to_string();
    if parts.next().is_some() || salt.is_empty() {
        return None;
    }
    if base64::b64url_decode(&hash).ok()?.len() != HASH_BYTES {
        return None;
    }
    Some(Stored { iterations, salt, hash })
}

fn encode(iterations: u32, salt: &[u8], hash: &[u8]) -> String {
    format!(
        "{SCHEME}${iterations}${}${}",
        base64::b64url_encode(salt),
        base64::b64url_encode(hash)
    )
}

async fn derive(password: &str, salt: &[u8], iterations: u32) -> ApiResult<Vec<u8>> {
    js::pbkdf2_sha256(password.as_bytes(), salt, iterations, (HASH_BYTES * 8) as u32)
        .await
        .map_err(|error| {
            worker::console_error!("PBKDF2 failed: {:?}", error);
            http::internal()
        })
}

/// A fresh salt and the hash of `password` under it, ready to store.
pub async fn hash(password: &str) -> ApiResult<String> {
    let mut salt = [0u8; SALT_BYTES];
    getrandom::fill(&mut salt).expect("crypto.getRandomValues is always available");
    let derived = derive(password, &salt, ITERATIONS).await?;
    Ok(encode(ITERATIONS, &salt, &derived))
}

/// Whether `password` is the one `stored` was made from. A stored value that
/// does not parse matches nothing.
pub async fn verify(password: &str, stored: &str) -> ApiResult<bool> {
    let Some(stored) = parse(stored) else {
        worker::console_error!("A stored password hash does not parse");
        return Ok(false);
    };
    let derived = derive(password, &stored.salt, stored.iterations).await?;
    Ok(timing_safe_equal(&base64::b64url_encode(&derived), &stored.hash))
}

/// The group's shared password, for somebody who has not set their own. Unset
/// or empty means there is no shared password, and nobody gets in this way.
pub fn is_default(default: Option<&str>, password: &str) -> bool {
    match default {
        Some(default) if !default.is_empty() => timing_safe_equal(password, default),
        _ => false,
    }
}

/// Length in characters, which is what somebody counting what they typed means.
pub fn length_ok(password: &str) -> bool {
    (MIN_LENGTH..=MAX_LENGTH).contains(&password.chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Taken from node: `crypto.pbkdf2Sync('group-password', salt, 50000, 32,
    /// 'sha256')` with the salt below. The smoke test checks a hash the Worker
    /// wrote the same way, so the two ends are held to one algorithm.
    const STORED: &str = "pbkdf2-sha256$50000$AAECAwQFBgcICQoLDA0ODw$\
                          bMNLncXb0f-X32UMYbHjPYPVZI1XSn2PWRNxRwTHrYY";

    #[test]
    fn reads_back_what_it_writes() {
        let salt: Vec<u8> = (0..16).collect();
        let hash = vec![7u8; 32];
        let text = encode(50_000, &salt, &hash);
        assert_eq!(
            parse(&text),
            Some(Stored { iterations: 50_000, salt, hash: base64::b64url_encode(&hash) })
        );
        assert!(parse(STORED).is_some());
    }

    #[test]
    fn refuses_anything_it_did_not_write() {
        let salt = "AAECAwQFBgcICQoLDA0ODw";
        let hash = "bMNLncXb0f-X32UMYbHjPYPVZI1XSn2PWRNxRwTHrYY";
        for bad in [
            String::new(),
            "group-password".to_string(),
            format!("bcrypt$50000${salt}${hash}"),
            format!("pbkdf2-sha256$0${salt}${hash}"),
            format!("pbkdf2-sha256$100001${salt}${hash}"),
            format!("pbkdf2-sha256$lots${salt}${hash}"),
            format!("pbkdf2-sha256$50000$${hash}"),
            format!("pbkdf2-sha256$50000${salt}$AAAA"),
            format!("pbkdf2-sha256$50000${salt}"),
            format!("pbkdf2-sha256$50000${salt}${hash}$extra"),
            format!("pbkdf2-sha256$50000$!!!${hash}"),
        ] {
            assert_eq!(parse(&bad), None, "{bad:?} should not parse");
        }
    }

    #[test]
    fn the_shared_password_needs_to_be_set() {
        assert!(is_default(Some("group-password"), "group-password"));
        assert!(!is_default(Some("group-password"), "Group-password"), "case matters");
        assert!(!is_default(Some("group-password"), "group-password "), "so does a trailing space");
        assert!(!is_default(Some(""), ""), "an empty secret is no secret");
        assert!(!is_default(None, ""));
        assert!(!is_default(None, "group-password"));
    }

    #[test]
    fn counts_characters_not_bytes() {
        assert!(!length_ok("12345"));
        assert!(length_ok("123456"));
        // Seven Burmese code points are twenty-one bytes, and still seven.
        assert!(length_ok("မြန်မာစ"));
        assert!(!length_ok("မြန်"));
        assert!(length_ok(&"x".repeat(MAX_LENGTH)));
        assert!(!length_ok(&"x".repeat(MAX_LENGTH + 1)));
    }
}
