-- Confirming the teams, and the games that follow from them.
--
-- ## Confirmation
--
-- A draw starts as a proposal. Anybody may reshuffle it, which is what makes a
-- random split socially workable: the group that thinks one side looks strong
-- presses the button again instead of arguing about it.
--
-- That has to stop at some point, and the point is when people put bibs on.
-- After confirmation the teams are not a suggestion any more — they are who is
-- standing where, and results start being recorded against them — so only an
-- organizer can pull them apart. Storing *when* rather than a flag: the screen
-- wants to say how long ago it was settled, and a nullable timestamp already
-- carries the boolean.
ALTER TABLE team_draws ADD COLUMN confirmed_at TEXT;
ALTER TABLE team_draws ADD COLUMN confirmed_by TEXT
  REFERENCES members (id) ON DELETE SET NULL;

-- The fixture list.
--
-- ## Why the pairing is written down before the match, not after
--
-- Recording who played whom at full time means asking people that question as
-- they walk off the pitch, which is the one moment nobody wants to be asked
-- anything — and with three sides rotating for an hour it is a question they
-- will get wrong. So confirming the teams generates every fixture at once
-- (everyone plays everyone), and finishing a game only ever means putting a
-- score against a line that is already on the screen.
--
-- `first_team` and `second_team` are indexes into the draw's teams — 0 is the
-- side shown first — not team letters and not member ids. They are stored with
-- first < second so a fixture cannot exist twice under two orderings.
CREATE TABLE team_matches (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- Position in the list. Fixed at generation so the order never reshuffles
  -- under somebody halfway through entering a score.
  ordinal       INTEGER NOT NULL,
  first_team    INTEGER NOT NULL CHECK (first_team >= 0 AND first_team < 6),
  second_team   INTEGER NOT NULL CHECK (second_team > first_team AND second_team < 6),
  -- NULL on both until somebody records it. A game that finished nil-nil is
  -- two zeroes, and is a different fact from a game not yet played — the same
  -- distinction attendance draws, for the same reason.
  --
  -- The ceiling here is deliberately looser than the API's, which stops at 30
  -- alongside every other goal count. This is the backstop, not the rule.
  first_goals   INTEGER CHECK (first_goals IS NULL OR (first_goals >= 0 AND first_goals <= 50)),
  second_goals  INTEGER CHECK (second_goals IS NULL OR (second_goals >= 0 AND second_goals <= 50)),
  recorded_at   TEXT,
  recorded_by   TEXT REFERENCES members (id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);

-- Every read is "the fixtures for this session, in order", and this covers it.
CREATE UNIQUE INDEX idx_team_matches_slot ON team_matches (session_id, ordinal);
