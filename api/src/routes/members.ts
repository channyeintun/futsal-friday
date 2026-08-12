import { createMemberSchema, updateMemberSchema } from '@futsal/shared';
import { Hono } from 'hono';
import {
  type MemberRow,
  decodeBalanceCursor,
  FORM_WINDOW,
  loadLeaderboard,
  loadMemberBalances,
  loadRecentForm,
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
/**
 * Opaque cursor over `(name, id)`.
 *
 * Base64 rather than the raw pair so it reads as a token the client should
 * hand back untouched, and so a name containing the separator cannot forge a
 * position. Anything unparseable is treated as "start from the beginning",
 * which is the safe failure: a stale cursor shows the first page again rather
 * than erroring at somebody halfway down a list.
 */
function encodeCursor(name: string, id: string): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify({ n: name, i: id }))));
}

function decodeCursor(raw: string | undefined): { name: string; id: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(escape(atob(raw))));
    if (typeof parsed?.n === 'string' && typeof parsed?.i === 'string') {
      return { name: parsed.n, id: parsed.i };
    }
  } catch {
    // Fall through: an unreadable cursor is a first page, not a 400.
  }
  return null;
}

export const memberRoutes = new Hono<AppContext>()

  /**
   * The roster, a page at a time.
   *
   * Keyset, not `OFFSET`: the order is by name, and adding somebody called
   * "Aung" while you are three pages down would shift every later row by one
   * and make the next page repeat a name it had already shown. Comparing
   * against the last row you actually saw cannot skip or duplicate, however
   * much the table moves underneath.
   *
   * The tuple has to include `id` because names are not unique — two players
   * called "Minh" would otherwise make the cursor ambiguous and the second one
   * unreachable. SQLite compares row values left to right, which is exactly
   * the "name greater, or name equal and id greater" rule we want.
   */
  .get('/', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 100);
    const cursor = decodeCursor(c.req.query('cursor'));

    // Approved only. Somebody in the waiting room is not a member of the group
    // yet, and leaking them here would put them in the roster, the session
    // lists and every count in the app.
    const where = `active = 1 AND approved_at IS NOT NULL`;
    const statement = cursor
      ? c.env.DB.prepare(
          `SELECT * FROM members
            WHERE ${where}
              AND (name COLLATE NOCASE, id) > (?1 COLLATE NOCASE, ?2)
            ORDER BY name COLLATE NOCASE ASC, id ASC
            LIMIT ?3`,
        ).bind(cursor.name, cursor.id, limit + 1)
      : c.env.DB.prepare(
          `SELECT * FROM members
            WHERE ${where}
            ORDER BY name COLLATE NOCASE ASC, id ASC
            LIMIT ?1`,
        ).bind(limit + 1);

    // One more than asked for, so "is there another page" is answered without
    // a second COUNT query on every scroll.
    const { results } = await statement.all<MemberRow>();
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return c.json({
      members: page.map(toMember),
      nextCursor: results.length > limit && last ? encodeCursor(last.name, last.id) : null,
    });
  })

  /**
   * Just how many there are.
   *
   * The Setup screen wants a number and an Add button, not a roster — reading
   * every member to render "23 players" would be the whole list downloaded to
   * print two characters.
   */
  .get('/count', async (c) => {
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM members WHERE active = 1 AND approved_at IS NOT NULL`,
    ).first<{ n: number }>();
    return c.json({ total: row?.n ?? 0 });
  })

  /**
   * Recent form for the whole roster, for the squares beside each name.
   *
   * One call for everybody rather than one per player: the home screen draws a
   * row of these next to every name on the list, and per-member requests would
   * be a dozen round trips on the screen people open most.
   */
  .get('/form', async (c) => {
    const form = await loadRecentForm(c.env.DB);
    return c.json({
      window: FORM_WINDOW,
      form: [...form].map(([memberId, recent]) => ({ memberId, recent })),
    });
  })

  /**
   * The ranking, by whichever column was asked for.
   *
   * Computed rather than stored — see `loadLeaderboard`. Paged off the sorted
   * result, with the sort settled before slicing so a page boundary cannot
   * reorder anybody.
   */
  .get('/leaderboard', async (c) => {
    const board = c.req.query('board') === 'goals' ? 'goals' : 'streak';
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 25) || 25, 1), 100);
    const cursor = c.req.query('cursor');

    const all = await loadLeaderboard(c.env.DB);
    // Nobody with nothing to show: a board of forty people on zero is not a
    // ranking, it is a roster.
    const ranked = all
      .filter((row) => (board === 'goals' ? row.goals > 0 : row.streak.best > 0))
      .sort((a, b) =>
        board === 'goals'
          ? b.goals - a.goals || a.member.name.localeCompare(b.member.name)
          : b.streak.current - a.streak.current ||
            b.streak.best - a.streak.best ||
            a.member.name.localeCompare(b.member.name),
      );

    const from = cursor ? ranked.findIndex((row) => row.member.id === cursor) + 1 : 0;
    const page = ranked.slice(from, from + limit);
    const last = page.at(-1);
    return c.json({
      board,
      entries: page.map((row, i) => ({ ...row, rank: from + i + 1 })),
      nextCursor: from + limit < ranked.length && last ? last.member.id : null,
    });
  })

  /** The waiting room. Organizers only — it is a queue of decisions for them. */
  .get('/pending', requireOrganizer(), async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM members
        WHERE active = 1 AND approved_at IS NULL
        ORDER BY created_at ASC`,
    ).all<MemberRow>();
    return c.json({ members: results.map(toMember) });
  })

  /** Let somebody in. Idempotent: approving twice is not an error. */
  .post('/:id/approve', requireOrganizer(), async (c) => {
    const id = c.req.param('id');
    const existing = await c.env.DB.prepare(`SELECT * FROM members WHERE id = ?1`)
      .bind(id)
      .first<MemberRow>();
    if (!existing) throw notFound('No such member');

    const approvedAt = existing.approved_at ?? nowIso();
    await c.env.DB.prepare(`UPDATE members SET approved_at = ?2 WHERE id = ?1`)
      .bind(id, approvedAt)
      .run();

    return c.json({ member: toMember({ ...existing, approved_at: approvedAt }) });
  })

  /**
   * Turn somebody away.
   *
   * A hard delete, unlike removing a member who has been playing — this row
   * was created by the person themselves, has no registrations or payments
   * behind it (a pending member cannot make any), and the name needs to go
   * back on the list so the real owner can ask for it. Soft-deleting would
   * hold the name hostage forever.
   */
  .delete('/:id/approve', requireOrganizer(), async (c) => {
    const id = c.req.param('id');
    const gone = await c.env.DB.prepare(
      `DELETE FROM members WHERE id = ?1 AND approved_at IS NULL`,
    )
      .bind(id)
      .run();

    if (gone.meta.changes === 0) {
      throw conflict('That member is already in — remove them from the roster instead');
    }
    return c.json({ ok: true });
  })

  /**
   * Who owes what, across every session — readable by anyone signed in.
   *
   * Deliberately not an organizer secret. In a group this size the debt is
   * already public: the payments screen has a *Copy status for chat* button
   * whose whole job is pasting the unpaid list into the group, and any
   * member's outstanding total is already on their profile. Keeping the
   * aggregate private only meant the one person chasing the money was also
   * the only one who could see it, which put all the nagging on them.
   */
  .get('/balances', async (c) => {
    const limit = Number(c.req.query('limit') ?? 50) || 50;
    return c.json(
      await loadMemberBalances(c.env.DB, {
        limit,
        cursor: decodeBalanceCursor(c.req.query('cursor')),
      }),
    );
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
      const timestamp = nowIso();
      await c.env.DB.prepare(
        // Approved on the spot: an organizer typing a name in *is* the
        // approval. The waiting room is only for people who added themselves
        // from the group link.
        `INSERT INTO members (id, name, is_organizer, active, created_at, approved_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
      )
        .bind(id, input.name, input.isOrganizer ? 1 : 0, timestamp)
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
