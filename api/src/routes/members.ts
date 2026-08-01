import { createMemberSchema, updateMemberSchema } from '@futsal/shared';
import { Hono } from 'hono';
import {
  type MemberRow,
  loadMemberBalances,
  loadMemberHistory,
  loadMemberProfile,
  toMember,
} from '../db.js';
import type { AppContext } from '../env.js';
import { conflict, forbidden, newId, notFound, nowIso, parseBody } from '../http.js';
import { requireOrganizer } from '../middleware.js';
import { readImageUpload } from './uploads.js';

/**
 * A profile picture is a thumbnail, not a screenshot — the client renders it at
 * 40px in a list and 96px on a profile. 200 KB is already generous for that,
 * and re-uploads replace rather than accumulate, so the bucket cannot creep.
 */
const MAX_AVATAR_BYTES = 200_000;

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

  /**
   * Everything the profile screen needs. Readable by anyone signed in: these
   * people already see each other's names and attendance on every session
   * screen, so a streak is not a new disclosure.
   */
  .get('/:id/profile', async (c) => {
    const profile = await loadMemberProfile(c.env.DB, c.req.param('id'));
    if (!profile) throw notFound('No such member');
    return c.json({ profile });
  })

  /**
   * Your own face, and only your own — an organizer picking somebody else's
   * profile picture is not a feature anyone asked for.
   *
   * One request rather than the upload-then-attach dance the payment proofs
   * use: there is nothing to attach it to but this row, and a two-step flow
   * would leave an orphaned object behind every time somebody changed their
   * mind between the two calls.
   */
  .put('/me/avatar', async (c) => {
    const identity = c.get('identity');
    const { body, contentType, extension } = await readImageUpload(c.req.raw, MAX_AVATAR_BYTES);

    const existing = await c.env.DB.prepare(`SELECT * FROM members WHERE id = ?1`)
      .bind(identity.memberId)
      .first<MemberRow>();
    if (!existing) throw notFound('No such member');

    const key = `avatars/${identity.memberId}/${newId('img')}.${extension}`;
    await c.env.PROOFS.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: { memberId: identity.memberId },
    });

    const updatedAt = nowIso();
    await c.env.DB.prepare(
      `UPDATE members SET avatar_key = ?2, avatar_updated_at = ?3 WHERE id = ?1`,
    )
      .bind(identity.memberId, key, updatedAt)
      .run();

    // Only once the row points at the new object. Deleting first would leave a
    // broken picture if the write below failed; deleting after is at worst an
    // orphan, and this is the only writer of that key.
    if (existing.avatar_key) {
      await c.env.PROOFS.delete(existing.avatar_key).catch(() => {});
    }

    return c.json({
      member: toMember({ ...existing, avatar_key: key, avatar_updated_at: updatedAt }),
    });
  })

  .delete('/me/avatar', async (c) => {
    const identity = c.get('identity');
    const existing = await c.env.DB.prepare(`SELECT * FROM members WHERE id = ?1`)
      .bind(identity.memberId)
      .first<MemberRow>();
    if (!existing) throw notFound('No such member');

    await c.env.DB.prepare(
      `UPDATE members SET avatar_key = NULL, avatar_updated_at = NULL WHERE id = ?1`,
    )
      .bind(identity.memberId)
      .run();
    if (existing.avatar_key) await c.env.PROOFS.delete(existing.avatar_key).catch(() => {});

    return c.json({
      member: toMember({ ...existing, avatar_key: null, avatar_updated_at: null }),
    });
  })

  /**
   * The picture itself. Like payment proofs, R2 keys never leave the server —
   * reading one always goes through here, so access follows the session token
   * rather than knowledge of a URL.
   */
  .get('/:id/avatar', async (c) => {
    const row = await c.env.DB.prepare(`SELECT avatar_key FROM members WHERE id = ?1`)
      .bind(c.req.param('id'))
      .first<{ avatar_key: string | null }>();
    if (!row?.avatar_key) throw notFound('No profile picture');

    const object = await c.env.PROOFS.get(row.avatar_key);
    if (!object) throw notFound('No profile picture');

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
        // Private: it is behind auth, and a shared cache must not hold it. The
        // client busts this with `avatarUpdatedAt` when the picture changes.
        'Cache-Control': 'private, max-age=86400',
      },
    });
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
    const id = newId('mem');

    try {
      await c.env.DB.prepare(
        `INSERT INTO members (id, name, is_organizer, active, created_at)
         VALUES (?1, ?2, ?3, 1, ?4)`,
      )
        .bind(id, input.name, input.isOrganizer ? 1 : 0, nowIso())
        .run();
    } catch (error) {
      // Names have to be unambiguous — they are how the organizer picks who a
      // claim link is for — so surface the collision as a real message.
      if (isUniqueViolation(error)) throw conflict(`${input.name} is already on the list`);
      throw error;
    }

    // Read the row back rather than mirroring the column defaults by hand;
    // every migration that adds a column would otherwise break this literal.
    const row = await c.env.DB.prepare(`SELECT * FROM members WHERE id = ?1`)
      .bind(id)
      .first<MemberRow>();
    if (!row) throw conflict('Member vanished after insert');

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
