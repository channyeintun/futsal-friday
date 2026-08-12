-- Where the money goes.
--
-- A singleton, like `group_invite`: one person collects for the group, so this
-- is a property of the group rather than of a member. Keeping it off the
-- members table also means handing the organizer role to somebody else does
-- not silently redirect everybody's transfers.
--
-- Nothing here is a secret. An account number and a name are exactly what you
-- would paste into the chat anyway, and the whole point is that the group can
-- read them without asking. They are still behind sign-in.
--
-- `bank_bin` is the NAPAS acquirer id — the six digits VietQR identifies a
-- bank by, e.g. 970436 for Vietcombank. `bank_name` is stored alongside it
-- rather than looked up, so a row still renders if the bank list is later
-- edited or a bank is renamed.

CREATE TABLE payment_details (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  bank_bin       TEXT NOT NULL,
  bank_name      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name   TEXT NOT NULL,
  -- Free text the organizer wants shown with the details, e.g. "put your name
  -- in the transfer note".
  note           TEXT,
  updated_at     TEXT NOT NULL,
  updated_by     TEXT REFERENCES members (id) ON DELETE SET NULL
);
