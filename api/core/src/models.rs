//! Domain models and request payloads, defined once and used on both sides of
//! the wire: the Worker parses inbound bodies with these, the frontend types its
//! fetch results from them.
//!
//! Ported from `shared/src/models.ts`. The TypeScript wrote each shape once, as
//! a zod schema, and read the type back out of it with `z.infer`. Rust has no
//! such trick, so each shape is written twice: the struct, and the validation
//! that produces it.
//!
//! The validation is a port, not a re-imagining. It reports the same issues, in
//! the same order, with the same message strings, because those strings are what
//! the API answers with — `validate()` in `http.ts` renders the *first* issue as
//! `path: message` and that is the body the app shows a person. Everything zod
//! decides is reproduced here: unknown keys are dropped rather than refused, a
//! `.default()` fills in for an absent key but not for an explicit `null`,
//! `.trim()` runs before the checks that follow it and its result is what comes
//! out, string lengths are counted in UTF-16 code units the way `String.length`
//! counts them, and a failed type check stops that field but not the ones after
//! it.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::i18n::Locale;

/* ------------------------------------------------------------ what went wrong */

/// One step of the path to an offending value: an object key, or an index into
/// an array.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Key(&'static str),
    Index(usize),
}

impl fmt::Display for Segment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Segment::Key(key) => f.write_str(key),
            Segment::Index(index) => write!(f, "{index}"),
        }
    }
}

/// One thing wrong with a body, in the shape zod reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub path: Vec<Segment>,
    pub message: String,
}

impl Issue {
    /// `issue.path.join('.')` — `overrides.0.memberId` for a nested one, and the
    /// empty string when the whole body is the problem.
    pub fn path_string(&self) -> String {
        self.path.iter().map(Segment::to_string).collect::<Vec<_>>().join(".")
    }
}

/// A rejected body, with every issue zod would have collected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    pub issues: Vec<Issue>,
}

impl ValidationError {
    /// What the API answers with: the first issue, named by its path.
    ///
    /// An error with no issues cannot happen — a failed parse always carries at
    /// least one — but the original kept a fallback for it and so does this.
    pub fn message(&self) -> String {
        match self.issues.first() {
            Some(issue) => {
                let path = issue.path_string();
                if path.is_empty() {
                    issue.message.clone()
                } else {
                    format!("{path}: {}", issue.message)
                }
            }
            None => "Invalid body".to_string(),
        }
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for ValidationError {}

/* ------------------------------------------------------------------- checks */

/// The checks a string schema was given, in the order it was given them —
/// `z.string().trim().min(1, 'Name is required').max(40)` is `[Trim, Min, Max]`.
/// Order is observable: every check that is not a type failure runs, and the
/// issues come out in this order.
#[derive(Debug, Clone, Copy)]
enum StrCheck {
    /// `.trim()`, which rewrites the value for every check after it and for the
    /// value that comes out.
    Trim,
    /// `.min(n)` or `.min(n, 'message')`.
    Min(usize, Option<&'static str>),
    Max(usize),
    /// `.regex(pattern, 'message')` — the pattern as a predicate, since the two
    /// this file needs are simpler to read spelled out than as a regex engine.
    Regex(&'static str, fn(&str) -> bool),
    /// `z.iso.datetime()`.
    Iso,
    /// `z.url()`, whose check also trims the value the way `new URL()` does.
    Url(&'static str),
}

/// The checks a number schema was given. Every one in this file starts with
/// `.int()`.
#[derive(Debug, Clone, Copy)]
enum NumCheck {
    Int,
    Min(i64),
    Max(i64),
}

/// What may stand in place of a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Presence {
    /// `z.thing()` — the key must be there and must not be null.
    Required,
    /// `.optional()` — an absent key is fine, an explicit null is not.
    Optional,
    /// `.nullable()` — null is fine, an absent key is not.
    Nullable,
    /// `.nullish()` — either.
    Nullish,
    /// `.default(x)` and `.optional().default(x)` — an absent key takes the
    /// default; an explicit null is still a type error, because a default only
    /// ever stands in for `undefined`.
    Defaulted,
    /// `.nullable().default(null)` — either, both meaning null.
    NullableDefault,
}

/// What the schema expected, for the message a wrong type gets.
#[derive(Debug, Clone, Copy)]
enum Expected {
    /// `Invalid input: expected string, received number`.
    Type(&'static str),
    /// `Invalid option: expected one of "en"|"my"` — an enum says this whatever
    /// arrived, including `undefined`.
    Option(&'static [&'static str]),
    /// A union that no branch could take: plain `Invalid input`.
    Union,
}

/// A value as the body actually had it.
enum Slot<T> {
    Absent,
    Null,
    Value(T),
}

impl<T> Slot<T> {
    /// A required field. Anything missing has already been reported, and the
    /// zero value stands in for it — the parse answers `Err`, and the
    /// half-built value is dropped without being read.
    fn required(self) -> T
    where
        T: Default,
    {
        match self {
            Slot::Value(value) => value,
            _ => T::default(),
        }
    }

    /// `.optional()` or `.nullable()`: one absence, spelled `None`.
    fn optional(self) -> Option<T> {
        match self {
            Slot::Value(value) => Some(value),
            _ => None,
        }
    }

    /// `.nullish()`: an absent key and an explicit null are different answers,
    /// and the routes that patch a record rely on the difference — an absent
    /// field leaves the column alone, a null clears it.
    fn nullish(self) -> Option<Option<T>> {
        match self {
            Slot::Absent => None,
            Slot::Null => Some(None),
            Slot::Value(value) => Some(Some(value)),
        }
    }

    /// `.default(x)`.
    fn or(self, fallback: T) -> T {
        match self {
            Slot::Value(value) => value,
            _ => fallback,
        }
    }
}

/* ------------------------------------------------------- the checks themselves */

/// `String.prototype.length` counts UTF-16 code units, so a name of 33 emoji is
/// 66 characters to `.max(64)` and is refused.
fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `String.prototype.trim`, which is not Rust's: JavaScript trims the BOM
/// (U+FEFF) and does not trim U+0085, and Rust's `char::is_whitespace` is the
/// other way round on both.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| {
        matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

/// The type name zod puts in `received …`.
fn received(value: Option<&Value>) -> &'static str {
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

fn expected_message(expected: Expected, got: &'static str) -> String {
    match expected {
        Expected::Type(name) => format!("Invalid input: expected {name}, received {got}"),
        Expected::Option(options) => {
            let choices = options.iter().map(|o| format!("\"{o}\"")).collect::<Vec<_>>().join("|");
            format!("Invalid option: expected one of {choices}")
        }
        Expected::Union => "Invalid input".to_string(),
    }
}

fn push_issue(issues: &mut Vec<Issue>, path: &[Segment], message: String) {
    issues.push(Issue { path: path.to_vec(), message });
}

/// `^\d{6}$` — the six digits VietQR addresses a bank by.
fn six_digits(text: &str) -> bool {
    text.len() == 6 && text.bytes().all(|b| b.is_ascii_digit())
}

/// `^[A-Za-z0-9]{4,19}$` — an account number as the banks write them.
fn account_number(text: &str) -> bool {
    (4..=19).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// How long a value is, and what zod calls it — because `.min()` and `.max()`
/// are not string checks. They run on anything that has a `.length`, *even after
/// the type check has already failed*, so an array handed to a string schema is
/// still measured, and it is measured in items rather than characters.
fn lengthable(value: &Value) -> Option<(usize, &'static str, &'static str)> {
    match value {
        Value::String(text) => Some((utf16_len(text), "string", "characters")),
        Value::Array(items) => Some((items.len(), "array", "items")),
        _ => None,
    }
}

fn too_small(min: usize, origin: &str, unit: &str) -> String {
    format!("Too small: expected {origin} to have >={min} {unit}")
}

fn too_big(max: usize, origin: &str, unit: &str) -> String {
    format!("Too big: expected {origin} to have <={max} {unit}")
}

/// Run one string schema's checks, answering the value they leave behind.
fn string_value(
    value: &Value,
    path: &[Segment],
    issues: &mut Vec<Issue>,
    checks: &[StrCheck],
) -> String {
    let Value::String(text) = value else {
        push_issue(issues, path, expected_message(Expected::Type("string"), received(Some(value))));
        // The length checks still have their say; everything else is skipped,
        // because a wrong type is an aborting issue and only these carry the
        // predicate that outlives it.
        if let Some((length, origin, unit)) = lengthable(value) {
            for check in checks {
                match *check {
                    StrCheck::Min(min, message) if length < min => {
                        let message = message
                            .map(str::to_string)
                            .unwrap_or_else(|| too_small(min, origin, unit));
                        push_issue(issues, path, message);
                    }
                    StrCheck::Max(max) if length > max => {
                        push_issue(issues, path, too_big(max, origin, unit));
                    }
                    _ => {}
                }
            }
        }
        return String::new();
    };
    let mut current = text.clone();
    for check in checks {
        match *check {
            StrCheck::Trim => current = js_trim(&current).to_string(),
            StrCheck::Min(min, message) => {
                if utf16_len(&current) < min {
                    let message = message
                        .map(str::to_string)
                        .unwrap_or_else(|| too_small(min, "string", "characters"));
                    push_issue(issues, path, message);
                }
            }
            StrCheck::Max(max) => {
                if utf16_len(&current) > max {
                    push_issue(issues, path, too_big(max, "string", "characters"));
                }
            }
            StrCheck::Regex(message, matches) => {
                if !matches(&current) {
                    push_issue(issues, path, message.to_string());
                }
            }
            StrCheck::Iso => {
                if !is_iso_datetime(&current) {
                    push_issue(issues, path, "Invalid ISO datetime".to_string());
                }
            }
            StrCheck::Url(message) => {
                // zod's URL check trims first and keeps the trimmed string,
                // which is what `.max()` after it then measures.
                let trimmed = current.trim().to_string();
                if !is_url(&trimmed) {
                    push_issue(issues, path, message.to_string());
                }
                current = trimmed;
            }
        }
    }
    current
}

/// Run one number schema's checks. Every number in this file is an integer, so
/// the answer is an `i64`; a value that failed the integer check is reported and
/// its stand-in never read.
fn number_value(
    value: &Value,
    path: &[Segment],
    issues: &mut Vec<Issue>,
    checks: &[NumCheck],
) -> i64 {
    let number = match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        other => {
            push_issue(
                issues,
                path,
                expected_message(Expected::Type("number"), received(Some(other))),
            );
            return 0;
        }
    };
    // `z.number()` refuses NaN and both infinities. JSON cannot carry them, but
    // a value built in code can.
    if !number.is_finite() {
        let got = if number.is_nan() { "NaN" } else { "number" };
        push_issue(issues, path, expected_message(Expected::Type("number"), got));
        return 0;
    }

    /// The largest integer a double can count to one by one: `Number.MAX_SAFE_INTEGER`.
    const SAFE: f64 = 9_007_199_254_740_991.0;

    for check in checks {
        match *check {
            NumCheck::Int => {
                if number.fract() != 0.0 {
                    // A fractional number is the wrong *type* to zod, and a
                    // wrong type stops the rest of this field's checks.
                    push_issue(
                        issues,
                        path,
                        "Invalid input: expected int, received number".to_string(),
                    );
                    return 0;
                }
                if number > SAFE {
                    push_issue(
                        issues,
                        path,
                        "Too big: expected int to be <=9007199254740991".to_string(),
                    );
                } else if number < -SAFE {
                    push_issue(
                        issues,
                        path,
                        "Too small: expected int to be >=-9007199254740991".to_string(),
                    );
                }
            }
            NumCheck::Min(min) => {
                if number < min as f64 {
                    push_issue(issues, path, format!("Too small: expected number to be >={min}"));
                }
            }
            NumCheck::Max(max) => {
                if number > max as f64 {
                    push_issue(issues, path, format!("Too big: expected number to be <={max}"));
                }
            }
        }
    }
    number as i64
}

fn boolean_value(value: &Value, path: &[Segment], issues: &mut Vec<Issue>) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        other => {
            push_issue(
                issues,
                path,
                expected_message(Expected::Type("boolean"), received(Some(other))),
            );
            false
        }
    }
}

fn enum_value<T: Default>(
    value: &Value,
    path: &[Segment],
    issues: &mut Vec<Issue>,
    options: &'static [&'static str],
    from_tag: fn(&str) -> Option<T>,
) -> T {
    if let Value::String(text) = value {
        if let Some(parsed) = from_tag(text) {
            return parsed;
        }
    }
    push_issue(issues, path, expected_message(Expected::Option(options), received(Some(value))));
    T::default()
}

/// `z.array(item).max(n)`: every element is checked first, in order, and the
/// length check comes after them.
fn array_value<T>(
    value: &Value,
    path: &[Segment],
    issues: &mut Vec<Issue>,
    max: Option<usize>,
    item: impl Fn(&Value, Vec<Segment>, &mut Vec<Issue>) -> T,
) -> Vec<T> {
    let Value::Array(values) = value else {
        push_issue(issues, path, expected_message(Expected::Type("array"), received(Some(value))));
        // As above, and the other way round: a string handed to an array schema
        // is measured by the array's own `.max()`, in characters.
        if let (Some(max), Some((length, origin, unit))) = (max, lengthable(value)) {
            if length > max {
                push_issue(issues, path, too_big(max, origin, unit));
            }
        }
        return Vec::new();
    };
    let out = values
        .iter()
        .enumerate()
        .map(|(index, element)| {
            let mut child = path.to_vec();
            child.push(Segment::Index(index));
            item(element, child, issues)
        })
        .collect();
    if let Some(max) = max {
        if values.len() > max {
            push_issue(issues, path, too_big(max, "array", "items"));
        }
    }
    out
}

/// `z.url('Must be a valid URL').max(500).nullish().or(z.literal(''))`.
///
/// The one union in the file, and its two branches answer differently. A string
/// that is not a URL fails the first branch and *aborts* the second (a literal
/// mismatch is an aborting issue), so zod surfaces the first branch's own
/// issues; anything that is not a string aborts both, and the union says
/// `Invalid input` with nothing more. The empty string is the whole point of the
/// second branch: the venue form posts one to mean "no map link".
fn map_url_value(value: &Value, path: &[Segment], issues: &mut Vec<Issue>) -> String {
    match value {
        Value::String(text) if text.is_empty() => String::new(),
        Value::String(_) => string_value(value, path, issues, MAP_URL_INPUT),
        _ => {
            push_issue(issues, path, expected_message(Expected::Union, received(Some(value))));
            String::new()
        }
    }
}

/* ------------------------------------------------------------ reading objects */

/// The keys of one object, and the issues found reading them.
struct Fields<'v, 'i> {
    /// `None` once the value turned out not to be an object at all, after which
    /// nothing more is reported: zod stops there too.
    object: Option<&'v Map<String, Value>>,
    path: Vec<Segment>,
    issues: &'i mut Vec<Issue>,
}

impl<'v, 'i> Fields<'v, 'i> {
    fn new(value: &'v Value, path: Vec<Segment>, issues: &'i mut Vec<Issue>) -> Self {
        let object = match value {
            Value::Object(map) => Some(map),
            other => {
                push_issue(
                    issues,
                    &path,
                    expected_message(Expected::Type("object"), received(Some(other))),
                );
                None
            }
        };
        Self { object, path, issues }
    }

    fn child(&self, key: &'static str) -> Vec<Segment> {
        let mut path = self.path.clone();
        path.push(Segment::Key(key));
        path
    }

    /// Resolve a key against the presence rules, reporting the type error zod
    /// would report and answering with whatever still needs checking.
    fn resolve(
        &mut self,
        key: &'static str,
        presence: Presence,
        expected: Expected,
    ) -> Slot<&'v Value> {
        let Some(object) = self.object else { return Slot::Absent };
        match object.get(key) {
            Some(Value::Null) => {
                let allowed = matches!(
                    presence,
                    Presence::Nullable | Presence::Nullish | Presence::NullableDefault
                );
                if !allowed {
                    let path = self.child(key);
                    push_issue(self.issues, &path, expected_message(expected, "null"));
                }
                Slot::Null
            }
            None => {
                let allowed = matches!(
                    presence,
                    Presence::Optional
                        | Presence::Nullish
                        | Presence::Defaulted
                        | Presence::NullableDefault
                );
                if !allowed {
                    let path = self.child(key);
                    push_issue(self.issues, &path, expected_message(expected, "undefined"));
                }
                Slot::Absent
            }
            Some(value) => Slot::Value(value),
        }
    }

    fn string(
        &mut self,
        key: &'static str,
        checks: &[StrCheck],
        presence: Presence,
    ) -> Slot<String> {
        match self.resolve(key, presence, Expected::Type("string")) {
            Slot::Value(value) => {
                let path = self.child(key);
                Slot::Value(string_value(value, &path, self.issues, checks))
            }
            Slot::Absent => Slot::Absent,
            Slot::Null => Slot::Null,
        }
    }

    fn number(&mut self, key: &'static str, checks: &[NumCheck], presence: Presence) -> Slot<i64> {
        match self.resolve(key, presence, Expected::Type("number")) {
            Slot::Value(value) => {
                let path = self.child(key);
                Slot::Value(number_value(value, &path, self.issues, checks))
            }
            Slot::Absent => Slot::Absent,
            Slot::Null => Slot::Null,
        }
    }

    fn boolean(&mut self, key: &'static str, presence: Presence) -> Slot<bool> {
        match self.resolve(key, presence, Expected::Type("boolean")) {
            Slot::Value(value) => {
                let path = self.child(key);
                Slot::Value(boolean_value(value, &path, self.issues))
            }
            Slot::Absent => Slot::Absent,
            Slot::Null => Slot::Null,
        }
    }

    fn enumeration<T: Default>(
        &mut self,
        key: &'static str,
        options: &'static [&'static str],
        from_tag: fn(&str) -> Option<T>,
        presence: Presence,
    ) -> Slot<T> {
        match self.resolve(key, presence, Expected::Option(options)) {
            Slot::Value(value) => {
                let path = self.child(key);
                Slot::Value(enum_value(value, &path, self.issues, options, from_tag))
            }
            Slot::Absent => Slot::Absent,
            Slot::Null => Slot::Null,
        }
    }

    fn object<T>(
        &mut self,
        key: &'static str,
        presence: Presence,
        read: impl Fn(&Value, Vec<Segment>, &mut Vec<Issue>) -> T,
    ) -> Slot<T> {
        match self.resolve(key, presence, Expected::Type("object")) {
            Slot::Value(value) => {
                let path = self.child(key);
                Slot::Value(read(value, path, self.issues))
            }
            Slot::Absent => Slot::Absent,
            Slot::Null => Slot::Null,
        }
    }

    fn array<T>(
        &mut self,
        key: &'static str,
        presence: Presence,
        max: Option<usize>,
        item: impl Fn(&Value, Vec<Segment>, &mut Vec<Issue>) -> T,
    ) -> Slot<Vec<T>> {
        match self.resolve(key, presence, Expected::Type("array")) {
            Slot::Value(value) => {
                let path = self.child(key);
                Slot::Value(array_value(value, &path, self.issues, max, item))
            }
            Slot::Absent => Slot::Absent,
            Slot::Null => Slot::Null,
        }
    }

    fn map_url(&mut self, key: &'static str, presence: Presence) -> Slot<String> {
        match self.resolve(key, presence, Expected::Union) {
            Slot::Value(value) => {
                let path = self.child(key);
                Slot::Value(map_url_value(value, &path, self.issues))
            }
            Slot::Absent => Slot::Absent,
            Slot::Null => Slot::Null,
        }
    }
}

