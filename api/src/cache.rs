//! A small key/value cache on the Redis that is already here for realtime.
//!
//! The leaderboard is the reason this exists. Every visit to that screen ran
//! five queries over the whole history window and then computed a streak per
//! member in Rust — work that is identical for every viewer and changes only
//! when somebody plays, scores, wins an award or joins the group. Doing it per
//! request meant the cost grew with how often people looked at it, which is
//! exactly backwards: a board is looked at far more often than it changes.
//!
//! ## Why this is a cache and not a table
//!
//! Storing the computed board in D1 would make it a second source of truth, and
//! the first thing that goes wrong with those is that they disagree. A cache
//! cannot disagree for long: it is deleted whenever anything it was derived
//! from changes, and it carries a time to live so that a missed invalidation
//! costs one stale hour rather than forever. Both of those are properties the
//! table version would have to be given by hand.
//!
//! ## Failure is not an error
//!
//! Every operation here swallows its errors and reports a miss. Redis being
//! unreachable must mean the leaderboard is slow, never that it is broken —
//! and the same is true of realtime being switched off entirely, which is the
//! normal state of a local development environment.

use serde_json::Value;
use worker::{Env, Result as WorkerResult};

use crate::realtime::{redis_pipeline, upstash_rest};

/// Everything derived from the whole history: the leaderboard, for now.
///
/// One key rather than one per board, because the three boards are three sorts
/// of the same computation — `load_leaderboard` produces every figure and the
/// route picks among them. Versioned so a change to the shape of what is stored
/// cannot be read back by the code that expects the old one; bump it whenever
/// `LeaderboardEntry` gains or loses a field.
pub const LEADERBOARD_KEY: &str = "cache:leaderboard:v1";

/// An hour.
///
/// Not the invalidation mechanism — that is `forget`, called from everything
/// that changes a figure on the board. This is the backstop for the case where
/// one of those calls is missed or its Redis write fails: an hour of staleness
/// on a board that is mostly about a season is a blemish, where forever is a
/// bug. Chosen against the cron, which warms it well inside that window.
const TTL_SECONDS: i64 = 3600;

/// The cached value, or `None` for a miss, a disabled cache, or any failure.
pub async fn get(env: &Env, key: &str) -> Option<Value> {
    let (base_url, token) = upstash_rest(env)?;
    let commands = serde_json::json!([["GET", key]]);
    let response = redis_pipeline(&base_url, &token, &commands).await.ok()?;
    let raw = response.get(0)?.get("result")?.as_str()?;
    serde_json::from_str(raw).ok()
}

/// Store, with the standing time to live. Silent on failure.
pub async fn put(env: &Env, key: &str, value: &Value) -> WorkerResult<()> {
    let Some((base_url, token)) = upstash_rest(env) else { return Ok(()) };
    let commands =
        serde_json::json!([["SET", key, value.to_string(), "EX", TTL_SECONDS.to_string()]]);
    if let Err(error) = redis_pipeline(&base_url, &token, &commands).await {
        // A cache that cannot be written is a cache that will be recomputed.
        worker::console_log!("[cache] could not store {key}: {error}");
    }
    Ok(())
}

/// Drop a key, because something it was derived from has changed.
///
/// Deliberately a delete rather than a recompute. Recomputing here would put
/// the cost of rebuilding the board inside whichever request happened to change
/// a goal, and that request is somebody standing at a pitch marking a score.
/// The next reader pays instead — or, more often, nobody does, because the cron
/// gets there first.
pub async fn forget(env: &Env, key: &str) {
    let Some((base_url, token)) = upstash_rest(env) else { return };
    let commands = serde_json::json!([["DEL", key]]);
    if let Err(error) = redis_pipeline(&base_url, &token, &commands).await {
        worker::console_log!("[cache] could not drop {key}: {error}");
    }
}

/// The one call sites use, so nobody has to remember the key.
pub async fn forget_leaderboard(env: &Env) {
    forget(env, LEADERBOARD_KEY).await;
}
