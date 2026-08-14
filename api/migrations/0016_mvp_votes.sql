-- Who was the best today.
--
-- One vote each, for somebody else, on a game you were at. The winner is
-- whoever has the most; ties are ties and the app says so rather than
-- inventing a tiebreak nobody agreed to.
--
-- ## Anonymous
--
-- `voter_id` is here because the table cannot work without it — it is what
-- makes a vote *one* vote, and what lets somebody change their mind — but it
-- is server-side only and must stay that way. Nothing that leaves the Worker
-- carries it: the API returns a tally and the caller's own choice, and the
-- realtime event carries counts alone.
--
-- That is worth stating in the schema because the natural next feature is
-- "who voted for me", and shipping it would retroactively change what everyone
-- who has already voted was promised.
--
-- Small-group inference is not solved by any of this and cannot be: with four
-- people who played, the second voter learns a lot from the tally. The point
-- is that the app does not *hand* anyone the answer.
CREATE TABLE mvp_votes (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  voter_id   TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  -- No self-votes: the CHECK is the backstop, the API is the rule. Voting for
  -- yourself is not a bug to be tolerated, it is the joke that ruins the award.
  nominee_id TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE
    CHECK (nominee_id <> voter_id),
  created_at TEXT NOT NULL,
  -- One vote per person per session, and changing your mind is an upsert onto
  -- this key rather than a second row.
  PRIMARY KEY (session_id, voter_id)
);

-- Every read is "the tally for this session", which this covers.
CREATE INDEX IF NOT EXISTS idx_mvp_votes_nominee
  ON mvp_votes (session_id, nominee_id);

-- And the career count behind the profile and the leaderboard.
CREATE INDEX IF NOT EXISTS idx_mvp_votes_by_nominee
  ON mvp_votes (nominee_id);
