-- Profile pictures.
--
-- The object itself lives in R2 next to the payment proofs; only the key is
-- here. `avatar_updated_at` exists so the client has something to cache on:
-- the key is never sent to the browser (it is an internal R2 path), but a
-- picture that never changes should not be re-fetched on every render, and one
-- that *has* changed must not keep showing the old face. The timestamp is the
-- cache buster, and it is safe to expose.

ALTER TABLE members ADD COLUMN avatar_key TEXT;
ALTER TABLE members ADD COLUMN avatar_updated_at TEXT;
