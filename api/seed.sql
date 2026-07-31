-- Optional bootstrap data. NOT a migration — run it once by hand to get a
-- usable app, then edit everything from the UI.
--
--   npm run db:seed:local            (local dev)
--   npx wrangler d1 execute futsal-friday --remote --file=./seed.sql
--
-- Change the organizer's name before running this: whoever is called
-- 'Organizer' below is the only person who can add the rest of the group.

INSERT OR IGNORE INTO members (id, name, is_organizer, active, created_at) VALUES
  ('mem_organizer', 'Organizer', 1, 1, '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO venues (id, name, address, map_url, price_note, active, created_at) VALUES
  ('ven_example', 'Sân Tao Đàn', '1 Truong Dinh, Ben Thanh, District 1', NULL, '~600.000d/hour', 1, '2026-01-01T00:00:00.000Z');
