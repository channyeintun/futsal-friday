//! Typed realtime events.
//!
//! The nested shape is what `@upstash/realtime` wants for its dotted event
//! paths (`player.joined` addresses `realtime_schema.player.joined`), and the
//! same object gives the client its payload types. One definition, both sides —
//! a mismatch is caught here rather than being a silent no-op at runtime.
//!
//! Payloads are deliberately *self-sufficient*: a client that receives
//! `player.joined` can update its list and its counter without issuing a
//! follow-up request. That keeps Worker requests and Upstash commands down,
//! which is the whole game on these free tiers.
//!
//! Ported from `shared/src/events.ts`. The original wrote the catalogue as zod
//! schemas — values, not types — and handed the whole object to the realtime
//! library, which validated every payload against it before anything reached
//! Redis. So the port keeps them values too: a `Rule` is one zod schema, and
//! `check` is `safeParse`, down to which keys survive it and in what order.
//! Written as Rust structs instead, the catalogue would be a type per event and
//! no way left to look one up by the name that arrived on the wire.

use serde_json::{Map, Value};

/* ----------------------------------------------------------------- channels */

/// Everything about one session fans out on its own channel.
pub fn session_channel(session_id: &str) -> String {
    format!("session:{session_id}")
}

/// Low-traffic channel for "the schedule changed" pings on the home screen.
pub const LOBBY_CHANNEL: &str = "lobby";

/* -------------------------------------------------------------- the schemas */

