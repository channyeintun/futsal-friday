-- Picking sides.
--
-- Everybody arrives, somebody counts heads, and the group needs two or three
-- teams out of whoever is standing there. That was being done by pointing, and
-- pointing is how the same four good players end up together every week.
--
-- ## Why this is stored rather than computed
--
-- A draw derived on demand from "whoever is currently marked present" would be
-- one query and no tables — and would silently rearrange the teams every time
-- somebody was marked a no-show, a late arrival was added, or a guest count
-- was corrected. By then the teams are not rows, they are people standing in
-- two groups on a pitch. So the draw is written down once, and only a
-- deliberate reshuffle moves anybody.
--
-- ## Why anyone can write to this
--
-- No organizer column and no organizer check anywhere above this table. The
-- split happens in the two minutes before kickoff, and requiring the one
-- person with the flag to be present, awake and holding their phone would make
-- the feature useless exactly when it is wanted. Nothing here is worth money
-- or is hard to undo: the recovery from a bad draw is another draw.

CREATE TABLE team_draws (
  session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  -- Two sides is the game; six is the most a pitch could plausibly rotate.
  team_count INTEGER NOT NULL CHECK (team_count >= 2 AND team_count <= 6),
  -- Who last pressed shuffle. Not an audit trail — it is so the screen can say
  -- whose draw everyone is looking at, which is most of what settles an
  -- argument about it. SET NULL rather than CASCADE: a member leaving the
  -- group should not take the teams down with them.
  drawn_by   TEXT REFERENCES members (id) ON DELETE SET NULL,
  drawn_at   TEXT NOT NULL
);

-- One row per body on the pitch.
--
-- `guest_index` 0 is the member; 1..5 are the friends they brought. Guests get
-- their own rows because they are their own bodies in the game — three people
-- who arrived together are three players, and keeping them welded to one side
-- is precisely the imbalance a random draw exists to break up.
CREATE TABLE team_slots (
  session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  guest_index INTEGER NOT NULL CHECK (guest_index >= 0 AND guest_index <= 5),
  team        INTEGER NOT NULL CHECK (team >= 0 AND team < 6),
  -- Also the read path: every query here is "the slots for this session", and
  -- this index covers it. A board is a dozen rows, so the ordering within it
  -- is not worth a second index.
  PRIMARY KEY (session_id, member_id, guest_index)
);