/// Wrap a reader as the public entry point: the value, or every issue found.
macro_rules! parser {
    ($(#[$meta:meta])* $name:ident, $read:ident, $out:ty) => {
        $(#[$meta])*
        pub fn $name(value: &Value) -> Result<$out, ValidationError> {
            let mut issues = Vec::new();
            let parsed = $read(value, Vec::new(), &mut issues);
            if issues.is_empty() {
                Ok(parsed)
            } else {
                Err(ValidationError { issues })
            }
        }
    };
}

/// A string enum: the tags that cross the wire, and the parse zod's `z.enum`
/// does. The first variant doubles as the stand-in for a field that failed its
/// checks — see `Slot::required`.
macro_rules! tag_enum {
    (
        $(#[$meta:meta])*
        $name:ident { $first:ident => $first_tag:literal $(, $variant:ident => $tag:literal)* $(,)? }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "lowercase")]
        pub enum $name {
            $first,
            $($variant),*
        }

        impl $name {
            pub const OPTIONS: &'static [&'static str] = &[$first_tag $(, $tag)*];

            pub fn as_str(&self) -> &'static str {
                match self {
                    $name::$first => $first_tag,
                    $($name::$variant => $tag),*
                }
            }

            pub fn from_tag(tag: &str) -> Option<Self> {
                match tag {
                    $first_tag => Some($name::$first),
                    $($tag => Some($name::$variant),)*
                    _ => None,
                }
            }
        }

        impl Default for $name {
            fn default() -> Self {
                $name::$first
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

/* ---------------------------------------------------------- the two formats */

/// `z.iso.datetime()`: `YYYY-MM-DDTHH:MM[:SS[.fraction]]Z`.
///
/// Written out from the regex zod builds, which is stricter than it looks. The
/// year is exactly four digits, the `T` and the `Z` are upper case, seconds and
/// their fraction are optional but a lone `.` is not, no offset other than `Z`
/// is accepted, and the day is checked against the month — `2026-02-30` and
/// `2023-02-29` are both refused, `2024-02-29` is not.
pub fn is_iso_datetime(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 11 || !is_iso_date(&bytes[..10]) || bytes[10] != b'T' {
        return false;
    }
    let mut rest = &bytes[11..];

    // HH:MM, 00..23 and 00..59.
    if rest.len() < 5 {
        return false;
    }
    let hour_ok = match rest[0] {
        b'0' | b'1' => rest[1].is_ascii_digit(),
        b'2' => (b'0'..=b'3').contains(&rest[1]),
        _ => false,
    };
    if !hour_ok || rest[2] != b':' || !(b'0'..=b'5').contains(&rest[3]) || !rest[4].is_ascii_digit()
    {
        return false;
    }
    rest = &rest[5..];

    // Optional :SS, and then an optional fraction of at least one digit.
    if rest.first() == Some(&b':') {
        if rest.len() < 3 || !(b'0'..=b'5').contains(&rest[1]) || !rest[2].is_ascii_digit() {
            return false;
        }
        rest = &rest[3..];
        if rest.first() == Some(&b'.') {
            let digits = rest[1..].iter().take_while(|b| b.is_ascii_digit()).count();
            if digits == 0 {
                return false;
            }
            rest = &rest[1 + digits..];
        }
    }

    rest == b"Z"
}

fn is_iso_date(bytes: &[u8]) -> bool {
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes.iter().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit()) {
        return false;
    }
    let number = |from: usize, to: usize| -> u32 {
        bytes[from..to].iter().fold(0, |acc, b| acc * 10 + u32::from(b - b'0'))
    };
    let year = number(0, 4);
    let month = number(5, 7);
    let day = number(8, 10);
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let last = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    (1..=last).contains(&day)
}

/// Whether `new URL(value)` would succeed, which is all `z.url()` asks.
///
/// zod hands the string to the platform's URL parser, so what follows is the
/// WHATWG basic URL parser reduced to its failure conditions: a scheme is
/// required, a special scheme (`http`, `https`, `ws`, `wss`, `ftp`) needs a
/// host, a bracketed host must be a well-formed IPv6 literal, a host that ends
/// in a number is parsed as IPv4 and can fail there, a port must be digits and
/// at most 65535, and a host may not contain the forbidden code points. A
/// scheme it does not know (`mailto:`, `tel:`, `data:`) takes an opaque path and
/// cannot fail.
///
/// One place this is an approximation rather than a port: a browser runs the
/// full IDNA/UTS-46 tables over a decoded `xn--` label, and this refuses only
/// the labels that fail to decode or decode to control characters.
pub fn is_url(value: &str) -> bool {
    // The parser drops tab and newline anywhere in the input, then strips
    // leading and trailing C0 controls and spaces.
    let cleaned: String = value.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let input = cleaned.trim_matches(|c: char| c <= ' ');

    let Some(colon) = scheme_end(input) else { return false };
    let scheme = input[..colon].to_ascii_lowercase();
    let rest = &input[colon + 1..];
    let special = matches!(scheme.as_str(), "ftp" | "file" | "http" | "https" | "ws" | "wss");

    if !special {
        // An opaque path — anything at all — unless it opens an authority.
        let Some(authority) = rest.strip_prefix("//") else { return true };
        return authority_ok(authority, false, true);
    }
    // A special scheme tolerates any number of slashes: `http:example.com` and
    // `https:/path` both name a host. `file` is the one that may have none.
    let authority = rest.trim_start_matches(['/', '\\']);
    authority_ok(authority, true, scheme == "file")
}

/// The `:` that ends the scheme, if the text up to it is one.
fn scheme_end(input: &str) -> Option<usize> {
    let bytes = input.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return None;
    }
    for (i, b) in bytes.iter().enumerate() {
        match b {
            b':' => return Some(i),
            b if b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.') => continue,
            _ => return None,
        }
    }
    None
}

fn authority_ok(rest: &str, special: bool, host_may_be_empty: bool) -> bool {
    let delimiters: &[char] = if special { &['/', '\\', '?', '#'] } else { &['/', '?', '#'] };
    let end = rest.find(delimiters).unwrap_or(rest.len());
    let authority = &rest[..end];
    // Everything up to the last `@` is credentials, and they cannot fail.
    let host_port = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };

    let (host, port) = split_port(host_port);
    if let Some(port) = port {
        if !port.is_empty()
            && (!port.bytes().all(|b| b.is_ascii_digit())
                || port.parse::<u32>().map(|p| p > 65_535).unwrap_or(true))
        {
            return false;
        }
    }
    if host.is_empty() {
        return host_may_be_empty;
    }
    if let Some(inner) = host.strip_prefix('[') {
        return match inner.strip_suffix(']') {
            Some(address) => is_ipv6(address),
            None => false,
        };
    }
    if !special {
        // An opaque host: only the forbidden code points can fail it.
        return !host.chars().any(is_forbidden_host);
    }
    let decoded = percent_decode(host);
    if decoded.chars().any(is_forbidden_domain) {
        return false;
    }
    for label in decoded.split('.') {
        let punycode = label
            .strip_prefix("xn--")
            .or_else(|| label.strip_prefix("XN--"))
            .or_else(|| label.strip_prefix("Xn--"))
            .or_else(|| label.strip_prefix("xN--"));
        if let Some(punycode) = punycode {
            if !punycode_ok(punycode) {
                return false;
            }
        }
    }
    if ends_in_a_number(&decoded) {
        return parse_ipv4(&decoded);
    }
    true
}

/// Split `host:port`, leaving a bracketed IPv6 literal alone.
fn split_port(host_port: &str) -> (&str, Option<&str>) {
    let from = match host_port.find(']') {
        Some(bracket) => bracket,
        None => 0,
    };
    match host_port[from..].find(':') {
        Some(colon) => (&host_port[..from + colon], Some(&host_port[from + colon + 1..])),
        None => (host_port, None),
    }
}

/// The forbidden host code points, as the URL standard lists them.
const FORBIDDEN_HOST: [char; 17] =
    ['\u{0}', '\t', '\n', '\r', ' ', '#', '/', ':', '<', '>', '?', '@', '[', '\\', ']', '^', '|'];

fn is_forbidden_host(c: char) -> bool {
    FORBIDDEN_HOST.contains(&c)
}

/// A domain may not hold what an opaque host may not, and also no `%`, no C0
/// control and no delete — the percent-decoding has already happened by then, so
/// `%20` arrives here as a space.
fn is_forbidden_domain(c: char) -> bool {
    is_forbidden_host(c) || c == '%' || c <= '\u{1f}' || c == '\u{7f}'
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap_or(0));
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether the host's last label is a number, which is what sends a host down
/// the IPv4 path instead of being read as a domain.
fn ends_in_a_number(host: &str) -> bool {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 1 && parts.last() == Some(&"") {
        parts.pop();
    }
    let Some(last) = parts.last() else { return false };
    if last.is_empty() {
        return false;
    }
    if last.bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    ipv4_number(last).is_some()
}

/// One dotted part, in the radix its prefix asks for: `0x` is hex, a leading
/// zero is octal, anything else is decimal.
fn ipv4_number(part: &str) -> Option<u64> {
    if part.is_empty() {
        return None;
    }
    let (radix, digits) = if part.len() >= 2 && (part.starts_with("0x") || part.starts_with("0X")) {
        (16, &part[2..])
    } else if part.len() >= 2 && part.starts_with('0') {
        (8, &part[1..])
    } else {
        (10, part)
    };
    if digits.is_empty() {
        // `0x` on its own is zero.
        return Some(0);
    }
    if !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    u64::from_str_radix(digits, radix).ok()
}

fn parse_ipv4(host: &str) -> bool {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 1 && parts.last() == Some(&"") {
        parts.pop();
    }
    if parts.len() > 4 {
        return false;
    }
    let mut numbers = Vec::with_capacity(parts.len());
    for part in parts {
        match ipv4_number(part) {
            Some(number) => numbers.push(number),
            None => return false,
        }
    }
    let count = numbers.len();
    if numbers[..count - 1].iter().any(|n| *n > 255) {
        return false;
    }
    // The last part fills whatever is left of the 32 bits.
    numbers[count - 1] < 256u64.pow(5 - count as u32)
}

fn is_ipv6(input: &str) -> bool {
    let mut text = input.to_string();
    if let Some(dot) = text.find('.') {
        // The dotted tail starts after the last `:` before the first dot.
        let Some(colon) = text[..dot].rfind(':') else { return false };
        if !is_ipv4_literal(&text[colon + 1..]) {
            return false;
        }
        // Two hex pieces stand for the four bytes just checked.
        text.replace_range(colon + 1.., "0:0");
    }
    let compressed = text.matches("::").count();
    if compressed > 1 {
        return false;
    }
    let piece = |p: &&str| (1..=4).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_hexdigit());
    if compressed == 1 {
        let (left, right) = text.split_once("::").unwrap();
        let left: Vec<&str> = if left.is_empty() { Vec::new() } else { left.split(':').collect() };
        let right: Vec<&str> =
            if right.is_empty() { Vec::new() } else { right.split(':').collect() };
        // `::` stands for at least one piece of zeroes.
        return left.len() + right.len() <= 7 && left.iter().chain(right.iter()).all(piece);
    }
    let pieces: Vec<&str> = text.split(':').collect();
    pieces.len() == 8 && pieces.iter().all(piece)
}

fn is_ipv4_literal(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|part| {
        !part.is_empty()
            && part.len() <= 3
            && part.bytes().all(|b| b.is_ascii_digit())
            && (part.len() == 1 || !part.starts_with('0'))
            && part.parse::<u32>().map(|n| n <= 255).unwrap_or(false)
    })
}

/// RFC 3492 decoding of an `xn--` label, for whether it decodes at all.
fn punycode_ok(label: &str) -> bool {
    const BASE: u32 = 36;
    const TMIN: u32 = 1;
    const TMAX: u32 = 26;
    const SKEW: u32 = 38;
    const DAMP: u32 = 700;
    const INITIAL_BIAS: u32 = 72;
    const INITIAL_N: u32 = 128;

    fn adapt(delta: u32, count: u32, first: bool) -> u32 {
        let mut delta = if first { delta / DAMP } else { delta / 2 };
        delta += delta / count;
        let mut k = 0;
        while delta > ((BASE - TMIN) * TMAX) / 2 {
            delta /= BASE - TMIN;
            k += BASE;
        }
        k + (((BASE - TMIN + 1) * delta) / (delta + SKEW))
    }

    let (basic, extended) = match label.rfind('-') {
        Some(index) => (&label[..index], &label[index + 1..]),
        None => ("", label),
    };
    if !basic.is_ascii() {
        return false;
    }
    let mut output: Vec<char> = basic.chars().collect();
    let mut n = INITIAL_N;
    let mut i: u32 = 0;
    let mut bias = INITIAL_BIAS;
    let mut chars = extended.chars().peekable();
    while chars.peek().is_some() {
        let old_i = i;
        let mut weight: u32 = 1;
        let mut k = BASE;
        loop {
            let Some(c) = chars.next() else { return false };
            let digit = match c {
                'a'..='z' => c as u32 - 'a' as u32,
                'A'..='Z' => c as u32 - 'A' as u32,
                '0'..='9' => c as u32 - '0' as u32 + 26,
                _ => return false,
            };
            let Some(step) = digit.checked_mul(weight) else { return false };
            let Some(next) = i.checked_add(step) else { return false };
            i = next;
            let t = if k <= bias {
                TMIN
            } else if k >= bias + TMAX {
                TMAX
            } else {
                k - bias
            };
            if digit < t {
                break;
            }
            let Some(grown) = weight.checked_mul(BASE - t) else { return false };
            weight = grown;
            k += BASE;
        }
        let count = output.len() as u32 + 1;
        bias = adapt(i - old_i, count, old_i == 0);
        n += i / count;
        i %= count;
        let Some(decoded) = char::from_u32(n) else { return false };
        // The full IDNA validity tables live in a browser; a control character
        // is the part of them that a decodable-but-invalid label hits.
        if decoded.is_control() || is_forbidden_domain(decoded) {
            return false;
        }
        output.insert(i as usize, decoded);
        i += 1;
    }
    !output.is_empty()
}

/* ------------------------------------------------------------- the schemas */

/// `z.string().min(1).max(64)`.
const ID: &[StrCheck] = &[StrCheck::Min(1, None), StrCheck::Max(64)];
/// `z.iso.datetime()` — an ISO-8601 UTC instant. Every timestamp in the API is
/// one of these.
const ISO: &[StrCheck] = &[StrCheck::Iso];
/// `z.string()` with nothing asked of it.
const FREE_TEXT: &[StrCheck] = &[];

/// `z.number().int().min(0).max(1_000_000_000)` — non-negative integer dong.
const VND: &[NumCheck] = &[NumCheck::Int, NumCheck::Min(0), NumCheck::Max(1_000_000_000)];
/// `z.number().int()`.
const INT: &[NumCheck] = &[NumCheck::Int];
/// `z.number().int().min(0)`.
const COUNT: &[NumCheck] = &[NumCheck::Int, NumCheck::Min(0)];
/// `z.number().int().min(0).max(5)` — guests, and the guest index in a team slot.
const GUESTS: &[NumCheck] = &[NumCheck::Int, NumCheck::Min(0), NumCheck::Max(5)];
/// `matchGoalsSchema`, and a player's own tally: `z.number().int().min(0).max(30)`.
///
/// A scoreline nobody is going to exceed in a friendly. Past this is a typo. The
/// same ceiling the score stepper stops at, so a number the UI cannot produce is
/// also a number the API will not take.
const GOALS: &[NumCheck] = &[NumCheck::Int, NumCheck::Min(0), NumCheck::Max(30)];
/// `z.number().int().min(1).max(60)`.
const MAX_PLAYERS: &[NumCheck] = &[NumCheck::Int, NumCheck::Min(1), NumCheck::Max(60)];
/// `z.number().int().min(MIN_TEAMS).max(MAX_TEAMS)`.
const TEAM_COUNT: &[NumCheck] =
    &[NumCheck::Int, NumCheck::Min(MIN_TEAMS), NumCheck::Max(MAX_TEAMS)];
/// A position in the fixture: `z.number().int().min(0).max(MAX_TEAMS - 1)`.
const TEAM_INDEX: &[NumCheck] = &[NumCheck::Int, NumCheck::Min(0), NumCheck::Max(MAX_TEAMS - 1)];
/// `z.number().int().min(1).max(100_000)` — the rounding grain; 1 disables it.
const GRANULARITY: &[NumCheck] = &[NumCheck::Int, NumCheck::Min(1), NumCheck::Max(100_000)];

const MEMBER_NAME: &[StrCheck] = &[StrCheck::Min(1, None), StrCheck::Max(40)];
const NAME_INPUT: &[StrCheck] =
    &[StrCheck::Trim, StrCheck::Min(1, Some("Name is required")), StrCheck::Max(40)];
const NAME_PATCH: &[StrCheck] = &[StrCheck::Trim, StrCheck::Min(1, None), StrCheck::Max(40)];
const ENDPOINT: &[StrCheck] = &[StrCheck::Url("Invalid URL"), StrCheck::Max(500)];
const P256DH: &[StrCheck] = &[StrCheck::Min(1, None), StrCheck::Max(200)];
const AUTH: &[StrCheck] = &[StrCheck::Min(1, None), StrCheck::Max(100)];
/// The NAPAS acquirer id; the six digits VietQR addresses a bank by.
const BANK_BIN: &[StrCheck] = &[StrCheck::Regex("Pick a bank", six_digits)];
const BANK_NAME: &[StrCheck] = &[StrCheck::Min(1, None), StrCheck::Max(60)];
const ACCOUNT_NUMBER: &[StrCheck] = &[
    StrCheck::Trim,
    StrCheck::Regex("Account number should be 4-19 letters or digits", account_number),
];
const ACCOUNT_NAME: &[StrCheck] =
    &[StrCheck::Trim, StrCheck::Min(1, Some("Who the account belongs to")), StrCheck::Max(60)];
const PAYMENT_DETAILS_NOTE: &[StrCheck] = &[StrCheck::Trim, StrCheck::Max(160)];
const VENUE_NAME: &[StrCheck] = &[StrCheck::Min(1, None), StrCheck::Max(80)];
const VENUE_NAME_INPUT: &[StrCheck] =
    &[StrCheck::Trim, StrCheck::Min(1, Some("Venue name is required")), StrCheck::Max(80)];
const ADDRESS: &[StrCheck] = &[StrCheck::Max(200)];
const ADDRESS_INPUT: &[StrCheck] = &[StrCheck::Trim, StrCheck::Max(200)];
const MAP_URL: &[StrCheck] = &[StrCheck::Url("Invalid URL"), StrCheck::Max(500)];
/// The first branch of `createVenueSchema.mapUrl`, which was given its own
/// message; the second branch is the bare empty string.
const MAP_URL_INPUT: &[StrCheck] = &[StrCheck::Url("Must be a valid URL"), StrCheck::Max(500)];
const PRICE_NOTE: &[StrCheck] = &[StrCheck::Max(120)];
const PRICE_NOTE_INPUT: &[StrCheck] = &[StrCheck::Trim, StrCheck::Max(120)];
const SESSION_NOTES: &[StrCheck] = &[StrCheck::Max(500)];
const SESSION_NOTES_INPUT: &[StrCheck] = &[StrCheck::Trim, StrCheck::Max(500)];
const MESSAGE_BODY: &[StrCheck] = &[StrCheck::Min(1, None), StrCheck::Max(MAX_MESSAGE_LENGTH)];
const MESSAGE_BODY_INPUT: &[StrCheck] =
    &[StrCheck::Trim, StrCheck::Min(1, Some("Say something")), StrCheck::Max(MAX_MESSAGE_LENGTH)];