/// One schema, the way zod holds one: a value that can check a payload and
/// answer with the payload it accepts.
#[derive(Debug, Clone, Copy)]
enum Rule {
    /// `z.string()`, with the length bounds in UTF-16 code units — that is what
    /// `String.prototype.length` counts, and these bounds were written against
    /// it.
    Text {
        min: usize,
        max: usize,
    },
    /// `z.iso.datetime()`: an ISO-8601 UTC instant, `Z` and nothing else.
    Iso,
    /// `z.number().int()`, which in zod means a *safe* integer.
    Int {
        min: i64,
        max: i64,
    },
    Bool,
    Enum(&'static [&'static str]),
    /// `z.object()`, which strips whatever it was not asked about and answers
    /// with its own keys in its own order.
    Object(&'static [Field]),
    Array {
        of: &'static Rule,
        max: usize,
    },
    Nullable(&'static Rule),
    /// `.default(v)`: what a key that never arrived is worth.
    Defaulted(&'static Rule, Given),
}

/// One key of an object schema.
#[derive(Debug, Clone, Copy)]
struct Field {
    name: &'static str,
    rule: Rule,
}

/// The two defaults this catalogue uses.
#[derive(Debug, Clone, Copy)]
enum Given {
    Null,
    Zero,
}

impl Given {
    fn value(self) -> Value {
        match self {
            Given::Null => Value::Null,
            Given::Zero => Value::from(0),
        }
    }
}

/// JavaScript's integers stop being exact here, and so does `z.number().int()`.
const SAFE_MIN: i64 = -9_007_199_254_740_991;
const SAFE_MAX: i64 = 9_007_199_254_740_991;

const ID: Rule = Rule::Text { min: 1, max: 64 };
const TEXT: Rule = Rule::Text { min: 0, max: usize::MAX };
const ISO: Rule = Rule::Iso;
const VND: Rule = Rule::Int { min: 0, max: 1_000_000_000 };
const INT: Rule = Rule::Int { min: SAFE_MIN, max: SAFE_MAX };
const COUNT: Rule = Rule::Int { min: 0, max: SAFE_MAX };
const AVATAR_UPDATED_AT: Rule = Rule::Defaulted(&Rule::Nullable(&ISO), Given::Null);

/// Heads, not rows. `in` counts everybody standing on the pitch — members and
/// the guests they brought — because that is what the cap is about. `guests` is
/// how many of those are guests, so a screen can explain the difference between
/// "7 playing" and five names on the list.
const COUNTS: Rule = Rule::Object(&[
    Field { name: "in", rule: INT },
    Field { name: "waitlist", rule: INT },
    Field { name: "guests", rule: Rule::Defaulted(&INT, Given::Zero) },
]);

const PLAYER_JOINED: Rule = Rule::Object(&[
    Field { name: "sessionId", rule: ID },
    Field { name: "memberId", rule: ID },
    Field { name: "memberName", rule: TEXT },
    // Carried for the same reason as the name: so a client can draw the new row
    // complete, without the picture popping in on the next refresh.
    Field { name: "memberAvatarUpdatedAt", rule: AVATAR_UPDATED_AT },
    // How many friends they brought; they answer for the spots and the cost.
    Field { name: "guests", rule: Rule::Defaulted(&COUNT, Given::Zero) },
    Field { name: "status", rule: Rule::Enum(&["in", "waitlist"]) },
    Field { name: "position", rule: INT },
    Field { name: "counts", rule: COUNTS },
    Field { name: "at", rule: ISO },
]);

const PLAYER_LEFT: Rule = Rule::Object(&[
    Field { name: "sessionId", rule: ID },
    Field { name: "memberId", rule: ID },
    Field { name: "memberName", rule: TEXT },
    // Set when this withdrawal auto-promoted the first person off the waitlist.
    Field {
        name: "promoted",
        rule: Rule::Nullable(&Rule::Object(&[
            Field { name: "memberId", rule: ID },
            Field { name: "memberName", rule: TEXT },
        ])),
    },
    Field { name: "counts", rule: COUNTS },
    Field { name: "at", rule: ISO },
]);

/// Somebody said who turned up.
///
/// Carries the resulting head count so the settle screen can update the
/// suggested charge without a refetch — attendance is usually marked by several
/// people at once, in the ten minutes around kickoff.
/// Somebody already on the pitch picked a different circle.
///
/// Carries no counts, and that absence is the event. Nobody joined and nobody
/// left, so there is nothing for a viewer to recount — only one card to slide
/// across. `slot` is never null here: giving a spot up is `player.left`.
const PLAYER_MOVED: Rule = Rule::Object(&[
    Field { name: "sessionId", rule: ID },
    Field { name: "memberId", rule: ID },
    Field { name: "memberName", rule: TEXT },
    Field { name: "slot", rule: COUNT },
    Field { name: "at", rule: ISO },
]);

const PLAYER_ATTENDANCE: Rule = Rule::Object(&[
    Field { name: "sessionId", rule: ID },
    Field { name: "memberId", rule: ID },
    Field { name: "memberName", rule: TEXT },
    // `null` puts it back to unmarked.
    Field { name: "attended", rule: Rule::Nullable(&Rule::Bool) },
    Field { name: "guestsArrived", rule: Rule::Nullable(&Rule::Int { min: 0, max: 5 }) },
    // Heads now down as having played, across the whole session.
    Field { name: "arrivedHeads", rule: COUNT },
    // Who marked it — not always the person it is about.
    Field { name: "byMemberId", rule: ID },
    Field { name: "at", rule: ISO },
]);

const PAYMENT_CLAIMED: Rule = Rule::Object(&[
    Field { name: "sessionId", rule: ID },
    Field { name: "memberId", rule: ID },
    Field { name: "memberName", rule: TEXT },
    Field { name: "amountDue", rule: VND },
    Field { name: "hasProof", rule: Rule::Bool },
    Field { name: "at", rule: ISO },
]);

const PAYMENT_CONFIRMED: Rule = Rule::Object(&[
    Field { name: "sessionId", rule: ID },
    Field { name: "memberId", rule: ID },
    Field { name: "memberName", rule: TEXT },
    Field { name: "amountDue", rule: VND },
    Field { name: "at", rule: ISO },
]);

const PAYMENT_REJECTED: Rule = Rule::Object(&[
    Field { name: "sessionId", rule: ID },
    Field { name: "memberId", rule: ID },
    Field { name: "memberName", rule: TEXT },
    Field { name: "reason", rule: Rule::Nullable(&TEXT) },
    Field { name: "at", rule: ISO },
]);

/// Whoever last pressed shuffle, or confirmed, or recorded a score. Null if
/// they have since been removed.
const ACTOR: Rule =
    Rule::Object(&[Field { name: "memberId", rule: ID }, Field { name: "memberName", rule: TEXT }]);

/// `guestIndex` 0 is the member themselves; 1..5 are the guests they brought.
const TEAM_SLOT: Rule = Rule::Object(&[
    Field { name: "memberId", rule: ID },
    Field { name: "memberName", rule: TEXT },
    Field { name: "memberAvatarUpdatedAt", rule: AVATAR_UPDATED_AT },
    Field { name: "guestIndex", rule: Rule::Int { min: 0, max: 5 } },
]);

/// One fixture: two of the drawn teams, and how it finished. `firstTeam` and
/// `secondTeam` are positions in the fixture, not team letters — they index
/// into the draw's `teams`.
const TEAM_MATCH: Rule = Rule::Object(&[
    Field { name: "id", rule: ID },
    // Position in the fixture list; stable, so the order never jumps around.
    Field { name: "ordinal", rule: COUNT },
    Field { name: "firstTeam", rule: Rule::Int { min: 0, max: 5 } },
    Field { name: "secondTeam", rule: Rule::Int { min: 0, max: 5 } },
    // Both null until somebody records it. A played 0-0 is two zeroes.
    Field { name: "firstGoals", rule: Rule::Nullable(&Rule::Int { min: 0, max: 30 }) },
    Field { name: "secondGoals", rule: Rule::Nullable(&Rule::Int { min: 0, max: 30 }) },
    Field { name: "recordedBy", rule: Rule::Nullable(&ACTOR) },
    Field { name: "recordedAt", rule: Rule::Nullable(&ISO) },
]);

/// The teams as they currently stand, exactly as `models.ts` defines them —
/// `events.ts` imports this one rather than describing the board twice, and so
/// does this port, until there is a `models` module here to import it from.
const TEAM_DRAW: Rule = Rule::Object(&[
    Field { name: "teamCount", rule: Rule::Int { min: 2, max: 6 } },
    // `teams[i]` is everyone on team i. May be empty if people have left.
    Field {
        name: "teams",
        rule: Rule::Array { of: &Rule::Array { of: &TEAM_SLOT, max: usize::MAX }, max: 6 },
    },
    Field { name: "drawnBy", rule: Rule::Nullable(&ACTOR) },
    Field { name: "drawnAt", rule: ISO },
    // Null while the draw is still being argued about; once set, only an
    // organizer may move anybody.
    Field { name: "confirmedAt", rule: Rule::Nullable(&ISO) },
    Field { name: "confirmedBy", rule: Rule::Nullable(&ACTOR) },
    // Empty until the teams are confirmed, which is what generates the list.
    Field { name: "matches", rule: Rule::Array { of: &TEAM_MATCH, max: usize::MAX } },
]);

/// The team board changed: split, reshuffled, confirmed, scored or cleared.
///
/// One event for all of it, carrying the whole board. That is the point:
/// everyone is standing on the same pitch looking at the same six phones, and a
/// change that arrived as "go and refetch" would land on each of them at a
/// slightly different moment. The payload is a dozen names and a handful of
/// scorelines, so sending it costs less than the round trip it saves.
///
/// `draw` is null when the teams were cleared — the same fact ("the board is
/// now this") with nothing on it.
const TEAMS_CHANGED: Rule = Rule::Object(&[
    Field { name: "sessionId", rule: ID },
    Field { name: "draw", rule: Rule::Nullable(&TEAM_DRAW) },
    // Who did it — anybody may, so this is not implied by the session.
    Field { name: "byMemberId", rule: ID },
    Field { name: "byMemberName", rule: TEXT },
    Field { name: "at", rule: ISO },
]);

/// Somebody said something.
///
/// Carries the whole message rather than a nudge to refetch — the same rule as
/// `player.joined`, and it matters more here: a thread that goes back to the
/// server for every jab turns a five-message exchange into ten round trips on
/// fifteen phones. The board, by contrast, ships whole because it is one object
/// that changes at once; a thread only ever grows by one at the end.
const MESSAGE_POSTED: Rule = Rule::Object(&[
    Field { name: "sessionId", rule: ID },
    Field { name: "id", rule: ID },
    Field { name: "memberId", rule: ID },
    Field { name: "memberName", rule: TEXT },
    Field { name: "memberAvatarUpdatedAt", rule: AVATAR_UPDATED_AT },
    Field { name: "body", rule: TEXT },
    Field { name: "at", rule: ISO },
]);

/// Taken down by its author or an organizer. The id is all a client needs.
const MESSAGE_DELETED: Rule = Rule::Object(&[
    Field { name: "sessionId", rule: ID },
    Field { name: "id", rule: ID },
    Field { name: "byMemberId", rule: ID },
    Field { name: "at", rule: ISO },
]);

/// The MVP vote moved.
///
/// Carries nothing but the fact that it did — no nominee, no voter, no counts.
/// Every other event in this catalogue is deliberately self-sufficient so a
/// client can patch without refetching; this one deliberately is not, because
/// what it would have to carry is exactly what the read refuses to hand
/// somebody who has not voted yet. A viewer who has voted refetches and sees
/// the new tally; one who has not sees the same nothing they saw before.
const MVP_CHANGED: Rule =
    Rule::Object(&[Field { name: "sessionId", rule: ID }, Field { name: "at", rule: ISO }]);

const SESSION_UPDATED: Rule = Rule::Object(&[
    Field { name: "sessionId", rule: ID },
    Field { name: "status", rule: Rule::Enum(&["scheduled", "cancelled", "completed"]) },
    Field { name: "startsAt", rule: ISO },
    Field { name: "venueId", rule: Rule::Nullable(&ID) },
    // Why the session changed — lets the UI decide whether to refetch heavily.
    Field {
        name: "reason",
        rule: Rule::Enum(&["created", "edited", "cancelled", "settled", "completed"]),
    },
    Field { name: "at", rule: ISO },
]);

/* ---------------------------------------------------------------- catalogue */

/// The single source of truth for the event catalogue, nested the way the
/// realtime library addresses it: a group, then an event within it.
const REALTIME_SCHEMA: &[(&str, &[(&str, Rule)])] = &[
    (
        "player",
        &[
            ("joined", PLAYER_JOINED),
            ("left", PLAYER_LEFT),
            ("moved", PLAYER_MOVED),
            ("attendance", PLAYER_ATTENDANCE),
        ],
    ),
    (
        "payment",
        &[
            ("claimed", PAYMENT_CLAIMED),
            ("confirmed", PAYMENT_CONFIRMED),
            ("rejected", PAYMENT_REJECTED),
        ],
    ),
    ("teams", &[("changed", TEAMS_CHANGED)]),
    ("message", &[("posted", MESSAGE_POSTED), ("deleted", MESSAGE_DELETED)]),
    ("mvp", &[("changed", MVP_CHANGED)]),
    ("session", &[("updated", SESSION_UPDATED)]),
];

pub const EVENT_NAMES: [&str; 12] = [
    "player.joined",
    "player.left",
    "player.moved",
    "player.attendance",
    "payment.claimed",
    "payment.confirmed",
    "payment.rejected",
    "teams.changed",
    "message.posted",
    "message.deleted",
    "mvp.changed",
    "session.updated",
];

/// The schema an event path addresses, or `None` if it addresses none.
///
/// The original walked the nested object one path element at a time and
/// answered `null` unless it landed on a schema, so a path that stops at a
/// group (`player`), runs past a schema (`player.joined.extra`) or names a key
/// that only exists on `Object.prototype` is not an event.
fn lookup_schema(path: &[&str]) -> Option<&'static Rule> {
    let [group, event] = path else {
        return None;
    };
    let events = REALTIME_SCHEMA.iter().find(|(name, _)| name == group)?.1;
    events.iter().find(|(name, _)| name == event).map(|(_, rule)| rule)
}

/// The schema for one dotted event name, e.g. `player.joined`.
///
/// This is what the Worker validates an outgoing payload with — the original
/// handed the whole catalogue to `new Realtime({ schema })` and let the library
/// do it before anything reached Redis.
pub fn validate_payload(name: &str, data: &Value) -> Option<Value> {
    let path: Vec<&str> = name.split('.').collect();
    check(lookup_schema(&path)?, data)
}

/* -------------------------------------------------------------------- types */

/// One event, named and addressed: what a client acts on.
#[derive(Debug, Clone, PartialEq)]
pub struct RealtimeEvent {
    pub name: String,
    pub channel: String,
    pub data: Value,
}

/* --------------------------------------------------------------- wire format */

/// Narrow a raw SSE frame into a typed application event, or `None` if it is a
/// system frame / an event this build does not know about. Unknown events are
/// ignored rather than raised so an older client survives a newer server.
pub fn parse_wire_event(raw: &Value) -> Option<RealtimeEvent> {
    let frame = raw.as_object()?;
    // `__event_path: z.array(z.string())`, and the two optional strings are
    // still checked when they are there.
    let path: Vec<&str> = frame
        .get("__event_path")?
        .as_array()?
        .iter()
        .map(|part| part.as_str())
        .collect::<Option<_>>()?;
    for key in ["__stream_id", "__channel"] {
        if !is_optional_string(frame.get(key)) {
            return None;
        }
    }

    let name = path.join(".");
    let schema = lookup_schema(&path)?;
    // `data: z.unknown()`, so a frame without one reaches the payload schema as
    // nothing at all — and every payload is an object, which nothing is not.
    let payload = check(schema, frame.get("data").unwrap_or(&Value::Null))?;

    Some(RealtimeEvent {
        name,
        channel: frame.get("__channel").and_then(Value::as_str).unwrap_or("").to_string(),
        data: payload,
    })
}

fn is_optional_string(field: Option<&Value>) -> bool {
    match field {
        None => true,
        Some(value) => value.is_string(),
    }
}

/// The system frames `@upstash/realtime`'s `handle()` puts on the same stream.
///
/// Mirrored here (rather than imported) so the frontend never has to depend on
/// the server library, and so a different transport could speak the same
/// protocol.
#[derive(Debug, Clone, PartialEq)]
pub enum WireSystemEvent {
    Connected { channel: String, cursor: Option<String> },
    Reconnect,
    Error { error: String },
    Disconnected { channel: String },
    Ping { timestamp: f64 },
}

/// The union is tried in the order it is written, first match winning.
pub fn parse_wire_system_event(raw: &Value) -> Option<WireSystemEvent> {
    let frame = raw.as_object()?;
    let text = |key: &str| frame.get(key).and_then(Value::as_str).map(str::to_string);
    match frame.get("type").and_then(Value::as_str)? {
        "connected" => {
            if !is_optional_string(frame.get("cursor")) {
                return None;
            }
            Some(WireSystemEvent::Connected { channel: text("channel")?, cursor: text("cursor") })
        }
        "reconnect" => Some(WireSystemEvent::Reconnect),
        "error" => Some(WireSystemEvent::Error { error: text("error")? }),
        "disconnected" => Some(WireSystemEvent::Disconnected { channel: text("channel")? }),
        "ping" => Some(WireSystemEvent::Ping { timestamp: frame.get("timestamp")?.as_f64()? }),
        _ => None,
    }
}

/* ----------------------------------------------------------------- checking */

/// `safeParse`: the value a schema accepts, or `None`.
///
/// An object answers with *its own* keys, in its own order, whatever order they
/// arrived in and whatever else came with them — a client that is handed the
/// result reads the catalogue's shape, not the sender's.
fn check(rule: &Rule, value: &Value) -> Option<Value> {
    match rule {
        Rule::Text { min, max } => {
            let text = value.as_str()?;
            let length = text.encode_utf16().count();
            (length >= *min && length <= *max).then(|| value.clone())
        }
        Rule::Iso => {
            let text = value.as_str()?;
            is_iso_datetime(text).then(|| value.clone())
        }
        Rule::Int { min, max } => {
            let number = safe_integer(value)?;
            (number >= *min && number <= *max).then(|| Value::from(number))
        }
        Rule::Bool => value.as_bool().map(Value::Bool),
        Rule::Enum(options) => {
            let text = value.as_str()?;
            options.contains(&text).then(|| value.clone())
        }
        Rule::Object(fields) => {
            let given = value.as_object()?;
            let mut out = Map::with_capacity(fields.len());
            for field in *fields {
                let taken = match given.get(field.name) {
                    Some(found) => check(&field.rule, found)?,
                    // Absent: only a `.default()` saves it, and the default is
                    // taken as written rather than parsed again.
                    None => match field.rule {
                        Rule::Defaulted(_, given) => given.value(),
                        _ => return None,
                    },
                };
                out.insert(field.name.to_string(), taken);
            }
            Some(Value::Object(out))
        }
        Rule::Array { of, max } => {
            let items = value.as_array()?;
            if items.len() > *max {
                return None;
            }
            items.iter().map(|item| check(of, item)).collect::<Option<Vec<_>>>().map(Value::Array)
        }
        Rule::Nullable(inner) => {
            if value.is_null() {
                Some(Value::Null)
            } else {
                check(inner, value)
            }
        }
        Rule::Defaulted(inner, _) => check(inner, value),
    }
}

/// `z.number().int()` is a *safe* integer: past 2^53 JavaScript's numbers stop
/// counting one at a time, so a payload that carried one never meant it.
fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_number()?;
    let whole = if let Some(exact) = number.as_i64() {
        exact
    } else {
        let float = number.as_f64()?;
        if float.fract() != 0.0 {
            return None;
        }
        if !(SAFE_MIN as f64..=SAFE_MAX as f64).contains(&float) {
            return None;
        }
        float as i64
    };
    (SAFE_MIN..=SAFE_MAX).contains(&whole).then_some(whole)
}

