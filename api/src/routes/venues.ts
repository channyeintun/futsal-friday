import { createVenueSchema, updateVenueSchema } from '@futsal/shared';
import { Hono } from 'hono';
import { type VenueRow, toVenue } from '../db.js';
import type { AppContext } from '../env.js';
import { conflict, newId, notFound, nowIso, parseBody } from '../http.js';
import { requireOrganizer } from '../middleware.js';

/** A short list of pitches the group rotates between. Everyone can read it. */
export const venueRoutes = new Hono<AppContext>()

  .get('/', async (c) => {
    // `?all=1` includes retired venues so the organizer can bring one back.
    const includeInactive = c.req.query('all') === '1' && c.get('identity').isOrganizer;
    const { results } = await c.env.DB.prepare(
      includeInactive
        ? `SELECT * FROM venues ORDER BY active DESC, name COLLATE NOCASE ASC`
        : `SELECT * FROM venues WHERE active = 1 ORDER BY name COLLATE NOCASE ASC`,
    ).all<VenueRow>();
    return c.json({ venues: results.map(toVenue) });
  })

  .post('/', requireOrganizer(), async (c) => {
    const input = await parseBody(c.req.raw, createVenueSchema);
    const row: VenueRow = {
      id: newId('ven'),
      name: input.name,
      address: input.address ?? null,
      map_url: emptyToNull(input.mapUrl),
      price_note: input.priceNote ?? null,
      active: 1,
      created_at: nowIso(),
    };

    await c.env.DB.prepare(
      `INSERT INTO venues (id, name, address, map_url, price_note, active, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)`,
    )
      .bind(row.id, row.name, row.address, row.map_url, row.price_note, row.created_at)
      .run();

    return c.json({ venue: toVenue(row) }, 201);
  })

  .patch('/:id', requireOrganizer(), async (c) => {
    const id = c.req.param('id');
    const input = await parseBody(c.req.raw, updateVenueSchema);

    const existing = await c.env.DB.prepare(`SELECT * FROM venues WHERE id = ?1`)
      .bind(id)
      .first<VenueRow>();
    if (!existing) throw notFound('No such venue');

    const next: VenueRow = {
      ...existing,
      name: input.name ?? existing.name,
      address: input.address === undefined ? existing.address : (input.address ?? null),
      map_url: input.mapUrl === undefined ? existing.map_url : emptyToNull(input.mapUrl),
      price_note: input.priceNote === undefined ? existing.price_note : (input.priceNote ?? null),
      active: input.active === undefined ? existing.active : input.active ? 1 : 0,
    };

    await c.env.DB.prepare(
      `UPDATE venues SET name = ?2, address = ?3, map_url = ?4, price_note = ?5, active = ?6
       WHERE id = ?1`,
    )
      .bind(next.id, next.name, next.address, next.map_url, next.price_note, next.active)
      .run();

    return c.json({ venue: toVenue(next) });
  })

  /**
   * Retire rather than delete: past sessions point at this venue, and the cron
   * copies the previous session's venue forward as the default.
   */
  .delete('/:id', requireOrganizer(), async (c) => {
    const id = c.req.param('id');
    const upcoming = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sessions
        WHERE venue_id = ?1 AND status = 'scheduled' AND starts_at > ?2`,
    )
      .bind(id, nowIso())
      .first<{ n: number }>();

    if ((upcoming?.n ?? 0) > 0) {
      throw conflict('An upcoming session still uses this venue — move it first');
    }

    const result = await c.env.DB.prepare(`UPDATE venues SET active = 0 WHERE id = ?1`)
      .bind(id)
      .run();
    if (result.meta.changes === 0) throw notFound('No such venue');

    return c.json({ ok: true });
  });

/** An empty string from a cleared form field means "no link", not "". */
function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}
