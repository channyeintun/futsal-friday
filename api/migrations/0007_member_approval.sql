-- Letting people add themselves.
--
-- The group link used to only hand out names the organizer had already typed
-- in, which meant enumerating the whole chat up front — the work the link was
-- supposed to remove. Now somebody with the link can put their own name
-- forward, and the organizer lets them in with one tap.
--
-- `approved_at` NULL is the waiting room. It is a separate axis from `active`,
-- which is the soft delete for people who have left: a pending member has
-- never been in, a deactivated one has been and gone, and conflating the two
-- would let a departed member's row reappear as a join request.
--
-- Backfilled from `created_at` rather than defaulted, because everybody who
-- already exists was put there by an organizer and must not wake up locked
-- out of their own account.

ALTER TABLE members ADD COLUMN approved_at TEXT;

UPDATE members SET approved_at = created_at WHERE approved_at IS NULL;

-- Finding the waiting room is the organizer's most time-sensitive read, and it
-- is a tiny slice of a small table; the partial index keeps it exact.
CREATE INDEX idx_members_pending ON members (created_at) WHERE approved_at IS NULL;
