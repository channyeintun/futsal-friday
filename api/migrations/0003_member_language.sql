-- Migration 0003 — per-member language.
--
-- Push notification text is written on the server, so the member's language has
-- to live in the database: the browser that chose it is asleep when the
-- reminder goes out. The frontend keeps its own copy for instant switching, but
-- this column is what the cron reads.
--
-- 'en' rather than the device language as the default, because a row can be
-- created by an organizer on someone else's behalf, long before that person
-- first opens the app and their real preference is known.
ALTER TABLE members ADD COLUMN language TEXT NOT NULL DEFAULT 'en'
  CHECK (language IN ('en', 'my'));
