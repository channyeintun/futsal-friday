-- Goals scored, per player per game.
--
-- On the registration rather than a table of its own: a goal belongs to one
-- person in one match, which is exactly what a registration row already is.
-- A separate `goals` table would buy the ability to record *when* each went
-- in, which nobody is going to type in on a phone after playing for an hour.
--
-- Self-reported, like attendance, and for the same reason — the organiser is
-- not going to keep score for fifteen people. Also like attendance, an
-- organiser can correct anybody, because the person who over-claims is not the
-- person who will fix it.
--
-- Capped at 30. Futsal scores run high and a hat-trick is unremarkable, but a
-- number past thirty is a typo or a joke, and an uncapped integer here would
-- put whoever typed it at the top of the leaderboard for ever.
ALTER TABLE registrations ADD COLUMN goals INTEGER NOT NULL DEFAULT 0
  CHECK (goals >= 0 AND goals <= 30);

-- Ranking reads sort by this, and a leaderboard is the one screen where every
-- member is touched at once.
CREATE INDEX IF NOT EXISTS idx_registrations_goals
  ON registrations (member_id, goals);
