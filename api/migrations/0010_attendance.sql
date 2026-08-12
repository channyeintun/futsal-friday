-- Who actually turned up, as opposed to who said they would.
--
-- Registering and arriving were the same fact until now, and both the money
-- and the streaks were wrong because of it: a no-show was billed a full share,
-- which quietly under-charged everybody who did play, and their attendance
-- streak survived a game they never came to.
--
-- ## Why this is nullable rather than a boolean defaulting to 0
--
-- The failure modes are not symmetrical. If arriving needs a tap, then every
-- player who forgets one drops out of the split and the people who did tap
-- cover them — a wrong bill, every week, caused by inaction. If *not* arriving
-- needs a tap, the only wrong bills are the weeks somebody no-shows and nobody
-- says so, which is rarer, self-correcting once anyone notices, and no worse
-- than the behaviour being replaced.
--
-- So NULL means "nobody has said", and is read as presence for a player who is
-- in and absence for one on the waitlist. That is the presumption, not a
-- stored value: leaving it NULL keeps "nobody marked this" distinguishable
-- from "somebody confirmed it", which matters when the organiser is looking at
-- a split and wondering whether the roster has been checked at all.
--
--   NULL  no one has said        -> presumed from status
--   1     explicitly arrived     -> counted, whatever the status
--   0     explicitly a no-show   -> not counted, whatever the status
--
-- Marking a waitlisted player as arrived is deliberately expressible: when
-- somebody no-shows without withdrawing, the reserve who stepped onto the
-- pitch was never promoted, and they still owe for the game they played.
ALTER TABLE registrations ADD COLUMN attended INTEGER
  CHECK (attended IN (0, 1));

-- How many of the guests actually came.
--
-- NULL means "as registered" rather than zero, so bringing two friends and
-- saying nothing still bills for two. Only the person who turned up with one
-- fewer mate than planned has to touch it.
ALTER TABLE registrations ADD COLUMN guests_arrived INTEGER
  CHECK (guests_arrived >= 0 AND guests_arrived <= 5);

-- Who marked it and when.
--
-- Attendance decides what people are charged, so it needs the same
-- accountability as any other money-adjacent edit: if a share looks wrong, the
-- first question is who said that person was not there.
ALTER TABLE registrations ADD COLUMN attendance_marked_at TEXT;
ALTER TABLE registrations ADD COLUMN attendance_marked_by TEXT
  REFERENCES members (id) ON DELETE SET NULL;