const PAYMENT_TEXT: &[StrCheck] = &[StrCheck::Max(300)];
const PROOF_KEY: &[StrCheck] = &[StrCheck::Max(200)];
const PAYMENT_TEXT_INPUT: &[StrCheck] = &[StrCheck::Trim, StrCheck::Max(300)];
const NONCE: &[StrCheck] = &[StrCheck::Min(20, None), StrCheck::Max(100)];
/// `groupSelfAddSchema` asks for no ceiling, unlike every other nonce.
const NONCE_NO_MAX: &[StrCheck] = &[StrCheck::Min(20, None)];

/// `z.enum(['en', 'my'])`, whose inferred type is the app's `Locale`.
const LANGUAGE: &[&str] = &["en", "my"];

fn language_from_tag(tag: &str) -> Option<Locale> {
    match tag {
        "en" => Some(Locale::En),
        "my" => Some(Locale::My),
        _ => None,
    }
}

/* ------------------------------------------------------------------ member */

/// A person on the roster.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub name: String,
    pub is_organizer: bool,
    /// The soft delete: people who have left stay on their old sessions.
    pub active: bool,
    pub created_at: String,
    /// When this identity was first claimed via a link; null if nobody has.
    pub claimed_at: Option<String>,
    /// True while an unspent claim link is outstanding for this member.
    pub has_pending_link: bool,
    /// Reminder preferences; only meaningful once push is granted on a device.
    pub notify_session: bool,
    pub notify_payment: bool,
    /// Drives the UI and, crucially, server-written push notifications.
    pub language: Locale,
    /// Their clock, for the same two reasons.
    pub hour12: bool,
    /// When the profile picture last changed, or null if there is none. The R2
    /// key stays server-side; this is what the client caches the image against.
    pub avatar_updated_at: Option<String>,
    /// When an organizer let them in. Null means they added themselves from the
    /// group link and are still waiting — a different thing from `active`.
    pub approved_at: Option<String>,
}

fn read_member(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> Member {
    let mut f = Fields::new(value, path, issues);
    Member {
        id: f.string("id", ID, Presence::Required).required(),
        name: f.string("name", MEMBER_NAME, Presence::Required).required(),
        is_organizer: f.boolean("isOrganizer", Presence::Required).required(),
        active: f.boolean("active", Presence::Required).required(),
        created_at: f.string("createdAt", ISO, Presence::Required).required(),
        claimed_at: f.string("claimedAt", ISO, Presence::Nullable).optional(),
        has_pending_link: f.boolean("hasPendingLink", Presence::Required).required(),
        notify_session: f.boolean("notifySession", Presence::Defaulted).or(true),
        notify_payment: f.boolean("notifyPayment", Presence::Defaulted).or(true),
        language: f
            .enumeration("language", LANGUAGE, language_from_tag, Presence::Defaulted)
            .or(Locale::En),
        hour12: f.boolean("hour12", Presence::Defaulted).or(false),
        avatar_updated_at: f.string("avatarUpdatedAt", ISO, Presence::NullableDefault).optional(),
        approved_at: f.string("approvedAt", ISO, Presence::NullableDefault).optional(),
    }
}

parser!(parse_member, read_member, Member);

/// Attendance run, computed from every past session since the member joined.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct StreakStats {
    pub current: i64,
    pub best: i64,
    pub played: i64,
    pub total: i64,
}

