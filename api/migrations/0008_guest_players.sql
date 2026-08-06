-- Bringing friends who will never have an account.
--
-- Somebody turns up once, or plays every third week, and is never going to
-- install anything. They still take a spot on the pitch and still cost money,
-- so they are counted — as a number attached to whoever brought them, not as
-- members. A guest has no identity, no login and no history; the member who
-- brought them is answerable for their spot and their share.
--
-- Capped at 5 rather than left open: a party of seven is a different booking,
-- not a guest, and an unbounded number here would let one person silently
-- consume the whole session.

ALTER TABLE registrations ADD COLUMN guests INTEGER NOT NULL DEFAULT 0
  CHECK (guests >= 0 AND guests <= 5);

-- The same number, snapshotted onto the charge.
--
-- Not redundant with the column above: this one records *what the split was
-- computed from*. An amount that can only be explained by re-reading live
-- registration state stops being explainable the moment that state moves, and
-- "why do I owe 210.000d" has to stay answerable from the payment row alone.
ALTER TABLE payments ADD COLUMN guests INTEGER NOT NULL DEFAULT 0
  CHECK (guests >= 0);
