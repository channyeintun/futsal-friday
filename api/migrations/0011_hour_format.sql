-- 12-hour or 24-hour, per member.
--
-- Stored on the member rather than only in the browser for the same reason
-- `language` is: the cron writes push notifications on the server, and a
-- reminder that says "19:30" to somebody whose app says "7:30 PM" is the kind
-- of small inconsistency that reads as a bug.
--
-- Default 0 — 24-hour — because that is what the app has always shown and what
-- Vietnam uses on every pitch booking; nobody's existing screens change.
ALTER TABLE members ADD COLUMN hour12 INTEGER NOT NULL DEFAULT 0
  CHECK (hour12 IN (0, 1));