fn read_streak(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> StreakStats {
    let mut f = Fields::new(value, path, issues);
    StreakStats {
        current: f.number("current", COUNT, Presence::Required).required(),
        best: f.number("best", COUNT, Presence::Required).required(),
        played: f.number("played", COUNT, Presence::Required).required(),
        total: f.number("total", COUNT, Presence::Required).required(),
    }
}

parser!(parse_streak, read_streak, StreakStats);

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberProfile {
    pub member: Member,
    pub streak: StreakStats,
    /// Goals across every game they have played.
    pub goals: i64,
    /// Games the group voted them the best in.
    pub mvps: i64,
    /// Still owed across every session, so a profile shows the whole picture.
    pub outstanding: i64,
}

fn read_member_profile(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> MemberProfile {
    let mut f = Fields::new(value, path, issues);
    MemberProfile {
        member: f.object("member", Presence::Required, read_member).required(),
        streak: f.object("streak", Presence::Required, read_streak).required(),
        goals: f.number("goals", COUNT, Presence::Defaulted).or(0),
        mvps: f.number("mvps", COUNT, Presence::Defaulted).or(0),
        outstanding: f.number("outstanding", COUNT, Presence::Required).required(),
    }
}

parser!(parse_member_profile, read_member_profile, MemberProfile);

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMemberInput {
    pub name: String,
    pub is_organizer: bool,
}

fn read_create_member(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> CreateMemberInput {
    let mut f = Fields::new(value, path, issues);
    CreateMemberInput {
        name: f.string("name", NAME_INPUT, Presence::Required).required(),
        is_organizer: f.boolean("isOrganizer", Presence::Defaulted).or(false),
    }
}

parser!(parse_create_member, read_create_member, CreateMemberInput);

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemberInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_organizer: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
}

fn read_update_member(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> UpdateMemberInput {
    let mut f = Fields::new(value, path, issues);
    UpdateMemberInput {
        name: f.string("name", NAME_PATCH, Presence::Optional).optional(),
        is_organizer: f.boolean("isOrganizer", Presence::Optional).optional(),
        active: f.boolean("active", Presence::Optional).optional(),
    }
}

parser!(parse_update_member, read_update_member, UpdateMemberInput);

/// A member may change only their own reminder preferences and language.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPrefsInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify_session: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify_payment: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<Locale>,
    /// True for "7:30 PM", false for "19:30". Follows them onto a new phone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hour12: Option<bool>,
}

fn read_notification_prefs(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> NotificationPrefsInput {
    let mut f = Fields::new(value, path, issues);
    NotificationPrefsInput {
        notify_session: f.boolean("notifySession", Presence::Optional).optional(),
        notify_payment: f.boolean("notifyPayment", Presence::Optional).optional(),
        language: f
            .enumeration("language", LANGUAGE, language_from_tag, Presence::Optional)
            .optional(),
        hour12: f.boolean("hour12", Presence::Optional).optional(),
    }
}

parser!(parse_notification_prefs, read_notification_prefs, NotificationPrefsInput);

/* --------------------------------------------------------------- web push */

/// Exactly what `PushSubscription.toJSON()` produces in the browser.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct PushSubscriptionInput {
    pub endpoint: String,
    pub keys: PushKeys,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct PushKeys {
    pub p256dh: String,
    pub auth: String,
}

fn read_push_keys(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> PushKeys {
    let mut f = Fields::new(value, path, issues);
    PushKeys {
        p256dh: f.string("p256dh", P256DH, Presence::Required).required(),
        auth: f.string("auth", AUTH, Presence::Required).required(),
    }
}

fn read_push_subscription(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> PushSubscriptionInput {
    let mut f = Fields::new(value, path, issues);
    PushSubscriptionInput {
        endpoint: f.string("endpoint", ENDPOINT, Presence::Required).required(),
        keys: f.object("keys", Presence::Required, read_push_keys).required(),
    }
}

parser!(parse_push_subscription, read_push_subscription, PushSubscriptionInput);

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushStatus {
    /// False when the server has no VAPID keys; the UI hides the toggle.
    pub enabled: bool,
    /// Application server key the browser needs to subscribe.
    pub public_key: Option<String>,
    /// How many devices this member currently has reminders on.
    pub devices: i64,
    pub notify_session: bool,
    pub notify_payment: bool,
    pub language: Locale,
    pub hour12: bool,
}

fn read_push_status(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> PushStatus {
    let mut f = Fields::new(value, path, issues);
    PushStatus {
        enabled: f.boolean("enabled", Presence::Required).required(),
        public_key: f.string("publicKey", FREE_TEXT, Presence::Nullable).optional(),
        devices: f.number("devices", INT, Presence::Required).required(),
        notify_session: f.boolean("notifySession", Presence::Required).required(),
        notify_payment: f.boolean("notifyPayment", Presence::Required).required(),
        language: f
            .enumeration("language", LANGUAGE, language_from_tag, Presence::Required)
            .required(),
        hour12: f.boolean("hour12", Presence::Defaulted).or(false),
    }
}

parser!(parse_push_status, read_push_status, PushStatus);

/* --------------------------------------------------------- payment details */

/// Where the group sends money. One per group, set by an organizer.
///
/// Not a secret — an account number and a name are what would otherwise be
/// pasted into the chat every week, and the point is that anyone can look them
/// up without asking. Still behind sign-in.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentDetails {
    pub bank_bin: String,
    pub bank_name: String,
    pub account_number: String,
    pub account_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<Option<String>>,
    pub updated_at: String,
}

fn read_payment_details(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> PaymentDetails {
    let mut f = Fields::new(value, path, issues);
    PaymentDetails {
        bank_bin: f.string("bankBin", BANK_BIN, Presence::Required).required(),
        bank_name: f.string("bankName", BANK_NAME, Presence::Required).required(),
        account_number: f.string("accountNumber", ACCOUNT_NUMBER, Presence::Required).required(),
        account_name: f.string("accountName", ACCOUNT_NAME, Presence::Required).required(),
        note: f.string("note", PAYMENT_DETAILS_NOTE, Presence::Nullish).nullish(),
        updated_at: f.string("updatedAt", ISO, Presence::Required).required(),
    }
}

parser!(parse_payment_details, read_payment_details, PaymentDetails);

/// `paymentDetailsSchema.omit({ updatedAt: true })`.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePaymentDetailsInput {
    pub bank_bin: String,
    pub bank_name: String,
    pub account_number: String,
    pub account_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<Option<String>>,
}

fn read_save_payment_details(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> SavePaymentDetailsInput {
    let mut f = Fields::new(value, path, issues);
    SavePaymentDetailsInput {
        bank_bin: f.string("bankBin", BANK_BIN, Presence::Required).required(),
        bank_name: f.string("bankName", BANK_NAME, Presence::Required).required(),
        account_number: f.string("accountNumber", ACCOUNT_NUMBER, Presence::Required).required(),
        account_name: f.string("accountName", ACCOUNT_NAME, Presence::Required).required(),
        note: f.string("note", PAYMENT_DETAILS_NOTE, Presence::Nullish).nullish(),
    }
}

parser!(parse_save_payment_details, read_save_payment_details, SavePaymentDetailsInput);

/* ------------------------------------------------------------------- venue */

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Venue {
    pub id: String,
    pub name: String,
    pub address: Option<String>,
    pub map_url: Option<String>,
    pub price_note: Option<String>,
    pub active: bool,
    pub created_at: String,
}

fn read_venue(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> Venue {
    let mut f = Fields::new(value, path, issues);
    Venue {
        id: f.string("id", ID, Presence::Required).required(),
        name: f.string("name", VENUE_NAME, Presence::Required).required(),
        address: f.string("address", ADDRESS, Presence::Nullable).optional(),
        map_url: f.string("mapUrl", MAP_URL, Presence::Nullable).optional(),
        price_note: f.string("priceNote", PRICE_NOTE, Presence::Nullable).optional(),
        active: f.boolean("active", Presence::Required).required(),
        created_at: f.string("createdAt", ISO, Presence::Required).required(),
    }
}

parser!(parse_venue, read_venue, Venue);

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVenueInput {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<Option<String>>,
    /// The empty string is explicitly accepted here, and the venue route reads
    /// it as "no map link".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map_url: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_note: Option<Option<String>>,
}

fn read_create_venue(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> CreateVenueInput {
    let mut f = Fields::new(value, path, issues);
    CreateVenueInput {
        name: f.string("name", VENUE_NAME_INPUT, Presence::Required).required(),
        address: f.string("address", ADDRESS_INPUT, Presence::Nullish).nullish(),
        map_url: f.map_url("mapUrl", Presence::Nullish).nullish(),
        price_note: f.string("priceNote", PRICE_NOTE_INPUT, Presence::Nullish).nullish(),
    }
}

parser!(parse_create_venue, read_create_venue, CreateVenueInput);

/// `createVenueSchema.partial().extend({ active: z.boolean().optional() })`.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateVenueInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map_url: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_note: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
}

fn read_update_venue(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> UpdateVenueInput {
    let mut f = Fields::new(value, path, issues);
    UpdateVenueInput {
        name: f.string("name", VENUE_NAME_INPUT, Presence::Optional).optional(),
        address: f.string("address", ADDRESS_INPUT, Presence::Nullish).nullish(),
        map_url: f.map_url("mapUrl", Presence::Nullish).nullish(),
        price_note: f.string("priceNote", PRICE_NOTE_INPUT, Presence::Nullish).nullish(),
        active: f.boolean("active", Presence::Optional).optional(),
    }
}

parser!(parse_update_venue, read_update_venue, UpdateVenueInput);

/* ----------------------------------------------------------------- session */

tag_enum! {
    SessionStatus {
        Scheduled => "scheduled",
        Cancelled => "cancelled",
        Completed => "completed",
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub starts_at: String,
    pub venue_id: Option<String>,
    pub venue: Option<Venue>,
    pub status: SessionStatus,
    /// Organizer's up-front estimate, shown before the session is settled.
    pub fee_per_person: Option<i64>,
    /// Actual charge, entered after the session. Drives the payment split.
    pub total_charge: Option<i64>,
    pub max_players: Option<i64>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn read_session(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> Session {
    let mut f = Fields::new(value, path, issues);
    Session {
        id: f.string("id", ID, Presence::Required).required(),
        starts_at: f.string("startsAt", ISO, Presence::Required).required(),
        venue_id: f.string("venueId", ID, Presence::Nullable).optional(),
        venue: f.object("venue", Presence::Nullable, read_venue).optional(),
        status: f
            .enumeration(
                "status",
                SessionStatus::OPTIONS,
                SessionStatus::from_tag,
                Presence::Required,
            )
            .required(),
        fee_per_person: f.number("feePerPerson", VND, Presence::Nullable).optional(),
        total_charge: f.number("totalCharge", VND, Presence::Nullable).optional(),
        max_players: f.number("maxPlayers", MAX_PLAYERS, Presence::Nullable).optional(),
        notes: f.string("notes", SESSION_NOTES, Presence::Nullable).optional(),
        created_at: f.string("createdAt", ISO, Presence::Required).required(),
        updated_at: f.string("updatedAt", ISO, Presence::Required).required(),
    }
}

parser!(parse_session, read_session, Session);

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionInput {
    pub starts_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub venue_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_per_person: Option<Option<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_players: Option<Option<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<Option<String>>,
}

fn read_create_session(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> CreateSessionInput {
    let mut f = Fields::new(value, path, issues);
    CreateSessionInput {
        starts_at: f.string("startsAt", ISO, Presence::Required).required(),
        venue_id: f.string("venueId", ID, Presence::Nullish).nullish(),
        fee_per_person: f.number("feePerPerson", VND, Presence::Nullish).nullish(),
        max_players: f.number("maxPlayers", MAX_PLAYERS, Presence::Nullish).nullish(),
        notes: f.string("notes", SESSION_NOTES_INPUT, Presence::Nullish).nullish(),
    }
}

parser!(parse_create_session, read_create_session, CreateSessionInput);

/// `createSessionSchema.partial().extend({ status: sessionStatusSchema.optional() })`.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starts_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub venue_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_per_person: Option<Option<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_players: Option<Option<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<SessionStatus>,
}

fn read_update_session(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> UpdateSessionInput {
    let mut f = Fields::new(value, path, issues);
    UpdateSessionInput {
        starts_at: f.string("startsAt", ISO, Presence::Optional).optional(),
        venue_id: f.string("venueId", ID, Presence::Nullish).nullish(),
        fee_per_person: f.number("feePerPerson", VND, Presence::Nullish).nullish(),
        max_players: f.number("maxPlayers", MAX_PLAYERS, Presence::Nullish).nullish(),
        notes: f.string("notes", SESSION_NOTES_INPUT, Presence::Nullish).nullish(),
        status: f
            .enumeration(
                "status",
                SessionStatus::OPTIONS,
                SessionStatus::from_tag,
                Presence::Optional,
            )
            .optional(),
    }
}

parser!(parse_update_session, read_update_session, UpdateSessionInput);

/* ------------------------------------------------------------ registration */

tag_enum! {
    RegistrationStatus {
        In => "in",
        Waitlist => "waitlist",
    }
}

/// Sign up, optionally bringing friends.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterInput {
    pub guests: i64,
}

fn read_register(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> RegisterInput {
    let mut f = Fields::new(value, path, issues);
    RegisterInput { guests: f.number("guests", GUESTS, Presence::Defaulted).or(0) }
}

parser!(parse_register, read_register, RegisterInput);

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub id: String,
    pub session_id: String,
    pub member_id: String,
    pub member_name: String,
    /// Cache token for the member's picture; null when they have none.
    pub member_avatar_updated_at: Option<String>,
    /// Friends brought along who have no account. They take spots and cost
    /// money; this member answers for both.
    pub guests: i64,
    pub status: RegistrationStatus,
    /// Whether they actually turned up. `None` means nobody has said, which is
    /// read as present for `in` and absent for `waitlist` — see `attendance`.
    /// Kept distinct from `Some(false)` so the settle screen can tell an
    /// unchecked roster from a confirmed one.
    pub attended: Option<bool>,
    /// How many guests came. `None` means "as registered", not none.
    pub guests_arrived: Option<i64>,
    /// Goals they scored in this game. Self-reported after the whistle.
    pub goals: i64,
    /// Monotonic per session; defines display order and waitlist promotion order.
    pub position: i64,
    pub created_at: String,
}

fn read_registration(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> Registration {
    let mut f = Fields::new(value, path, issues);
    Registration {
        id: f.string("id", ID, Presence::Required).required(),
        session_id: f.string("sessionId", ID, Presence::Required).required(),
        member_id: f.string("memberId", ID, Presence::Required).required(),
        member_name: f.string("memberName", FREE_TEXT, Presence::Required).required(),
        member_avatar_updated_at: f
            .string("memberAvatarUpdatedAt", ISO, Presence::NullableDefault)
            .optional(),
        guests: f.number("guests", GUESTS, Presence::Defaulted).or(0),
        status: f
            .enumeration(
                "status",
                RegistrationStatus::OPTIONS,
                RegistrationStatus::from_tag,
                Presence::Required,
            )
            .required(),
        attended: f.boolean("attended", Presence::NullableDefault).optional(),
        guests_arrived: f.number("guestsArrived", GUESTS, Presence::NullableDefault).optional(),
        goals: f.number("goals", GOALS, Presence::Defaulted).or(0),
        position: f.number("position", INT, Presence::Required).required(),
        created_at: f.string("createdAt", ISO, Presence::Required).required(),
    }
}

parser!(parse_registration, read_registration, Registration);

/// "I scored two." `member_id` is only honoured for an organizer; everyone else
/// may set their own and nobody else's.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordGoalsInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
    pub goals: i64,
}

fn read_record_goals(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> RecordGoalsInput {
    let mut f = Fields::new(value, path, issues);
    RecordGoalsInput {
        member_id: f.string("memberId", ID, Presence::Optional).optional(),
        goals: f.number("goals", GOALS, Presence::Required).required(),
    }
}

parser!(parse_record_goals, read_record_goals, RecordGoalsInput);

/// Say who turned up.
///
/// `member_id` is only honoured for an organizer. Every field is optional so the
/// two halves — "I was there" and "only one of my two friends came" — can be
/// sent apart.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkAttendanceInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attended: Option<Option<bool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guests_arrived: Option<Option<i64>>,
}

fn read_mark_attendance(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> MarkAttendanceInput {
    let mut f = Fields::new(value, path, issues);
    MarkAttendanceInput {
        member_id: f.string("memberId", ID, Presence::Optional).optional(),
        attended: f.boolean("attended", Presence::Nullish).nullish(),
        guests_arrived: f.number("guestsArrived", GUESTS, Presence::Nullish).nullish(),
    }
}

parser!(parse_mark_attendance, read_mark_attendance, MarkAttendanceInput);

/* ------------------------------------------------------------------- teams */

/// Two sides is the game; six is the most a futsal pitch could plausibly host
/// as rotating teams. The lower bound is what makes the question worth asking
/// at all — "one team" is not a split.
pub const MIN_TEAMS: i64 = 2;
pub const MAX_TEAMS: i64 = 6;

/// One body on the pitch.
///
/// A member is one slot; each guest they brought is another. Guests are dealt
/// independently rather than kept beside whoever brought them — they are their
/// own body in the game, and pinning a party of three to one side is exactly the
/// imbalance a random draw is for.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSlot {
    pub member_id: String,
    pub member_name: String,
    pub member_avatar_updated_at: Option<String>,
    /// 0 is the member themselves; 1..5 are the guests they brought.
    pub guest_index: i64,
}

fn read_team_slot(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> TeamSlot {
    let mut f = Fields::new(value, path, issues);
    TeamSlot {
        member_id: f.string("memberId", ID, Presence::Required).required(),
        member_name: f.string("memberName", FREE_TEXT, Presence::Required).required(),
        member_avatar_updated_at: f
            .string("memberAvatarUpdatedAt", ISO, Presence::NullableDefault)
            .optional(),
        guest_index: f.number("guestIndex", GUESTS, Presence::Required).required(),
    }
}

parser!(parse_team_slot, read_team_slot, TeamSlot);

/// Whoever did the thing, kept by value so a removed member still has a name.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub member_id: String,
    pub member_name: String,
}

fn read_actor(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> Actor {
    let mut f = Fields::new(value, path, issues);
    Actor {
        member_id: f.string("memberId", ID, Presence::Required).required(),
        member_name: f.string("memberName", FREE_TEXT, Presence::Required).required(),
    }
}

/// One fixture: two of the drawn teams, and how it finished.
///
/// Who plays whom is settled when the teams are confirmed, not when a match
/// ends — walking off the pitch and *then* being asked who you just played is
/// the wrong order, and with three teams rotating it is a question nobody can
/// answer reliably an hour later. So the fixture list exists first and each
/// entry only ever needs its score.
///
/// `first_team` and `second_team` are positions in the fixture, not team
/// letters: they index into `TeamDraw::teams`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMatch {
    pub id: String,
    /// Position in the fixture list; stable, so the order never jumps around.
    pub ordinal: i64,
    pub first_team: i64,
    pub second_team: i64,
    /// Both null until somebody records it. A played 0-0 is two zeroes.
    pub first_goals: Option<i64>,
    pub second_goals: Option<i64>,
    pub recorded_by: Option<Actor>,
    pub recorded_at: Option<String>,
}

fn read_team_match(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> TeamMatch {
    let mut f = Fields::new(value, path, issues);
    TeamMatch {
        id: f.string("id", ID, Presence::Required).required(),
        ordinal: f.number("ordinal", COUNT, Presence::Required).required(),
        first_team: f.number("firstTeam", TEAM_INDEX, Presence::Required).required(),
        second_team: f.number("secondTeam", TEAM_INDEX, Presence::Required).required(),
        first_goals: f.number("firstGoals", GOALS, Presence::Nullable).optional(),
        second_goals: f.number("secondGoals", GOALS, Presence::Nullable).optional(),
        recorded_by: f.object("recordedBy", Presence::Nullable, read_actor).optional(),
        recorded_at: f.string("recordedAt", ISO, Presence::Nullable).optional(),
    }
}

parser!(parse_team_match, read_team_match, TeamMatch);

/// The teams as they currently stand.
///
/// Stored rather than derived. A draw computed on the fly from whoever is
/// currently marked present would silently rearrange everybody the moment a late
/// arrival was added or somebody was marked a no-show — and by then the teams are
/// people standing in two groups on a pitch, not a query result.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamDraw {
    pub team_count: i64,
    /// `teams[i]` is everyone on team i. May be empty if people have left.
    pub teams: Vec<Vec<TeamSlot>>,
    /// Whoever last pressed shuffle. Null if they have since been removed.
    pub drawn_by: Option<Actor>,
    pub drawn_at: String,
    /// When the group settled on these teams.
    ///
    /// Null while it is still being argued about, and until then anybody may
    /// reshuffle. Once it is set the draw stops being a suggestion — people have
    /// put bibs on — so only an organizer can move anybody after it.
    pub confirmed_at: Option<String>,
    pub confirmed_by: Option<Actor>,
    /// Empty until the teams are confirmed, which is what generates the list.
    pub matches: Vec<TeamMatch>,
}

fn read_team_draw(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> TeamDraw {
    let mut f = Fields::new(value, path, issues);
    TeamDraw {
        team_count: f.number("teamCount", TEAM_COUNT, Presence::Required).required(),
        teams: f
            .array("teams", Presence::Required, Some(MAX_TEAMS as usize), |value, path, issues| {
                array_value(value, &path, issues, None, read_team_slot)
            })
            .required(),
        drawn_by: f.object("drawnBy", Presence::Nullable, read_actor).optional(),
        drawn_at: f.string("drawnAt", ISO, Presence::Required).required(),
        confirmed_at: f.string("confirmedAt", ISO, Presence::Nullable).optional(),
        confirmed_by: f.object("confirmedBy", Presence::Nullable, read_actor).optional(),
        matches: f.array("matches", Presence::Required, None, read_team_match).required(),
    }
}

parser!(parse_team_draw, read_team_draw, TeamDraw);

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawTeamsInput {
    pub team_count: i64,
}

fn read_draw_teams(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> DrawTeamsInput {
    let mut f = Fields::new(value, path, issues);
    DrawTeamsInput { team_count: f.number("teamCount", TEAM_COUNT, Presence::Required).required() }
}

parser!(parse_draw_teams, read_draw_teams, DrawTeamsInput);

tag_enum! {
    /// How one game went for one of the two sides in it.
    MatchOutcome {
        Won => "won",
        Drawn => "drawn",
        Lost => "lost",
    }
}

/// Both together, or both null to put a fixture back to unplayed.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordMatchInput {
    pub first_goals: Option<i64>,
    pub second_goals: Option<i64>,
}

fn read_record_match(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> RecordMatchInput {
    let mut f = Fields::new(value, path, issues);
    RecordMatchInput {
        first_goals: f.number("firstGoals", GOALS, Presence::Nullable).optional(),
        second_goals: f.number("secondGoals", GOALS, Presence::Nullable).optional(),
    }
}

parser!(parse_record_match, read_record_match, RecordMatchInput);

/* --------------------------------------------------------------------- mvp */

/// One player's share of the vote. Never says who voted for them.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvpTallyEntry {
    pub member_id: String,
    pub member_name: String,
    pub member_avatar_updated_at: Option<String>,
    pub votes: i64,
}

fn read_mvp_tally_entry(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> MvpTallyEntry {
    let mut f = Fields::new(value, path, issues);
    MvpTallyEntry {
        member_id: f.string("memberId", ID, Presence::Required).required(),
        member_name: f.string("memberName", FREE_TEXT, Presence::Required).required(),
        member_avatar_updated_at: f
            .string("memberAvatarUpdatedAt", ISO, Presence::NullableDefault)
            .optional(),
        votes: f.number("votes", COUNT, Presence::Required).required(),
    }
}

parser!(parse_mvp_tally_entry, read_mvp_tally_entry, MvpTallyEntry);

/// `mvpTallyEntrySchema.omit({ votes: true })` — a name that may be voted for.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvpCandidate {
    pub member_id: String,
    pub member_name: String,
    pub member_avatar_updated_at: Option<String>,
}

fn read_mvp_candidate(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> MvpCandidate {
    let mut f = Fields::new(value, path, issues);
    MvpCandidate {
        member_id: f.string("memberId", ID, Presence::Required).required(),
        member_name: f.string("memberName", FREE_TEXT, Presence::Required).required(),
        member_avatar_updated_at: f
            .string("memberAvatarUpdatedAt", ISO, Presence::NullableDefault)
            .optional(),
    }
}

/// The vote on one session.
///
/// One thing is deliberately absent, and the absence is the feature: **who voted
/// for whom.** The table needs a voter id to make one vote one vote; nothing
/// that leaves the server carries it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mvp {
    /// Members who played and may be voted for. Guests have no name to award.
    pub candidates: Vec<MvpCandidate>,
    /// The caller's own choice, and only theirs. Null until they vote.
    pub my_vote: Option<String>,
    /// The standing, highest first and then by name. Everyone who could be voted
    /// for is here on nought votes, plus anybody holding votes who has since been
    /// marked absent — their votes were cast and are not ours to discard.
    pub tally: Vec<MvpTallyEntry>,
    /// How many have voted, out of how many could. Safe to show beforehand.
    pub votes_cast: i64,
    pub voter_count: i64,
    /// Everybody level at the top. Empty until somebody votes; may be several.
    pub leaders: Vec<String>,
}

fn read_mvp(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> Mvp {
    let mut f = Fields::new(value, path, issues);
    Mvp {
        candidates: f.array("candidates", Presence::Required, None, read_mvp_candidate).required(),
        my_vote: f.string("myVote", ID, Presence::Nullable).optional(),
        tally: f.array("tally", Presence::Required, None, read_mvp_tally_entry).required(),
        votes_cast: f.number("votesCast", COUNT, Presence::Required).required(),
        voter_count: f.number("voterCount", COUNT, Presence::Required).required(),
        leaders: f
            .array("leaders", Presence::Required, None, |value, path, issues| {
                string_value(value, &path, issues, ID)
            })
            .required(),
    }
}

parser!(parse_mvp, read_mvp, Mvp);

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastVoteInput {
    /// Null takes your vote back without putting it anywhere else.
    pub nominee_id: Option<String>,
}

fn read_cast_vote(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> CastVoteInput {
    let mut f = Fields::new(value, path, issues);
    CastVoteInput { nominee_id: f.string("nomineeId", ID, Presence::Nullable).optional() }
}

parser!(parse_cast_vote, read_cast_vote, CastVoteInput);

/* -------------------------------------------------------------- trash talk */

/// A jab across the pitch, not a post — see the migration for why it is short.
pub const MAX_MESSAGE_LENGTH: usize = 280;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub id: String,
    pub session_id: String,
    pub member_id: String,
    pub member_name: String,
    /// Cache token for the writer's picture; null when they have none.
    pub member_avatar_updated_at: Option<String>,
    pub body: String,
    pub created_at: String,
}

fn read_session_message(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> SessionMessage {
    let mut f = Fields::new(value, path, issues);
    SessionMessage {
        id: f.string("id", ID, Presence::Required).required(),
        session_id: f.string("sessionId", ID, Presence::Required).required(),
        member_id: f.string("memberId", ID, Presence::Required).required(),
        member_name: f.string("memberName", FREE_TEXT, Presence::Required).required(),
        member_avatar_updated_at: f
            .string("memberAvatarUpdatedAt", ISO, Presence::NullableDefault)
            .optional(),
        body: f.string("body", MESSAGE_BODY, Presence::Required).required(),
        created_at: f.string("createdAt", ISO, Presence::Required).required(),
    }
}

parser!(parse_session_message, read_session_message, SessionMessage);

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostMessageInput {
    pub body: String,
}

fn read_post_message(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> PostMessageInput {
    let mut f = Fields::new(value, path, issues);
    PostMessageInput { body: f.string("body", MESSAGE_BODY_INPUT, Presence::Required).required() }
}

parser!(parse_post_message, read_post_message, PostMessageInput);

/// Whoever is looking at a message and might take it down.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MessageViewer<'a> {
    pub member_id: &'a str,
    pub is_organizer: bool,
}

/// Who may take a message down: whoever wrote it, or an organizer.
///
/// The same pair the app trusts everywhere else it stores something one person
/// said — attendance, goals, a scoreline. The author because it is theirs, and an
/// organizer because the person whose joke landed badly is not always the person
/// who will delete it.
pub fn can_delete_message(message_member_id: &str, viewer: &MessageViewer) -> bool {
    message_member_id == viewer.member_id || viewer.is_organizer
}

/* ------------------------------------------------------------- leaderboard */

tag_enum! {
    /// One game in a player's recent form. `in` played, `missed` did not,
    /// `waitlist` had no room, `none` not a member yet.
    FormMark {
        In => "in",
        Missed => "missed",
        Waitlist => "waitlist",
        None => "none",
    }
}

/// One player's recent form: the last few games, newest last.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberForm {
    pub member_id: String,
    pub recent: Vec<FormMark>,
}

fn read_form(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> MemberForm {
    let mut f = Fields::new(value, path, issues);
    MemberForm {
        member_id: f.string("memberId", ID, Presence::Required).required(),
        recent: f
            .array("recent", Presence::Required, None, |value, path, issues| {
                enum_value(value, &path, issues, FormMark::OPTIONS, FormMark::from_tag)
            })
            .required(),
    }
}

parser!(parse_form, read_form, MemberForm);

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardEntry {
    pub member: Member,
    pub streak: StreakStats,
    pub goals: i64,
    /// Games this player was voted the best in.
    pub mvps: i64,
}

fn read_leaderboard_entry(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> LeaderboardEntry {
    let mut f = Fields::new(value, path, issues);
    LeaderboardEntry {
        member: f.object("member", Presence::Required, read_member).required(),
        streak: f.object("streak", Presence::Required, read_streak).required(),
        goals: f.number("goals", COUNT, Presence::Required).required(),
        mvps: f.number("mvps", COUNT, Presence::Defaulted).or(0),
    }
}

parser!(parse_leaderboard_entry, read_leaderboard_entry, LeaderboardEntry);

tag_enum! {
    /// Which column the board is ranked by.
    LeaderboardBoard {
        Streak => "streak",
        Goals => "goals",
        Mvp => "mvp",
    }
}

/* ----------------------------------------------------------------- payment */

tag_enum! {
    /// `unpaid -> pending (member claims) -> confirmed (organizer verifies)`.
    PaymentStatus {
        Unpaid => "unpaid",
        Pending => "pending",
        Confirmed => "confirmed",
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payment {
    pub id: String,
    pub session_id: String,
    pub member_id: String,
    pub member_name: String,
    /// What this person owes after the split and any override.
    pub amount_due: i64,
    /// Organizer's manual per-person amount, when set.
    pub amount_override: Option<i64>,
    /// Guests this charge was computed for, snapshotted when the bill was split.
    /// Keeps the amount explainable from the payment alone.
    pub guests: i64,
    pub status: PaymentStatus,
    /// True when a screenshot exists; the object key itself stays server-side.
    pub has_proof: bool,
    pub note: Option<String>,
    pub reject_reason: Option<String>,
    pub claimed_at: Option<String>,
    pub confirmed_at: Option<String>,
    pub updated_at: String,
}

fn read_payment(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> Payment {
    let mut f = Fields::new(value, path, issues);
    Payment {
        id: f.string("id", ID, Presence::Required).required(),
        session_id: f.string("sessionId", ID, Presence::Required).required(),
        member_id: f.string("memberId", ID, Presence::Required).required(),
        member_name: f.string("memberName", FREE_TEXT, Presence::Required).required(),
        amount_due: f.number("amountDue", VND, Presence::Required).required(),
        amount_override: f.number("amountOverride", VND, Presence::Nullable).optional(),
        guests: f.number("guests", COUNT, Presence::Defaulted).or(0),
        status: f
            .enumeration(
                "status",
                PaymentStatus::OPTIONS,
                PaymentStatus::from_tag,
                Presence::Required,
            )
            .required(),
        has_proof: f.boolean("hasProof", Presence::Required).required(),
        note: f.string("note", PAYMENT_TEXT, Presence::Nullable).optional(),
        reject_reason: f.string("rejectReason", PAYMENT_TEXT, Presence::Nullable).optional(),
        claimed_at: f.string("claimedAt", ISO, Presence::Nullable).optional(),
        confirmed_at: f.string("confirmedAt", ISO, Presence::Nullable).optional(),
        updated_at: f.string("updatedAt", ISO, Presence::Required).required(),
    }
}

parser!(parse_payment, read_payment, Payment);

/// One person charged a fixed amount instead of their share of the split.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleOverride {
    pub member_id: String,
    pub amount: i64,
}

fn read_settle_override(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> SettleOverride {
    let mut f = Fields::new(value, path, issues);
    SettleOverride {
        member_id: f.string("memberId", ID, Presence::Required).required(),
        amount: f.number("amount", VND, Presence::Required).required(),
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleSessionInput {
    pub total_charge: i64,
    /// Round each share to this grain (dong). 1 disables rounding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub granularity: Option<i64>,
    /// Absolute amounts that bypass the equal split.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overrides: Option<Vec<SettleOverride>>,
}

fn read_settle_session(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> SettleSessionInput {
    let mut f = Fields::new(value, path, issues);
    SettleSessionInput {
        total_charge: f.number("totalCharge", VND, Presence::Required).required(),
        granularity: f.number("granularity", GRANULARITY, Presence::Optional).optional(),
        overrides: f
            .array("overrides", Presence::Optional, Some(60), read_settle_override)
            .optional(),
    }
}

parser!(parse_settle_session, read_settle_session, SettleSessionInput);

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimPaymentInput {
    /// R2 object key returned by the upload endpoint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof_key: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<Option<String>>,
}

fn read_claim_payment(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> ClaimPaymentInput {
    let mut f = Fields::new(value, path, issues);
    ClaimPaymentInput {
        proof_key: f.string("proofKey", PROOF_KEY, Presence::Nullish).nullish(),
        note: f.string("note", PAYMENT_TEXT_INPUT, Presence::Nullish).nullish(),
    }
}

parser!(parse_claim_payment, read_claim_payment, ClaimPaymentInput);

tag_enum! {
    ReviewDecision {
        Confirm => "confirm",
        Reject => "reject",
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPaymentInput {
    pub decision: ReviewDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Option<String>>,
}

fn read_review_payment(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> ReviewPaymentInput {
    let mut f = Fields::new(value, path, issues);
    ReviewPaymentInput {
        decision: f
            .enumeration(
                "decision",
                ReviewDecision::OPTIONS,
                ReviewDecision::from_tag,
                Presence::Required,
            )
            .required(),
        reason: f.string("reason", PAYMENT_TEXT_INPUT, Presence::Nullish).nullish(),
    }
}

parser!(parse_review_payment, read_review_payment, ReviewPaymentInput);

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverridePaymentInput {
    /// Null clears the override and returns this person to the equal split.
    pub amount: Option<i64>,
}

fn read_override_payment(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> OverridePaymentInput {
    let mut f = Fields::new(value, path, issues);
    OverridePaymentInput { amount: f.number("amount", VND, Presence::Nullable).optional() }
}

parser!(parse_override_payment, read_override_payment, OverridePaymentInput);

/* -------------------------------------------------------- composite views */

/// The heads on the pitch, and how many of them came as guests.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct SessionCounts {
    /// Heads on the pitch: members plus the guests they brought.
    #[serde(rename = "in")]
    pub in_count: i64,
    pub waitlist: i64,
    /// How many of `in` are guests, so a screen can say why the numbers differ.
    pub guests: i64,
}

fn read_session_counts(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> SessionCounts {
    let mut f = Fields::new(value, path, issues);
    SessionCounts {
        in_count: f.number("in", INT, Presence::Required).required(),
        waitlist: f.number("waitlist", INT, Presence::Required).required(),
        guests: f.number("guests", INT, Presence::Defaulted).or(0),
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub session: Session,
    pub registrations: Vec<Registration>,
    pub counts: SessionCounts,
    /// Whether registration is still open (before kickoff, not cancelled).
    pub registration_open: bool,
    /// The caller's own registration, if any.
    pub me: Option<Registration>,
    /// The teams, once somebody has split them. Carried here rather than fetched
    /// separately: the one screen that wants it already loads this, and it is
    /// wanted at a pitch on a phone connection where a second round trip is the
    /// expensive part.
    pub teams: Option<TeamDraw>,
}

fn read_session_detail(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> SessionDetail {
    let mut f = Fields::new(value, path, issues);
    SessionDetail {
        session: f.object("session", Presence::Required, read_session).required(),
        registrations: f
            .array("registrations", Presence::Required, None, read_registration)
            .required(),
        counts: f.object("counts", Presence::Required, read_session_counts).required(),
        registration_open: f.boolean("registrationOpen", Presence::Required).required(),
        me: f.object("me", Presence::Nullable, read_registration).optional(),
        teams: f.object("teams", Presence::NullableDefault, read_team_draw).optional(),
    }
}

parser!(parse_session_detail, read_session_detail, SessionDetail);

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentSummary {
    pub session_id: String,
    pub total_charge: Option<i64>,
    pub collected: i64,
    pub pending: i64,
    pub outstanding: i64,
    pub payments: Vec<Payment>,
}

fn read_payment_summary(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> PaymentSummary {
    let mut f = Fields::new(value, path, issues);
    PaymentSummary {
        session_id: f.string("sessionId", ID, Presence::Required).required(),
        total_charge: f.number("totalCharge", VND, Presence::Nullable).optional(),
        collected: f.number("collected", VND, Presence::Required).required(),
        pending: f.number("pending", VND, Presence::Required).required(),
        outstanding: f.number("outstanding", VND, Presence::Required).required(),
        payments: f.array("payments", Presence::Required, None, read_payment).required(),
    }
}

parser!(parse_payment_summary, read_payment_summary, PaymentSummary);

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberBalance {
    pub member: Member,
    pub sessions_played: i64,
    pub total_owed: i64,
    pub total_confirmed: i64,
    /// Owed minus confirmed: what this person still needs to settle up.
    pub outstanding: i64,
}

fn read_member_balance(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> MemberBalance {
    let mut f = Fields::new(value, path, issues);
    MemberBalance {
        member: f.object("member", Presence::Required, read_member).required(),
        sessions_played: f.number("sessionsPlayed", INT, Presence::Required).required(),
        total_owed: f.number("totalOwed", VND, Presence::Required).required(),
        total_confirmed: f.number("totalConfirmed", VND, Presence::Required).required(),
        outstanding: f.number("outstanding", VND, Presence::Required).required(),
    }
}

parser!(parse_member_balance, read_member_balance, MemberBalance);

/// Which side they were on that week and how its games went.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct HistoryTeams {
    pub team: i64,
    pub outcomes: Vec<MatchOutcome>,
}

fn read_history_teams(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> HistoryTeams {
    let mut f = Fields::new(value, path, issues);
    HistoryTeams {
        team: f.number("team", TEAM_INDEX, Presence::Required).required(),
        outcomes: f
            .array("outcomes", Presence::Required, None, |value, path, issues| {
                enum_value(value, &path, issues, MatchOutcome::OPTIONS, MatchOutcome::from_tag)
            })
            .required(),
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberHistoryEntry {
    pub session: Session,
    pub registration_status: Option<RegistrationStatus>,
    pub payment: Option<Payment>,
    /// Null when no teams were drawn, which is most of the group's history — the
    /// feature is new, and plenty of Fridays are a kickabout nobody split. The
    /// outcomes are resolved server-side with the shared helper rather than
    /// shipping every fixture, because a list row only ever draws the marks.
    pub teams: Option<HistoryTeams>,
}

fn read_member_history_entry(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> MemberHistoryEntry {
    let mut f = Fields::new(value, path, issues);
    MemberHistoryEntry {
        session: f.object("session", Presence::Required, read_session).required(),
        registration_status: f
            .enumeration(
                "registrationStatus",
                RegistrationStatus::OPTIONS,
                RegistrationStatus::from_tag,
                Presence::Nullable,
            )
            .optional(),
        payment: f.object("payment", Presence::Nullable, read_payment).optional(),
        teams: f.object("teams", Presence::NullableDefault, read_history_teams).optional(),
    }
}

parser!(parse_member_history_entry, read_member_history_entry, MemberHistoryEntry);

/* ---------------------------------------------------------------- identity */

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub member_id: String,
    pub name: String,
    pub is_organizer: bool,
    /// False while the organizer has not let them in yet. The client shows a
    /// waiting screen; the server refuses everything but this check.
    pub approved: bool,
    /// Follows the member across devices, so a new phone opens in their language.
    pub language: Locale,
    /// And on their preferred clock.
    pub hour12: bool,
}

fn read_identity(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> Identity {
    let mut f = Fields::new(value, path, issues);
    Identity {
        member_id: f.string("memberId", ID, Presence::Required).required(),
        name: f.string("name", FREE_TEXT, Presence::Required).required(),
        is_organizer: f.boolean("isOrganizer", Presence::Required).required(),
        approved: f.boolean("approved", Presence::Defaulted).or(true),
        language: f
            .enumeration("language", LANGUAGE, language_from_tag, Presence::Required)
            .required(),
        hour12: f.boolean("hour12", Presence::Defaulted).or(false),
    }
}

parser!(parse_identity, read_identity, Identity);

/// Redeeming a claim link.
///
/// The nonce travels in the URL *fragment*, which browsers never send to the
/// server and which stays out of access logs and `Referer` headers. The page
/// reads it and posts it here.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimInput {
    pub nonce: String,
}

fn read_claim(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> ClaimInput {
    let mut f = Fields::new(value, path, issues);
    ClaimInput { nonce: f.string("nonce", NONCE, Presence::Required).required() }
}

parser!(parse_claim, read_claim, ClaimInput);

/// A name offered on the group join screen. Nothing else about them leaks.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct JoinableMember {
    pub id: String,
    pub name: String,
}

fn read_joinable_member(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> JoinableMember {
    let mut f = Fields::new(value, path, issues);
    JoinableMember {
        id: f.string("id", ID, Presence::Required).required(),
        name: f.string("name", FREE_TEXT, Presence::Required).required(),
    }
}

parser!(parse_joinable_member, read_joinable_member, JoinableMember);

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupJoinInput {
    pub nonce: String,
}

fn read_group_join(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> GroupJoinInput {
    let mut f = Fields::new(value, path, issues);
    GroupJoinInput { nonce: f.string("nonce", NONCE, Presence::Required).required() }
}

parser!(parse_group_join, read_group_join, GroupJoinInput);

/// Putting your own name forward from the group link.
///
/// Same nonce as the name picker, so only somebody holding the link can do it,
/// and the result is a member the organizer still has to approve.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSelfAddInput {
    pub nonce: String,
    pub name: String,
}

fn read_group_self_add(
    value: &Value,
    path: Vec<Segment>,
    issues: &mut Vec<Issue>,
) -> GroupSelfAddInput {
    let mut f = Fields::new(value, path, issues);
    GroupSelfAddInput {
        nonce: f.string("nonce", NONCE_NO_MAX, Presence::Required).required(),
        name: f.string("name", NAME_INPUT, Presence::Required).required(),
    }
}

parser!(parse_group_self_add, read_group_self_add, GroupSelfAddInput);

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupClaimInput {
    pub nonce: String,
    pub member_id: String,
}

fn read_group_claim(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> GroupClaimInput {
    let mut f = Fields::new(value, path, issues);
    GroupClaimInput {
        nonce: f.string("nonce", NONCE, Presence::Required).required(),
        member_id: f.string("memberId", ID, Presence::Required).required(),
    }
}

parser!(parse_group_claim, read_group_claim, GroupClaimInput);

/// The one link the organizer pastes into the group chat.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInvite {
    pub url: String,
    pub expires_at: String,
    /// How many people still have a name to claim through it.
    pub unclaimed: i64,
}

fn read_group_invite(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> GroupInvite {
    let mut f = Fields::new(value, path, issues);
    GroupInvite {
        url: f.string("url", FREE_TEXT, Presence::Required).required(),
        expires_at: f.string("expiresAt", ISO, Presence::Required).required(),
        unclaimed: f.number("unclaimed", INT, Presence::Required).required(),
    }
}

parser!(parse_group_invite, read_group_invite, GroupInvite);

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimLink {
    /// Full URL to send to the person. Contains the only copy of the nonce.
    pub url: String,
    pub expires_at: String,
    pub member_name: String,
}

fn read_claim_link(value: &Value, path: Vec<Segment>, issues: &mut Vec<Issue>) -> ClaimLink {
    let mut f = Fields::new(value, path, issues);
    ClaimLink {
        url: f.string("url", FREE_TEXT, Presence::Required).required(),
        expires_at: f.string("expiresAt", ISO, Presence::Required).required(),
        member_name: f.string("memberName", FREE_TEXT, Presence::Required).required(),
    }
}

parser!(parse_claim_link, read_claim_link, ClaimLink);

#[cfg(test)]
mod tests {
    use super::*;

    fn to_json<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    /// A body the original accepts, and the value it comes out as — compared as
    /// JSON, which is the form it crosses the wire in anyway, and which catches
    /// a filled-in default, a trimmed string and a dropped unknown key all at
    /// once.
    fn ok(parse: fn(&Value) -> Result<String, ValidationError>, body: &str, want: &str) {
        let value: Value = serde_json::from_str(body).unwrap();
        match parse(&value) {
            Ok(got) => assert_eq!(got, want, "body {body}"),
            Err(error) => panic!("{body} was refused: {}", error.message()),
        }
    }

    /// A body the original refuses, and every issue it reports, each rendered
    /// the way `validate()` renders the first one.
    fn bad(parse: fn(&Value) -> Option<ValidationError>, body: &str, want: &[&str]) {
        let value: Value = serde_json::from_str(body).unwrap();
        let Some(error) = parse(&value) else { panic!("{body} was accepted") };
        let got: Vec<String> = error
            .issues
            .iter()
            .map(|issue| {
                let path = issue.path_string();
                if path.is_empty() {
                    issue.message.clone()
                } else {
                    format!("{path}: {}", issue.message)
                }
            })
            .collect();
        assert_eq!(got, want, "body {body}");
        // The API answers with the first issue and nothing else.
        assert_eq!(error.message(), want[0], "body {body}");
    }

    /// Every schema against the zod it was ported from: the bodies it takes, the
    /// values they parse to, and the exact issues the rest produce.
    #[test]
    fn bodies_parse_exactly_as_the_original() {
        ok(
            |v| parse_member(v).map(|p| to_json(&p)),
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false}"#,
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"notifySession":true,"notifyPayment":true,"language":"en","hour12":false,"avatarUpdatedAt":null,"approvedAt":null}"#,
        );
        ok(
            |v| parse_member(v).map(|p| to_json(&p)),
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"notifySession":false,"language":"my","hour12":true,"avatarUpdatedAt":"2026-01-01T00:00:00.000Z","approvedAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"notifySession":false,"notifyPayment":true,"language":"my","hour12":true,"avatarUpdatedAt":"2026-01-01T00:00:00.000Z","approvedAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(
            |v| parse_member(v).map(|p| to_json(&p)),
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2024-02-29T00:00:00Z","claimedAt":null,"hasPendingLink":false}"#,
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2024-02-29T00:00:00Z","claimedAt":null,"hasPendingLink":false,"notifySession":true,"notifyPayment":true,"language":"en","hour12":false,"avatarUpdatedAt":null,"approvedAt":null}"#,
        );
        ok(
            |v| parse_member(v).map(|p| to_json(&p)),
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-08-07T12:30Z","claimedAt":null,"hasPendingLink":false}"#,
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-08-07T12:30Z","claimedAt":null,"hasPendingLink":false,"notifySession":true,"notifyPayment":true,"language":"en","hour12":false,"avatarUpdatedAt":null,"approvedAt":null}"#,
        );
        ok(
            |v| parse_member(v).map(|p| to_json(&p)),
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"junk":1}"#,
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"notifySession":true,"notifyPayment":true,"language":"en","hour12":false,"avatarUpdatedAt":null,"approvedAt":null}"#,
        );
        ok(
            |v| parse_streak(v).map(|p| to_json(&p)),
            r#"{"current":1,"best":2,"played":3,"total":4}"#,
            r#"{"current":1,"best":2,"played":3,"total":4}"#,
        );
        ok(
            |v| parse_member_profile(v).map(|p| to_json(&p)),
            r#"{"member":{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false},"streak":{"current":1,"best":2,"played":3,"total":4},"outstanding":0}"#,
            r#"{"member":{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"notifySession":true,"notifyPayment":true,"language":"en","hour12":false,"avatarUpdatedAt":null,"approvedAt":null},"streak":{"current":1,"best":2,"played":3,"total":4},"goals":0,"mvps":0,"outstanding":0}"#,
        );
        ok(
            |v| parse_member_profile(v).map(|p| to_json(&p)),
            r#"{"member":{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false},"streak":{"current":1,"best":2,"played":3,"total":4},"goals":3,"mvps":2,"outstanding":70000}"#,
            r#"{"member":{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"notifySession":true,"notifyPayment":true,"language":"en","hour12":false,"avatarUpdatedAt":null,"approvedAt":null},"streak":{"current":1,"best":2,"played":3,"total":4},"goals":3,"mvps":2,"outstanding":70000}"#,
        );
        ok(
            |v| parse_create_member(v).map(|p| to_json(&p)),
            r#"{"name":"  Bao  "}"#,
            r#"{"name":"Bao","isOrganizer":false}"#,
        );
        ok(
            |v| parse_create_member(v).map(|p| to_json(&p)),
            r#"{"name":"Bao","isOrganizer":true}"#,
            r#"{"name":"Bao","isOrganizer":true}"#,
        );
        ok(|v| parse_update_member(v).map(|p| to_json(&p)), "{}", "{}");
        ok(
            |v| parse_update_member(v).map(|p| to_json(&p)),
            r#"{"name":"  Bao "}"#,
            r#"{"name":"Bao"}"#,
        );
        ok(
            |v| parse_update_member(v).map(|p| to_json(&p)),
            r#"{"isOrganizer":true,"active":false}"#,
            r#"{"isOrganizer":true,"active":false}"#,
        );
        ok(|v| parse_notification_prefs(v).map(|p| to_json(&p)), "{}", "{}");
        ok(
            |v| parse_notification_prefs(v).map(|p| to_json(&p)),
            r#"{"notifySession":true,"language":"my","hour12":true}"#,
            r#"{"notifySession":true,"language":"my","hour12":true}"#,
        );
        ok(
            |v| parse_push_subscription(v).map(|p| to_json(&p)),
            r#"{"endpoint":"https://push.example/abc","keys":{"p256dh":"k","auth":"a"}}"#,
            r#"{"endpoint":"https://push.example/abc","keys":{"p256dh":"k","auth":"a"}}"#,
        );
        ok(
            |v| parse_push_subscription(v).map(|p| to_json(&p)),
            r#"{"endpoint":"  https://push.example/abc  ","keys":{"p256dh":"k","auth":"a"}}"#,
            r#"{"endpoint":"https://push.example/abc","keys":{"p256dh":"k","auth":"a"}}"#,
        );
        ok(
            |v| parse_push_status(v).map(|p| to_json(&p)),
            r#"{"enabled":true,"publicKey":null,"devices":2,"notifySession":true,"notifyPayment":false,"language":"en"}"#,
            r#"{"enabled":true,"publicKey":null,"devices":2,"notifySession":true,"notifyPayment":false,"language":"en","hour12":false}"#,
        );
        ok(
            |v| parse_push_status(v).map(|p| to_json(&p)),
            r#"{"enabled":true,"publicKey":"BKx","devices":-3,"notifySession":true,"notifyPayment":false,"language":"my","hour12":true}"#,
            r#"{"enabled":true,"publicKey":"BKx","devices":-3,"notifySession":true,"notifyPayment":false,"language":"my","hour12":true}"#,
        );
        ok(
            |v| parse_payment_details(v).map(|p| to_json(&p)),
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","note":null,"updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","note":null,"updatedAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(
            |v| parse_payment_details(v).map(|p| to_json(&p)),
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(
            |v| parse_payment_details(v).map(|p| to_json(&p)),
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","note":"  pay me  ","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","note":"pay me","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(
            |v| parse_payment_details(v).map(|p| to_json(&p)),
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"  1234567890  ","accountName":"NGUYEN VAN A","note":null,"updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","note":null,"updatedAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(
            |v| parse_save_payment_details(v).map(|p| to_json(&p)),
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","note":null}"#,
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","note":null}"#,
        );
        ok(
            |v| parse_save_payment_details(v).map(|p| to_json(&p)),
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","note":null,"updatedAt":"junk"}"#,
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","note":null}"#,
        );
        ok(
            |v| parse_venue(v).map(|p| to_json(&p)),
            r#"{"id":"ven_1","name":"Tao Dan","address":"1 Truong Dinh","mapUrl":"https://maps.example/x","priceNote":"600.000d/hour","active":true,"createdAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"id":"ven_1","name":"Tao Dan","address":"1 Truong Dinh","mapUrl":"https://maps.example/x","priceNote":"600.000d/hour","active":true,"createdAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(
            |v| parse_venue(v).map(|p| to_json(&p)),
            r#"{"id":"ven_1","name":"Tao Dan","address":null,"mapUrl":null,"priceNote":null,"active":true,"createdAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"id":"ven_1","name":"Tao Dan","address":null,"mapUrl":null,"priceNote":null,"active":true,"createdAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(
            |v| parse_create_venue(v).map(|p| to_json(&p)),
            r#"{"name":" Tao Dan "}"#,
            r#"{"name":"Tao Dan"}"#,
        );
        ok(
            |v| parse_create_venue(v).map(|p| to_json(&p)),
            r#"{"name":"Tao Dan","mapUrl":""}"#,
            r#"{"name":"Tao Dan","mapUrl":""}"#,
        );
        ok(
            |v| parse_create_venue(v).map(|p| to_json(&p)),
            r#"{"name":"Tao Dan","mapUrl":null}"#,
            r#"{"name":"Tao Dan","mapUrl":null}"#,
        );
        ok(
            |v| parse_create_venue(v).map(|p| to_json(&p)),
            r#"{"name":"Tao Dan","mapUrl":"https://maps.example/x"}"#,
            r#"{"name":"Tao Dan","mapUrl":"https://maps.example/x"}"#,
        );
        ok(
            |v| parse_create_venue(v).map(|p| to_json(&p)),
            r#"{"name":"Tao Dan","mapUrl":"  https://maps.example/x  "}"#,
            r#"{"name":"Tao Dan","mapUrl":"https://maps.example/x"}"#,
        );
        ok(
            |v| parse_create_venue(v).map(|p| to_json(&p)),
            r#"{"name":"Tao Dan","address":"  1 Truong Dinh  ","priceNote":"  600k  "}"#,
            r#"{"name":"Tao Dan","address":"1 Truong Dinh","priceNote":"600k"}"#,
        );
        ok(
            |v| parse_create_venue(v).map(|p| to_json(&p)),
            r#"{"name":"Tao Dan","address":null,"priceNote":null}"#,
            r#"{"name":"Tao Dan","address":null,"priceNote":null}"#,
        );
        ok(|v| parse_update_venue(v).map(|p| to_json(&p)), "{}", "{}");
        ok(
            |v| parse_update_venue(v).map(|p| to_json(&p)),
            r#"{"mapUrl":null,"active":false}"#,
            r#"{"mapUrl":null,"active":false}"#,
        );
        ok(
            |v| parse_update_venue(v).map(|p| to_json(&p)),
            r#"{"name":" New "}"#,
            r#"{"name":"New"}"#,
        );
        ok(
            |v| parse_session(v).map(|p| to_json(&p)),
            r#"{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(
            |v| parse_session(v).map(|p| to_json(&p)),
            r#"{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":"ven_1","venue":{"id":"ven_1","name":"Tao Dan","address":"1 Truong Dinh","mapUrl":"https://maps.example/x","priceNote":"600.000d/hour","active":true,"createdAt":"2026-01-01T00:00:00.000Z"},"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":"ven_1","venue":{"id":"ven_1","name":"Tao Dan","address":"1 Truong Dinh","mapUrl":"https://maps.example/x","priceNote":"600.000d/hour","active":true,"createdAt":"2026-01-01T00:00:00.000Z"},"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(
            |v| parse_create_session(v).map(|p| to_json(&p)),
            r#"{"startsAt":"2026-08-07T12:30:00.000Z"}"#,
            r#"{"startsAt":"2026-08-07T12:30:00.000Z"}"#,
        );
        ok(
            |v| parse_create_session(v).map(|p| to_json(&p)),
            r#"{"startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"feePerPerson":null,"maxPlayers":null,"notes":null}"#,
            r#"{"startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"feePerPerson":null,"maxPlayers":null,"notes":null}"#,
        );
        ok(
            |v| parse_create_session(v).map(|p| to_json(&p)),
            r#"{"startsAt":"2026-08-07T12:30:00.000Z","notes":"  bring bibs  "}"#,
            r#"{"startsAt":"2026-08-07T12:30:00.000Z","notes":"bring bibs"}"#,
        );
        ok(|v| parse_update_session(v).map(|p| to_json(&p)), "{}", "{}");
        ok(
            |v| parse_update_session(v).map(|p| to_json(&p)),
            r#"{"status":"cancelled"}"#,
            r#"{"status":"cancelled"}"#,
        );
        ok(
            |v| parse_update_session(v).map(|p| to_json(&p)),
            r#"{"venueId":null,"notes":"  x  "}"#,
            r#"{"venueId":null,"notes":"x"}"#,
        );
        ok(|v| parse_register(v).map(|p| to_json(&p)), "{}", r#"{"guests":0}"#);
        ok(|v| parse_register(v).map(|p| to_json(&p)), r#"{"guests":3}"#, r#"{"guests":3}"#);
        ok(
            |v| parse_registration(v).map(|p| to_json(&p)),
            r#"{"id":"reg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","status":"in","position":1,"createdAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"id":"reg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","memberAvatarUpdatedAt":null,"guests":0,"status":"in","attended":null,"guestsArrived":null,"goals":0,"position":1,"createdAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(
            |v| parse_registration(v).map(|p| to_json(&p)),
            r#"{"id":"reg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","status":"in","position":1,"createdAt":"2026-01-01T00:00:00.000Z","guests":2,"attended":false,"guestsArrived":1,"goals":3,"memberAvatarUpdatedAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"id":"reg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","memberAvatarUpdatedAt":"2026-01-01T00:00:00.000Z","guests":2,"status":"in","attended":false,"guestsArrived":1,"goals":3,"position":1,"createdAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(|v| parse_record_goals(v).map(|p| to_json(&p)), r#"{"goals":2}"#, r#"{"goals":2}"#);
        ok(
            |v| parse_record_goals(v).map(|p| to_json(&p)),
            r#"{"memberId":"mem_1","goals":2}"#,
            r#"{"memberId":"mem_1","goals":2}"#,
        );
        ok(|v| parse_mark_attendance(v).map(|p| to_json(&p)), "{}", "{}");
        ok(
            |v| parse_mark_attendance(v).map(|p| to_json(&p)),
            r#"{"attended":null,"guestsArrived":null}"#,
            r#"{"attended":null,"guestsArrived":null}"#,
        );
        ok(
            |v| parse_mark_attendance(v).map(|p| to_json(&p)),
            r#"{"attended":true,"guestsArrived":2}"#,
            r#"{"attended":true,"guestsArrived":2}"#,
        );
        ok(
            |v| parse_team_slot(v).map(|p| to_json(&p)),
            r#"{"memberId":"mem_1","memberName":"Bao","guestIndex":0}"#,
            r#"{"memberId":"mem_1","memberName":"Bao","memberAvatarUpdatedAt":null,"guestIndex":0}"#,
        );
        ok(
            |v| parse_team_match(v).map(|p| to_json(&p)),
            r#"{"id":"mat_1","ordinal":0,"firstTeam":0,"secondTeam":1,"firstGoals":null,"secondGoals":null,"recordedBy":null,"recordedAt":null}"#,
            r#"{"id":"mat_1","ordinal":0,"firstTeam":0,"secondTeam":1,"firstGoals":null,"secondGoals":null,"recordedBy":null,"recordedAt":null}"#,
        );
        ok(
            |v| parse_team_draw(v).map(|p| to_json(&p)),
            r#"{"teamCount":2,"teams":[[{"memberId":"mem_1","memberName":"Bao","guestIndex":0}],[]],"drawnBy":{"memberId":"mem_1","memberName":"Bao"},"drawnAt":"2026-01-01T00:00:00.000Z","confirmedAt":null,"confirmedBy":null,"matches":[]}"#,
            r#"{"teamCount":2,"teams":[[{"memberId":"mem_1","memberName":"Bao","memberAvatarUpdatedAt":null,"guestIndex":0}],[]],"drawnBy":{"memberId":"mem_1","memberName":"Bao"},"drawnAt":"2026-01-01T00:00:00.000Z","confirmedAt":null,"confirmedBy":null,"matches":[]}"#,
        );
        ok(
            |v| parse_draw_teams(v).map(|p| to_json(&p)),
            r#"{"teamCount":3}"#,
            r#"{"teamCount":3}"#,
        );
        ok(
            |v| parse_record_match(v).map(|p| to_json(&p)),
            r#"{"firstGoals":null,"secondGoals":null}"#,
            r#"{"firstGoals":null,"secondGoals":null}"#,
        );
        ok(
            |v| parse_record_match(v).map(|p| to_json(&p)),
            r#"{"firstGoals":2,"secondGoals":1}"#,
            r#"{"firstGoals":2,"secondGoals":1}"#,
        );
        ok(
            |v| parse_mvp_tally_entry(v).map(|p| to_json(&p)),
            r#"{"memberId":"mem_1","memberName":"Bao","votes":2}"#,
            r#"{"memberId":"mem_1","memberName":"Bao","memberAvatarUpdatedAt":null,"votes":2}"#,
        );
        ok(
            |v| parse_mvp(v).map(|p| to_json(&p)),
            r#"{"candidates":[{"memberId":"mem_1","memberName":"Bao"}],"myVote":null,"tally":[{"memberId":"mem_1","memberName":"Bao","votes":1}],"votesCast":1,"voterCount":3,"leaders":["mem_1"]}"#,
            r#"{"candidates":[{"memberId":"mem_1","memberName":"Bao","memberAvatarUpdatedAt":null}],"myVote":null,"tally":[{"memberId":"mem_1","memberName":"Bao","memberAvatarUpdatedAt":null,"votes":1}],"votesCast":1,"voterCount":3,"leaders":["mem_1"]}"#,
        );
        ok(
            |v| parse_cast_vote(v).map(|p| to_json(&p)),
            r#"{"nomineeId":null}"#,
            r#"{"nomineeId":null}"#,
        );
        ok(
            |v| parse_cast_vote(v).map(|p| to_json(&p)),
            r#"{"nomineeId":"mem_1"}"#,
            r#"{"nomineeId":"mem_1"}"#,
        );
        ok(
            |v| parse_session_message(v).map(|p| to_json(&p)),
            r#"{"id":"msg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","body":"nice one","createdAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"id":"msg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","memberAvatarUpdatedAt":null,"body":"nice one","createdAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(
            |v| parse_post_message(v).map(|p| to_json(&p)),
            r#"{"body":"  hey  "}"#,
            r#"{"body":"hey"}"#,
        );
        ok(
            |v| parse_form(v).map(|p| to_json(&p)),
            r#"{"memberId":"mem_1","recent":["in","missed","waitlist","none"]}"#,
            r#"{"memberId":"mem_1","recent":["in","missed","waitlist","none"]}"#,
        );
        ok(
            |v| parse_leaderboard_entry(v).map(|p| to_json(&p)),
            r#"{"member":{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false},"streak":{"current":1,"best":2,"played":3,"total":4},"goals":5}"#,
            r#"{"member":{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"notifySession":true,"notifyPayment":true,"language":"en","hour12":false,"avatarUpdatedAt":null,"approvedAt":null},"streak":{"current":1,"best":2,"played":3,"total":4},"goals":5,"mvps":0}"#,
        );
        ok(
            |v| parse_leaderboard_entry(v).map(|p| to_json(&p)),
            r#"{"member":{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false},"streak":{"current":1,"best":2,"played":3,"total":4},"goals":5,"mvps":2}"#,
            r#"{"member":{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"notifySession":true,"notifyPayment":true,"language":"en","hour12":false,"avatarUpdatedAt":null,"approvedAt":null},"streak":{"current":1,"best":2,"played":3,"total":4},"goals":5,"mvps":2}"#,
        );
        ok(
            |v| parse_payment(v).map(|p| to_json(&p)),
            r#"{"id":"pay_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","amountDue":70000,"amountOverride":null,"status":"unpaid","hasProof":false,"note":null,"rejectReason":null,"claimedAt":null,"confirmedAt":null,"updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"id":"pay_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","amountDue":70000,"amountOverride":null,"guests":0,"status":"unpaid","hasProof":false,"note":null,"rejectReason":null,"claimedAt":null,"confirmedAt":null,"updatedAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        ok(
            |v| parse_settle_session(v).map(|p| to_json(&p)),
            r#"{"totalCharge":500000}"#,
            r#"{"totalCharge":500000}"#,
        );
        ok(
            |v| parse_settle_session(v).map(|p| to_json(&p)),
            r#"{"totalCharge":500000,"granularity":1000,"overrides":[{"memberId":"mem_1","amount":100000}]}"#,
            r#"{"totalCharge":500000,"granularity":1000,"overrides":[{"memberId":"mem_1","amount":100000}]}"#,
        );
        ok(|v| parse_claim_payment(v).map(|p| to_json(&p)), "{}", "{}");
        ok(
            |v| parse_claim_payment(v).map(|p| to_json(&p)),
            r#"{"proofKey":"proofs/x.png","note":"  sent  "}"#,
            r#"{"proofKey":"proofs/x.png","note":"sent"}"#,
        );
        ok(
            |v| parse_claim_payment(v).map(|p| to_json(&p)),
            r#"{"proofKey":null,"note":null}"#,
            r#"{"proofKey":null,"note":null}"#,
        );
        ok(
            |v| parse_review_payment(v).map(|p| to_json(&p)),
            r#"{"decision":"confirm"}"#,
            r#"{"decision":"confirm"}"#,
        );
        ok(
            |v| parse_review_payment(v).map(|p| to_json(&p)),
            r#"{"decision":"reject","reason":"  wrong  "}"#,
            r#"{"decision":"reject","reason":"wrong"}"#,
        );
        ok(
            |v| parse_override_payment(v).map(|p| to_json(&p)),
            r#"{"amount":null}"#,
            r#"{"amount":null}"#,
        );
        ok(
            |v| parse_override_payment(v).map(|p| to_json(&p)),
            r#"{"amount":120000}"#,
            r#"{"amount":120000}"#,
        );
        ok(
            |v| parse_session_detail(v).map(|p| to_json(&p)),
            r#"{"session":{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"registrations":[{"id":"reg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","status":"in","position":1,"createdAt":"2026-01-01T00:00:00.000Z"}],"counts":{"in":3,"waitlist":0},"registrationOpen":true,"me":null}"#,
            r#"{"session":{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"registrations":[{"id":"reg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","memberAvatarUpdatedAt":null,"guests":0,"status":"in","attended":null,"guestsArrived":null,"goals":0,"position":1,"createdAt":"2026-01-01T00:00:00.000Z"}],"counts":{"in":3,"waitlist":0,"guests":0},"registrationOpen":true,"me":null,"teams":null}"#,
        );
        ok(
            |v| parse_session_detail(v).map(|p| to_json(&p)),
            r#"{"session":{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"registrations":[],"counts":{"in":0,"waitlist":0,"guests":0},"registrationOpen":false,"me":{"id":"reg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","status":"in","position":1,"createdAt":"2026-01-01T00:00:00.000Z"},"teams":{"teamCount":2,"teams":[[{"memberId":"mem_1","memberName":"Bao","guestIndex":0}],[]],"drawnBy":{"memberId":"mem_1","memberName":"Bao"},"drawnAt":"2026-01-01T00:00:00.000Z","confirmedAt":null,"confirmedBy":null,"matches":[]}}"#,
            r#"{"session":{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"registrations":[],"counts":{"in":0,"waitlist":0,"guests":0},"registrationOpen":false,"me":{"id":"reg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","memberAvatarUpdatedAt":null,"guests":0,"status":"in","attended":null,"guestsArrived":null,"goals":0,"position":1,"createdAt":"2026-01-01T00:00:00.000Z"},"teams":{"teamCount":2,"teams":[[{"memberId":"mem_1","memberName":"Bao","memberAvatarUpdatedAt":null,"guestIndex":0}],[]],"drawnBy":{"memberId":"mem_1","memberName":"Bao"},"drawnAt":"2026-01-01T00:00:00.000Z","confirmedAt":null,"confirmedBy":null,"matches":[]}}"#,
        );
        ok(
            |v| parse_payment_summary(v).map(|p| to_json(&p)),
            r#"{"sessionId":"ses_1","totalCharge":500000,"collected":0,"pending":0,"outstanding":500000,"payments":[{"id":"pay_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","amountDue":70000,"amountOverride":null,"status":"unpaid","hasProof":false,"note":null,"rejectReason":null,"claimedAt":null,"confirmedAt":null,"updatedAt":"2026-01-01T00:00:00.000Z"}]}"#,
            r#"{"sessionId":"ses_1","totalCharge":500000,"collected":0,"pending":0,"outstanding":500000,"payments":[{"id":"pay_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","amountDue":70000,"amountOverride":null,"guests":0,"status":"unpaid","hasProof":false,"note":null,"rejectReason":null,"claimedAt":null,"confirmedAt":null,"updatedAt":"2026-01-01T00:00:00.000Z"}]}"#,
        );
        ok(
            |v| parse_member_balance(v).map(|p| to_json(&p)),
            r#"{"member":{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false},"sessionsPlayed":3,"totalOwed":210000,"totalConfirmed":70000,"outstanding":140000}"#,
            r#"{"member":{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"notifySession":true,"notifyPayment":true,"language":"en","hour12":false,"avatarUpdatedAt":null,"approvedAt":null},"sessionsPlayed":3,"totalOwed":210000,"totalConfirmed":70000,"outstanding":140000}"#,
        );
        ok(
            |v| parse_member_history_entry(v).map(|p| to_json(&p)),
            r#"{"session":{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"registrationStatus":"in","payment":null}"#,
            r#"{"session":{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"registrationStatus":"in","payment":null,"teams":null}"#,
        );
        ok(
            |v| parse_member_history_entry(v).map(|p| to_json(&p)),
            r#"{"session":{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"registrationStatus":null,"payment":{"id":"pay_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","amountDue":70000,"amountOverride":null,"status":"unpaid","hasProof":false,"note":null,"rejectReason":null,"claimedAt":null,"confirmedAt":null,"updatedAt":"2026-01-01T00:00:00.000Z"},"teams":{"team":0,"outcomes":["won","drawn"]}}"#,
            r#"{"session":{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"registrationStatus":null,"payment":{"id":"pay_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","amountDue":70000,"amountOverride":null,"guests":0,"status":"unpaid","hasProof":false,"note":null,"rejectReason":null,"claimedAt":null,"confirmedAt":null,"updatedAt":"2026-01-01T00:00:00.000Z"},"teams":{"team":0,"outcomes":["won","drawn"]}}"#,
        );
        ok(
            |v| parse_identity(v).map(|p| to_json(&p)),
            r#"{"memberId":"mem_1","name":"Bao","isOrganizer":true,"language":"en"}"#,
            r#"{"memberId":"mem_1","name":"Bao","isOrganizer":true,"approved":true,"language":"en","hour12":false}"#,
        );
        ok(
            |v| parse_identity(v).map(|p| to_json(&p)),
            r#"{"memberId":"mem_1","name":"Bao","isOrganizer":true,"approved":false,"language":"my","hour12":true}"#,
            r#"{"memberId":"mem_1","name":"Bao","isOrganizer":true,"approved":false,"language":"my","hour12":true}"#,
        );
        ok(
            |v| parse_claim(v).map(|p| to_json(&p)),
            r#"{"nonce":"nnnnnnnnnnnnnnnnnnnnnnnn"}"#,
            r#"{"nonce":"nnnnnnnnnnnnnnnnnnnnnnnn"}"#,
        );
        ok(
            |v| parse_joinable_member(v).map(|p| to_json(&p)),
            r#"{"id":"mem_1","name":"Bao"}"#,
            r#"{"id":"mem_1","name":"Bao"}"#,
        );
        ok(
            |v| parse_group_join(v).map(|p| to_json(&p)),
            r#"{"nonce":"nnnnnnnnnnnnnnnnnnnnnnnn"}"#,
            r#"{"nonce":"nnnnnnnnnnnnnnnnnnnnnnnn"}"#,
        );
        ok(
            |v| parse_group_self_add(v).map(|p| to_json(&p)),
            r#"{"nonce":"nnnnnnnnnnnnnnnnnnnnnnnn","name":"  Bao  "}"#,
            r#"{"nonce":"nnnnnnnnnnnnnnnnnnnnnnnn","name":"Bao"}"#,
        );
        ok(
            |v| parse_group_self_add(v).map(|p| to_json(&p)),
            r#"{"nonce":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","name":"Bao"}"#,
            r#"{"nonce":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","name":"Bao"}"#,
        );
        ok(
            |v| parse_group_claim(v).map(|p| to_json(&p)),
            r#"{"nonce":"nnnnnnnnnnnnnnnnnnnnnnnn","memberId":"mem_1"}"#,
            r#"{"nonce":"nnnnnnnnnnnnnnnnnnnnnnnn","memberId":"mem_1"}"#,
        );
        ok(
            |v| parse_group_invite(v).map(|p| to_json(&p)),
            r#"{"url":"https://x/y","expiresAt":"2026-01-01T00:00:00.000Z","unclaimed":2}"#,
            r#"{"url":"https://x/y","expiresAt":"2026-01-01T00:00:00.000Z","unclaimed":2}"#,
        );
        ok(
            |v| parse_claim_link(v).map(|p| to_json(&p)),
            r#"{"url":"https://x/y","expiresAt":"2026-01-01T00:00:00.000Z","memberName":"Bao"}"#,
            r#"{"url":"https://x/y","expiresAt":"2026-01-01T00:00:00.000Z","memberName":"Bao"}"#,
        );
        bad(
            |v| parse_member(v).err(),
            "{}",
            &[
                "id: Invalid input: expected string, received undefined",
                "name: Invalid input: expected string, received undefined",
                "isOrganizer: Invalid input: expected boolean, received undefined",
                "active: Invalid input: expected boolean, received undefined",
                "createdAt: Invalid input: expected string, received undefined",
                "claimedAt: Invalid input: expected string, received undefined",
                "hasPendingLink: Invalid input: expected boolean, received undefined",
            ],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false}"#,
            &["id: Too small: expected string to have >=1 characters"],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false}"#,
            &["id: Too big: expected string to have <=64 characters"],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false}"#,
            &["id: Too big: expected string to have <=64 characters"],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"mem_1","name":"","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false}"#,
            &["name: Too small: expected string to have >=1 characters"],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"mem_1","name":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false}"#,
            &["name: Too big: expected string to have <=40 characters"],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"mem_1","name":"Bao","isOrganizer":"yes","active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false}"#,
            &["isOrganizer: Invalid input: expected boolean, received string"],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01","claimedAt":null,"hasPendingLink":false}"#,
            &["createdAt: Invalid ISO datetime"],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-02-30T00:00:00Z","claimedAt":null,"hasPendingLink":false}"#,
            &["createdAt: Invalid ISO datetime"],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","hasPendingLink":false}"#,
            &["claimedAt: Invalid input: expected string, received undefined"],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"language":"fr"}"#,
            &[r#"language: Invalid option: expected one of "en"|"my""#],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"language":null}"#,
            &[r#"language: Invalid option: expected one of "en"|"my""#],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"mem_1","name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false,"notifySession":null}"#,
            &["notifySession: Invalid input: expected boolean, received null"],
        );
        bad(|v| parse_member(v).err(), "[]", &["Invalid input: expected object, received array"]);
        bad(
            |v| parse_member(v).err(),
            r#""nope""#,
            &["Invalid input: expected object, received string"],
        );
        bad(|v| parse_member(v).err(), "null", &["Invalid input: expected object, received null"]);
        bad(
            |v| parse_streak(v).err(),
            r#"{"current":-1,"best":2,"played":3,"total":4}"#,
            &["current: Too small: expected number to be >=0"],
        );
        bad(
            |v| parse_streak(v).err(),
            r#"{"current":1,"best":1.5,"played":3,"total":4}"#,
            &["best: Invalid input: expected int, received number"],
        );
        bad(
            |v| parse_streak(v).err(),
            r#"{"current":1,"best":2,"played":9007199254740992,"total":4}"#,
            &["played: Too big: expected int to be <=9007199254740991"],
        );
        bad(
            |v| parse_streak(v).err(),
            r#"{"current":1,"best":2,"played":3,"total":"4"}"#,
            &["total: Invalid input: expected number, received string"],
        );
        bad(
            |v| parse_member_profile(v).err(),
            r#"{"member":{},"streak":{"current":1,"best":2,"played":3,"total":4},"outstanding":0}"#,
            &[
                "member.id: Invalid input: expected string, received undefined",
                "member.name: Invalid input: expected string, received undefined",
                "member.isOrganizer: Invalid input: expected boolean, received undefined",
                "member.active: Invalid input: expected boolean, received undefined",
                "member.createdAt: Invalid input: expected string, received undefined",
                "member.claimedAt: Invalid input: expected string, received undefined",
                "member.hasPendingLink: Invalid input: expected boolean, received undefined",
            ],
        );
        bad(
            |v| parse_member_profile(v).err(),
            r#"{"streak":{"current":1,"best":2,"played":3,"total":4},"outstanding":0}"#,
            &["member: Invalid input: expected object, received undefined"],
        );
        bad(|v| parse_create_member(v).err(), r#"{"name":"   "}"#, &["name: Name is required"]);
        bad(|v| parse_create_member(v).err(), r#"{"name":""}"#, &["name: Name is required"]);
        bad(
            |v| parse_create_member(v).err(),
            "{}",
            &["name: Invalid input: expected string, received undefined"],
        );
        bad(
            |v| parse_create_member(v).err(),
            r#"{"name":"  xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  "}"#,
            &["name: Too big: expected string to have <=40 characters"],
        );
        bad(
            |v| parse_create_member(v).err(),
            r#"{"name":"Bao","isOrganizer":null}"#,
            &["isOrganizer: Invalid input: expected boolean, received null"],
        );
        bad(
            |v| parse_create_member(v).err(),
            r#"{"name":5}"#,
            &["name: Invalid input: expected string, received number"],
        );
        bad(
            |v| parse_update_member(v).err(),
            r#"{"name":" "}"#,
            &["name: Too small: expected string to have >=1 characters"],
        );
        bad(
            |v| parse_update_member(v).err(),
            r#"{"name":null}"#,
            &["name: Invalid input: expected string, received null"],
        );
        bad(
            |v| parse_notification_prefs(v).err(),
            r#"{"language":"de"}"#,
            &[r#"language: Invalid option: expected one of "en"|"my""#],
        );
        bad(
            |v| parse_push_subscription(v).err(),
            r#"{"endpoint":"not-a-url","keys":{"p256dh":"k","auth":"a"}}"#,
            &["endpoint: Invalid URL"],
        );
        bad(
            |v| parse_push_subscription(v).err(),
            r#"{"endpoint":"https://push.example/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","keys":{"p256dh":"","auth":""}}"#,
            &[
                "endpoint: Too big: expected string to have <=500 characters",
                "keys.p256dh: Too small: expected string to have >=1 characters",
                "keys.auth: Too small: expected string to have >=1 characters",
            ],
        );
        bad(
            |v| parse_push_subscription(v).err(),
            r#"{"endpoint":"https://push.example/abc"}"#,
            &["keys: Invalid input: expected object, received undefined"],
        );
        bad(
            |v| parse_push_subscription(v).err(),
            r#"{"endpoint":"https://push.example/abc","keys":{}}"#,
            &[
                "keys.p256dh: Invalid input: expected string, received undefined",
                "keys.auth: Invalid input: expected string, received undefined",
            ],
        );
        bad(
            |v| parse_push_subscription(v).err(),
            r#"{"endpoint":"https://push.example/abc","keys":"no"}"#,
            &["keys: Invalid input: expected object, received string"],
        );
        bad(
            |v| parse_payment_details(v).err(),
            r#"{"bankBin":"97043","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","note":null,"updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &["bankBin: Pick a bank"],
        );
        bad(
            |v| parse_payment_details(v).err(),
            r#"{"bankBin":"abcdef","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","note":null,"updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &["bankBin: Pick a bank"],
        );
        bad(
            |v| parse_payment_details(v).err(),
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":" abc ","accountName":"NGUYEN VAN A","note":null,"updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &["accountNumber: Account number should be 4-19 letters or digits"],
        );
        bad(
            |v| parse_payment_details(v).err(),
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"   ","note":null,"updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &["accountName: Who the account belongs to"],
        );
        bad(
            |v| parse_payment_details(v).err(),
            r#"{"bankBin":"970436","bankName":"Vietcombank","accountNumber":"1234567890","accountName":"NGUYEN VAN A","note":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &["note: Too big: expected string to have <=160 characters"],
        );
        bad(
            |v| parse_payment_details(v).err(),
            r#"{"bankBin":"zz","bankName":"","accountNumber":"!","accountName":" ","updatedAt":"nope"}"#,
            &[
                "bankBin: Pick a bank",
                "bankName: Too small: expected string to have >=1 characters",
                "accountNumber: Account number should be 4-19 letters or digits",
                "accountName: Who the account belongs to",
                "updatedAt: Invalid ISO datetime",
            ],
        );
        bad(
            |v| parse_venue(v).err(),
            r#"{"id":"ven_1","name":"Tao Dan","address":"1 Truong Dinh","mapUrl":"nope","priceNote":"600.000d/hour","active":true,"createdAt":"2026-01-01T00:00:00.000Z"}"#,
            &["mapUrl: Invalid URL"],
        );
        bad(
            |v| parse_venue(v).err(),
            r#"{"id":"ven_1","name":"","address":"1 Truong Dinh","mapUrl":"https://maps.example/x","priceNote":"600.000d/hour","active":true,"createdAt":"2026-01-01T00:00:00.000Z"}"#,
            &["name: Too small: expected string to have >=1 characters"],
        );
        bad(|v| parse_create_venue(v).err(), r#"{"name":"  "}"#, &["name: Venue name is required"]);
        bad(
            |v| parse_create_venue(v).err(),
            "{}",
            &["name: Invalid input: expected string, received undefined"],
        );
        bad(
            |v| parse_create_venue(v).err(),
            r#"{"name":"Tao Dan","mapUrl":"nope"}"#,
            &["mapUrl: Must be a valid URL"],
        );
        bad(
            |v| parse_create_venue(v).err(),
            r#"{"name":"Tao Dan","mapUrl":5}"#,
            &["mapUrl: Invalid input"],
        );
        bad(
            |v| parse_create_venue(v).err(),
            r#"{"name":"Tao Dan","mapUrl":"https://a.b/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}"#,
            &["mapUrl: Too big: expected string to have <=500 characters"],
        );
        bad(
            |v| parse_create_venue(v).err(),
            r#"{"name":"Tao Dan","address":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}"#,
            &["address: Too big: expected string to have <=200 characters"],
        );
        bad(
            |v| parse_update_venue(v).err(),
            r#"{"name":"","active":"yes"}"#,
            &[
                "name: Venue name is required",
                "active: Invalid input: expected boolean, received string",
            ],
        );
        bad(
            |v| parse_session(v).err(),
            r#"{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"done","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &[r#"status: Invalid option: expected one of "scheduled"|"cancelled"|"completed""#],
        );
        bad(
            |v| parse_session(v).err(),
            r#"{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":1000000001,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &["feePerPerson: Too big: expected number to be <=1000000000"],
        );
        bad(
            |v| parse_session(v).err(),
            r#"{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":0,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &["maxPlayers: Too small: expected number to be >=1"],
        );
        bad(
            |v| parse_session(v).err(),
            r#"{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":61,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &["maxPlayers: Too big: expected number to be <=60"],
        );
        bad(
            |v| parse_session(v).err(),
            r#"{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":{"id":"v"},"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &[
                "venue.name: Invalid input: expected string, received undefined",
                "venue.address: Invalid input: expected string, received undefined",
                "venue.mapUrl: Invalid input: expected string, received undefined",
                "venue.priceNote: Invalid input: expected string, received undefined",
                "venue.active: Invalid input: expected boolean, received undefined",
                "venue.createdAt: Invalid input: expected string, received undefined",
            ],
        );
        bad(
            |v| parse_session(v).err(),
            r#"{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &["notes: Too big: expected string to have <=500 characters"],
        );
        bad(
            |v| parse_create_session(v).err(),
            "{}",
            &["startsAt: Invalid input: expected string, received undefined"],
        );
        bad(
            |v| parse_create_session(v).err(),
            r#"{"startsAt":"2026-08-07T12:30:00.000Z","feePerPerson":-1,"maxPlayers":61}"#,
            &[
                "feePerPerson: Too small: expected number to be >=0",
                "maxPlayers: Too big: expected number to be <=60",
            ],
        );
        bad(
            |v| parse_create_session(v).err(),
            r#"{"startsAt":"nope"}"#,
            &["startsAt: Invalid ISO datetime"],
        );
        bad(
            |v| parse_update_session(v).err(),
            r#"{"status":"nope"}"#,
            &[r#"status: Invalid option: expected one of "scheduled"|"cancelled"|"completed""#],
        );
        bad(
            |v| parse_register(v).err(),
            r#"{"guests":6}"#,
            &["guests: Too big: expected number to be <=5"],
        );
        bad(
            |v| parse_register(v).err(),
            r#"{"guests":-1}"#,
            &["guests: Too small: expected number to be >=0"],
        );
        bad(
            |v| parse_register(v).err(),
            r#"{"guests":null}"#,
            &["guests: Invalid input: expected number, received null"],
        );
        bad(
            |v| parse_register(v).err(),
            r#"{"guests":1.5}"#,
            &["guests: Invalid input: expected int, received number"],
        );
        bad(
            |v| parse_registration(v).err(),
            r#"{"id":"reg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","status":"maybe","position":1,"createdAt":"2026-01-01T00:00:00.000Z"}"#,
            &[r#"status: Invalid option: expected one of "in"|"waitlist""#],
        );
        bad(
            |v| parse_registration(v).err(),
            r#"{"id":"reg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","status":"in","position":1,"createdAt":"2026-01-01T00:00:00.000Z","goals":31}"#,
            &["goals: Too big: expected number to be <=30"],
        );
        bad(
            |v| parse_registration(v).err(),
            r#"{"id":"reg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","status":"in","position":1.5,"createdAt":"2026-01-01T00:00:00.000Z"}"#,
            &["position: Invalid input: expected int, received number"],
        );
        bad(
            |v| parse_record_goals(v).err(),
            r#"{"memberId":"","goals":31}"#,
            &[
                "memberId: Too small: expected string to have >=1 characters",
                "goals: Too big: expected number to be <=30",
            ],
        );
        bad(
            |v| parse_record_goals(v).err(),
            "{}",
            &["goals: Invalid input: expected number, received undefined"],
        );
        bad(
            |v| parse_mark_attendance(v).err(),
            r#"{"memberId":"","attended":"yes","guestsArrived":9}"#,
            &[
                "memberId: Too small: expected string to have >=1 characters",
                "attended: Invalid input: expected boolean, received string",
                "guestsArrived: Too big: expected number to be <=5",
            ],
        );
        bad(
            |v| parse_team_slot(v).err(),
            r#"{"memberId":"mem_1","memberName":"Bao","guestIndex":6}"#,
            &["guestIndex: Too big: expected number to be <=5"],
        );
        bad(
            |v| parse_team_match(v).err(),
            r#"{"id":"mat_1","ordinal":0,"firstTeam":0,"secondTeam":6,"firstGoals":3,"secondGoals":31,"recordedBy":{"memberId":"mem_1","memberName":"Bao"},"recordedAt":"2026-01-01T00:00:00.000Z"}"#,
            &[
                "secondTeam: Too big: expected number to be <=5",
                "secondGoals: Too big: expected number to be <=30",
            ],
        );
        bad(
            |v| parse_team_draw(v).err(),
            r#"{"teamCount":1,"teams":[[{"memberId":"mem_1","memberName":"Bao","guestIndex":0}],[]],"drawnBy":{"memberId":"mem_1","memberName":"Bao"},"drawnAt":"2026-01-01T00:00:00.000Z","confirmedAt":null,"confirmedBy":null,"matches":[]}"#,
            &["teamCount: Too small: expected number to be >=2"],
        );
        bad(
            |v| parse_team_draw(v).err(),
            r#"{"teamCount":2,"teams":[[],[],[],[],[],[],[]],"drawnBy":{"memberId":"mem_1","memberName":"Bao"},"drawnAt":"2026-01-01T00:00:00.000Z","confirmedAt":null,"confirmedBy":null,"matches":[]}"#,
            &["teams: Too big: expected array to have <=6 items"],
        );
        bad(
            |v| parse_team_draw(v).err(),
            r#"{"teamCount":2,"teams":[[{"memberId":"","memberName":"x","guestIndex":0}]],"drawnBy":{"memberId":"mem_1","memberName":"Bao"},"drawnAt":"2026-01-01T00:00:00.000Z","confirmedAt":null,"confirmedBy":null,"matches":[]}"#,
            &["teams.0.0.memberId: Too small: expected string to have >=1 characters"],
        );
        bad(
            |v| parse_team_draw(v).err(),
            r#"{"teamCount":2,"teams":"no","drawnBy":{"memberId":"mem_1","memberName":"Bao"},"drawnAt":"2026-01-01T00:00:00.000Z","confirmedAt":null,"confirmedBy":null,"matches":[]}"#,
            &["teams: Invalid input: expected array, received string"],
        );
        bad(
            |v| parse_draw_teams(v).err(),
            r#"{"teamCount":7}"#,
            &["teamCount: Too big: expected number to be <=6"],
        );
        bad(
            |v| parse_record_match(v).err(),
            r#"{"firstGoals":-1,"secondGoals":31}"#,
            &[
                "firstGoals: Too small: expected number to be >=0",
                "secondGoals: Too big: expected number to be <=30",
            ],
        );
        bad(
            |v| parse_mvp(v).err(),
            r#"{"candidates":[],"myVote":"mem_1","tally":[],"votesCast":0,"voterCount":0,"leaders":[""]}"#,
            &["leaders.0: Too small: expected string to have >=1 characters"],
        );
        bad(
            |v| parse_cast_vote(v).err(),
            "{}",
            &["nomineeId: Invalid input: expected string, received undefined"],
        );
        bad(
            |v| parse_session_message(v).err(),
            r#"{"id":"msg_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","body":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","createdAt":"2026-01-01T00:00:00.000Z"}"#,
            &["body: Too big: expected string to have <=280 characters"],
        );
        bad(|v| parse_post_message(v).err(), r#"{"body":"   "}"#, &["body: Say something"]);
        bad(
            |v| parse_post_message(v).err(),
            r#"{"body":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}"#,
            &["body: Too big: expected string to have <=280 characters"],
        );
        bad(
            |v| parse_post_message(v).err(),
            "{}",
            &["body: Invalid input: expected string, received undefined"],
        );
        bad(
            |v| parse_form(v).err(),
            r#"{"memberId":"mem_1","recent":["in","nope"]}"#,
            &[r#"recent.1: Invalid option: expected one of "in"|"missed"|"waitlist"|"none""#],
        );
        bad(
            |v| parse_payment(v).err(),
            r#"{"id":"pay_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","amountDue":70000,"amountOverride":null,"status":"paid","hasProof":false,"note":null,"rejectReason":null,"claimedAt":null,"confirmedAt":null,"updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &[r#"status: Invalid option: expected one of "unpaid"|"pending"|"confirmed""#],
        );
        bad(
            |v| parse_payment(v).err(),
            r#"{"id":"pay_1","sessionId":"ses_1","memberId":"mem_1","memberName":"Bao","amountDue":-1,"amountOverride":null,"status":"unpaid","hasProof":false,"note":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","rejectReason":null,"claimedAt":null,"confirmedAt":null,"updatedAt":"2026-01-01T00:00:00.000Z"}"#,
            &[
                "amountDue: Too small: expected number to be >=0",
                "note: Too big: expected string to have <=300 characters",
            ],
        );
        bad(
            |v| parse_settle_session(v).err(),
            r#"{"totalCharge":500000,"granularity":0}"#,
            &["granularity: Too small: expected number to be >=1"],
        );
        bad(
            |v| parse_settle_session(v).err(),
            r#"{"totalCharge":500000,"overrides":[{"memberId":"","amount":-1}]}"#,
            &[
                "overrides.0.memberId: Too small: expected string to have >=1 characters",
                "overrides.0.amount: Too small: expected number to be >=0",
            ],
        );
        bad(
            |v| parse_settle_session(v).err(),
            r#"{"totalCharge":500000,"overrides":[{"memberId":"m0","amount":1},{"memberId":"m1","amount":1},{"memberId":"m2","amount":1},{"memberId":"m3","amount":1},{"memberId":"m4","amount":1},{"memberId":"m5","amount":1},{"memberId":"m6","amount":1},{"memberId":"m7","amount":1},{"memberId":"m8","amount":1},{"memberId":"m9","amount":1},{"memberId":"m10","amount":1},{"memberId":"m11","amount":1},{"memberId":"m12","amount":1},{"memberId":"m13","amount":1},{"memberId":"m14","amount":1},{"memberId":"m15","amount":1},{"memberId":"m16","amount":1},{"memberId":"m17","amount":1},{"memberId":"m18","amount":1},{"memberId":"m19","amount":1},{"memberId":"m20","amount":1},{"memberId":"m21","amount":1},{"memberId":"m22","amount":1},{"memberId":"m23","amount":1},{"memberId":"m24","amount":1},{"memberId":"m25","amount":1},{"memberId":"m26","amount":1},{"memberId":"m27","amount":1},{"memberId":"m28","amount":1},{"memberId":"m29","amount":1},{"memberId":"m30","amount":1},{"memberId":"m31","amount":1},{"memberId":"m32","amount":1},{"memberId":"m33","amount":1},{"memberId":"m34","amount":1},{"memberId":"m35","amount":1},{"memberId":"m36","amount":1},{"memberId":"m37","amount":1},{"memberId":"m38","amount":1},{"memberId":"m39","amount":1},{"memberId":"m40","amount":1},{"memberId":"m41","amount":1},{"memberId":"m42","amount":1},{"memberId":"m43","amount":1},{"memberId":"m44","amount":1},{"memberId":"m45","amount":1},{"memberId":"m46","amount":1},{"memberId":"m47","amount":1},{"memberId":"m48","amount":1},{"memberId":"m49","amount":1},{"memberId":"m50","amount":1},{"memberId":"m51","amount":1},{"memberId":"m52","amount":1},{"memberId":"m53","amount":1},{"memberId":"m54","amount":1},{"memberId":"m55","amount":1},{"memberId":"m56","amount":1},{"memberId":"m57","amount":1},{"memberId":"m58","amount":1},{"memberId":"m59","amount":1},{"memberId":"m60","amount":1}]}"#,
            &["overrides: Too big: expected array to have <=60 items"],
        );
        bad(
            |v| parse_settle_session(v).err(),
            "{}",
            &["totalCharge: Invalid input: expected number, received undefined"],
        );
        bad(
            |v| parse_claim_payment(v).err(),
            r#"{"note":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}"#,
            &["note: Too big: expected string to have <=300 characters"],
        );
        bad(
            |v| parse_review_payment(v).err(),
            r#"{"decision":"maybe"}"#,
            &[r#"decision: Invalid option: expected one of "confirm"|"reject""#],
        );
        bad(
            |v| parse_review_payment(v).err(),
            "{}",
            &[r#"decision: Invalid option: expected one of "confirm"|"reject""#],
        );
        bad(
            |v| parse_override_payment(v).err(),
            "{}",
            &["amount: Invalid input: expected number, received undefined"],
        );
        bad(
            |v| parse_session_detail(v).err(),
            r#"{"session":{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"registrations":[{}],"counts":{"in":0,"waitlist":0},"registrationOpen":true,"me":null}"#,
            &[
                "registrations.0.id: Invalid input: expected string, received undefined",
                "registrations.0.sessionId: Invalid input: expected string, received undefined",
                "registrations.0.memberId: Invalid input: expected string, received undefined",
                "registrations.0.memberName: Invalid input: expected string, received undefined",
                r#"registrations.0.status: Invalid option: expected one of "in"|"waitlist""#,
                "registrations.0.position: Invalid input: expected number, received undefined",
                "registrations.0.createdAt: Invalid input: expected string, received undefined",
            ],
        );
        bad(
            |v| parse_member_history_entry(v).err(),
            r#"{"session":{"id":"ses_1","startsAt":"2026-08-07T12:30:00.000Z","venueId":null,"venue":null,"status":"scheduled","feePerPerson":70000,"totalCharge":null,"maxPlayers":12,"notes":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"registrationStatus":"in","payment":null,"teams":{"team":6,"outcomes":["nope"]}}"#,
            &[
                "teams.team: Too big: expected number to be <=5",
                r#"teams.outcomes.0: Invalid option: expected one of "won"|"drawn"|"lost""#,
            ],
        );
        bad(
            |v| parse_identity(v).err(),
            r#"{"memberId":"mem_1","name":"Bao","isOrganizer":true}"#,
            &[r#"language: Invalid option: expected one of "en"|"my""#],
        );
        bad(
            |v| parse_claim(v).err(),
            r#"{"nonce":"short"}"#,
            &["nonce: Too small: expected string to have >=20 characters"],
        );
        bad(
            |v| parse_claim(v).err(),
            r#"{"nonce":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn"}"#,
            &["nonce: Too big: expected string to have <=100 characters"],
        );
        bad(
            |v| parse_group_self_add(v).err(),
            r#"{"nonce":"short","name":" "}"#,
            &[
                "nonce: Too small: expected string to have >=20 characters",
                "name: Name is required",
            ],
        );
        bad(
            |v| parse_create_member(v).err(),
            r#"{"name":[]}"#,
            &["name: Invalid input: expected string, received array", "name: Name is required"],
        );
        bad(
            |v| parse_create_member(v).err(),
            r#"{"name":[1,2]}"#,
            &["name: Invalid input: expected string, received array"],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":[],"name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false}"#,
            &[
                "id: Invalid input: expected string, received array",
                "id: Too small: expected array to have >=1 items",
            ],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":["a"],"name":[],"isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false}"#,
            &[
                "id: Invalid input: expected string, received array",
                "name: Invalid input: expected string, received array",
                "name: Too small: expected array to have >=1 items",
            ],
        );
        bad(
            |v| parse_claim(v).err(),
            r#"{"nonce":[]}"#,
            &[
                "nonce: Invalid input: expected string, received array",
                "nonce: Too small: expected array to have >=20 items",
            ],
        );
        bad(
            |v| parse_settle_session(v).err(),
            r#"{"totalCharge":1,"overrides":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}"#,
            &[
                "overrides: Invalid input: expected array, received string",
                "overrides: Too big: expected string to have <=60 characters",
            ],
        );
        bad(
            |v| parse_team_draw(v).err(),
            r#"{"teamCount":2,"teams":"xxxxxxx","drawnBy":{"memberId":"mem_1","memberName":"Bao"},"drawnAt":"2026-01-01T00:00:00.000Z","confirmedAt":null,"confirmedBy":null,"matches":[]}"#,
            &[
                "teams: Invalid input: expected array, received string",
                "teams: Too big: expected string to have <=6 characters",
            ],
        );
        bad(
            |v| parse_create_venue(v).err(),
            r#"{"name":[]}"#,
            &[
                "name: Invalid input: expected string, received array",
                "name: Venue name is required",
            ],
        );
        bad(
            |v| parse_create_venue(v).err(),
            r#"{"name":"ok","mapUrl":[]}"#,
            &["mapUrl: Invalid input"],
        );
        bad(
            |v| parse_post_message(v).err(),
            r#"{"body":[]}"#,
            &["body: Invalid input: expected string, received array", "body: Say something"],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":"mem_1","name":{},"isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false}"#,
            &["name: Invalid input: expected string, received object"],
        );
        bad(
            |v| parse_member(v).err(),
            r#"{"id":5,"name":"Bao","isOrganizer":false,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","claimedAt":null,"hasPendingLink":false}"#,
            &["id: Invalid input: expected string, received number"],
        );
    }

    /// The two string formats, against the same inputs zod was asked about.
    #[test]
    fn the_formats_answer_exactly_as_the_original() {
        // ---- z.iso.datetime()
        assert_eq!(is_iso_datetime("2026-08-07T12:30:00.000Z"), true, "2026-08-07T12:30:00.000Z");
        assert_eq!(is_iso_datetime("2026-08-07T12:30Z"), true, "2026-08-07T12:30Z");
        assert_eq!(is_iso_datetime("2026-08-07T12:30:00Z"), true, "2026-08-07T12:30:00Z");
        assert_eq!(is_iso_datetime("2026-08-07T12:30:00.1Z"), true, "2026-08-07T12:30:00.1Z");
        assert_eq!(
            is_iso_datetime("2026-08-07T12:30:00.123456789Z"),
            true,
            "2026-08-07T12:30:00.123456789Z"
        );
        assert_eq!(is_iso_datetime("2000-02-29T00:00:00Z"), true, "2000-02-29T00:00:00Z");
        assert_eq!(is_iso_datetime("1900-02-29T00:00:00Z"), false, "1900-02-29T00:00:00Z");
        assert_eq!(is_iso_datetime("2400-02-29T00:00:00Z"), true, "2400-02-29T00:00:00Z");
        assert_eq!(is_iso_datetime("2100-02-29T00:00:00Z"), false, "2100-02-29T00:00:00Z");
        assert_eq!(is_iso_datetime("2024-02-29T12:30:00Z"), true, "2024-02-29T12:30:00Z");
        assert_eq!(is_iso_datetime("2023-02-29T12:30:00Z"), false, "2023-02-29T12:30:00Z");
        assert_eq!(is_iso_datetime("2026-02-28T12:30:00Z"), true, "2026-02-28T12:30:00Z");
        assert_eq!(is_iso_datetime("2026-04-30T12:30:00Z"), true, "2026-04-30T12:30:00Z");
        assert_eq!(is_iso_datetime("2026-04-31T12:30:00Z"), false, "2026-04-31T12:30:00Z");
        assert_eq!(is_iso_datetime("2026-06-31T00:00:00Z"), false, "2026-06-31T00:00:00Z");
        assert_eq!(is_iso_datetime("2026-11-31T00:00:00Z"), false, "2026-11-31T00:00:00Z");
        assert_eq!(is_iso_datetime("2026-01-31T23:59:59Z"), true, "2026-01-31T23:59:59Z");
        assert_eq!(is_iso_datetime("2026-13-01T00:00:00Z"), false, "2026-13-01T00:00:00Z");
        assert_eq!(is_iso_datetime("2026-00-10T12:30:00Z"), false, "2026-00-10T12:30:00Z");
        assert_eq!(is_iso_datetime("2026-10-00T12:30:00Z"), false, "2026-10-00T12:30:00Z");
        assert_eq!(is_iso_datetime("2026-10-32T12:30:00Z"), false, "2026-10-32T12:30:00Z");
        assert_eq!(is_iso_datetime("0000-01-01T00:00:00Z"), true, "0000-01-01T00:00:00Z");
        assert_eq!(
            is_iso_datetime("9999-12-31T23:59:59.999999Z"),
            true,
            "9999-12-31T23:59:59.999999Z"
        );
        assert_eq!(is_iso_datetime("2026-08-07T00:00Z"), true, "2026-08-07T00:00Z");
        assert_eq!(is_iso_datetime("2026-08-07T12:30:00.Z"), false, "2026-08-07T12:30:00.Z");
        assert_eq!(is_iso_datetime("2026-08-07T12:30:00"), false, "2026-08-07T12:30:00");
        assert_eq!(
            is_iso_datetime("2026-08-07T12:30:00+00:00"),
            false,
            "2026-08-07T12:30:00+00:00"
        );
        assert_eq!(
            is_iso_datetime("2026-08-07T12:30:00+07:00"),
            false,
            "2026-08-07T12:30:00+07:00"
        );
        assert_eq!(is_iso_datetime("2026-08-07 12:30:00Z"), false, "2026-08-07 12:30:00Z");
        assert_eq!(is_iso_datetime("2026-08-07T12:30:00ZZ"), false, "2026-08-07T12:30:00ZZ");
        assert_eq!(is_iso_datetime("2026-08-07T24:00:00Z"), false, "2026-08-07T24:00:00Z");
        assert_eq!(is_iso_datetime("2026-08-07T23:60:00Z"), false, "2026-08-07T23:60:00Z");
        assert_eq!(is_iso_datetime("2026-08-07T23:59:60Z"), false, "2026-08-07T23:59:60Z");
        assert_eq!(is_iso_datetime("20260807T123000Z"), false, "20260807T123000Z");
        assert_eq!(is_iso_datetime("2026-08-07t12:30:00Z"), false, "2026-08-07t12:30:00Z");
        assert_eq!(is_iso_datetime("2026-08-07T12:30:00z"), false, "2026-08-07T12:30:00z");
        assert_eq!(is_iso_datetime("2026-8-07T12:30:00Z"), false, "2026-8-07T12:30:00Z");
        assert_eq!(is_iso_datetime(" 2026-08-07T12:30:00Z"), false, " 2026-08-07T12:30:00Z");
        assert_eq!(is_iso_datetime("2026-08-07T12:30:00Z "), false, "2026-08-07T12:30:00Z ");
        assert_eq!(is_iso_datetime("2026-08-07"), false, "2026-08-07");
        assert_eq!(is_iso_datetime(""), false, "");
        assert_eq!(is_iso_datetime("2026-08-07T25:30:00Z"), false, "2026-08-07T25:30:00Z");

        // ---- z.url()
        assert_eq!(is_url("https://a.b"), true, "https://a.b");
        assert_eq!(is_url("http://x"), true, "http://x");
        assert_eq!(is_url("HTTP://X"), true, "HTTP://X");
        assert_eq!(is_url("ftp://x/y"), true, "ftp://x/y");
        assert_eq!(is_url("x"), false, "x");
        assert_eq!(is_url(""), false, "");
        assert_eq!(is_url("https://"), false, "https://");
        assert_eq!(is_url("http://"), false, "http://");
        assert_eq!(is_url("mailto:a@b.c"), true, "mailto:a@b.c");
        assert_eq!(is_url("a.b"), false, "a.b");
        assert_eq!(is_url("https://a.b?q=1#f"), true, "https://a.b?q=1#f");
        assert_eq!(is_url("HTTPS://A.B"), true, "HTTPS://A.B");
        assert_eq!(is_url("http:example.com"), true, "http:example.com");
        assert_eq!(is_url("https:/path"), true, "https:/path");
        assert_eq!(is_url("https://例え.jp"), true, "https://例え.jp");
        assert_eq!(is_url("https://xn--r8jz45g.jp"), true, "https://xn--r8jz45g.jp");
        assert_eq!(is_url("https://a b.c"), false, "https://a b.c");
        assert_eq!(is_url("https://a.b:8080/x"), true, "https://a.b:8080/x");
        assert_eq!(is_url("https://a.b:99999"), false, "https://a.b:99999");
        assert_eq!(is_url("https://a.b:abc"), false, "https://a.b:abc");
        assert_eq!(is_url("https://[::1]/"), true, "https://[::1]/");
        assert_eq!(is_url("https://[::1"), false, "https://[::1");
        assert_eq!(is_url("https://1.2.3.4"), true, "https://1.2.3.4");
        assert_eq!(is_url("https://999.1.1.1"), false, "https://999.1.1.1");
        assert_eq!(is_url("https://1.2.3.4.5"), false, "https://1.2.3.4.5");
        assert_eq!(is_url("https://user:pw@a.b/"), true, "https://user:pw@a.b/");
        assert_eq!(is_url("https://@a.b/"), true, "https://@a.b/");
        assert_eq!(is_url("https://a.b/#"), true, "https://a.b/#");
        assert_eq!(is_url("file:///tmp/x"), true, "file:///tmp/x");
        assert_eq!(is_url("file://"), true, "file://");
        assert_eq!(is_url("foo:bar"), true, "foo:bar");
        assert_eq!(is_url("foo://"), true, "foo://");
        assert_eq!(is_url("foo:"), true, "foo:");
        assert_eq!(is_url("c:\\x"), true, "c:\\x");
        assert_eq!(is_url("javascript:alert(1)"), true, "javascript:alert(1)");
        assert_eq!(is_url("data:text/plain,hi"), true, "data:text/plain,hi");
        assert_eq!(is_url("tel:+123"), true, "tel:+123");
        assert_eq!(is_url("//a.b/c"), false, "//a.b/c");
        assert_eq!(is_url("/a/b"), false, "/a/b");
        assert_eq!(is_url("./x"), false, "./x");
        assert_eq!(is_url("https://a_b.c"), true, "https://a_b.c");
        assert_eq!(is_url("https://a.b%20c"), false, "https://a.b%20c");
        assert_eq!(is_url("https://a.b/ "), true, "https://a.b/ ");
        assert_eq!(is_url(" https://a.b "), true, " https://a.b ");
        assert_eq!(is_url("https://a..b"), true, "https://a..b");
        assert_eq!(is_url("https://.b"), true, "https://.b");
        assert_eq!(is_url("https://a.b."), true, "https://a.b.");
        assert_eq!(is_url("ws://a.b"), true, "ws://a.b");
        assert_eq!(is_url("https://a.b\\c"), true, "https://a.b\\c");
        assert_eq!(is_url("https://a.b\tc"), true, "https://a.b\tc");
        assert_eq!(is_url("https://a.b\nc"), true, "https://a.b\nc");
        assert_eq!(is_url("HTTPS://A.B/PATH"), true, "HTTPS://A.B/PATH");
        assert_eq!(is_url("https://xn--a.b"), false, "https://xn--a.b");
        assert_eq!(is_url("https://%41.b"), true, "https://%41.b");
        assert_eq!(is_url("https://a.b?"), true, "https://a.b?");
        assert_eq!(is_url("https://a.b#"), true, "https://a.b#");
        assert_eq!(is_url("https:"), false, "https:");
        assert_eq!(is_url("https://:8080"), false, "https://:8080");
        assert_eq!(is_url("https://a.b:0"), true, "https://a.b:0");
        assert_eq!(is_url("unix:/run/x.sock"), true, "unix:/run/x.sock");
        assert_eq!(is_url("urn:isbn:1"), true, "urn:isbn:1");
        assert_eq!(is_url("http://[fe80::1%25eth0]/"), false, "http://[fe80::1%25eth0]/");
        assert_eq!(is_url("http://0x7f.1/"), true, "http://0x7f.1/");
        assert_eq!(is_url("http://1/"), true, "http://1/");
        assert_eq!(is_url("https://[2001:db8::1]:443/x"), true, "https://[2001:db8::1]:443/x");
        assert_eq!(is_url("https://[1:2:3:4:5:6:7:8]/"), true, "https://[1:2:3:4:5:6:7:8]/");
        assert_eq!(is_url("https://[1:2:3:4:5:6:7:8:9]/"), false, "https://[1:2:3:4:5:6:7:8:9]/");
        assert_eq!(is_url("https://[::ffff:1.2.3.4]/"), true, "https://[::ffff:1.2.3.4]/");
        assert_eq!(is_url("https://[::1.2.3.256]/"), false, "https://[::1.2.3.256]/");
        assert_eq!(is_url("http://0300.0250.0.1/"), true, "http://0300.0250.0.1/");
        assert_eq!(is_url("http://1.2.3.4.5.6/"), false, "http://1.2.3.4.5.6/");
    }

    /// The author, or an organizer — the same pair the app trusts everywhere
    /// else it stores something one person said.
    #[test]
    fn taking_a_message_down() {
        let author = MessageViewer { member_id: "mem_1", is_organizer: false };
        let bystander = MessageViewer { member_id: "mem_2", is_organizer: false };
        let organizer = MessageViewer { member_id: "mem_2", is_organizer: true };
        assert!(can_delete_message("mem_1", &author));
        assert!(!can_delete_message("mem_1", &bystander));
        assert!(can_delete_message("mem_1", &organizer));
    }

    #[test]
    fn the_constants_are_the_originals() {
        assert_eq!(MIN_TEAMS, 2);
        assert_eq!(MAX_TEAMS, 6);
        assert_eq!(MAX_MESSAGE_LENGTH, 280);
        assert_eq!(SessionStatus::OPTIONS, &["scheduled", "cancelled", "completed"]);
        assert_eq!(RegistrationStatus::OPTIONS, &["in", "waitlist"]);
        assert_eq!(MatchOutcome::OPTIONS, &["won", "drawn", "lost"]);
        assert_eq!(PaymentStatus::OPTIONS, &["unpaid", "pending", "confirmed"]);
        assert_eq!(LeaderboardBoard::OPTIONS, &["streak", "goals", "mvp"]);
        assert_eq!(FormMark::OPTIONS, &["in", "missed", "waitlist", "none"]);
        assert_eq!(ReviewDecision::OPTIONS, &["confirm", "reject"]);
    }

    /// A body with nothing wrong with it but its shape is one issue with no
    /// path, and the API says just the message.
    #[test]
    fn an_error_with_no_path_is_rendered_alone() {
        let error = parse_register(&Value::String("nope".into())).unwrap_err();
        assert_eq!(error.issues[0].path_string(), "");
        assert_eq!(error.message(), "Invalid input: expected object, received string");
        assert_eq!(ValidationError { issues: Vec::new() }.message(), "Invalid body");
    }

    /// An absent key and an explicit null are different answers, and the routes
    /// that patch a record rely on the difference.
    #[test]
    fn absent_is_not_null() {
        let absent = parse_update_venue(&serde_json::json!({})).unwrap();
        assert_eq!(absent.address, None);
        let cleared = parse_update_venue(&serde_json::json!({ "address": null })).unwrap();
        assert_eq!(cleared.address, Some(None));
        let set = parse_update_venue(&serde_json::json!({ "address": " here " })).unwrap();
        assert_eq!(set.address, Some(Some("here".to_string())));
    }
}
