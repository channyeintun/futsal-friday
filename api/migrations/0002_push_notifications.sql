-- Migration 0002 — Web Push subscriptions and delivery bookkeeping.

-- One row per browser/device a member has enabled reminders on. People install
-- the PWA on more than one device, so this is deliberately many-per-member.
CREATE TABLE push_subscriptions (
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  -- The push service URL. Unique because re-subscribing the same browser
  -- returns the same endpoint, and we want an upsert rather than a duplicate.
  endpoint      TEXT NOT NULL UNIQUE,
  -- RFC 8291 subscriber keys, base64url as the browser hands them over.
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  -- Rough device label ("iPhone Safari") so a member can tell which is which.
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  last_success_at TEXT,
  -- Consecutive delivery failures. A push service returning 404/410 means the
  -- subscription is dead and the row is deleted outright; softer errors just
  -- increment this so a flapping endpoint eventually stops being retried.
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_push_subscriptions_member ON push_subscriptions (member_id);

-- What has already been sent, so the hourly cron is idempotent.
--
-- `dedupe_key` is what makes a notification "the same" notification:
--   session reminder -> 'session_reminder:<session_id>'   (once, ever)
--   payment nudge    -> 'payment_due:<session_id>:<YYYY-Www>' (at most weekly)
-- Retrying an hour later, or a cron that fires twice, therefore sends nothing.
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('session_reminder', 'payment_due')),
  dedupe_key TEXT NOT NULL,
  sent_at    TEXT NOT NULL,
  UNIQUE (member_id, dedupe_key)
);

CREATE INDEX idx_notifications_sent_at ON notifications (sent_at);

-- Per-member reminder preferences. Defaults are on: somebody who went to the
-- trouble of granting the browser permission wants the reminders.
ALTER TABLE members ADD COLUMN notify_session INTEGER NOT NULL DEFAULT 1
  CHECK (notify_session IN (0, 1));
ALTER TABLE members ADD COLUMN notify_payment INTEGER NOT NULL DEFAULT 1
  CHECK (notify_payment IN (0, 1));