/// `z.iso.datetime()`: `YYYY-MM-DDTHH:MM[:SS[.frac]]Z`, and nothing else.
///
/// Seconds are optional, the fraction is any number of digits, and the zone is
/// literally `Z` — an offset is a different instant written a different way,
/// and everything crossing this API is UTC. The calendar is checked as well as
/// the shape: 31 April and a 29 February outside a leap year are both refused.
fn is_iso_datetime(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() < 17 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return false;
    }
    let digits = |from: usize, to: usize| -> Option<u32> {
        let field = bytes.get(from..to).filter(|field| !field.is_empty())?;
        field
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| field.iter().fold(0u32, |sum, byte| sum * 10 + u32::from(byte - b'0')))
    };
    let (Some(year), Some(month), Some(day)) = (digits(0, 4), digits(5, 7), digits(8, 10)) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let last = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    if day < 1 || day > last {
        return false;
    }

    if bytes[13] != b':' {
        return false;
    }
    let (Some(hour), Some(minute)) = (digits(11, 13), digits(14, 16)) else {
        return false;
    };
    if hour > 23 || minute > 59 {
        return false;
    }

    let mut at = 16;
    if bytes[at] == b':' {
        let Some(second) = digits(at + 1, at + 3) else {
            return false;
        };
        if second > 59 {
            return false;
        }
        at += 3;
        if at < bytes.len() && bytes[at] == b'.' {
            at += 1;
            let start = at;
            while at < bytes.len() && bytes[at].is_ascii_digit() {
                at += 1;
            }
            if at == start {
                return false;
            }
        }
    }
    at + 1 == bytes.len() && bytes[at] == b'Z'
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ISO: &str = "2026-08-07T12:30:00.000Z";

    /// What `JSON.stringify` printed on the other side, so the comparison is
    /// over the keys, their order and their values at once.
    fn shown(event: Option<RealtimeEvent>) -> String {
        match event {
            None => "null".to_string(),
            Some(event) => {
                let mut out = Map::new();
                out.insert("name".into(), Value::String(event.name));
                out.insert("channel".into(), Value::String(event.channel));
                out.insert("data".into(), event.data);
                serde_json::to_string(&Value::Object(out)).unwrap()
            }
        }
    }

    #[test]
    fn channels_and_the_catalogue() {
        assert_eq!(session_channel("ses_1"), "session:ses_1");
        assert_eq!(LOBBY_CHANNEL, "lobby");
        assert_eq!(
            EVENT_NAMES,
            [
                "player.joined",
                "player.left",
                "player.moved",
                "player.attendance",
                "payment.claimed",
                "payment.confirmed",
                "payment.rejected",
                "teams.changed",
                "message.posted",
                "message.deleted",
                "mvp.changed",
                "session.updated",
            ]
        );
        for name in EVENT_NAMES {
            assert!(validate_payload(name, &json!({})).is_none(), "{name} has a schema");
        }
    }

    /// The frame arrives with its keys in the sender's order and an extra one
    /// nobody asked for; the event comes out in the catalogue's order without
    /// it. Both expected strings were printed by `shared/src/events.ts`.
    #[test]
    fn a_frame_becomes_an_event() {
        let frame = json!({
            "__channel": "session:1",
            "__event_path": ["message", "posted"],
            "data": {
                "at": ISO,
                "body": "hi",
                "memberName": "Bao",
                "memberId": "m1",
                "id": "x1",
                "sessionId": "s1",
                "extra": 5,
            },
        });
        assert_eq!(
            shown(parse_wire_event(&frame)),
            r#"{"name":"message.posted","channel":"session:1","data":{"sessionId":"s1","id":"x1","memberId":"m1","memberName":"Bao","memberAvatarUpdatedAt":null,"body":"hi","at":"2026-08-07T12:30:00.000Z"}}"#
        );

        // No `__channel` at all: the channel is the empty string, not an error.
        let frame = json!({
            "__event_path": ["mvp", "changed"],
            "__stream_id": "1-0",
            "data": { "sessionId": "s", "at": ISO },
        });
        assert_eq!(
            shown(parse_wire_event(&frame)),
            r#"{"name":"mvp.changed","channel":"","data":{"sessionId":"s","at":"2026-08-07T12:30:00.000Z"}}"#
        );
    }

    /// Every `.default()` in the catalogue, filled in on the way through.
    #[test]
    fn the_keys_that_did_not_arrive() {
        let frame = json!({
            "__event_path": ["player", "joined"],
            "data": {
                "sessionId": "s1", "memberId": "m1", "memberName": "Bao",
                "status": "waitlist", "position": 12,
                "counts": { "in": 10, "waitlist": 1 },
                "at": ISO,
            },
        });
        assert_eq!(
            shown(parse_wire_event(&frame)),
            r#"{"name":"player.joined","channel":"","data":{"sessionId":"s1","memberId":"m1","memberName":"Bao","memberAvatarUpdatedAt":null,"guests":0,"status":"waitlist","position":12,"counts":{"in":10,"waitlist":1,"guests":0},"at":"2026-08-07T12:30:00.000Z"}}"#
        );
    }

    /// `teams.changed` carries the whole board, so the whole board is checked —
    /// nested slots, nested matches, and an actor with a key too many.
    #[test]
    fn the_whole_board_rides_along() {
        let frame = json!({
            "__event_path": ["teams", "changed"],
            "__channel": "session:ses_1",
            "data": {
                "sessionId": "ses_1",
                "draw": {
                    "teamCount": 2,
                    "teams": [
                        [{ "memberId": "m1", "memberName": "Bao", "guestIndex": 0 }],
                        [{ "memberId": "m2", "memberName": "Linh", "memberAvatarUpdatedAt": ISO, "guestIndex": 1 }],
                    ],
                    "drawnBy": { "memberId": "m1", "memberName": "Bao", "extra": 9 },
                    "drawnAt": ISO,
                    "confirmedAt": null,
                    "confirmedBy": null,
                    "matches": [{
                        "id": "mat_0", "ordinal": 0, "firstTeam": 0, "secondTeam": 1,
                        "firstGoals": 3, "secondGoals": 2, "recordedBy": null, "recordedAt": null,
                    }],
                },
                "byMemberId": "m1",
                "byMemberName": "Bao",
                "at": ISO,
            },
        });
        assert_eq!(
            shown(parse_wire_event(&frame)),
            r#"{"name":"teams.changed","channel":"session:ses_1","data":{"sessionId":"ses_1","draw":{"teamCount":2,"teams":[[{"memberId":"m1","memberName":"Bao","memberAvatarUpdatedAt":null,"guestIndex":0}],[{"memberId":"m2","memberName":"Linh","memberAvatarUpdatedAt":"2026-08-07T12:30:00.000Z","guestIndex":1}]],"drawnBy":{"memberId":"m1","memberName":"Bao"},"drawnAt":"2026-08-07T12:30:00.000Z","confirmedAt":null,"confirmedBy":null,"matches":[{"id":"mat_0","ordinal":0,"firstTeam":0,"secondTeam":1,"firstGoals":3,"secondGoals":2,"recordedBy":null,"recordedAt":null}]},"byMemberId":"m1","byMemberName":"Bao","at":"2026-08-07T12:30:00.000Z"}}"#
        );
    }

    /// An older client meeting a newer server: nothing it does not recognise
    /// reaches it, and nothing raises.
    #[test]
    fn frames_this_build_cannot_use() {
        let good = json!({ "sessionId": "s", "at": ISO });
        for frame in [
            // An event from a later build.
            json!({ "__event_path": ["nope", "nothing"], "data": {} }),
            // A path that stops at a group, or runs past a schema.
            json!({ "__event_path": ["mvp"], "data": good }),
            json!({ "__event_path": ["mvp", "changed", "more"], "data": good }),
            json!({ "__event_path": [], "data": good }),
            // The dotted name is not a path.
            json!({ "__event_path": ["mvp.changed"], "data": good }),
            // A key that only exists because everything in JavaScript has one.
            json!({ "__event_path": ["constructor"], "data": good }),
            // No payload, or one that is not an object.
            json!({ "__event_path": ["mvp", "changed"] }),
            json!({ "__event_path": ["mvp", "changed"], "data": null }),
            json!({ "__event_path": ["mvp", "changed"], "data": [] }),
            // A payload that fails its schema.
            json!({ "__event_path": ["mvp", "changed"], "data": { "sessionId": "", "at": ISO } }),
            json!({ "__event_path": ["mvp", "changed"], "data": { "sessionId": "s", "at": "2026-02-29T00:00:00Z" } }),
            // The frame itself is malformed.
            json!({ "__event_path": "mvp.changed", "data": good }),
            json!({ "__event_path": [1, 2], "data": good }),
            json!({ "__event_path": ["mvp", "changed"], "data": good, "__channel": 3 }),
            json!({ "__event_path": ["mvp", "changed"], "data": good, "__stream_id": null }),
            json!({ "data": good }),
            json!([]),
            json!(null),
            json!("mvp.changed"),
        ] {
            assert_eq!(parse_wire_event(&frame), None, "{frame}");
        }
    }

    /// What the Worker does before anything reaches Redis.
    #[test]
    fn payloads_are_checked_before_they_are_sent() {
        let claim = json!({
            "sessionId": "ses_1", "memberId": "m1", "memberName": "Bao",
            "amountDue": 120_000, "hasProof": false, "at": ISO, "extra": 1,
        });
        assert_eq!(
            serde_json::to_string(&validate_payload("payment.claimed", &claim).unwrap()).unwrap(),
            r#"{"sessionId":"ses_1","memberId":"m1","memberName":"Bao","amountDue":120000,"hasProof":false,"at":"2026-08-07T12:30:00.000Z"}"#
        );

        // A dong over the ceiling is a typo, not a bill.
        let over = json!({
            "sessionId": "ses_1", "memberId": "m1", "memberName": "Bao",
            "amountDue": 1_000_000_001i64, "hasProof": false, "at": ISO,
        });
        assert_eq!(validate_payload("payment.claimed", &over), None);
        assert_eq!(validate_payload("payment.nothing", &claim), None);

        // `null` is a value here, not an absence: unmarked attendance.
        let unmarked = json!({
            "sessionId": "ses_1", "memberId": "m1", "memberName": "Bao", "attended": null,
            "guestsArrived": null, "arrivedHeads": 7, "byMemberId": "m2", "at": ISO,
        });
        assert_eq!(
            serde_json::to_string(&validate_payload("player.attendance", &unmarked).unwrap())
                .unwrap(),
            r#"{"sessionId":"ses_1","memberId":"m1","memberName":"Bao","attended":null,"guestsArrived":null,"arrivedHeads":7,"byMemberId":"m2","at":"2026-08-07T12:30:00.000Z"}"#
        );
    }

    #[test]
    fn the_stream_says_what_it_is_doing() {
        assert_eq!(
            parse_wire_system_event(&json!({ "type": "connected", "channel": "session:1" })),
            Some(WireSystemEvent::Connected { channel: "session:1".into(), cursor: None })
        );
        assert_eq!(
            parse_wire_system_event(
                &json!({ "type": "connected", "channel": "c", "cursor": "1-0" })
            ),
            Some(WireSystemEvent::Connected { channel: "c".into(), cursor: Some("1-0".into()) })
        );
        assert_eq!(
            parse_wire_system_event(&json!({ "type": "reconnect" })),
            Some(WireSystemEvent::Reconnect)
        );
        assert_eq!(
            parse_wire_system_event(&json!({ "type": "error", "error": "gone" })),
            Some(WireSystemEvent::Error { error: "gone".into() })
        );
        assert_eq!(
            parse_wire_system_event(&json!({ "type": "disconnected", "channel": "c" })),
            Some(WireSystemEvent::Disconnected { channel: "c".into() })
        );
        assert_eq!(
            parse_wire_system_event(&json!({ "type": "ping", "timestamp": 1_754_656_200_000i64 })),
            Some(WireSystemEvent::Ping { timestamp: 1_754_656_200_000.0 })
        );
        for frame in [
            json!({ "type": "connected" }),
            json!({ "type": "connected", "channel": 7 }),
            json!({ "type": "connected", "channel": "c", "cursor": 7 }),
            json!({ "type": "ping" }),
            json!({ "type": "ping", "timestamp": "soon" }),
            json!({ "type": "nope" }),
            json!({ "channel": "c" }),
            json!(null),
        ] {
            assert_eq!(parse_wire_system_event(&frame), None, "{frame}");
        }
    }
}
