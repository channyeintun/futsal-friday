-- Migration 0005 — one group invite link, instead of one link per person.
--
-- Per-person links were secure but wrong for the job: setting up a fifteen
-- person group meant fifteen individual messages, and another every time
-- somebody changed phone. That is worse than the problem it solved.
--
-- So there is now a single link the organizer pastes into the group chat once.
-- What makes it safe is not secrecy — a chat message is not a secret — but the
-- three limits enforced when it is redeemed:
--
--   1. A name can be claimed exactly once. After that it is locked to whoever
--      claimed it, and the picker stops offering it.
--   2. Organizer accounts are never listed and never claimable through it, so
--      admin cannot be grabbed. Organizers use a personal link.
--   3. It expires, and the organizer can rotate it, which invalidates the copy
--      sitting in the chat history.
--
-- The residual risk is somebody tapping a name that is not theirs. In a group
-- of friends that is socially obvious and one tap to undo — the organizer
-- un-claims it and they try again.

-- Exactly one row, enforced by the CHECK: there is one group, one link.
CREATE TABLE group_invite (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  nonce      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES members (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_group_invite_nonce ON group_invite (nonce);
