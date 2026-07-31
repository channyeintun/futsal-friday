import { createMemberSchema, updateMemberSchema } from '@futsal/shared';
import { Hono } from 'hono';
import {
  type MemberRow,
  loadMemberBalances,
  loadMemberHistory,
  toMember,
} from '../db.js';
import type { AppContext } from '../env.js';
import { conflict, forbidden, newId, notFound, nowIso, parseBody } from '../http.js';
import { requireOrganizer } from '../middleware.js';

/** The member list is the app's roster; only organizers may change it. */
export const memberRoutes = new Hono<AppContext>()

  .get('/', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE ASC`,
    ).all<MemberRow>();
    return c.json({ members: results.map(toMember) });
  })

  /** Organizer dashboard: who owes what, across every session. */
  .get('/balances', requireOrganizer(), async (c) => {
    return c.json({ balances: await loadMemberBalances(c.env.DB) });
  })

  .get('/:id/history', async (c) => {
    const id = c.req.param('id');
    const identity = c.get('identity');
    // Your own history is yours; everyone else's is the organizer's business.
    if (id !== identity.memberId && !identity.isOrganizer) throw forbidden();

    return c.json({ history: await loadMemberHistory(c.env.DB, id) });
  })

  .post('/', requireOrganizer(), async (c) => {
    const input = await parseBody(c.req.raw, createMemberSchema);
    const row: MemberRow = {
      id: newId('mem'),
      name: input.name,
      is_organizer: input.isOrganizer ? 1 : 0,
      active: 1,
      external_id: null,
      created_at: nowIso(),
      // Matches the column defaults; nothing is delivered until the member
      // actually grants push permission on a device.
      notify_session: 1,
      notify_payment: 1,
      // The organizer adds people before they ever open the app, so their real
      // language is unknown until they pick one.
      language: 'en',
    };

    try {
      await c.env.DB.prepare(
        `INSERT INTO members (id, name, is_organizer, active, created_at)
         VALUES (?1, ?2, ?3, 1, ?4)`,
      )
        .bind(row.id, row.name, row.is_organizer, row.created_at)
        .run();
    } catch (error) {
      // The unique index on name COLLATE NOCASE is what makes the
      // pick-your-name screen unambiguous, so surface it as a real message.
      if (isUniqueViolation(error)) throw conflict(`${input.name} is already on the list`);
      throw error;
    }

    return c.json({ member: toMember(row) }, 201);
  })

  .patch('/:id', requireOrganizer(), async (c) => {
    const id = c.req.param('id');
    const input = await parseBody(c.req.raw, updateMemberSchema);

    const existing = await c.env.DB.prepare(`SELECT * FROM members WHERE id = ?1`)
      .bind(id)
      .first<MemberRow>();
    if (!existing) throw notFound('No such member');

    // Refuse to remove the last way into the admin screens.
    if (input.isOrganizer === false || input.active === false) {
      if (existing.is_organizer === 1 && (await countOrganizers(c.env.DB)) <= 1) {
        throw conflict('Promote someone else first — this is the only organizer');
      }
    }

    const next: MemberRow = {
      ...existing,
      name: input.name ?? existing.name,
      is_organizer: input.isOrganizer === undefined ? existing.is_organizer : input.isOrganizer ? 1 : 0,
      active: input.active === undefined ? existing.active : input.active ? 1 : 0,
    };

    try {
      await c.env.DB.prepare(
        `UPDATE members SET name = ?2, is_organizer = ?3, active = ?4 WHERE id = ?1`,
      )
        .bind(next.id, next.name, next.is_organizer, next.active)
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(`${next.name} is already on the list`);
      throw error;
    }

    return c.json({ member: toMember(next) });
  })

  /**
   * Soft delete. Registrations and payments reference members, and wiping a
   * row would rewrite the group's financial history — so a departing member is
   * deactivated and simply stops appearing on the name picker.
   */
  .delete('/:id', requireOrganizer(), async (c) => {
    const id = c.req.param('id');

    const existing = await c.env.DB.prepare(`SELECT * FROM members WHERE id = ?1`)
      .bind(id)
      .first<MemberRow>();
    if (!existing) throw notFound('No such member');
    if (existing.is_organizer === 1 && (await countOrganizers(c.env.DB)) <= 1) {
      throw conflict('Promote someone else first — this is the only organizer');
    }

    await c.env.DB.prepare(`UPDATE members SET active = 0 WHERE id = ?1`).bind(id).run();
    return c.json({ ok: true });
  });

async function countOrganizers(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM members WHERE is_organizer = 1 AND active = 1`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
