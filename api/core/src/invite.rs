//! Reading an invite out of whatever somebody pasted.
//!
//! An installed PWA has no address bar, so a link cannot be "opened" in it.
//! That is not a rare corner: on iOS, tapping a link inside a chat app opens the
//! in-app webview, whose storage is a different world from the installed app —
//! so somebody can sign in perfectly well and still find their home-screen icon
//! signed out, with nowhere to put the link. Pasting it into a field is the way
//! back, and this turns the paste into something the app can act on.
//!
//! Deliberately forgiving about what arrives. People paste whole URLs, links
//! that a chat client wrapped in tracking parameters, text with the link
//! somewhere in the middle, and occasionally just the code.
//!
//! Ported from `shared/src/invite.ts`.

/// Which door the link goes through: joining the group, or claiming a name
/// somebody already added to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviteKind {
    Join,
    Claim,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedInvite {
    pub nonce: String,
    /// `None` when the paste carried no path to tell them apart — a bare code.
    /// The caller resolves it by trying the read-only one first.
    pub kind: Option<InviteKind>,
}

/// Nonces are 32 random bytes, base64url. A range is accepted, not a fixed
/// length, so a future length still reads.
const NONCE_MIN: usize = 20;

pub fn parse_invite(input: &str) -> Option<ParsedInvite> {
    let text = trim(input);
    if text.is_empty() {
        return None;
    }

    // The fragment is the interesting part and never reaches a server, so it
    // survives whatever a chat client did to the rest of the URL.
    if let Some(hash_at) = text.find('#') {
        let before = &text[..hash_at];
        let after = &text[hash_at + 1..];
        // Stop at anything that cannot be part of a nonce: a trailing quote, a
        // full stop, a chat client's invisible padding.
        let found = nonce_in(after)?;
        return Some(ParsedInvite { nonce: found.to_string(), kind: kind_of(before) });
    }

    // No fragment. Either a bare code, or a link whose fragment was stripped —
    // in which case there is nothing to recover and the token in the path is
    // not one.
    if text.contains('/') || text.contains('?') {
        return None;
    }
    let found = nonce_in(text)?;
    if found != text {
        return None;
    }
    Some(ParsedInvite { nonce: text.to_string(), kind: None })
}

fn kind_of(path: &str) -> Option<InviteKind> {
    if has_segment(path, "/join") {
        return Some(InviteKind::Join);
    }
    if has_segment(path, "/claim") {
        return Some(InviteKind::Claim);
    }
    None
}

/// `/join` at a word boundary: `/join?x=1` is one, `/joining` is not.
fn has_segment(path: &str, word: &str) -> bool {
    path.match_indices(word)
        .any(|(at, _)| path[at + word.len()..].chars().next().is_none_or(|c| !is_word(c)))
}

/// What `\b` counts as a word character, which is ASCII and nothing else.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The first run of at least [`NONCE_MIN`] base64url characters, in full.
///
/// The original's regular expression is unanchored and greedy, so it takes the
/// earliest run long enough to be a nonce and then all of it — which is what
/// lets a link survive being pasted mid-sentence.
fn nonce_in(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if !is_nonce_byte(bytes[at]) {
            at += 1;
            continue;
        }
        let start = at;
        while at < bytes.len() && is_nonce_byte(bytes[at]) {
            at += 1;
        }
        if at - start >= NONCE_MIN {
            return Some(&text[start..at]);
        }
    }
    None
}

fn is_nonce_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// JavaScript's `String.prototype.trim`, which is not quite Rust's: it counts
/// the byte-order mark as space and U+0085 NEXT LINE as text, and a paste from
/// a chat client can carry either.
fn trim(text: &str) -> &str {
    text.trim_matches(|c| {
        matches!(c,
            '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}'
            | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}'
            | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: &str = "aG9sYS10aGlzLWlzLWEtbm9uY2UtdmFsdWU";

    fn parsed(nonce: &str, kind: Option<InviteKind>) -> Option<ParsedInvite> {
        Some(ParsedInvite { nonce: nonce.to_string(), kind })
    }

    /// Every expected value here was printed by `shared/src/invite.ts` itself.
    #[test]
    fn the_answers_the_original_gives() {
        let join = parsed(N, Some(InviteKind::Join));
        let claim = parsed(N, Some(InviteKind::Claim));
        let bare = parsed(N, None);
        let cases = [
            (format!("https://futsal-friday.pages.dev/join#{N}"), join.clone()),
            (format!("https://futsal-friday.pages.dev/claim#{N}"), claim.clone()),
            (N.to_string(), bare.clone()),
            // The link arrives mid-sentence, as it does in a group chat.
            (
                format!("join here lads https://futsal-friday.pages.dev/join#{N} see you friday"),
                join.clone(),
            ),
            // A trailing full stop is not part of the nonce.
            (format!("https://futsal-friday.pages.dev/join#{N}."), join.clone()),
            // Whatever the chat client added to the query is not either.
            (format!("https://futsal-friday.pages.dev/join?utm_source=chat#{N}"), join.clone()),
            (format!("  https://futsal-friday.pages.dev/claim#{N}  "), claim.clone()),
            // A path that names neither door leaves the caller to try both.
            (format!("https://example.test/somewhere#{N}"), bare.clone()),
            // `\b` after the word: `/joining` is a different path.
            (format!("https://x.test/joining#{N}"), bare.clone()),
            (format!("https://x.test/join_#{N}"), bare.clone()),
            // `join` is looked for first, wherever the two appear.
            (format!("https://x.test/claim/join#{N}"), join.clone()),
            // A bare code before a fragment: the fragment wins.
            (format!("{N}#{N}"), bare.clone()),
            (String::new(), None),
            ("   ".to_string(), None),
            ("hey can you send me the link".to_string(), None),
            ("abc123".to_string(), None),
            // A link whose fragment a client stripped carries nothing to recover.
            ("https://futsal-friday.pages.dev/join".to_string(), None),
            ("https://futsal-friday.pages.dev/join#".to_string(), None),
            ("a".repeat(19), None),
            ("a".repeat(20), parsed(&"a".repeat(20), None)),
        ];
        for (input, want) in cases {
            assert_eq!(parse_invite(&input), want, "parse_invite({input:?})");
        }
    }
}
