-- Trash talk.
--
-- The group already does this in the chat all week; the app was the one place
-- that knew who was playing and had nothing to say about it. A thread per
-- session, so the banter sits against the game it is about rather than
-- scrolling away above three hundred messages about lunch.
--
-- ## Why this is not gated on anything
--
-- Not on kickoff, not on having registered, not on the organizer. The winding
-- up starts days before and the gloating runs for a week after, and a thread
-- that only opens for two hours on a Friday is a thread nobody uses. The one
-- rule is that a cancelled session takes its thread down with it — there is
-- nothing to talk about.
--
-- ## Deleting
--
-- No column for it. A message is removed by its author or by an organizer —
-- the same pair the app trusts everywhere it stores something one person said
-- about themselves — and removed means gone, not hidden. Somebody will post
-- something that lands wrong, and the fix for that is for it to stop existing,
-- not to be greyed out with a tombstone saying it was there.
CREATE TABLE session_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- CASCADE, but members are soft-deleted (`active = 0`) and never actually
  -- removed, so in practice this fires only if a row is cleaned up by hand.
  member_id  TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  -- Short on purpose. This is a jab across a pitch, not a post; the cap is
  -- what keeps the thread scannable and stops one person owning the screen.
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
  created_at TEXT NOT NULL
);

-- Every read is "this session's thread, oldest first", which is this index.
CREATE INDEX idx_session_messages_session
  ON session_messages (session_id, created_at);
