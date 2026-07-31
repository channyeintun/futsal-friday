-- Migration 0001 — initial schema.
--
-- Conventions used throughout:
--   * ids are application-generated UUIDs (TEXT), not autoincrement, so the
--     Worker can emit a realtime event without a round-trip to read the id back.
--   * timestamps are ISO-8601 UTC strings ('2026-08-07T12:30:00.000Z'). SQLite
--     sorts these lexicographically in true chronological order.
--   * booleans are INTEGER 0/1.
--   * money is INTEGER Vietnamese dong. No floats anywhere.

-- Members -------------------------------------------------------------------
-- The organizer maintains this list by hand; there is no self-signup.
CREATE TABLE members (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  is_organizer INTEGER NOT NULL DEFAULT 0 CHECK (is_organizer IN (0, 1)),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- Reserved for the Zalo Mini App port: the ZMP user id gets stored here so a
  -- member keeps their history when identity moves from cookie to Zalo SDK.
  external_id  TEXT,
  created_at   TEXT NOT NULL
);

-- Names are how people identify each other on the pick-your-name screen, so
-- they have to be unambiguous. Case-insensitive to stop "An" / "an" duplicates.
CREATE UNIQUE INDEX idx_members_name ON members (name COLLATE NOCASE);
CREATE UNIQUE INDEX idx_members_external_id ON members (external_id) WHERE external_id IS NOT NULL;

-- Venues --------------------------------------------------------------------
CREATE TABLE venues (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  address    TEXT,
  map_url    TEXT,
  price_note TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_venues_active ON venues (active, name);

-- Sessions ------------------------------------------------------------------
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  starts_at      TEXT NOT NULL,
  venue_id       TEXT REFERENCES venues (id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  -- Estimate shown while registration is open.
  fee_per_person INTEGER CHECK (fee_per_person IS NULL OR fee_per_person >= 0),
  -- Actual invoice from the venue, entered afterwards. Drives the split.
  total_charge   INTEGER CHECK (total_charge IS NULL OR total_charge >= 0),
  -- NULL means "no cap", so the waitlist never engages.
  max_players    INTEGER CHECK (max_players IS NULL OR max_players > 0),
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- The home screen asks "what is next / what was recent" — both are this index.
CREATE INDEX idx_sessions_starts_at ON sessions (starts_at DESC);
-- Guards the weekly cron against creating a second session for the same slot
-- if it is retried or fires twice.
CREATE UNIQUE INDEX idx_sessions_slot ON sessions (starts_at) WHERE status <> 'cancelled';

-- Registrations -------------------------------------------------------------
CREATE TABLE registrations (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'in' CHECK (status IN ('in', 'waitlist')),
  -- Monotonically increasing per session. Defines both display order and the
  -- promotion order off the waitlist. Never reused, even after a withdrawal,
  -- so that re-registering puts you at the back of the queue.
  position   INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, member_id)
);

CREATE INDEX idx_registrations_session ON registrations (session_id, position);
CREATE INDEX idx_registrations_member ON registrations (member_id);

-- Payments ------------------------------------------------------------------
-- One row per player per settled session. Created in bulk when the organizer
-- enters the total charge.
CREATE TABLE payments (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  member_id       TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  -- What this member owes: their share of the split, or their override.
  amount_due      INTEGER NOT NULL DEFAULT 0 CHECK (amount_due >= 0),
  -- Set when the organizer pins an amount for this person. Re-settling the
  -- session preserves it and re-splits the remainder among everyone else.
  amount_override INTEGER CHECK (amount_override IS NULL OR amount_override >= 0),
  status          TEXT NOT NULL DEFAULT 'unpaid'
                    CHECK (status IN ('unpaid', 'pending', 'confirmed')),
  -- R2 object key for the transfer screenshot. Never exposed to clients
  -- directly; images are streamed through an authorized Worker route.
  proof_key       TEXT,
  note            TEXT,
  reject_reason   TEXT,
  claimed_at      TEXT,
  confirmed_at    TEXT,
  confirmed_by    TEXT REFERENCES members (id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (session_id, member_id)
);

CREATE INDEX idx_payments_session ON payments (session_id, status);
-- Powers the per-member outstanding balance across all sessions.
CREATE INDEX idx_payments_member ON payments (member_id, status);
