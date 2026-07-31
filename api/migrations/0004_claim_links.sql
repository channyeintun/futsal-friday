-- Migration 0004 — single-use claim links replace the name picker.
--
-- Before this, anyone holding the shared invite code could pick *any* name on
-- the roster, including an organizer's, and inherit their privileges. The
-- invite code also lives forever in a group chat, so it was a single static
-- string standing between the group and someone settling their own bills.
--
-- Now the only way in is a link the organizer sends to one person. The link is
-- a bearer capability: a 256-bit random value looked up directly in this table.
-- It is deliberately *not* a signed token — a DB lookup is simpler to reason
-- about, needs no secret to mint, and makes single-use trivial (delete it).

-- NULL until this identity has been taken. Shown to the organizer so they can
-- see at a glance who has not joined yet.
ALTER TABLE members ADD COLUMN claimed_at TEXT;

-- The one outstanding link for this member, or NULL. Storing it on the member
-- (rather than a table of tokens) means issuing a new link implicitly revokes
-- the previous one, which is the behaviour you want when someone says "resend
-- it, I lost the message".
ALTER TABLE members ADD COLUMN claim_nonce TEXT;
ALTER TABLE members ADD COLUMN claim_expires_at TEXT;

-- Claiming is a lookup by nonce, so it must be indexed and unique. Partial, so
-- the many NULLs do not collide.
CREATE UNIQUE INDEX idx_members_claim_nonce
  ON members (claim_nonce) WHERE claim_nonce IS NOT NULL;

-- Bumped to sign out every device belonging to one member at once.
--
-- Session tokens are stateless and last 90 days, so without this a lost or
-- stolen phone would keep full access for three months. The version is embedded
-- in the token and compared on every request against this column, which is
-- already being read to re-check membership — so revocation costs nothing.
ALTER TABLE members ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;
